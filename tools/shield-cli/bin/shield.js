#!/usr/bin/env node

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SONGS_TABLE_NAME = process.env.SONGS_TABLE_NAME || "shieldbearer-songs";
const DYNAMO_TABLE_NAME = process.env.DYNAMO_TABLE || "shieldbearer-sentinel-logs";
const EVENT_STREAM_PK = "eventstream";

const helpText = `Shield Ingest CLI

Usage:
  shield ingest <file>

Options:
  --help     Show help
  --dry-run  Preview without writing
`;

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const fileArg = args.find((arg) => !arg.startsWith("--"));

if (args.length === 0 || args.includes("--help")) {
  process.stdout.write(helpText);
  process.exit(0);
}

function parseFile(rawContent) {
  const lines = String(rawContent || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const fields = {
    title: null,
    songmeaning: null,
    lyrics: null
  };
  let currentKey = null;
  const buffer = [];
  const flush = () => {
    if (!currentKey) return;
    const value = buffer.join("\n").replace(/^\n+|\n+$/g, "");
    fields[currentKey] = value.length > 0 ? value : null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "#title" || trimmed === "#songmeaning" || trimmed === "#lyrics") {
      flush();
      currentKey = trimmed.slice(1);
      buffer.length = 0;
      continue;
    }
    if (!currentKey) continue;
    buffer.push(line);
  }

  flush();
  return fields;
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

function findArtwork(filePath, slug) {
  if (!slug) return null;
  const allowedExts = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  const directory = path.dirname(filePath);
  const preferred = `${slug}`;
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsedEntry = path.parse(entry.name);
    if (!allowedExts.has(parsedEntry.ext.toLowerCase())) continue;
    if (parsedEntry.name === preferred) {
      return entry.name;
    }
  }

  return null;
}

function normalizeContentField(value) {
  if (value == null) return null;
  return String(value);
}

function buildContentHash(song) {
  const payload = {
    title: normalizeContentField(song.title),
    songmeaning: normalizeContentField(song.songmeaning),
    lyrics: normalizeContentField(song.lyrics),
    artwork: normalizeContentField(song.artwork)
  };

  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function validateSong(parsed) {
  const song = {
    title: parsed && parsed.title != null ? String(parsed.title) : null,
    songmeaning: parsed && parsed.songmeaning != null ? String(parsed.songmeaning) : null,
    lyrics: parsed && parsed.lyrics != null ? String(parsed.lyrics) : null,
    slug: parsed && parsed.slug != null ? String(parsed.slug) : null,
    artwork: parsed && parsed.artwork != null ? String(parsed.artwork) : null,
    contentHash: parsed && parsed.contentHash != null ? String(parsed.contentHash) : null
  };

  if (!song.title) {
    return {
      status: "rejected",
      triggerMatched: false,
      reason: "missing title",
      song
    };
  }

  if (song.lyrics || song.songmeaning || song.artwork) {
    return {
      status: "processed",
      triggerMatched: true,
      song
    };
  }

  return {
    status: "skipped",
    triggerMatched: false,
    reason: "missing lyrical or meaning content",
    song
  };
}

function buildCliEventStreamItem(song) {
  const timestamp = new Date().toISOString();
  return {
    id: `${EVENT_STREAM_PK}#CLI_INGEST#${song.slug}#${song.contentHash}`,
    pk: EVENT_STREAM_PK,
    sk: `CLI_INGEST#${song.slug}#${song.contentHash}`,
    eventType: "CLI_INGEST",
    changeType: song.changeType || "create",
    songId: song.slug,
    title: song.title,
    timestamp,
    source: "shield-cli",
    hasLyrics: Boolean(song.lyrics),
    hasMeaning: Boolean(song.songmeaning),
    hasArtwork: Boolean(song.artwork)
  };
}

if (!fileArg) {
  process.stdout.write(helpText);
  process.exit(0);
}

function buildProcessedResult(song, writtenToDynamo, eventLogged) {
  return {
    status: "processed",
    songId: song.slug,
    triggerMatched: true,
    writtenToDynamo,
    eventLogged,
    artworkAttached: Boolean(song.artwork),
    contentHash: song.contentHash || null
  };
}

function buildSkippedResult(song) {
  return {
    status: "skipped",
    songId: song.slug,
    triggerMatched: false,
    reason: "missing lyrics or meaning or artwork",
    contentHash: song.contentHash || null
  };
}

function buildRejectedResult() {
  return {
    status: "rejected",
    reason: "missing title or invalid file",
    songId: null,
    contentHash: null
  };
}

function buildErrorResult(reason, songId) {
  return {
    status: "error",
    reason,
    songId: songId || null,
    contentHash: null
  };
}

async function main() {
  try {
    const filePath = path.resolve(process.cwd(), fileArg);
    const rawContent = fs.readFileSync(filePath, "utf8");
    const parsed = parseFile(rawContent);
    const slug = slugifyTitle(parsed.title);
    const artwork = findArtwork(filePath, slug);
    const contentHash = buildContentHash({
      title: parsed.title,
      songmeaning: parsed.songmeaning,
      lyrics: parsed.lyrics,
      artwork
    });
    const enrichedSong = {
      ...parsed,
      slug,
      artwork,
      contentHash
    };
    const result = validateSong(enrichedSong);

    if (result.status === "rejected") {
      return buildRejectedResult();
    }

    if (result.status === "skipped") {
      return buildSkippedResult(result.song);
    }

    if (isDryRun) {
      return buildProcessedResult(result.song, false, false);
    }

    let existingSong = null;
    try {
      const existing = await dynamo.send(new GetCommand({
        TableName: SONGS_TABLE_NAME,
        Key: { songId: result.song.slug }
      }));
      existingSong = existing?.Item || null;
    } catch (error) {
      return buildErrorResult("dynamodb_write_failed", result.song.slug);
    }

    const existingHash = existingSong?.contentHash ? String(existingSong.contentHash) : null;
    if (existingHash === result.song.contentHash) {
      return buildProcessedResult(result.song, false, false);
    }

    const changeType = existingSong ? "update" : "create";
    const nextSongItem = {
      songId: result.song.slug,
      title: result.song.title,
      normalizedTitle: result.song.slug,
      songMeaning: result.song.songmeaning,
      lyrics: result.song.lyrics,
      artwork: result.song.artwork,
      contentHash: result.song.contentHash,
      status: "coming_soon",
      releaseDetected: false,
      source: "cli",
      createdAt: existingSong?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    try {
      await dynamo.send(new PutCommand({
        TableName: SONGS_TABLE_NAME,
        Item: nextSongItem
      }));
    } catch (error) {
      return buildErrorResult("dynamodb_write_failed", result.song.slug);
    }

    let eventLogged = true;
    try {
      const eventSong = {
        ...result.song,
        changeType
      };
      await dynamo.send(new PutCommand({
        TableName: DYNAMO_TABLE_NAME,
        Item: buildCliEventStreamItem(eventSong),
        ConditionExpression: "attribute_not_exists(id)"
      }));
    } catch (error) {
      eventLogged = false;
    }

    return buildProcessedResult(result.song, true, eventLogged);
  } catch (error) {
    const reason = error && error.code === "ENOENT" ? "parsing_failed" : "unknown";
    return buildErrorResult(reason, null);
  }
}

main()
  .then((output) => {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  })
  .catch(() => {
    process.stdout.write(`${JSON.stringify(buildErrorResult("unknown", null), null, 2)}\n`);
  });
