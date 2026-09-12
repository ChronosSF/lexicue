import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  HttpVersion,
  OriginRequestPolicy,
  PriceClass,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
  type IDistribution,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { BlockPublicAccess, Bucket, BucketEncryption, type IBucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, CacheControl, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import type { EnvironmentConfig } from "../config.js";

/**
 * The static site of specification sections 7.2 and 9.6.
 *
 * One CloudFront distribution with two origins: the site bucket for everything,
 * and the HTTP API for `/api/*`. That is what lets the app and the API share
 * one domain, which is what means there is no CORS to configure and no
 * preflight on every call (section 7.2).
 *
 * Caching follows section 9.6 exactly: hashed assets are immutable for a year
 * and `index.html` is not cached, so a deploy is visible immediately and a
 * returning browser fetches almost nothing. `/api/*` is
 * `CACHING_DISABLED` with `ALL_VIEWER_EXCEPT_HOST_HEADER`, because the
 * `Authorization` header has to reach the authorizer and an API response must
 * never be served to the next user.
 *
 * The SPA bundle is optional. `siteBundlePath` is the built `apps/web/dist`,
 * and when it is absent the stack synthesises the bucket and the distribution
 * without a deployment — which is how the assertion tests and `cdk synth` run
 * on a checkout nobody has built. Section 9.6's `BucketDeployment` is the
 * deploy path, not the synth path.
 */

export interface WebStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  /** `{apiId}.execute-api.{region}.amazonaws.com`, from the Api stack. */
  readonly apiDomainName: string;
  /** The built SPA. Omitted, the stack synthesises without a deployment. */
  readonly siteBundlePath?: string;
}

export class WebStack extends Stack {
  readonly siteBucket: IBucket;
  readonly distribution: IDistribution;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.siteBucket = new Bucket(this, "Site", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: config.removalPolicy,
      autoDeleteObjects: config.removalPolicy === RemovalPolicy.DESTROY,
    });

    const apiOrigin = new HttpOrigin(props.apiDomainName, {
      readTimeout: Duration.seconds(30),
    });

    const distribution = new Distribution(this, "Distribution", {
      comment: `Lexicue ${config.name}`,
      // Origin access control: the bucket stays private and only this
      // distribution can read it (section 8, public access blocked).
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      additionalBehaviors: {
        "/api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          // The Authorization header has to reach the authorizer; the Host
          // header must not, or API Gateway rejects the signature.
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: true,
        },
      },
      defaultRootObject: "index.html",
      // A hash router on a single page: every unknown path is the app.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
      httpVersion: HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      // Europe and North America; section 7.6 picks one region for everything
      // else and the audience is not global yet.
      priceClass: PriceClass.PRICE_CLASS_100,
      enableLogging: config.stage === "prod",
    });
    this.distribution = distribution;

    if (props.siteBundlePath !== undefined) {
      new BucketDeployment(this, "SiteDeployment", {
        sources: [Source.asset(props.siteBundlePath)],
        destinationBucket: this.siteBucket,
        distribution,
        // Section 9.6: only index.html is invalidated, because every other file
        // is content-hashed and a new deploy writes new names.
        distributionPaths: ["/index.html"],
        prune: false,
        cacheControl: [CacheControl.fromString("public,max-age=31536000,immutable")],
        exclude: ["index.html", "config.json"],
      });
      new BucketDeployment(this, "SiteEntry", {
        sources: [Source.asset(props.siteBundlePath, { exclude: ["**", "!index.html"] })],
        destinationBucket: this.siteBucket,
        prune: false,
        cacheControl: [CacheControl.fromString("no-cache")],
      });
    }

    new CfnOutput(this, "SiteUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description: "Where the app is served from",
    });
  }
}
