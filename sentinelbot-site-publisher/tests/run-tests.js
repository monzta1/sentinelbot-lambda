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
  // Both events carry sourceUrl since the timeline filter requires it.
  // Dedup happens at the song level, not the events level; both events
  // remain in the events stream so the timeline can still show two
  // chronologically-distinct release records for the same songId.
  const events = [
    { eventId: "e1", songId: "abc", title: "T", eventType: "SONG_RELEASED", source: "youtube", timestamp: "2026-04-25T22:00:00Z", stateAfter: "released", sourceUrl: "https://www.youtube.com/watch?v=abc" },
    { eventId: "e2", songId: "abc", title: "T", eventType: "SONG_UPDATED", source: "youtube", timestamp: "2026-04-25T20:00:00Z", stateAfter: "released", sourceUrl: "https://www.youtube.com/watch?v=abc" }
  ];
  const out = pub.buildSiteArtifactFromEvents({ events, songs: [] });
  assertEqual(out.released.length, 1, "duplicate songId -> only one entry");
  assertEqual(out.events.length, 2, "release events retained in events stream");
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

// --- cleanReleaseTitle: strips Shieldbearer prefix and pipe suffix ---
{
  assertEqual(pub.cleanReleaseTitle(""), "", "empty input -> empty");
  assertEqual(pub.cleanReleaseTitle(null), "", "null input -> empty");
  assertEqual(
    pub.cleanReleaseTitle("Shieldbearer - Let My People Go | Heavy Christian Metal Anthem"),
    "Let My People Go",
    "strips 'Shieldbearer - ' prefix and ' | ...' suffix"
  );
  assertEqual(
    pub.cleanReleaseTitle("SHIELDBEARER – Sentinels"),
    "Sentinels",
    "case-insensitive prefix, en-dash variant"
  );
  assertEqual(
    pub.cleanReleaseTitle("Let My People Go"),
    "Let My People Go",
    "clean title left alone"
  );
  assertEqual(
    pub.cleanReleaseTitle("\"Galilean\""),
    "Galilean",
    "wrapping double-quotes stripped"
  );
  assertEqual(
    pub.cleanReleaseTitle("Some Track | with pipe"),
    "Some Track",
    "non-Shieldbearer title still cleans pipe suffix"
  );
  // Real bug: titles like "Slayer of the Grave [Christian Metal |
  // Official Lyric Video]" had a "|" inside the brackets, so the
  // earlier implementation chopped the title to "Slayer of the
  // Grave [Christian Metal". Strip bracketed tags first.
  assertEqual(
    pub.cleanReleaseTitle("Slayer of the Grave [Christian Metal | Official Lyric Video]"),
    "Slayer of the Grave",
    "bracketed tag with internal pipe is fully stripped"
  );
  assertEqual(
    pub.cleanReleaseTitle("Pahalgam (A Prayer for India) [Official Audio]"),
    "Pahalgam (A Prayer for India)",
    "bracketed tag stripped, parenthesized subtitle preserved"
  );
}

// --- isValidArtworkUrl: rejects YouTube watch URLs and non-http ---
{
  assert(!pub.isValidArtworkUrl(""), "empty -> not valid");
  assert(!pub.isValidArtworkUrl(null), "null -> not valid");
  assert(!pub.isValidArtworkUrl("not a url"), "non-URL string -> not valid");
  assert(!pub.isValidArtworkUrl("ftp://example.com/x.jpg"), "non-http scheme -> not valid");
  assert(
    !pub.isValidArtworkUrl("https://www.youtube.com/watch?v=abc"),
    "YouTube watch URL -> not valid"
  );
  assert(
    !pub.isValidArtworkUrl("https://youtube.com/watch?v=abc"),
    "YouTube watch URL without www -> not valid"
  );
  assert(
    !pub.isValidArtworkUrl("https://youtu.be/abc"),
    "youtu.be share URL -> not valid"
  );
  assert(
    pub.isValidArtworkUrl("https://img.youtube.com/vi/abc/hqdefault.jpg"),
    "YouTube thumbnail URL -> valid"
  );
  assert(
    pub.isValidArtworkUrl("https://shieldbearerusa.com/images/signal-room/let-my-people-go.jpg"),
    "project CDN URL -> valid"
  );
}

