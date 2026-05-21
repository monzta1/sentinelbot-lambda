/* =============================================================
   sentinelbot-metrics-publisher

   Reads GA4 Data API for the current calendar month, builds
   metrics.json, and commits it to shieldbearer-website. Daily
   cron via EventBridge.

   Mirrors sentinelbot-site-publisher for GitHub auth, retry,
   and commit shape. The GA4 fetch path is the new piece. The
   service-account key lives in Secrets Manager under
   `shieldbearer/ga4-service-account`. The property ID lives in
   the env var GA4_PROPERTY_ID (numeric, e.g. "123456789").
   ============================================================= */

const crypto = require("crypto");

// Lazy-require the AWS SDK Secrets Manager client so the module
// loads in unit tests without the dependency installed. The Lambda
// runtime carries it; we only need it inside loadServiceAccount.
let secretsClient = null;
function getSecretsClient() {
  if (secretsClient) return secretsClient;
  const { SecretsManagerClient } = require("@aws-sdk/client-secrets-manager");
  secretsClient = new SecretsManagerClient({});
  return secretsClient;
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const METRICS_JSON_PATH = process.env.METRICS_JSON_PATH || "metrics.json";
const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID || "";
const GA4_SECRET_NAME = process.env.GA4_SECRET_NAME || "shieldbearer/ga4-service-account";
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() !== "false";
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

function hashContent(content) {
  return crypto.createHash("sha256").update(String(content || ""), "utf8").digest("hex");
}

// ============================================================
// Period helpers: "calendar month so far" + "previous month".
// ============================================================

function getCurrentPeriod(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 0));
  const monthName = start.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return {
    label: `${monthName} ${year} so far`,
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10)
  };
}

function getPreviousPeriod(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  const monthName = start.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return {
    label: `${monthName} ${start.getUTCFullYear()}`,
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10)
  };
}

function computeDeltaPct(current, previous) {
  if (previous == null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// ============================================================
// GA4 Data API client. Uses Google's documented JWT-bearer auth
// flow for service accounts. We avoid pulling the full
// google-auth-library to keep the deployment package small.
// ============================================================

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signRs256(unsignedJwt, privateKeyPem) {
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsignedJwt);
  signer.end();
  return base64UrlEncode(signer.sign(privateKeyPem));
}

async function loadServiceAccount() {
  const { GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
  const result = await getSecretsClient().send(new GetSecretValueCommand({ SecretId: GA4_SECRET_NAME }));
  const raw = result.SecretString;
  if (!raw) throw new Error("GA4 secret has no SecretString");
  return JSON.parse(raw);
}

async function fetchGoogleAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: serviceAccount.private_key_id }));
  const claim = base64UrlEncode(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  }));
  const unsigned = `${header}.${claim}`;
  const signature = signRs256(unsigned, serviceAccount.private_key);
  const assertion = `${unsigned}.${signature}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token exchange failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  const json = await response.json();
  return json.access_token;
}

async function runGa4Report(accessToken, body) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(GA4_PROPERTY_ID)}:runReport`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GA4 runReport failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  return response.json();
}

// ============================================================
// Report builders. Each one returns a small typed structure that
// buildMetricsArtifact composes.
// ============================================================

