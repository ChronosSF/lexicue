import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import type { ITableV2 } from "aws-cdk-lib/aws-dynamodb";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { Queue, type IQueue } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import type { EnvironmentConfig } from "../config.js";
import { handlerFunction } from "../functions.js";

/**
 * The queue and the three functions behind it, from specification sections 7.2
 * and 7.5.
 *
 * One message per file. The visibility timeout is six times the worker's
 * timeout, which is AWS's own guidance and stops a slow film being handed to a
 * second worker while the first is still on it. `maxReceiveCount` is 2, so a
 * file gets one redelivery and then lands in the dead-letter queue, where a
 * small function refunds it: section 7.5 is explicit that no user is ever
 * charged for a crash.
 *
 * Reserved concurrency on the worker is the throttle of sections 5.7 and 6.8.
 * It is the one number in this stack that decides how fast money can be spent,
 * which is why it is per-environment configuration and not a constant.
 */

export interface WorkerStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly table: ITableV2;
  readonly filesBucket: IBucket;
}

export class WorkerStack extends Stack {
  readonly queue: IQueue;
  readonly deadLetterQueue: IQueue;
  readonly worker: IFunction;
  readonly poller: IFunction;
  readonly zipBuilder: IFunction;

  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);
    const { config, table, filesBucket } = props;

    const workerTimeout = Duration.minutes(15);

    this.deadLetterQueue = new Queue(this, "JobsDlq", {
      queueName: `lexicue-jobs-dlq-${config.name}`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    this.queue = new Queue(this, "Jobs", {
      queueName: `lexicue-jobs-${config.name}`,
      // Six times the worker timeout, per AWS guidance (section 7.2).
      visibilityTimeout: Duration.seconds(workerTimeout.toSeconds() * 6),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 2 },
    });

    const environment = {
      LEXICUE_TABLE: table.tableName,
      LEXICUE_FILES_BUCKET: filesBucket.bucketName,
      LEXICUE_QUEUE_URL: this.queue.queueUrl,
    };

    this.worker = handlerFunction(this, "Worker", {
      config,
      entry: "worker",
      // Section 7.2's 1,769 MB is one full vCPU, which is the point: the
      // harness waits on the model far more than it computes, but it holds a
      // whole film in memory while it reassembles one.
      memorySize: 1769,
      timeout: workerTimeout,
      environment,
      description: "Runs the translation harness for one file (spec section 7.5)",
      reservedConcurrentExecutions: config.workerReservedConcurrency,
    });
    this.worker.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize: 1,
        // Redeliver the messages that failed, not the whole receive.
        reportBatchItemFailures: true,
      }),
    );

    this.poller = handlerFunction(this, "Poller", {
      config,
      entry: "poller",
      memorySize: 1024,
      timeout: Duration.minutes(15),
      environment,
      description: "Collects ended Message Batches on the economy lane (spec section 4.5)",
    });
    new Rule(this, "PollerSchedule", {
      ruleName: `lexicue-poller-${config.name}`,
      description: "Every minute, as specification section 7.2 sets it",
      schedule: Schedule.rate(config.pollerInterval),
      targets: [new LambdaFunction(this.poller)],
    });

    this.zipBuilder = handlerFunction(this, "Zip", {
      config,
      entry: "zip",
      memorySize: 1024,
      timeout: Duration.minutes(5),
      environment,
      description: "Streams a finished multi-file upload into one zip (spec section 7.2)",
    });

    // Section 8, least privilege: each function gets exactly the table, the
    // bucket prefix and the queue it needs, and none of them can create a
    // Stripe Checkout Session or read the model key that the API can.
    for (const fn of [this.worker, this.poller, this.zipBuilder]) {
      table.grantReadWriteData(fn);
      filesBucket.grantReadWrite(fn);
    }
    this.queue.grantConsumeMessages(this.worker);
    // The poller re-runs an overdue economy file on the fast lane, which is a
    // message on this queue (section 4.5).
    this.queue.grantSendMessages(this.poller);
  }
}
