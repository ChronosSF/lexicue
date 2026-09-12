import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AttributeType, Billing, TableEncryptionV2, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  HttpMethods,
  type IBucket,
} from "aws-cdk-lib/aws-s3";
import type { ITableV2 } from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";
import { tableName, type EnvironmentConfig } from "../config.js";

/**
 * The table of specification section 7.4 and the bucket of section 7.2.
 *
 * One DynamoDB table holds every row — users, batches, jobs, ledger,
 * idempotency markers, the poller's worklist — under a partition key `PK` and
 * a sort key `SK`, with no global secondary index, because v1 never queries
 * anything except one user's own partition. That is the same shape
 * `packages/core`'s `MetadataStore.load` reads in a single `Query`.
 *
 * One bucket holds uploads, outputs and zips, private, encrypted, and expiring
 * after a day. The 24-hour promise of section 3.2 is an S3 lifecycle rule
 * rather than application code on purpose: a rule keeps deleting files while
 * the application is broken, and "files never retained beyond 24 hours" is a
 * privacy claim in section 3.6 that should not depend on a Lambda running.
 */

export interface StorageStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

export class StorageStack extends Stack {
  readonly table: ITableV2;
  readonly filesBucket: IBucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.table = new TableV2(this, "Table", {
      tableName: tableName(config),
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      // On-demand: near-zero cost at low volume and nothing to scale by hand.
      billing: Billing.onDemand(),
      // The TTL attribute every expiring row carries: 30 days on a batch, a
      // job and a ledger entry, 90 days on a Stripe event marker.
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: config.pointInTimeRecovery,
      },
      encryption: TableEncryptionV2.dynamoOwnedKey(),
      removalPolicy: config.removalPolicy,
      deletionProtection: config.stage === "prod",
    });

    this.filesBucket = new Bucket(this, "Files", {
      // Section 8: private, encrypted at rest, public access blocked, HTTPS
      // only. Nothing in this bucket is ever served directly to a browser
      // except through a presigned URL.
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: config.removalPolicy,
      autoDeleteObjects: config.removalPolicy === RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          // Section 3.2's retention, as a rule rather than as code.
          id: "expire-after-one-day",
          expiration: Duration.days(1),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      cors: [
        {
          // The browser PUTs straight to S3 with a presigned POST and GETs the
          // finished file with a presigned GET (section 7.1), so the bucket has
          // to answer the app's origin rather than the API's.
          allowedMethods: [HttpMethods.GET, HttpMethods.POST, HttpMethods.HEAD],
          allowedOrigins: config.domainName === null ? ["*"] : [`https://${config.domainName}`],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 3000,
        },
      ],
    });
  }
}
