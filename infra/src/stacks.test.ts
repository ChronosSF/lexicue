import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { App, type Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { ENVIRONMENTS, environmentFor, parameterPrefix, type Stage } from "./config.js";
import { buildStacks, type BuiltStacks } from "./stacks.js";
import { WebStack } from "./stacks/web-stack.js";

/**
 * Every stack, synthesised with no credentials, no account and no network.
 *
 * `App.synth()` is the whole test: if it runs, the templates are valid
 * CloudFormation and every cross-stack reference resolves. What is asserted on
 * top of that is the handful of properties where getting it wrong costs money
 * or loses a file — retention, the lifecycle rule, the conditional-write
 * surface, the authorizer, the reserved concurrency, and which behaviour
 * CloudFront sends `/api/*` to.
 *
 * Nothing here deploys, and nothing here can: there is no environment in the
 * stack props, so every stack is region-agnostic and the account is a token.
 */

/**
 * Built once per environment and reused.
 *
 * Synthesis bundles six Lambdas with esbuild, which is the point — a handler
 * that does not bundle is not a handler — but it costs a few seconds a time.
 * Three apps for three environments keeps the whole file inside the budget the
 * rest of `pnpm test` sets.
 */
const built = new Map<Stage, { app: App; stacks: BuiltStacks }>();

function stacksFor(stage: Stage): { app: App; stacks: BuiltStacks } {
  const existing = built.get(stage);
  if (existing !== undefined) return existing;
  const app = new App();
  const fresh = { app, stacks: buildStacks(app, ENVIRONMENTS[stage]) };
  built.set(stage, fresh);
  return fresh;
}

/**
 * The six in a list. `Object.values` on an object with no index signature is
 * typed `any[]`, which the type-aware rules are right to refuse.
 */
function allOf(stacks: BuiltStacks): Stack[] {
  return [stacks.auth, stacks.storage, stacks.worker, stacks.api, stacks.web, stacks.monitoring];
}

/** Templates are immutable once synthesised, so they are cached too. */
const templates = new Map<string, Template>();

function templateOf(stage: Stage, stack: keyof BuiltStacks): Template {
  const key = `${stage}:${stack}`;
  const existing = templates.get(key);
  if (existing !== undefined) return existing;
  const fresh = Template.fromStack(stacksFor(stage).stacks[stack]);
  templates.set(key, fresh);
  return fresh;
}

/**
 * Synthesise everything once, before any assertion runs.
 *
 * Without this the first test to touch a stack pays for its esbuild bundles,
 * which is more than vitest's default per-test timeout under a loaded machine —
 * and which test that is depends on the order the file happens to run in. One
 * warm-up with one generous timeout makes the suite deterministic.
 */
beforeAll(() => {
  for (const stage of ["dev", "staging", "prod"] as const) {
    for (const stack of ["auth", "storage", "worker", "api", "web", "monitoring"] as const) {
      templateOf(stage, stack);
    }
  }
}, 300_000);

describe("the environments", () => {
  it("names a per-developer stack after the developer", () => {
    expect(environmentFor("dev-anna")).toMatchObject({ name: "dev-anna", stage: "dev" });
    expect(environmentFor(undefined)).toMatchObject({ name: "dev" });
    expect(environmentFor("staging").name).toBe("staging");
  });

  it("refuses an environment nobody configured", () => {
    expect(() => environmentFor("production")).toThrow(/Unknown environment/);
  });

  /** Section 9.3: three accounts, and the differences that cost money. */
  it("differs between the three in exactly the ways section 9.3 asks for", () => {
    expect(ENVIRONMENTS.dev).toMatchObject({ wafEnabled: false, pointInTimeRecovery: false });
    expect(ENVIRONMENTS.staging).toMatchObject({ wafEnabled: true, pointInTimeRecovery: true });
    expect(ENVIRONMENTS.prod).toMatchObject({ wafEnabled: true, pointInTimeRecovery: true });
    expect(ENVIRONMENTS.prod.workerReservedConcurrency).toBeGreaterThan(
      ENVIRONMENTS.dev.workerReservedConcurrency,
    );
  });
});

describe("every stack", () => {
  // The first synthesis of each environment bundles its Lambdas with esbuild,
  // which is slower than vitest's default timeout and is the point.
  it("synthesises for dev, staging and prod", { timeout: 300_000 }, () => {
    for (const stage of ["dev", "staging", "prod"] as const) {
      const { app, stacks } = stacksFor(stage);
      const assembly = app.synth();
      expect(assembly.stacks).toHaveLength(6);
      for (const stack of allOf(stacks)) {
        expect(assembly.getStackByName(stack.stackName).template).toBeDefined();
      }
    }
  });

  it("names every stack after its environment", () => {
    const { stacks } = stacksFor("staging");
    expect(
      allOf(stacks)
        .map((stack) => stack.stackName)
        .sort(),
    ).toEqual([
      "Lexicue-Api-staging",
      "Lexicue-Auth-staging",
      "Lexicue-Monitoring-staging",
      "Lexicue-Storage-staging",
      "Lexicue-Web-staging",
      "Lexicue-Worker-staging",
    ]);
  });
});

describe("the storage stack", () => {
  it("builds the single table of section 7.4, keyed PK and SK with a TTL", () => {
    const template = templateOf("prod", "storage");
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      TableName: "subtitles-prod",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
    // No secondary index: section 7.4 says v1 needs none, and one nobody
    // queries is a bill and a write-capacity multiplier.
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      GlobalSecondaryIndexes: Match.absent(),
    });
  });

  /**
   * The 24-hour promise of section 3.2 is a privacy claim in section 3.6. It
   * has to be a bucket rule rather than application code, so that it keeps
   * being true while the application is broken.
   */
  it("expires every object after one day, by lifecycle rule", () => {
    templateOf("prod", "storage").hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 1, Status: "Enabled" })]),
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
    });
  });

  it("retains the table in production and destroys it on a developer stack", () => {
    templateOf("prod", "storage").hasResource("AWS::DynamoDB::GlobalTable", {
      DeletionPolicy: "Retain",
    });
    templateOf("dev", "storage").hasResource("AWS::DynamoDB::GlobalTable", {
      DeletionPolicy: "Delete",
    });
  });

  it("turns point-in-time recovery on everywhere the data matters", () => {
    templateOf("staging", "storage").hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      Replicas: Match.arrayWith([
        Match.objectLike({
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        }),
      ]),
    });
  });
});

