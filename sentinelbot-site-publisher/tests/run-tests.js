#!/usr/bin/env node
/**
 * Pure-function regression tests for the publisher Lambda.
 * No DynamoDB, no GitHub. Each test guards a real bug fixed in the
 * commit history: the assertions exist so those bugs cannot return
 * silently.
 */

const pub = require("../index.js");

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`PASS ${label}`);
    passed += 1;
  } else {
    console.log(`FAIL ${label}`);
    failed += 1;
  }
}

function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`PASS ${label}`);
    passed += 1;
  } else {
    console.log(`FAIL ${label}`);
    console.log(`  expected: ${JSON.stringify(expected)}`);
    console.log(`  actual:   ${JSON.stringify(actual)}`);
    failed += 1;
  }
}

// --- buildEmptySiteArtifact: schema agreed with website ---
{
  const empty = pub.buildEmptySiteArtifact();
  assert("comingSoon" in empty, "empty artifact emits comingSoon (not incoming)");
  assert("events" in empty, "empty artifact emits events (not eventsStream)");
  assert("incoming" in empty === false, "empty artifact does NOT emit deprecated incoming");
  assert("eventsStream" in empty === false, "empty artifact does NOT emit deprecated eventsStream");
  assert("featuredRelease" in (empty.homepage || {}), "empty artifact has homepage.featuredRelease key");
}

// --- normalizeSongTableItem: handle shield-cli vs release-detector field names ---
{
  // Shield-cli writes lowercase songmeaning; publisher must read it.
  const shieldCliRecord = {
    songId: "let-my-people-go",
    title: "Let My People Go",
    status: "coming_soon",
    lyrics: "Go DOWN, Moses!",
    songmeaning: "A cry that shook a nation.",
    artworkUrl: "https://shieldbearerusa.com/images/signal-room/let-my-people-go.jpg",
    artwork: "Let My People Go 5.00.33 AM.png"
  };
  const norm = pub.normalizeReleaseEventItem;
  const songNorm = (item) => {
    // re-inline the function under test via the publisher's exported buildSongView
    // since normalizeSongTableItem is exported directly:
    const fn = pub.normalizeSongTableItem || pub.normalizeSongTable;
    return (typeof fn === "function") ? fn(item) : null;
  };
  const out = pub.normalizeSongTableItem(shieldCliRecord);
  assertEqual(out.songMeaning, "A cry that shook a nation.", "songmeaning (lowercase) read into songMeaning (canonical)");
  assertEqual(out.lyrics, "Go DOWN, Moses!", "lyrics passes through");
  assertEqual(out.artwork, "https://shieldbearerusa.com/images/signal-room/let-my-people-go.jpg", "artworkUrl preferred over filename in artwork field");
  assertEqual(out.state, "coming_soon", "state derived from status");
}

// --- normalizeSongTableItem: artwork field with filename fallback to URL ---
{
  const recordWithUrlInArtwork = {
    songId: "x",
    title: "X",
    status: "released",
    artwork: "https://example.com/x.jpg"
  };
  const out = pub.normalizeSongTableItem(recordWithUrlInArtwork);
  assertEqual(out.artwork, "https://example.com/x.jpg", "URL in artwork field accepted when artworkUrl missing");
}
{
  const recordWithFilenameOnly = {
    songId: "y",
    title: "Y",
    status: "released",
    artwork: "Y artwork.png"
  };
  const out = pub.normalizeSongTableItem(recordWithFilenameOnly);
  assertEqual(out.artwork, "", "filename (non-URL) in artwork field rejected when artworkUrl missing");
}

// --- buildSongView: song-table state wins over event-derived state ---
{
  // Real bug: SONG_UPDATED events from shield-cli got synthesized
  // stateAfter="draft", which clobbered a song-table row marked released.
  const releasedSong = { songId: "abc", title: "Released Song", state: "released" };
  const updatedEvent = { songId: "abc", eventType: "SONG_UPDATED", stateAfter: "draft", source: "shield-ingest-cli" };
  const view = pub.buildSongView(releasedSong, updatedEvent);
  assertEqual(view.state, "released", "song-table state wins when event is just a SONG_UPDATED");
}

