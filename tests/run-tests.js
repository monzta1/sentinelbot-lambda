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

console.log("\n=========================================");
console.log(`SentinelBot tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
