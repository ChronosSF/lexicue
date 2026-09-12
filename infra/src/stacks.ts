import type { App } from "aws-cdk-lib";
import { stackName, type EnvironmentConfig } from "./config.js";
import { ApiStack } from "./stacks/api-stack.js";
import { AuthStack } from "./stacks/auth-stack.js";
import { MonitoringStack } from "./stacks/monitoring-stack.js";
import { StorageStack } from "./stacks/storage-stack.js";
import { WebStack } from "./stacks/web-stack.js";
import { WorkerStack } from "./stacks/worker-stack.js";

/**
 * The six stacks of specification section 7.2, and what each one needs from the
 * others.
 *
 * The order is the dependency order and it is not arbitrary. Auth and Storage
 * own things that outlive a deploy — a user pool and a table — so nothing they
 * do depends on anything else. Worker owns the queue, Api sends to it, Web
 * points at Api, and Monitoring watches all of them. Keeping that in one
 * function rather than in `app.ts` is what lets the tests build every stack
 * exactly the way the app does.
 */

export interface BuiltStacks {
  auth: AuthStack;
  storage: StorageStack;
  worker: WorkerStack;
  api: ApiStack;
  web: WebStack;
  monitoring: MonitoringStack;
}

export interface BuildOptions {
  /** The built `apps/web/dist`. Omitted, Web synthesises without a deployment. */
  readonly siteBundlePath?: string;
}

export function buildStacks(
  app: App,
  config: EnvironmentConfig,
  options: BuildOptions = {},
): BuiltStacks {
  const tags = { Project: "lexicue", Environment: config.name };

  const auth = new AuthStack(app, stackName(config, "Auth"), {
    config,
    tags,
    description: `Cognito user pool and web client (${config.name})`,
  });

  const storage = new StorageStack(app, stackName(config, "Storage"), {
    config,
    tags,
    description: `The single table of section 7.4 and the files bucket of 7.2 (${config.name})`,
  });

  const worker = new WorkerStack(app, stackName(config, "Worker"), {
    config,
    tags,
    description: `Job queue, worker, poller and zip builder (${config.name})`,
    table: storage.table,
    filesBucket: storage.filesBucket,
  });

  const api = new ApiStack(app, stackName(config, "Api"), {
    config,
    tags,
    description: `The HTTP API of section 7.3 behind a JWT authorizer (${config.name})`,
    table: storage.table,
    filesBucket: storage.filesBucket,
    queue: worker.queue,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
  });

  const web = new WebStack(app, stackName(config, "Web"), {
    config,
    tags,
    description: `The static site and its CloudFront distribution (${config.name})`,
    apiDomainName: api.apiDomainName,
    ...(options.siteBundlePath === undefined ? {} : { siteBundlePath: options.siteBundlePath }),
  });

  const monitoring = new MonitoringStack(app, stackName(config, "Monitoring"), {
    config,
    tags,
    description: `Alarms from section 11.1 (${config.name})`,
    queue: worker.queue,
    deadLetterQueue: worker.deadLetterQueue,
    worker: worker.worker,
    apiFunction: api.apiFunction,
  });

  return { auth, storage, worker, api, web, monitoring };
}
