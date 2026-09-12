import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
  type IAlarmAction,
} from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import { Topic, type ITopic } from "aws-cdk-lib/aws-sns";
import type { Construct } from "constructs";
import type { EnvironmentConfig } from "../config.js";

/**
 * The alarms of specification section 11.1 that can be built from metrics AWS
 * already publishes.
 *
 * Four of the section's rows are here: the dead-letter queue, the age of the
 * oldest message, the worker's failure rate and the API's 5xx rate. They share
 * one SNS topic, which section 11.1 feeds to email and Slack.
 *
 * The rest of the section needs metrics the application has to emit — cost per
 * file, cache read tokens per file, untranslated cues, the economy lane's
 * oldest pending Message Batch, the nightly wallet reconciliation. Those are
 * `putMetricData` calls in the worker and the poller, and building the alarms
 * before the metrics exist would create a dashboard of permanently missing
 * data, which is worse than a short list. `infra/README.md` names each one.
 */

export interface MonitoringStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly queue: IQueue;
  readonly deadLetterQueue: IQueue;
  readonly worker: IFunction;
  readonly apiFunction: IFunction;
}

export class MonitoringStack extends Stack {
  readonly alarmTopic: ITopic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.alarmTopic = new Topic(this, "Alarms", {
      topicName: `lexicue-alarms-${config.name}`,
      displayName: `Lexicue ${config.name} alarms`,
    });
    const action: IAlarmAction = new SnsAction(this.alarmTopic);
    const wire = (alarm: Alarm): void => {
      if (!config.alarmsEnabled) return;
      alarm.addAlarmAction(action);
    };

    // "Dead-letter queue depth: any message." A file in here has already been
    // refunded by the DLQ function; the alarm is how anybody finds out why.
    wire(
      new Alarm(this, "DeadLetters", {
        alarmName: `lexicue-${config.name}-dead-letters`,
        alarmDescription:
          "A file failed twice and was refunded. Inspect by jobId (spec section 11.2).",
        metric: props.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(5),
        }),
        threshold: 0,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // "Queue depth and age of oldest message: oldest message over 5 minutes."
    wire(
      new Alarm(this, "QueueAge", {
        alarmName: `lexicue-${config.name}-queue-age`,
        alarmDescription: "Files are waiting longer than five minutes to start.",
        metric: props.queue.metricApproximateAgeOfOldestMessage({
          period: Duration.minutes(5),
        }),
        threshold: Duration.minutes(5).toSeconds(),
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // "Files started, done, failed, per lane: failure rate over 5% in 15
    // minutes." Until the worker emits its own counters this is the Lambda's
    // own error metric, which is a coarser version of the same question.
    wire(
      new Alarm(this, "WorkerErrors", {
        alarmName: `lexicue-${config.name}-worker-errors`,
        alarmDescription: "The worker is failing files.",
        metric: props.worker.metricErrors({ period: Duration.minutes(15) }),
        threshold: 3,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // "API 5xx and 4xx rates, latency: 5xx over 1%."
    wire(
      new Alarm(this, "ApiErrors", {
        alarmName: `lexicue-${config.name}-api-errors`,
        alarmDescription: "The API is answering 5xx.",
        metric: new Metric({
          namespace: "AWS/Lambda",
          metricName: "Errors",
          statistic: "Sum",
          period: Duration.minutes(5),
          dimensionsMap: { FunctionName: props.apiFunction.functionName },
        }),
        threshold: 5,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );
  }
}
