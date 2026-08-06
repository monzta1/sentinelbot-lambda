#!/usr/bin/env node
/**
 * Pure-function regression tests for the SentinelBot main handler.
 * Covers the bugs that surfaced in real-user transcripts: phrasing
 * variants for upcoming-release intent, deterministic Signal Room
 * answer formatting, and rate-limit bucket math.
 */

const sb = require("../index.js");

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`PASS ${label}`); passed += 1; }
  else { console.log(`FAIL ${label}`); failed += 1; }
}
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`PASS ${label}`); passed += 1; }
  else {
    console.log(`FAIL ${label}`);
    console.log(`  expected: ${JSON.stringify(expected)}`);
    console.log(`  actual:   ${JSON.stringify(actual)}`);
    failed += 1;
  }
}

// --- isUpcomingQuestion: catches phrasings real users have typed ---
{
  const should_match = [
    "what's in the signal room",
    "anything coming up",
    "next release",
    "next song",
    "whats next",
    "in the works",
    "being written",
    "what are you working on",
    "anything new",
    "up and coming",
    "no i mean up and coming",
    "what's brewing",
    "whats cooking",
    "cooking up",
    "what are you cooking up",
    "anything in the oven",
    "got anything new in the lab",
    "any new tracks brewing",
    "anything fresh dropping soon",
    "whats the new release coming",
    "what new song you working on"
  ];
  for (const q of should_match) {
    assert(sb.isUpcomingQuestion(q) === true, `recognizes upcoming intent: '${q}'`);
  }
}

// --- isUpcomingQuestion: rejects unrelated questions ---
{
  const should_not_match = [
    "tell me about Galilean",
    "are you claude",
    "what is shieldbearer",
    "where can i listen to sentinels",
    "lyrics to galilean"
  ];
  for (const q of should_not_match) {
    assert(sb.isUpcomingQuestion(q) === false, `does NOT trigger upcoming intent on: '${q}'`);
  }
}

// --- buildSignalRoomAnswer: empty state ---
{
  const out = sb.buildSignalRoomAnswer([]);
  assert(/between songs/.test(out), "empty signal room answer says 'between songs'");
  assert(/Signal Room/.test(out), "empty signal room answer links to Signal Room");
}

// --- buildSignalRoomAnswer: populated ---
{
  const songs = [{
    title: "Let My People Go",
    songmeaning: "A cry that shook a nation. A command that broke chains.",
    lyrics: "Go DOWN, Moses!\nBurn through Egypt's gates,\nPharaoh's throne is shaking\n\n[verse 2]\nmore lines"
  }];
  const out = sb.buildSignalRoomAnswer(songs);
  assert(/Let My People Go/.test(out), "populated answer mentions title");
  assert(/A cry that shook a nation/.test(out), "populated answer includes meaning's first sentence");
  assert(/Go DOWN, Moses!/.test(out), "populated answer includes opening lyrics");
  assert(/no release date set yet/i.test(out), "populated answer disclaims release date");
}

// --- buildSignalRoomSystemBlock: returns null when empty ---
{
  assertEqual(sb.buildSignalRoomSystemBlock([]), null, "system block null when no songs");
}

// --- buildSignalRoomSystemBlock: includes override directive ---
{
  const block = sb.buildSignalRoomSystemBlock([{
    title: "Test Song",
    songmeaning: "test meaning here",
    lyrics: "first line\nsecond line"
  }]);
  assert(/OVERRIDES/i.test(block), "system block contains override directive");
  assert(/Test Song/.test(block), "system block contains the song title");
  assert(/test meaning/.test(block), "system block contains the meaning text");
}

// --- rateLimitMinuteBucket: trims to minute precision ---
{
  const a = sb.rateLimitMinuteBucket(new Date("2026-04-25T20:35:12Z"));
  const b = sb.rateLimitMinuteBucket(new Date("2026-04-25T20:35:58Z"));
  const c = sb.rateLimitMinuteBucket(new Date("2026-04-25T20:36:00Z"));
  assertEqual(a, b, "two timestamps in the same minute share a bucket");
  assert(a !== c, "different minutes get different buckets");
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(a), "bucket has minute-precision ISO format");
}

// --- isResolvableIp: rejects unresolvable inputs ---
{
  assert(sb.isResolvableIp("8.8.8.8"), "public IPv4 is resolvable");
  assert(sb.isResolvableIp("108.28.97.217"), "operator-class public IPv4 is resolvable");
  assert(!sb.isResolvableIp(""), "empty string is not resolvable");
  assert(!sb.isResolvableIp(null), "null is not resolvable");
  assert(!sb.isResolvableIp("unknown"), "the 'unknown' sentinel is not resolvable");
  assert(!sb.isResolvableIp("10.0.0.1"), "private 10.x is not resolvable");
  assert(!sb.isResolvableIp("192.168.1.1"), "private 192.168.x is not resolvable");
  assert(!sb.isResolvableIp("172.16.5.4"), "private 172.16-31 is not resolvable");
  assert(!sb.isResolvableIp("127.0.0.1"), "loopback is not resolvable");
  assert(!sb.isResolvableIp("169.254.1.1"), "link-local is not resolvable");
  assert(!sb.isResolvableIp("203.0.113.99"), "TEST-NET-3 documentation range is not resolvable");
  assert(!sb.isResolvableIp("192.0.2.5"), "TEST-NET-1 documentation range is not resolvable");
}

