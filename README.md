# SentinelBot Lambda

## Overview
This folder contains the AWS Lambda function for SentinelBot.

The Lambda:
- Receives requests from API Gateway
- Uses cache or Anthropic API to generate answers
- Logs all requests to DynamoDB

## Prerequisites
- AWS CLI installed
- AWS CLI configured with access keys
- Correct region set to us-east-1
- IAM user has permission for Lambda (AWSLambda_FullAccess)

## Deploying from VS Code

From this folder, run:

```bash
chmod +x deploy.sh
./deploy.sh
```

What this does:
- Zips `index.js` into `function.zip`
- Uploads the zip to AWS Lambda
- Updates the function code

## Updating Environment Variables

Use AWS CLI:

```bash
aws lambda update-function-configuration \
  --function-name sentinelbot-handler \
  --region us-east-1 \
  --environment "Variables={DYNAMO_TABLE=shieldbearer-sentinel-logs,ANTHROPIC_API_KEY=YOUR_KEY}"
```

Notes:
- Do not include `SENTINEL_SYSTEM_PROMPT` (now embedded in code)
- Keep secrets out of source control

## Verifying Deployment

```bash
aws lambda get-function \
  --function-name sentinelbot-handler \
  --region us-east-1 \
  --query 'Configuration.FunctionName'
```

Expected output:

```text
"sentinelbot-handler"
```

## Testing Flow

1. Update `index.js`
2. Run `./deploy.sh`
3. Open website
4. Ask SentinelBot a question
5. Check DynamoDB logs

## Notes
- Logging is best-effort and should not break the API
- Cached answers return instantly
- Anthropic answers may take 1-2 seconds
- Keep deployment package small for faster updates

## Future Improvements
- Add CI/CD pipeline (GitHub Actions)
- Move secrets to AWS Secrets Manager
- Add environment separation (dev/prod)
- Build admin UI for DynamoDB logs
