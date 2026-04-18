# SentinelBot Changelog

Versioning note:
- Use semantic versioning in the form `vmajor.minor.patch`
- Patch bumps track prompt tuning, cache additions, and other small bot updates
- Minor bumps track visible capability additions or new behavioral layers
- Major bumps track architecture or deployment model changes

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
