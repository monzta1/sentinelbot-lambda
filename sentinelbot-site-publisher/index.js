const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.DYNAMO_TABLE || "shieldbearer-sentinel-logs";
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() !== "false";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const SITE_JSON_PATH = process.env.SITE_JSON_PATH || "site.json";
const EVENT_STREAM_PK = "eventstream";
const ALLOWED_SOURCES = parseAllowedSources(process.env.ALLOWED_SOURCES || "[\"youtube\"]");
const EVENT_STREAM_PAGE_SIZE = Math.max(1, Number.parseInt(process.env.EVENT_STREAM_PAGE_SIZE || "100", 10) || 100);
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
      publishedAt: ""
    },
    releaseIndex: {}
  };
}

function normalizeReleaseEventItem(item) {
  const payload = item?.payload || null;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const releaseId = String(payload.id || "").trim();
  const source = String(payload.source || "").trim();
  const title = String(payload.title || "").trim();
  const publishedAt = String(payload.publishedAt || item?.publishedAt || item?.createdAt || "").trim();
  const sourceUrl = String(payload.sourceUrl || "").trim();
  const eventId = String(item?.id || "").trim();

  if (!releaseId && !eventId && !publishedAt && !source && !title) {
    return null;
  }

  return {
    eventId,
    releaseId,
    source,
    title,
    publishedAt,
    sourceUrl,
    createdAt: String(item?.createdAt || "").trim(),
    updatedAt: String(item?.updatedAt || "").trim(),
    payload
  };
}

function compareReleaseEventsDesc(a, b) {
  const aTime = parseTimestamp(a.publishedAt || a.createdAt || a.updatedAt);
  const bTime = parseTimestamp(b.publishedAt || b.createdAt || b.updatedAt);
  if (aTime !== bTime) {
    return bTime - aTime;
  }

  const aId = String(a.releaseId || a.eventId || "");
  const bId = String(b.releaseId || b.eventId || "");
  return aId.localeCompare(bId);
}

function buildSiteArtifactFromEvents(events) {
  const ordered = Array.isArray(events) ? [...events].filter(Boolean).sort(compareReleaseEventsDesc) : [];
  if (ordered.length === 0) {
    return buildEmptySiteArtifact();
  }

  const releaseIndex = {};
  for (const event of ordered) {
    const key = normalizeReleaseTitle(event.title || event.releaseId || event.eventId || "");
    if (!key || releaseIndex[key]) {
      continue;
    }

    releaseIndex[key] = {
      id: event.releaseId || event.eventId || "",
      title: event.title || "",
      publishedAt: event.publishedAt || event.createdAt || "",
      sourceUrl: event.sourceUrl || ""
    };
  }

  const latest = ordered[0];
  const generatedAt = latest.publishedAt || latest.createdAt || latest.updatedAt || "";
  const releaseId = latest.releaseId || latest.eventId || "";
  const source = latest.source || "youtube";
  const title = latest.title || "";
  const sourceUrl = latest.sourceUrl || "";
  const publishedAt = latest.publishedAt || latest.createdAt || "";

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
      publishedAt
    },
    releaseIndex
  };
}

async function loadEventStreamPage(exclusiveStartKey) {
  return dynamo.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "#pk = :pk",
    ExpressionAttributeNames: {
      "#pk": "pk"
    },
    ExpressionAttributeValues: {
      ":pk": EVENT_STREAM_PK
    },
    ExclusiveStartKey: exclusiveStartKey,
    Limit: EVENT_STREAM_PAGE_SIZE,
    ScanIndexForward: false
  }));
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
  const events = await loadEventStreamItems();
  return buildSiteArtifactFromEvents(events);
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