// --- formatLocation: returns "City, RegionCode" (compact format) ---
{
  // ipinfo.io US payload: region is the full state name; expect mapping to code
  assertEqual(
    sb.formatLocation({ city: "Arcola", region: "Virginia", country: "US" }),
    "Arcola, VA",
    "ipinfo.io US payload (region as full state name) -> 'City, StateCode'"
  );
  assertEqual(
    sb.formatLocation({ city: "Chantilly", region: "Virginia", country: "US" }),
    "Chantilly, VA",
    "ipinfo.io 'Virginia' -> 'VA'"
  );
  assertEqual(
    sb.formatLocation({ city: "Washington", region: "District of Columbia", country: "US" }),
    "Washington, DC",
    "ipinfo.io 'District of Columbia' -> 'DC'"
  );
  assertEqual(
    sb.formatLocation({ city: "Toronto", region: "Ontario", country: "CA" }),
    "Toronto, Ontario",
    "ipinfo.io non-US (Canada) -> region name passes through"
  );
  // freeipapi.com US state codes (still supported for legacy provider response)
  assertEqual(
    sb.formatLocation({ cityName: "Dallas", regionCode: "TX", countryCode: "US" }),
    "Dallas, TX",
    "freeipapi.com US payload -> 'City, StateCode'"
  );
  assertEqual(
    sb.formatLocation({ cityName: "Washington D.C.", regionCode: "DC", countryCode: "US" }),
    "Washington D.C., DC",
    "freeipapi.com DC payload -> 'City, DC'"
  );
  // International region codes
  assertEqual(
    sb.formatLocation({ cityName: "Ancaster", regionCode: "ON", countryCode: "CA" }),
    "Ancaster, ON",
    "freeipapi.com Canadian payload -> 'City, ProvinceCode'"
  );
  assertEqual(
    sb.formatLocation({ cityName: "Craignish", regionCode: "QLD", countryCode: "AU" }),
    "Craignish, QLD",
    "freeipapi.com Australian payload -> 'City, StateCode' (3-letter region works)"
  );
  // Fallback to country when region is empty
  assertEqual(
    sb.formatLocation({ cityName: "Somewhere", regionCode: "", countryCode: "US" }),
    "Somewhere, US",
    "Missing regionCode -> falls back to countryCode"
  );
  // ipwho.is uses snake_case keys
  assertEqual(
    sb.formatLocation({ city: "Baltimore", region_code: "MD", country_code: "US" }),
    "Baltimore, MD",
    "ipwho.is payload (snake_case keys) -> 'City, RegionCode'"
  );
  // Missing pieces
  assertEqual(
    sb.formatLocation({ cityName: "", regionCode: "TX", countryCode: "US" }),
    "TX",
    "Missing city -> subdivision alone"
  );
  assertEqual(
    sb.formatLocation({ cityName: "Tokyo", regionCode: "", countryCode: "" }),
    "Tokyo",
    "Missing region + country -> city alone"
  );
  // Empty / null / error cases
  assertEqual(sb.formatLocation({}), null, "Empty object -> null");
  assertEqual(sb.formatLocation(null), null, "Null payload -> null");
  assertEqual(
    sb.formatLocation({ error: true, reason: "quota" }),
    null,
    "ipapi.co error payload -> null"
  );
  assertEqual(
    sb.formatLocation({ success: false, message: "rate limit" }),
    null,
    "ipwho.is failure payload -> null"
  );
}

// --- resolveIpLocation: returns null on unresolvable inputs without hitting the network ---
(async () => {
  const savedFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = () => { fetchCalls += 1; return Promise.reject(new Error("should not fetch")); };
  assertEqual(await sb.resolveIpLocation(""), null, "resolveIpLocation('') -> null without fetching");
  assertEqual(await sb.resolveIpLocation("unknown"), null, "resolveIpLocation('unknown') -> null without fetching");
  assertEqual(await sb.resolveIpLocation("10.0.0.1"), null, "resolveIpLocation private IP -> null without fetching");
  assert(fetchCalls === 0, "resolveIpLocation made zero network calls for unresolvable inputs");
  global.fetch = savedFetch;
})();

// --- buildLogItem: location flows through the log shape ---
{
  const item = sb.buildLogItem({
    id: "x", timestamp: "2026-05-11T12:00:00.000Z",
    sourceIp: "1.2.3.4", location: "Herndon, United States",
    question: "q", answer: "a", page: "p", source: "s",
    historyLength: 0, responseTimeMs: 100, status: "success",
    repeat: false
  });
  assertEqual(item.location, "Herndon, United States", "buildLogItem includes location when provided");
  assertEqual(item.sourceIp, "1.2.3.4", "buildLogItem still includes sourceIp");
}
{
  const item = sb.buildLogItem({
    id: "x", timestamp: "2026-05-11T12:00:00.000Z",
    sourceIp: null,
    question: "q", answer: "a", page: "p", source: "s",
    historyLength: 0, responseTimeMs: 100, status: "success",
    repeat: false
  });
  assertEqual(item.location, null, "buildLogItem location defaults to null when not provided");
}

