#!/usr/bin/env node
/**
 * Pure-function regression tests for the release-detector Lambda.
 * Each test guards a real bug fixed in the commit history.
 */

const det = require("../index.js");

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

// --- mergeDraftOntoSongItem: shield-cli draft fields override release-detector defaults ---
{
  const baseItem = {
    songId: "abc123vid",
    title: "Let My People Go",
    lyrics: "",
    songMeaning: "",
    artwork: ""
  };
  const draft = {
    songId: "let-my-people-go",
    title: "Let My People Go",
    status: "coming_soon",
    lyrics: "Go DOWN, Moses!",
    // Shield-cli writes lowercase songmeaning; merge must read it.
    songmeaning: "A cry that shook a nation.",
    // Shield-cli writes URL into artworkUrl, filename into artwork; prefer URL.
    artwork: "Let My People Go 5.00.33 AM.png",
    artworkUrl: "https://shieldbearerusa.com/images/signal-room/let-my-people-go.jpg"
  };
  const merged = det.mergeDraftOntoSongItem(baseItem, draft);
  assertEqual(merged.lyrics, "Go DOWN, Moses!", "draft lyrics merged onto release record");
  assertEqual(merged.songMeaning, "A cry that shook a nation.", "draft songmeaning (lowercase) becomes songMeaning (canonical)");
  assertEqual(merged.artwork, "https://shieldbearerusa.com/images/signal-room/let-my-people-go.jpg", "artworkUrl preferred over filename");
  assertEqual(merged.status, "released", "merged record stamped as released");
  assertEqual(merged.releaseDetected, true, "merged record stamped releaseDetected=true");
  assertEqual(merged.draftSongId, "let-my-people-go", "draftSongId tracked for cleanup");
}

// --- mergeDraftOntoSongItem: handles missing draft gracefully ---
{
  const item = { songId: "x", lyrics: "kept" };
  const out = det.mergeDraftOntoSongItem(item, null);
  assertEqual(out.songId, "x", "null draft returns songItem unchanged in shape");
  assertEqual(out.lyrics, "kept", "null draft preserves existing lyrics");
}

// --- mergeDraftOntoSongItem: filename-only artwork is rejected (must be URL) ---
{
  const baseItem = { songId: "v1", title: "T", artwork: "" };
  const draft = { songId: "t", artwork: "T.png" };
  const merged = det.mergeDraftOntoSongItem(baseItem, draft);
  assertEqual(merged.artwork, "", "draft artwork that's just a filename is NOT copied (would 404 on homepage)");
}

// --- buildSongItem: stamps status=released and releaseDetected=true ---
{
  const video = {
    videoId: "TESTVIDEO",
    title: "Test Song",
    description: "no lyrics here",
    durationSeconds: 200,
    publishedAt: "2026-04-25T20:00:00Z",
    sourceUrl: "https://www.youtube.com/watch?v=TESTVIDEO"
  };
  const item = det.buildSongItem(video);
  assertEqual(item.status, "released", "buildSongItem stamps status=released");
  assertEqual(item.releaseDetected, true, "buildSongItem stamps releaseDetected=true");
  assertEqual(item.songId, "TESTVIDEO", "songId is the videoId");
  assertEqual(item.type, "official_release", "type is official_release");
}

// --- normalizeSongTitle: handles common variants ---
{
  assertEqual(det.normalizeSongTitle("Let My People Go"), "let my people go", "normalize preserves spacing, lowercases");
  assertEqual(det.normalizeSongTitle("  TEST   song  "), "test song", "normalize trims and collapses whitespace");
  assertEqual(det.normalizeSongTitle(null), "", "normalize handles null safely");
}

// --- extractLyricsFromDescription: structured description with section headers ---
{
  const desc = `
[Verse 1]
On the wall in the dead of night
Eyes awake, blades held tight
Trumpet ready in the hand
Waiting on the King's command

[Chorus]
Sentinels
Stand awake
Guard the truth
For heaven's sake

[Bridge]
Through the dark the warning call
Sentinels upon the wall
`.trim();
  const lyrics = det.extractLyricsFromDescription(desc);
  assert(lyrics.length > 100, "extractor returns substantial lyrics from structured description");
  assert(/Sentinels/.test(lyrics), "extractor preserves chorus content");
}