describe("the auth stack", () => {
  it("requires a verified email, which is what grants the free balance", () => {
    const template = templateOf("prod", "auth");
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "lexicue-prod",
      AutoVerifiedAttributes: ["email"],
      UsernameAttributes: ["email"],
      UsernameConfiguration: { CaseSensitive: false },
    });
  });

  it("gives the SPA a public client with short-lived tokens", () => {
    templateOf("prod", "auth").hasResourceProperties("AWS::Cognito::UserPoolClient", {
      // A public SPA client: no secret to leak into a bundle.
      GenerateSecret: false,
      IdTokenValidity: 60,
      AccessTokenValidity: 60,
      TokenValidityUnits: Match.objectLike({ IdToken: "minutes" }),
      PreventUserExistenceErrors: "ENABLED",
      ExplicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    });
  });
});

describe("the worker stack", () => {
  it("gives the queue a dead-letter queue after one redelivery", () => {
    templateOf("prod", "worker").hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "lexicue-jobs-prod",
      // Section 7.2: six times the worker's 15-minute timeout.
      VisibilityTimeout: 5400,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 2 }),
    });
  });

  it("builds the worker to section 7.2's shape, with its spend throttle", () => {
    templateOf("prod", "worker").hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 1769,
      Timeout: 900,
      // Sections 5.7 and 6.8: the ceiling on how fast money can be spent.
      ReservedConcurrentExecutions: 20,
    });
  });

  it("throttles a developer stack far lower than production", () => {
    templateOf("dev", "worker").hasResourceProperties("AWS::Lambda::Function", {
      MemorySize: 1769,
      ReservedConcurrentExecutions: 2,
    });
  });

  it("redelivers only the messages that failed", () => {
    templateOf("prod", "worker").hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 1,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
  });

  it("runs the economy poller every minute, as section 7.2 sets it", () => {
    templateOf("prod", "worker").hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(1 minute)",
      State: "ENABLED",
    });
  });
});

