const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const cliPath = path.resolve(__dirname, "../bin/shield.js");
const fixturesDir = __dirname;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runCli(filePath, env = {}) {
  return spawnSync(process.execPath, [cliPath, "ingest", filePath], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });
}

function runCliWithArgs(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });
}

function loadEvents(eventFile) {
  if (!fs.existsSync(eventFile)) {
    return [];
  }
  const raw = fs.readFileSync(eventFile, "utf8");
  return JSON.parse(raw);
}

function parseJson(stdout, caseName) {
  const output = stdout.trim();
  assert(output.startsWith("{") && output.endsWith("}"), `${caseName}: output was not a single JSON object`);

  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${caseName}: output was not valid JSON`);
  }
}

function runIdempotencySuite() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shield-cli-"));
  const stateFile = path.join(workspace, "state.json");
  const eventFile = path.join(workspace, "events.json");
  const sourceFile = path.join(fixturesDir, "valid-song-with-artwork.txt");
  const artworkFile = path.join(fixturesDir, "valid-song-with-artwork.jpg");
  const filePath = path.join(workspace, "song.txt");
  const artworkPath = path.join(workspace, "valid-song-with-artwork.jpg");

  fs.copyFileSync(sourceFile, filePath);
  fs.copyFileSync(artworkFile, artworkPath);

  const first = runCli(filePath, {
    SHIELD_CLI_DYNAMO_STATE_FILE: stateFile,
    SHIELD_CLI_EVENT_STATE_FILE: eventFile
  });
  assert(first.error == null, "idempotency: first cli execution failed");
  assert(first.stderr.trim() === "", "idempotency: first run expected no stderr output");

  const firstParsed = parseJson(first.stdout, "idempotency first run");
  assert(firstParsed.status === "processed", `idempotency: expected first run processed but got ${firstParsed.status}`);
  assert(firstParsed.songId === "valid-song-with-artwork", `idempotency: expected songId valid-song-with-artwork but got ${firstParsed.songId}`);
  assert(firstParsed.writtenToDynamo === true, "idempotency: first run should write to Dynamo");
  assert(firstParsed.updateType === "insert", `idempotency: expected first run insert but got ${firstParsed.updateType}`);
  assert(typeof firstParsed.contentHash === "string" && firstParsed.contentHash.length > 0, "idempotency: first run missing contentHash");
  let events = loadEvents(eventFile);
  assert(events.length === 1, "idempotency: first run should emit one event");
  assert(events[0].eventType === "SONG_CREATED", "idempotency: first run should emit SONG_CREATED");
  assert(events[0].payload.songId === "valid-song-with-artwork", "idempotency: emitted create event songId mismatch");
  assert(events[0].payload.source === "shield-ingest-cli", "idempotency: emitted create event source mismatch");

  const second = runCli(filePath, {
    SHIELD_CLI_DYNAMO_STATE_FILE: stateFile,
    SHIELD_CLI_EVENT_STATE_FILE: eventFile
  });
  assert(second.error == null, "idempotency: second cli execution failed");
  assert(second.stderr.trim() === "", "idempotency: second run expected no stderr output");

  const secondParsed = parseJson(second.stdout, "idempotency second run");
  assert(secondParsed.status === "unchanged", `idempotency: expected second run unchanged but got ${secondParsed.status}`);
  assert(secondParsed.songId === "valid-song-with-artwork", `idempotency: expected same songId on second run but got ${secondParsed.songId}`);
  assert(secondParsed.writtenToDynamo === false, "idempotency: second run should not write to Dynamo");
  assert(secondParsed.updateType === "skip", `idempotency: expected second run skip but got ${secondParsed.updateType}`);
  assert(secondParsed.contentHash === firstParsed.contentHash, "idempotency: contentHash should stay stable on unchanged content");
  events = loadEvents(eventFile);
  assert(events.length === 1, "idempotency: unchanged run should not emit a second event");

  const updatedContent = fs.readFileSync(filePath, "utf8").replace("Line 2", "Line 2\nLine 3");
  fs.writeFileSync(filePath, updatedContent);

  const third = runCli(filePath, {
    SHIELD_CLI_DYNAMO_STATE_FILE: stateFile,
    SHIELD_CLI_EVENT_STATE_FILE: eventFile
  });
  assert(third.error == null, "idempotency: third cli execution failed");
  assert(third.stderr.trim() === "", "idempotency: third run expected no stderr output");

  const thirdParsed = parseJson(third.stdout, "idempotency third run");
  assert(thirdParsed.status === "updated", `idempotency: expected third run updated but got ${thirdParsed.status}`);
  assert(thirdParsed.songId === "valid-song-with-artwork", `idempotency: expected same songId on third run but got ${thirdParsed.songId}`);
  assert(thirdParsed.writtenToDynamo === true, "idempotency: third run should write to Dynamo");
  assert(thirdParsed.updateType === "update", `idempotency: expected third run update but got ${thirdParsed.updateType}`);
  assert(thirdParsed.contentHash !== firstParsed.contentHash, "idempotency: contentHash should change after file edit");
  events = loadEvents(eventFile);
  assert(events.length === 2, "idempotency: update should add one more event");
  assert(events[1].eventType === "SONG_UPDATED", "idempotency: update should emit SONG_UPDATED");
  assert(events[1].payload.songId === "valid-song-with-artwork", "idempotency: emitted event songId mismatch");
  assert(events[1].payload.source === "shield-ingest-cli", "idempotency: emitted event source mismatch");

  const storedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const storedRecord = storedState["valid-song-with-artwork"];
  assert(storedRecord, "idempotency: expected a stored song record");
  assert(Object.keys(storedState).length === 1, "idempotency: expected a single Dynamo key");
  assert(storedRecord.songId === "valid-song-with-artwork", "idempotency: stored record songId mismatch");
  assert(storedRecord.status === "coming_soon", "idempotency: stored status should remain coming_soon");
  assert(storedRecord.artwork === "valid-song-with-artwork.jpg", "idempotency: artwork was not preserved");
}

function runEmptyFieldProtectionCase() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shield-cli-empty-"));
  const stateFile = path.join(workspace, "state.json");
  const eventFile = path.join(workspace, "events.json");
  const filePath = path.join(workspace, "song.txt");
  const sourceFile = path.join(fixturesDir, "empty-fields.txt");

  fs.copyFileSync(sourceFile, filePath);
  fs.writeFileSync(stateFile, `${JSON.stringify({
    "empty-fields-song": {
      songId: "empty-fields-song",
      title: "Empty Fields Song",
      songmeaning: "Existing meaning",
      lyrics: "Existing lyrics",
      artwork: "existing-artwork.png",
      contentHash: "old-hash",
      status: "coming_soon",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  }, null, 2)}\n`);

  const result = runCli(filePath, {
    SHIELD_CLI_DYNAMO_STATE_FILE: stateFile,
    SHIELD_CLI_EVENT_STATE_FILE: eventFile
  });
  assert(result.error == null, "empty-fields: cli execution failed");
  assert(result.stderr.trim() === "", "empty-fields: expected no stderr output");

  const parsed = parseJson(result.stdout, "empty-fields");
  assert(parsed.status === "skipped", `empty-fields: expected skipped but got ${parsed.status}`);
  assert(parsed.reason === "not_qualifying", `empty-fields: expected not_qualifying but got ${parsed.reason}`);
  assert(parsed.writtenToDynamo === false, "empty-fields: should not write to Dynamo");
  const events = loadEvents(eventFile);
  assert(events.length === 0, "empty-fields: expected no emitted events");

  const storedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const storedRecord = storedState["empty-fields-song"];
  assert(storedRecord.songmeaning === "Existing meaning", "empty-fields: songmeaning should not be overwritten");
  assert(storedRecord.lyrics === "Existing lyrics", "empty-fields: lyrics should not be overwritten");
  assert(storedRecord.artwork === "existing-artwork.png", "empty-fields: artwork should not be overwritten");
}

function runNoTitleCase() {
  const filePath = path.join(fixturesDir, "no-title.txt");
  const result = runCli(filePath);

  assert(result.error == null, "no-title: cli execution failed");
  assert(result.stderr.trim() === "", "no-title: expected no stderr output");

  const parsed = parseJson(result.stdout, "no-title");
  assert(parsed.status === "rejected", `no-title: expected rejected but got ${parsed.status}`);
  assert(parsed.reason === "missing_title", `no-title: expected missing_title but got ${parsed.reason}`);
  assert(parsed.songId === null, `no-title: expected null songId but got ${parsed.songId}`);
}

function runDropzoneScanCase() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shield-cli-dropzone-"));
  const stateFile = path.join(workspace, "state.json");
  const eventFile = path.join(workspace, "events.json");
  const dropzoneDir = path.join(workspace, "dropzone");
  fs.mkdirSync(dropzoneDir, { recursive: true });

  fs.writeFileSync(path.join(dropzoneDir, "lyrics-only.txt"), [
    "#title",
    "Lyrics Only Song",
    "",
    "#lyrics",
    "Line 1",
    "Line 2"
  ].join("\n"));

  fs.writeFileSync(path.join(dropzoneDir, "artwork-only.txt"), [
    "#title",
    "Artwork Only Song",
    "",
    "#lyrics",
    ""
  ].join("\n"));
  fs.copyFileSync(path.join(fixturesDir, "valid-song-with-artwork.jpg"), path.join(dropzoneDir, "Artwork Only Song.jpg"));

  fs.writeFileSync(path.join(dropzoneDir, "title-only.txt"), [
    "#title",
    "Title Only Song",
    "",
    "#lyrics",
    ""
  ].join("\n"));

  const result = runCliWithArgs(["ingest", "-"], {
    SHIELD_CLI_DYNAMO_STATE_FILE: stateFile,
    SHIELD_CLI_EVENT_STATE_FILE: eventFile,
    SHIELD_CLI_DROPZONE_DIR: dropzoneDir
  });

  assert(result.error == null, "dropzone-scan: cli execution failed");
  assert(result.stderr.trim() === "", "dropzone-scan: expected no stderr output");

  const parsed = parseJson(result.stdout, "dropzone-scan");
  assert(parsed.status === "processed", `dropzone-scan: expected processed but got ${parsed.status}`);
  assert(parsed.mode === "dropzone", `dropzone-scan: expected dropzone mode but got ${parsed.mode}`);
  assert(parsed.scanned === 3, `dropzone-scan: expected scanned 3 but got ${parsed.scanned}`);
  assert(parsed.queued === 2, `dropzone-scan: expected queued 2 but got ${parsed.queued}`);
  assert(parsed.skipped === 1, `dropzone-scan: expected skipped 1 but got ${parsed.skipped}`);

  const events = loadEvents(eventFile);
  assert(events.length === 2, `dropzone-scan: expected 2 emitted events but got ${events.length}`);

  const storedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert(storedState["lyrics-only-song"], "dropzone-scan: lyrics-only song should be queued");
  assert(storedState["artwork-only-song"], "dropzone-scan: artwork-only song should be queued");
  assert(!storedState["title-only-song"], "dropzone-scan: title-only song should not be queued");
}

function runPartialExistingUpsertCase() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shield-cli-partial-"));
  const stateFile = path.join(workspace, "state.json");
  const eventFile = path.join(workspace, "events.json");
  const dropzoneDir = path.join(workspace, "dropzone");
  fs.mkdirSync(dropzoneDir, { recursive: true });

  fs.writeFileSync(path.join(dropzoneDir, "let-my-people-go.txt"), [
    "#title",
    "Let My People Go",
    "",
    "#songmeaning",
    "Latest meaning from the dropzone.",
    "",
    "#lyrics",
    "Go DOWN, Moses!",
    "Burn through Egypt’s gates,"
  ].join("\n"));
  fs.copyFileSync(path.join(fixturesDir, "valid-song-with-artwork.jpg"), path.join(dropzoneDir, "Let My People Go.jpg"));

  fs.writeFileSync(stateFile, `${JSON.stringify({
    "let-my-people-go": {
      songId: "let-my-people-go",
      title: "Let My People Go",
      lyrics: "Old lyrics",
      contentHash: "old-hash",
      status: "coming_soon",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  }, null, 2)}\n`);

  const result = runCliWithArgs(["ingest", "-"], {
    SHIELD_CLI_DYNAMO_STATE_FILE: stateFile,
    SHIELD_CLI_EVENT_STATE_FILE: eventFile,
    SHIELD_CLI_DROPZONE_DIR: dropzoneDir
  });

  assert(result.error == null, "partial-upsert: cli execution failed");
  assert(result.stderr.trim() === "", "partial-upsert: expected no stderr output");

  const parsed = parseJson(result.stdout, "partial-upsert");
  assert(parsed.status === "processed", `partial-upsert: expected processed but got ${parsed.status}`);
  assert(parsed.queued === 1, `partial-upsert: expected one queued song but got ${parsed.queued}`);

  const events = loadEvents(eventFile);
  assert(events.length === 1, `partial-upsert: expected one event but got ${events.length}`);
  assert(events[0].eventType === "SONG_UPDATED", "partial-upsert: expected SONG_UPDATED");

  const storedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const storedRecord = storedState["let-my-people-go"];
  assert(storedRecord.lyrics !== "Old lyrics", "partial-upsert: lyrics should be refreshed");
  assert(storedRecord.songmeaning === "Latest meaning from the dropzone.", "partial-upsert: songmeaning should be refreshed");
  assert(storedRecord.artwork === "Let My People Go.jpg", "partial-upsert: artwork should be attached");
}

try {
  runIdempotencySuite();
  console.log("PASS idempotency");
  runEmptyFieldProtectionCase();
  console.log("PASS empty-fields");
  runNoTitleCase();
  console.log("PASS no-title");
  runDropzoneScanCase();
  console.log("PASS dropzone-scan");
  runPartialExistingUpsertCase();
  console.log("PASS partial-upsert");
  console.log("ALL TESTS PASSED");
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
}
