from aws_cdk import Stack, Duration, RemovalPolicy
from aws_cdk import aws_s3 as s3
from constructs import Construct

# @rs:config sheet: ストレージ基盤 (Py)

# @rs:category アプリ設定
MAX_CONNECTIONS = 100      # @rs 最大接続数 @rs:default 50
TIMEOUT_SECONDS = 30       # @rs タイムアウト秒 @rs:remarks SLA は 3 秒以内
LOG_LEVEL = "INFO"         # @rs ログレベル @rs:default WARN

# @rs:category S3
BUCKET_NAME = "myapp-data-prod"   # @rs バケット名 @rs:remarks 命名規則 <app>-data-<env>
VERSIONED = True                  # @rs バージョニング @rs:default False

# @rs:category キャパシティ
settings = {
    "read_capacity": 25,          # @rs 読み込みキャパシティ @rs:default 5
    "removal_policy": "RETAIN",   # @rs 削除ポリシー @rs:remarks 本番は RETAIN 必須
}