// --- cleanLyrics: drops description-shaped text ---
{
  assertEqual(pub.cleanLyrics(""), "", "empty -> empty");
  assertEqual(pub.cleanLyrics(null), "", "null -> empty");
  const realLyrics = "Go DOWN, Moses!\nBurn through Egypt's gates,\nPharaoh's throne is shaking,";
  assertEqual(pub.cleanLyrics(realLyrics), realLyrics, "real lyrics pass through");
  assertEqual(
    pub.cleanLyrics(realLyrics, { description: realLyrics }),
    "",
    "lyrics equal to description -> dropped"
  );
  const descriptionWithUrl = "Some marketing copy.\nWatch: https://youtube.com/watch?v=x";
  assertEqual(
    pub.cleanLyrics(descriptionWithUrl),
    "",
    "text with YouTube URL -> dropped"
  );
  assertEqual(
    pub.cleanLyrics("Shieldbearer - \"Let My People Go\"\nA cry that shook a nation."),
    "",
    "text starting with 'Shieldbearer' -> dropped (artist name in description)"
  );
  assertEqual(
    pub.cleanLyrics("A cry that shook a nation. New Single 2026 incoming."),
    "",
    "text mentioning 'new single 2026' -> dropped (marketing copy)"
  );
  assertEqual(
    pub.cleanLyrics("Real lyrics here.\n#Shieldbearer #ChristianMetal"),
    "",
    "text with #Shieldbearer hashtag -> dropped (promotional)"
  );
  const longText = "a".repeat(8001);
  assertEqual(pub.cleanLyrics(longText), "", "text > 8000 chars -> dropped");
  // The previous lyrics pass-through case where lyrics legitimately
  // include a song title is preserved (no title-equality check).
  const lyricsWithTitle = "Galilean rose at dawn\nGalilean walked the shore\n";
  assertEqual(
    pub.cleanLyrics(lyricsWithTitle),
    lyricsWithTitle.trim(),
    "lyrics that legitimately include the song title pass through (trimmed)"
  );
}

// --- normalizeSongTableItem: applies title + lyrics + artwork sanitization ---
{
  // Real bug: detector wrote YouTube description into lyrics, YouTube
  // watch URL into payload artworkUrl, full YouTube title into title.
  const dirtyDetectorRecord = {
    songId: "0lUJcLKIt0o",
    title: "Shieldbearer - Let My People Go | Heavy Christian Metal Anthem",
    status: "released",
    lyrics: "Shieldbearer - \"Let My People Go\"\nNew Single 2026\nhttps://youtube.com/watch?v=x",
    description: "Shieldbearer - \"Let My People Go\"\nNew Single 2026\nhttps://youtube.com/watch?v=x",
    artworkUrl: "https://www.youtube.com/watch?v=0lUJcLKIt0o"
  };
  const out = pub.normalizeSongTableItem(dirtyDetectorRecord);
  assertEqual(out.title, "Let My People Go", "dirty title cleaned");
  assertEqual(out.lyrics, "", "dirty lyrics dropped");
  assertEqual(out.artwork, "", "YouTube watch URL artwork dropped");

  // Clean shield-cli record passes through untouched.
  const cleanShieldCliRecord = {
    songId: "let-my-people-go",
    title: "Let My People Go",
    status: "released",
    lyrics: "Go DOWN, Moses!\nBurn through Egypt's gates,",
    artworkUrl: "https://shieldbearerusa.com/images/signal-room/let-my-people-go.jpg"
  };
  const clean = pub.normalizeSongTableItem(cleanShieldCliRecord);
  assertEqual(clean.title, "Let My People Go", "clean title preserved");
  assertEqual(clean.lyrics, "Go DOWN, Moses!\nBurn through Egypt's gates,", "clean lyrics preserved");
  assertEqual(
    clean.artwork,
    "https://shieldbearerusa.com/images/signal-room/let-my-people-go.jpg",
    "clean artwork URL preserved"
  );
}

// --- buildSongView: same sanitization on event payload values ---
{
  const sparseSong = { songId: "0lUJcLKIt0o", title: "" };
  const dirtyEvent = {
    songId: "0lUJcLKIt0o",
    title: "Shieldbearer - Let My People Go | Heavy Christian Metal Anthem",
    publishedAt: "2026-05-02T12:40:33Z",
    timestamp: "2026-05-02T13:00:08.851Z",
    sourceUrl: "https://www.youtube.com/watch?v=0lUJcLKIt0o",
    payload: {
      lyrics: "Shieldbearer - \"Let My People Go\"\nhttps://youtube.com/watch?v=x",
      description: "Shieldbearer - \"Let My People Go\"\nhttps://youtube.com/watch?v=x",
      artworkUrl: "https://www.youtube.com/watch?v=0lUJcLKIt0o"
    }
  };
  const view = pub.buildSongView(sparseSong, dirtyEvent);
  assertEqual(view.title, "Let My People Go", "buildSongView strips dirty title");
  assertEqual(view.lyrics, "", "buildSongView drops description-shaped lyrics");
  assertEqual(view.artwork, "", "buildSongView drops YouTube watch URL artwork");
  assertEqual(
    view.publishedAt,
    "2026-05-02T12:40:33Z",
    "buildSongView prefers payload.publishedAt over event timestamp"
  );
}

