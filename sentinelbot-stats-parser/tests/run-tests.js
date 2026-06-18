#!/usr/bin/env node
// Pure-function tests for the stats parser. No live AWS, no live
// Anthropic, no live GitHub. External-IO paths exercised in
// production with operator-supplied screenshots.

const pub = require("../index.js");

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

// --- intOrNull strips commas ---
assertEqual(pub.intOrNull("9,724"), 9724, "intOrNull: comma stripped");
assertEqual(pub.intOrNull("3,164"), 3164, "intOrNull: comma stripped 4-digit");
assertEqual(pub.intOrNull("17"), 17, "intOrNull: no-comma");
assertEqual(pub.intOrNull(""), null, "intOrNull: empty -> null");
assertEqual(pub.intOrNull(null), null, "intOrNull: null -> null");
assertEqual(pub.intOrNull("abc"), null, "intOrNull: non-numeric -> null");

// --- canonicalizeCountry handles The Netherlands + UAE + UK + US ---
{
  const nl = pub.canonicalizeCountry("The Netherlands");
  assert(nl && nl.code === "NL", "canonicalize: The Netherlands -> NL");
  const uae = pub.canonicalizeCountry("United Arab Emirates");
  assert(uae && uae.code === "AE", "canonicalize: UAE -> AE");
  const uk = pub.canonicalizeCountry("United Kingdom");
  assert(uk && uk.code === "GB", "canonicalize: UK -> GB");
  const us = pub.canonicalizeCountry("United States");
  assert(us && us.code === "US", "canonicalize: US -> US");
  const unknown = pub.canonicalizeCountry("Atlantis");
  assert(unknown && unknown.code === "", "canonicalize: unknown country -> empty code, name preserved");
  assertEqual(pub.canonicalizeCountry(""), null, "canonicalize: empty -> null");
}

// --- normalizeParsed: comma-stripped totals + country list ---
{
  const raw = {
    total_streams: "9,724",
    last_90: "7,411",
    last_30: "5,968",
    last_7: "1,227",
    per_country: [
      { country: "United States", streams: "3,164" },
      { country: "The Netherlands", streams: "218" },
      { country: "Atlantis", streams: 5 }
    ]
  };
  const out = pub.normalizeParsed(raw);
  assertEqual(out.total_streams, 9724, "normalize: total_streams int");
  assertEqual(out.last_90, 7411, "normalize: last_90 int");
  assertEqual(out.last_30, 5968, "normalize: last_30 int");
  assertEqual(out.last_7, 1227, "normalize: last_7 int");
  assertEqual(out.per_country.length, 3, "normalize: per_country length");
  assertEqual(out.per_country[0].code, "US", "normalize: US row code");
  assertEqual(out.per_country[1].code, "NL", "normalize: NL row code");
}

// --- normalizeParsed: omits fields not present ---
{
  const raw = { per_country: [{ country: "Germany", streams: 589 }] };
  const out = pub.normalizeParsed(raw);
  assert(!("total_streams" in out), "normalize: missing total_streams stays absent");
  assert(!("last_90" in out), "normalize: missing last_90 stays absent");
}

// --- sanityCheck: no prior record -> always ok ---
{
  const r = pub.sanityCheck({ total_streams: 100 }, null);
  assert(r.ok === true, "sanity: no prior record -> ok");
}
// --- sanityCheck: lower total rejected ---
{
  const r = pub.sanityCheck({ total_streams: 8000 }, { total_streams: 9000 });
  assert(r.ok === false && r.reason === "lower_total", "sanity: lower total rejected");
}
// --- sanityCheck: equal total accepted ---
{
  const r = pub.sanityCheck({ total_streams: 9000 }, { total_streams: 9000 });
  assert(r.ok === true, "sanity: equal total accepted");
}
// --- sanityCheck: small increase accepted ---
{
  const r = pub.sanityCheck({ total_streams: 9500 }, { total_streams: 9000 });
  assert(r.ok === true, "sanity: +500 accepted");
}
// --- sanityCheck: implausible jump rejected ---
{
  const r = pub.sanityCheck({ total_streams: 50000 }, { total_streams: 9000 });
  assert(r.ok === false && r.reason === "implausible_jump", "sanity: +41000 rejected");
}
// --- sanityCheck: missing total -> passes (parse may be country-only) ---
{
  const r = pub.sanityCheck({ per_country: [] }, { total_streams: 9000 });
  assert(r.ok === true, "sanity: missing total in country-only parse -> ok");
}

