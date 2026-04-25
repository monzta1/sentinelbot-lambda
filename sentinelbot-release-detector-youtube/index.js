const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, ScanCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const sns = new SNSClient({ region: "us-east-1" });
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN || "";

const TABLE_NAME = process.env.DYNAMO_TABLE || "shieldbearer-sentinel-logs";
const EVENT_STREAM_TABLE_NAME = process.env.EVENT_STREAM_TABLE_NAME || "EventStream";
const SONGS_TABLE_NAME = process.env.SONGS_TABLE_NAME || "shieldbearer-songs";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || "";
const MAX_SCAN_RESULTS = Math.max(1, Number.parseInt(process.env.YOUTUBE_RELEASE_SCAN_LIMIT || "100", 10) || 100);
const WATCHER_KEY = "releasewatcher#youtube";
const EVENT_PREFIX = "releaseevent#youtube#";
const EVENT_STREAM_PK = "eventstream";
const DEBUG_FILTER = String(process.env.DEBUG_FILTER || "").toLowerCase() === "true";

function nowIso() {
  return new Date().toISOString();
}

function buildTraceId(videoId) {
  return `youtube:${String(videoId || "").trim()}`;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeSongTitle(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSongDescription(value) {
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

  const looksStructured = sectionCount >= 2 || (sectionCount >= 1 && lyricLineCount >= 3) || lyricLineCount >= 6;
  if (!looksStructured) return "";

  const lyrics = normalizeLyricsBlock(kept.join("\n"));
  return lyrics.length >= 100 ? lyrics : "";
}

function isShortFormTitle(value) {
  const normalized = normalizeText(value || "").toLowerCase();
  return (
    normalized.includes("#shorts") ||
    /\bshort\b/.test(normalized) ||
    /\bshorts\b/.test(normalized) ||
    normalized.includes("short form") ||
    normalized.includes("short video")
  );
}

function isShortFormEntry(title, durationSeconds) {
  return isShortFormTitle(title) || Number(durationSeconds || 0) > 0 && Number(durationSeconds || 0) < 120;
}

function buildSongContextFromDescription(description, title = "") {
  const normalized = normalizeSongDescription(description);
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

function parseTimestamp(value) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

function getReleaseMetadata(video) {
  const title = normalizeText(video?.title || "");
  const titleLower = title.toLowerCase();
  const durationSeconds = Number(video?.durationSeconds || 0);
  const hasHashShorts = titleLower.includes("#shorts");
  const tooShortForRelease = durationSeconds < 45;
  const releaseKeywords = ["music", "official", "single", "lyric", "live"];
  const score = releaseKeywords.reduce((total, keyword) => (
    titleLower.includes(keyword) ? total + 1 : total
  ), 0);
  const lowConfidence = score === 0 && durationSeconds < 45;
  const isCandidate = !(hasHashShorts || tooShortForRelease);

  return {
    isCandidate,
    rejectionReason: hasHashShorts
      ? "title_contains_shorts_hashtag"
      : tooShortForRelease
        ? "duration_below_45_seconds"
        : lowConfidence
          ? "low_confidence_candidate"
          : null,
    score,
    durationSeconds,
    lowConfidence,
    debugBypass: DEBUG_FILTER && !hasHashShorts && !tooShortForRelease && score === 0
  };
}

function isReleaseCandidate(video) {
  return getReleaseMetadata(video).isCandidate;
}

function logStage(event, details) {
  console.log(JSON.stringify({
    stage: event,
    timestamp: nowIso(),
    ...details
  }));
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`YouTube API HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchUploadsPlaylistId() {
  if (!YOUTUBE_API_KEY || !YOUTUBE_CHANNEL_ID) {
    throw new Error("Missing YOUTUBE_API_KEY or YOUTUBE_CHANNEL_ID");
  }

  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "contentDetails");
  url.searchParams.set("id", YOUTUBE_CHANNEL_ID);
  url.searchParams.set("key", YOUTUBE_API_KEY);

  const data = await fetchJson(url.toString());
  const uploadsPlaylistId = data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || "";
  if (!uploadsPlaylistId) {
    throw new Error("Could not resolve uploads playlist from channel");
  }
  return uploadsPlaylistId;
}

async function fetchLatestVideos({ playlistId, limit }) {
  const videos = [];
  let pageToken = "";

  while (videos.length < limit) {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "contentDetails,snippet");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("maxResults", String(Math.min(50, limit - videos.length)));
    url.searchParams.set("key", YOUTUBE_API_KEY);
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const data = await fetchJson(url.toString());
    for (const item of data?.items || []) {
      const videoId = item?.contentDetails?.videoId || "";
      if (!videoId) continue;

      videos.push({
        videoId,
        title: normalizeText(item?.snippet?.title || ""),
        description: normalizeText(item?.snippet?.description || ""),
        publishedAt: item?.contentDetails?.videoPublishedAt || item?.snippet?.publishedAt || "",
        sourceUrl: `https://www.youtube.com/watch?v=${videoId}`
      });

      if (videos.length >= limit) break;
    }

    pageToken = data?.nextPageToken || "";
    if (!pageToken) break;
  }

  return videos;
}

