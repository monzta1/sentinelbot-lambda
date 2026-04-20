# SentinelBot Changelog

Versioning note:
- Use semantic versioning in the form `vmajor.minor.patch`
- Patch bumps track prompt tuning, cache additions, and other small bot updates
- Minor bumps track visible capability additions or new behavioral layers
- Major bumps track architecture or deployment model changes

## v1.4.31 - April 2026
- Corrected the canonical Shieldbearer founding answer to April 20, 2025
- Added nearby founding and launch phrasings so the same date stays consistent across Q&A variants
- Added a direct "solo project, not a band" answer for founding-style questions

## v1.0 - April 2026
- Initial deployment of SentinelBot Mark I
- Watchman-class Guardian Intelligence online
- Signal-class retrieval and inference fallback established
- Core knowledge base added for music, theology, band history, gear, and site navigation
- App-side caching started for common questions
- DynamoDB logging enabled

## v1.1 - April 2026
- Expanded track coverage from Shieldbearer catalog content
- Added deeper song context and scripture-backed responses
- Separated guitar brand details from amp details
- Added more direct music, merch, and mission answers

## v1.2 - April 2026
- Added UNKNOWN TRACKS RULE and TRACK FOCUS RULE
- Added merch store routing
- Improved markdown stripping in the frontend
- Added em dash stripping for safer display

## v1.3 - April 2026
- Added the full SentinelBot character profile
- Added the watchman-class designation and origin story
- Added the learning and memory framing in-universe
- Added version-aware runtime responses
- Introduced `SENTINELBOT_VERSION` for minor release tracking

## v1.3.1 - April 2026
- Documented semantic versioning for SentinelBot releases
- Aligned the bot changelog with patch-level release tracking
- Kept runtime behavior on v1.3 while the changelog records incremental updates

## v1.3.2 - April 2026
- Updated the identity replies so who-are-you questions speak the full semantic version
- Advanced the runtime version label to the next patch release
- Kept the Mark I watchman voice intact while making version reporting more precise

## v1.3.3 - April 2026
- Expanded indirect self-reference replies so learning, improvement, memory, and upgrade questions also speak the full semantic version
- Kept identity responses and version reporting tied to the shared runtime version variable

## v1.3.4 - April 2026
- Updated the direct version reply to a more ceremonial Mark I watchman line
- Kept the full patch version visible in the version response

## v1.3.5 - April 2026
- Closed the identity loophole so the bot never names the underlying model, company, or stack
- Added hard cache replies for Claude, Anthropic, ChatGPT, Gemini, Kimi, and model-identity traps
- Added a backend-name leak guard so leaked infrastructure names get replaced with SentinelBot-only answers

## v1.3.6 - April 2026
- Added elimination-trap handling so questions that try to force identity by negation get interrupted
- Kept the response in designation-only language and redirected back to Shieldbearer immediately

## v1.4.0 - April 2026
- Promoted the expanded knowledge base to the production prompt path
- Added production prompt caching with the expanded system prompt as the cached prefix
- Loaded the live handler from `config:system-prompt-expanded`
- Launched the 96-video knowledge base with 40,721 token coverage

## v1.4.1 - April 2026
- Added the SentinelBot site publisher layer for artifact output
- Added git-backed site publication with dry-run-safe logging
- Prepared the GitHub Pages path for release sync commits without touching the event system

## v1.4.2 - April 2026
- Added safe live-mode gates for approval and source allowlisting
- Added immutable site snapshot generation before site.json writes
- Added duplicate-commit protection based on the latest git commit message

## v1.4.3 - April 2026
- Added the GitHub Pages build artifact pipeline for SentinelBot site output
- Added a static Pages renderer that fetches and displays `site.json`
- Added a build script that copies the latest local `site-output/site.json` into the deploy artifact

## v1.4.4 - April 2026
- Moved the Pages source of truth into repository state via `docs/site.json`
- Removed the local `site-output/site.json` production dependency
- Kept GitHub Actions repo-only while Lambda continues to publish the repo artifact upstream

## v1.4.5 - April 2026
- Made the SentinelBot site publisher write directly to GitHub Contents API at `docs/site.json`
- Removed local filesystem and git CLI as the production publication path
- Kept dry-run and source gating behavior while making GitHub the only production writer

## v1.4.6 - April 2026
- Hardened the site publisher with deterministic EventStream ordering and empty-stream fallback
- Added GitHub retry handling for rate limiting and transient failures
- Tightened the Pages build path to repo-state inputs only

## v1.4.7 - April 2026
- Removed the dead nested `/tmp` site publisher stub from the release detector tree
- Trimmed publisher logging down to production decision and retry signals
- Kept the final pipeline clean of simulation, test, and local-output dependencies

## v1.4.8 - April 2026
- Required `docs/site.json` as the sole production Pages input
- Added an explicit build failure when `docs/site.json` is missing
- Added workflow retries to wait for the committed site artifact before deployment
- Logged the copied site artifact path and event count during page builds

