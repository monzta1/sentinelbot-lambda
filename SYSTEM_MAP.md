# SentinelBot Lambda. System Map.

One-page snapshot of every Lambda in this repo, what it does, what it reads, what it writes. The full cross-repo topology (including the website side) lives in `shieldbearer-website/SYSTEM_MAP.md`.

Last verified: 2026-05-22.

## Lambdas in this repo

Each subdirectory at the repo root is its own Lambda with its own `index.js`, `deploy.sh`, and tests under `tests/`.

| Directory | Lambda name | Trigger | Reads | Writes |
| --------- | ----------- | ------- | ----- | ------ |
| (repo root) | `sentinelbot-handler` | API Gateway `POST /sentinel` | `shieldbearer-sentinel-logs` (cache + logs) + Anthropic API | `shieldbearer-sentinel-logs` |
| `sentinelbot-release-detector-youtube/` | `sentinelbot-release-detector-youtube` | EventBridge cron Sat 13:00 UTC | YouTube Data API v3, `shieldbearer-sentinel-logs` (denylist) | `EventStream`, `shieldbearer-songs`, `shieldbearer-sentinel-logs` |
| `sentinelbot-site-publisher/` | `sentinelbot-site-publisher` | EventBridge cron Sat 13:15 UTC + manual invoke | `EventStream`, `shieldbearer-songs`, `shieldbearer-sentinel-logs` | `shieldbearer-website/site.json` + `shieldbearer-website/index.html` (between marker comments) via GitHub API |
| `sentinelbot-metrics-publisher/` | `sentinelbot-metrics-publisher` | EventBridge cron daily 08:00 UTC | GA4 Data API + Secrets Manager (`shieldbearer/ga4-service-account`) | `shieldbearer-website/admin/metrics.json` via GitHub API |
| `sentinelbot-visitor-logger/` | `sentinelbot-visitor-logger` | API Gateway `POST /visit` + `GET /visit` | `shieldbearer_visits` + ipinfo.io | `shieldbearer_visits` |
| `ai-band-quiz-logger/` | `ai-band-quiz-logger` | API Gateway `POST /quiz` + `GET /quiz` | `ai_band_quiz_submissions` + ipinfo.io | `ai_band_quiz_submissions` |
| `sentinelbot-social-ingest/` | (in-flight, not yet exported) | -- | -- | -- |
| `sentinelbot-scraper-staging/` | (in-flight, not yet exported) | -- | -- | -- |

## CLI tools

| Path | Purpose |
| ---- | ------- |
| `tools/shield-cli/bin/shield.js` | Manual song ingest from `~/Shieldbearer/dropzone`. Writes to `shieldbearer-songs` DynamoDB and updates the Signal Room portion of `site.json`. The featuredRelease block in `site.json` is owned by the publisher Lambda and only refreshes on the next publisher run. |
| `scripts/` | Backfill + verify scripts for songs table and event stream. |

## Shared execution role

`arn:aws:iam::744330047785:role/service-role/sentinelbot-handler-role-5ikqhbaz` is the role behind almost every Lambda here. It has broad DynamoDB access + Lambda basic execution + (now) Secrets Manager read on `shieldbearer/ga4-service-account-*`. When you stand up a new Lambda, reuse this role via the `*_ROLE_ARN` override in the deploy script -- the operator IAM user (`monzta`) cannot create new roles.

## Test entry point

```
npm test
```

Runs every Lambda's `tests/run-tests.js` plus the shield-cli tests. Wrapped by `c8` with a 90% lines/statements gate. Configured in `.c8rc.json`.

Individual Lambda tests run standalone too:

```
node sentinelbot-site-publisher/tests/run-tests.js
node sentinelbot-release-detector-youtube/tests/run-tests.js
node sentinelbot-visitor-logger/tests/run-tests.js  # if present
node sentinelbot-metrics-publisher/tests/run-tests.js
node tools/shield-cli/tests/run-tests.js
```

## Standing rules

- Scoped staging is mandatory. The repo carries in-flight foreign work in many places. **Never `git add -A`.** Add explicit paths only.
- Em dashes are banned. Use `--`, periods, commas, colons, or rewrite.
- Every Lambda change updates `SENTINELBOT_CHANGELOG.md`.
- Lambda Function URLs return 403 anonymously on this AWS account. Route new HTTP endpoints through the shared `sentinelbot-api` (id `g7a5tqlxaj`). See `shieldbearer-website/KNOWN_QUIRKS.md`.

## How a release flows end-to-end

1. YouTube publishes a new Shieldbearer video.
2. `sentinelbot-release-detector-youtube` cron fires Sat 13:00 UTC. Scans the channel, scores candidates, writes a `releaseevent#youtube#<videoId>` record to `shieldbearer-sentinel-logs` and a song record to `shieldbearer-songs`.
3. `sentinelbot-site-publisher` cron fires 15 minutes later. Reads the songs table + event stream, builds `site.json`, commits to `shieldbearer-website`. Also rewrites `index.html` between the `<!-- featured-track:stamp:begin -->` and `<!-- featured-track:stamp:end -->` markers so the static featured-track fallback stays in sync with `site.json`.
4. GitHub Pages rebuilds. New release is live at `shieldbearerusa.com` within a couple of minutes.

If something between artist publish and site live takes longer than ~90 minutes, that's an SLA miss worth investigating.

## Manual operator paths

- **Force publisher**: `aws lambda invoke --function-name sentinelbot-site-publisher --payload '{"approved":true,"source":"youtube"}' --cli-binary-format raw-in-base64-out --region us-east-1 /tmp/out.json`
- **Force metrics**: `aws lambda invoke --function-name sentinelbot-metrics-publisher --payload '{}' --cli-binary-format raw-in-base64-out --region us-east-1 /tmp/out.json`
- **Ingest a song**: drop `.txt` + artwork in `~/Shieldbearer/dropzone`, then `cd ~/Shieldbearer/dropzone && node /Users/moncyabraham/Projects/sentinelbot-lambda/tools/shield-cli/bin/shield.js ingest *.txt`
- **Denylist a misclassified video**: update the `videoIds` list on item `id = config:release-detector-denylist` in `shieldbearer-sentinel-logs`, and delete the `releaseevent#youtube#<videoId>` record so the publisher stops promoting it.

## Where current state lives

- `SENTINELBOT_CHANGELOG.md` (this repo) -- version history.
- `AGENTS.md` (this repo) -- pre-push checklist; binding.
- `README.md` (this repo) -- prerequisites + deploy notes.
- `shieldbearer-website/SYSTEM_MAP.md` -- full cross-repo topology.
- `shieldbearer-website/KNOWN_QUIRKS.md` -- institutional gotchas.
- `shieldbearer-website/AGENT_STATE.md` -- current branch + active task + watch windows.
- `~/.claude/projects/-Users-moncyabraham-Projects/memory/MEMORY.md` -- operator-preference memory across all projects (auto-loaded).
