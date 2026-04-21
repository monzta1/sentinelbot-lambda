const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.DYNAMO_TABLE || "shieldbearer-sentinel-logs";
const SONGS_TABLE_NAME = process.env.SONGS_TABLE_NAME || "shieldbearer-songs";
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() !== "false";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const SITE_JSON_PATH = process.env.SITE_JSON_PATH || "site.json";
const EVENT_STREAM_PK = "eventstream";
const ALLOWED_SOURCES = parseAllowedSources(process.env.ALLOWED_SOURCES || "[\"youtube\"]");
const EVENT_STREAM_PAGE_SIZE = Math.max(1, Number.parseInt(process.env.EVENT_STREAM_PAGE_SIZE || "100", 10) || 100);
const SONGS_TABLE_PAGE_SIZE = Math.max(1, Number.parseInt(process.env.SONGS_TABLE_PAGE_SIZE || "100", 10) || 100);
const GITHUB_MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.GITHUB_MAX_ATTEMPTS || "5", 10) || 5);
const GITHUB_BASE_DELAY_MS = Math.max(100, Number.parseInt(process.env.GITHUB_BASE_DELAY_MS || "500", 10) || 500);

function nowIso() {
  return new Date().toISOString();
}

function logStage(stage, details) {
  console.log(JSON.stringify({
    stage,
    timestamp: nowIso(),
    dryRun: DRY_RUN,
    ...details
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeJsonObject(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Site artifact must be an object");
  }
  return JSON.parse(JSON.stringify(value));
}

function parseAllowedSources(value) {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && item.trim())) {
      return parsed.map((item) => item.trim());
    }
  } catch {
    // default below
  }
  return ["youtube"];
}

function getArtifactReleaseId(siteArtifact) {
  return siteArtifact?.homepage?.banner?.activeReleaseId || siteArtifact?.release?.id || "";
}

function getArtifactSource(siteArtifact, event = {}) {
  return String(event.source || siteArtifact?.release?.source || "youtube").trim();
}

function normalizeStateName(value) {
  const raw = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");

  if (!raw) {
    return "";
  }

  if (raw === "signal") {
    return "draft";
  }

  if (raw === "incoming" || raw === "comingsoon") {
    return "coming_soon";
  }

  if (raw === "coming_soon" || raw === "draft" || raw === "released") {
    return raw;
  }

  return "";
}

function isAllowedSource(source) {
  return ALLOWED_SOURCES.includes(source);
}

function parseTimestamp(value) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeReleaseTitle(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashContent(content) {
  return crypto.createHash("sha256").update(String(content || ""), "utf8").digest("hex");
}

function buildGitHubContentsUrl(pathname) {
  const encodedPath = pathname.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${encodedPath}`;
}

function buildGitHubHeaders() {
  return {
    "accept": "application/vnd.github+json",
    "authorization": `Bearer ${GITHUB_TOKEN}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "SentinelBot-Site-Publisher"
  };
}

function parseRetryAfterMs(headers) {
  const retryAfter = headers?.get?.("retry-after");
  if (!retryAfter) return null;

  const asNumber = Number(retryAfter);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return asNumber * 1000;
  }

  const asDate = Date.parse(retryAfter);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return null;
}

function isRetryableGitHubStatus(status, response) {
  if ([429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  if (status === 403) {
    const remaining = response?.headers?.get?.("x-ratelimit-remaining");
    return remaining === "0";
  }

  return false;
}

function backoffDelayMs(attempt, retryAfterMs = null) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs != null) {
    return Math.max(retryAfterMs, GITHUB_BASE_DELAY_MS);
  }

  const jitter = Math.floor(Math.random() * 250);
  return Math.min(GITHUB_BASE_DELAY_MS * (2 ** attempt), 10_000) + jitter;
}

