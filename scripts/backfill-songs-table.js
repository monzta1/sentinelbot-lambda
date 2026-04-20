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
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

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

function normalizeDescription(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}\s.,!?;:'"’()-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function extractLyricsFromDescription(description) {
  const lines = String(description || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return "";

  const noisePatterns = [
    /https?:\/\//i,
    /\b(spotify|youtube|subscribe|follow|merch|pre-save|stream|watch|official video|out now|available now|link in bio|shorts)\b/i
  ];
  const sectionPattern = /^(?:[\(\[]?\s*(verse|chorus|bridge|intro|outro|pre-chorus|hook)(?:\s*\d+)?\s*[\)\]]?\s*[:\-–—]?\s*)$/i;

  const kept = [];
  let sectionCount = 0;
  let lyricLineCount = 0;

  for (const line of lines) {
    if (noisePatterns.some((pattern) => pattern.test(line))) {
      continue;
    }

    if (sectionPattern.test(line)) {
      sectionCount += 1;
      kept.push(line.replace(/[:\-–—\s]+$/g, "").trim());
      continue;
    }

    const wordCount = line.split(/\s+/).filter(Boolean).length;
    const lyricish = wordCount > 0 && wordCount <= 14 && /[A-Za-z]/.test(line);
    if (lyricish) {
      lyricLineCount += 1;
      kept.push(line);
    }
  }

  const looksStructured = sectionCount >= 2 || (sectionCount >= 1 && lyricLineCount >= 4) || lyricLineCount >= 10;
  if (!looksStructured) return "";

  const lyrics = normalizeLyricsBlock(kept.join("\n"));
  return lyrics.length >= 100 ? lyrics : "";
}

function buildSongContextFromDescription(description, title = "") {
  const normalized = normalizeDescription(description);
  const fallbackTitle = String(title || "").trim();
  if (!normalized) {
    return {
      theme: "",
      meaning: "",
      spiritualTone: "",
      scriptureReferences: [],
      summary: ""
    };
  }

  const sentences = normalized
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => !/https?:\/\//i.test(sentence))
    .filter((sentence) => !/\b(spotify|youtube|subscribe|watch|stream|official video|out now|available now|follow|merch|pre-save|shorts)\b/i.test(sentence));

  const first = sentences[0] || normalized;
  const second = sentences[1] || "";
  const spiritualKeywords = ["christ", "jesus", "god", "grace", "gospel", "cross", "salvation", "redemption", "faith", "scripture", "worship", "holy spirit"];
  const spiritualMatches = spiritualKeywords.filter((keyword) => normalized.toLowerCase().includes(keyword));
  const spiritualTone = spiritualMatches.length ? `Scripture-centered, ${spiritualMatches.slice(0, 3).join(", ")}` : "";
  const summaryParts = [first, second].filter(Boolean);
  if (spiritualTone) summaryParts.push(spiritualTone);

  return {
    theme: first || fallbackTitle,
    meaning: summaryParts.join(" ").trim() || fallbackTitle,
    spiritualTone,
    scriptureReferences: [],
    summary: summaryParts.join(" ").trim() || fallbackTitle
  };
}

function parseIsoDuration(duration) {
  const match = String(duration || "").match(
    /^P(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/
  );
  if (!match) return 0;
  const hours = Number.parseInt(match[1] || "0", 10);
  const minutes = Number.parseInt(match[2] || "0", 10);
  const seconds = Number.parseInt(match[3] || "0", 10);
  return (hours * 3600) + (minutes * 60) + seconds;
}

async function fetchYouTubeVideoDetails(videoIds) {
  if (!YOUTUBE_API_KEY) {
    return new Map();
  }

  const ids = Array.from(new Set((videoIds || []).filter(Boolean)));
  const details = new Map();

  for (let index = 0; index < ids.length; index += 50) {
    const batch = ids.slice(index, index + 50);
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,contentDetails");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("key", YOUTUBE_API_KEY);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`YouTube API HTTP ${response.status}`);
    }

    const data = await response.json();
    for (const item of data?.items || []) {
      const videoId = item?.id || "";
      if (!videoId) continue;
      const description = normalizeDescription(item?.snippet?.description || "");
      details.set(videoId, {
        description,
        descriptionNormalized: normalizeSongTitle(description),
        duration: item?.contentDetails?.duration || "",
        durationSeconds: parseIsoDuration(item?.contentDetails?.duration || "")
      });
    }
  }

  return details;
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
      const eventLyrics = extractLyricsFromDescription(event.description || "");
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
        description: event.description || "",
        descriptionNormalized: normalizeDescription(event.description || ""),
        lyrics: eventLyrics,
        lyricsSource: eventLyrics ? "youtube_description" : "",
        lyricsConfidence: eventLyrics ? "medium" : "",
        songContext: buildSongContextFromDescription(event.description || "", event.title || ""),
        type: "official_release",
        source: "youtube",
        createdAt: event.createdAt || new Date().toISOString(),
        updatedAt: event.updatedAt || new Date().toISOString()
      });
    }

    lastKey = response?.LastEvaluatedKey || null;
  } while (lastKey);

  const details = await fetchYouTubeVideoDetails(songs.map((song) => song.songId));

  return songs.map((song) => {
    const detail = details.get(song.songId) || {};
    const description = String(song.description || detail.description || "").trim();
    const lyrics = String(song.lyrics || detail.lyrics || extractLyricsFromDescription(description)).trim();
    return {
      ...song,
      description,
      descriptionNormalized: normalizeDescription(description),
      lyrics,
      lyricsSource: String(song.lyricsSource || detail.lyricsSource || (lyrics ? "youtube_description" : "")).trim(),
      lyricsConfidence: String(song.lyricsConfidence || detail.lyricsConfidence || (lyrics ? "medium" : "")).trim(),
      duration: song.duration || detail.duration || "",
      durationSeconds: Number(song.durationSeconds || 0) || Number(detail.durationSeconds || 0) || 0
    };
  });
}

function buildItem(song) {
  const title = String(song?.title || "").trim();
  const normalizedTitle = normalizeSongTitle(title);
  const canonicalTitle = String(song?.canonicalTitle || deriveCanonicalTitle(title)).trim();
  const meaningUrl = String(song?.meaningUrl || `https://shieldbearerusa.com/song-meanings.html#${String(song?.slug || song?.id || normalizedTitle).trim()}`).trim();
  const songContext = song?.songContext && typeof song.songContext === "object"
    ? song.songContext
    : buildSongContextFromDescription(song?.description || "", title);
  const lyrics = String(song?.lyrics || "").trim();
  const lyricsSource = String(song?.lyricsSource || "").trim();
  const lyricsConfidence = String(song?.lyricsConfidence || "").trim();
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
    description: String(song?.description || "").trim(),
    descriptionNormalized: normalizeDescription(song?.description || ""),
    lyrics,
    lyricsSource: lyricsSource || (lyrics ? "cached_parsed" : ""),
    lyricsConfidence: lyricsConfidence || (lyrics ? "low" : ""),
    songContext,
    songContextTheme: String(songContext.theme || "").trim(),
    songContextMeaning: String(songContext.meaning || "").trim(),
    songContextSummary: String(songContext.summary || "").trim(),
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
