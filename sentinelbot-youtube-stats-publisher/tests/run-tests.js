#!/usr/bin/env node
// Pure-function tests for youtube-stats-publisher. No live AWS,
// no live Google APIs, no GitHub. The external-IO paths are
// exercised in production.

const pub = require("../index.js");

let passed = 0, failed = 0;
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

// --- daysAgo: produces YYYY-MM-DD relative to a reference date ---
{
  const ref = new Date("2026-05-24T17:00:00Z");
  assertEqual(pub.daysAgo(0, ref), "2026-05-24", "daysAgo: 0 -> today");
  assertEqual(pub.daysAgo(7, ref), "2026-05-17", "daysAgo: 7 -> a week back");
  assertEqual(pub.daysAgo(30, ref), "2026-04-24", "daysAgo: 30 -> a month back");
  assertEqual(pub.daysAgo(2, ref), "2026-05-22", "daysAgo: 2 -> 48h back");
}

// --- buildDateWindows: returns last48h, last7, last30 keyed correctly ---
{
  const ref = new Date("2026-05-24T17:00:00Z");
  const w = pub.buildDateWindows(ref);
  assertEqual(w.last48h.start, "2026-05-22", "windows: last48h start");
  assertEqual(w.last48h.end, "2026-05-24", "windows: last48h end");
  assertEqual(w.last7.start, "2026-05-17", "windows: last7 start");
  assertEqual(w.last30.start, "2026-04-24", "windows: last30 start");
  // All windows share the same end (today)
  assertEqual(w.last48h.end, w.last7.end, "windows: all ends match");
  assertEqual(w.last7.end, w.last30.end, "windows: all ends match");
}

// --- decorateCountry: known codes get name + flag ---
{
  const us = pub.decorateCountry("US");
  assert(us.code === "US" && us.name === "United States" && us.flag === "🇺🇸", "decorate: US full lookup");
  const nl = pub.decorateCountry("nl");  // lowercase -> upper-cased + matched
  assert(nl.code === "NL" && nl.name === "The Netherlands", "decorate: lowercase normalized");
  const xx = pub.decorateCountry("XX"); // unknown
  assert(xx.code === "XX" && xx.name === "XX" && xx.flag === "", "decorate: unknown passes through bare");
  const empty = pub.decorateCountry("");
  assert(empty.code === "" && empty.name === "Unknown", "decorate: empty -> Unknown");
}

// --- firstRowMetric: pulls a row index from analytics report shape ---
{
  const report = { rows: [[100, 200, 30]] };
  assertEqual(pub.firstRowMetric(report, 0), 100, "firstRowMetric: index 0");
  assertEqual(pub.firstRowMetric(report, 1), 200, "firstRowMetric: index 1");
  assertEqual(pub.firstRowMetric(report, 2), 30, "firstRowMetric: index 2");
  assertEqual(pub.firstRowMetric({ rows: [] }, 0), 0, "firstRowMetric: empty rows -> 0");
  assertEqual(pub.firstRowMetric({}, 0), 0, "firstRowMetric: no rows key -> 0");
  assertEqual(pub.firstRowMetric(null, 0), 0, "firstRowMetric: null -> 0");
}

// --- buildYouTubeArtifact: shape + nesting ---
{
  const artifact = pub.buildYouTubeArtifact({
    channel: {
      channelId: "UCgL4mzUUcYtqxx-0IdjoqIw",
      title: "Shieldbearer",
      handle: "@shieldbearerusa",
      channelUrl: "https://www.youtube.com/channel/UCgL4mzUUcYtqxx-0IdjoqIw",
      publishedAt: "2025-04-14T03:40:06.969878Z",
      thumbnail: "https://yt3.ggpht.com/...",
      viewsLifetime: 1234,
      subscribers: 56,
      subscribersHidden: false,
      videoCount: 17
    },
    windows: {
      last_48h: { start: "2026-05-22", end: "2026-05-24" },
      last_7: { start: "2026-05-17", end: "2026-05-24" },
      last_30: { start: "2026-04-24", end: "2026-05-24" }
    },
    watch: {
      last7: { views: 10, watchMinutes: 18, avgViewDurationSec: 60 },
      last30: { views: 138, watchMinutes: 250, avgViewDurationSec: 75 }
    },
    top48: [{ code: "US", name: "United States", flag: "🇺🇸", views: 10 }],
    top30: [{ code: "US", name: "United States", flag: "🇺🇸", views: 138 }],
    topVideos: [{ videoId: "abc", title: "Sentinels", views: 500, url: "https://www.youtube.com/watch?v=abc" }]
  });
  assertEqual(artifact.source, "YouTube", "artifact: source labeled YouTube");
  assertEqual(artifact.channel.title, "Shieldbearer", "artifact: channel title");
  assertEqual(artifact.channel.views_lifetime, 1234, "artifact: views_lifetime");
  assertEqual(artifact.channel.subscribers, 56, "artifact: subscribers");
  assertEqual(artifact.watch_time.last_7.views, 10, "artifact: last_7 views nested");
  assertEqual(artifact.last_48h_countries.length, 1, "artifact: last_48h countries length");
  assertEqual(artifact.last_30d_countries[0].name, "United States", "artifact: last_30d country name");
  assertEqual(artifact.top_videos[0].videoId, "abc", "artifact: top video id");
  assert(typeof artifact.generated_at === "string" && artifact.generated_at.endsWith("Z"), "artifact: generated_at ISO");
}