async function githubRequestOnce(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: buildGitHubHeaders(),
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const error = new Error(data?.message || `GitHub API HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    error.retryAfterMs = parseRetryAfterMs(response.headers);
    error.response = response;
    throw error;
  }

  return {
    status: response.status,
    headers: response.headers,
    data
  };
}

async function githubRequestWithRetry(url, options = {}, context = {}) {
  const method = String(options.method || "GET").toUpperCase();
  let lastError = null;

  for (let attempt = 0; attempt < GITHUB_MAX_ATTEMPTS; attempt += 1) {
    try {
      if (attempt > 0) {
        logStage("github-request-retry", {
          attempt,
          method,
          path: context.path || null,
          status: lastError?.status || null,
          delayMs: lastError?.retryAfterMs || null,
          error: lastError?.message || "unknown"
        });
      }

      return githubRequestOnce(url, options);
    } catch (error) {
      lastError = error;
      const retryable = isRetryableGitHubStatus(error.status, error.response);
      if (!retryable || attempt === GITHUB_MAX_ATTEMPTS - 1) {
        logStage("github-request-failed", {
          attempt,
          method,
          path: context.path || null,
          status: error.status || null,
          error: error.message
        });
        throw error;
      }

      const delayMs = backoffDelayMs(attempt, error.retryAfterMs);
      lastError.retryAfterMs = delayMs;
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function encodeContent(content) {
  return Buffer.from(String(content || ""), "utf8").toString("base64");
}

function decodeContent(content) {
  return Buffer.from(String(content || ""), "base64").toString("utf8");
}

function buildCanonicalSiteArtifact(siteArtifact) {
  const normalized = normalizeJsonObject(siteArtifact);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

function buildEmptySiteArtifact() {
  return {
    generatedAt: "",
    source: "sentinelbot-event-consumer",
    homepage: {
      banner: {
        title: "",
        image: null,
        sourceUrl: "",
        activeReleaseId: ""
      },
      lastUpdatedAt: ""
    },
    release: {
      id: "",
      source: "",
      publishedAt: "",
      traceId: ""
    },
    releaseIndex: {},
    signal: [],
    incoming: [],
    released: [],
    signalCount: 0,
    comingSoonCount: 0,
    releasedCount: 0,
    eventsStream: []
  };
}

function normalizeReleaseEventItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const payload = item?.payload && typeof item.payload === "object" ? item.payload : null;
  const eventType = String(item?.eventType || payload?.eventType || "").trim();
  const songId = String(item?.songId || payload?.songId || payload?.id || item?.id || "").trim();
  const title = String(item?.title || payload?.title || "").trim();
  const timestamp = String(item?.timestamp || payload?.timestamp || payload?.publishedAt || item?.publishedAt || item?.createdAt || item?.updatedAt || "").trim();
  const source = String(item?.source || payload?.source || "youtube").trim();
  const sourceUrl = String(item?.sourceUrl || payload?.sourceUrl || "").trim();
  const traceId = String(item?.traceId || payload?.traceId || item?.id || "").trim();
  const explicitState = normalizeStateName(item?.stateAfter || payload?.stateAfter);
  let stateAfter = explicitState;

  if (!stateAfter) {
    if (eventType === "CLI_INGEST") {
      stateAfter = "coming_soon";
    } else if (eventType === "new_content_detected" || source === "youtube") {
      stateAfter = "released";
    } else if (payload?.releaseDetected === true || payload?.status === "released") {
      stateAfter = "released";
    } else if (payload?.status) {
      stateAfter = normalizeStateName(payload.status) || "draft";
    } else {
      stateAfter = "draft";
    }
  }

  return {
    eventId: String(item?.id || "").trim(),
    songId,
    eventType,
    source,
    title,
    timestamp,
    stateAfter,
    sourceUrl,
    traceId,
    createdAt: String(item?.createdAt || "").trim(),
    updatedAt: String(item?.updatedAt || "").trim(),
    publishedAt: timestamp,
    payload
  };
}

function compareReleaseEventsDesc(a, b) {
  const aTime = parseTimestamp(a.timestamp || a.publishedAt || a.createdAt || a.updatedAt);
  const bTime = parseTimestamp(b.timestamp || b.publishedAt || b.createdAt || b.updatedAt);
  if (aTime !== bTime) {
    return bTime - aTime;
  }

  const aId = String(a.songId || a.eventId || "");
  const bId = String(b.songId || b.eventId || "");
  return aId.localeCompare(bId);
}

function normalizeSongTableItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const songId = String(item.songId || item.id || item.pk || "").trim();
  if (!songId) {
    return null;
  }

  const status = normalizeStateName(item.status) || (item.releaseDetected ? "released" : "draft");

  return {
    songId,
    title: String(item.title || "").trim(),
    state: status || "draft",
    traceId: String(item.traceId || "").trim(),
    publishedAt: String(item.publishedAt || "").trim(),
    sourceUrl: String(item.youtubeUrl || item.sourceUrl || "").trim(),
    artwork: String(item.artwork || "").trim(),
    updatedAt: String(item.updatedAt || item.createdAt || item.publishedAt || "").trim(),
    contentHash: String(item.contentHash || "").trim(),
    releaseDetected: Boolean(item.releaseDetected),
    status: String(item.status || "").trim()
  };
}

function compareSongsDesc(a, b) {
  const aTime = parseTimestamp(a.publishedAt || a.updatedAt);
  const bTime = parseTimestamp(b.publishedAt || b.updatedAt);
  if (aTime !== bTime) {
    return bTime - aTime;
  }

  return String(a.songId || "").localeCompare(String(b.songId || ""));
}

function compareReleaseSongsDesc(a, b) {
  const aTime = parseTimestamp(a.publishedAt || a.updatedAt);
  const bTime = parseTimestamp(b.publishedAt || b.updatedAt);
  if (aTime !== bTime) {
    return bTime - aTime;
  }

  return String(a.songId || "").localeCompare(String(b.songId || ""));
}

function buildSongView(song, latestEvent = null) {
  const state = normalizeStateName(latestEvent?.stateAfter || song?.state) || "draft";
  return {
    songId: song.songId || latestEvent?.songId || "",
    title: song.title || latestEvent?.title || "",
    state,
    traceId: latestEvent?.traceId || song.traceId || "",
    publishedAt: latestEvent?.timestamp || song.publishedAt || "",
    sourceUrl: latestEvent?.sourceUrl || song.sourceUrl || "",
    artwork: song.artwork || "",
    updatedAt: latestEvent?.timestamp || song.updatedAt || song.publishedAt || "",
    contentHash: song.contentHash || ""
  };
}

function buildSiteArtifactFromEvents({ songs = [], events = [] } = {}) {
  const orderedEvents = Array.isArray(events) ? [...events].filter(Boolean).sort(compareReleaseEventsDesc) : [];
  const orderedSongs = Array.isArray(songs) ? [...songs].filter(Boolean).sort(compareSongsDesc) : [];
  if (orderedEvents.length === 0 && orderedSongs.length === 0) {
    return buildEmptySiteArtifact();
  }

  const latestEventBySongId = new Map();
  for (const event of orderedEvents) {
    if (!event.songId || latestEventBySongId.has(event.songId)) {
      continue;
    }
    latestEventBySongId.set(event.songId, event);
  }

  const songById = new Map();
  for (const song of orderedSongs) {
    songById.set(song.songId, song);
  }

  for (const [songId, event] of latestEventBySongId.entries()) {
    if (!songById.has(songId)) {
      songById.set(songId, {
        songId,
        title: event.title || "",
        state: normalizeStateName(event.stateAfter) || "draft",
        traceId: event.traceId || "",
        publishedAt: event.timestamp || "",
        sourceUrl: event.sourceUrl || "",
        artwork: "",
        updatedAt: event.timestamp || "",
        contentHash: "",
        releaseDetected: false,
        status: ""
      });
    }
  }

  const songViews = [];
  for (const song of songById.values()) {
    const latestEvent = latestEventBySongId.get(song.songId) || null;
    const view = buildSongView(song, latestEvent);
    songViews.push(view);
  }

  songViews.sort(compareReleaseSongsDesc);

  const signal = songViews.filter((song) => song.state === "draft");
  const incoming = songViews.filter((song) => song.state === "coming_soon");
  const released = songViews.filter((song) => song.state === "released");
  const releaseIndex = {};
  for (const song of released) {
    const key = normalizeReleaseTitle(song.title || song.songId || "");
    if (!key || releaseIndex[key]) {
      continue;
    }

    releaseIndex[key] = {
      id: song.songId || "",
      title: song.title || "",
      publishedAt: song.publishedAt || song.updatedAt || "",
      sourceUrl: song.sourceUrl || "",
      traceId: song.traceId || ""
    };
  }

  const latestReleased = released[0] || songViews[0] || null;
  const latestEvent = orderedEvents[0] || null;
  const generatedAt = latestReleased?.updatedAt || latestEvent?.timestamp || latestEvent?.createdAt || latestReleased?.publishedAt || "";
  const releaseId = latestReleased?.songId || latestEvent?.songId || "";
  const source = latestEvent?.source || (latestReleased?.traceId ? "youtube" : "cli");
  const title = latestReleased?.title || latestEvent?.title || "";
  const sourceUrl = latestReleased?.sourceUrl || latestEvent?.sourceUrl || "";
  const publishedAt = latestReleased?.publishedAt || latestEvent?.timestamp || latestEvent?.createdAt || "";
  const traceId = latestReleased?.traceId || latestEvent?.traceId || "";
  const eventsStream = orderedEvents.slice(0, 50).map((event) => ({
    songId: event.songId || "",
    eventType: event.eventType || "",
    stateAfter: normalizeStateName(event.stateAfter) || "draft",
    timestamp: event.timestamp || event.publishedAt || event.createdAt || ""
  }));

  return {
    generatedAt,
    source: "sentinelbot-event-consumer",
    homepage: {
      banner: {
        title,
        image: null,
        sourceUrl,
        activeReleaseId: releaseId
      },
      lastUpdatedAt: generatedAt
    },
    release: {
      id: releaseId,
      source,
      publishedAt,
      traceId
    },
    releaseIndex,
    signal,
    incoming,
    released,
    signalCount: signal.length,
    comingSoonCount: incoming.length,
    releasedCount: released.length,
    eventsStream
  };
}

async function loadSongsTablePage(exclusiveStartKey) {
  const input = {
    TableName: SONGS_TABLE_NAME,
    Limit: SONGS_TABLE_PAGE_SIZE
  };

  if (exclusiveStartKey) {
    input.ExclusiveStartKey = exclusiveStartKey;
  }

  return dynamo.send(new ScanCommand(input));
}

async function loadSongsTableItems() {
  const items = [];
  let exclusiveStartKey = null;

  do {
    const page = await loadSongsTablePage(exclusiveStartKey);
    items.push(...(page?.Items || []));
    exclusiveStartKey = page?.LastEvaluatedKey || null;
  } while (exclusiveStartKey);

  return items
    .map(normalizeSongTableItem)
    .filter(Boolean);
}

async function loadEventStreamPage(exclusiveStartKey) {
  const input = {
    TableName: TABLE_NAME,
    KeyConditionExpression: "#pk = :pk",
    ExpressionAttributeNames: {
      "#pk": "pk"
    },
    ExpressionAttributeValues: {
      ":pk": EVENT_STREAM_PK
    },
    Limit: EVENT_STREAM_PAGE_SIZE,
    ScanIndexForward: false
  };

  if (exclusiveStartKey) {
    input.ExclusiveStartKey = exclusiveStartKey;
  }

  return dynamo.send(new QueryCommand(input));
}

async function loadEventStreamItems() {
  const items = [];
  let exclusiveStartKey = null;

  do {
    const page = await loadEventStreamPage(exclusiveStartKey);
    const pageItems = page?.Items || [];
    items.push(...pageItems);
    exclusiveStartKey = page?.LastEvaluatedKey || null;
  } while (exclusiveStartKey);

  const normalized = [];
  const seen = new Set();
  for (const item of items) {
    const record = normalizeReleaseEventItem(item);
    if (!record) {
      continue;
    }
    const key = item?.id || `${record.releaseId}#${record.publishedAt}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(record);
  }

  normalized.sort(compareReleaseEventsDesc);
  return normalized;
}