// --- YouTube link intent: explicit video-link requests ---
{
  const should_match = [
    "can i have the youtube links pls",
    "youtube link please",
    "can you give me the video links",
    "link to the video",
    "whats the url of the youtube video",
    "where can i watch",
    "where do i watch your videos"
  ];
  for (const q of should_match) {
    assert(sb.isYouTubeLinkRequestQuestion(q) === true, `recognizes youtube link intent: '${q}'`);
  }

  const should_not_match = [
    "spotify link please",
    "what is galilean about",
    "do you have a youtube channel",
    "links pls",
    "can i watch you live",
    "whats the merch link"
  ];
  for (const q of should_not_match) {
    assert(sb.isYouTubeLinkRequestQuestion(q) === false, `rejects non-youtube-link intent: '${q}'`);
  }
}

// --- Song link groups: pick the main upload, derive real watch URLs ---
{
  const catalog = [
    { songId: "AAAAAAAAAA1", title: "Celestial Shield (Lyric Video) – Shieldbearer | Christian Metal | Israel, Prophecy & Warfare", type: "official_release", publishedAt: "2025-07-15T00:00:00Z", youtubeUrl: "" },
    { songId: "BBBBBBBBBB2", title: "Celestial Shield - Shieldbearer #shorts", type: "official_release", publishedAt: "2025-07-16T00:00:00Z", youtubeUrl: "" },
    { songId: "CCCCCCCCCC3", title: "Ruler of the Storm – Shieldbearer (Official Lyric Video | Christian Metal Anthem)", type: "official_release", publishedAt: "2025-05-16T00:00:00Z", youtubeUrl: "" },
    { songId: "DDDDDDDDDD4", title: "Shieldbearer | GALILEAN", type: "official_release", publishedAt: "2026-01-23T00:00:00Z", youtubeUrl: "" },
    { songId: "let-my-people-go", title: "Let My People Go", type: "official_release", publishedAt: "", youtubeUrl: "https://www.youtube.com/watch?v=0lUJcLKIt0o" },
    { songId: "some-slug", title: "Curated Song Without Video", type: "official_release", publishedAt: "", youtubeUrl: "" }
  ];
  const groups = sb.buildSongLinkGroups(catalog);
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));

  assertEqual(byKey["celestial shield"]?.watchUrl, "https://www.youtube.com/watch?v=AAAAAAAAAA1", "main upload beats the short for the same song");
  assertEqual(byKey["galilean"]?.displayTitle, "Galilean", "all-caps title renders title-cased");
  assertEqual(byKey["let my people go"]?.watchUrl, "https://www.youtube.com/watch?v=0lUJcLKIt0o", "explicit youtubeUrl wins for curated slug records");
  assert(!byKey["curated song without video"], "curated record with no resolvable URL is dropped");

  // The July 10 failure: titles mentioned in a prior bot answer must
  // resolve to direct links, even from mashed run-on text.
  const matches = sb.matchSongLinksInText(groups, "can i have the youtube links pls\nGalilean Ruler of the Storm Celestial Shield All three hit different angles of the same mission.");
  assertEqual(matches.map((m) => m.key), ["galilean", "ruler of the storm", "celestial shield"], "matches songs from conversation text in mention order");

  const answer = sb.formatYouTubeLinkAnswer(matches);
  assert(answer.includes('href="https://www.youtube.com/watch?v=DDDDDDDDDD4"'), "answer carries the Galilean watch URL");
  assert(answer.includes('href="https://www.youtube.com/watch?v=CCCCCCCCCC3"'), "answer carries the Ruler of the Storm watch URL");
  assert(answer.includes("youtube.com/@ShieldbearerUSA"), "answer closes with the channel link");

  const fallback = sb.formatYouTubeLinkAnswer([]);
  assert(fallback.includes("youtube.com/@ShieldbearerUSA"), "no-match fallback still hands over the channel link");
}

// --- sanitizeMeaningResponse: keep line structure, strip links ---
{
  const mashed = sb.sanitizeMeaningResponse("Galilean\nRuler of the Storm\nCelestial Shield\nAll three hit different angles of the same mission.\nCrank them up.");
  assertEqual(mashed, "Galilean\nRuler of the Storm\nCelestial Shield\nAll three hit different angles of the same mission.\nCrank them up.", "titles on separate lines stay on separate lines");

  const filtered = sb.sanitizeMeaningResponse('Real answer here. Listen on <a href="https://example.com">Spotify</a>.');
  assertEqual(filtered, "Real answer here.", "link sentences still stripped on the meaning path");
}

// Wait briefly so the async resolveIpLocation block runs before the
// process exits. The previous test block's setImmediate equivalents
// settle within a single tick.
setTimeout(() => {
  console.log("\n=========================================");
  console.log(`SentinelBot tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}, 50);
