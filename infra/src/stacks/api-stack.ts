import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import {
  CorsHttpMethod,
  HttpApi,
  HttpMethod,
  HttpRoute,
  HttpRouteKey,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { IUserPool, IUserPoolClient } from "aws-cdk-lib/aws-cognito";
import type { ITableV2 } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import {
  DEFAULT_RATE_TABLE,
  DEFAULT_TOP_UP_CENTS,
  FREE_BALANCE_CENTS,
  TOP_UP_AMOUNTS_CENTS,
} from "@lexicue/pricing";
import { CONCURRENT_FAST_FILES, MAX_FILES_PER_DAY } from "@lexicue/shared";
import { DEFAULT_HARNESS_CONFIG } from "@lexicue/harness";
import { MAX_CUES_PER_FILE, MAX_FILES_PER_UPLOAD } from "@lexicue/subtitles";
import { parameterPrefix, type EnvironmentConfig } from "../config.js";
import { handlerFunction } from "../functions.js";

/**
 * The HTTP API of specification section 7.2, and the runtime configuration of
 * section 9.8.
 *
 * Two routes are deliberately unauthenticated, because section 7.3 says so:
 * `GET /api/pricing` and `GET /api/languages` are cached at the edge and carry
 * nothing about anybody. Everything else goes through a JWT authorizer against
 * the Cognito user pool, so an unauthenticated request never reaches a Lambda
 * at all, which is what makes the API handler's `callerOf` a read of claims
 * rather than a check of them.
 *
 * The parameters under `/lexicue/{env}/` are the point of section 9.8: a rate
 * change, a model switch or a batch-size change is an SSM write and not a
 * deploy. Their initial values come from the packages that define them, so the
 * parameter and the code cannot start out disagreeing — `pnpm typecheck` fails
 * if a name moves.
 */

export interface ApiStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly table: ITableV2;
  readonly filesBucket: IBucket;
  readonly queue: IQueue;
  readonly userPool: IUserPool;
  readonly userPoolClient: IUserPoolClient;
}