async function fetchVideoDetails(videoIds) {
  const ids = Array.from(new Set((videoIds || []).filter(Boolean)));
  const details = new Map();

  for (let index = 0; index < ids.length; index += 50) {
    const batch = ids.slice(index, index + 50);
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("key", YOUTUBE_API_KEY);

    const data = await fetchJson(url.toString());
    for (const item of data?.items || []) {
      const videoId = item?.id || "";
      if (!videoId) continue;
      details.set(videoId, {
        duration: item?.contentDetails?.duration || "",
        durationSeconds: parseIsoDuration(item?.contentDetails?.duration || "")
      });
    }
  }

  return details;
}

async function loadWatcherState() {
  const response = await dynamo.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      id: WATCHER_KEY
    }
  }));
  return response?.Item || null;
}

function buildReleaseEventItem(video) {
  const releaseKey = `${EVENT_PREFIX}${video.videoId}`;
  const timestamp = nowIso();
  const description = normalizeText(video.description || "");
  const lyrics = extractLyricsFromDescription(description);
  const shortForm = isShortFormEntry(video.title, video.durationSeconds);
  const traceId = buildTraceId(video.videoId);
  return {
    id: video.videoId,
    traceId,
    pk: releaseKey,
    sk: releaseKey,
    eventType: "new_content_detected",
    source: "youtube",
    title: video.title,
    description,
    descriptionNormalized: normalizeSongTitle(description),
    lyrics,
    lyricsSource: lyrics ? "youtube_description" : "",
    lyricsConfidence: lyrics ? "medium" : "",
    contentFormat: shortForm ? "short" : "full",
    isShort: shortForm,
    excludeFromTimeline: shortForm,
    publishedAt: video.publishedAt,
    sourceUrl: video.sourceUrl,
    processed: false,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function buildSongItem(video) {
  const timestamp = nowIso();
  const title = normalizeText(video.title || "");
  const normalizedTitle = normalizeSongTitle(title);
  const canonicalTitle = normalizedTitle.replace(/\s+(official|lyric|video|short|shorts|chorus)\b.*$/i, "").trim() || normalizedTitle;
  const meaningUrl = `https://shieldbearerusa.com/song-meanings.html#${normalizedTitle.replace(/\s+/g, "-")}`;
  const description = normalizeText(video.description || "");
  const descriptionNormalized = normalizeSongDescription(description);
  const songContext = buildSongContextFromDescription(description, title);
  const lyrics = extractLyricsFromDescription(description);
  const shortForm = isShortFormEntry(title, video.durationSeconds);
  const traceId = buildTraceId(video.videoId);

  return {
    songId: video.videoId,
    traceId,
    pk: video.videoId,
    title,
    normalizedTitle,
    canonicalTitle,
    normalizedCanonicalTitle: normalizeSongTitle(canonicalTitle),
    meaningUrl,
    description,
    descriptionNormalized,
    lyrics,
    lyricsSource: lyrics ? "youtube_description" : "",
    lyricsConfidence: lyrics ? "medium" : "",
    contentFormat: shortForm ? "short" : "full",
    isShort: shortForm,
    excludeFromTimeline: shortForm,
    songContext,
    songContextTheme: songContext.theme,
    songContextMeaning: songContext.meaning,
    songContextSummary: songContext.summary,
    publishedAt: video.publishedAt || "",
    youtubeUrl: video.sourceUrl || "",
    duration: video.duration || "",
    durationSeconds: Number(video.durationSeconds || 0),
    type: "official_release",
    source: "youtube",
    // status + releaseDetected are what the publisher reads to bucket
    // a song into released[]. Without them, the song is treated as a
    // draft and never reaches homepage.featuredRelease.
    status: "released",
    releaseDetected: true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function buildEventStreamItem(releaseEvent) {
  const songId = String(releaseEvent.songId || releaseEvent.id || "").trim();
  const timestamp = String(releaseEvent.timestamp || releaseEvent.publishedAt || nowIso()).trim();
  const source = String(releaseEvent.source || "release-detector-youtube").trim();
  const eventType = String(releaseEvent.eventType || "SONG_RELEASED").trim();
  const streamKey = timestamp;
  const lyrics = String(releaseEvent.lyrics || releaseEvent.songContextSummary || "").trim();
  const artworkUrl = String(releaseEvent.artworkUrl || releaseEvent.sourceUrl || releaseEvent.youtubeUrl || "").trim();
  const songMeaning = String(releaseEvent.songMeaning || releaseEvent.songContextMeaning || releaseEvent.songContextSummary || "").trim();
  return {
    id: `${songId}#${streamKey}#${eventType}`,
    songId,
    title: String(releaseEvent.title || "").trim(),
    youtubeUrl: String(releaseEvent.youtubeUrl || releaseEvent.sourceUrl || "").trim(),
    sourceUrl: String(releaseEvent.sourceUrl || releaseEvent.youtubeUrl || "").trim(),
    timestamp,
    publishedAt: String(releaseEvent.publishedAt || timestamp).trim(),
    stateAfter: String(releaseEvent.stateAfter || "released").trim(),
    traceId: releaseEvent.traceId || buildTraceId(songId),
    pk: songId,
    sk: streamKey,
    eventType,
    source,
    payload: {
      id: songId,
      songId,
      title: String(releaseEvent.title || "").trim(),
      youtubeUrl: String(releaseEvent.youtubeUrl || releaseEvent.sourceUrl || "").trim(),
      sourceUrl: String(releaseEvent.sourceUrl || releaseEvent.youtubeUrl || "").trim(),
      timestamp,
      publishedAt: String(releaseEvent.publishedAt || timestamp).trim(),
      stateAfter: String(releaseEvent.stateAfter || "released").trim(),
      eventType,
      source,
      lyrics,
      artworkUrl,
      artwork: artworkUrl,
      songMeaning
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function writeReleaseEvent(video) {
  const item = buildReleaseEventItem(video);
  try {
    await dynamo.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
      ConditionExpression: "attribute_not_exists(id)"
    }));
    return { created: true, item };
  } catch (error) {
    if (error?.name === "ConditionalCheckFailedException") {
      return { created: false, item, duplicate: true };
    }
    throw error;
  }
}

async function writeEventStream(releaseEvent) {
  const item = buildEventStreamItem(releaseEvent);
  try {
    await dynamo.send(new PutCommand({
      TableName: EVENT_STREAM_TABLE_NAME,
      Item: item,
      ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)"
    }));
    return { created: true, item };
  } catch (error) {
    if (error?.name === "ConditionalCheckFailedException") {
      return { created: false, item, duplicate: true };
    }
    console.error(error);
    throw error;
  }
}

// Find a coming_soon song record (typically written by shield-cli from a
// dropzone ingest) whose normalized title matches this YouTube release.
// Returns the first match or null. Used to carry user-authored lyrics,
// songMeaning, and artwork onto the new released record so the homepage
// and song-meanings dossier render with the polished content the user
// staged ahead of release.
async function findDraftSongByTitle(normalizedTitleTarget) {
  if (!normalizedTitleTarget) return null;
  let exclusiveStartKey;
  do {
    const response = await dynamo.send(new ScanCommand({
      TableName: SONGS_TABLE_NAME,
      FilterExpression: "#status = :status",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":status": "coming_soon" },
      ExclusiveStartKey: exclusiveStartKey,
      Limit: 100
    }));
    for (const item of response?.Items || []) {
      const candidate = normalizeSongTitle(item?.title || "");
      const canonical = normalizeSongTitle(item?.canonicalTitle || "");
      if (candidate === normalizedTitleTarget || canonical === normalizedTitleTarget) {
        return item;
      }
    }
    exclusiveStartKey = response?.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return null;
}

// Merge user-authored fields from a coming_soon draft onto the new
// released record so YouTube release transitions inherit the polished
// content. Draft fields win over auto-extracted ones for lyrics,
// songMeaning, and artwork.
function mergeDraftOntoSongItem(songItem, draft) {
  if (!draft) return songItem;
  const merged = { ...songItem };
  if (draft.lyrics) {
    merged.lyrics = draft.lyrics;
    merged.lyricsSource = draft.lyricsSource || "shield-cli-dropzone";
    merged.lyricsConfidence = draft.lyricsConfidence || "high";
  }
  // Shield-cli stores the meaning under lowercase `songmeaning`; the
  // publisher reads camelCase `songMeaning`. Accept either input shape
  // and always write canonical camelCase to the released record.
  const draftMeaning = draft.songMeaning || draft.songmeaning;
  if (draftMeaning) {
    merged.songMeaning = draftMeaning;
  }
  // Shield-cli stores the published CDN URL under `artworkUrl` and the
  // raw source filename under `artwork`. Prefer the URL; fall back to
  // `artwork` only if it looks like a URL (starts with http).
  const draftArtworkUrl = draft.artworkUrl
    || (typeof draft.artwork === "string" && /^https?:\/\//i.test(draft.artwork) ? draft.artwork : "");
  if (draftArtworkUrl) {
    merged.artwork = draftArtworkUrl;
  }
  if (draft.songId && draft.songId !== merged.songId) {
    merged.draftSongId = draft.songId;
  }
  // The merged record represents a released song no matter what state
  // the draft was in; explicitly stamp the released markers.
  merged.status = "released";
  merged.releaseDetected = true;
  return merged;
}

// Send a heartbeat email summarizing the scan. Configured via env var
// SNS_TOPIC_ARN. Always best-effort: a publish failure must never break
// the scan flow.
async function publishScanSummary(payload) {
  if (!SNS_TOPIC_ARN) return;
  const ok = payload.status === "ok";
  const lines = [];
  lines.push(ok ? "Scan completed." : "Scan FAILED.");
  lines.push(`Time (UTC): ${payload.timestamp || nowIso()}`);
  if (ok) {
    lines.push(`Videos scanned: ${payload.scannedCount || 0}`);
    lines.push(`New release candidates: ${payload.detectedCount || 0}`);
    lines.push(`Events created: ${payload.createdCount || 0}`);
    if (payload.duplicateCount) lines.push(`Duplicates skipped: ${payload.duplicateCount}`);
    if (Array.isArray(payload.detectedTitles) && payload.detectedTitles.length) {
      lines.push("");
      lines.push("New releases detected:");
      for (const title of payload.detectedTitles) lines.push(`  - ${title}`);
    } else {
      lines.push("");
      lines.push("No new releases this run.");
    }
  } else {
    lines.push(`Error: ${payload.error || "unknown"}`);
  }
  lines.push("");
  lines.push(`Elapsed: ${payload.elapsedMs || 0}ms`);

  const subject = ok
    ? `[SentinelBot] Weekly YouTube scan: ${payload.detectedCount || 0} new`
    : "[SentinelBot] Weekly YouTube scan FAILED";

  try {
    await sns.send(new PublishCommand({
      TopicArn: SNS_TOPIC_ARN,
      Subject: subject.slice(0, 100),
      Message: lines.join("\n")
    }));
  } catch (error) {
    logStage("sns-publish-failed", { error: error?.message || String(error) });
  }
}

async function deleteDraftSong(draftSongId) {
  if (!draftSongId) return;
  try {
    await dynamo.send(new DeleteCommand({
      TableName: SONGS_TABLE_NAME,
      Key: { songId: draftSongId }
    }));
  } catch (error) {
    logStage("draft-song-delete-failed", {
      draftSongId,
      error: error?.message || String(error)
    });
  }
}

async function writeSongItem(video) {
  let item = buildSongItem(video);

  // Look up any matching coming_soon draft by normalized title and pull
  // its user-authored fields onto the released record.
  let draft = null;
  try {
    draft = await findDraftSongByTitle(item.normalizedCanonicalTitle || item.normalizedTitle || "");
  } catch (error) {
    logStage("draft-lookup-failed", {
      videoId: video.videoId,
      title: video.title,
      error: error?.message || String(error)
    });
  }
  if (draft) {
    item = mergeDraftOntoSongItem(item, draft);
    logStage("draft-merged-onto-release", {
      videoId: video.videoId,
      title: video.title,
      draftSongId: draft.songId,
      mergedLyrics: Boolean(draft.lyrics),
      mergedSongMeaning: Boolean(draft.songMeaning),
      mergedArtwork: Boolean(draft.artwork)
    });
  }

  try {
    await dynamo.send(new PutCommand({
      TableName: SONGS_TABLE_NAME,
      Item: item,
      ConditionExpression: "attribute_not_exists(songId)"
    }));
    if (draft && draft.songId !== item.songId) {
      await deleteDraftSong(draft.songId);
    }
    return { created: true, item };
  } catch (error) {
    if (error?.name === "ConditionalCheckFailedException") {
      return { created: false, item, duplicate: true };
    }
    throw error;
  }
}

async function updateWatcherState({
  playlistId,
  newestVideo,
  scannedCount,
  newEventCount,
  lastKnownVideoId,
  lastKnownPublishedAt
}) {
  const timestamp = nowIso();
  const newestVideoId = newestVideo?.videoId || lastKnownVideoId || null;
  const newestPublishedAt = newestVideo?.publishedAt || lastKnownPublishedAt || null;

  // Several attribute names here are DynamoDB reserved words (`source`,
  // `processed`). Alias every field via ExpressionAttributeNames to be
  // safe against future renames hitting another reserved word.
  const expressionNames = {
    "#pk": "pk",
    "#sk": "sk",
    "#source": "source",
    "#playlistId": "playlistId",
    "#latestVideoId": "latestVideoId",
    "#latestPublishedAt": "latestPublishedAt",
    "#lastProcessedAt": "lastProcessedAt",
    "#scannedCount": "scannedCount",
    "#newEventCount": "newEventCount",
    "#processed": "processed",
    "#updatedAt": "updatedAt"
  };

  const expressionValues = {
    ":pk": WATCHER_KEY,
    ":sk": WATCHER_KEY,
    ":source": "youtube",
    ":playlistId": playlistId || "",
    ":latestVideoId": newestVideoId,
    ":latestPublishedAt": newestPublishedAt,
    ":lastProcessedAt": timestamp,
    ":scannedCount": scannedCount,
    ":newEventCount": newEventCount,
    ":processed": Boolean(newEventCount > 0),
    ":updatedAt": timestamp
  };

  const updateExpression = [
    "SET #pk = :pk",
    "#sk = :sk",
    "#source = :source",
    "#playlistId = :playlistId",
    "#latestVideoId = :latestVideoId",
    "#latestPublishedAt = :latestPublishedAt",
    "#lastProcessedAt = :lastProcessedAt",
    "#scannedCount = :scannedCount",
    "#newEventCount = :newEventCount",
    "#processed = :processed",
    "#updatedAt = :updatedAt"
  ].join(", ");

  await dynamo.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      id: WATCHER_KEY
    },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: expressionValues
  }));
}