// --- eventsForArtifact: includes website-required fields ---
{
  // Real regression: prior emitter stripped events to 4 fields, which
  // broke /timeline (it reads id, title, publishedAt, sourceUrl).
  const events = [
    {
      songId: "0lUJcLKIt0o",
      eventId: "evt1",
      eventType: "SONG_RELEASED",
      stateAfter: "released",
      title: "Shieldbearer - Let My People Go | Heavy Christian Metal Anthem",
      timestamp: "2026-05-02T13:00:08.851Z",
      publishedAt: "2026-05-02T12:40:33Z",
      sourceUrl: "https://www.youtube.com/watch?v=0lUJcLKIt0o",
      source: "release-detector-youtube",
      payload: {}
    },
    {
      // SONG_UPDATED tick from shield-cli with no sourceUrl. Must be
      // filtered out so it does not crowd the timeline.
      songId: "let-my-people-go",
      eventId: "evt2",
      eventType: "SONG_UPDATED",
      stateAfter: "draft",
      title: "Let My People Go",
      timestamp: "2026-04-25T20:44:23.351Z",
      publishedAt: "2026-04-25T20:44:23.351Z",
      sourceUrl: "",
      source: "shield-ingest-cli",
      payload: {}
    }
  ];
  const out = pub.buildSiteArtifactFromEvents({ events, songs: [] });
  assert(Array.isArray(out.events), "artifact has events array");
  assertEqual(out.events.length, 1, "events without sourceUrl filtered out");
  const e = out.events[0];
  assertEqual(e.id, "0lUJcLKIt0o", "event has id (timeline reads this)");
  assertEqual(e.title, "Let My People Go", "event title is cleaned");
  assertEqual(e.publishedAt, "2026-05-02T12:40:33Z", "event publishedAt is the platform-publish time, not detector run time");
  assertEqual(e.sourceUrl, "https://www.youtube.com/watch?v=0lUJcLKIt0o", "event sourceUrl preserved");
  assert("albumId" in e && "isShort" in e && "contentFormat" in e, "event has album/short defaults timeline reads");
}

// --- normalizeSongTableItem: scripture and reference pass through ---
{
  const recordWithScripture = {
    songId: "let-my-people-go",
    title: "Let My People Go",
    status: "released",
    reference: "Exodus 5:1 | Exodus 7:16",
    scripture: {
      ref: "Exodus 5:1",
      quote: "Thus says the Lord, the God of Israel, 'Let my people go...'"
    }
  };
  const out = pub.normalizeSongTableItem(recordWithScripture);
  assertEqual(out.reference, "Exodus 5:1 | Exodus 7:16", "reference passes through");
  assertEqual(out.scripture.ref, "Exodus 5:1", "scripture.ref passes through");
  assert(out.scripture.quote.indexOf("Let my people go") !== -1, "scripture.quote passes through");
}

// --- normalizeSongTableItem: missing scripture defaults to safe empties ---
{
  const recordWithoutScripture = {
    songId: "x",
    title: "X",
    status: "released"
  };
  const out = pub.normalizeSongTableItem(recordWithoutScripture);
  assertEqual(out.reference, "", "missing reference -> empty string");
  assertEqual(out.scripture, { ref: "", quote: "" }, "missing scripture -> empty object");
}

// --- mergeReleasedWithComingSoon: scripture from curated record wins ---
{
  const released = [
    {
      songId: "0lUJcLKIt0o",
      title: "Let My People Go",
      state: "released",
      sourceUrl: "https://www.youtube.com/watch?v=0lUJcLKIt0o",
      reference: "",
      scripture: { ref: "", quote: "" }
    }
  ];
  const comingSoon = [
    {
      songId: "let-my-people-go",
      title: "Let My People Go",
      state: "coming_soon",
      lyrics: "real lyrics",
      reference: "Exodus 5:1",
      scripture: { ref: "Exodus 5:1", quote: "Let my people go..." }
    }
  ];
  const out = pub.mergeReleasedWithComingSoon(released, comingSoon);
  assertEqual(out.released.length, 1, "merged into single entry");
  assertEqual(out.released[0].reference, "Exodus 5:1", "merged reference from curated record");
  assertEqual(out.released[0].scripture.ref, "Exodus 5:1", "merged scripture.ref from curated record");
}

