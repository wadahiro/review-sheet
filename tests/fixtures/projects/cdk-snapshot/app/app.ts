// CDK entry point (illustrative only — see api-stack.ts). One stack per stage,
// which is what makes one synthesized template per stage — the snapshot recipe's
// unit of input.

import { App } from "aws-cdk-lib";
import { ApiStack } from "./api-stack.js";

const app = new App();

new ApiStack(app, "StagingApiStack", { stage: "staging" });
new ApiStack(app, "ProductionApiStack", { stage: "production" });
