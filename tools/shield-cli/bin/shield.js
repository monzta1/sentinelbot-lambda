#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SONGS_TABLE_NAME = process.env.SONGS_TABLE_NAME || "shieldbearer-songs";

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

function validateSong(parsed) {
  const song = {
    title: parsed && parsed.title != null ? String(parsed.title) : null,
    songmeaning: parsed && parsed.songmeaning != null ? String(parsed.songmeaning) : null,
    lyrics: parsed && parsed.lyrics != null ? String(parsed.lyrics) : null,
    slug: parsed && parsed.slug != null ? String(parsed.slug) : null,
    artwork: parsed && parsed.artwork != null ? String(parsed.artwork) : null
  };

  if (!song.title) {
    return {
      status: "rejected",
      triggerMatched: false,
      reason: "missing title",
      song
    };
  }

  if (song.lyrics || song.songmeaning) {
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

if (!fileArg) {
  process.stdout.write(helpText);
  process.exit(0);
}

const filePath = path.resolve(process.cwd(), fileArg);
const rawContent = fs.readFileSync(filePath, "utf8");
const parsed = parseFile(rawContent);
const slug = slugifyTitle(parsed.title);
const artwork = findArtwork(filePath, slug);
const enrichedSong = {
  ...parsed,
  slug,
  artwork
};
const result = validateSong(enrichedSong);

async function upsertSong(songResult) {
  if (songResult.status !== "processed" || isDryRun) {
    return songResult;
  }

  const song = songResult.song;
  try {
    await dynamo.send(new PutCommand({
      TableName: SONGS_TABLE_NAME,
      Item: {
        songId: song.slug,
        title: song.title,
        normalizedTitle: song.slug,
        songMeaning: song.songmeaning,
        lyrics: song.lyrics,
        artwork: song.artwork,
        status: "coming_soon",
        releaseDetected: false,
        source: "cli",
        createdAt: new Date().toISOString()
      }
    }));
    return songResult;
  } catch (error) {
    return {
      status: "error",
      reason: "dynamodb_write_failed"
    };
  }
}

(async () => {
  const finalResult = await upsertSong(result);
  process.stdout.write(`${JSON.stringify(finalResult, null, 2)}\n`);
})().catch(() => {
  process.stdout.write(`${JSON.stringify({ status: "error", reason: "dynamodb_write_failed" }, null, 2)}\n`);
});
