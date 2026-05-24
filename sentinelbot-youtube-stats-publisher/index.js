/* =============================================================
   sentinelbot-youtube-stats-publisher

   Reads the Shieldbearer YouTube channel (UCgL4mzUUcYtqxx-0IdjoqIw)
   via two Google APIs and commits a single artifact to the website
   repo:

     YouTube Data API v3       -- channel statistics (lifetime views,
                                  subscribers, video count) + top-video
                                  details by title and id. Uses the
                                  same YOUTUBE_API_KEY env var the
                                  release-detector Lambda uses.

     YouTube Analytics API v2  -- time-windowed metrics (last 7/30 day
                                  views, watch minutes, average view
                                  duration) plus geographic breakdowns
                                  (last 48 hours and last 30 days by
                                  country). Uses an OAuth refresh
                                  token stored in Secrets Manager
                                  under shieldbearer/youtube-analytics.

   Output: youtube_stats.json committed to the website repo. The
   /reach page fetches that file and renders the YouTube section.

   Cron: EventBridge rate(6 hours) -> a fresh artifact four times
   per day. YouTube Analytics has a ~48h reporting lag; refreshing
   faster than that buys nothing.

   YouTube data NEVER blends with the DistroKid reach total or the
   Spotify per-song count. It is its own labeled source artifact.

   Mirrors sentinelbot-metrics-publisher for GitHub commit + retry
   patterns. The OAuth refresh-token exchange replaces GA4's JWT-
   bearer service-account flow.
   ============================================================= */

const crypto = require("crypto");

let secretsClient = null;
function getSecretsClient() {
  if (secretsClient) return secretsClient;
  const { SecretsManagerClient } = require("@aws-sdk/client-secrets-manager");
  secretsClient = new SecretsManagerClient({});
  return secretsClient;
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "monzta1";
const GITHUB_REPO = process.env.GITHUB_REPO || "shieldbearer-website";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "sentinelbot-stable";
const YOUTUBE_JSON_PATH = process.env.YOUTUBE_JSON_PATH || "youtube_stats.json";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || "UCgL4mzUUcYtqxx-0IdjoqIw";
const YOUTUBE_OAUTH_SECRET_NAME = process.env.YOUTUBE_OAUTH_SECRET_NAME || "shieldbearer/youtube-analytics";
const TOP_VIDEO_LIMIT = Math.max(1, Number.parseInt(process.env.TOP_VIDEO_LIMIT || "5", 10) || 5);

const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";
const GITHUB_MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.GITHUB_MAX_ATTEMPTS || "5", 10) || 5);
const GITHUB_BASE_DELAY_MS = Math.max(100, Number.parseInt(process.env.GITHUB_BASE_DELAY_MS || "500", 10) || 500);

