# infra — the CDK app

The stacks of specification section 7.2 and the pipeline notes of section 9, as
an AWS CDK app. **Nothing has ever been deployed.** There is no AWS account, no
OIDC role, no bootstrap and no domain, so what this directory is for today is
`cdk synth` and the assertion tests — which is enough to make the
infrastructure a reviewed artifact rather than a plan in a document.

```sh
pnpm test                       # synthesises every stack for dev, staging and prod
pnpm --filter @lexicue/infra synth -- -c env=staging   # needs the aws-cdk CLI
```

`aws-cdk-lib` is pinned at an exact version (2.269.0) with `constructs`
(10.8.1). The `aws-cdk` **CLI** is deliberately not a dependency: it is only
useful to somebody with an account, and `pnpm dlx aws-cdk@2 synth` gets it when
that day comes. The assertion tests do not need it.

**`esbuild` is a devDependency of the root package.json, and that is not an
accident.** `NodejsFunction` bundles by spawning `pnpm exec -- esbuild` with
its working directory set to the directory holding `pnpm-lock.yaml` — the
repository root, which is also where `pnpm test` starts — so the root is the
only manifest whose dependencies put `esbuild` on that command's path. It is
pinned to the exact version Vite and tsx already resolve (0.28.2) so no second
copy is installed; `pnpm why esbuild` shows what that is, and the pin should
move when it does. `infra/src/functions.ts` has the long version. Without it
the suite does not merely fail an assertion, it fails to load, which is how it
passed on a laptop with a stale bin and went red on a clean CI runner.

## The six stacks

| Stack        | What it owns                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| `Auth`       | Cognito user pool and the SPA's public client; verified email, which is what grants the $2.50           |
| `Storage`    | The single DynamoDB table of section 7.4 and the files bucket, expiring after one day                   |
| `Worker`     | SQS queue and dead-letter queue, the worker, the economy poller on its minute schedule, the zip builder |
| `Api`        | HTTP API, the Cognito JWT authorizer, the API Lambda, and the SSM parameters of section 9.8             |
| `Web`        | The site bucket and the CloudFront distribution, with the `/api/*` origin                               |
| `Monitoring` | An SNS topic and the four alarms of section 11.1 that AWS already has metrics for                       |

Dependencies run in that order. `Auth` and `Storage` own things that must
outlive a deploy and depend on nothing; `Worker` owns the queue, `Api` sends to
it, `Web` points at `Api`, `Monitoring` watches all of them.

`cdk deploy -c env=staging`, or `-c env=dev-anna` for a per-developer stack,
which is the `dev` configuration under its own name so two developers never
share a table (section 9.3).

## The handlers are adapters over `packages/core`

This is the part worth reading. Every rule — what a file is, what it costs,
whether the balance covers it, what state an upload is in — is in
`@lexicue/core`, and these handlers only translate events:

- **`handlers/api.ts`** turns an API Gateway HTTP API v2 event into an
  `ApiService` call and back into JSON. It is real and tested: nine tests in
  `handlers/handlers.test.ts` drive it with hand-written events and in-memory
  stores, including charging for a batch. The authorizer has already validated
  the Cognito token before it runs, so `callerOf` reads the claims rather than
  checking them — and there is a test that a route which somehow lost its
  authorizer fails closed.
- **`handlers/worker.ts`** turns an SQS message into the same
  `ApiService.translate` that `pnpm dev` calls in its own process, reports the
  failed message ids rather than throwing, and is tested end to end against the
  deterministic fake model client.
- **`handlers/poller.ts`** and **`handlers/zip.ts`** are stubs that reject with
  a sentence saying so. Both are transcription jobs rather than design ones —
  `collectEconomyBatch` in the harness and `ApiService.zipContents` already do
  the thinking — but writing them against a bucket and a table that do not
  exist would produce code nobody has run.
- **`adapters/aws-stores.ts`** is the DynamoDB and S3 implementation of the
  core's two interfaces, and **it is unimplemented on purpose**. Each method
  carries the exact call it becomes: `load` is one `Query` on `USER#{sub}`,
  `commit` is one `TransactWriteItems` whose `requireBalanceAtLeast` is section
  7.4's `ConditionExpression`, and the file store is three object calls. An
  unrunnable implementation of a money path would look tested and would not be.