// --- mergePerCountry: new list replaces ---
{
  const cur = { per_country: [{ country: "US", code: "US", flag: "🇺🇸", streams: 100 }] };
  const last = { per_country: [{ country: "DE", code: "DE", flag: "🇩🇪", streams: 50 }] };
  const merged = pub.mergePerCountry(cur, last);
  assertEqual(merged.length, 1, "merge: new list wins length");
  assertEqual(merged[0].code, "US", "merge: new list wins content");
}
// --- mergePerCountry: empty new keeps last ---
{
  const cur = {};
  const last = { per_country: [{ country: "DE", code: "DE", flag: "🇩🇪", streams: 50 }] };
  const merged = pub.mergePerCountry(cur, last);
  assertEqual(merged.length, 1, "merge: empty new keeps last");
}
// --- mergePerCountry: both empty -> [] ---
assertEqual(pub.mergePerCountry({}, null), [], "merge: both empty -> []");

// --- preservedTotal / preservedField fall back to last published ---
{
  assertEqual(pub.preservedTotal({}, { total_streams: 9000 }), 9000, "preservedTotal: falls back");
  assertEqual(pub.preservedTotal({ total_streams: 9500 }, { total_streams: 9000 }), 9500, "preservedTotal: uses new value");
  assertEqual(pub.preservedField({}, { last_90: 7411 }, "last_90"), 7411, "preservedField: falls back");
  assertEqual(pub.preservedField({ last_90: 7500 }, { last_90: 7411 }, "last_90"), 7500, "preservedField: uses new");
}

// --- buildReachArtifact: shape + sort ---
{
  const latest = {
    parsed_at: "2026-05-24T12:00:00Z",
    total_streams: 9724,
    last_90: 7411, last_30: 5968, last_7: 1227,
    per_country: [
      { country: "France", code: "FR", flag: "🇫🇷", streams: 580 },
      { country: "United States", code: "US", flag: "🇺🇸", streams: 3164 },
      { country: "Germany", code: "DE", flag: "🇩🇪", streams: 589 }
    ]
  };
  const history = [
    { parsed_at: "2026-05-01T00:00:00Z", total_streams: 8000 },
    { parsed_at: "2026-05-24T12:00:00Z", total_streams: 9724 }
  ];
  const artifact = pub.buildReachArtifact(latest, history);
  assertEqual(artifact.total_streams, 9724, "reach: total");
  assertEqual(artifact.nations, 3, "reach: nations count");
  assertEqual(artifact.countries[0].code, "US", "reach: countries sorted desc by streams");
  assertEqual(artifact.countries[1].code, "DE", "reach: second is DE");
  assertEqual(artifact.countries[2].code, "FR", "reach: third is FR");
  assertEqual(artifact.history.length, 2, "reach: history series length");
  assertEqual(artifact.history[0].total, 8000, "reach: history oldest first");
  assert(typeof artifact.generated_at === "string", "reach: generated_at ISO string");
}

// --- mergeParses: empty / single passthrough ---
assertEqual(pub.mergeParses([]), {}, "mergeParses: empty list -> {}");
assertEqual(pub.mergeParses(null), {}, "mergeParses: null -> {}");
{
  const only = { total_streams: 9724, last_90: 7411 };
  assertEqual(pub.mergeParses([only]), only, "mergeParses: single parse passthrough");
}

