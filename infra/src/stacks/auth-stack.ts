import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  AccountRecovery,
  Mfa,
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolEmail,
  VerificationEmailStyle,
  type IUserPool,
  type IUserPoolClient,
} from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import type { EnvironmentConfig } from "../config.js";

/**
 * Cognito, from specification sections 2.1 and 7.2.
 *
 * Email and password with verification required, because verification is what
 * grants the $2.50 (section 6.5) and what the abuse controls of section 6.8
 * rest on. Google sign-in is a configuration toggle rather than a v1
 * requirement, so it is not wired here; adding it is an identity provider and
 * one line on the client.
 *
 * The post-confirmation trigger that grants the free balance is **not** here.
 * It belongs with the table it writes to and the code that does the granting,
 * which is `ApiService.verifyEmail` in `packages/core`, so the Api stack wires
 * it and this stack only exports the pool. Putting it here would have meant
 * this stack depending on Storage and on the handlers, which is the wrong way
 * round: auth is the thing everything else depends on.
 */

export interface AuthStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

export class AuthStack extends Stack {
  readonly userPool: IUserPool;
  readonly userPoolClient: IUserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { config } = props;

    const pool = new UserPool(this, "Users", {
      userPoolName: `lexicue-${config.name}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: false,
        requireDigits: true,
        requireSymbols: false,
      },
      mfa: Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      userVerification: {
        emailSubject: "Confirm your Lexicue address",
        emailStyle: VerificationEmailStyle.LINK,
        emailBody: "Confirm your address to start translating: {##Confirm##}",
      },
      // Cognito's default sender is capped at 50 emails a day (section 7.2), so
      // production has to send through SES before it has fifty users a day.
      // That needs a region, and section 7.6's region is still an open decision
      // (section 12.1 item 9), so `sesRegion` is configuration rather than a
      // guess: until the founder picks one, every environment uses Cognito's
      // own sender and the cap is a launch blocker written down here.
      email:
        config.sesRegion !== null && config.domainName !== null
          ? UserPoolEmail.withSES({
              sesRegion: config.sesRegion,
              fromEmail: `no-reply@${config.domainName}`,
              fromName: "Lexicue",
              replyTo: `hello@${config.domainName}`,
            })
          : UserPoolEmail.withCognito(),
      removalPolicy: config.removalPolicy,
      deletionProtection: config.stage === "prod",
    });

    this.userPool = pool;
    this.userPoolClient = new UserPoolClient(this, "WebClient", {
      userPool: pool,
      userPoolClientName: `lexicue-web-${config.name}`,
      // A public SPA client: no secret, and tokens the browser keeps in memory
      // and session storage only (section 8, "cookie-free by design").
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.EMAIL, OAuthScope.OPENID, OAuthScope.PROFILE],
        callbackUrls:
          config.domainName === null
            ? ["http://localhost:5173/"]
            : [`https://${config.domainName}/`],
        logoutUrls:
          config.domainName === null
            ? ["http://localhost:5173/"]
            : [`https://${config.domainName}/`],
      },
      // Short-lived, as section 8 requires; the SPA refreshes silently.
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
    });

    if (config.removalPolicy === RemovalPolicy.RETAIN) {
      // A retained pool outlives the stack on purpose: deleting it would delete
      // every customer's sign-in, and the free-balance record keyed on a hashed
      // email (section 6.8) would then mean nothing.
      pool.applyRemovalPolicy(RemovalPolicy.RETAIN);
    }
  }
}
