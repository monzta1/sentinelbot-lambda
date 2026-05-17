# SentinelBot Changelog

Versioning note:
- Use semantic versioning in the form `vmajor.minor.patch`
- Patch bumps track prompt tuning, cache additions, and other small bot updates
- Minor bumps track visible capability additions or new behavioral layers
- Major bumps track architecture or deployment model changes
- Always add the newest entry at the top of the file

## v1.12.2 - May 2026
- The deterministic Suno cache route now falls through to the LLM when the question is a quiz-grouping objection (contains quiz, group, lump, or "are you an ai band"), so those reach the v1.12.1 AI BAND QUIZ OBJECTION DEFENSES Suno paragraph. The plain "is Suno used / involved in production" question keeps its deterministic cached answer. Code path change only; prompt unchanged.

## v1.12.1 - May 2026
- Extended the AI BAND QUIZ OBJECTION DEFENSES block with a Suno and generative AI defense, for when someone asks why generative platforms are grouped into the quiz alongside assistive production tools. Prompt context only, no code path change. Pushed into config:system-prompt-expanded (base section only; knowledge sections preserved).

## v1.12.0 - May 2026
- SentinelBot can now field Are You An AI Band quiz objections. Added an AI BAND QUIZ OBJECTION DEFENSES block to SYSTEM_PROMPT with concise, on-voice rebuttals for Trigger, Superior Drummer, Melodyne, Kemper/Quad Cortex/Neural DSP/Tonex, Ozone/Gullfoss, and the recommendation engines, ending on the manifesto and quiz links.
- Aligned the Superior Drummer defense to "programmed model" rather than "statistical model" to match the corrected quiz copy.
- Pushed into the production prompt at config:system-prompt-expanded (base section only; YouTube and Facebook knowledge sections untouched). No code-path change; prompt context only.

## v1.11.0 - May 2026
- YouTube release-detector: added a score-zero guard. A video with none of the release keywords (music, official, single, lyric, live) in its title is no longer auto-published, regardless of duration. This closes the gap that let the 3:06 Short "AI band doing AI things" auto-publish as a full release after YouTube served it as a regular video.
- Added an operator-controlled denylist. The detector loads `config:release-detector-denylist` (DynamoDB, shape `{ id, videoIds: [] }`) and never treats a listed video ID as a release. Fails open so a DynamoDB blip never stalls a scan.
- Score-zero videos that clear the short and denylist filters are collected as needsManualReview and surfaced in the SNS scan summary with instructions, so a real release with an unusual title is flagged for the operator instead of silently dropped.
- Seeded the denylist with cdNeg691X2E (the misclassified Short) and added 13 detector tests covering the guard, the denylist priority, and the manual-review path.

## v1.9.5 - May 2026
- Stopped SentinelBot from inventing exact technical specs for songs. Live test of "what BPM are the drums in Galilean" returned "around 160 BPM"; "what key is Worth It All in" returned "E major"; "what time signature does Quake use" returned "4/4". None of those numbers are in any documented source. The LLM was confabulating plausible-sounding figures.
- Added a system prompt rule (NO INVENTED TECHNICAL SPECS) plus a deterministic cached answer routed on `bpm`, `beats per minute`, `what key`, `time signature`, `tempo`, `track length`, `duration`, `sample rate`. The cached answer says the precise number is not on file and points to Contact. Descriptive questions ("describe the feel", "what is the tempo character") still fall through to the LLM because those are observational, not measurements.
- The prompt rule alone did not hold (the LLM kept generating numbers); the cache short-circuits the LLM entirely for these specific patterns, same approach used for the deflection fix in v1.9.4.