// --- mergeParses: totals screen + country screen -> one combined record ---
{
  const totals = { total_streams: 9724, last_90: 7411, last_30: 5968, last_7: 1227 };
  const countries = {
    per_country: [
      { country: "United States", code: "US", flag: "🇺🇸", streams: 3164 },
      { country: "Germany", code: "DE", flag: "🇩🇪", streams: 589 }
    ]
  };
  const merged = pub.mergeParses([totals, countries]);
  assertEqual(merged.total_streams, 9724, "mergeParses: total from totals screen");
  assertEqual(merged.last_90, 7411, "mergeParses: last_90 carried");
  assertEqual(merged.last_30, 5968, "mergeParses: last_30 carried");
  assertEqual(merged.last_7, 1227, "mergeParses: last_7 carried");
  assertEqual(merged.per_country.length, 2, "mergeParses: per_country carried");
  assertEqual(merged.per_country[0].code, "US", "mergeParses: per_country US first");
}

// --- mergeParses: order independence (country first, totals second) ---
{
  const totals = { total_streams: 9724, last_90: 7411 };
  const countries = { per_country: [{ country: "United States", code: "US", flag: "🇺🇸", streams: 3164 }] };
  const merged = pub.mergeParses([countries, totals]);
  assertEqual(merged.total_streams, 9724, "mergeParses: order-independent total");
  assertEqual(merged.per_country.length, 1, "mergeParses: order-independent countries");
}

// --- mergeParses: two parses both carry total -> max wins ---
{
  const a = { total_streams: 9500 };
  const b = { total_streams: 9724 };
  const merged = pub.mergeParses([a, b]);
  assertEqual(merged.total_streams, 9724, "mergeParses: max total wins across parses");
}

// --- mergeParses: overlapping country lists union, dedupe by code, max streams ---
{
  const small = { per_country: [{ country: "United States", code: "US", flag: "🇺🇸", streams: 100 }] };
  const big = {
    per_country: [
      { country: "United States", code: "US", flag: "🇺🇸", streams: 3164 },
      { country: "Germany", code: "DE", flag: "🇩🇪", streams: 589 },
      { country: "France", code: "FR", flag: "🇫🇷", streams: 580 }
    ]
  };
  const merged = pub.mergeParses([small, big]);
  assertEqual(merged.per_country.length, 3, "mergeParses: overlapping lists deduped to 3 unique countries");
  const us = merged.per_country.find((c) => c.code === "US");
  assertEqual(us.streams, 3164, "mergeParses: overlapping US row keeps max streams");
}

// --- mergeParses: only country screen -> total omitted (preservedField will fall back to last published) ---
{
  const countries = { per_country: [{ country: "Germany", code: "DE", flag: "🇩🇪", streams: 589 }] };
  const merged = pub.mergeParses([countries]);
  assert(!("total_streams" in merged), "mergeParses: country-only parse leaves total absent");
}

// --- normalizeEnvelope: handles tagged envelopes correctly ---
{
  const totals = pub.normalizeEnvelope({
    type: "distrokid_totals",
    data: { total_streams: "9,724", last_90: "7,411" }
  });
  assertEqual(totals.type, "distrokid_totals", "envelope: type preserved for totals");
  assertEqual(totals.data.total_streams, 9724, "envelope: totals normalized");
  assertEqual(totals.data.last_90, 7411, "envelope: last_90 normalized");

  const countries = pub.normalizeEnvelope({
    type: "distrokid_countries",
    data: { per_country: [{ country: "United States", streams: "3,164" }] }
  });
  assertEqual(countries.type, "distrokid_countries", "envelope: type preserved for countries");
  assertEqual(countries.data.per_country[0].code, "US", "envelope: country code mapped");

  const songs = pub.normalizeEnvelope({
    type: "spotify_songs",
    data: { songs: [{ title: "Silent As Night", streams: "4,270" }, { title: "Quake", streams: "897" }] }
  });
  assertEqual(songs.type, "spotify_songs", "envelope: type preserved for songs");
  assertEqual(songs.data.songs.length, 2, "envelope: songs count");
  assertEqual(songs.data.songs[0].streams, 4270, "envelope: song streams int");

  const unknown = pub.normalizeEnvelope({ type: "unknown", data: {} });
  assertEqual(unknown.type, "unknown", "envelope: unknown stays unknown");
}