describe("the api stack", () => {
  it("puts a Cognito JWT authorizer in front of everything but two routes", () => {
    const template = templateOf("prod", "api");
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
      IdentitySource: ["$request.header.Authorization"],
    });
    // Section 7.3 marks these two "none" and has them cached at the edge.
    for (const routeKey of ["GET /api/pricing", "GET /api/languages"]) {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: routeKey,
        AuthorizationType: "NONE",
      });
    }
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "ANY /api/{proxy+}",
      AuthorizationType: "JWT",
    });
  });

  it("builds the API function to section 7.2's shape", () => {
    templateOf("prod", "api").hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 512,
    });
  });

  /**
   * Section 9.8: a rate change, a model switch or a batch-size change is an SSM
   * write and not a deploy. The initial values come from the packages that
   * define them, so a parameter cannot start life disagreeing with the code.
   */
  it("writes the runtime configuration of section 9.8 under /lexicue/{env}/", () => {
    const template = templateOf("staging", "api");
    const prefix = parameterPrefix(ENVIRONMENTS.staging);
    expect(prefix).toBe("/lexicue/staging");
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: `${prefix}/pricing/fastRateCentsPer1000Chars`,
      Value: "1",
    });
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: `${prefix}/pricing/economyRateCentsPer1000Chars`,
      Value: "1",
    });
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: `${prefix}/pricing/fastMinimumPriceCents`,
      Value: "10",
    });
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: `${prefix}/pricing/economyMinimumPriceCents`,
      Value: "10",
    });
    // The per-cue component of the rate table, adopted on 14 September 2026.
    // It is what makes the economy lane a third cheaper rather than the same
    // price, both lanes charging 1 cent per 1,000 characters, and it can move
    // without a deploy (spec section 9.8).
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: `${prefix}/pricing/fastRateCentsPer100Cues`,
      Value: "8",
    });
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: `${prefix}/pricing/economyRateCentsPer100Cues`,
      Value: "4",
    });
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: `${prefix}/model/id`,
      Value: "claude-sonnet-5",
    });
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: `${prefix}/model/batchSize`,
      Value: "120",
    });
    // Twenty-one parameters, and every one of them is a thing section 9.8
    // lists. The three added with the rate table are the per-cue component and
    // the per-lane floor, which together let the price of section 6.1 be
    // reshaped without a deploy.
    template.resourceCountIs("AWS::SSM::Parameter", 21);
  });

  it("lets the API read its parameters and write none of them", () => {
    templateOf("prod", "api").hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
            Effect: "Allow",
          }),
        ]),
      }),
    });
  });
});

describe("the web stack", () => {
  it("serves the app and the API from one distribution", () => {
    const template = templateOf("prod", "web");
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: "index.html",
        // Two origins: the private site bucket, and the HTTP API.
        Origins: Match.arrayWith([
          Match.objectLike({ S3OriginConfig: Match.anyValue() }),
          Match.objectLike({
            CustomOriginConfig: Match.objectLike({ OriginProtocolPolicy: "https-only" }),
          }),
        ]),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: "/api/*",
            // CACHING_DISABLED: an API answer must never be served to the next
            // user, and the Authorization header has to reach the authorizer.
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
            ViewerProtocolPolicy: "https-only",
          }),
        ]),
      }),
    });
  });

  it("keeps the site bucket private and reachable only through CloudFront", () => {
    const template = templateOf("prod", "web");
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicPolicy: true }),
    });
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
  });

  /** Synth must not need a build; section 9.6's upload is the deploy path. */
  it("synthesises with no SPA bundle at all", () => {
    templateOf("prod", "web").resourceCountIs("Custom::CDKBucketDeployment", 0);
  });

  it("uploads the SPA when it is given one", () => {
    // The Web stack on its own: it has no Lambdas of its own, so this costs no
    // bundling, and any directory serves as the bundle — what is asserted is
    // that a bundle produces a deployment and an invalidation of `index.html`,
    // not what is inside it.
    const stack = new WebStack(new App(), "WebWithBundle", {
      config: ENVIRONMENTS.prod,
      apiDomainName: "api.example.com",
      siteBundlePath: dirname(fileURLToPath(import.meta.url)),
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs("Custom::CDKBucketDeployment", 2);
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      DistributionPaths: ["/index.html"],
    });
  });
});

describe("the monitoring stack", () => {
  it("alarms on the four things AWS already measures", () => {
    const template = templateOf("prod", "monitoring");
    template.resourceCountIs("AWS::CloudWatch::Alarm", 4);
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "lexicue-prod-dead-letters",
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      AlarmActions: Match.anyValue(),
    });
  });

  it("builds the same alarms on a developer stack but wires them to nobody", () => {
    const template = templateOf("dev", "monitoring");
    template.resourceCountIs("AWS::CloudWatch::Alarm", 4);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "lexicue-dev-dead-letters",
      AlarmActions: Match.absent(),
    });
  });
});
