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

// --- mergeParses: longer per_country list wins ---
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
  assertEqual(merged.per_country.length, 3, "mergeParses: longer per_country list wins");
}

// --- mergeParses: only country screen -> total omitted (preservedField will fall back to last published) ---
{
  const countries = { per_country: [{ country: "Germany", code: "DE", flag: "🇩🇪", streams: 589 }] };
  const merged = pub.mergeParses([countries]);
  assert(!("total_streams" in merged), "mergeParses: country-only parse leaves total absent");
}

// --- SANITY_CEILING export sanity (default 2500 unless env overrides) ---
assert(typeof pub.SANITY_CEILING === "number" && pub.SANITY_CEILING >= 100, "SANITY_CEILING is a positive number");

console.log("\n=========================================");
console.log(`Stats-parser tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