function nowIso() { return new Date().toISOString(); }
function logStage(stage, details) {
  console.log(JSON.stringify({ stage, timestamp: nowIso(), dryRun: DRY_RUN, ...details }));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hashContent(content) {
  return crypto.createHash("sha256").update(String(content || ""), "utf8").digest("hex");
}

// ============================================================
// Date helpers. YouTube Analytics uses YYYY-MM-DD strings, always
// UTC. We snapshot "now" once per invocation so all reports share
// the same end date.
// ============================================================

function daysAgo(n, ref = new Date()) {
  const d = new Date(ref.getTime() - n * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function buildDateWindows(ref = new Date()) {
  const today = ref.toISOString().slice(0, 10);
  return {
    last48h: { start: daysAgo(2, ref), end: today },
    last7: { start: daysAgo(7, ref), end: today },
    last30: { start: daysAgo(30, ref), end: today }
  };
}

// ============================================================
// Country code -> name + flag emoji. Covers the codes YouTube
// Analytics returns most often. Unknown codes pass through with
// the bare code as the name and no flag.
// ============================================================
const COUNTRY_LOOKUP = {
  US: { name: "United States", flag: "🇺🇸" },
  CA: { name: "Canada", flag: "🇨🇦" },
  MX: { name: "Mexico", flag: "🇲🇽" },
  BR: { name: "Brazil", flag: "🇧🇷" },
  AR: { name: "Argentina", flag: "🇦🇷" },
  CL: { name: "Chile", flag: "🇨🇱" },
  CO: { name: "Colombia", flag: "🇨🇴" },
  GB: { name: "United Kingdom", flag: "🇬🇧" },
  IE: { name: "Ireland", flag: "🇮🇪" },
  DE: { name: "Germany", flag: "🇩🇪" },
  FR: { name: "France", flag: "🇫🇷" },
  NL: { name: "The Netherlands", flag: "🇳🇱" },
  BE: { name: "Belgium", flag: "🇧🇪" },
  SE: { name: "Sweden", flag: "🇸🇪" },
  NO: { name: "Norway", flag: "🇳🇴" },
  DK: { name: "Denmark", flag: "🇩🇰" },
  FI: { name: "Finland", flag: "🇫🇮" },
  CH: { name: "Switzerland", flag: "🇨🇭" },
  AT: { name: "Austria", flag: "🇦🇹" },
  IT: { name: "Italy", flag: "🇮🇹" },
  ES: { name: "Spain", flag: "🇪🇸" },
  PT: { name: "Portugal", flag: "🇵🇹" },
  GR: { name: "Greece", flag: "🇬🇷" },
  PL: { name: "Poland", flag: "🇵🇱" },
  CZ: { name: "Czech Republic", flag: "🇨🇿" },
  HU: { name: "Hungary", flag: "🇭🇺" },
  RO: { name: "Romania", flag: "🇷🇴" },
  RU: { name: "Russia", flag: "🇷🇺" },
  UA: { name: "Ukraine", flag: "🇺🇦" },
  TR: { name: "Turkey", flag: "🇹🇷" },
  IL: { name: "Israel", flag: "🇮🇱" },
  IN: { name: "India", flag: "🇮🇳" },
  PK: { name: "Pakistan", flag: "🇵🇰" },
  BD: { name: "Bangladesh", flag: "🇧🇩" },
  SG: { name: "Singapore", flag: "🇸🇬" },
  AE: { name: "United Arab Emirates", flag: "🇦🇪" },
  SA: { name: "Saudi Arabia", flag: "🇸🇦" },
  JP: { name: "Japan", flag: "🇯🇵" },
  KR: { name: "South Korea", flag: "🇰🇷" },
  CN: { name: "China", flag: "🇨🇳" },
  HK: { name: "Hong Kong", flag: "🇭🇰" },
  TW: { name: "Taiwan", flag: "🇹🇼" },
  PH: { name: "Philippines", flag: "🇵🇭" },
  ID: { name: "Indonesia", flag: "🇮🇩" },
  MY: { name: "Malaysia", flag: "🇲🇾" },
  TH: { name: "Thailand", flag: "🇹🇭" },
  VN: { name: "Vietnam", flag: "🇻🇳" },
  AU: { name: "Australia", flag: "🇦🇺" },
  NZ: { name: "New Zealand", flag: "🇳🇿" },
  ZA: { name: "South Africa", flag: "🇿🇦" },
  EG: { name: "Egypt", flag: "🇪🇬" },
  NG: { name: "Nigeria", flag: "🇳🇬" },
  KE: { name: "Kenya", flag: "🇰🇪" }
};

function decorateCountry(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return { code: "", name: "Unknown", flag: "" };
  const entry = COUNTRY_LOOKUP[c];
  return { code: c, name: (entry && entry.name) || c, flag: (entry && entry.flag) || "" };
}

// ============================================================
// OAuth refresh-token exchange. The secret carries client_id +
// client_secret + refresh_token (long-lived); we trade those for
// a short-lived access_token on each invocation. No caching --
// Lambda may be cold-started, and the call is cheap.
// ============================================================

async function loadOAuthSecret() {
  const { GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
  const result = await getSecretsClient().send(new GetSecretValueCommand({ SecretId: YOUTUBE_OAUTH_SECRET_NAME }));
  const raw = result.SecretString;
  if (!raw) throw new Error("YouTube OAuth secret has no SecretString");
  const parsed = JSON.parse(raw);
  if (!parsed.client_id || !parsed.client_secret || !parsed.refresh_token) {
    throw new Error("YouTube OAuth secret missing required fields");
  }
  return parsed;
}

async function fetchAccessToken({ client_id, client_secret, refresh_token }) {
  const body = new URLSearchParams({
    client_id,
    client_secret,
    refresh_token,
    grant_type: "refresh_token"
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
  if (!json.access_token) throw new Error("Google token exchange returned no access_token");
  return json.access_token;
}

// ============================================================
// YouTube Analytics API v2 caller. All reports go through here.
// ids=channel==MINE binds to the channel that authorized the
// refresh token (i.e. Shieldbearer).
// ============================================================

async function runAnalyticsReport(accessToken, params) {
  const search = new URLSearchParams({ "ids": "channel==MINE", ...params });
  const url = `https://youtubeanalytics.googleapis.com/v2/reports?${search.toString()}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "authorization": `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`YouTube Analytics HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json();
}

function firstRowMetric(report, idx = 0) {
  const row = report?.rows?.[0];
  if (!row) return 0;
  const v = Number(row[idx]);
  return Number.isFinite(v) ? v : 0;
}

async function fetchWatchSummary(accessToken, startDate, endDate) {
  const report = await runAnalyticsReport(accessToken, {
    startDate, endDate,
    metrics: "views,estimatedMinutesWatched,averageViewDuration"
  });
  return {
    views: firstRowMetric(report, 0),
    watchMinutes: firstRowMetric(report, 1),
    avgViewDurationSec: firstRowMetric(report, 2)
  };
}

async function fetchCountryBreakdown(accessToken, startDate, endDate, limit = 15) {
  const report = await runAnalyticsReport(accessToken, {
    startDate, endDate,
    metrics: "views",
    dimensions: "country",
    sort: "-views",
    maxResults: String(limit)
  });
  const rows = report?.rows || [];
  return rows.map((row) => {
    const decorated = decorateCountry(row[0]);
    return { ...decorated, views: Number(row[1]) || 0 };
  });
}

// ============================================================
// YouTube Data API v3 callers. These use the API key, not OAuth.
// ============================================================

async function dataApiFetch(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`YouTube Data API HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json();
}

async function fetchChannelStats() {
  if (!YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY not set");
  const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet,contentDetails&id=${encodeURIComponent(YOUTUBE_CHANNEL_ID)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
  const data = await dataApiFetch(url);
  const item = data?.items?.[0];
  if (!item) throw new Error("YouTube Data API returned no channel item");
  const stats = item.statistics || {};
  const snippet = item.snippet || {};
  return {
    channelId: item.id || YOUTUBE_CHANNEL_ID,
    title: snippet.title || "Shieldbearer",
    handle: snippet.customUrl || "",
    publishedAt: snippet.publishedAt || null,
    thumbnail: snippet?.thumbnails?.high?.url || snippet?.thumbnails?.default?.url || null,
    channelUrl: `https://www.youtube.com/channel/${item.id || YOUTUBE_CHANNEL_ID}`,
    viewsLifetime: Number(stats.viewCount) || 0,
    subscribers: Number(stats.subscriberCount) || 0,
    subscribersHidden: stats.hiddenSubscriberCount === true,
    videoCount: Number(stats.videoCount) || 0,
    uploadsPlaylistId: item?.contentDetails?.relatedPlaylists?.uploads || null
  };
}

async function fetchAllUploadVideoIds(uploadsPlaylistId, max = 200) {
  if (!uploadsPlaylistId) return [];
  const ids = [];
  let pageToken = "";
  while (ids.length < max) {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("playlistId", uploadsPlaylistId);
    url.searchParams.set("maxResults", String(Math.min(50, max - ids.length)));
    url.searchParams.set("key", YOUTUBE_API_KEY);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await dataApiFetch(url.toString());
    for (const item of (data?.items || [])) {
      const vid = item?.contentDetails?.videoId;
      if (vid) ids.push(vid);
      if (ids.length >= max) break;
    }
    pageToken = data?.nextPageToken || "";
    if (!pageToken) break;
  }
  return ids;
}

async function fetchTopVideos(uploadsPlaylistId, limit) {
  const allIds = await fetchAllUploadVideoIds(uploadsPlaylistId, 200);
  if (!allIds.length) return [];
  const results = [];
  for (let i = 0; i < allIds.length; i += 50) {
    const batch = allIds.slice(i, i + 50);
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "statistics,snippet");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("key", YOUTUBE_API_KEY);
    const data = await dataApiFetch(url.toString());
    for (const item of (data?.items || [])) {
      results.push({
        videoId: item.id,
        title: item?.snippet?.title || "Untitled",
        thumbnail: item?.snippet?.thumbnails?.medium?.url || item?.snippet?.thumbnails?.default?.url || null,
        views: Number(item?.statistics?.viewCount) || 0,
        likes: Number(item?.statistics?.likeCount) || 0,
        publishedAt: item?.snippet?.publishedAt || null,
        url: `https://www.youtube.com/watch?v=${item.id}`
      });
    }
  }
  results.sort((a, b) => b.views - a.views);
  return results.slice(0, limit);
}

// ============================================================
// Artifact builder.
// ============================================================

function buildYouTubeArtifact({ channel, windows, watch, top48, top30, topVideos }) {
  return {
    generated_at: nowIso(),
    source: "YouTube",
    channel: {
      channel_id: channel.channelId,
      title: channel.title,
      handle: channel.handle,
      url: channel.channelUrl,
      published_at: channel.publishedAt,
      thumbnail: channel.thumbnail,
      views_lifetime: channel.viewsLifetime,
      subscribers: channel.subscribers,
      subscribers_hidden: channel.subscribersHidden,
      video_count: channel.videoCount
    },
    windows,
    watch_time: {
      last_7: watch.last7,
      last_30: watch.last30
    },
    last_48h_countries: top48,
    last_30d_countries: top30,
    top_videos: topVideos
  };
}

function buildCanonicalArtifact(artifact) {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

// ============================================================
// GitHub helpers (mirror metrics-publisher).
// ============================================================

function buildGitHubContentsUrl(pathname) {
  const encoded = pathname.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${encoded}`;
}
function buildGitHubHeaders() {
  return {
    "accept": "application/vnd.github+json",
    "authorization": `Bearer ${GITHUB_TOKEN}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "SentinelBot-YouTube-Stats-Publisher"
  };
}
function encodeContentBase64(s) { return Buffer.from(String(s || ""), "utf8").toString("base64"); }
function isRetryableGitHubStatus(status) { return [429, 500, 502, 503, 504].includes(status); }

async function githubRequestOnce(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: buildGitHubHeaders(),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
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

async function readExistingSha() {
  const url = `${buildGitHubContentsUrl(YOUTUBE_JSON_PATH)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  try {
    const result = await githubRequestWithRetry(url, { method: "GET" }, { path: YOUTUBE_JSON_PATH });
    return result?.data?.sha || null;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function writeArtifactToGitHub(artifact) {
  const content = buildCanonicalArtifact(artifact);
  const contentHash = hashContent(content);
  const sha = await readExistingSha();
  const body = {
    message: `auto: youtube stats refresh ${artifact.generated_at.slice(0, 10)}`,
    content: encodeContentBase64(content),
    branch: GITHUB_BRANCH
  };
  if (sha) body.sha = sha;
  logStage("github-put-attempt", { path: YOUTUBE_JSON_PATH, branch: GITHUB_BRANCH, contentHash });
  const result = await githubRequestWithRetry(buildGitHubContentsUrl(YOUTUBE_JSON_PATH), { method: "PUT", body }, { path: YOUTUBE_JSON_PATH });
  logStage("github-put-response", {
    path: YOUTUBE_JSON_PATH,
    status: result.status,
    commitSha: result?.data?.commit?.sha || null
  });
  return { contentHash, commitSha: result?.data?.commit?.sha || null };
}

// ============================================================
// Handler.
// ============================================================

/* c8 ignore start: external-IO + handler entry, exercised in production */
exports.handler = async (event = {}) => {
  const startedAt = Date.now();
  try {
    const windows = buildDateWindows();
    const secret = await loadOAuthSecret();
    const accessToken = await fetchAccessToken(secret);

    const [channel, watch7, watch30, countries48, countries30] = await Promise.all([
      fetchChannelStats(),
      fetchWatchSummary(accessToken, windows.last7.start, windows.last7.end),
      fetchWatchSummary(accessToken, windows.last30.start, windows.last30.end),
      fetchCountryBreakdown(accessToken, windows.last48h.start, windows.last48h.end, 15),
      fetchCountryBreakdown(accessToken, windows.last30.start, windows.last30.end, 15)
    ]);

    // Top videos fetch reuses the channel result's uploadsPlaylistId,
    // so it must run after that resolves.
    const topVideos = await fetchTopVideos(channel.uploadsPlaylistId, TOP_VIDEO_LIMIT);

    const artifact = buildYouTubeArtifact({
      channel,
      windows: { last_48h: windows.last48h, last_7: windows.last7, last_30: windows.last30 },
      watch: { last7: watch7, last30: watch30 },
      top48: countries48,
      top30: countries30,
      topVideos
    });

    if (DRY_RUN) {
      logStage("youtube-stats-dry-run", {
        viewsLifetime: channel.viewsLifetime,
        subscribers: channel.subscribers,
        videoCount: channel.videoCount,
        last48hCountries: countries48.length,
        elapsedMs: Date.now() - startedAt
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: true, artifact }) };
    }

    const writeResult = await writeArtifactToGitHub(artifact);
    logStage("youtube-stats-ok", {
      viewsLifetime: channel.viewsLifetime,
      subscribers: channel.subscribers,
      videoCount: channel.videoCount,
      last48hCountries: countries48.length,
      last30dCountries: countries30.length,
      topVideos: topVideos.length,
      commitSha: writeResult.commitSha,
      elapsedMs: Date.now() - startedAt
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, dryRun: false, commitSha: writeResult.commitSha })
    };
  } catch (error) {
    logStage("youtube-stats-failed", { error: error.message, elapsedMs: Date.now() - startedAt });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: error.message }) };
  }
};
/* c8 ignore stop */

module.exports = {
  handler: exports.handler,
  buildDateWindows,
  daysAgo,
  decorateCountry,
  buildYouTubeArtifact,
  buildCanonicalArtifact,
  firstRowMetric,
  hashContent,
  COUNTRY_LOOKUP
};
