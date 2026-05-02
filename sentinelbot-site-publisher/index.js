const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.DYNAMO_TABLE || "shieldbearer-sentinel-logs";
const EVENT_STREAM_TABLE_NAME = process.env.EVENT_STREAM_TABLE_NAME || "EventStream";
const SONGS_TABLE_NAME = process.env.SONGS_TABLE_NAME || "shieldbearer-songs";
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() !== "false";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const SITE_JSON_PATH = process.env.SITE_JSON_PATH || "site.json";
const EVENT_STREAM_PK = "eventstream";
const ALLOWED_SOURCES = parseAllowedSources(process.env.ALLOWED_SOURCES || "[\"youtube\"]");
const AUTO_APPROVE_SOURCES = parseAutoApproveSources(process.env.AUTO_APPROVE_SOURCES || "");
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

function parseAutoApproveSources(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function isCronInvocation(event) {
  if (!event || typeof event !== "object") return false;
  const detailType = event["detail-type"] || event.detailType;
  return event.source === "aws.events" && detailType === "Scheduled Event";
}

function shouldAutoApprove(event, releaseSource, autoApproveSources) {
  if (!isCronInvocation(event)) return false;
  if (!Array.isArray(autoApproveSources) || autoApproveSources.length === 0) return false;
  const normalized = String(releaseSource || "").trim().toLowerCase();
  if (!normalized) return false;
  return autoApproveSources.includes(normalized);
}

function cleanReleaseTitle(value) {
  // YouTube titles tend to be "Shieldbearer - <song> [<tag>] | <marketing>"
  // or "Slayer of the Grave [Christian Metal | Official Lyric Video]".
  // Strip the artist prefix, drop bracketed tags entirely (often
  // "Official Video", genre labels, etc.), then strip a trailing
  // pipe-suffix outside any brackets.
  let title = String(value || "").trim();
  if (!title) return "";
  title = title.replace(/^shieldbearer\s*[-–—]\s*/i, "").trim();
  // Drop every [bracketed] segment so a "|" inside a bracket cannot
  // chop the title at the wrong place.
  title = title.replace(/\s*\[[^\]]*\]\s*/g, " ").trim();
  const pipeIndex = title.indexOf(" | ");
  if (pipeIndex > 0) {
    title = title.slice(0, pipeIndex).trim();
  }
  // Strip surrounding double quotes left over from titles like
  // "Let My People Go" written into the YouTube title field.
  if (title.length >= 2 && title.startsWith("\"") && title.endsWith("\"")) {
    title = title.slice(1, -1).trim();
  }
  // Collapse any double spaces produced by bracket removal.
  title = title.replace(/\s{2,}/g, " ").trim();
  return title;
}

