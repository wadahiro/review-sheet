// The stack this example reviews. It is here to show WHY a snapshot review is
// needed — nothing in review-sheet reads or runs this file.
//
// Note where the per-environment divergence lives: in `const prod = ...` and the
// ternaries below. There is no `staging.yml` / `production.yml` to overlay — the
// only place the resolved per-environment values exist is the CloudFormation
// template `cdk synth` renders (see ../snapshots/).

import { Stack, StackProps, Duration, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";

export type Stage = "staging" | "production";

export interface ApiStackProps extends StackProps {
  readonly stage: Stage;
}

export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const prod = props.stage === "production";

    const table = new dynamodb.Table(this, "AppTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: prod ? 50 : 5,
      writeCapacity: prod ? 25 : 5,
      pointInTimeRecovery: prod,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Read autoscaling only in production: the whole ScalableTarget resource is
    // absent from the staging template.
    if (prod) {
      table.autoScaleReadCapacity({ minCapacity: 50, maxCapacity: 200 });
    }

    new logs.LogGroup(this, "ApiLogGroup", {
      logGroupName: `/aws/lambda/${props.stage}-api`,
      retention: prod ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_WEEK,
    });

    const fn = new lambda.Function(this, "ApiFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("dist/api"),
      memorySize: prod ? 1769 : 512,
      timeout: Duration.seconds(prod ? 30 : 10),
      environment: {
        LOG_LEVEL: prod ? "info" : "debug",
        TABLE_NAME: table.tableName,
      },
      // Absent in staging (the property is not rendered at all).
      ...(prod ? { reservedConcurrentExecutions: 100 } : {}),
    });

    table.grantReadWriteData(fn);
  }
}