So the `handler` exports fail closed with a `NotDeployedError` the moment
anything invokes them, which is the correct behaviour for a function in an
account that does not exist. `routeRequest` and `consume` are what the tests
drive, and they are the whole of the logic.

## What the tests prove, and what they cost

`stacks.test.ts` synthesises all six stacks for all three environments with no
credentials, no account and no network, and asserts the properties where being
wrong costs money or loses a file: the lifecycle rule, the table's retention and
TTL, the dead-letter queue after one redelivery, the worker's reserved
concurrency, the authorizer in front of everything but section 7.3's two public
routes, the eighteen SSM parameters, and which CloudFront behaviour `/api/*`
lands on.

It takes about thirty seconds, because synthesis bundles six Lambdas with
esbuild exactly as section 9.2 describes, and the worker's bundle is 1.3 MB of
harness and SDK. That is the price of knowing the handlers bundle at all, and
it is paid on every `pnpm test`. The templates are cached per environment and
warmed in a `beforeAll`, so no individual test pays for it and the suite is
deterministic.

## Decisions and gaps, in one place

**`exactOptionalPropertyTypes` is off in this package, and only here.**
aws-cdk-lib's types are generated from JSII, which declares an optional property
as `foo?: T` and never `T | undefined`, so under that flag a concrete construct
is not assignable to its own interface — `TableV2` to `ITableV2`. No care at the
call site fixes it. Everything else stays strict.

**Node.js 22 in Lambda, Node 24 in the repository.** Section 7.2 pins the
runtime at Node.js 22 and this app follows it, while development and CI are on 24. Running a different major in production than in CI is a real if small risk,
and the fix is a one-line change once the founder says which way to close it.

**SES is not wired, so Cognito sends its own mail.** Section 7.2 notes that
Cognito's default sender is capped at fifty emails a day. Sending through SES
needs a region, section 7.6's region is still an open decision (section 12.1
item 9), and `sesRegion` is therefore configuration set to null. **That cap is a
launch blocker**, not a design gap.

**Not built at all**, and why:

- **AWS WAF.** `wafEnabled` is in the per-environment configuration and nothing
  reads it yet. Section 6.8 wants a rate-based rule and the two AWS managed rule
  groups on CloudFront; it is $8 to $10 a month and needs a decision about
  thresholds that only real traffic can inform.
- **Route 53 and ACM.** Section 7.6's apex domain needs a hosted zone and a
  certificate in `us-east-1`, which needs the domain to be held in the account.
  `domainName` is configured for production and the distribution does not claim
  it.
- **The post-confirmation trigger.** Section 7.2 grants the free balance from a
  Cognito trigger. `ApiService.verifyEmail` is the code that does the granting,
  once per email ever; wiring the trigger is a Lambda in the Api stack and a
  dependency from Auth to it.
- **The dead-letter refund function.** Section 7.5 wants a small Lambda on the
  DLQ that refunds a file so no user is ever charged for a crash. `failJobs` in
  the core is the refund; the function around it is not written.
- **Twelve of section 11.1's alarms.** The four that exist are the ones AWS
  publishes metrics for. Cost per file, cache read tokens per file, untranslated
  cues, the oldest pending Message Batch and the nightly wallet reconciliation
  are all `putMetricData` calls the worker and the poller do not make yet, and
  an alarm on a metric nobody emits is a dashboard of permanent gaps.
- **`deploy.yml`, `evals.yml`, `rollback.yml`.** Every one of them needs an
  account and an OIDC role. `ci.yml` exists and is described in the root README.

## What the founder has to do before any of this runs

1. Create the three AWS accounts of section 9.3 under an organisation, and
   decide the region section 7.6 leaves open.
2. `cdk bootstrap` each account, and create the GitHub OIDC provider and a
   deployment role per account, restricted to this repository.
3. Hold `lexicue.io` in the production account, with a hosted zone and an ACM
   certificate in `us-east-1` for CloudFront.
4. Put the Anthropic key in Secrets Manager per environment, with the spend
   limits of section 9.3 set in the Anthropic Console.
5. Say which way to close the Node 22-versus-24 gap, and whether to pay for WAF
   before launch.