function sumRowMetric(report, metricIndex) {
  const rows = report?.rows || [];
  let total = 0;
  for (const row of rows) {
    const value = Number(row?.metricValues?.[metricIndex]?.value || 0);
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

async function fetchSessionsForRange(accessToken, startDate, endDate) {
  const report = await runGa4Report(accessToken, {
    dateRanges: [{ startDate, endDate }],
    metrics: [{ name: "sessions" }]
  });
  return sumRowMetric(report, 0);
}

async function fetchChannels(accessToken, startDate, endDate) {
  const report = await runGa4Report(accessToken, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 10
  });
  const rows = report?.rows || [];
  const total = rows.reduce((acc, row) => acc + Number(row?.metricValues?.[0]?.value || 0), 0);
  return rows.slice(0, 3).map((row) => {
    const name = String(row?.dimensionValues?.[0]?.value || "Unknown");
    const sessions = Number(row?.metricValues?.[0]?.value || 0);
    const share = total > 0 ? Math.round((sessions / total) * 1000) / 10 : 0;
    return { name, sessions, share };
  });
}

async function fetchTopEvents(accessToken, startDate, endDate) {
  const report = await runGa4Report(accessToken, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "eventName" }],
    metrics: [{ name: "eventCount" }],
    dimensionFilter: {
      notExpression: {
        filter: {
          fieldName: "eventName",
          inListFilter: {
            // Exclude default-collected events that would otherwise
            // dominate the top-5 list and obscure the funnel signal.
            values: [
              "page_view", "session_start", "first_visit", "user_engagement",
              "scroll", "click", "form_start", "form_submit"
            ]
          }
        }
      }
    },
    orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
    limit: 10
  });
  const rows = report?.rows || [];
  return rows.slice(0, 5).map((row) => {
    const name = String(row?.dimensionValues?.[0]?.value || "unknown_event");
    const count = Number(row?.metricValues?.[0]?.value || 0);
    return { name, count, engagedShare: null };
  });
}

// ============================================================
// Shipped log: hand-curated. Read whatever the existing metrics.json
// already carries so the operator never loses their entries. The
// Lambda only refreshes engagement numbers, not the shipped log.
// ============================================================

async function fetchExistingShipped() {
  const url = `${buildGitHubContentsUrl(METRICS_JSON_PATH)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  try {
    const result = await githubRequestWithRetry(url, { method: "GET" }, { path: METRICS_JSON_PATH });
    const content = decodeContent(result?.data?.content || "");
    if (!content) return { shipped: [], sha: null };
    const parsed = JSON.parse(content);
    return {
      shipped: Array.isArray(parsed.shipped) ? parsed.shipped : [],
      sha: result?.data?.sha || null
    };
  } catch (error) {
    if (error.status === 404) return { shipped: [], sha: null };
    throw error;
  }
}

// ============================================================
// GitHub helpers (mirror site-publisher patterns).
// ============================================================

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
    "user-agent": "SentinelBot-Metrics-Publisher"
  };
}

function encodeContent(content) {
  return Buffer.from(String(content || ""), "utf8").toString("base64");
}

function decodeContent(content) {
  return Buffer.from(String(content || ""), "base64").toString("utf8");
}

function isRetryableGitHubStatus(status) {
  return [429, 500, 502, 503, 504].includes(status);
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
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!response.ok) {
    const error = new Error(data?.message || `GitHub API HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return { status: response.status, data };
}

async function githubRequestWithRetry(url, options = {}, context = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < GITHUB_MAX_ATTEMPTS; attempt += 1) {
    try {
      if (attempt > 0) {
        logStage("github-request-retry", { attempt, path: context.path || null, status: lastError?.status || null });
      }
      return await githubRequestOnce(url, options);
    } catch (error) {
      lastError = error;
      if (!isRetryableGitHubStatus(error.status) || attempt === GITHUB_MAX_ATTEMPTS - 1) {
        logStage("github-request-failed", { attempt, path: context.path || null, status: error.status || null, error: error.message });
        throw error;
      }
      const delay = Math.min(GITHUB_BASE_DELAY_MS * (2 ** attempt), 10_000);
      await sleep(delay);
    }
  }
  throw lastError;
}

// ============================================================
// Artifact builder + writer.
// ============================================================

function buildMetricsArtifact({ headline, channels, events, shipped, period }) {
  return {
    generatedAt: nowIso(),
    period,
    headline,
    channels,
    events,
    shipped,
    source: "ga4-data-api",
    note: "Numbers are aggregates only. Refreshed daily at 04:00 ET."
  };
}

