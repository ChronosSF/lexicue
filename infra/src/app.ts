#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { environmentFor } from "./config.js";
import { buildStacks } from "./stacks.js";

/**
 * The CDK app of specification section 7.2: one app, six stacks, parameterised
 * by environment.
 *
 * `cdk synth -c env=staging`, `cdk deploy -c env=dev-anna`. Nothing has ever
 * been deployed: there is no AWS account, no OIDC role and no bootstrap. What
 * this app is for today is `cdk synth` and the assertion tests, which is
 * enough to keep the infrastructure a reviewed artifact rather than a plan.
 */

const app = new App();
buildStacks(app, environmentFor(app.node.tryGetContext("env") as string | undefined));