## v1.9.4 - May 2026
- Stopped SentinelBot from opening on-topic music questions with the "That is outside my watch" deflection. Two real-user questions ("who is the drummer", "why is the music so bad") were leading with the deflection prefix before walking it back into a correct answer. Both are clearly on-topic.
- System prompt restructured with explicit ANSWER DIRECTLY and BANNED OPENINGS sections plus a CRITICAL FIRST RULE at the very top of the prompt naming the catalog songs and musical attributes that are always in-scope. Listing on-topic categories explicitly (the previous prompt only listed off-topic ones) gives the model a positive anchor.
- Deterministic cached answers added but kept tightly scoped, per the operator's "no dumb cached answers" rule:
  - Drummer cache fires ONLY on identity questions (regex-matched: "who is the drummer", "who plays drums", "is there a drummer", "are the drums real/fake/human/live/programmed/sampled", "human drummer"). Anything else (technique, BPM, fills, style, mix per song) falls through to the LLM where it can answer in context. An earlier broader rule that matched on `question.includes("drummer")` would have returned a brand-only answer for queries like "what BPM is the drum track in Galilean" or "is the drummer good at polyrhythms" and was rolled back.
  - Music-critique cache fires ONLY on broad attacks ("your music sucks", "the music is terrible", "why is your music so bad"). Song-specific critique ("is Galilean weak", "the drums sound thin in Prison Break") falls through to the LLM which has song context.
