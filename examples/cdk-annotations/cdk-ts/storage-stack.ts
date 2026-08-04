import { Stack, StackProps, Duration, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

/* @rs:config sheet: ストレージ基盤 (TS) */

/* @rs:category ストレージ */
export class StorageStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    /* @rs:category S3 */
    new s3.Bucket(this, "DataBucket", {
      bucketName: "myapp-data-prod", // @rs バケット名 @rs:remarks 命名規則 <app>-data-<env>
      versioned: true, // @rs バージョニング @rs:default false
      removalPolicy: RemovalPolicy.RETAIN, // @rs 削除ポリシー @rs:remarks 本番は RETAIN 必須
      encryption: s3.BucketEncryption.S3_MANAGED, // @rs 暗号化方式
    });

    /* @rs:category DynamoDB */
    new dynamodb.Table(this, "SessionsTable", {
      tableName: "sessions", // @rs テーブル名
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // @rs 課金モード @rs:default PROVISIONED
      timeToLiveAttribute: "expiresAt", // @rs TTL属性 @rs:remarks 期限切れセッションを自動削除
      pointInTimeRecovery: true, // @rs PITR @rs:default false @rs:remarks 本番では有効
    });
  }
}
