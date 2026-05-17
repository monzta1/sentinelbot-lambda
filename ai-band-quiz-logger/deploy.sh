#!/bin/bash
# =============================================================
# ARE YOU AN AI BAND. Quiz logger deploy.
#
# Idempotent. Safe to run more than once. Creates anything that
# is missing, updates the function code every time. Operator runs
# this; nothing here fires automatically. Same account/region as
# SentinelBot (us-east-1).
#
# Steps: DynamoDB table -> IAM role -> Lambda -> Function URL.
# Prints the Invoke URL at the end. Paste it into the static
# site config (js/config.js -> quiz.apiUrl) and push.
# =============================================================
set -euo pipefail
cd "$(dirname "$0")"

REGION="us-east-1"
TABLE="ai_band_quiz_submissions"
FN="ai-band-quiz-logger"
ROLE="ai-band-quiz-logger-role"
ALLOWED_ORIGIN="${QUIZ_ALLOWED_ORIGIN:-https://shieldbearerusa.com}"
ADMIN_KEY="${QUIZ_ADMIN_KEY:-shieldbearer-admin-2026}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

echo "==> Account $ACCOUNT_ID, region $REGION"

# 1. DynamoDB table. On-demand billing so it costs nothing at rest
#    and pennies at quiz volume. Partition key submission_id only.
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Table $TABLE already exists, leaving it."
else
  echo "==> Creating table $TABLE (PAY_PER_REQUEST)"
  aws dynamodb create-table \
    --table-name "$TABLE" \
    --attribute-definitions AttributeName=submission_id,AttributeType=S \
    --key-schema AttributeName=submission_id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION" >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"
fi

# 2. IAM role with least-privilege policy (PutItem/UpdateItem + logs).
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "==> Role $ROLE already exists."
else
  echo "==> Creating role $ROLE"
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]
    }' >/dev/null
  echo "    waiting for role propagation"
  sleep 12
fi
aws iam put-role-policy --role-name "$ROLE" \
  --policy-name "$ROLE-policy" \
  --policy-document file://iam-policy.json
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE}"

# 3. Lambda. Single-file zip, nodejs runtime bundles AWS SDK v3.
rm -f function.zip
zip -q function.zip index.js

if aws lambda get-function --function-name "$FN" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Updating function code for $FN"
  aws lambda update-function-code \
    --function-name "$FN" \
    --zip-file fileb://function.zip \
    --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name "$FN" --region "$REGION"
  aws lambda update-function-configuration \
    --function-name "$FN" \
    --environment "Variables={QUIZ_TABLE=$TABLE,QUIZ_ALLOWED_ORIGIN=$ALLOWED_ORIGIN,QUIZ_ADMIN_KEY=$ADMIN_KEY}" \
    --region "$REGION" >/dev/null
else
  echo "==> Creating function $FN"
  aws lambda create-function \
    --function-name "$FN" \
    --runtime nodejs22.x \
    --role "$ROLE_ARN" \
    --handler index.handler \
    --timeout 10 \
    --memory-size 128 \
    --environment "Variables={QUIZ_TABLE=$TABLE,QUIZ_ALLOWED_ORIGIN=$ALLOWED_ORIGIN,QUIZ_ADMIN_KEY=$ADMIN_KEY}" \
    --zip-file fileb://function.zip \
    --region "$REGION" >/dev/null
  aws lambda wait function-active --function-name "$FN" --region "$REGION"
fi

# 4. Public Function URL with built-in CORS. No API Gateway needed.
#    See DEPLOY.md for the API Gateway alternative if you prefer to
#    keep all endpoints behind the same gateway as SentinelBot.
if aws lambda get-function-url-config --function-name "$FN" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Function URL already configured."
else
  echo "==> Creating Function URL"
  aws lambda create-function-url-config \
    --function-name "$FN" \
    --auth-type NONE \
    --cors "{\"AllowOrigins\":[\"$ALLOWED_ORIGIN\"],\"AllowMethods\":[\"GET\",\"POST\"],\"AllowHeaders\":[\"content-type\",\"x-admin-key\"]}" \
    --region "$REGION" >/dev/null
  aws lambda add-permission \
    --function-name "$FN" \
    --statement-id "public-function-url" \
    --action lambda:InvokeFunctionUrl \
    --principal "*" \
    --function-url-auth-type NONE \
    --region "$REGION" >/dev/null || true
fi

URL="$(aws lambda get-function-url-config --function-name "$FN" --region "$REGION" --query FunctionUrl --output text)"
echo ""
echo "============================================================="
echo " Deployed."
echo " Invoke URL: $URL"
echo ""
echo " Next:"
echo "  1. shieldbearer-website/js/config.js -> quiz.apiUrl = \"$URL\""
echo "  2. shieldbearer-website/admin/quiz.html -> set QUIZ_API to:"
echo "       $URL"
echo "  3. The quiz page and admin page CSP already allow both"
echo "     *.execute-api and *.lambda-url us-east-1 hosts."
echo "  4. Commit and push the static site, then smoke test."
echo ""
echo " Admin read endpoint: GET $URL"
echo " Admin auth header:   x-admin-key: $ADMIN_KEY"
echo " (override with QUIZ_ADMIN_KEY=... before running this script)"
echo "============================================================="