// --- normalizeEnvelope: infers type from flat (untagged) shape ---
{
  const flat = pub.normalizeEnvelope({ total_streams: "9,724" });
  assertEqual(flat.type, "distrokid_totals", "envelope: flat with total_streams -> totals");

  const flatSongs = pub.normalizeEnvelope({ songs: [{ title: "Quake", streams: 100 }] });
  assertEqual(flatSongs.type, "spotify_songs", "envelope: flat with songs -> spotify");
}

// --- normalizeSpotifyData: rejects invalid rows ---
{
  const out = pub.normalizeSpotifyData({
    songs: [
      { title: "Quake", streams: 897 },
      { title: "", streams: 100 },
      { title: "1000 Suns", streams: "737" },
      { title: "Empty", streams: 0 },
      { title: "Bad", streams: "abc" }
    ]
  });
  assertEqual(out.songs.length, 2, "normalizeSpotify: drops empty title, zero, non-numeric");
  assertEqual(out.songs[0].streams, 897, "normalizeSpotify: first kept");
  assertEqual(out.songs[1].streams, 737, "normalizeSpotify: comma stripped");
}

// --- mergeSpotifyParses: empty / single passthrough ---
assertEqual(pub.mergeSpotifyParses([]), null, "mergeSpotify: empty list -> null");
assertEqual(pub.mergeSpotifyParses(null), null, "mergeSpotify: null -> null");
{
  const only = { songs: [{ title: "Quake", streams: 100 }] };
  const merged = pub.mergeSpotifyParses([only]);
  assertEqual(merged.songs.length, 1, "mergeSpotify: single passthrough length");
  assertEqual(merged.songs[0].streams, 100, "mergeSpotify: single passthrough value");
}

// --- mergeSpotifyParses: take MAX for duplicate titles, union otherwise ---
{
  const a = { songs: [{ title: "Quake", streams: 800 }, { title: "1000 Suns", streams: 737 }] };
  const b = { songs: [{ title: "Quake", streams: 897 }, { title: "Sentinels", streams: 503 }] };
  const merged = pub.mergeSpotifyParses([a, b]);
  assertEqual(merged.songs.length, 3, "mergeSpotify: union of unique titles");
  const quake = merged.songs.find((s) => s.title === "Quake");
  assertEqual(quake.streams, 897, "mergeSpotify: max count for duplicate title");
  // Should be sorted desc by streams
  assertEqual(merged.songs[0].title, "Quake", "mergeSpotify: sorted desc -- Quake first");
  assertEqual(merged.songs[1].title, "1000 Suns", "mergeSpotify: sorted desc -- 1000 Suns second");
  assertEqual(merged.songs[2].title, "Sentinels", "mergeSpotify: sorted desc -- Sentinels third");
}

// --- sanityCheckSpotify: no prior -> ok ---
{
  const r = pub.sanityCheckSpotify({ songs: [{ title: "Q", streams: 100 }] }, null);
  assert(r.ok === true, "sanitySpotify: no prior -> ok");
}

// --- sanityCheckSpotify: empty parse rejected ---
{
  const r = pub.sanityCheckSpotify({ songs: [] }, { songs: [{ title: "Q", streams: 100 }] });
  assert(r.ok === false && r.reason === "empty_parse", "sanitySpotify: empty parse rejected");
}

// --- sanityCheckSpotify: known song dropped -> rejected ---
{
  const prev = { songs: [{ title: "Quake", streams: 800 }, { title: "1000 Suns", streams: 700 }] };
  const cur = { songs: [{ title: "Quake", streams: 750 }, { title: "1000 Suns", streams: 737 }] };
  const r = pub.sanityCheckSpotify(cur, prev);
  assert(r.ok === false && r.reason === "song_dropped", "sanitySpotify: dropped song rejected");
}

// --- sanityCheckSpotify: equal or higher -> ok ---
{
  const prev = { songs: [{ title: "Quake", streams: 800 }] };
  const cur = { songs: [{ title: "Quake", streams: 897 }] };
  const r = pub.sanityCheckSpotify(cur, prev);
  assert(r.ok === true, "sanitySpotify: increase accepted");
  const eq = pub.sanityCheckSpotify({ songs: [{ title: "Quake", streams: 800 }] }, prev);
  assert(eq.ok === true, "sanitySpotify: equal accepted");
}