// --- buildCanonicalArtifact: stable JSON + trailing newline ---
{
  const s = pub.buildCanonicalArtifact({ a: 1, b: 2 });
  assert(s.endsWith("\n"), "canonical: trailing newline");
  assertEqual(JSON.parse(s), { a: 1, b: 2 }, "canonical: roundtrips through JSON.parse");
}

// --- hashContent: deterministic + sensitive to content ---
{
  const a = pub.hashContent("hello");
  const b = pub.hashContent("hello");
  const c = pub.hashContent("world");
  assertEqual(a, b, "hash: deterministic");
  assert(a !== c, "hash: differs when content differs");
  assert(a.length === 64, "hash: sha256 hex length");
}

// --- labelForTrafficSource: known codes get friendly labels ---
{
  assertEqual(pub.labelForTrafficSource("YT_SEARCH"), "YouTube search", "trafficLabel: YT_SEARCH");
  assertEqual(pub.labelForTrafficSource("SUGGESTED_VIDEO"), "Suggested next", "trafficLabel: SUGGESTED_VIDEO");
  assertEqual(pub.labelForTrafficSource("EXTERNAL"), "Outside YouTube", "trafficLabel: EXTERNAL");
  assertEqual(pub.labelForTrafficSource("YT_CHANNEL"), "Channel page", "trafficLabel: YT_CHANNEL");
  assertEqual(pub.labelForTrafficSource("BROWSE"), "Home feed", "trafficLabel: BROWSE");
  assertEqual(pub.labelForTrafficSource("DIRECT_OR_UNKNOWN"), "Direct or unknown", "trafficLabel: DIRECT_OR_UNKNOWN");
  // Unknown code falls back to lowercased / underscore-stripped
  assertEqual(pub.labelForTrafficSource("SOME_NEW_TYPE"), "some new type", "trafficLabel: unknown -> fallback");
  // Lowercase input still hits the upper-case table
  assertEqual(pub.labelForTrafficSource("yt_search"), "YouTube search", "trafficLabel: lowercase input normalized");
  // Empty / nullish
  assertEqual(pub.labelForTrafficSource(""), "", "trafficLabel: empty -> empty");
  assertEqual(pub.labelForTrafficSource(null), "", "trafficLabel: null -> empty");
}

// --- TRAFFIC_SOURCE_LABELS table sanity ---
{
  assert(typeof pub.TRAFFIC_SOURCE_LABELS === "object", "TRAFFIC_SOURCE_LABELS exported as object");
  assert(Object.keys(pub.TRAFFIC_SOURCE_LABELS).length >= 10, "TRAFFIC_SOURCE_LABELS has at least 10 codes");
}

// --- buildYouTubeArtifact: new fields land at expected paths ---
{
  const artifact = pub.buildYouTubeArtifact({
    channel: {
      channelId: "X", title: "T", handle: "@t", channelUrl: "u",
      publishedAt: "p", thumbnail: null, viewsLifetime: 1, subscribers: 1,
      subscribersHidden: false, videoCount: 1
    },
    windows: {
      last_48h: { start: "a", end: "b" },
      last_7: { start: "c", end: "d" },
      last_30: { start: "e", end: "f" }
    },
    watch: { last7: {}, last30: {} },
    top48: [],
    top30: [],
    topVideos: [],
    topVideos30d: [{ videoId: "v1", title: "Surge top", views: 100, url: "u1" }],
    dailyViews: [{ date: "2026-05-20", views: 10, minutes: 30 }],
    trafficSources: [{ source: "YT_SEARCH", label: "YouTube search", views: 50 }]
  });
  assertEqual(artifact.top_videos_30d.length, 1, "artifact: top_videos_30d carried");
  assertEqual(artifact.top_videos_30d[0].videoId, "v1", "artifact: top_videos_30d shape");
  assertEqual(artifact.daily_views.length, 1, "artifact: daily_views carried");
  assertEqual(artifact.daily_views[0].views, 10, "artifact: daily_views shape");
  assertEqual(artifact.traffic_sources_30d.length, 1, "artifact: traffic_sources_30d carried");
  assertEqual(artifact.traffic_sources_30d[0].label, "YouTube search", "artifact: traffic_sources_30d label");
}

// --- buildYouTubeArtifact: missing optional fields default to [] ---
{
  const artifact = pub.buildYouTubeArtifact({
    channel: { channelId: "X", title: "T", handle: "@t", channelUrl: "u", publishedAt: "p", thumbnail: null, viewsLifetime: 1, subscribers: 1, subscribersHidden: false, videoCount: 1 },
    windows: { last_48h: {}, last_7: {}, last_30: {} },
    watch: { last7: {}, last30: {} },
    top48: [], top30: [], topVideos: []
  });
  assertEqual(artifact.top_videos_30d, [], "artifact: missing top_videos_30d defaults to []");
  assertEqual(artifact.daily_views, [], "artifact: missing daily_views defaults to []");
  assertEqual(artifact.traffic_sources_30d, [], "artifact: missing traffic_sources_30d defaults to []");
}

console.log("\n=========================================");
console.log(`YouTube-stats-publisher tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