function buildCanonicalMetricsArtifact(artifact) {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

async function writeMetricsJsonToGitHub(artifact, existingSha) {
  const content = buildCanonicalMetricsArtifact(artifact);
  const contentHash = hashContent(content);

  const body = {
    message: `auto: metrics refresh ${artifact.generatedAt.slice(0, 10)}`,
    content: encodeContent(content),
    branch: GITHUB_BRANCH
  };
  if (existingSha) body.sha = existingSha;

  logStage("github-put-attempt", {
    path: METRICS_JSON_PATH,
    branch: GITHUB_BRANCH,
    contentHash,
    bytes: Buffer.byteLength(content, "utf8")
  });

  const result = await githubRequestWithRetry(buildGitHubContentsUrl(METRICS_JSON_PATH), {
    method: "PUT",
    body
  }, { path: METRICS_JSON_PATH });

  logStage("github-put-response", {
    path: METRICS_JSON_PATH,
    status: result.status,
    sha: result?.data?.content?.sha || null,
    commitSha: result?.data?.commit?.sha || null
  });

  return {
    changed: true,
    contentHash,
    sha: result?.data?.content?.sha || null,
    commitSha: result?.data?.commit?.sha || null
  };
}

// ============================================================
// Handler.
// ============================================================

/* c8 ignore start: external-IO + handler entry, exercised in production */
exports.handler = async (event = {}) => {
  const startedAt = Date.now();
  try {
    if (!GA4_PROPERTY_ID) throw new Error("GA4_PROPERTY_ID is not set");

    const period = getCurrentPeriod();
    const previous = getPreviousPeriod();

    const serviceAccount = await loadServiceAccount();
    const accessToken = await fetchGoogleAccessToken(serviceAccount);

    const [currentSessions, previousSessions, channels, topEvents, existing] = await Promise.all([
      fetchSessionsForRange(accessToken, period.start, period.end),
      fetchSessionsForRange(accessToken, previous.start, previous.end),
      fetchChannels(accessToken, period.start, period.end),
      fetchTopEvents(accessToken, period.start, period.end),
      fetchExistingShipped()
    ]);

    const headline = {
      sessions: currentSessions,
      deltaPct: computeDeltaPct(currentSessions, previousSessions),
      comparison: `vs ${previous.label}`
    };

    const artifact = buildMetricsArtifact({
      headline,
      channels,
      events: topEvents,
      shipped: existing.shipped,
      period
    });

    if (DRY_RUN) {
      logStage("metrics-publisher-dry-run", {
        currentSessions,
        previousSessions,
        channelsCount: channels.length,
        eventsCount: topEvents.length,
        shippedCount: existing.shipped.length,
        elapsedMs: Date.now() - startedAt
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: true, artifact }) };
    }

    const writeResult = await writeMetricsJsonToGitHub(artifact, existing.sha);
    logStage("metrics-publisher-ok", {
      currentSessions,
      previousSessions,
      channelsCount: channels.length,
      eventsCount: topEvents.length,
      shippedCount: existing.shipped.length,
      contentHash: writeResult.contentHash,
      commitSha: writeResult.commitSha,
      elapsedMs: Date.now() - startedAt
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        dryRun: false,
        period: artifact.period,
        headline: artifact.headline,
        commitSha: writeResult.commitSha
      })
    };
  } catch (error) {
    logStage("metrics-publisher-failed", {
      error: error.message,
      elapsedMs: Date.now() - startedAt
    });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: error.message }) };
  }
};
/* c8 ignore stop */

module.exports = {
  handler: exports.handler,
  getCurrentPeriod,
  getPreviousPeriod,
  computeDeltaPct,
  buildMetricsArtifact,
  buildCanonicalMetricsArtifact,
  sumRowMetric,
  buildGitHubContentsUrl,
  encodeContent,
  decodeContent,
  hashContent
};
