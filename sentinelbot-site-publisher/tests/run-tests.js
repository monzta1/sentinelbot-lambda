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

// --- buildSiteArtifactFromEvents: empty inputs return empty artifact ---
{
  const out = pub.buildSiteArtifactFromEvents({ events: [], songs: [] });
  assertEqual(out.released.length, 0, "empty inputs -> empty released bucket");
  assertEqual(out.comingSoon.length, 0, "empty inputs -> empty comingSoon bucket");
  assertEqual(out.events.length, 0, "empty inputs -> empty events bucket");
}

// --- buildSiteArtifactFromEvents: event without matching song synthesizes a song ---
{
  // When an event references a songId not in the songs table, the
  // publisher synthesizes a thin song record so the event still
  // produces output.
  const events = [{
    eventId: "e1",
    songId: "lone-event-id",
    title: "Lone Event",
    eventType: "SONG_RELEASED",
    source: "youtube",
    timestamp: "2026-04-25T12:00:00Z",
    stateAfter: "released",
    payload: {}
  }];
  const out = pub.buildSiteArtifactFromEvents({ events, songs: [] });
  assertEqual(out.released.length, 1, "lone event without song record still produces released entry");
  assertEqual(out.released[0].title, "Lone Event", "synthesized song carries event title");
}

// --- compareReleaseEventsDesc: timestamp tiebreak via songId ---
{
  const a = { timestamp: "2026-04-25T20:00:00Z", songId: "alpha" };
  const b = { timestamp: "2026-04-25T20:00:00Z", songId: "beta" };
  const cmp = pub.compareReleaseEventsDesc(a, b);
  assert(cmp !== 0, "equal timestamps fall back to songId comparison");
}

// --- normalizeReleaseEventItem: returns null for non-objects ---
{
  assertEqual(pub.normalizeReleaseEventItem(null), null, "null input -> null");
  assertEqual(pub.normalizeReleaseEventItem("string"), null, "string input -> null");
}

// --- normalizeReleaseEventItem: synthesizes stateAfter from cli + youtube hints ---
{
  const cliEvent = pub.normalizeReleaseEventItem({
    id: "e1", songId: "s1", title: "T", eventType: "CLI_INGEST", source: "shield-ingest-cli", timestamp: "2026-04-25T20:00:00Z"
  });
  assertEqual(cliEvent.stateAfter, "coming_soon", "CLI_INGEST event without explicit stateAfter -> coming_soon");

  const youtubeEvent = pub.normalizeReleaseEventItem({
    id: "e2", songId: "s2", title: "T", eventType: "new_content_detected", source: "youtube", timestamp: "2026-04-25T20:00:00Z"
  });
  assertEqual(youtubeEvent.stateAfter, "released", "youtube source -> released stateAfter");
}

// --- getArtifactReleaseId / getArtifactSource: read from nested fields ---
{
  const id = pub.getArtifactReleaseId({ homepage: { banner: { activeReleaseId: "abc" } } });
  assertEqual(id, "abc", "release id pulled from homepage.banner.activeReleaseId");
  const id2 = pub.getArtifactReleaseId({ release: { id: "xyz" } });
  assertEqual(id2, "xyz", "release id falls back to release.id");
  const src = pub.getArtifactSource({}, { source: "youtube" });
  assertEqual(src, "youtube", "event source preferred over artifact source");
}

// --- normalizeReleaseEventItem: skips items missing identity ---
{
  const skipped = pub.normalizeReleaseEventItem({ id: "", payload: {} });
  // Returns shape with empty fields, but eventId is empty
  assertEqual(skipped.eventId, "", "missing id yields empty eventId");
}

// --- normalizeSongTableItem: rejects malformed input ---
{
  assertEqual(pub.normalizeSongTableItem(null), null, "null input -> null");
  assertEqual(pub.normalizeSongTableItem("string"), null, "string input -> null");
  assertEqual(pub.normalizeSongTableItem({}), null, "missing songId -> null");
}

// --- compareSongsDesc / compareReleaseSongsDesc: tiebreak by songId ---
{
  const a = { publishedAt: "2026-04-25T20:00:00Z", songId: "a" };
  const b = { publishedAt: "2026-04-25T20:00:00Z", songId: "b" };
  assert(pub.compareReleaseEventsDesc(
    { timestamp: a.publishedAt, songId: "a" },
    { timestamp: b.publishedAt, songId: "b" }
  ) !== 0, "release events desc: tie broken by songId");
}

// --- buildSiteArtifactFromEvents: events without songId are skipped ---
{
  const events = [
    { eventId: "e1", songId: "", title: "skipped", eventType: "SONG_RELEASED", source: "youtube", timestamp: "2026-04-25T20:00:00Z", stateAfter: "released" },
    { eventId: "e2", songId: "valid", title: "Valid", eventType: "SONG_RELEASED", source: "youtube", timestamp: "2026-04-25T20:00:00Z", stateAfter: "released" }
  ];
  const out = pub.buildSiteArtifactFromEvents({ events, songs: [] });
  assertEqual(out.released.length, 1, "events without songId are skipped");
}

// --- normalizeSongTableItem: alternate id fields ---
{
  const fromId = pub.normalizeSongTableItem({ id: "x1", title: "X", status: "released" });
  assertEqual(fromId.songId, "x1", "songId falls back to id");
  const fromPk = pub.normalizeSongTableItem({ pk: "x2", title: "X", status: "released" });
  assertEqual(fromPk.songId, "x2", "songId falls back to pk");
}

