#!/usr/bin/env node
/**
 * Pure-function tests for the metrics publisher. No GA4, no GitHub,
 * no Secrets Manager. External-IO paths are exercised in production.
 */

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

// --- getCurrentPeriod: builds calendar-month-so-far range ---
{
  const now = new Date(Date.UTC(2026, 4, 21, 12, 0, 0)); // May 21, 2026 UTC
  const period = pub.getCurrentPeriod(now);
  assertEqual(period.start, "2026-05-01", "current period starts on first of month");
  assertEqual(period.end, "2026-05-31", "current period ends on last day of month");
  assert(period.label.includes("May 2026"), "current period label carries month + year");
  assert(period.label.includes("so far"), "current period label flagged as in-progress");
}

// --- getCurrentPeriod: end-of-year boundary ---
{
  const now = new Date(Date.UTC(2026, 11, 31, 23, 59, 59)); // Dec 31
  const period = pub.getCurrentPeriod(now);
  assertEqual(period.start, "2026-12-01", "December current start");
  assertEqual(period.end, "2026-12-31", "December current end");
}

// --- getPreviousPeriod: full prior month ---
{
  const now = new Date(Date.UTC(2026, 4, 21, 12, 0, 0));
  const period = pub.getPreviousPeriod(now);
  assertEqual(period.start, "2026-04-01", "previous period start");
  assertEqual(period.end, "2026-04-30", "previous period end (April has 30 days)");
  assert(period.label.includes("April 2026"), "previous period label");
  assert(!period.label.includes("so far"), "previous period not flagged in-progress");
}

// --- getPreviousPeriod: January rolls back to prior year ---
{
  const now = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
  const period = pub.getPreviousPeriod(now);
  assertEqual(period.start, "2025-12-01", "January previous start rolls to prior year");
  assertEqual(period.end, "2025-12-31", "January previous end");
  assert(period.label.includes("December 2025"), "previous label rolls to prior year");
}

// --- computeDeltaPct ---
{
  assertEqual(pub.computeDeltaPct(120, 100), 20, "120 vs 100 = +20%");
  assertEqual(pub.computeDeltaPct(80, 100), -20, "80 vs 100 = -20%");
  assertEqual(pub.computeDeltaPct(100, 100), 0, "100 vs 100 = 0%");
  assert(pub.computeDeltaPct(100, 0) === null, "previous=0 returns null (avoid div by zero)");
  assert(pub.computeDeltaPct(100, null) === null, "previous=null returns null");
  assertEqual(pub.computeDeltaPct(135, 100), 35, "exact 35%");
  assertEqual(pub.computeDeltaPct(133, 100), 33, "rounds to 1 decimal");
  assertEqual(pub.computeDeltaPct(1333, 1000), 33.3, "33.3% preserved");
}

// --- sumRowMetric ---
{
  const report = {
    rows: [
      { metricValues: [{ value: "100" }] },
      { metricValues: [{ value: "50" }] },
      { metricValues: [{ value: "25" }] }
    ]
  };
  assertEqual(pub.sumRowMetric(report, 0), 175, "sumRowMetric totals string-typed values");
  assertEqual(pub.sumRowMetric({ rows: [] }, 0), 0, "empty rows -> 0");
  assertEqual(pub.sumRowMetric({}, 0), 0, "missing rows -> 0");
  assertEqual(pub.sumRowMetric(null, 0), 0, "null report -> 0");
}

// --- sumRowMetric: skips non-finite values ---
{
  const report = {
    rows: [
      { metricValues: [{ value: "100" }] },
      { metricValues: [{ value: "abc" }] },
      { metricValues: [{ value: "" }] },
      { metricValues: [{ value: "50" }] }
    ]
  };
  assertEqual(pub.sumRowMetric(report, 0), 150, "non-numeric values skipped");
}

// --- buildMetricsArtifact: emits the documented schema ---
{
  const period = { label: "May 2026 so far", start: "2026-05-01", end: "2026-05-31" };
  const headline = { sessions: 1234, deltaPct: 12.4, comparison: "vs April 2026" };
  const channels = [{ name: "Organic", sessions: 500, share: 40.5 }];
  const geography = [{ name: "United States", sessions: 800, share: 64.8 }];
  const cities = [{ name: "Ashburn, Virginia", sessions: 120, share: 9.7 }];
  const events = [{ name: "watch_now", count: 100, engagedShare: null }];
  const shipped = [{ date: "2026-05-01", label: "Thing" }];
  const artifact = pub.buildMetricsArtifact({ headline, channels, geography, cities, events, shipped, period });

  assert("generatedAt" in artifact, "artifact has generatedAt");
  assertEqual(artifact.period, period, "period passes through");
  assertEqual(artifact.headline, headline, "headline passes through");
  assertEqual(artifact.channels, channels, "channels pass through");
  assertEqual(artifact.geography, geography, "geography passes through");
  assertEqual(artifact.cities, cities, "cities pass through");
  assertEqual(artifact.events, events, "events pass through");
  assertEqual(artifact.shipped, shipped, "shipped passes through");
  assertEqual(artifact.source, "ga4-data-api", "source tagged ga4-data-api");
  assert(typeof artifact.note === "string" && artifact.note.length > 0, "note is non-empty string");
}

// --- buildMetricsArtifact: geography defaults to [] when omitted ---
{
  const period = { label: "May 2026 so far", start: "2026-05-01", end: "2026-05-31" };
  const artifact = pub.buildMetricsArtifact({
    headline: { sessions: 1 }, channels: [], events: [], shipped: [], period
  });
  assertEqual(artifact.geography, [], "geography defaults to [] when omitted");
  assertEqual(artifact.cities, [], "cities defaults to [] when omitted");
}

// --- buildCanonicalMetricsArtifact: ends with newline, valid JSON ---
{
  const artifact = { a: 1, b: [2, 3] };
  const out = pub.buildCanonicalMetricsArtifact(artifact);
  assert(out.endsWith("\n"), "canonical artifact ends with newline");
  const parsed = JSON.parse(out);
  assertEqual(parsed, artifact, "canonical artifact round-trips through JSON");
}

// --- encodeContent / decodeContent: base64 round-trip ---
{
  const original = "Hello, world!\nLine 2.\n";
  const encoded = pub.encodeContent(original);
  assertEqual(pub.decodeContent(encoded), original, "base64 round-trip preserves content");
}

// --- hashContent: stable sha256 ---
{
  const h1 = pub.hashContent("test content");
  const h2 = pub.hashContent("test content");
  const h3 = pub.hashContent("different content");
  assertEqual(h1, h2, "same input -> same hash");
  assert(h1 !== h3, "different input -> different hash");
  assert(/^[a-f0-9]{64}$/.test(h1), "hash is 64 hex chars (sha256)");
}

// --- buildGitHubContentsUrl: encodes path segments ---
{
  // Set globals via env vars temporarily not viable, function reads
  // them at module load. Just verify the function produces a URL
  // with the metrics.json path embedded.
  const url = pub.buildGitHubContentsUrl("metrics.json");
  assert(url.includes("/contents/metrics.json"), "URL carries path");
  assert(url.startsWith("https://api.github.com/"), "URL is GitHub API");
}

// --- buildGitHubContentsUrl: nested path segments encoded ---
{
  const url = pub.buildGitHubContentsUrl("path/with spaces/file.json");
  assert(url.includes("/contents/path/with%20spaces/file.json"), "URL encodes spaces in segments");
}

console.log("\n=========================================");
console.log(`Metrics-publisher tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
