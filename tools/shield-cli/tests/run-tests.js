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

function buildArtworkEnv(workspace) {
  return {
    SHIELD_CLI_ARTWORK_PUBLIC_DIR: path.join(workspace, "public-artwork"),
    SHIELD_CLI_ARTWORK_PUBLIC_BASE_URL: "https://example.test",
    SHIELD_CLI_ARTWORK_COPY_ONLY: "1",
    SHIELD_CLI_SITE_JSON_PATH: path.join(workspace, "site.json")
  };
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
    ...buildArtworkEnv(workspace),
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
    ...buildArtworkEnv(workspace),
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
    ...buildArtworkEnv(workspace),
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
    ...buildArtworkEnv(path.dirname(stateFile)),
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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shield-cli-no-title-"));
  const filePath = path.join(fixturesDir, "no-title.txt");
  const result = runCli(filePath, buildArtworkEnv(workspace));

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
    ...buildArtworkEnv(workspace),
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
      artworkUrl: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  }, null, 2)}\n`);

  const result = runCliWithArgs(["ingest", "-"], {
    ...buildArtworkEnv(workspace),
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
  assert(events[0].artworkUrl && events[0].artworkUrl.startsWith("https://example.test/"), "partial-upsert: emitted artworkUrl missing");

  const storedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const storedRecord = storedState["let-my-people-go"];
  assert(storedRecord.lyrics !== "Old lyrics", "partial-upsert: lyrics should be refreshed");
  assert(storedRecord.songmeaning === "Latest meaning from the dropzone.", "partial-upsert: songmeaning should be refreshed");
  assert(storedRecord.artworkUrl && storedRecord.artworkUrl.startsWith("https://example.test/"), "partial-upsert: artworkUrl should be attached");
  assert(storedRecord.artwork === "Let My People Go.jpg", "partial-upsert: artwork should be attached");
}

function runCleanReplaceCase() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shield-cli-clean-replace-"));
  const stateFile = path.join(workspace, "state.json");
  const eventFile = path.join(workspace, "events.json");
  const dropzoneDir = path.join(workspace, "dropzone");
  fs.mkdirSync(dropzoneDir, { recursive: true });

  fs.writeFileSync(path.join(dropzoneDir, "let-my-people-go.txt"), [
    "#title",
    "Let My People Go",
    "",
    "#songmeaning",
    "New meaning from the dropzone.",
    "",
    "#lyrics",
    "Go DOWN, Moses!",
    "Burn through Egypt’s gates,"
  ].join("\n"));

  fs.writeFileSync(stateFile, `${JSON.stringify({
    "let-my-people-go": {
      songId: "let-my-people-go",
      title: "Let My People Go",
      lyrics: "Old lyrics",
      songmeaning: "Old meaning",
      artworkUrl: "https://example.test/old-artwork.jpg",
      artwork: "old-artwork.jpg",
      contentHash: "old-hash",
      status: "coming_soon",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  }, null, 2)}\n`);

  const result = runCliWithArgs(["ingest", "-"], {
    ...buildArtworkEnv(workspace),
    SHIELD_CLI_DYNAMO_STATE_FILE: stateFile,
    SHIELD_CLI_EVENT_STATE_FILE: eventFile,
    SHIELD_CLI_DROPZONE_DIR: dropzoneDir
  });

  assert(result.error == null, "clean-replace: cli execution failed");
  assert(result.stderr.trim() === "", "clean-replace: expected no stderr output");

  const parsed = parseJson(result.stdout, "clean-replace");
  assert(parsed.status === "processed" || parsed.status === "updated", `clean-replace: expected processed/updated but got ${parsed.status}`);

  const storedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const storedRecord = storedState["let-my-people-go"];
  assert(storedRecord.lyrics === "Go DOWN, Moses!\nBurn through Egypt’s gates,", "clean-replace: lyrics should be replaced");
  assert(storedRecord.songmeaning === "New meaning from the dropzone.", "clean-replace: songmeaning should be replaced");
  assert(!("artworkUrl" in storedRecord), "clean-replace: artworkUrl should be removed when not provided");
  assert(!("artwork" in storedRecord), "clean-replace: artwork should be removed when not provided");
}

function loadSiteJson(siteJsonPath) {
  if (!fs.existsSync(siteJsonPath)) return null;
  return JSON.parse(fs.readFileSync(siteJsonPath, "utf8"));
}

function runSiteJsonSnapshotCase() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shield-cli-site-json-"));
  const dropzoneDir = path.join(workspace, "dropzone");
  const artworkDir = path.join(workspace, "public-artwork");
  const siteJsonPath = path.join(workspace, "site.json");
  fs.mkdirSync(dropzoneDir, { recursive: true });

  fs.writeFileSync(siteJsonPath, `${JSON.stringify({
    generatedAt: "2026-01-01T00:00:00.000Z",
    homepage: { banner: { title: "Keep me" } },
    comingSoon: [{ title: "Old song", lyrics: "Old lyrics", artwork: "https://example.test/old.jpg" }]
  }, null, 4)}\n`);

  const env = {
    ...buildArtworkEnv(workspace),
    SHIELD_CLI_DYNAMO_STATE_FILE: path.join(workspace, "state.json"),
    SHIELD_CLI_EVENT_STATE_FILE: path.join(workspace, "events.json"),
    SHIELD_CLI_DROPZONE_DIR: dropzoneDir
  };

  // Scenario 1: title + lyrics + artwork
  fs.writeFileSync(path.join(dropzoneDir, "song.txt"), [
    "#title", "Let My People Go", "",
    "#songmeaning", "A cry for freedom.", "",
    "#lyrics", "Go DOWN, Moses!", "Burn through Egypt's gates,"
  ].join("\n"));
  fs.copyFileSync(path.join(fixturesDir, "valid-song-with-artwork.jpg"), path.join(dropzoneDir, "something-random.jpg"));

  let result = runCliWithArgs(["ingest", "-"], env);
  assert(result.error == null, "site-json full: cli execution failed");
  assert(result.stderr.trim() === "", `site-json full: unexpected stderr: ${result.stderr}`);

  let site = loadSiteJson(siteJsonPath);
  assert(site.homepage?.banner?.title === "Keep me", "site-json full: other top-level fields must be preserved");
  assert(Array.isArray(site.comingSoon) && site.comingSoon.length === 1, "site-json full: comingSoon should have exactly one entry");
  let entry = site.comingSoon[0];
  assert(entry.title === "Let My People Go", "site-json full: title mismatch");
  assert(entry.lyrics.startsWith("Go DOWN, Moses!"), "site-json full: lyrics mismatch");
  assert(entry.songMeaning === "A cry for freedom.", "site-json full: songMeaning mismatch");
  assert(entry.artwork === "https://example.test/images/signal-room/let-my-people-go.jpg", "site-json full: artwork url mismatch");
  assert(entry.status === "coming_soon", "site-json full: status should be coming_soon");
  assert(fs.existsSync(path.join(artworkDir, "let-my-people-go.jpg")), "site-json full: published artwork should exist");

  // Scenario 2: artwork removed from dropzone → site.json artwork cleared, published jpg deleted
  fs.rmSync(path.join(dropzoneDir, "something-random.jpg"));
  result = runCliWithArgs(["ingest", "-"], env);
  assert(result.error == null, "site-json no-artwork: cli execution failed");

  site = loadSiteJson(siteJsonPath);
  entry = site.comingSoon[0];
  assert(entry.artwork === "", "site-json no-artwork: artwork url should be cleared");
  assert(entry.lyrics.startsWith("Go DOWN, Moses!"), "site-json no-artwork: lyrics should still be present");
  assert(!fs.existsSync(path.join(artworkDir, "let-my-people-go.jpg")), "site-json no-artwork: published artwork should be deleted");

  // Scenario 3: lyrics removed from dropzone (keep artwork) → artwork-only entry
  fs.writeFileSync(path.join(dropzoneDir, "song.txt"), [
    "#title", "Let My People Go", "",
    "#lyrics", ""
  ].join("\n"));
  fs.copyFileSync(path.join(fixturesDir, "valid-song-with-artwork.jpg"), path.join(dropzoneDir, "something-random.jpg"));
  result = runCliWithArgs(["ingest", "-"], env);
  assert(result.error == null, "site-json artwork-only: cli execution failed");

  site = loadSiteJson(siteJsonPath);
  entry = site.comingSoon[0];
  assert(entry.lyrics === "", "site-json artwork-only: lyrics should be cleared");
  assert(entry.artwork === "https://example.test/images/signal-room/let-my-people-go.jpg", "site-json artwork-only: artwork url should be present");
  assert(fs.existsSync(path.join(artworkDir, "let-my-people-go.jpg")), "site-json artwork-only: published artwork should exist");

  // Scenario 4: dropzone emptied → comingSoon becomes empty, all published jpgs deleted
  fs.rmSync(path.join(dropzoneDir, "song.txt"));
  fs.rmSync(path.join(dropzoneDir, "something-random.jpg"));
  result = runCliWithArgs(["ingest", "-"], env);
  assert(result.error == null, "site-json empty-dropzone: cli execution failed");

  site = loadSiteJson(siteJsonPath);
  assert(site.homepage?.banner?.title === "Keep me", "site-json empty-dropzone: other top-level fields must remain");
  assert(Array.isArray(site.comingSoon) && site.comingSoon.length === 0, "site-json empty-dropzone: comingSoon should be empty");
  assert(!fs.existsSync(path.join(artworkDir, "let-my-people-go.jpg")), "site-json empty-dropzone: published artwork should be deleted");

  // Scenario 5: title-only (no lyrics, no artwork) → treated as nothing; comingSoon stays empty
  fs.writeFileSync(path.join(dropzoneDir, "song.txt"), [
    "#title", "Let My People Go", "",
    "#lyrics", ""
  ].join("\n"));
  result = runCliWithArgs(["ingest", "-"], env);
  assert(result.error == null, "site-json title-only: cli execution failed");

  site = loadSiteJson(siteJsonPath);
  assert(Array.isArray(site.comingSoon) && site.comingSoon.length === 0, "site-json title-only: comingSoon should remain empty when nothing qualifies");

  // Scenario 6: artwork with an unrelated filename gets picked up via fallback
  fs.copyFileSync(path.join(fixturesDir, "valid-song-with-artwork.jpg"), path.join(dropzoneDir, "random-cover-art.jpg"));
  result = runCliWithArgs(["ingest", "-"], env);
  assert(result.error == null, "site-json fallback-artwork: cli execution failed");

  site = loadSiteJson(siteJsonPath);
  entry = site.comingSoon[0];
  assert(entry.artwork === "https://example.test/images/signal-room/let-my-people-go.jpg", "site-json fallback-artwork: artwork should resolve via fallback");
  assert(fs.existsSync(path.join(artworkDir, "let-my-people-go.jpg")), "site-json fallback-artwork: published artwork should exist");
}

function runScriptureIngestCase() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shield-cli-scripture-"));
  const stateFile = path.join(workspace, "state.json");
  const eventFile = path.join(workspace, "events.json");
  const filePath = path.join(workspace, "song.txt");
  fs.copyFileSync(path.join(fixturesDir, "song-with-scripture.txt"), filePath);
  fs.writeFileSync(stateFile, "{}\n");

  const result = runCli(filePath, {
    ...buildArtworkEnv(path.dirname(stateFile)),
    SHIELD_CLI_DYNAMO_STATE_FILE: stateFile,
    SHIELD_CLI_EVENT_STATE_FILE: eventFile
  });
  assert(result.error == null, `scripture-ingest: cli failed: ${result.stderr}`);
  const parsed = parseJson(result.stdout, "scripture-ingest");
  assert(parsed.status === "processed" || parsed.status === "updated" || parsed.status === "created", `scripture-ingest: expected processed/updated/created, got ${parsed.status}`);

  const storedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const stored = storedState[parsed.songId];
  assert(stored != null, "scripture-ingest: record persisted to state");
  assert(stored.reference === "Exodus 5:1 | Exodus 7:16", `scripture-ingest: reference field mismatch (got ${JSON.stringify(stored.reference)})`);
  assert(stored.scripture && typeof stored.scripture === "object", "scripture-ingest: scripture stored as object");
  assert(stored.scripture.ref === "Exodus 5:1", `scripture-ingest: scripture.ref mismatch (got ${JSON.stringify(stored.scripture.ref)})`);
  assert(stored.scripture.quote.indexOf("Let my people go") !== -1, "scripture-ingest: scripture.quote contains the verse text");
}

function runScriptureMissingCase() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shield-cli-no-scripture-"));
  const stateFile = path.join(workspace, "state.json");
  const eventFile = path.join(workspace, "events.json");
  const filePath = path.join(workspace, "song.txt");
  fs.copyFileSync(path.join(fixturesDir, "valid-song.txt"), filePath);
  fs.writeFileSync(stateFile, "{}\n");

  const result = runCli(filePath, {
    ...buildArtworkEnv(path.dirname(stateFile)),
    SHIELD_CLI_DYNAMO_STATE_FILE: stateFile,
    SHIELD_CLI_EVENT_STATE_FILE: eventFile
  });
  assert(result.error == null, "no-scripture: cli failed");
  const parsed = parseJson(result.stdout, "no-scripture");
  const storedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const stored = storedState[parsed.songId];
  assert(stored != null, "no-scripture: record persisted");
  assert(stored.reference == null || stored.reference === undefined, "no-scripture: reference absent when template omits it");
  assert(stored.scripture == null || stored.scripture === undefined, "no-scripture: scripture absent when template omits it");
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
  runCleanReplaceCase();
  console.log("PASS clean-replace");
  runSiteJsonSnapshotCase();
  console.log("PASS site-json-snapshot");
  runScriptureIngestCase();
  console.log("PASS scripture-ingest");
  runScriptureMissingCase();
  console.log("PASS scripture-missing");
  console.log("ALL TESTS PASSED");
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
}