// --- mergeReleasedWithComingSoon: merge same-title songs across states ---
{
  // Real bug: shield-cli wrote let-my-people-go (coming_soon) with
  // curated lyrics + artwork; release-detector wrote 0lUJcLKIt0o
  // (released) with empty lyrics + no artwork. Merge so the release
  // promotes the curated entry to "released" with the YouTube videoId.
  const released = [
    {
      songId: "0lUJcLKIt0o",
      title: "Let My People Go",
      state: "released",
      lyrics: "",
      artwork: "",
      sourceUrl: "https://www.youtube.com/watch?v=0lUJcLKIt0o",
      publishedAt: "2026-05-02T12:40:33Z",
      traceId: "youtube:0lUJcLKIt0o"
    }
  ];
  const comingSoon = [
    {
      songId: "let-my-people-go",
      title: "Let My People Go",
      state: "coming_soon",
      lyrics: "Go DOWN, Moses!\nBurn through Egypt's gates,",
      artwork: "https://shieldbearerusa.com/images/signal-room/let-my-people-go.jpg",
      sourceUrl: "",
      publishedAt: ""
    },
    {
      songId: "another-track",
      title: "Another Track",
      state: "coming_soon",
      lyrics: "untouched lyrics",
      artwork: ""
    }
  ];
  const out = pub.mergeReleasedWithComingSoon(released, comingSoon);
  assertEqual(out.released.length, 1, "single merged released entry");
  const merged = out.released[0];
  assertEqual(merged.songId, "let-my-people-go", "merged keeps shield-cli kebab songId");
  assertEqual(merged.videoId, "0lUJcLKIt0o", "merged carries YouTube videoId");
  assertEqual(merged.state, "released", "merged state is released");
  assertEqual(merged.lyrics, "Go DOWN, Moses!\nBurn through Egypt's gates,", "merged keeps curated lyrics");
  assertEqual(merged.artwork, "https://shieldbearerusa.com/images/signal-room/let-my-people-go.jpg", "merged keeps curated artwork");
  assertEqual(merged.sourceUrl, "https://www.youtube.com/watch?v=0lUJcLKIt0o", "merged keeps YouTube watch URL");
  assertEqual(merged.publishedAt, "2026-05-02T12:40:33Z", "merged keeps YouTube publishedAt");
  assertEqual(out.comingSoon.length, 1, "matched coming_soon record removed");
  assertEqual(out.comingSoon[0].songId, "another-track", "unmatched coming_soon record retained");
}

// --- mergeReleasedWithComingSoon: no match leaves released unchanged but adds videoId ---
{
  const released = [{ songId: "abc123", title: "Standalone", state: "released", lyrics: "" }];
  const comingSoon = [{ songId: "another", title: "Different", state: "coming_soon", lyrics: "y" }];
  const out = pub.mergeReleasedWithComingSoon(released, comingSoon);
  assertEqual(out.released.length, 1, "released count unchanged");
  assertEqual(out.released[0].songId, "abc123", "songId unchanged when no match");
  assertEqual(out.released[0].videoId, "abc123", "videoId defaults to songId");
  assertEqual(out.comingSoon.length, 1, "comingSoon untouched when no match");
}

// --- mergeReleasedWithComingSoon: empty inputs are safe ---
{
  assertEqual(
    pub.mergeReleasedWithComingSoon([], []),
    { released: [], comingSoon: [] },
    "two empty inputs -> two empty outputs"
  );
  const out = pub.mergeReleasedWithComingSoon([{ songId: "x", title: "X" }], []);
  assertEqual(out.released[0].videoId, "x", "videoId still set when comingSoon empty");
}

