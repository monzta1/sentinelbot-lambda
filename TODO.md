# SentinelBot Lambda. Future Enhancements.

Honest backlog. Items aren't promises. Pick what's worth doing
when. Marked `[priority]` for the cluster I'd reach for first.

## Pipeline correctness

- **[priority] First real-release verification.** Publisher
  Lambda is intentionally `DRY_RUN=true`. After Let My People Go
  is published on YouTube and the Friday-night detector merges
  the shield-cli draft, flip `DRY_RUN=false` and trigger one
  manual publish to push the first real `site.json`. Then weekly
  autopilot. Verify visible homepage swap and song-meanings
  dossier append.
- **EventStream Query instead of Scan.** Publisher's
  `loadEventStreamPage` uses `Scan` because events are keyed by
  `pk = songId` (no constant pk to query). Fine at current
  scale (tens of items). Past a few thousand events, add a
  GSI on a constant attribute (e.g. `streamPartition: "events"`)
  so `Query` is back on the table.
- **Songs table consolidation.** Two ingestion paths produce
  records with different songId conventions (shield-cli uses
  slug, release-detector uses videoId). Merge step works but
  doubles writes. Long-term: normalize on one identity.

## Cost / observability

- **DynamoDB point-in-time recovery.** Currently disabled.
  Enabling costs ~$0.20/GB/month, basically nothing at this
  scale, and saves you from a fat-finger `delete-item`.
- **CloudWatch alarms on Lambda errors.** Beyond the heartbeat,
  add a metric alarm on `Errors > 0` for each Lambda. Email via
  the existing SNS topic.
- **Per-user (not per-IP) rate limit.** Current rate limit is
  per source IP. Behind a NAT or shared workspace, multiple
  legit users share an IP. Could move to a soft cookie
  identifier or signed JWT for finer-grained limits if abuse
  becomes a real problem.

## SentinelBot capability

- **Latest-release lookup.** Generic "what's new" / "latest
  release" without a song name should auto-pull from songs
  table ordered by `publishedAt DESC`. Today only direct
  title queries work.
- **Streaming responses.** Anthropic SDK supports streaming.
  Current implementation buffers the full response. For long
  answers (lyrics, meaning paragraphs), streaming gives a
  faster perceived response.
- **Conversation memory across pages.** Currently every page
  load resets chat history. Could persist last N turns in
  sessionStorage so a visitor browsing site doesn't repeat
  themselves.
- **Tool use for site search.** When a question matches a page
  (e.g. "tell me about the manifesto"), bot could return both a
  Claude answer AND a clickable link. Today it answers from
  prompt context; doesn't always link.

## Test coverage

- **Main handler integration tests.** `index.js` is excluded
  from the 90% gate because it's a 3000-line handler-heavy
  file. With proper mocking of DynamoDB and Anthropic SDK,
  could pull it into the gate. Worth it only when bugs in
  that file start slipping through.
- **War-game tests automated.** Today's e2e war-game is a
  manual flow (inject record, invoke publisher, verify, roll
  back). Could be a `scripts/wargame.sh` that does it all in
  one command, including rollback on failure.

## Schedule / deploy

- **DST-aware cron.** EventBridge cron is UTC-only. Friday-night
  scan times shift 1 hour when EST/EDT changes. Either accept
  drift, or migrate to EventBridge Scheduler with a timezone.
- **Single deploy script.** `deploy.sh` only handles the chat
  Lambda. Each subdir Lambda has its own zip pattern in our
  heads. Build one `deploy.sh <function-name>` that knows
  how to package each module.
- **GitHub Actions deploy.** Push to `sentinelbot-stable`,
  Actions runs tests + deploys all three Lambdas via OIDC.
  Removes the "did I remember to deploy?" anxiety.