// --- buildSongView: lyrics + meaning + artwork pass through ---
{
  const song = {
    songId: "abc",
    title: "Test",
    state: "released",
    lyrics: "verse one",
    songMeaning: "the meaning",
    artwork: "https://x/a.jpg"
  };
  const view = pub.buildSongView(song, null);
  assertEqual(view.lyrics, "verse one", "buildSongView passes lyrics");
  assertEqual(view.songMeaning, "the meaning", "buildSongView passes songMeaning");
  assertEqual(view.artwork, "https://x/a.jpg", "buildSongView passes artwork");
}

// --- buildSiteArtifactFromEvents: required destructured shape ---
{
  // Real bug: handler passed an array; function expected {events, songs}.
  // Calling with a plain array used to silently produce empty artifacts.
  const songs = [{
    songId: "let-my-people-go",
    title: "Let My People Go",
    state: "released",
    publishedAt: "2026-04-25T20:00:00Z",
    lyrics: "Go DOWN, Moses!",
    songMeaning: "A cry.",
    artwork: "https://x/lmpg.jpg",
    sourceUrl: "https://www.youtube.com/watch?v=abc"
  }];
  const events = [];
  const artifact = pub.buildSiteArtifactFromEvents({ events, songs });
  assertEqual(artifact.released.length, 1, "released bucket gets the released song");
  assertEqual(artifact.comingSoon.length, 0, "comingSoon empty when no coming-soon songs");
  assertEqual(artifact.released[0].title, "Let My People Go", "released entry preserves title");
  assertEqual(artifact.released[0].lyrics, "Go DOWN, Moses!", "released entry preserves lyrics");
  assertEqual(artifact.homepage.featuredRelease.title, "Let My People Go", "featuredRelease populated from latest released");
  assertEqual(artifact.homepage.featuredRelease.artwork, "https://x/lmpg.jpg", "featuredRelease carries artwork URL");
  assertEqual(artifact.homepage.featuredRelease.lyrics, "Go DOWN, Moses!", "featuredRelease carries lyrics");
  assertEqual(artifact.homepage.featuredRelease.songMeaning, "A cry.", "featuredRelease carries songMeaning");
}

// --- buildSiteArtifactFromEvents: coming_soon songs land in comingSoon bucket ---
{
  const songs = [{
    songId: "next-song",
    title: "Next Song",
    state: "coming_soon",
    publishedAt: "2026-04-25T22:00:00Z"
  }];
  const artifact = pub.buildSiteArtifactFromEvents({ events: [], songs });
  assertEqual(artifact.comingSoon.length, 1, "comingSoon bucket gets coming-soon song");
  assertEqual(artifact.released.length, 0, "released bucket empty when no released songs");
}

// --- isAllowedSource ---
{
  assert(pub.isAllowedSource("youtube") === true, "youtube is in default ALLOWED_SOURCES");
  assert(pub.isAllowedSource("manual-test") === false, "manual-test rejected by default");
}

// --- parseAllowedSources ---
{
  assertEqual(pub.parseAllowedSources('["youtube","cli"]'), ["youtube", "cli"], "parseAllowedSources accepts JSON array");
  assertEqual(pub.parseAllowedSources("not json"), ["youtube"], "parseAllowedSources falls back to default on garbage");
}

// --- buildCanonicalSiteArtifact: produces JSON ending with newline ---
{
  const out = pub.buildCanonicalSiteArtifact({ a: 1 });
  assert(out.endsWith("\n"), "canonical artifact ends with trailing newline");
  assert(JSON.parse(out).a === 1, "canonical artifact is valid JSON");
}

console.log("\n=========================================");
console.log(`Publisher tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
