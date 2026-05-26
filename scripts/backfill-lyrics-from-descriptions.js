#!/usr/bin/env node
/*
 * backfill-lyrics-from-descriptions
 * --------------------------------
 *
 * Walk every record in the `shieldbearer-songs` DynamoDB table. For each
 * record that has a YouTube videoId / sourceUrl but an empty `lyrics`
 * field, fetch the video description fresh from the YouTube Data API,
 * run extractLyricsFromDescription, and update the record if the
 * extractor produced ≥100 chars of lyrics. Idempotent: re-running
 * skips records that already have lyrics.
 *
 * One-off corrective script. Lives under scripts/ so it can be
 * rerun if a future extractor improvement opens up more songs.
 *
 *   YOUTUBE_API_KEY=<key> node scripts/backfill-lyrics-from-descriptions.js
 *   YOUTUBE_API_KEY=<key> DRY_RUN=1 node scripts/backfill-lyrics-from-descriptions.js
 *
 * After this finishes, invoke sentinelbot-site-publisher with
 * {approved: true, source: "youtube"} so site.json's released[]
 * entries pick up the new lyrics.
 */
"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const { extractLyricsFromDescription } = require("../sentinelbot-release-detector-youtube");

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.SONGS_TABLE_NAME || "shieldbearer-songs";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const DRY_RUN = String(process.env.DRY_RUN || "").trim() === "1";

if (!YOUTUBE_API_KEY) {
  console.error("YOUTUBE_API_KEY env var is required.");
  process.exit(1);
}

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

function videoIdFor(record) {
  if (record.videoId) return String(record.videoId).trim();
  if (record.songId && /^[A-Za-z0-9_-]{11}$/.test(record.songId)) {
    // YouTube video IDs are 11 chars in their well-known alphabet.
    return record.songId.trim();
  }
  const url = String(record.youtubeUrl || record.sourceUrl || "").trim();
  const match = url.match(/[?&]v=([^&#]+)/) || url.match(/youtu\.be\/([^?&#]+)/) || url.match(/embed\/([^?&#]+)/);
  return match ? match[1] : "";
}

async function fetchDescriptionsBatch(videoIds) {
  if (!videoIds.length) return new Map();
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("id", videoIds.join(","));
  url.searchParams.set("key", YOUTUBE_API_KEY);
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`YouTube API HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const out = new Map();
  for (const item of data.items || []) {
    out.set(item.id, String(item.snippet?.description || ""));
  }
  return out;
}

async function scanAllSongs() {
  const out = [];
  let exclusiveStartKey;
  do {
    const result = await dynamo.send(new ScanCommand({
      TableName: TABLE,
      ExclusiveStartKey: exclusiveStartKey
    }));
    for (const item of result.Items || []) out.push(item);
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return out;
}

async function updateLyrics(songId, lyrics) {
  await dynamo.send(new UpdateCommand({
    TableName: TABLE,
    Key: { songId },
    UpdateExpression: "SET lyrics = :l, lyricsSource = :s, lyricsConfidence = :c, updatedAt = :ts",
    ExpressionAttributeValues: {
      ":l": lyrics,
      ":s": "youtube_description_backfill",
      ":c": "medium",
      ":ts": new Date().toISOString()
    }
  }));
}

(async () => {
  console.log(`Scanning table=${TABLE} region=${REGION} dryRun=${DRY_RUN}`);
  const songs = await scanAllSongs();
  console.log(`Total records: ${songs.length}`);

  const candidates = songs
    .filter((s) => {
      const hasLyrics = String(s.lyrics || "").trim().length > 0;
      const vid = videoIdFor(s);
      return !hasLyrics && vid;
    })
    .map((s) => ({ songId: String(s.songId), videoId: videoIdFor(s), title: s.title || "" }));

  console.log(`Candidates (empty lyrics, has videoId): ${candidates.length}`);
  if (!candidates.length) {
    console.log("Nothing to backfill.");
    return;
  }

  let updated = 0;
  let skipped = 0;
  // YouTube API allows up to 50 ids per call.
  for (let i = 0; i < candidates.length; i += 50) {
    const batch = candidates.slice(i, i + 50);
    const descriptions = await fetchDescriptionsBatch(batch.map((c) => c.videoId));
    for (const c of batch) {
      const desc = descriptions.get(c.videoId) || "";
      if (!desc) {
        console.log(`SKIP no-description ${c.videoId} (${c.title})`);
        skipped += 1;
        continue;
      }
      const lyrics = extractLyricsFromDescription(desc);
      if (!lyrics) {
        console.log(`SKIP no-extraction ${c.videoId} (${c.title})`);
        skipped += 1;
        continue;
      }
      console.log(`UPDATE ${c.videoId} (${c.title}) lyrics_len=${lyrics.length}`);
      if (!DRY_RUN) {
        await updateLyrics(c.songId, lyrics);
      }
      updated += 1;
    }
  }
  console.log(`Done. updated=${updated} skipped=${skipped} dryRun=${DRY_RUN}`);
})().catch((err) => {
  console.error("backfill failed:", err);
  process.exit(2);
});
