const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.DYNAMO_TABLE || "shieldbearer-sentinel-logs";
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
  return {
    id: video.videoId,
    pk: releaseKey,
    sk: releaseKey,
    eventType: "new_content_detected",
    source: "youtube",
    title: video.title,
    description,
    descriptionNormalized: normalizeSongTitle(description),
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

  return {
    songId: video.videoId,
    pk: video.videoId,
    title,
    normalizedTitle,
    canonicalTitle,
    normalizedCanonicalTitle: normalizeSongTitle(canonicalTitle),
    meaningUrl,
    description,
    descriptionNormalized,
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
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function buildEventStreamItem(releaseEvent) {
  const streamKey = `${releaseEvent.publishedAt}#${releaseEvent.source}#${releaseEvent.id}`;
  const timestamp = nowIso();
  return {
    id: `${EVENT_STREAM_PK}#${streamKey}`,
    pk: EVENT_STREAM_PK,
    sk: streamKey,
    eventType: releaseEvent.eventType,
    source: releaseEvent.source,
    payload: releaseEvent,
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

async function writeSongItem(video) {
  const item = buildSongItem(video);
  try {
    await dynamo.send(new PutCommand({
      TableName: SONGS_TABLE_NAME,
      Item: item,
      ConditionExpression: "attribute_not_exists(songId)"
    }));
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

  const expressionNames = {
    "#pk": "pk",
    "#sk": "sk"
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
    "source = :source",
    "playlistId = :playlistId",
    "latestVideoId = :latestVideoId",
    "latestPublishedAt = :latestPublishedAt",
    "lastProcessedAt = :lastProcessedAt",
    "scannedCount = :scannedCount",
    "newEventCount = :newEventCount",
    "processed = :processed",
    "updatedAt = :updatedAt"
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
        events.push(result.item);
        try {
          await writeSongItem(video);
        } catch (error) {
          logStage("song-table-write-failed", {
            videoId: video.videoId,
            title: video.title,
            error: error.message
          });
        }
        await writeEventStream(result.item);
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

    logStage("youtube-release-scan-complete", {
      timestamp: requestTimestamp,
      scannedCount: enrichedVideos.length,
      detectedCount: newVideos.length,
      createdCount: events.length,
      duplicateCount,
      newestVideoId: newestVideo?.videoId || null,
      newestPublishedAt: newestVideo?.publishedAt || null,
      elapsedMs: Date.now() - startedAt
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
    logStage("youtube-release-scan-failed", {
      timestamp: requestTimestamp,
      error: error.message,
      elapsedMs: Date.now() - startedAt
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