## v1.4.9 - April 2026
- Forced the Pages workflow to reset to the latest `origin/main` before building
- Added a hard non-empty guard for `docs/site.json`
- Logged the deployed commit SHA and site artifact size before Pages deploy

## v1.4.10 - April 2026
- Added a retry-wait gate so Pages builds only proceed after `docs/site.json` is present in the synced checkout
- Logged the `docs/site.json` hash, file size, and event count before building
- Kept Pages deploys blocked until the Lambda commit is visible in the workflow workspace

## v1.4.11 - April 2026
- Changed the Pages workflow trigger to `push` only on `docs/site.json`
- Removed manual workflow dispatch from the Pages deploy path
- Made the Lambda commit to `docs/site.json` the single source of truth for Pages builds

## v1.4.12 - April 2026
- Pinned the Pages workflow checkout to `GITHUB_SHA` with full fetch depth
- Replaced git-metadata validation with filesystem-only checks for `docs/site.json`
- Added a checksum gate and explicit artifact logging before the Pages build

## v1.4.13 - April 2026
- Added a dedicated song index snapshot for fast title-based lookup
- Merged song metadata from the Shieldbearer catalog into a normalized local index
- Wired SentinelBot to answer song meaning and release queries from the indexed catalog before falling back

## v1.4.14 - April 2026
- Added a dedicated `shieldbearer-songs` lookup table path for fast song metadata retrieval
- Wrote valid release detections into the songs table without changing the EventStream audit path
- Added a catalog backfill script so the song table can be populated from the existing song index

## v1.4.15 - April 2026
- Added a high-priority site-intent routing layer ahead of FAQ and fallback handling
- Restored the structured Shieldbearer identity response for site-level questions
- Kept SongsTable strict lookup as the first routing stage

## v1.4.16 - April 2026
- Added a dedicated Song Context layer for meaning-based song questions
- Built song-context fields at index generation time from the canonical song catalog
- Routed “about this song” and “meaning of” queries away from release facts and into thematic responses

## v1.4.17 - April 2026
- Captured YouTube descriptions in the release ingestion pipeline
- Stored description-backed song context in the SongsTable schema
- Made meaning responses derive from stored YouTube description data first, with catalog fallback only when needed

## v1.4.18 - April 2026
- Fixed song-context routing to use best-candidate title matching for meaning questions
- Prevented long YouTube titles from blocking `what is [song] about` lookups
- Kept strict release lookup separate from meaning-layer answers

## v1.4.19 - April 2026
- Added a deterministic legacy context override for `Prison Break`
- Kept meaning queries from falling through to release-date answers when the stored song row is sparse

## v1.4.20 - April 2026
- Added human-readable song display titles to meaning responses
- Kept the Song Context layer deterministic while making answers read like proper sentences

## v1.4.21 - April 2026
- Tightened song-intent routing so only real song queries enter the song path
- Added Anthropic song-context prompts for catalog misses using stored song metadata
- Preserved the deterministic lookup layers before any narrative fallback

## v1.4.22 - April 2026
- Split song intent routing into release, meaning, and hybrid paths
- Ensured meaning/explanation queries bypass cached release answers
- Removed duplicate song-intent helpers so the handler has one canonical classifier

## v1.4.23 - April 2026
- Introduced intent-specific response modes for fact, meaning, and lyrics outputs
- Enforced strict single-line fact formatting and bounded lyrics retry handling
- Standardized meaning responses to a consistent short-form contract

## v1.4.24 - April 2026
- Stripped links and metadata from meaning responses before returning them
- Added a meaning-only Anthropic context so explanation answers stay short and thematic
- Kept lyrics and fact outputs on separate formatting contracts

## v1.4.25 - April 2026
- Hardened meaning response sanitization to remove promotional tail text
- Rebuilt meaning responses from clean sentences to preserve the short-form contract
- Kept the fact and lyrics response modes unchanged

## v1.4.26 - April 2026
- Raised the lyrics generation token budget to prevent clipped verses
- Added a larger retry ceiling for incomplete lyric outputs
- Left meaning and fact response modes unchanged

## v1.4.27 - April 2026
- Added deterministic lyrics storage fields for manual, YouTube, and generated sources
- Extracted lyric-shaped blocks from YouTube descriptions during ingestion and backfill
- Switched lyrics retrieval to use stored lyrics before any Anthropic fallback

## v1.4.28 - April 2026
- Cached Anthropic-generated lyrics back into the Songs table as `generated`
- Preserved manual and YouTube-derived lyrics as higher-priority sources
- Kept future lyrics lookups deterministic once a source has been stored

## v1.4.29 - April 2026
- Fixed the lyrics cache-write path so generated lyrics can be stored back into SongsTable
- Kept the stored-lyrics-first resolver order intact

## v1.4.30 - April 2026
- Changed the site publisher target path to the website root `site.json`
- Kept `SITE_JSON_PATH` configurable for non-production overrides
- Aligned the publisher output location with the GitHub Pages fetch path used by `timeline.html`