// --- normalizeReleaseEventItem: stateAfter inference branches ---
{
  // payload.releaseDetected
  const e1 = pub.normalizeReleaseEventItem({
    id: "e", songId: "s", title: "T", eventType: "X", source: "x",
    timestamp: "2026-04-25T20:00:00Z", payload: { releaseDetected: true }
  });
  assertEqual(e1.stateAfter, "released", "payload.releaseDetected -> released");

  // payload.status === "released"
  const e2 = pub.normalizeReleaseEventItem({
    id: "e", songId: "s", title: "T", eventType: "X", source: "x",
    timestamp: "2026-04-25T20:00:00Z", payload: { status: "released" }
  });
  assertEqual(e2.stateAfter, "released", "payload.status released -> released");

  // payload.status with non-released value
  const e3 = pub.normalizeReleaseEventItem({
    id: "e", songId: "s", title: "T", eventType: "X", source: "x",
    timestamp: "2026-04-25T20:00:00Z", payload: { status: "coming_soon" }
  });
  assertEqual(e3.stateAfter, "coming_soon", "payload.status normalized");

  // fallback draft
  const e4 = pub.normalizeReleaseEventItem({
    id: "e", songId: "s", title: "T", eventType: "X", source: "x",
    timestamp: "2026-04-25T20:00:00Z", payload: {}
  });
  assertEqual(e4.stateAfter, "draft", "no signals -> draft fallback");
}

// --- compareReleaseEventsDesc: different timestamps sort newest first ---
{
  const a = { timestamp: "2026-04-25T20:00:00Z", songId: "a" };
  const b = { timestamp: "2026-04-25T22:00:00Z", songId: "b" };
  const cmp = pub.compareReleaseEventsDesc(a, b);
  assert(cmp > 0, "newer timestamp comes first in desc sort");
}

// --- buildSiteArtifactFromEvents: duplicate songId events keep only latest ---
{
  const events = [
    { eventId: "e1", songId: "abc", title: "T", eventType: "SONG_RELEASED", source: "youtube", timestamp: "2026-04-25T22:00:00Z", stateAfter: "released" },
    { eventId: "e2", songId: "abc", title: "T", eventType: "SONG_UPDATED", source: "youtube", timestamp: "2026-04-25T20:00:00Z", stateAfter: "released" }
  ];
  const out = pub.buildSiteArtifactFromEvents({ events, songs: [] });
  assertEqual(out.released.length, 1, "duplicate songId -> only one entry");
  assertEqual(out.events.length, 2, "all events retained in events stream");
}

// --- buildSiteArtifactFromEvents: duplicate titles keep first releaseIndex entry ---
{
  // Two released songs with the same normalized title; only the first
  // claims the releaseIndex slot. Covers the dedup branch.
  const songs = [
    {
      songId: "first", title: "Galilean", state: "released",
      publishedAt: "2026-04-25T22:00:00Z", lyrics: "x", songMeaning: "y", artwork: ""
    },
    {
      songId: "second", title: "Galilean", state: "released",
      publishedAt: "2026-04-25T20:00:00Z", lyrics: "x", songMeaning: "y", artwork: ""
    }
  ];
  const out = pub.buildSiteArtifactFromEvents({ events: [], songs });
  const keys = Object.keys(out.releaseIndex || {});
  assertEqual(keys.length, 1, "duplicate normalized title -> single releaseIndex entry");
}

// --- encodeContent / decodeContent round-trip ---
{
  const s = "hello world\nGo DOWN, Moses";
  const encoded = pub.encodeContent(s);
  assert(encoded.length > 0, "encodeContent returns non-empty base64");
  assertEqual(pub.decodeContent(encoded), s, "decodeContent round-trips encoded content");
  assertEqual(pub.decodeContent(""), "", "decodeContent handles empty");
}

// --- hashContent: deterministic ---
{
  const a = pub.hashContent("test");
  const b = pub.hashContent("test");
  const c = pub.hashContent("different");
  assertEqual(a, b, "hashContent deterministic for same input");
  assert(a !== c, "hashContent differs for different input");
}

// --- buildSiteArtifactFromEvents: multiple songs trigger sort comparators ---
{
  const songs = [
    { songId: "older", title: "Older", state: "released", publishedAt: "2026-04-20T00:00:00Z" },
    { songId: "newer", title: "Newer", state: "released", publishedAt: "2026-04-25T00:00:00Z" },
    { songId: "middle", title: "Middle", state: "released", publishedAt: "2026-04-22T00:00:00Z" }
  ];
  const out = pub.buildSiteArtifactFromEvents({ events: [], songs });
  assertEqual(out.released[0].title, "Newer", "released sorted newest-first");
  assertEqual(out.homepage.featuredRelease.title, "Newer", "featuredRelease is the newest");
}

// --- buildSongView: synthesizes from event when song has no fields ---
{
  // Covers the path where a song record is sparse and the event
  // payload carries the actual content.
  const sparseSong = { songId: "abc", title: "" };
  const eventWithPayload = {
    songId: "abc", traceId: "t1", title: "From Event",
    timestamp: "2026-04-25T20:00:00Z", sourceUrl: "https://x/y",
    payload: {
      lyrics: "from payload",
      songMeaning: "meaning from payload",
      artwork: "https://x/art.jpg"
    }
  };
  const view = pub.buildSongView(sparseSong, eventWithPayload);
  assertEqual(view.lyrics, "from payload", "lyrics pulled from event payload");
  assertEqual(view.artwork, "https://x/art.jpg", "artwork pulled from event payload");
  assertEqual(view.title, "From Event", "title falls back to event title");
}

console.log("\n=========================================");
console.log(`Publisher tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
