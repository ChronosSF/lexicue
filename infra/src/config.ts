import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { RetentionDays } from "aws-cdk-lib/aws-logs";

/**
 * Per-environment configuration, from specification section 9.3.
 *
 * Three accounts under AWS Organizations keep blast radius and bills separate:
 * a per-developer `dev-{name}` that is destroyed when idle, a `staging` that
 * mirrors production and is the target of every merge to `main`, and `prod`.
 * What differs between them is deliberately small — what survives a stack
 * delete, how long logs are kept, how much the worker may spend at once, and
 * whether the edge protection of section 6.8 is on — because a staging that is
 * not a mirror is not a smoke test.
 */

export type Stage = "dev" | "staging" | "prod";

export interface EnvironmentConfig {
  /** The suffix on every resource name: `dev-anna`, `staging`, `prod`. */
  readonly name: string;
  readonly stage: Stage;
  /** What happens to the table and the buckets when the stack is deleted. */
  readonly removalPolicy: RemovalPolicy;
  /** Point-in-time recovery on the table: a real cost, and real insurance. */
  readonly pointInTimeRecovery: boolean;
  readonly logRetention: RetentionDays;
  /**
   * The throttle that keeps the fast lane inside the API tier and caps model
   * spend in a burst (sections 5.7 and 6.8). A developer stack does not need 20.
   */
  readonly workerReservedConcurrency: number;
  /** AWS WAF on CloudFront: about $8 to $10 a month (section 11.3). */
  readonly wafEnabled: boolean;
  /** Alarms wired to an SNS topic. Off on a developer stack. */
  readonly alarmsEnabled: boolean;
  /** The apex domain of section 7.6, when one is configured. */
  readonly domainName: string | null;
  /**
   * Where SES sends Cognito's mail. Null until section 7.6's region is decided
   * (section 12.1 item 9), which leaves Cognito's own sender and its cap of 50
   * emails a day — a launch blocker, not a design one.
   */
  readonly sesRegion: string | null;
  /** Where the poller looks for ended Message Batches (section 7.5). */
  readonly pollerInterval: Duration;
}

const BASE = {
  logRetention: RetentionDays.ONE_MONTH,
  pollerInterval: Duration.minutes(1),
  sesRegion: null,
} as const;

export const ENVIRONMENTS: Record<Stage, EnvironmentConfig> = {
  // `cdk deploy -c env=dev` or `-c env=dev-anna`; destroyed when idle, so
  // nothing is retained and no money goes on WAF or point-in-time recovery.
  dev: {
    ...BASE,
    name: "dev",
    stage: "dev",
    removalPolicy: RemovalPolicy.DESTROY,
    pointInTimeRecovery: false,
    logRetention: RetentionDays.ONE_WEEK,
    workerReservedConcurrency: 2,
    wafEnabled: false,
    alarmsEnabled: false,
    domainName: null,
  },
  staging: {
    ...BASE,
    name: "staging",
    stage: "staging",
    // A mirror of production in shape, but a stack that can be replaced.
    removalPolicy: RemovalPolicy.DESTROY,
    pointInTimeRecovery: true,
    workerReservedConcurrency: 5,
    wafEnabled: true,
    alarmsEnabled: true,
    domainName: null,
  },
  prod: {
    ...BASE,
    name: "prod",
    stage: "prod",
    // Customers' files and money. A stack delete must not take the table.
    removalPolicy: RemovalPolicy.RETAIN,
    pointInTimeRecovery: true,
    logRetention: RetentionDays.THREE_MONTHS,
    workerReservedConcurrency: 20,
    wafEnabled: true,
    alarmsEnabled: true,
    domainName: "lexicue.io",
  },
};

/**
 * Resolves `-c env=…`. A per-developer stack is `dev-anna`, which is the `dev`
 * configuration under its own name, so two developers never share a table.
 */
export function environmentFor(value: string | undefined): EnvironmentConfig {
  const requested = (value ?? "dev").trim();
  if (requested.startsWith("dev-")) {
    return { ...ENVIRONMENTS.dev, name: requested };
  }
  const known = ENVIRONMENTS[requested as Stage];
  if (known === undefined) {
    throw new Error(
      `Unknown environment "${requested}". Use dev, dev-{name}, staging or prod (specification section 9.3).`,
    );
  }
  return known;
}

/** Every runtime parameter lives under this prefix (spec section 9.8). */
export function parameterPrefix(config: EnvironmentConfig): string {
  return `/lexicue/${config.name}`;
}

/** The single table of spec section 7.4. */
export function tableName(config: EnvironmentConfig): string {
  return `subtitles-${config.name}`;
}

/** A stack id that reads the same in the console as in the pipeline. */
export function stackName(config: EnvironmentConfig, stack: string): string {
  return `Lexicue-${stack}-${config.name}`;
}
