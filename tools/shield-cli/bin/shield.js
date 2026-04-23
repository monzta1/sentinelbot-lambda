#!/usr/bin/env node

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { emitSongEvent } = require("../src/event-stream");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const SONGS_TABLE_NAME = process.env.SONGS_TABLE_NAME || "shieldbearer-songs";
const TEST_STATE_FILE = process.env.SHIELD_CLI_DYNAMO_STATE_FILE || "";
const DEFAULT_DROPZONE_DIR = process.env.SHIELD_CLI_DROPZONE_DIR || path.join(os.homedir(), "Shieldbearer", "dropzone");

const helpText = `Shield Ingest CLI

Usage:
  shield ingest [-|file]
  shield ingest

Options:
  --help     Show help
  --dry-run  Preview without writing
`;

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function logMissingTitleDebug(filePath) {
  if (process.env.SHIELD_CLI_DEBUG_MISSING_TITLE !== "1") return;
  try {
    console.error(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(error);
  }
}

function normalizeValue(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function slugifyTitle(title) {
  return String(title || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeMatchName(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\.[^.]+$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

function getDropzoneTargets(dropzoneDir) {
  const files = listFiles(dropzoneDir);
  const textFiles = files.filter((file) => path.extname(file).toLowerCase() === ".txt");
  return textFiles.map((file) => path.join(dropzoneDir, file));
}

function parseSongFile(rawContent) {
  const normalized = String(rawContent || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  const headingPattern = /^[ \t]*#([a-zA-Z]+)\s*$/gm;
  const headings = [];
  let headingMatch;

  while ((headingMatch = headingPattern.exec(normalized)) !== null) {
    headings.push({
      name: headingMatch[1].toLowerCase(),
      contentStart: headingPattern.lastIndex,
      headingStart: headingMatch.index
    });
  }

  const sections = {};
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    const next = headings[index + 1];
    const value = normalized.slice(current.contentStart, next ? next.headingStart : normalized.length)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (value.length > 0 && sections[current.name] == null) {
      sections[current.name] = value;
    }
  }

  return {
    title: sections.title || null,
    songmeaning: sections.songmeaning || null,
    lyrics: sections.lyrics || null
  };
}

function normalizeContentField(value) {
  const normalized = normalizeValue(value);
  return normalized;
}

function normalizeLyricsBlock(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractLyricsPreview(lyrics) {
  const normalized = normalizeLyricsBlock(lyrics);
  if (!normalized) return "";
  return normalized.split("\n").slice(0, 5).join("\n");
}

function buildContentHash(song) {
  const payload = {
    artworkUrl: normalizeContentField(song.artworkUrl),
    lyrics: normalizeContentField(song.lyrics),
    songMeaning: normalizeContentField(song.songMeaning),
    songmeaning: normalizeContentField(song.songmeaning),
    title: normalizeContentField(song.title)
  };

  const stablePayload = {
    artworkUrl: payload.artworkUrl,
    lyrics: payload.lyrics,
    songMeaning: payload.songMeaning,
    songmeaning: payload.songmeaning,
    title: payload.title
  };

  return crypto.createHash("sha256").update(JSON.stringify(stablePayload)).digest("hex");
}

function detectArtwork(filePath, title, slug) {
  if (!title && !slug) return null;

  const directory = path.dirname(filePath);
  const supportedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const matchTitle = normalizeMatchName(title);
  const matchSlug = normalizeMatchName(slug);

  const exactMatch = entries.find((entry) => {
    if (!entry.isFile()) return false;
    const parsed = path.parse(entry.name);
    if (!supportedExtensions.has(parsed.ext.toLowerCase())) return false;
    const stem = normalizeMatchName(parsed.name);
    return stem === matchSlug || stem === matchTitle;
  });

  if (exactMatch) {
    return exactMatch.name;
  }

  const containsMatch = entries.find((entry) => {
    if (!entry.isFile()) return false;
    const parsed = path.parse(entry.name);
    if (!supportedExtensions.has(parsed.ext.toLowerCase())) return false;
    const stem = normalizeMatchName(parsed.name);
    return (matchSlug && stem.includes(matchSlug)) || (matchTitle && stem.includes(matchTitle));
  });

  return containsMatch ? containsMatch.name : null;
}

function isQualifyingSong(parsed, songPayload) {
  const title = normalizeValue(parsed?.title);
  if (!title) {
    return false;
  }

  const lyrics = normalizeValue(songPayload?.lyrics);
  const artworkUrl = normalizeValue(songPayload?.artworkUrl);

  if (lyrics) {
    return true;
  }

  if (artworkUrl) {
    return true;
  }

  return false;
}

function buildSongContentPayload(filePath, parsed, slug) {
  const artworkFile = detectArtwork(filePath, parsed.title, slug);
  const lyrics = normalizeValue(parsed.lyrics);
  const songMeaning = normalizeValue(parsed.songmeaning);
  return {
    lyrics,
    lyricsPreview: extractLyricsPreview(parsed.lyrics),
    songMeaning,
    songmeaning: songMeaning,
    artworkUrl: artworkFile ? path.join(path.dirname(filePath), artworkFile) : null
  };
}

function readSongFile(filePath) {
  const rawContent = fs.readFileSync(filePath, "utf8");
  return parseSongFile(rawContent);
}

function loadTestState() {
  if (!TEST_STATE_FILE) return {};
  try {
    const raw = fs.readFileSync(TEST_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function saveTestState(state) {
  if (!TEST_STATE_FILE) return;
  const directory = path.dirname(TEST_STATE_FILE);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${TEST_STATE_FILE}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tempPath, TEST_STATE_FILE);
}

async function fetchExistingSong(songId) {
  if (TEST_STATE_FILE) {
    const state = loadTestState();
    return state[songId] || null;
  }

  const response = await dynamo.send(new GetCommand({
    TableName: SONGS_TABLE_NAME,
    Key: { songId }
  }));

  return response?.Item || null;
}

function buildInsertItem(song, contentHash, nowIso) {
  const item = {
    songId: song.songId,
    title: song.title,
    contentHash,
    status: "coming_soon",
    createdAt: nowIso,
    updatedAt: nowIso
  };

  if (normalizeValue(song.songMeaning)) item.songMeaning = normalizeValue(song.songMeaning);
  if (normalizeValue(song.songmeaning)) item.songmeaning = normalizeValue(song.songmeaning);
  if (normalizeValue(song.lyrics)) item.lyrics = normalizeValue(song.lyrics);
  if (normalizeValue(song.lyricsPreview)) item.lyricsPreview = normalizeValue(song.lyricsPreview);
  if (normalizeValue(song.artworkUrl)) item.artworkUrl = normalizeValue(song.artworkUrl);
  if (normalizeValue(song.artworkUrl)) item.artwork = normalizeValue(path.basename(song.artworkUrl));

  return item;
}

function buildMergedUpdate(existing, song, contentHash, nowIso) {
  const next = { ...existing };
  next.songId = existing.songId || song.songId;
  const nextTitle = normalizeValue(song.title);
  const nextSongMeaning = normalizeValue(song.songMeaning);
  const nextSongmeaning = normalizeValue(song.songmeaning);
  const nextLyrics = normalizeValue(song.lyrics);
  const nextLyricsPreview = normalizeValue(song.lyricsPreview);
  const nextArtwork = normalizeValue(song.artworkUrl);

  if (normalizeValue(existing.title) !== nextTitle) next.title = nextTitle;
  if (nextSongMeaning != null && normalizeValue(existing.songMeaning) !== nextSongMeaning) next.songMeaning = nextSongMeaning;
  if (nextSongmeaning != null && normalizeValue(existing.songmeaning) !== nextSongmeaning) next.songmeaning = nextSongmeaning;
  if (nextLyrics != null && normalizeValue(existing.lyrics) !== nextLyrics) next.lyrics = nextLyrics;
  if (nextLyricsPreview != null && normalizeValue(existing.lyricsPreview) !== nextLyricsPreview) next.lyricsPreview = nextLyricsPreview;
  if (nextArtwork != null && normalizeValue(existing.artworkUrl) !== nextArtwork) next.artworkUrl = nextArtwork;
  if (nextArtwork != null && normalizeValue(existing.artwork) !== path.basename(nextArtwork)) next.artwork = path.basename(nextArtwork);

  next.contentHash = contentHash;
  next.updatedAt = nowIso;
  if (!normalizeValue(next.status)) next.status = "coming_soon";

  return next;
}

async function writeInsert(song, contentHash, nowIso) {
  const item = buildInsertItem(song, contentHash, nowIso);

  if (TEST_STATE_FILE) {
    const state = loadTestState();
    state[song.songId] = item;
    saveTestState(state);
    return;
  }

  await dynamo.send(new PutCommand({
    TableName: SONGS_TABLE_NAME,
    Item: item,
    ConditionExpression: "attribute_not_exists(songId)"
  }));
}

async function writeUpdate(existing, song, contentHash, nowIso) {
  if (TEST_STATE_FILE) {
    const state = loadTestState();
    state[song.songId] = buildMergedUpdate(state[song.songId] || existing, song, contentHash, nowIso);
    saveTestState(state);
    return;
  }

  const expressionNames = {
    "#contentHash": "contentHash",
    "#songId": "songId",
    "#status": "status",
    "#updatedAt": "updatedAt"
  };
  const expressionValues = {
    ":comingSoon": "coming_soon",
    ":contentHash": contentHash,
    ":updatedAt": nowIso
  };
  const setExpressions = [
    "#contentHash = :contentHash",
    "#updatedAt = :updatedAt",
    "#status = if_not_exists(#status, :comingSoon)"
  ];

  if (normalizeValue(existing.title) !== normalizeValue(song.title)) {
    expressionNames["#title"] = "title";
    expressionValues[":title"] = normalizeValue(song.title);
    setExpressions.unshift("#title = :title");
  }

  if (normalizeValue(song.songmeaning) != null && normalizeValue(existing.songmeaning) !== normalizeValue(song.songmeaning)) {
    expressionNames["#songmeaning"] = "songmeaning";
    expressionValues[":songmeaning"] = normalizeValue(song.songmeaning);
    setExpressions.push("#songmeaning = :songmeaning");
  }

  if (normalizeValue(song.lyrics) != null && normalizeValue(existing.lyrics) !== normalizeValue(song.lyrics)) {
    expressionNames["#lyrics"] = "lyrics";
    expressionValues[":lyrics"] = normalizeValue(song.lyrics);
    setExpressions.push("#lyrics = :lyrics");
  }

  if (normalizeValue(song.artwork) != null && normalizeValue(existing.artwork) !== normalizeValue(song.artwork)) {
    expressionNames["#artwork"] = "artwork";
    expressionValues[":artwork"] = normalizeValue(song.artwork);
    setExpressions.push("#artwork = :artwork");
  }

  await dynamo.send(new UpdateCommand({
    TableName: SONGS_TABLE_NAME,
    Key: { songId: song.songId },
    ConditionExpression: "attribute_exists(#songId)",
    UpdateExpression: `SET ${setExpressions.join(", ")}`,
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: expressionValues
  }));
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    process.stdout.write(helpText);
    process.exit(0);
  }

  const command = args[0];
  const fileArg = args.find((arg, index) => index > 0 && !arg.startsWith("--"));
  const isDryRun = args.includes("--dry-run");
  return { command, fileArg, isDryRun };
}

async function ingestSongFile(filePath, { dryRun = false } = {}) {
  let parsed;
  try {
    parsed = readSongFile(filePath);
  } catch (error) {
    console.error(error);
    return {
      status: "rejected",
      reason: "missing_title",
      songId: null,
      filePath
    };
  }

  if (!parsed.title) {
    logMissingTitleDebug(filePath);
    return {
      status: "rejected",
      reason: "missing_title",
      songId: null,
      writtenToDynamo: false,
      filePath
    };
  }

  const songId = slugifyTitle(parsed.title);
  if (!songId) {
    return {
      status: "rejected",
      reason: "missing_title",
      songId: null,
      writtenToDynamo: false,
      filePath
    };
  }

  const contentPayload = buildSongContentPayload(filePath, parsed, songId);
  if (!isQualifyingSong(parsed, contentPayload)) {
    return {
      status: "skipped",
      reason: "not_qualifying",
      songId,
      writtenToDynamo: false,
      filePath
    };
  }

  try {
    const persisted = await persistSong({
      songId,
      title: parsed.title,
      songMeaning: contentPayload.songMeaning,
      songmeaning: contentPayload.songmeaning,
      lyrics: contentPayload.lyrics,
      lyricsPreview: contentPayload.lyricsPreview,
      artworkUrl: contentPayload.artworkUrl
    }, {
      dryRun
    });

    return {
      ...persisted,
      filePath
    };
  } catch (error) {
    return {
      status: "error",
      reason: "dynamodb_write_failed",
      songId,
      writtenToDynamo: false,
      filePath
    };
  }
}

async function persistSong(song, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const contentHash = buildContentHash(song);
  const existing = await fetchExistingSong(song.songId);
  const nowIso = new Date().toISOString();

  if (!existing) {
    if (!dryRun) {
      await writeInsert(song, contentHash, nowIso);
      void emitSongEvent({
        eventType: "SONG_CREATED",
        songId: song.songId,
        title: song.title,
        contentHash,
        timestamp: nowIso,
        source: "shield-ingest-cli"
      }).catch((error) => {
        console.error(JSON.stringify({
          stage: "eventstream_write_failed",
          songId: song.songId,
          updateType: "insert",
          error: error?.message || String(error)
        }));
      });
    }
    return {
      status: "processed",
      songId: song.songId,
      writtenToDynamo: !dryRun,
      updateType: "insert",
      contentHash
    };
  }

  const existingHash = normalizeValue(existing.contentHash);
  if (existingHash === contentHash) {
    return {
      status: "unchanged",
      songId: song.songId,
      writtenToDynamo: false,
      updateType: "skip",
      contentHash
    };
  }

  if (!dryRun) {
    await writeUpdate(existing, song, contentHash, nowIso);
    void emitSongEvent({
      eventType: "SONG_UPDATED",
      songId: song.songId,
      title: song.title,
      contentHash,
      timestamp: nowIso,
      source: "shield-ingest-cli"
    }).catch((error) => {
      console.error(JSON.stringify({
        stage: "eventstream_write_failed",
        songId: song.songId,
        updateType: "update",
        error: error?.message || String(error)
      }));
    });
  }
  return {
    status: "updated",
    songId: song.songId,
    writtenToDynamo: !dryRun,
    updateType: "update",
    contentHash
  };
}

function main() {
  return (async () => {
    const { command, fileArg, isDryRun } = parseArgs(process.argv);
    const shouldScanDropzone = command === "ingest" && (!fileArg || fileArg === "-");

    if (command !== "ingest" || shouldScanDropzone) {
      const dropzoneDir = DEFAULT_DROPZONE_DIR;
      const targets = shouldScanDropzone ? getDropzoneTargets(dropzoneDir) : [];

      if (command !== "ingest") {
        process.stdout.write(helpText);
        process.exit(0);
      }

      if (!targets.length) {
        printJson({
          status: "processed",
          mode: "dropzone",
          scanned: 0,
          queued: 0,
          skipped: 0,
          rejected: 0,
          writtenToDynamo: false
        });
        return;
      }

      const results = [];
      for (const target of targets) {
        results.push(await ingestSongFile(target, { dryRun: isDryRun }));
      }

      const summary = {
        status: "processed",
        mode: "dropzone",
        scanned: results.length,
        queued: results.filter((result) => result.status === "processed" || result.status === "updated").length,
        skipped: results.filter((result) => result.status === "skipped").length,
        rejected: results.filter((result) => result.status === "rejected").length,
        writtenToDynamo: results.some((result) => Boolean(result.writtenToDynamo))
      };

      printJson(summary);
      return;
    }

    let filePath;
    try {
      filePath = path.resolve(process.cwd(), fileArg);
      const result = await ingestSongFile(filePath, { dryRun: isDryRun });
      printJson(result);
    } catch (error) {
      printJson({
        status: "error",
        reason: "dynamodb_write_failed",
        songId: null
      });
    }
  })();
}

main().catch(() => {
  printJson({
    status: "error",
    reason: "dynamodb_write_failed",
    songId: null
  });
});
