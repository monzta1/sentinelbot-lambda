#!/bin/bash
set -e

cd "$(dirname "$0")"
rm -f function.zip
# CHANGELOG must be bundled so loadSentinelbotVersion() reads the
# current version at runtime. Without it, the bot reports a stale
# version forever (the catch path falls through to "1.0").
zip -q function.zip index.js api/events.js SENTINELBOT_CHANGELOG.md

aws lambda update-function-code \
  --function-name sentinelbot-handler \
  --zip-file fileb://function.zip \
  --region us-east-1

echo "Lambda code deployed."