async function loadLatestSiteArtifactFromEventStream() {
  const [events, songs] = await Promise.all([
    loadEventStreamItems(),
    loadSongsTableItems()
  ]);
  return buildSiteArtifactFromEvents({ events, songs });
}

async function resolveSiteArtifact(event = {}) {
  if (event.siteArtifact && event.allowDirectArtifact === true) {
    return normalizeJsonObject(event.siteArtifact);
  }

  return loadLatestSiteArtifactFromEventStream();
}

async function getExistingSiteJson() {
  const url = `${buildGitHubContentsUrl(SITE_JSON_PATH)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  try {
    const result = await githubRequestWithRetry(url, { method: "GET" }, { path: SITE_JSON_PATH });
    const content = decodeContent(result?.data?.content || "");
    let normalizedContent = content;
    if (content) {
      try {
        normalizedContent = `${JSON.stringify(JSON.parse(content), null, 2)}\n`;
      } catch {
        normalizedContent = content;
      }
    }
    return {
      exists: true,
      sha: result?.data?.sha || null,
      content: normalizedContent || content,
      contentHash: hashContent(normalizedContent || content),
      gitUrl: result?.data?.html_url || null,
      status: result.status
    };
  } catch (error) {
    if (error.status === 404) {
      return {
        exists: false,
        sha: null,
        content: null,
        contentHash: null,
        gitUrl: null,
        status: 404
      };
    }
    throw error;
  }
}

async function writeSiteJsonToGitHub(siteArtifact, releaseId) {
  const content = buildCanonicalSiteArtifact(siteArtifact);
  const contentHash = hashContent(content);
  const existing = await getExistingSiteJson();

  if (existing.exists && existing.content === content) {
    logStage("github-no-op", {
      releaseId,
      path: SITE_JSON_PATH,
      contentHash,
      existingHash: existing.contentHash,
      decision: "skip"
    });
    return {
      changed: false,
      releaseId,
      reason: "unchanged",
      path: SITE_JSON_PATH,
      sha: existing.sha,
      gitUrl: existing.gitUrl,
      contentHash
    };
  }

  const body = {
    message: `auto-update: SentinelBot release sync ${releaseId}`,
    content: encodeContent(content),
    branch: GITHUB_BRANCH
  };

  if (existing.sha) {
    body.sha = existing.sha;
  }

  logStage("github-put-attempt", {
    releaseId,
    path: SITE_JSON_PATH,
    branch: GITHUB_BRANCH,
    contentHash,
    existingHash: existing.contentHash,
    decision: "push"
  });

  const result = await githubRequestWithRetry(buildGitHubContentsUrl(SITE_JSON_PATH), {
    method: "PUT",
    body
  }, {
    path: SITE_JSON_PATH
  });

  logStage("github-put-response", {
    releaseId,
    path: SITE_JSON_PATH,
    status: result.status,
    sha: result?.data?.content?.sha || null,
    commitSha: result?.data?.commit?.sha || null
  });

  return {
    changed: true,
    releaseId,
    path: SITE_JSON_PATH,
    sha: result?.data?.content?.sha || existing.sha || null,
    gitUrl: result?.data?.content?.html_url || existing.gitUrl || null,
    commitSha: result?.data?.commit?.sha || null,
    contentHash
  };
}

exports.handler = async (event = {}) => {
  const startedAt = Date.now();

  try {
    const eventStreamItems = await loadEventStreamItems();
    const siteArtifact = buildSiteArtifactFromEvents(eventStreamItems);
    const latestReleaseSource = eventStreamItems[0]?.source || "youtube";
    const releaseId = getArtifactReleaseId(siteArtifact);
    const source = getArtifactSource(siteArtifact, {
      source: latestReleaseSource
    });
    const serialized = buildCanonicalSiteArtifact(siteArtifact);
    const artifactSize = Buffer.byteLength(serialized, "utf8");
    const eventCount = eventStreamItems.length;

    logStage("event-count-processed", {
      eventCount,
      releaseId,
      source
    });

    if (DRY_RUN) {
      logStage("site-publisher-dry-run", {
        releaseId,
        artifactSize,
        source,
        allowedSources: ALLOWED_SOURCES,
        gitRepo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
        gitBranch: GITHUB_BRANCH,
        gitPath: SITE_JSON_PATH,
        elapsedMs: Date.now() - startedAt
      });

      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          dryRun: true,
          releaseId,
          artifactSize,
          path: SITE_JSON_PATH,
          eventCount
        })
      };
    }

    if (!event.approved) {
      logStage("publish-blocked-unapproved", {
        releaseId,
        artifactSize,
        source,
        gitRepo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
        gitBranch: GITHUB_BRANCH,
        gitPath: SITE_JSON_PATH,
        elapsedMs: Date.now() - startedAt
      });

      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          blocked: true,
          reason: "unapproved",
          dryRun: false,
          releaseId,
          artifactSize,
          path: SITE_JSON_PATH,
          eventCount
        })
      };
    }

    if (!isAllowedSource(source)) {
      logStage("publish-blocked-source", {
        releaseId,
        artifactSize,
        source,
        allowedSources: ALLOWED_SOURCES,
        gitRepo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
        gitBranch: GITHUB_BRANCH,
        gitPath: SITE_JSON_PATH,
        elapsedMs: Date.now() - startedAt
      });

      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          blocked: true,
          reason: "source_not_allowed",
          dryRun: false,
          releaseId,
          artifactSize,
          path: SITE_JSON_PATH,
          eventCount
        })
      };
    }

    const writeResult = await writeSiteJsonToGitHub(siteArtifact, releaseId);
    logStage("commit-decision", {
      releaseId,
      decision: writeResult.changed ? "push" : "skip",
      reason: writeResult.changed ? "content_changed" : "unchanged",
      contentHash: writeResult.contentHash
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        dryRun: false,
        releaseId,
        artifactSize,
        path: SITE_JSON_PATH,
        changed: writeResult.changed,
        sha: writeResult.sha || null,
        gitUrl: writeResult.gitUrl || null,
        commitSha: writeResult.commitSha || null,
        eventCount
      })
    };
  } catch (error) {
    logStage("site-publisher-failed", {
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
  resolveSiteArtifact,
  loadLatestSiteArtifactFromEventStream,
  loadEventStreamItems,
  buildSiteArtifactFromEvents,
  writeSiteJsonToGitHub,
  getExistingSiteJson,
  githubRequestOnce,
  githubRequestWithRetry,
  buildGitHubContentsUrl,
  buildCanonicalSiteArtifact,
  encodeContent,
  decodeContent,
  isAllowedSource,
  getArtifactSource,
  getArtifactReleaseId,
  parseAllowedSources,
  compareReleaseEventsDesc,
  normalizeReleaseEventItem,
  hashContent
};
