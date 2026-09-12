import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Duration } from "aws-cdk-lib";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import type { EnvironmentConfig } from "./config.js";

/**
 * Every Lambda in the app, built the same way.
 *
 * Specification section 9.2 has CDK bundle the backend with esbuild through
 * `NodejsFunction`, so there is no separate build step: the entry is the
 * TypeScript handler and the bundle is an artifact of `cdk synth`. Section 7.2
 * fixes the rest — Node.js 22, arm64, and a memory size per function.
 *
 * `LEXICUE_*` environment variables carry only names and prefixes. Section 9.8
 * keeps the rates, the model id, the effort and the limits in SSM so a change
 * needs no deploy, and section 8 keeps every secret out of environment
 * variables entirely, so nothing here is a value anyone could spend.
 */

const HANDLERS = join(dirname(fileURLToPath(import.meta.url)), "handlers");

export interface HandlerOptions {
  readonly config: EnvironmentConfig;
  /** The file under `src/handlers`, without its extension. */
  readonly entry: string;
  readonly memorySize: number;
  readonly timeout: Duration;
  readonly environment: Record<string, string>;
  readonly description: string;
  readonly reservedConcurrentExecutions?: number;
}

export function handlerFunction(
  scope: Construct,
  id: string,
  options: HandlerOptions,
): NodejsFunction {
  // An explicit log group rather than the `logRetention` shortcut, which is
  // deprecated: that one provisions a custom resource with a Lambda of its own
  // just to call `PutRetentionPolicy`, and this is the group itself.
  const logGroup = new LogGroup(scope, `${id}Logs`, {
    retention: options.config.logRetention,
    removalPolicy: options.config.removalPolicy,
  });

  return new NodejsFunction(scope, id, {
    logGroup,
    // Section 7.2 pins Node.js 22 for every function. The repository itself
    // develops and tests on Node 24; see infra/README.md for why that gap is
    // written down rather than closed.
    runtime: Runtime.NODEJS_22_X,
    architecture: Architecture.ARM_64,
    entry: join(HANDLERS, `${options.entry}.ts`),
    handler: "handler",
    memorySize: options.memorySize,
    timeout: options.timeout,
    description: options.description,
    environment: {
      LEXICUE_ENV: options.config.name,
      NODE_OPTIONS: "--enable-source-maps",
      ...options.environment,
    },
    ...(options.reservedConcurrentExecutions === undefined
      ? {}
      : { reservedConcurrentExecutions: options.reservedConcurrentExecutions }),
    bundling: {
      // ESM, because every package in this workspace is ESM and a CommonJS
      // bundle of them is a stack of interop surprises waiting to happen.
      format: OutputFormat.ESM,
      target: "node22",
      minify: true,
      sourceMap: true,
      // The AWS SDK is on the runtime already; bundling it would add megabytes
      // and pin a version nobody chose.
      externalModules: ["@aws-sdk/*"],
      banner:
        // esbuild's ESM output uses `require` in a few shims; Lambda's ESM
        // loader has none, so one is created from `createRequire`.
        "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
    },
  });
}

export type { IFunction };
