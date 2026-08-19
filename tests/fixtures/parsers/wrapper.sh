#!/bin/bash
set -euo pipefail

REGION=ap-northeast-1
RETRIES=3

exec /usr/local/bin/agent --region "$REGION" --max-retries 3 --config /etc/agent.toml