// --- buildSiteArtifactFromEvents: featuredRelease and released[] reflect the merge ---
{
  const songs = [
    {
      songId: "let-my-people-go",
      title: "Let My People Go",
      state: "coming_soon",
      lyrics: "Go DOWN, Moses!\nBurn through Egypt's gates,",
      artwork: "https://shieldbearerusa.com/images/signal-room/let-my-people-go.jpg"
    },
    {
      songId: "0lUJcLKIt0o",
      title: "Let My People Go",
      state: "released",
      lyrics: "",
      artwork: "",
      sourceUrl: "https://www.youtube.com/watch?v=0lUJcLKIt0o",
      publishedAt: "2026-05-02T12:40:33Z"
    }
  ];
  const out = pub.buildSiteArtifactFromEvents({ events: [], songs });
  assertEqual(out.released.length, 1, "released[] dedupes via merge");
  const fr = out.homepage.featuredRelease;
  assertEqual(fr.title, "Let My People Go", "featuredRelease title is the merged value");
  assertEqual(fr.videoId, "0lUJcLKIt0o", "featuredRelease videoId is the YouTube id");
  assertEqual(fr.songId, "let-my-people-go", "featuredRelease songId is shield-cli kebab id");
  assertEqual(fr.lyrics, "Go DOWN, Moses!\nBurn through Egypt's gates,", "featuredRelease has curated lyrics");
  assertEqual(
    fr.artwork,
    "https://shieldbearerusa.com/images/signal-room/let-my-people-go.jpg",
    "featuredRelease has curated artwork"
  );
  assert("reference" in fr, "featuredRelease carries reference field");
  assert("scripture" in fr, "featuredRelease carries scripture field");
}

// --- buildSiteArtifactFromEvents: featuredRelease carries scripture from curated record ---
{
  const songs = [
    {
      songId: "let-my-people-go",
      title: "Let My People Go",
      state: "released",
      reference: "Exodus 5:1",
      scripture: { ref: "Exodus 5:1", quote: "Let my people go..." }
    }
  ];
  const out = pub.buildSiteArtifactFromEvents({ events: [], songs });
  const fr = out.homepage.featuredRelease;
  assertEqual(fr.reference, "Exodus 5:1", "featuredRelease.reference passes through");
  assertEqual(fr.scripture.ref, "Exodus 5:1", "featuredRelease.scripture.ref passes through");
  assertEqual(fr.scripture.quote, "Let my people go...", "featuredRelease.scripture.quote passes through");
}

// --- parseAutoApproveSources: empty / malformed inputs ---
{
  assertEqual(pub.parseAutoApproveSources(""), [], "empty -> empty list");
  assertEqual(pub.parseAutoApproveSources(undefined), [], "undefined -> empty list");
  assertEqual(pub.parseAutoApproveSources(null), [], "null -> empty list");
  assertEqual(pub.parseAutoApproveSources("   "), [], "whitespace -> empty list");
}

// --- parseAutoApproveSources: comma-separated, trimmed, lowercased ---
{
  assertEqual(pub.parseAutoApproveSources("youtube"), ["youtube"], "single source");
  assertEqual(pub.parseAutoApproveSources("youtube,spotify"), ["youtube", "spotify"], "two sources");
  assertEqual(pub.parseAutoApproveSources("  YouTube , Spotify  "), ["youtube", "spotify"], "trim + lowercase");
  assertEqual(pub.parseAutoApproveSources("a,,b"), ["a", "b"], "drops empty entries");
}

// --- isCronInvocation: detects EventBridge scheduled events ---
{
  assert(
    pub.isCronInvocation({ source: "aws.events", "detail-type": "Scheduled Event" }),
    "aws.events + Scheduled Event = cron"
  );
  assert(
    !pub.isCronInvocation({ source: "aws.events" }),
    "aws.events without Scheduled Event != cron"
  );
  assert(!pub.isCronInvocation({ source: "manual" }), "manual source != cron");
  assert(!pub.isCronInvocation({}), "empty event != cron");
  assert(!pub.isCronInvocation(null), "null event != cron");
  assert(
    pub.isCronInvocation({ source: "aws.events", detailType: "Scheduled Event" }),
    "camelCase detailType also accepted"
  );
}

// --- shouldAutoApprove: cron + allowed source = approve ---
{
  const cronEvent = { source: "aws.events", "detail-type": "Scheduled Event" };
  const manualEvent = { source: "manual" };

  assert(!pub.shouldAutoApprove(manualEvent, "youtube", ["youtube"]), "manual invoke does NOT auto-approve");
  assert(!pub.shouldAutoApprove(cronEvent, "youtube", []), "empty allowlist does NOT auto-approve");
  assert(!pub.shouldAutoApprove(cronEvent, "spotify", ["youtube"]), "source not in allowlist does NOT auto-approve");
  assert(pub.shouldAutoApprove(cronEvent, "youtube", ["youtube"]), "cron + source in allowlist DOES auto-approve");
  assert(pub.shouldAutoApprove(cronEvent, "YOUTUBE", ["youtube"]), "case-insensitive source match");
  assert(!pub.shouldAutoApprove(cronEvent, "", ["youtube"]), "empty source does NOT auto-approve");
  assert(!pub.shouldAutoApprove(cronEvent, "youtube", "youtube"), "non-array allowlist does NOT auto-approve");
}

console.log("\n=========================================");
console.log(`Publisher tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
