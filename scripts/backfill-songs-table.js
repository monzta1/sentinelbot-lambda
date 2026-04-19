const fs = require("fs/promises");
const path = require("path");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, DeleteCommand, PutCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const repoRoot = path.resolve(__dirname, "..");
const songsIndexPath = path.join(repoRoot, "docs", "song-index.json");
const DYNAMO_TABLE_NAME = process.env.DYNAMO_TABLE || "shieldbearer-sentinel-logs";
const SONGS_TABLE_NAME = process.env.SONGS_TABLE_NAME || "shieldbearer-songs";
const BACKFILL_SOURCE = String(process.env.SONGS_BACKFILL_SOURCE || "eventstream").toLowerCase();
const REPLACE_EXISTING = String(process.env.SONGS_REPLACE_EXISTING || (BACKFILL_SOURCE === "eventstream" ? "true" : "false")).toLowerCase() === "true";

function normalizeSongTitle(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveCanonicalTitle(value) {
  const normalized = normalizeSongTitle(value);
  return normalized.replace(/\s+(official|lyric|video|short|shorts|chorus)\b.*$/i, "").trim() || normalized;
}

async function readSongIndex() {
  const raw = await fs.readFile(songsIndexPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid song index");
  }
  return parsed;
}

function normalizeEventPayload(item) {
  const payload = item?.payload || item || {};
  return {
    songId: String(payload.id || payload.songId || payload.pk || item?.id || "").trim(),
    title: String(payload.title || "").trim(),
    publishedAt: String(payload.publishedAt || "").trim(),
    youtubeUrl: String(payload.sourceUrl || payload.youtubeUrl || "").trim(),
    duration: String(payload.duration || "").trim(),
    durationSeconds: Number(payload.durationSeconds || 0),
    source: String(payload.source || "youtube").trim(),
    type: String(payload.type || "official_release").trim(),
    createdAt: String(payload.createdAt || item?.createdAt || "").trim(),
    updatedAt: String(payload.updatedAt || item?.updatedAt || "").trim()
  };
}

async function loadEventStreamSongs() {
  const songs = [];
  let lastKey = null;

  do {
    const response = await dynamo.send(new ScanCommand({
      TableName: DYNAMO_TABLE_NAME,
      FilterExpression: "#pk = :pk AND #source = :source AND #eventType = :eventType",
      ExpressionAttributeNames: {
        "#pk": "pk",
        "#source": "source",
        "#eventType": "eventType"
      },
      ExpressionAttributeValues: {
        ":pk": "eventstream",
        ":source": "youtube",
        ":eventType": "new_content_detected"
      },
      ExclusiveStartKey: lastKey || undefined
    }));

    for (const item of response?.Items || []) {
      const event = normalizeEventPayload(item);
      if (!event.songId || !event.title) continue;
      const canonicalTitle = deriveCanonicalTitle(event.title);
      songs.push({
        songId: event.songId,
        id: event.songId,
        slug: event.songId,
        title: event.title,
        normalizedTitle: normalizeSongTitle(event.title),
        canonicalTitle,
        normalizedCanonicalTitle: normalizeSongTitle(canonicalTitle),
        meaningUrl: `https://shieldbearerusa.com/song-meanings.html#${normalizeSongTitle(event.title).replace(/\s+/g, "-")}`,
        publishedAt: event.publishedAt,
        youtubeUrl: event.youtubeUrl,
        duration: event.duration,
        durationSeconds: event.durationSeconds,
        type: "official_release",
        source: "youtube",
        createdAt: event.createdAt || new Date().toISOString(),
        updatedAt: event.updatedAt || new Date().toISOString()
      });
    }

    lastKey = response?.LastEvaluatedKey || null;
  } while (lastKey);

  return songs;
}

function buildItem(song) {
  const title = String(song?.title || "").trim();
  const normalizedTitle = normalizeSongTitle(title);
  const canonicalTitle = String(song?.canonicalTitle || deriveCanonicalTitle(title)).trim();
  const meaningUrl = String(song?.meaningUrl || `https://shieldbearerusa.com/song-meanings.html#${String(song?.slug || song?.id || normalizedTitle).trim()}`).trim();
  return {
    songId: String(song?.songId || song?.id || normalizedTitle).trim(),
    pk: String(song?.songId || song?.id || normalizedTitle).trim(),
    title,
    normalizedTitle,
    canonicalTitle,
    normalizedCanonicalTitle: normalizeSongTitle(canonicalTitle),
    meaningUrl,
    publishedAt: String(song?.publishedAt || "").trim(),
    youtubeUrl: String(song?.actions?.youtube || song?.sourceUrl || "").trim(),
    duration: String(song?.duration || "").trim(),
    type: "official_release",
    releaseLabel: String(song?.releaseLabel || "").trim(),
    meaningUrl: String(song?.meaningUrl || "").trim(),
    summary: String(song?.meaningSummary || song?.thesis || "").trim(),
    genre: String(song?.genre || "").trim(),
    reference: String(song?.reference || "").trim(),
    artwork: String(song?.artwork || "").trim(),
    tags: Array.isArray(song?.tags) ? song.tags : [],
    source: "catalog-backfill",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function clearSongsTable() {
  let lastKey = null;
  let deleted = 0;
  do {
    const response = await dynamo.send(new ScanCommand({
      TableName: SONGS_TABLE_NAME,
      ProjectionExpression: "songId",
      ExclusiveStartKey: lastKey || undefined
    }));

    for (const item of response?.Items || []) {
      const songId = String(item?.songId || "").trim();
      if (!songId) continue;
      await dynamo.send(new DeleteCommand({
        TableName: SONGS_TABLE_NAME,
        Key: {
          songId
        }
      }));
      deleted += 1;
    }

    lastKey = response?.LastEvaluatedKey || null;
  } while (lastKey);

  return deleted;
}

async function main() {
  const index = BACKFILL_SOURCE === "eventstream" ? null : await readSongIndex();
  const songs = BACKFILL_SOURCE === "eventstream"
    ? await loadEventStreamSongs()
    : (Array.isArray(index.songs) ? index.songs : []);
  let created = 0;
  let skipped = 0;

  if (REPLACE_EXISTING) {
    const deleted = await clearSongsTable();
    console.log(JSON.stringify({
      ok: true,
      songsTable: SONGS_TABLE_NAME,
      deleted
    }));
  }

  for (const song of songs) {
    const item = buildItem(song);
    try {
      await dynamo.send(new PutCommand({
        TableName: SONGS_TABLE_NAME,
        Item: item,
        ConditionExpression: "attribute_not_exists(songId)"
      }));
      created += 1;
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }

  console.log(JSON.stringify({
    ok: true,
    songsTable: SONGS_TABLE_NAME,
    source: BACKFILL_SOURCE,
    replaced: REPLACE_EXISTING,
    totalSongs: songs.length,
    created,
    skipped
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
