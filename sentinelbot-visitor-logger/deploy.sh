#!/bin/bash
# =============================================================
# SHIELDBEARER. Visitor logger deploy.
#
# Idempotent. Safe to run more than once. Creates anything that
# is missing, updates the function code every time. Operator runs
# this; nothing here fires automatically. Same account/region as
# SentinelBot and the quiz logger (us-east-1).
#
# Steps: DynamoDB table -> IAM role (or reuse) -> Lambda
#        -> Function URL with CORS. Prints the Invoke URL at the
# end. Paste it into the static site config (js/config.js ->
# visitor.apiUrl) and push.
# =============================================================
set -euo pipefail
cd "$(dirname "$0")"

REGION="us-east-1"
TABLE="shieldbearer_visits"
FN="sentinelbot-visitor-logger"
ROLE="sentinelbot-visitor-logger-role"
ALLOWED_ORIGIN="${VISITOR_ALLOWED_ORIGIN:-https://shieldbearerusa.com}"
ADMIN_KEY="${VISITOR_ADMIN_KEY:-shieldbearer-visits-2026}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

echo "==> Account $ACCOUNT_ID, region $REGION"

# 1. DynamoDB table. On-demand billing so it costs nothing at rest
#    and pennies at pageview volume. PK session_id + SK ts_open so
#    multiple pageviews per session live as separate rows.
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Table $TABLE already exists, leaving it."
else
  echo "==> Creating table $TABLE (PAY_PER_REQUEST)"
  aws dynamodb create-table \
    --table-name "$TABLE" \
    --attribute-definitions AttributeName=session_id,AttributeType=S AttributeName=ts_open,AttributeType=S \
    --key-schema AttributeName=session_id,KeyType=HASH AttributeName=ts_open,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION" >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"
fi

# 2. Execution role. Same pattern as the quiz logger: reuse if
#    VISITOR_ROLE_ARN is set; otherwise create a dedicated
#    least-privilege role from iam-policy.json (needs
#    iam:CreateRole + iam:PutRolePolicy). The shared SentinelBot
#    role works if the deploying user cannot create roles.
if [ -n "${VISITOR_ROLE_ARN:-}" ]; then
  echo "==> Reusing existing role: $VISITOR_ROLE_ARN (no IAM changes)"
  ROLE_ARN="$VISITOR_ROLE_ARN"
else
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
fi

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
    --environment "Variables={VISITOR_TABLE=$TABLE,VISITOR_ALLOWED_ORIGIN=$ALLOWED_ORIGIN,VISITOR_ADMIN_KEY=$ADMIN_KEY}" \
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
    --environment "Variables={VISITOR_TABLE=$TABLE,VISITOR_ALLOWED_ORIGIN=$ALLOWED_ORIGIN,VISITOR_ADMIN_KEY=$ADMIN_KEY}" \
    --zip-file fileb://function.zip \
    --region "$REGION" >/dev/null
  aws lambda wait function-active --function-name "$FN" --region "$REGION"
fi

# 4. Public Function URL with built-in CORS.
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
echo "  1. shieldbearer-website/js/config.js -> visitor.apiUrl = \"$URL\""
echo "  2. shieldbearer-website/admin/visitors.html -> set VISITOR_API to:"
echo "       $URL"
echo "  3. Commit and push the static site."
echo ""
echo " Admin read endpoint: GET $URL"
echo " Admin auth header:   x-admin-key: $ADMIN_KEY"
echo " (override with VISITOR_ADMIN_KEY=... before running this script)"
echo "============================================================="