// --- sanityCheckSpotify: new song appears -> ok (first appearance always accepted) ---
{
  const prev = { songs: [{ title: "Quake", streams: 800 }] };
  const cur = { songs: [{ title: "Quake", streams: 897 }, { title: "Ruach", streams: 378 }] };
  const r = pub.sanityCheckSpotify(cur, prev);
  assert(r.ok === true, "sanitySpotify: new song accepted");
}

// --- buildSpotifyArtifact: shape + sort + totals ---
{
  const rec = {
    parsed_at: "2026-05-24T18:00:00Z",
    songs: [
      { title: "Quake", streams: 897 },
      { title: "Silent As Night", streams: 4270 },
      { title: "1000 Suns", streams: 737 }
    ]
  };
  const a = pub.buildSpotifyArtifact(rec);
  assertEqual(a.source, "Spotify for Artists", "spotifyArtifact: source label");
  assertEqual(a.track_count, 3, "spotifyArtifact: track_count");
  assertEqual(a.total_spotify_streams, 897 + 4270 + 737, "spotifyArtifact: sum");
  assertEqual(a.songs[0].title, "Silent As Night", "spotifyArtifact: sorted desc -- top track first");
  assertEqual(a.last_published_at, "2026-05-24T18:00:00Z", "spotifyArtifact: last_published_at carried");
}

// --- spotify_songs_28d envelope normalization ---
{
  const e = pub.normalizeEnvelope({
    type: "spotify_songs_28d",
    data: { songs: [{ title: "Quake", streams: 80 }, { title: "Sentinels", streams: 55 }] }
  });
  assertEqual(e.type, "spotify_songs_28d", "envelope: 28d type preserved");
  assertEqual(e.data.songs.length, 2, "envelope: 28d songs normalized");
  assertEqual(e.data.songs[0].streams, 80, "envelope: 28d streams retained");
}

// --- buildSpotify28dArtifact: window tag + total field + sort ---
{
  const rec = {
    parsed_at: "2026-05-27T20:00:00Z",
    songs: [
      { title: "Silent As Night", streams: 312 },
      { title: "Quake", streams: 80 },
      { title: "Sentinels", streams: 55 }
    ]
  };
  const a = pub.buildSpotify28dArtifact(rec);
  assertEqual(a.source, "Spotify for Artists", "spotify28dArtifact: source label");
  assertEqual(a.window, "28d", "spotify28dArtifact: window tagged 28d");
  assertEqual(a.track_count, 3, "spotify28dArtifact: track_count");
  assertEqual(a.total_spotify_streams_28d, 312 + 80 + 55, "spotify28dArtifact: 28d total uses 28d-suffixed key");
  assertEqual(a.songs[0].title, "Silent As Night", "spotify28dArtifact: sorted desc");
  assertEqual(a.last_published_at, "2026-05-27T20:00:00Z", "spotify28dArtifact: last_published_at carried");
  // The lifetime artifact must NOT carry the 28d-only field name.
  const a2 = pub.buildSpotifyArtifact(rec);
  assert(a2.total_spotify_streams != null, "spotifyArtifact: lifetime uses total_spotify_streams");
  assert(a2.total_spotify_streams_28d == null, "spotifyArtifact: lifetime does NOT use 28d-suffixed key");
  assertEqual(a2.window, "all-time", "spotifyArtifact: lifetime tagged all-time");
}

// --- 28d and lifetime do not cross-pollute via normalizeByType ---
{
  const liveLife = pub.normalizeEnvelope({
    type: "spotify_songs",
    data: { songs: [{ title: "X", streams: 1000 }] }
  });
  const live28d = pub.normalizeEnvelope({
    type: "spotify_songs_28d",
    data: { songs: [{ title: "X", streams: 12 }] }
  });
  assertEqual(liveLife.type, "spotify_songs", "envelope: lifetime type preserved");
  assertEqual(live28d.type, "spotify_songs_28d", "envelope: 28d type preserved");
  assertEqual(liveLife.data.songs[0].streams, 1000, "envelope: lifetime streams isolated");
  assertEqual(live28d.data.songs[0].streams, 12, "envelope: 28d streams isolated");
}