// --- extractLyricsFromDescription: rejects non-lyric noise ---
{
  const desc = `
Subscribe at https://example.com
Listen on Spotify: https://spotify.com/x
Watch on YouTube
`.trim();
  const lyrics = det.extractLyricsFromDescription(desc);
  assertEqual(lyrics, "", "extractor returns empty for boilerplate-only descriptions");
}

// --- getReleaseMetadata: classify shorts and short-duration videos ---
{
  // #shorts hashtag in title
  const shortsTitle = det.getReleaseMetadata({ title: "Shieldbearer Live #shorts", durationSeconds: 60 });
  assertEqual(shortsTitle.isCandidate, false, "title with #shorts -> not a candidate");
  assertEqual(shortsTitle.rejectionReason, "title_contains_shorts_hashtag", "rejection reason set");

  // Too short duration
  const tooShort = det.getReleaseMetadata({ title: "Quick clip", durationSeconds: 30 });
  assertEqual(tooShort.isCandidate, false, "duration below 45s -> not a candidate");
  assertEqual(tooShort.rejectionReason, "duration_below_45_seconds", "rejection reason set");

  // Healthy release
  const healthy = det.getReleaseMetadata({ title: "Sentinels Official Music Video", durationSeconds: 200 });
  assertEqual(healthy.isCandidate, true, "music + official keyword + >45s -> candidate");
  assert(healthy.score >= 2, "release keywords accumulate in score");

  // Low-confidence (no keywords, sub-45s)
  const lowConf = det.getReleaseMetadata({ title: "untitled", durationSeconds: 30 });
  assertEqual(lowConf.lowConfidence, true, "no keyword + short duration flagged low confidence");
}

// --- isReleaseCandidate wrapper ---
{
  assert(det.isReleaseCandidate({ title: "Sentinels Music", durationSeconds: 180 }) === true, "isReleaseCandidate true for healthy entry");
  assert(det.isReleaseCandidate({ title: "Sentinels #shorts", durationSeconds: 180 }) === false, "isReleaseCandidate false for shorts");
}

// --- buildReleaseEventItem: shape of output ---
{
  const video = {
    videoId: "ABC123",
    title: "Sentinels Official Music Video",
    description: "Watchman themes",
    sourceUrl: "https://www.youtube.com/watch?v=ABC123",
    publishedAt: "2026-04-25T20:00:00Z",
    durationSeconds: 240
  };
  const event = det.buildReleaseEventItem(video);
  assertEqual(event.id, "ABC123", "event id is the videoId");
  assertEqual(event.source, "youtube", "source stamped youtube");
  assertEqual(event.processed, false, "processed flag starts false");
  assert(event.pk.startsWith("releaseevent#youtube#"), "pk has expected prefix");
}

// --- buildSongItem: derived fields ---
{
  const video = {
    videoId: "XYZ",
    title: "Test Song Official",
    description: "[Verse 1]\nLine one\nLine two\nLine three\n\n[Chorus]\nHook one\nHook two",
    sourceUrl: "https://www.youtube.com/watch?v=XYZ",
    publishedAt: "2026-04-25T20:00:00Z",
    durationSeconds: 200
  };
  const item = det.buildSongItem(video);
  assert(item.normalizedTitle.length > 0, "buildSongItem populates normalizedTitle");
  assert(typeof item.canonicalTitle === "string", "canonicalTitle present");
  assert(typeof item.meaningUrl === "string" && item.meaningUrl.includes("song-meanings"), "meaningUrl points to song-meanings page");
  assertEqual(item.contentFormat, "full", "long-form content marked full");
  assertEqual(item.isShort, false, "long-form not marked as short");
}

// --- shouldStopScanning ---
{
  assert(det.shouldStopScanning("vid1", "vid1") === true, "stops when videoId matches lastSeen");
  assert(det.shouldStopScanning("vid1", "vid2") === false, "continues when videoId differs from lastSeen");
  assert(det.shouldStopScanning("vid1", null) === false, "continues when no lastSeen recorded yet");
}

console.log("\n=========================================");
console.log(`Release-detector tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