- Verified end-to-end:
  - "who is the drummer" -> cached EZdrummer answer.
  - "what BPM are the drums in Galilean" -> LLM responds with 120 BPM and contextual notes.
  - "the drums sound thin in prison break" -> LLM responds with production context for that specific track.
  - "your music sucks" -> cached confident defense.
  - "why is galilean a weak song" -> LLM defends Galilean directly without the deflection prefix.
  - "who won the super bowl" -> correctly deflects with a valid bridge to Sentinels/Quake battle language.
  - Known remaining edge case: questions like "is the drummer skilled at polyrhythms" still get the deflection prefix because the model reads "drummer skilled" as implicit challenge to whether a drummer exists. The substantive answer (citing Big Drummer Man's polyrhythmic structure) follows after the prefix. Acceptable for now; revisit if it becomes a real complaint.

## v1.9.3 - May 2026
- Switched IP geolocation provider from freeipapi.com to ipinfo.io (anonymous tier, no API key, ~1k req/day per source IP, HTTPS, $0/month). Trigger: a real user IP from Chantilly VA resolved to "Washington D.C., DC" on freeipapi.com because that provider keys off the Verizon hostname `pool-108-28-97-217.washdc.fios.verizon.net`. ipinfo.io resolved the same IP to "Arcola, VA" (Arcola is adjacent to Chantilly), which is materially more accurate.
- ipinfo.io returns the full state name ("Virginia") rather than a two-letter code, so `formatLocation` now maps US state names to postal codes via a built-in table. Keeps the displayed format compact: "Arcola, VA" not "Arcola, Virginia". Non-US regions pass through as-is (e.g. "Hamilton, Ontario", "Brisbane, Queensland"). The formatter remains provider-agnostic: it still accepts freeipapi.com (`cityName`/`regionCode`/`countryCode`) and ipwho.is (`city`/`region_code`/`country_code`) payloads as fallbacks, so the provider can be swapped again without rewriting the formatter.
- Bumped the fetch timeout from 1000ms to 2500ms after CloudWatch logs showed ipinfo.io regularly responding to AWS Lambda's source IPs in 1.0-1.5s. The chat path's typical response time is 3-4s end-to-end, so 2500ms still fits comfortably.
- 4 new tests cover ipinfo.io payload mapping ("Arcola"+"Virginia"+"US" -> "Arcola, VA", DC state name -> "DC", non-US passthrough). All 74 tests pass.
- Re-ran `scripts/backfill-ip-locations.js --force` against the historical 333 rows (now 341 with test traffic) to migrate every row off freeipapi.com data. Backfill script switched to the same ipinfo.io endpoint and US state map. Rate limit between API calls dropped from 1500ms to 100ms since ipinfo.io is more generous.

## v1.9.2 - May 2026
- Fixed a poison-cache bug in `resolveIpLocation`. The previous code cached `null` on any failure path (timeout, non-200, fetch error), so a single transient hiccup permanently marked an IP as unresolvable for the rest of the warm Lambda instance's life. Symptom: a real user request from `108.28.97.217` (known-resolvable, "Washington D.C., DC") logged with `location: null`. Now only the formatter's verdict (the API responded and we parsed it) is cached. Transient failures fall through without poisoning.
- Bumped the lookup timeout from 250ms to 1000ms. 250ms was tight for freeipapi.com's free tier and was likely the trigger for the cache poisoning. 1000ms is still well below the chat path's typical 1-2s response time.

## v1.9.1 - May 2026
- Tightened the location string to `"City, RegionCode"` (e.g. `"Dallas, TX"`, `"Ancaster, ON"`) instead of `"City, Country"`. Reason: the admin logs page renders one cell per row at narrow widths, and "United States" was wide enough to force per-character word-break wrapping in the cache and insight tables. Short region codes keep the cell on one line, and US/CA/AU consumers see a more useful identifier than "United States".
- Fallback when `regionCode` is empty drops to `countryCode` so country-only resolutions still produce a usable label.
- `formatLocation` tests updated to assert the new compact format across freeipapi.com (cityName/regionCode/countryCode) and ipwho.is (city/region_code/country_code) shapes, plus the missing-region fallback.
- Re-ran `scripts/backfill-ip-locations.js --force` against all 333 historical sentinelbot rows to rewrite the existing "City, Country" entries into the new compact form. Added a `--force` flag for exactly this case (full re-resolve when the format itself changes). Fixed an associated DynamoDB ValidationException where the scan request declared the `#loc` attribute alias even when the filter did not reference it.

## v1.9.0 - May 2026
- Chat Lambda now annotates every log row with an approximate `location` resolved at write time from `sourceIp`. Uses freeipapi.com's free tier (no API key, HTTPS, 60 req/min cap). Inline await with a 250ms timeout, in-memory cache per warm Lambda instance so repeat traffic from the same IP does not re-resolve.
- `formatLocation` is intentionally provider-agnostic. It accepts the response shapes of freeipapi.com (cityName + regionCode + countryCode), ipwho.is (city + region_code + country_code + success), and ipapi.co (city + region_code + country_code + error), so the provider can be swapped later without touching the formatter.
- Private, loopback, link-local, and documentation-range IPs are rejected up front (`isResolvableIp`) so no API call is made for traffic that has no public location. The `"unknown"` sentinel sourceIp value is treated the same way.
- Failure path is silent and quick: any non-200 response, an `error: true` payload, a `success: false` payload, or a fetch timeout sets `location: null` and the chat continues. The chat path never blocks waiting on the lookup beyond the 250ms timeout.
- 30 new pure-function tests cover `isResolvableIp` (public IPv4, all private and reserved ranges, the `"unknown"` sentinel, null, empty), `formatLocation` (city + country across all three provider shapes including failure payloads), `resolveIpLocation` (no network calls for unresolvable inputs), and `buildLogItem` (location flows through, defaults to null).
- Added `scripts/backfill-ip-locations.js` for the one-off historical backfill. Scans `shieldbearer-sentinel-logs` for sentinelbot rows missing `location`, dedupes unique sourceIp values, resolves each via freeipapi.com (with a 1.5s polite delay between API calls), then fans out the result to every row sharing that IP. Idempotent: re-running skips rows that already have `location`. Supports `--dry-run`.
- Provider iteration history: ipapi.co 429'd from a single backfill burst on its anonymous free tier. ipwho.is returned `success: false: CORS is not supported on the Free plan` for every Node fetch call. freeipapi.com handled the same burst cleanly with no headers tuning and is the picked provider.

## v1.8.3 - May 2026
- shield-cli now ingests `#Reference`, `#ScriptureRef`, `#ScriptureQuote` template sections. Reference is a free-form pipe-separated string ("Exodus 5:1 | Exodus 7:16"); the two scripture sections combine into a `scripture: { ref, quote }` object on the song record. Both paths (the in-memory test state file and the production DynamoDB UpdateCommand) write the new fields, and both tear them down when the template omits them. `buildContentHash` now includes the new fields so an edit to scripture re-emits a SONG_UPDATED event.
- Added a fresh template at `~/Documents/song-template.txt` for cloning per release. Includes Title, Genre, Tags, Reference, ScriptureRef, ScriptureQuote, SongMeaning, Lyrics sections.
- Two new tests: `scripture-ingest` confirms the round-trip from template to song record, `scripture-missing` confirms a template without scripture sections still ingests cleanly with no scripture field.

## v1.8.2 - May 2026
- Site publisher now reads `reference` and `scripture` fields off the song record and emits them on `released[]` entries plus `homepage.featuredRelease`. shield-cli does not yet write these (a follow-up), so for now they are populated directly via DynamoDB and the publisher passes them through verbatim. The merge helper preserves the curated record's scripture when promoting a coming-soon song to released.
- Added 8 tests for scripture passthrough on `normalizeSongTableItem` and the merge path; default-empties when absent.

## v1.8.1 - May 2026
- Site publisher now loads release events from `shieldbearer-sentinel-logs` (pk pattern `releaseevent#youtube#<videoId>`) in addition to `EventStream`. The legacy table holds the long history of detected releases (~547 records); without this loader the timeline showed only the 26 EventStream entries (mostly shield-cli SONG_UPDATED ticks) and lost a year of release context.
- Added `mergeReleasedWithComingSoon` to dedupe songs across states by normalized title. shield-cli ingests songs as `coming_soon` with curated lyrics and artwork; the release-detector creates a separate `released` record keyed by YouTube videoId. Without merge the same song appeared twice with different metadata. Merge promotes the curated record to released, attaches the YouTube videoId/sourceUrl/publishedAt, and drops the YouTube-only twin from comingSoon.
- `cleanReleaseTitle` now strips bracketed tags (e.g. "[Christian Metal | Official Lyric Video]") before splitting on " | ", so titles with a pipe inside the brackets are no longer chopped at the wrong place.
- Tightened release-event dedupe key to `songId#publishedAt` so the same release recorded in both source tables collapses to a single timeline entry.

## v1.8.0 - May 2026
- Site publisher hardened against release-detector data quality bugs that produced a broken homepage / lyrics page / timeline on the first Saturday-morning auto-publish
  - `cleanReleaseTitle` strips "Shieldbearer - " prefix and " | <marketing>" suffix from titles so the homepage shows just the song name
  - `isValidArtworkUrl` rejects YouTube watch URLs from the artwork field; the website renderer falls back to the img.youtube.com thumbnail
  - `cleanLyrics` drops description-shaped text written into the lyrics field by the release detector (equality with description, YouTube URLs, "Shieldbearer" prefix, "New Single YYYY" marketing copy, #Shieldbearer hashtags, length cap)
  - `eventsForArtifact` now emits the fields the timeline page reads (id, title, publishedAt, sourceUrl, plus album/short metadata) instead of a 4-field stub; filtered to events with sourceUrl so SONG_UPDATED ticks from shield-cli stop crowding actual releases
  - `normalizeReleaseEventItem` distinguishes event timestamp from release publishedAt so the timeline shows when YouTube went live, not when the detector ran
- Auto-approve path added for trusted sources so the EventBridge cron-driven publisher run can push without manual approval. Off by default: empty `AUTO_APPROVE_SOURCES` env var is the same as today's manual-approval-only behavior. Set `AUTO_APPROVE_SOURCES=youtube` to opt in once the data quality issues are resolved at the detector layer.
- Added Saturday 9am EDT EventBridge schedule (detector + publisher with the standard 15-minute gap) to fill the gap between the Friday evening cycle and the next Friday cycle. Pre-existing Friday and late-Saturday rules remain in place. Schedule lives in the AWS console for now; persisting in IaC is a follow-up.
- 23 new pure-function tests covering each of the helpers above

## v1.7.4 - April 2026
- Tightened the system prompt with three accuracy fixes after a fan exchange caught the bot guessing
- GUITARS section now states tuning explicitly: Drop C or Drop D for heavy material, standard for ballads and worship; deep gear specs deferred to a future Mark II memory pack
- Added a PRODUCTION PROCESS block clarifying that Suno is used in ideation only and never ships as is
- Added a VOCALS block stating lead vocals are AI generated unless specified, with Moncy on backing vocals for Quake and Celestial Shield
- Equipment block in the character profile now references the planned Mark II per-guitar gear pack
- Added dedicated cached answers for tuning, AI vocals, and Suno usage so these questions short-circuit the LLM and stay deterministic
- Fixed cache matcher bug where "what tuning do they use for their guitars" was folding into the "what guitar does he play" cache and answering with the brand

## v1.7.3 - April 2026
- Added `TODO.md` at the repo root with an honest backlog of future enhancements grouped by pipeline correctness, cost/observability, capability, test coverage, schedule/deploy

## v1.7.2 - April 2026
- Added `AGENTS.md` at the repo root with the contributor workflow checklist (test gate, scoped staging, deploy zip rules, smoke-test steps, heartbeat and alerting pointers) so the same rules are visible to future contributors

## v1.7.1 - April 2026
- Bundled `SENTINELBOT_CHANGELOG.md` into the Lambda zip so `loadSentinelbotVersion()` reads the current version at runtime instead of falling through to the legacy default
- Removed the stale `SENTINELBOT_VERSION` env var that was pinning the bot to v1.4.0; the changelog file is now the single source of truth for the reported version

## v1.7.0 - April 2026
- Added Lambda regression tests across publisher, release-detector, SentinelBot main handler, plus c8 coverage gate at 90% lines and statements
- Marked external-IO functions and handler entry points with c8 ignore so the gate measures pure-function correctness
- Current coverage: publisher 92.48%, release-detector 91.98%, shield-cli 92%, event-stream 93.22%; overall 91.63% lines

## v1.6.2 - April 2026
- Added an optional Healthchecks.io heartbeat ping to the release-detector so a missed scheduled run triggers an alert email after the grace period
- Best-effort: a network failure on the heartbeat endpoint does not break the scan flow

## v1.6.1 - April 2026
- Added per-IP rate limit on SentinelBot at 15 questions per minute, returning HTTP 429 with a friendly in-voice message
- Atomic counter on the existing logs table; fail-open so a DynamoDB blip never blocks legit users
- Disable via `SENTINEL_RATE_LIMIT_DISABLED=true` env var if needed

## v1.6.0 - April 2026
- Taught SentinelBot to read the Signal Room: questions about upcoming or in-progress songs now answer with live `coming_soon` data from the songs table instead of deflecting
- Injected the Signal Room data into every Claude system prompt so colloquial phrasings ("anything in the oven", "what's brewing") get recognized without phrase-matching
- Pure-function deterministic answer for the common phrasings; cached DynamoDB scan to keep cost negligible

## v1.5.4 - April 2026
- Updated `buildSongView` so the songs-table state wins over synthesized event states; SONG_UPDATED events from shield-cli no longer demote a released record
- Updated `normalizeSongTableItem` to read shield-cli's lowercase `songmeaning` and to prefer `artworkUrl` over the source filename in `artwork`

## v1.5.3 - April 2026
- Fixed five publisher bugs surfaced by the e2e war-game: handler now loads songs alongside events, EventStream uses Scan instead of an unmatched constant pk, source detection prefers `event.source` over the freshest event's source, and the canonical artifact ends with a trailing newline
- Verified end-to-end via a live publish into shieldbearer-website and a clean rollback

## v1.5.2 - April 2026
- Aliased every DynamoDB attribute name in `updateWatcherState` so reserved words like `source` and `processed` no longer break the UpdateExpression
- Added `status: "released"` and `releaseDetected: true` stamps in the release-detector's `buildSongItem` and merge logic so the publisher routes new releases to `released[]`

## v1.5.1 - April 2026
- Release-detector now scans for a `coming_soon` draft matching the new release by normalized title and merges its lyrics, songMeaning, and artwork onto the released record before write
- Deletes the stale draft after merge so the publisher does not double-list the song
- Bridges the songId mismatch between shield-cli (slug) and release-detector (videoId)

## v1.5.0 - April 2026
- Publisher now emits a website-compatible `site.json` schema: `comingSoon` instead of `incoming`, `events` instead of `eventsStream`, with `homepage.featuredRelease` populated from the latest released song
- Enriched `released[]` entries with lyrics, songMeaning, and artwork so the homepage and song-meanings page render full content without a separate fetch

## v1.4.46 - April 2026
- Added a `RESERVED_ARTWORK_FILES` guard in `cleanupPublishedArtwork` so dropzone clears no longer wipe `desk.jpg` (the permanent Signal Room backdrop)
- Wrote a `scripts/fetch-merch.sh` baker that pulls from the Shopify public sitemap and produces `data/merch.json` for the website rotator

## v1.4.45 - April 2026
- Reset Shield CLI to a parsing-only contract with deterministic slug and local artwork detection
- Removed write-side behavior from the CLI path so it returns a single parsing JSON object only

## v1.4.44 - April 2026
- Added replay controls to the Signal Room frontend for event-stream playback and pause/reset behavior
- Kept replay mode fully client-side and driven only by the current `site.json` snapshot

## v1.4.43 - April 2026
- Added transition animations to the Signal Room frontend for state changes between draft, incoming, and released columns
- Kept the 60-second refresh loop stable while limiting animation spam to actual state changes

## v1.4.42 - April 2026
- Updated the Signal Room frontend to derive song columns from `eventsStream` with SongsTable fallback
- Kept the live event feed available for UI transition highlighting

## v1.4.41 - April 2026
- Added EventStream-derived song state resolution and lightweight state buckets to the site artifact builder
- Included a last-50 event feed for UI animations while keeping SongsTable as the fallback source of truth

## v1.4.40 - April 2026
- Added deterministic content hashing and read-before-write idempotency to Shield Ingest CLI
- Made EventStream emission conditional on new or meaningfully changed content

## v1.4.39 - April 2026
- Added an end-to-end Shield Ingest CLI test suite with real sample files and artwork coverage
- Added a package test script so `npm run test` runs the Shield Ingest CLI harness

## v1.4.38 - April 2026
- Standardized Shield Ingest CLI output into one consistent JSON contract for processed, skipped, rejected, and error results
- Kept internal validation, artwork lookup, DynamoDB writes, and event logging silent except for the final JSON response

## v1.4.37 - April 2026
- Added fire-and-forget EventStream logging after Shield Ingest CLI upserts a processed song
- Kept EventStream failures non-blocking so CLI ingestion still returns success JSON

## v1.4.36 - April 2026
- Added Shield Ingest CLI DynamoDB upsert support for processed songs
- Kept skipped and rejected inputs read-only while preserving JSON-only CLI output

## v1.4.35 - April 2026
- Made the runtime version answer derive from the changelog top entry when `SENTINELBOT_VERSION` is not set
- Kept environment overrides available for staged or pinned deployments

## v1.4.34 - April 2026
- Added trace IDs to the generated `site.json` artifact for GitHub Pages
- Carried release trace metadata into the archive payload and release index

## v1.4.33 - April 2026
- Added trace IDs across the release detector, event consumer, and SentinelBot logs
- Linked song answers back to the underlying song or release ID for easier debugging

## v1.4.32 - April 2026
- Added a hard normalized cache for common identity, song, and FAQ questions
- Shortened song-context prompts and lowered Anthropic token caps for fallback answers
- Added structured Anthropic call logging with intent and size metrics

## v1.4.31 - April 2026
- Corrected the canonical Shieldbearer founding answer to April 20, 2025
- Added nearby founding and launch phrasings so the same date stays consistent across Q&A variants
- Added a direct "solo project, not a band" answer for founding-style questions
- Added FAQ routing for band/solo-project phrasing so the founding answer stays consistent

## v1.4.30 - April 2026
- Changed the site publisher target path to the website root `site.json`
- Kept `SITE_JSON_PATH` configurable for non-production overrides
- Aligned the publisher output location with the GitHub Pages fetch path used by `timeline.html`

## v1.4.29 - April 2026
- Fixed the lyrics cache-write path so generated lyrics can be stored back into SongsTable
- Kept the stored-lyrics-first resolver order intact

## v1.4.28 - April 2026
- Cached Anthropic-generated lyrics back into the Songs table as `generated`
- Preserved manual and YouTube-derived lyrics as higher-priority sources
- Kept future lyrics lookups deterministic once a source has been stored

## v1.4.27 - April 2026
- Added deterministic lyrics storage fields for manual, YouTube, and generated sources
- Extracted lyric-shaped blocks from YouTube descriptions during ingestion and backfill
- Switched lyrics retrieval to use stored lyrics before any Anthropic fallback

## v1.4.26 - April 2026
- Raised the lyrics generation token budget to prevent clipped verses
- Added a larger retry ceiling for incomplete lyric outputs
- Left meaning and fact response modes unchanged

## v1.4.25 - April 2026
- Hardened meaning response sanitization to remove promotional tail text
- Rebuilt meaning responses from clean sentences to preserve the short-form contract
- Kept the fact and lyrics response modes unchanged

## v1.4.24 - April 2026
- Stripped links and metadata from meaning responses before returning them
- Added a meaning-only Anthropic context so explanation answers stay short and thematic
- Kept lyrics and fact outputs on separate formatting contracts

## v1.4.23 - April 2026
- Introduced intent-specific response modes for fact, meaning, and lyrics outputs
- Enforced strict single-line fact formatting and bounded lyrics retry handling
- Standardized meaning responses to a consistent short-form contract

## v1.4.22 - April 2026
- Split song intent routing into release, meaning, and hybrid paths
- Ensured meaning/explanation queries bypass cached release answers
- Removed duplicate song-intent helpers so the handler has one canonical classifier

## v1.4.21 - April 2026
- Tightened song-intent routing so only real song queries enter the song path
- Added Anthropic song-context prompts for catalog misses using stored song metadata
- Preserved the deterministic lookup layers before any narrative fallback

## v1.4.20 - April 2026
- Added human-readable song display titles to meaning responses
- Kept the Song Context layer deterministic while making answers read like proper sentences

## v1.4.19 - April 2026
- Added a deterministic legacy context override for `Prison Break`
- Kept meaning queries from falling through to release-date answers when the stored song row is sparse

## v1.4.18 - April 2026
- Fixed song-context routing to use best-candidate title matching for meaning questions
- Prevented long YouTube titles from blocking `what is [song] about` lookups
- Kept strict release lookup separate from meaning-layer answers

## v1.4.17 - April 2026
- Captured YouTube descriptions in the release ingestion pipeline
- Stored description-backed song context in the SongsTable schema
- Made meaning responses derive from stored YouTube description data first, with catalog fallback only when needed

## v1.4.16 - April 2026
- Added a dedicated Song Context layer for meaning-based song questions
- Built song-context fields at index generation time from the canonical song catalog
- Routed “about this song” and “meaning of” queries away from release facts and into thematic responses

## v1.4.15 - April 2026
- Added a high-priority site-intent routing layer ahead of FAQ and fallback handling
- Restored the structured Shieldbearer identity response for site-level questions
- Kept SongsTable strict lookup as the first routing stage

## v1.4.14 - April 2026
- Added a dedicated `shieldbearer-songs` lookup table path for fast song metadata retrieval
- Wrote valid release detections into the songs table without changing the EventStream audit path
- Added a catalog backfill script so the song table can be populated from the existing song index

## v1.4.13 - April 2026
- Added a dedicated song index snapshot for fast title-based lookup
- Merged song metadata from the Shieldbearer catalog into a normalized local index
- Wired SentinelBot to answer song meaning and release queries from the indexed catalog before falling back

## v1.4.12 - April 2026
- Pinned the Pages workflow checkout to `GITHUB_SHA` with full fetch depth
- Replaced git-metadata validation with filesystem-only checks for `docs/site.json`
- Added a checksum gate and explicit artifact logging before the Pages build

## v1.4.11 - April 2026
- Changed the Pages workflow trigger to `push` only on `docs/site.json`
- Removed manual workflow dispatch from the Pages deploy path
- Made the Lambda commit to `docs/site.json` the single source of truth for Pages builds

## v1.4.10 - April 2026
- Added a retry-wait gate so Pages builds only proceed after `docs/site.json` is present in the synced checkout
- Logged the `docs/site.json` hash, file size, and event count before building
- Kept Pages deploys blocked until the Lambda commit is visible in the workflow workspace

## v1.4.9 - April 2026
- Forced the Pages workflow to reset to the latest `origin/main` before building
- Added a hard non-empty guard for `docs/site.json`
- Logged the deployed commit SHA and site artifact size before Pages deploy

## v1.4.8 - April 2026
- Required `docs/site.json` as the sole production Pages input
- Added an explicit build failure when `docs/site.json` is missing
- Added workflow retries to wait for the committed site artifact before deployment
- Logged the copied site artifact path and event count during page builds

## v1.4.7 - April 2026
- Removed the dead nested `/tmp` site publisher stub from the release detector tree
- Trimmed publisher logging down to production decision and retry signals
- Kept the final pipeline clean of simulation, test, and local-output dependencies

## v1.4.6 - April 2026
- Hardened the site publisher with deterministic EventStream ordering and empty-stream fallback
- Added GitHub retry handling for rate limiting and transient failures
- Tightened the Pages build path to repo-state inputs only

## v1.4.5 - April 2026
- Made the SentinelBot site publisher write directly to GitHub Contents API at `docs/site.json`
- Removed local filesystem and git CLI as the production publication path
- Kept dry-run and source gating behavior while making GitHub the only production writer

## v1.4.4 - April 2026
- Moved the Pages source of truth into repository state via `docs/site.json`
- Removed the local `site-output/site.json` production dependency
- Kept GitHub Actions repo-only while Lambda continues to publish the repo artifact upstream

## v1.4.3 - April 2026
- Added the GitHub Pages build artifact pipeline for SentinelBot site output
- Added a static Pages renderer that fetches and displays `site.json`
- Added a build script that copies the latest local `site-output/site.json` into the deploy artifact

## v1.4.2 - April 2026
- Added safe live-mode gates for approval and source allowlisting
- Added immutable site snapshot generation before site.json writes
- Added duplicate-commit protection based on the latest git commit message

## v1.4.1 - April 2026
- Added the SentinelBot site publisher layer for artifact output
- Added git-backed site publication with dry-run-safe logging
- Prepared the GitHub Pages path for release sync commits without touching the event system

## v1.4.0 - April 2026
- Promoted the expanded knowledge base to the production prompt path
- Added production prompt caching with the expanded system prompt as the cached prefix
- Loaded the live handler from `config:system-prompt-expanded`
- Launched the 96-video knowledge base with 40,721 token coverage

## v1.3.6 - April 2026
- Added elimination-trap handling so questions that try to force identity by negation get interrupted
- Kept the response in designation-only language and redirected back to Shieldbearer immediately

## v1.3.5 - April 2026
- Closed the identity loophole so the bot never names the underlying model, company, or stack
- Added hard cache replies for Claude, Anthropic, ChatGPT, Gemini, Kimi, and model-identity traps
- Added a backend-name leak guard so leaked infrastructure names get replaced with SentinelBot-only answers

## v1.3.4 - April 2026
- Updated the direct version reply to a more ceremonial Mark I watchman line
- Kept the full patch version visible in the version response

## v1.3.3 - April 2026
- Expanded indirect self-reference replies so learning, improvement, memory, and upgrade questions also speak the full semantic version
- Kept identity responses and version reporting tied to the shared runtime version variable

## v1.3.2 - April 2026
- Updated the identity replies so who-are-you questions speak the full semantic version
- Advanced the runtime version label to the next patch release
- Kept the Mark I watchman voice intact while making version reporting more precise

## v1.3.1 - April 2026
- Documented semantic versioning for SentinelBot releases
- Aligned the bot changelog with patch-level release tracking
- Kept runtime behavior on v1.3 while the changelog records incremental updates

## v1.3 - April 2026
- Added the full SentinelBot character profile
- Added the watchman-class designation and origin story
- Added the learning and memory framing in-universe
- Added version-aware runtime responses
- Introduced `SENTINELBOT_VERSION` for minor release tracking

## v1.2 - April 2026
- Added UNKNOWN TRACKS RULE and TRACK FOCUS RULE
- Added merch store routing
- Improved markdown stripping in the frontend
- Added em dash stripping for safer display

## v1.1 - April 2026
- Expanded track coverage from Shieldbearer catalog content
- Added deeper song context and scripture-backed responses
- Separated guitar brand details from amp details
- Added more direct music, merch, and mission answers

## v1.0 - April 2026
- Initial deployment of SentinelBot Mark I
- Watchman-class Guardian Intelligence online
- Signal-class retrieval and inference fallback established
- Core knowledge base added for music, theology, band history, gear, and site navigation
- App-side caching started for common questions
- DynamoDB logging enabled