// --- canonicalizeSpotifyWindow: maps variants and defaults to all-time ---
{
  assertEqual(pub.canonicalizeSpotifyWindow("all-time"), "all-time", "spotifyWindow: all-time passes through");
  assertEqual(pub.canonicalizeSpotifyWindow("All-time"), "all-time", "spotifyWindow: capitalization normalized");
  assertEqual(pub.canonicalizeSpotifyWindow("last-12-months"), "last-12-months", "spotifyWindow: last-12-months passes through");
  assertEqual(pub.canonicalizeSpotifyWindow("Last 12 months"), "last-12-months", "spotifyWindow: spaces normalized");
  assertEqual(pub.canonicalizeSpotifyWindow("12 months"), "last-12-months", "spotifyWindow: '12 months' variant");
  assertEqual(pub.canonicalizeSpotifyWindow("Past 12 months"), "last-12-months", "spotifyWindow: 'past 12 months' variant");
  assertEqual(pub.canonicalizeSpotifyWindow(""), "all-time", "spotifyWindow: empty defaults to all-time");
  assertEqual(pub.canonicalizeSpotifyWindow(null), "all-time", "spotifyWindow: null defaults to all-time");
  assertEqual(pub.canonicalizeSpotifyWindow("garbage"), "all-time", "spotifyWindow: unknown defaults to all-time");
}

// --- normalizeSpotifyData carries window (defaults to all-time) ---
{
  const a = pub.normalizeSpotifyData({ songs: [{ title: "Q", streams: 100 }] });
  assertEqual(a.window, "all-time", "normalizeSpotify: missing window defaults to all-time");
  const b = pub.normalizeSpotifyData({ window: "last-12-months", songs: [{ title: "Q", streams: 100 }] });
  assertEqual(b.window, "last-12-months", "normalizeSpotify: last-12-months preserved");
  const c = pub.normalizeSpotifyData({ window: "Last 12 months", songs: [{ title: "Q", streams: 100 }] });
  assertEqual(c.window, "last-12-months", "normalizeSpotify: human-readable window canonicalized");
}

// --- mergeSpotifyParses propagates window (12m wins if any parse carries it) ---
{
  const a = { window: "all-time", songs: [{ title: "Q", streams: 100 }] };
  const b = { window: "all-time", songs: [{ title: "R", streams: 50 }] };
  const both = pub.mergeSpotifyParses([a, b]);
  assertEqual(both.window, "all-time", "mergeSpotify: all parses all-time -> all-time");

  const c = { window: "last-12-months", songs: [{ title: "Q", streams: 800 }] };
  const d = { window: "last-12-months", songs: [{ title: "R", streams: 60 }] };
  const twelve = pub.mergeSpotifyParses([c, d]);
  assertEqual(twelve.window, "last-12-months", "mergeSpotify: all parses 12m -> 12m");

  const mixed = pub.mergeSpotifyParses([a, c]);
  assertEqual(mixed.window, "last-12-months", "mergeSpotify: mixed picks 12m (the non-default)");
}

// --- buildSpotifyArtifact reads window from record (legacy = all-time) ---
{
  const legacy = pub.buildSpotifyArtifact({
    parsed_at: "2026-05-24T18:00:00Z",
    songs: [{ title: "Q", streams: 800 }]
  });
  assertEqual(legacy.window, "all-time", "spotifyArtifact: legacy record without window -> all-time");

  const twelve = pub.buildSpotifyArtifact({
    parsed_at: "2026-06-06T12:00:00Z",
    window: "last-12-months",
    songs: [{ title: "Silent As Night", streams: 4562 }]
  });
  assertEqual(twelve.window, "last-12-months", "spotifyArtifact: 12m record -> 12m");
  assertEqual(twelve.total_spotify_streams, 4562, "spotifyArtifact: 12m total uses lifetime field name (frontend reads same key)");
}