function isValidArtworkUrl(value) {
  const url = String(value || "").trim();
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  // The release-detector occasionally writes the YouTube watch URL
  // into the artworkUrl field on the event payload. That is a video
  // page, not an image, so it must be rejected. Real artwork comes
  // from img.youtube.com, the project CDN, or shield-cli uploads.
  if (/^https?:\/\/(www\.)?youtube\.com\/watch\b/i.test(url)) return false;
  if (/^https?:\/\/youtu\.be\//i.test(url) && !/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url)) return false;
  return true;
}

function cleanLyrics(value, options = {}) {
  const lyrics = String(value || "").trim();
  if (!lyrics) return "";
  // The release-detector copies the YouTube description into the
  // song record's lyrics field. Real verse-line lyrics never:
  //   - equal the song's separate description field
  //   - contain a YouTube URL
  //   - start with the artist name "Shieldbearer"
  //   - mention "new single 2026" / "new ep" / "new album YYYY" (marketing copy)
  //   - contain promotional hashtags like #Shieldbearer
  //   - exceed a generous 8000-char length cap
  // Anything that hits any of those signals gets dropped so the
  // website's static fallback or a shield-cli ingest wins.
  const description = String(options.description || "").trim();
  if (description && lyrics === description) return "";
  if (/youtube\.com|youtu\.be/i.test(lyrics)) return "";
  if (/^shieldbearer\b/i.test(lyrics)) return "";
  if (/\bnew\s+(single|ep|album)\s+\d{4}/i.test(lyrics)) return "";
  if (/#shieldbearer\b/i.test(lyrics)) return "";
  if (lyrics.length > 8000) return "";
  return lyrics;
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

/* c8 ignore start: external-IO functions tested via war-game pattern, not unit tests */
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
/* c8 ignore stop */

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
      // featuredRelease is what the homepage reads to render the
      // top-of-page release card (artwork, title, video, lyrics blurb,
      // song meaning). Populated from the latest released song.
      featuredRelease: null,
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
    // comingSoon is the field the website reads (signal-room, etc.).
    // Kept for compatibility with existing renderers.
    comingSoon: [],
    released: [],
    signalCount: 0,
    comingSoonCount: 0,
    releasedCount: 0,
    // events is the field the website reads (timeline page). Kept
    // singular and short-named for compatibility.
    events: []
  };
}

function normalizeReleaseEventItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const payload = item?.payload && typeof item.payload === "object" ? item.payload : null;
  const eventType = String(item?.eventType || payload?.eventType || "").trim();
  const songId = String(item?.songId || payload?.songId || payload?.id || item?.id || "").trim();
  const rawTitle = String(item?.title || payload?.title || "").trim();
  const title = cleanReleaseTitle(rawTitle);
  const timestamp = String(item?.timestamp || payload?.timestamp || item?.createdAt || item?.updatedAt || "").trim();
  // publishedAt is when the song went live on the source platform.
  // It may differ from the EVENT timestamp (when the detector ran),
  // and the timeline page renders publishedAt, so prefer that.
  const publishedAt = String(payload?.publishedAt || item?.publishedAt || timestamp || "").trim();
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
    publishedAt,
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

  const rawTitle = String(item.title || "").trim();
  const title = cleanReleaseTitle(rawTitle);

  // Lyrics + meaning may live under either shield-cli field names
  // (lyrics, songmeaning lowercase) or release-detector field names
  // (songMeaning camelCase, songContextMeaning/Summary). Accept all and
  // emit canonical camelCase. cleanLyrics drops description-shaped
  // text the release-detector occasionally writes into `lyrics`.
  const description = String(item.description || "").trim();
  const lyrics = cleanLyrics(item.lyrics, { description });
  const songMeaning = String(
    item.songMeaning ||
    item.songmeaning ||
    item.songContextMeaning ||
    item.songContextSummary ||
    ""
  ).trim();
  // Shield-cli writes the source filename into `artwork` and the
  // published CDN URL into `artworkUrl`. Prefer a valid image URL
  // from either, reject anything else (e.g. a YouTube watch URL the
  // release-detector sometimes writes into artworkUrl).
  const candidateArtworkUrl = String(item.artworkUrl || "").trim();
  const candidateArtwork = String(item.artwork || "").trim();
  const artwork = isValidArtworkUrl(candidateArtworkUrl) ? candidateArtworkUrl
    : isValidArtworkUrl(candidateArtwork) ? candidateArtwork
    : "";

  // Scripture and references are curated. shield-cli doesn't write
  // these yet; for now they get added directly to DynamoDB. The
  // publisher passes them through verbatim so the song-meanings
  // dossier can render them. If absent on the record, default to
  // empty values so the website fallback (no reference shown) wins.
  const reference = String(item.reference || "").trim();
  const scriptureRaw = item.scripture && typeof item.scripture === "object" ? item.scripture : null;
  const scripture = scriptureRaw ? {
    ref: String(scriptureRaw.ref || "").trim(),
    quote: String(scriptureRaw.quote || "").trim()
  } : { ref: "", quote: "" };

  return {
    songId,
    title,
    state: status || "draft",
    traceId: String(item.traceId || "").trim(),
    publishedAt: String(item.publishedAt || "").trim(),
    sourceUrl: String(item.youtubeUrl || item.sourceUrl || "").trim(),
    artwork,
    lyrics,
    songMeaning,
    reference,
    scripture,
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

function mergeReleasedWithComingSoon(released, comingSoon) {
  // Two song records can describe the same song:
  //   - shield-cli ingest writes a coming_soon record keyed by a
  //     kebab-case slug (e.g. let-my-people-go) with curated lyrics,
  //     real artwork, and a clean title.
  //   - The release detector creates a separate released record keyed
  //     by the YouTube video id when the music video drops, with
  //     little curated content beyond the YouTube metadata.
  // Without merge, the website shows the song twice in different
  // states with different metadata. Merge by normalized title so a
  // release event promotes the existing shield-cli record to the
  // released state and keeps the curated content. The promoted entry
  // gains the YouTube videoId and sourceUrl so the homepage embed
  // and the lyrics-page YouTube link both work.
  const safeReleased = Array.isArray(released) ? released : [];
  const safeComingSoon = Array.isArray(comingSoon) ? comingSoon : [];
  if (safeReleased.length === 0 || safeComingSoon.length === 0) {
    const result = safeReleased.map((song) => ({ ...song, videoId: song.videoId || song.songId || "" }));
    return { released: result, comingSoon: safeComingSoon };
  }

  const comingByTitle = new Map();
  for (const song of safeComingSoon) {
    const key = normalizeReleaseTitle(song.title);
    if (!key) continue;
    if (!comingByTitle.has(key)) comingByTitle.set(key, song);
  }

  const usedComingSoonIds = new Set();
  const mergedReleased = safeReleased.map((rel) => {
    const key = normalizeReleaseTitle(rel.title);
    const match = key ? comingByTitle.get(key) : null;
    const youtubeVideoId = rel.videoId || rel.songId || "";
    if (!match) {
      return { ...rel, videoId: youtubeVideoId };
    }
    usedComingSoonIds.add(match.songId);
    // Prefer shield-cli's curated content but fall back to whatever
    // the release-detector record produced (post-sanitization). For
    // scripture, prefer the curated record; the release-detector
    // never produces scripture data.
    const mergedScripture = (match.scripture && match.scripture.ref)
      ? match.scripture
      : (rel.scripture || { ref: "", quote: "" });
    return {
      ...match,
      state: "released",
      videoId: youtubeVideoId,
      sourceUrl: rel.sourceUrl || match.sourceUrl || "",
      publishedAt: rel.publishedAt || match.publishedAt || "",
      traceId: rel.traceId || match.traceId || "",
      updatedAt: rel.updatedAt || match.updatedAt || "",
      lyrics: match.lyrics || rel.lyrics || "",
      artwork: match.artwork || rel.artwork || "",
      songMeaning: match.songMeaning || rel.songMeaning || "",
      reference: match.reference || rel.reference || "",
      scripture: mergedScripture,
      title: match.title || rel.title || ""
    };
  });

  const remainingComingSoon = safeComingSoon.filter((song) => !usedComingSoonIds.has(song.songId));
  return { released: mergedReleased, comingSoon: remainingComingSoon };
}

function buildSongView(song, latestEvent = null) {
  // The songs table is the source of truth for state. Prefer it over
  // the latest event's stateAfter — events get a synthesized "draft"
  // tag for SONG_UPDATED events from shield-cli, which would
  // incorrectly demote a released record.
  const state = normalizeStateName(song?.state)
    || normalizeStateName(latestEvent?.stateAfter)
    || "draft";
  const eventPayload = latestEvent?.payload || {};
  // Pull lyrics/songMeaning/artwork from event payload first (freshest),
  // then song table. cleanLyrics drops description-shaped text the
  // release-detector writes into payload.lyrics, so a clean shield-cli
  // ingest can win even if it arrived first.
  const description = String(eventPayload.description || song.description || "").trim();
  const lyricsRaw = String(eventPayload.lyrics || song.lyrics || "").trim();
  const lyrics = cleanLyrics(lyricsRaw, { description });
  const songMeaning = String(
    eventPayload.songMeaning ||
    song.songMeaning ||
    eventPayload.songContextMeaning ||
    ""
  ).trim();
  const candidates = [eventPayload.artwork, eventPayload.artworkUrl, song.artwork];
  let artwork = "";
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value && isValidArtworkUrl(value)) {
      artwork = value;
      break;
    }
  }
  const rawTitle = song.title || latestEvent?.title || "";
  // Scripture and reference are curated and live on the song record;
  // events do not carry them. Pass through whatever the song has.
  const reference = String(song.reference || "").trim();
  const scripture = song.scripture && typeof song.scripture === "object" ? {
    ref: String(song.scripture.ref || "").trim(),
    quote: String(song.scripture.quote || "").trim()
  } : { ref: "", quote: "" };

  return {
    songId: song.songId || latestEvent?.songId || "",
    videoId: song.videoId || "",
    title: cleanReleaseTitle(rawTitle),
    state,
    traceId: latestEvent?.traceId || song.traceId || "",
    publishedAt: latestEvent?.publishedAt || song.publishedAt || latestEvent?.timestamp || "",
    sourceUrl: latestEvent?.sourceUrl || song.sourceUrl || "",
    artwork,
    lyrics,
    songMeaning,
    reference,
    scripture,
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
  const allComingSoon = songViews.filter((song) => song.state === "coming_soon");
  const allReleased = songViews.filter((song) => song.state === "released");
  const merged = mergeReleasedWithComingSoon(allReleased, allComingSoon);
  const released = merged.released;
  const comingSoon = merged.comingSoon;
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
  // The timeline page reads id, title, publishedAt, sourceUrl, plus
  // album/short metadata for filtering. Filter to events that have a
  // sourceUrl (release events) so SONG_UPDATED ticks from shield-cli
  // do not crowd out actual releases. Cap at 100 to keep the artifact
  // size bounded while leaving plenty of room for a year of releases.
  const eventsForArtifact = orderedEvents
    .filter((event) => Boolean(event.sourceUrl))
    .slice(0, 100)
    .map((event) => {
      const payload = event.payload || {};
      return {
        id: String(event.songId || event.eventId || "").trim(),
        songId: event.songId || "",
        eventType: event.eventType || "",
        stateAfter: normalizeStateName(event.stateAfter) || "draft",
        timestamp: event.timestamp || event.createdAt || "",
        title: cleanReleaseTitle(event.title || ""),
        publishedAt: event.publishedAt || event.timestamp || "",
        sourceUrl: event.sourceUrl || "",
        source: event.source || "",
        // Default album/short metadata. The detector does not currently
        // populate these, but the timeline page reads them defensively
        // to filter out shorts and group album tracks.
        albumId: String(payload.albumId || "").trim(),
        albumTitle: String(payload.albumTitle || "").trim(),
        albumUrl: String(payload.albumUrl || "").trim(),
        videoType: String(payload.videoType || "").trim(),
        isShort: payload.isShort === true,
        contentFormat: String(payload.contentFormat || "full").trim(),
        excludeFromTimeline: payload.excludeFromTimeline === true
      };
    });

  // featuredRelease drives the homepage's top-of-page release card.
  // Built from the latest released song so the page swaps automatically
  // when a new YouTube release is detected.
  const featuredVideoId = latestReleased?.videoId || latestReleased?.songId || "";
  const featuredRelease = latestReleased ? {
    songId: latestReleased.songId || "",
    title: latestReleased.title || "",
    videoId: featuredVideoId,
    sourceUrl: latestReleased.sourceUrl || "",
    artwork: latestReleased.artwork || (featuredVideoId
      ? `https://img.youtube.com/vi/${featuredVideoId}/hqdefault.jpg`
      : ""),
    lyrics: latestReleased.lyrics || "",
    songMeaning: latestReleased.songMeaning || "",
    publishedAt: latestReleased.publishedAt || ""
  } : null;

  return {
    generatedAt,
    source: "sentinelbot-event-consumer",
    homepage: {
      banner: {
        title,
        image: featuredRelease?.artwork || null,
        sourceUrl,
        activeReleaseId: releaseId
      },
      featuredRelease,
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
    comingSoon,
    released,
    signalCount: signal.length,
    comingSoonCount: comingSoon.length,
    releasedCount: released.length,
    events: eventsForArtifact
  };
}

/* c8 ignore start: external-IO + handler entry, tested via war-game pattern */
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
  // EventStream items use pk = songId (not a constant), so we cannot
  // Query by a fixed pk. Scan instead. Cheap at current scale (~tens
  // of items); switch to a GSI on a constant attribute if the table
  // grows past a few thousand events.
  const input = {
    TableName: EVENT_STREAM_TABLE_NAME,
    Limit: EVENT_STREAM_PAGE_SIZE
  };

  if (exclusiveStartKey) {
    input.ExclusiveStartKey = exclusiveStartKey;
  }

  return dynamo.send(new ScanCommand(input));
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

async function loadReleaseEventsPage(exclusiveStartKey) {
  // Release events historically wrote to shieldbearer-sentinel-logs
  // with pk values like "releaseevent#youtube#<videoId>". The
  // EventStream table holds the newer SONG_RELEASED + SONG_UPDATED
  // event shape but currently only carries ~tens of records, so the
  // legacy table is still the source for the long timeline. Scan
  // with a begins_with filter on pk; cheap at current scale.
  const input = {
    TableName: TABLE_NAME,
    FilterExpression: "begins_with(#pk, :prefix)",
    ExpressionAttributeNames: { "#pk": "pk" },
    ExpressionAttributeValues: { ":prefix": "releaseevent#" },
    Limit: EVENT_STREAM_PAGE_SIZE
  };

  if (exclusiveStartKey) {
    input.ExclusiveStartKey = exclusiveStartKey;
  }

  return dynamo.send(new ScanCommand(input));
}

async function loadReleaseEventsFromSentinelLogs() {
  const items = [];
  let exclusiveStartKey = null;

  do {
    const page = await loadReleaseEventsPage(exclusiveStartKey);
    items.push(...(page?.Items || []));
    exclusiveStartKey = page?.LastEvaluatedKey || null;
  } while (exclusiveStartKey);

  return items
    .map(normalizeReleaseEventItem)
    .filter(Boolean);
}

async function loadAllReleaseEvents() {
  const [eventStreamEvents, sentinelLogEvents] = await Promise.all([
    loadEventStreamItems(),
    loadReleaseEventsFromSentinelLogs()
  ]);
  // Dedupe by songId+publishedAt so the same release recorded in
  // both tables (EventStream + shieldbearer-sentinel-logs, common
  // for the most recent release) collapses to one entry on the
  // timeline. eventId values differ between tables, so they are not
  // a reliable dedup key.
  const seen = new Set();
  const merged = [];
  for (const event of [...eventStreamEvents, ...sentinelLogEvents]) {
    const songId = String(event.songId || "").trim();
    const ts = String(event.publishedAt || event.timestamp || "").trim();
    const key = songId && ts ? `${songId}#${ts}` : (event.eventId || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  merged.sort(compareReleaseEventsDesc);
  return merged;
}

async function loadLatestSiteArtifactFromEventStream() {
  const [events, songs] = await Promise.all([
    loadAllReleaseEvents(),
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
    // Load both events and songs and pass them to the artifact builder
    // in the expected destructured shape. The previous implementation
    // passed a plain array to a function that expects {events, songs},
    // so songs were never read and the artifact was always empty.
    const [eventStreamItems, songItems] = await Promise.all([
      loadAllReleaseEvents(),
      loadSongsTableItems()
    ]);
    const siteArtifact = buildSiteArtifactFromEvents({
      events: eventStreamItems,
      songs: songItems
    });
    // Prefer the source the caller passed (lets EventBridge target pass
    // source: "youtube" explicitly). Fall back to the freshest
    // SONG_RELEASED event in the stream, then to the latest event of
    // any kind, then to "youtube" as the final default.
    const latestReleasedEvent = eventStreamItems.find(
      (item) => String(item?.eventType || "").toUpperCase() === "SONG_RELEASED"
    );
    const latestReleaseSource = event.source
      || latestReleasedEvent?.source
      || eventStreamItems[0]?.source
      || "youtube";
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

    let effectivelyApproved = Boolean(event.approved);
    let autoApproved = false;
    if (!effectivelyApproved && shouldAutoApprove(event, source, AUTO_APPROVE_SOURCES)) {
      effectivelyApproved = true;
      autoApproved = true;
      logStage("publish-auto-approved", {
        releaseId,
        source,
        autoApproveSources: AUTO_APPROVE_SOURCES,
        invocationSource: event.source,
        detailType: event["detail-type"] || event.detailType,
        elapsedMs: Date.now() - startedAt
      });
    }

    if (!effectivelyApproved) {
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
        autoApproved,
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

/* c8 ignore stop */
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
  parseAutoApproveSources,
  isCronInvocation,
  shouldAutoApprove,
  cleanReleaseTitle,
  isValidArtworkUrl,
  cleanLyrics,
  mergeReleasedWithComingSoon,
  compareReleaseEventsDesc,
  normalizeReleaseEventItem,
  normalizeSongTableItem,
  buildSongView,
  buildEmptySiteArtifact,
  hashContent
};
