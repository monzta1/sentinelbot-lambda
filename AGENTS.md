# SentinelBot Lambda — Contributor Workflow

This file lives in the repo so anyone working on it (human or AI
collaborator) follows the same flow. If you're an AI, treat this as
binding even if you don't have the context that produced it.

## Before every push

Walk these in order. Don't bundle. Each step is a checkpoint, not a
suggestion.

1. **Tests pass.** Run `npm test`. This runs:
   - `tools/shield-cli/tests/run-tests.js`
   - `sentinelbot-site-publisher/tests/run-tests.js`
   - `sentinelbot-release-detector-youtube/tests/run-tests.js`
   - `tests/run-tests.js` (SentinelBot main handler)
   - All wrapped by `c8` with a 90% lines/statements gate, 80%
     functions, 60% branches. Configured in `.c8rc.json`.

2. **Changelog entry.** Add a new version entry at the top of
   `SENTINELBOT_CHANGELOG.md`. Versioning rules:
   - **patch** for prompt tuning, cache additions, small fixes
   - **minor** for visible capability changes or new behavior
   - **major** for architecture or deployment-model changes

3. **No em dashes anywhere.** Hard rule.

4. **Stage scoped, NEVER `git add -A` in this repo.** This repo
   carries in-flight uncommitted work in many directories
   (`SENTINELBOT_CHANGELOG.md`, `api/events.js`,
   `docs/song-index.json`, `scripts/*.js`, `node_modules/`,
   etc.) that does not belong in your commit. Add only the files
   you authored:
   ```bash
   git add path/to/specific/file.js path/to/another.js
   git diff --cached --stat   # confirm scope before commit
   ```

5. **Commit + push.**

6. **If your change affects deployed Lambda code, deploy.** The
   bots are NOT auto-deployed from GitHub. Each Lambda has its
   own zip path:
   - `sentinelbot-handler` (chat) → `./deploy.sh` from repo root
   - `sentinelbot-site-publisher` → zip + `aws lambda
     update-function-code` from inside that subdirectory
   - `sentinelbot-release-detector-youtube` → same pattern

   `deploy.sh` bundles `index.js`, `api/events.js`, and
   `SENTINELBOT_CHANGELOG.md` (the changelog must be in the zip
   so the bot reports the current version at runtime).

7. **Smoke-test after deploy.** Manually invoke the Lambda with a
   minimal payload. Check CloudWatch logs for the success path
   markers (`youtube-release-scan-complete`, `event-count-processed`,
   etc.). For SentinelBot, hit the chat with a known question and
   verify the version string in the answer matches the changelog
   you just shipped.

## Cost rules

- Every change should be evaluated against the user's frugality
  preference. Default to free tier; flag any non-zero monthly cost
  before deploying. AWS billing alarm is set at $5.
- Use `c8 ignore` for external-IO functions (DynamoDB, GitHub,
  YouTube, Anthropic API calls). Pure-function unit tests are the
  way; AWS-mocking integration tests are usually not worth the
  maintenance for this scale.

## Heartbeat and alerting

- Release-detector pings `https://hc-ping.com/...` (Healthchecks.io)
  on every successful run. URL lives in `HEALTHCHECK_URL` env var on
  the Lambda. If a Friday-night run is missed for 7 days + 2 hours,
  Healthchecks emails the listed contact.
- Detector also publishes a scan summary to SNS topic
  `sentinelbot-release-detector-notifications` when a real release
  is detected (not on every run). Subscriber emails are managed in
  the SNS console.

## Source of truth pointers

- Songs table: DynamoDB `shieldbearer-songs`. Shield-cli writes
  `coming_soon` records; release-detector writes `released`
  records (with merge from any matching draft).
- EventStream: DynamoDB `EventStream`. Pk = songId, sk = timestamp.
- Site artifact: built by `sentinelbot-site-publisher` from songs
  table + EventStream, pushed to GitHub Contents API on a weekly
  schedule (Friday 03:15 UTC, after the detector).