function shouldStopScanning(videoId, lastSeenVideoId) {
  return Boolean(lastSeenVideoId && videoId === lastSeenVideoId);
}

exports.handler = async () => {
  const startedAt = Date.now();
  const requestTimestamp = nowIso();

  try {
    const playlistId = await fetchUploadsPlaylistId();
    const state = await loadWatcherState();
    const lastSeenVideoId = state?.latestVideoId || null;
    const lastSeenPublishedAt = state?.latestPublishedAt || null;
    const videos = await fetchLatestVideos({
      playlistId,
      limit: MAX_SCAN_RESULTS
    });
    const videoDetails = await fetchVideoDetails(videos.map((video) => video.videoId));
    const enrichedVideos = videos.map((video) => ({
      ...video,
      ...videoDetails.get(video.videoId)
    }));

    const newVideos = [];
    for (const video of enrichedVideos) {
      if (shouldStopScanning(video.videoId, lastSeenVideoId)) {
        break;
      }
      const candidateCheck = getReleaseMetadata(video);
      logStage("youtube-release-candidate-evaluated", {
        traceId: buildTraceId(video.videoId),
        videoId: video.videoId,
        title: video.title,
        durationSeconds: candidateCheck.durationSeconds,
        isCandidate: candidateCheck.isCandidate,
        rejectionReason: candidateCheck.rejectionReason,
        score: candidateCheck.score,
        lowConfidence: candidateCheck.lowConfidence,
        debugFilter: DEBUG_FILTER,
        debugBypass: candidateCheck.debugBypass
      });
      if (!isReleaseCandidate(video)) {
        continue;
      }
      newVideos.push(video);
    }

    const events = [];
    let duplicateCount = 0;

    for (const video of newVideos) {
      const result = await writeReleaseEvent(video);
      if (result.created) {
        try {
          await writeSongItem(video);
          events.push(result.item);
          void writeEventStream({
            eventType: "SONG_RELEASED",
            songId: video.videoId,
            title: video.title,
            youtubeUrl: video.sourceUrl,
            sourceUrl: video.sourceUrl,
            timestamp: nowIso(),
            publishedAt: video.publishedAt || nowIso(),
            stateAfter: "released",
            source: "release-detector-youtube",
            traceId: buildTraceId(video.videoId),
            lyrics: video.lyrics || "",
            artworkUrl: video.sourceUrl || "",
            artwork: video.sourceUrl || "",
            songMeaning: video.songContextMeaning || video.songContextSummary || ""
          }).catch((error) => {
            logStage("song-release-eventstream-write-failed", {
              traceId: buildTraceId(video.videoId),
              videoId: video.videoId,
              title: video.title,
              error: error.message
            });
          });
        } catch (error) {
          logStage("song-table-write-failed", {
            traceId: buildTraceId(video.videoId),
            videoId: video.videoId,
            title: video.title,
            error: error.message
          });
        }
      } else if (result.duplicate) {
        duplicateCount += 1;
      }
    }

    const newestVideo = videos[0] || null;
    await updateWatcherState({
      playlistId,
      newestVideo,
      scannedCount: enrichedVideos.length,
      newEventCount: events.length,
      lastKnownVideoId: lastSeenVideoId,
      lastKnownPublishedAt: lastSeenPublishedAt
    });

    const elapsedMs = Date.now() - startedAt;
    logStage("youtube-release-scan-complete", {
      timestamp: requestTimestamp,
      traceIds: events.map((event) => event.traceId || null).filter(Boolean),
      scannedCount: enrichedVideos.length,
      detectedCount: newVideos.length,
      createdCount: events.length,
      duplicateCount,
      newestVideoId: newestVideo?.videoId || null,
      newestPublishedAt: newestVideo?.publishedAt || null,
      elapsedMs
    });

    await publishScanSummary({
      status: "ok",
      timestamp: requestTimestamp,
      scannedCount: enrichedVideos.length,
      detectedCount: newVideos.length,
      createdCount: events.length,
      duplicateCount,
      detectedTitles: newVideos.map((video) => video.title).filter(Boolean),
      elapsedMs
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        source: "youtube",
        scannedCount: enrichedVideos.length,
        detectedCount: newVideos.length,
        createdCount: events.length,
        duplicateCount,
        newestVideoId: newestVideo?.videoId || null,
        newestPublishedAt: newestVideo?.publishedAt || null
      })
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logStage("youtube-release-scan-failed", {
      timestamp: requestTimestamp,
      error: error.message,
      traceId: null,
      elapsedMs
    });

    await publishScanSummary({
      status: "failed",
      timestamp: requestTimestamp,
      error: error.message,
      elapsedMs
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: error.message
      })
    };
  }
};

module.exports = {
  handler: exports.handler,
  fetchUploadsPlaylistId,
  fetchLatestVideos,
  fetchVideoDetails,
  buildReleaseEventItem,
  getReleaseMetadata,
  isReleaseCandidate,
  buildSongItem,
  writeSongItem,
  normalizeSongTitle
};
