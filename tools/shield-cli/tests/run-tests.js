const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const cliPath = path.resolve(__dirname, "../bin/shield.js");
const cases = [
  {
    name: "valid-song",
    input: "valid-song.txt",
    expect: {
      status: "processed",
      triggerMatched: true
    }
  },
  {
    name: "missing-lyrics",
    input: "missing-lyrics.txt",
    expect: {
      status: "skipped"
    }
  },
  {
    name: "no-title",
    input: "no-title.txt",
    expect: {
      status: "rejected"
    }
  },
  {
    name: "artwork-match",
    input: "valid-song-with-artwork.txt",
    expect: {
      status: "processed",
      artworkAttached: true
    }
  }
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runCase(testCase) {
  const filePath = path.join(__dirname, testCase.input);
  const result = spawnSync(process.execPath, [cliPath, "--dry-run", filePath], {
    encoding: "utf8"
  });

  assert(result.error == null, `${testCase.name}: cli execution failed`);
  assert(result.stderr.trim() === "", `${testCase.name}: expected no stderr output`);

  const stdout = result.stdout.trim();
  assert(stdout.startsWith("{") && stdout.endsWith("}"), `${testCase.name}: output was not a single JSON object`);

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${testCase.name}: output was not valid JSON`);
  }

  assert(parsed && typeof parsed === "object", `${testCase.name}: parsed output must be an object`);
  assert(parsed.status === testCase.expect.status, `${testCase.name}: expected status ${testCase.expect.status} but got ${parsed.status}`);

  for (const [key, value] of Object.entries(testCase.expect)) {
    assert(parsed[key] === value, `${testCase.name}: expected ${key}=${value} but got ${parsed[key]}`);
  }

  console.log(`PASS ${testCase.name}`);
}

try {
  for (const testCase of cases) {
    runCase(testCase);
  }
  console.log("ALL TESTS PASSED");
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
}
