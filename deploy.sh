#!/bin/bash
set -e

cd "$(dirname "$0")"
rm -f function.zip
zip -q function.zip index.js

aws lambda update-function-code \
  --function-name sentinelbot-handler \
  --zip-file fileb://function.zip \
  --region us-east-1

echo "Lambda code deployed."