export class ApiStack extends Stack {
  readonly httpApi: HttpApi;
  readonly apiFunction: IFunction;
  /** What CloudFront points its `/api/*` behaviour at (section 7.2). */
  readonly apiDomainName: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, table, filesBucket, queue, userPool, userPoolClient } = props;

    this.apiFunction = handlerFunction(this, "Api", {
      config,
      entry: "api",
      // Section 7.2: 512 MB. It handles metadata and money and never a file.
      memorySize: 512,
      timeout: Duration.seconds(29),
      environment: {
        LEXICUE_TABLE: table.tableName,
        LEXICUE_FILES_BUCKET: filesBucket.bucketName,
        LEXICUE_QUEUE_URL: queue.queueUrl,
        LEXICUE_PARAMETER_PREFIX: parameterPrefix(config),
      },
      description: "The routes of specification section 7.3",
    });

    table.grantReadWriteData(this.apiFunction);
    // The API signs upload and download URLs and never reads or writes an
    // object itself: the bytes never pass through a Lambda (section 7.1).
    filesBucket.grantPut(this.apiFunction);
    filesBucket.grantRead(this.apiFunction);
    queue.grantSendMessages(this.apiFunction);

    this.httpApi = new HttpApi(this, "HttpApi", {
      apiName: `lexicue-${config.name}`,
      description: "Lexicue API (specification section 7.3)",
      // A configured domain needs no CORS at all: the app and the API share it
      // behind CloudFront (section 7.2). A developer stack has no domain and is
      // reached from Vite on localhost, so that one origin is allowed.
      ...(config.domainName === null
        ? {
            corsPreflight: {
              allowOrigins: ["http://localhost:5173"],
              allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.DELETE],
              allowHeaders: ["authorization", "content-type"],
              maxAge: Duration.hours(1),
            },
          }
        : {}),
    });

    const integration = new HttpLambdaIntegration("ApiIntegration", this.apiFunction);
    const authorizer = new HttpJwtAuthorizer(
      "CognitoAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      {
        authorizerName: `lexicue-jwt-${config.name}`,
        jwtAudience: [userPoolClient.userPoolClientId],
        identitySource: ["$request.header.Authorization"],
      },
    );

    // The two routes section 7.3 marks "none".
    for (const path of ["/api/pricing", "/api/languages"]) {
      new HttpRoute(this, `Public${path.replace(/\W/g, "")}`, {
        httpApi: this.httpApi,
        routeKey: HttpRouteKey.with(path, HttpMethod.GET),
        integration,
      });
    }

    // Everything else, behind the authorizer. A greedy route keeps the routing
    // table in one place — the handler — rather than split between the handler
    // and API Gateway, which is what let `packages/dev-api` and this share it.
    new HttpRoute(this, "Authenticated", {
      httpApi: this.httpApi,
      routeKey: HttpRouteKey.with("/api/{proxy+}", HttpMethod.ANY),
      integration,
      authorizer,
    });

    this.apiDomainName = `${this.httpApi.apiId}.execute-api.${this.region}.${this.urlSuffix}`;

    this.addParameters(config);

    new CfnOutput(this, "ApiEndpoint", {
      value: this.apiDomainName,
      description: "The origin CloudFront routes /api/* to",
    });
  }

  /**
   * Section 9.8's parameters. Lambdas read them at cold start and refresh every
   * five minutes, so a rate change never applies to a batch already priced.
   */
  private addParameters(config: EnvironmentConfig): void {
    const prefix = parameterPrefix(config);
    const parameters: Record<string, string> = {
      // The rate table of spec section 6.1, one parameter per number, so any
      // one of them can be moved without touching the others. The per-cue
      // components are zero: today's price is purely per character.
      "pricing/fastRateCentsPer1000Chars": DEFAULT_RATE_TABLE.fast.centsPer1000Chars.toString(),
      "pricing/fastRateCentsPer100Cues": DEFAULT_RATE_TABLE.fast.centsPer100Cues.toString(),
      "pricing/fastMinimumPriceCents": DEFAULT_RATE_TABLE.fast.minimumPriceCents.toString(),
      "pricing/economyRateCentsPer1000Chars":
        DEFAULT_RATE_TABLE.economy.centsPer1000Chars.toString(),
      "pricing/economyRateCentsPer100Cues": DEFAULT_RATE_TABLE.economy.centsPer100Cues.toString(),
      "pricing/economyMinimumPriceCents": DEFAULT_RATE_TABLE.economy.minimumPriceCents.toString(),
      "pricing/topUpAmountsCents": TOP_UP_AMOUNTS_CENTS.join(","),
      "pricing/defaultTopUpCents": DEFAULT_TOP_UP_CENTS.toString(),
      "pricing/freeGrantCents": FREE_BALANCE_CENTS.toString(),
      "model/id": DEFAULT_HARNESS_CONFIG.model,
      "model/fallbackId": DEFAULT_HARNESS_CONFIG.fallbackModel,
      "model/effort": DEFAULT_HARNESS_CONFIG.effort,
      "model/batchSize": DEFAULT_HARNESS_CONFIG.batchSize.toString(),
      "model/concurrency": DEFAULT_HARNESS_CONFIG.concurrency.toString(),
      "model/economyCacheTtl": DEFAULT_HARNESS_CONFIG.economyCacheTtl,
      "limits/maxFilesPerUpload": MAX_FILES_PER_UPLOAD.toString(),
      "limits/maxCuesPerFile": MAX_CUES_PER_FILE.toString(),
      "limits/concurrentFastFiles": CONCURRENT_FAST_FILES.toString(),
      "limits/maxFilesPerDay": MAX_FILES_PER_DAY.toString(),
      // Section 6.9's levers, as flags rather than as a deploy.
      "flags/economyLaneEnabled": "true",
      "flags/customTopUpEnabled": "false",
    };

    for (const [name, value] of Object.entries(parameters)) {
      new StringParameter(this, `Parameter${name.replace(/\W/g, "")}`, {
        parameterName: `${prefix}/${name}`,
        stringValue: value,
        description: `Specification section 9.8: ${name}`,
      });
    }

    // Read of the whole prefix, write of nothing: a rate change is a
    // deliberate act by a person with a console, not something a handler can
    // do to itself.
    this.apiFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
        resources: [
          `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${prefix}`,
          `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${prefix}/*`,
        ],
      }),
    );
  }
}
