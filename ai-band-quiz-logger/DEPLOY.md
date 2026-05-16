# Are You An AI Band. Quiz logger deploy

Backend for the quiz at `shieldbearerusa.com/are-you-an-ai-band`.
Nothing here runs automatically. The operator runs `deploy.sh`.
Same AWS account and region as SentinelBot (`us-east-1`).

The static site works fully before this is deployed. The quiz
runs, scores, and draws the share card client side with no
backend. Only the anonymous submission log is skipped until
`js/config.js` `quiz.apiUrl` is set. So this can be deployed
whenever, with no rush and no site downtime.

## DynamoDB table: `ai_band_quiz_submissions`

| Attribute       | Type    | Notes                                      |
|-----------------|---------|--------------------------------------------|
| `submission_id` | S       | Partition key. UUID v4 from the Lambda.    |
| `timestamp`     | S       | ISO 8601, set server side.                 |
| `path`          | S       | `musician` or `listener`.                  |
| `answers`       | L       | List of `{ question_id, answer }` maps.    |
| `score`         | N       | Integer 0 to 10.                           |
| `category`      | S       | Result category name.                      |
| `shared`        | BOOL    | Defaults false. Flipped true on share.     |
| `user_agent`    | S       | Spam triage only.                          |
| `email`         | S       | Present only if the visitor typed one.     |

Partition key only, no sort key, no indexes. Billing is
`PAY_PER_REQUEST` so it costs nothing at rest and pennies at
quiz volume. `deploy.sh` creates it if missing.

## One command

```bash
cd ai-band-quiz-logger
./deploy.sh
```

It is idempotent. It creates the table, an IAM role scoped to
`PutItem` and `UpdateItem` on this one table plus CloudWatch
Logs (`iam-policy.json`), the Lambda (`nodejs22.x`, 128 MB, 10s),
and a Lambda Function URL with CORS locked to
`https://shieldbearerusa.com`. It prints the Invoke URL.

Override the allowed origin if testing from elsewhere:

```bash
QUIZ_ALLOWED_ORIGIN="https://staging.example.com" ./deploy.sh
```

## Wire the front end

1. `shieldbearer-website/js/config.js` -> set `quiz.apiUrl` to the
   printed Invoke URL.
2. The quiz page CSP `connect-src` already allows both
   `https://*.execute-api.us-east-1.amazonaws.com` and
   `https://*.lambda-url.us-east-1.on.aws`, so either endpoint
   style works with no CSP edit.
3. `cp are-you-an-ai-band.html are-you-an-ai-band/index.html` to
   keep the clean-URL mirror byte-identical, run `npm test`,
   commit, push.

## Request shapes

New submission (POST JSON):

```json
{ "path": "musician", "answers": [{ "question_id": "m1", "answer": "Yes" }],
  "score": 7, "category": "The Suspect ...", "shared": false,
  "user_agent": "...", "email": "optional@example.com" }
```

Returns `{ "submission_id": "<uuid>" }`.

Mark shared (POST JSON), sent when the visitor shares or
downloads the card:

```json
{ "submission_id": "<uuid>", "shared": true }
```

Returns `{ "ok": true }`. Validation rejects bad paths, out of
range scores, empty or oversized answer arrays, and truncates
every string field.

## API Gateway alternative

If you would rather keep every endpoint behind the same HTTP API
as SentinelBot instead of a Function URL:

1. Skip the Function URL block (comment out step 4 in
   `deploy.sh`).
2. In the existing HTTP API, add a route `POST /quiz` with a
   Lambda proxy integration to `ai-band-quiz-logger`, plus an
   `OPTIONS /quiz` route for preflight.
3. Enable CORS on the API for origin `https://shieldbearerusa.com`,
   methods `POST,OPTIONS`, headers `content-type`.
4. Grant API Gateway permission to invoke the function:

   ```bash
   aws lambda add-permission --function-name ai-band-quiz-logger \
     --statement-id apigw-quiz --action lambda:InvokeFunction \
     --principal apigateway.amazonaws.com --region us-east-1 \
     --source-arn "arn:aws:execute-api:us-east-1:<acct>:<apiId>/*/*/quiz"
   ```

5. Use `https://<apiId>.execute-api.us-east-1.amazonaws.com/quiz`
   as `quiz.apiUrl`. The page CSP already allows that host.

## Teardown

```bash
aws lambda delete-function --function-name ai-band-quiz-logger --region us-east-1
aws dynamodb delete-table --table-name ai_band_quiz_submissions --region us-east-1
aws iam delete-role-policy --role-name ai-band-quiz-logger-role --policy-name ai-band-quiz-logger-role-policy
aws iam delete-role --role-name ai-band-quiz-logger-role
```