// --- envelope round-trip: Last 12 months screenshot end-to-end ---
{
  const env = pub.normalizeEnvelope({
    type: "spotify_songs",
    data: {
      window: "Last 12 months",
      songs: [{ title: "Silent As Night", streams: 4562 }, { title: "Quake", streams: 720 }]
    }
  });
  assertEqual(env.type, "spotify_songs", "12m envelope: routes to spotify_songs (same artifact file)");
  assertEqual(env.data.window, "last-12-months", "12m envelope: window canonicalized");
  const merged = pub.mergeSpotifyParses([env.data]);
  const artifact = pub.buildSpotifyArtifact({ parsed_at: "2026-06-06T12:00:00Z", ...merged });
  assertEqual(artifact.window, "last-12-months", "12m envelope: artifact tagged last-12-months");
  assertEqual(artifact.songs[0].title, "Silent As Night", "12m envelope: songs sorted desc");
}

// --- multi-screenshot country list: two country screens cover different
//     slices of one long list and get concatenated, not overwritten ---
{
  const screenA = {
    per_country: [
      { country: "United States", code: "US", flag: "🇺🇸", streams: 3164 },
      { country: "Germany", code: "DE", flag: "🇩🇪", streams: 589 },
      { country: "France", code: "FR", flag: "🇫🇷", streams: 580 }
    ]
  };
  const screenB = {
    per_country: [
      { country: "Canada", code: "CA", flag: "🇨🇦", streams: 240 },
      { country: "Sweden", code: "SE", flag: "🇸🇪", streams: 188 },
      { country: "Japan", code: "JP", flag: "🇯🇵", streams: 91 }
    ]
  };
  const merged = pub.mergeParses([screenA, screenB]);
  assertEqual(merged.per_country.length, 6, "multi-screen countries: two slices concatenated into 6 rows");
  const codes = merged.per_country.map((c) => c.code);
  assert(codes.indexOf("US") >= 0 && codes.indexOf("JP") >= 0, "multi-screen countries: rows from both screens present");
}

// --- multi-screenshot country list with totals screen + scroll overlap:
//     5 screens (totals + 3 country slices with one overlap + dup) merge
//     into one record with the full deduped country list ---
{
  const totals = { total_streams: 12000, last_90: 9000, last_30: 6000, last_7: 1500 };
  const c1 = { per_country: [
    { country: "United States", code: "US", flag: "🇺🇸", streams: 5000 },
    { country: "United Kingdom", code: "GB", flag: "🇬🇧", streams: 1200 }
  ] };
  const c2 = { per_country: [
    { country: "United Kingdom", code: "GB", flag: "🇬🇧", streams: 1200 }, // overlap row at scroll boundary
    { country: "Germany", code: "DE", flag: "🇩🇪", streams: 900 }
  ] };
  const c3 = { per_country: [
    { country: "Brazil", code: "BR", flag: "🇧🇷", streams: 410 },
    { country: "India", code: "IN", flag: "🇮🇳", streams: 300 }
  ] };
  const merged = pub.mergeParses([totals, c1, c2, c3]);
  assertEqual(merged.total_streams, 12000, "5-screen merge: totals carried from totals screen");
  assertEqual(merged.per_country.length, 5, "5-screen merge: overlapping GB row deduped, 5 unique countries");
  const gb = merged.per_country.find((c) => c.code === "GB");
  assertEqual(gb.streams, 1200, "5-screen merge: deduped GB keeps a single row");
}

// --- mergePerCountryRows: unmapped country (empty code) deduped by name ---
{
  const a = { per_country: [{ country: "Atlantis", code: "", flag: "", streams: 5 }] };
  const b = { per_country: [{ country: "Atlantis", code: "", flag: "", streams: 8 }] };
  const rows = pub.mergePerCountryRows([a, b]);
  assertEqual(rows.length, 1, "mergePerCountryRows: unmapped country deduped by name");
  assertEqual(rows[0].streams, 8, "mergePerCountryRows: unmapped country keeps max streams");
}

// --- SANITY_CEILING export sanity (default 2500 unless env overrides) ---
assert(typeof pub.SANITY_CEILING === "number" && pub.SANITY_CEILING >= 100, "SANITY_CEILING is a positive number");

console.log("\n=========================================");
console.log(`Stats-parser tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
