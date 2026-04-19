const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const {
  assemblePromptDocument,
  estimateTokenCount,
  normalizePromptText
} = require("./prompt-assembly");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.DYNAMO_TABLE || "shieldbearer-sentinel-logs";
const BASE_PROMPT_KEY = "config:system-prompt-base-staging";
const EXPANDED_PROMPT_KEY = "config:system-prompt-expanded-staging";
const YOUTUBE_KNOWLEDGE_KEY = "knowledge:youtube-staging";
const FACEBOOK_KNOWLEDGE_KEY = "knowledge:facebook-staging";
const FACEBOOK_RAW_KEY = "knowledge:facebook-staging-raw";
const FACEBOOK_SUMMARY_KEY = "knowledge:facebook-staging-summary";
const FACEBOOK_RECENT_KEY = "knowledge:facebook-staging-recent";
const FACEBOOK_META_KEY = "meta:facebook-staging";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || "";
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || "";
const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID || "";
const FACEBOOK_GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION || "v19.0";
const DEFAULT_VERSION = process.env.SENTINELBOT_STAGING_VERSION || process.env.SENTINELBOT_VERSION || "1.0";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function logStage(event, details) {
  console.log(JSON.stringify({
    stage: event,
    timestamp: nowIso(),
    ...details
  }));
}

function toSourceList(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") {
    return input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }
  return [];
}

function resolveSourceUrl(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry.trim();
  return String(entry.url || entry.link || entry.href || "").trim();
}

function resolveSourceLabel(entry, fallback) {
  if (!entry) return fallback;
  if (typeof entry === "string") return fallback;
  return String(entry.title || entry.label || entry.name || fallback || "").trim() || fallback;
}

function extractHtmlField(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return normalizePromptText(match[1]);
    }
  }
  return "";
}

function extractKnowledgeText(html) {
  const candidate = extractHtmlField(html, [
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:description["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i
  ]);
  if (candidate) return candidate;

  const title = extractHtmlField(html, [
    /<title[^>]*>([\s\S]*?)<\/title>/i
  ]);
  return title || "";
}

async function fetchYouTubeJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`YouTube API HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchYouTubeUploadsPlaylistId() {
  if (!YOUTUBE_API_KEY || !YOUTUBE_CHANNEL_ID) {
    throw new Error("Missing YOUTUBE_API_KEY or YOUTUBE_CHANNEL_ID");
  }

  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "contentDetails");
  url.searchParams.set("id", YOUTUBE_CHANNEL_ID);
  url.searchParams.set("key", YOUTUBE_API_KEY);

  const data = await fetchYouTubeJson(url.toString());
  const playlistId = data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || "";
  if (!playlistId) {
    throw new Error("Could not resolve uploads playlist from channel");
  }
  return playlistId;
}

async function fetchChannelVideoIds(playlistId) {
  const videoIds = [];
  let pageToken = "";

  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("key", YOUTUBE_API_KEY);
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const data = await fetchYouTubeJson(url.toString());
    for (const item of data?.items || []) {
      const videoId = item?.contentDetails?.videoId;
      if (videoId) {
        videoIds.push({
          videoId,
          publishedAt: item?.contentDetails?.videoPublishedAt || item?.snippet?.publishedAt || "",
          playlistItemId: item?.id || ""
        });
      }
    }
    pageToken = data?.nextPageToken || "";
  } while (pageToken);

  return videoIds;
}

async function fetchYouTubeVideos(videoIds) {
  const batches = [];
  const ids = videoIds.map((item) => item.videoId).filter(Boolean);

  for (let i = 0; i < ids.length; i += 50) {
    batches.push(ids.slice(i, i + 50));
  }

  const videos = [];

  for (const batch of batches) {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,contentDetails");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("maxResults", String(batch.length));
    url.searchParams.set("key", YOUTUBE_API_KEY);

    const data = await fetchYouTubeJson(url.toString());
    for (const item of data?.items || []) {
      const snippet = item?.snippet || {};
      videos.push({
        videoId: item?.id || "",
        title: normalizePromptText(snippet.title || ""),
        description: normalizePromptText(snippet.description || ""),
        publishedAt: snippet.publishedAt || "",
        channelTitle: normalizePromptText(snippet.channelTitle || ""),
        url: `https://www.youtube.com/watch?v=${item?.id || ""}`
      });
    }
  }

  const order = new Map(ids.map((videoId, index) => [videoId, index]));
  videos.sort((a, b) => {
    const aOrder = order.get(a.videoId) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = order.get(b.videoId) ?? Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });

  return videos;
}

async function buildYouTubeKnowledgeFromApi() {
  const uploadsPlaylistId = await fetchYouTubeUploadsPlaylistId();
  const playlistItems = await fetchChannelVideoIds(uploadsPlaylistId);
  const videos = await fetchYouTubeVideos(playlistItems);

  const sections = videos.map((video) => ({
    title: `${video.title || video.videoId} | ${video.publishedAt || "unknown date"}`,
    value: [
      `Video ID: ${video.videoId}`,
      `URL: ${video.url}`,
      `Published: ${video.publishedAt || "unknown"}`,
      `Channel: ${video.channelTitle || "unknown"}`,
      `Description: ${video.description || "No description provided."}`
    ].join("\n")
  }));

  const document = assemblePromptDocument([
    {
      title: "youtube knowledge",
      value: sections.length
        ? sections.map((section) => `- ${section.title}\n${section.value}`).join("\n\n")
        : "No YouTube videos found."
    }
  ]);

  return {
    sourceCount: videos.length,
    successCount: videos.length,
    failureCount: 0,
    failures: [],
    videos,
    body: document.prompt,
    document,
    byteSize: document.byteSize,
    tokenEstimate: document.tokenEstimate
  };
}

function parseBoolean(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "string") {
    return ["true", "1", "yes", "on"].includes(value.toLowerCase().trim());
  }
  return false;
}

function parseTimestamp(value) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatIsoDate(value) {
  const parsed = parseTimestamp(value);
  if (!parsed) return "unknown";
  return new Date(parsed).toISOString();
}

function truncateText(value, maxLength = 240) {
  const text = normalizePromptText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildFacebookGraphUrl(path, params = {}) {
  const url = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}${path}`);
  url.searchParams.set("access_token", FACEBOOK_ACCESS_TOKEN);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function fetchFacebookJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Facebook Graph API HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchFacebookPostsPage({ since, until, after }) {
  if (!FACEBOOK_ACCESS_TOKEN || !FACEBOOK_PAGE_ID) {
    throw new Error("Missing FACEBOOK_ACCESS_TOKEN or FACEBOOK_PAGE_ID");
  }

  const fields = [
    "id",
    "message",
    "story",
    "created_time",
    "updated_time",
    "permalink_url",
    "full_picture",
    "attachments{media_type,url,title,description,subattachments}"
  ].join(",");

  const url = buildFacebookGraphUrl(`/${FACEBOOK_PAGE_ID}/posts`, {
    fields,
    limit: 100,
    since,
    until,
    after
  });

  return fetchFacebookJson(url);
}

function collectAttachmentText(attachments) {
  const parts = [];
  for (const attachment of attachments || []) {
    if (!attachment) continue;
    const nested = attachment?.subattachments?.data || [];
    if (attachment.title) parts.push(attachment.title);
    if (attachment.description) parts.push(attachment.description);
    if (attachment.url) parts.push(attachment.url);
    for (const child of nested) {
      if (child?.title) parts.push(child.title);
      if (child?.description) parts.push(child.description);
      if (child?.url) parts.push(child.url);
    }
  }
  return parts.filter(Boolean).join("\n");
}

function normalizeFacebookPost(item) {
  const attachments = Array.isArray(item?.attachments?.data) ? item.attachments.data : [];
  const attachmentText = collectAttachmentText(attachments);
  const text = normalizePromptText([
    item?.message || "",
    item?.story || "",
    attachmentText || ""
  ].filter(Boolean).join("\n"));

  return {
    id: item?.id || "",
    message: normalizePromptText(item?.message || ""),
    story: normalizePromptText(item?.story || ""),
    createdTime: item?.created_time || "",
    updatedTime: item?.updated_time || "",
    permalinkUrl: item?.permalink_url || `https://www.facebook.com/${item?.id || ""}`,
    fullPicture: item?.full_picture || "",
    attachments: attachments.map((attachment) => ({
      mediaType: attachment?.media_type || "",
      url: attachment?.url || "",
      title: normalizePromptText(attachment?.title || ""),
      description: normalizePromptText(attachment?.description || "")
    })),
    text
  };
}

function compareFacebookPosts(a, b) {
  const timeDelta = parseTimestamp(b.createdTime) - parseTimestamp(a.createdTime);
  if (timeDelta !== 0) return timeDelta;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

function dedupeFacebookPosts(posts) {
  const seen = new Map();
  for (const post of posts || []) {
    if (!post?.id) continue;
    const previous = seen.get(post.id);
    if (!previous) {
      seen.set(post.id, post);
      continue;
    }
    const keep = compareFacebookPosts(post, previous) < 0 ? post : previous;
    seen.set(post.id, keep);
  }
  return Array.from(seen.values()).sort(compareFacebookPosts);
}

async function fetchFacebookPosts({ since, until }) {
  const posts = [];
  let nextAfter = "";
  let pageCount = 0;

  while (true) {
    const data = await fetchFacebookPostsPage({ since, until, after: nextAfter || undefined });
    pageCount += 1;
    for (const item of data?.data || []) {
      const post = normalizeFacebookPost(item);
      if (post.id) {
        posts.push(post);
      }
    }
    const next = data?.paging?.next || "";
    if (!next) break;
    const cursors = data?.paging?.cursors || {};
    nextAfter = cursors?.after || "";
    if (!nextAfter) break;
  }

  return {
    posts: dedupeFacebookPosts(posts),
    pageCount
  };
}

async function loadDynamoItem(id) {
  const response = await dynamo.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      id
    }
  }));
  return response?.Item || null;
}

function extractStoredFacebookPosts(rawItem) {
  const posts = rawItem?.posts;
  if (!Array.isArray(posts)) return [];
  return posts
    .map((post) => normalizeFacebookPost(post))
    .filter((post) => post.id);
}

function filterPostsByWindow(posts, cutoffMs) {
  return posts.filter((post) => parseTimestamp(post.createdTime) >= cutoffMs);
}

function summarizeFacebookPost(post) {
  const text = normalizePromptText(post.text || post.message || post.story || "");
  const snippet = truncateText(text, 220) || "No text available.";
  return [
    `${formatIsoDate(post.createdTime)} | ${snippet}`,
    `Link: ${post.permalinkUrl}`
  ].join("\n");
}

function classifyFacebookPost(post) {
  const text = normalizePromptText([
    post.message,
    post.story,
    post.text,
    (post.attachments || []).map((attachment) => [
      attachment.title,
      attachment.description
    ].filter(Boolean).join(" ")).join(" ")
  ].filter(Boolean).join("\n")).toLowerCase();

  const categories = new Set();

  if (/(release|released|new song|new video|premiere|album|single|ep|out now|listen|stream|watch|spotify|youtube|bandcamp)/i.test(text)) {
    categories.add("releases");
  }

  if (/(ai|artificial intelligence|machine learning|prompt|generated|tool|technology|model|algorithm|inference)/i.test(text)) {
    categories.add("mission and ai stance");
  }

  if (/(jesus|christ|scripture|verse|bible|god|gospel|cross|salvation|worship|prayer|grace|faith|holy)/i.test(text)) {
    categories.add("theology and message");
  }

  if (/(guitar|ibanez|mesa|amp|pedal|tone|pickup|studio|mix|mixing|drum|drums|fabfilter|neural|tonex|wampler|boss|recording|production)/i.test(text)) {
    categories.add("gear and production");
  }

  if (/(backlash|critic|critics|controversy|accusation|accused|fraud|fake|reply|response|defend|argument|issue|concern)/i.test(text)) {
    categories.add("controversies and public responses");
  }

  if (!categories.size) {
    categories.add("theology and message");
  }

  return Array.from(categories);
}

function buildSectionBlock(title, posts) {
  const orderedPosts = [...posts].sort(compareFacebookPosts);
  const lines = orderedPosts.length
    ? orderedPosts.slice(0, 24).map((post) => `- ${summarizeFacebookPost(post)}`).join("\n\n")
    : "- No posts in this section.";
  return `=== ${title.toUpperCase()} ===\n${lines}`;
}

function buildFacebookSummaryDocument(posts) {
  const buckets = {
    "releases": [],
    "mission and ai stance": [],
    "theology and message": [],
    "gear and production": [],
    "controversies and public responses": []
  };

  for (const post of posts) {
    for (const category of classifyFacebookPost(post)) {
      buckets[category].push(post);
    }
  }

  const summaryText = [
    buildSectionBlock("releases", buckets["releases"]),
    buildSectionBlock("mission and AI stance", buckets["mission and ai stance"]),
    buildSectionBlock("theology and message", buckets["theology and message"]),
    buildSectionBlock("gear and production", buckets["gear and production"]),
    buildSectionBlock("controversies and public responses", buckets["controversies and public responses"])
  ].join("\n\n");

  const document = assemblePromptDocument([
    {
      title: "facebook summary",
      value: summaryText
    }
  ]);

  return {
    content: summaryText,
    document,
    byteSize: document.byteSize,
    tokenEstimate: document.tokenEstimate
  };
}

function buildFacebookRecentDocument(posts) {
  const recentText = posts.length
    ? posts
      .slice(0, 40)
      .sort(compareFacebookPosts)
      .map((post) => `- ${summarizeFacebookPost(post)}`)
      .join("\n\n")
    : "- No Facebook posts in the recent 30 day window.";

  const document = assemblePromptDocument([
    {
      title: "facebook recent",
      value: recentText
    }
  ]);

  return {
    content: recentText,
    document,
    byteSize: document.byteSize,
    tokenEstimate: document.tokenEstimate
  };
}

async function persistFacebookItem(id, item) {
  await persistItem(id, {
    ...item,
    summaryVersion: DEFAULT_VERSION
  });
}

async function buildFacebookKnowledgeFromApi({ forceFullRebuild = false } = {}) {
  const metaItem = await loadDynamoItem(FACEBOOK_META_KEY);
  const rawItem = await loadDynamoItem(FACEBOOK_RAW_KEY);
  const now = Date.now();
  const fullCutoffMs = now - ONE_YEAR_MS;
  const recentCutoffMs = now - THIRTY_DAYS_MS;
  const existingRawPosts = extractStoredFacebookPosts(rawItem);
  const lastFullBuildAt = metaItem?.lastFullBuildAt || null;
  const lastDeltaProcessedAt = metaItem?.lastDeltaProcessedAt || null;
  const previousSeenTime = metaItem?.lastSeenPostTime || null;
  const isInitialBuild = !lastFullBuildAt;
  const useFullBuild = forceFullRebuild || isInitialBuild;
  const sinceIso = useFullBuild
    ? new Date(fullCutoffMs).toISOString()
    : (lastDeltaProcessedAt || lastFullBuildAt || previousSeenTime || new Date(fullCutoffMs).toISOString());
  const startedAt = Date.now();

  logStage("facebook-ingest-start", {
    timestamp: nowIso(),
    mode: useFullBuild ? "full" : "delta",
    forceFullRebuild: Boolean(forceFullRebuild),
    sinceIso
  });

  let fetchedPosts = [];
  let pageCount = 0;
  try {
    const fetched = await fetchFacebookPosts({
      since: sinceIso,
      until: nowIso()
    });
    fetchedPosts = fetched.posts;
    pageCount = fetched.pageCount;
  } catch (error) {
    logStage("facebook-ingest-failed", {
      timestamp: nowIso(),
      mode: useFullBuild ? "full" : "delta",
      forceFullRebuild: Boolean(forceFullRebuild),
      error: error.message
    });
    throw error;
  }

  const mergedPosts = useFullBuild
    ? fetchedPosts
    : dedupeFacebookPosts([...existingRawPosts, ...fetchedPosts]);
  const rawPosts = filterPostsByWindow(mergedPosts, fullCutoffMs);
  const recentPosts = filterPostsByWindow(rawPosts, recentCutoffMs);
  const lastSeenPostTime = rawPosts.reduce((latest, post) => {
    const current = parseTimestamp(post.createdTime);
    return current > latest ? current : latest;
  }, 0);

  const summaryDocument = buildFacebookSummaryDocument(rawPosts);
  const recentDocument = buildFacebookRecentDocument(recentPosts);
  const combinedFacebookDocument = assemblePromptDocument([
    {
      title: "Facebook summary",
      value: summaryDocument.content
    },
    {
      title: "Facebook recent",
      value: recentDocument.content
    }
  ]);

  const ingestTimestamp = nowIso();
  const sharedMeta = {
    version: `${DEFAULT_VERSION}-staging`,
    rawPostCount: rawPosts.length,
    recentPostCount: recentPosts.length,
    summaryVersion: DEFAULT_VERSION,
    lastSeenPostTime: lastSeenPostTime ? new Date(lastSeenPostTime).toISOString() : null,
    sourcePageCount: pageCount,
    fetchedPostCount: fetchedPosts.length,
    rawStoredCount: rawPosts.length,
    recentStoredCount: recentPosts.length,
    summaryByteSize: summaryDocument.byteSize,
    summaryTokenEstimate: summaryDocument.tokenEstimate,
    elapsedMs: Date.now() - startedAt
  };

  await persistFacebookItem(FACEBOOK_RAW_KEY, {
    value: JSON.stringify({
      mode: useFullBuild ? "full" : "delta",
      generatedAt: ingestTimestamp,
      windowDays: 365,
      posts: rawPosts
    }, null, 2),
    generatedAt: ingestTimestamp,
    mode: useFullBuild ? "full" : "delta",
    lastFullBuildAt: useFullBuild ? ingestTimestamp : lastFullBuildAt,
    lastDeltaProcessedAt: useFullBuild ? null : ingestTimestamp,
    lastSeenPostTime: lastSeenPostTime ? new Date(lastSeenPostTime).toISOString() : null,
    posts: rawPosts
  });

  await persistFacebookItem(FACEBOOK_SUMMARY_KEY, {
    value: summaryDocument.prompt,
    byteSize: summaryDocument.byteSize,
    tokenEstimate: summaryDocument.tokenEstimate,
    generatedAt: ingestTimestamp,
    sectionOrder: [
      "releases",
      "mission and ai stance",
      "theology and message",
      "gear and production",
      "controversies and public responses"
    ],
    postCount: rawPosts.length,
    sourceCount: fetchedPosts.length
  });

  await persistFacebookItem(FACEBOOK_RECENT_KEY, {
    value: recentDocument.prompt,
    byteSize: recentDocument.byteSize,
    tokenEstimate: recentDocument.tokenEstimate,
    generatedAt: ingestTimestamp,
    windowDays: 30,
    postCount: recentPosts.length,
    sourceCount: fetchedPosts.length
  });

  await persistFacebookItem(FACEBOOK_KNOWLEDGE_KEY, {
    value: combinedFacebookDocument.prompt,
    byteSize: combinedFacebookDocument.byteSize,
    tokenEstimate: combinedFacebookDocument.tokenEstimate,
    generatedAt: ingestTimestamp,
    sections: ["summary", "recent"],
    postCount: rawPosts.length
  });

  await persistFacebookItem(FACEBOOK_META_KEY, {
    ...sharedMeta,
    lastFullBuildAt: useFullBuild ? ingestTimestamp : lastFullBuildAt,
    lastDeltaProcessedAt: useFullBuild ? null : ingestTimestamp,
    buildMode: useFullBuild ? "full" : "delta",
    forceFullRebuild: Boolean(forceFullRebuild),
    sourceKeys: {
      raw: FACEBOOK_RAW_KEY,
      summary: FACEBOOK_SUMMARY_KEY,
      recent: FACEBOOK_RECENT_KEY
    }
  });

  logStage("facebook-ingest-complete", {
    timestamp: ingestTimestamp,
    mode: useFullBuild ? "full" : "delta",
    forceFullRebuild: Boolean(forceFullRebuild),
    fetchedPostCount: fetchedPosts.length,
    rawStoredCount: rawPosts.length,
    recentStoredCount: recentPosts.length,
    summaryByteSize: summaryDocument.byteSize,
    summaryTokenEstimate: summaryDocument.tokenEstimate,
    elapsedMs: Date.now() - startedAt,
    failureCount: 0
  });

  return {
    mode: useFullBuild ? "full" : "delta",
    fetchedPostCount: fetchedPosts.length,
    rawStoredCount: rawPosts.length,
    recentStoredCount: recentPosts.length,
    summaryDocument,
    recentDocument,
    summaryContent: summaryDocument.content,
    recentContent: recentDocument.content,
    combinedFacebookDocument,
    lastSeenPostTime: lastSeenPostTime ? new Date(lastSeenPostTime).toISOString() : null,
    lastFullBuildAt: useFullBuild ? ingestTimestamp : lastFullBuildAt,
    lastDeltaProcessedAt: useFullBuild ? null : ingestTimestamp,
    meta: {
      ...sharedMeta,
      buildMode: useFullBuild ? "full" : "delta",
      forceFullRebuild: Boolean(forceFullRebuild)
    }
  };
}

async function getBasePrompt() {
  const response = await dynamo.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      id: BASE_PROMPT_KEY
    }
  }));
  const value = normalizePromptText(response?.Item?.value || "");
  if (!value) {
    throw new Error(`Missing or empty staging base prompt: ${BASE_PROMPT_KEY}`);
  }
  return value;
}

async function persistItem(id, item) {
  await dynamo.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      id,
      updatedAt: nowIso(),
      ...item
    }
  }));
}

async function scrapeKnowledgeSource(kind, sources) {
  const sourceList = toSourceList(sources);
  const successes = [];
  const failures = [];

  for (const entry of sourceList) {
    const url = resolveSourceUrl(entry);
    const label = resolveSourceLabel(entry, url);

    if (!url) {
      failures.push({ label, error: "Missing URL" });
      continue;
    }

    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "SentinelBot-Staging/1.0"
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();
      const extracted = extractKnowledgeText(html);
      const value = normalizePromptText(extracted || html.slice(0, 600));

      if (!value) {
        throw new Error("No knowledge text extracted");
      }

      successes.push({
        label,
        url,
        value,
        byteSize: Buffer.byteLength(value, "utf8"),
        tokenEstimate: estimateTokenCount(value)
      });
    } catch (error) {
      failures.push({
        label,
        url,
        error: error.message
      });
    }
  }

  const body = successes.length
    ? successes
      .map((item) => `- ${item.label}\n  ${item.value}\n  Source: ${item.url}`)
      .join("\n\n")
    : `No ${kind} knowledge collected.`;

  const knowledgeDocument = assemblePromptDocument([
    {
      title: `${kind} knowledge`,
      value: body
    }
  ]);

  logStage(`${kind}-scrape-summary`, {
    timestamp: nowIso(),
    sourceCount: sourceList.length,
    successCount: successes.length,
    failureCount: failures.length,
    failures
  });

  return {
    kind,
    sourceCount: sourceList.length,
    successCount: successes.length,
    failureCount: failures.length,
    failures,
    successes,
    body,
    document: knowledgeDocument,
    byteSize: knowledgeDocument.byteSize,
    tokenEstimate: knowledgeDocument.tokenEstimate
  };
}

async function writeKnowledgeItem(key, result) {
  await persistItem(key, {
    value: result.document.prompt,
    version: `${DEFAULT_VERSION}-staging`,
    tokenEstimate: result.tokenEstimate,
    byteSize: result.byteSize,
    sourceCount: result.sourceCount,
    successCount: result.successCount,
    failureCount: result.failureCount,
    failures: result.failures
  });
}

async function writeExpandedPrompt(basePrompt, youtubeResult, facebookSummaryResult, facebookRecentResult) {
  const document = assemblePromptDocument([
    {
      title: "Base prompt",
      value: basePrompt
    },
    {
      title: "YouTube knowledge",
      value: youtubeResult.body
    },
    {
      title: "Facebook summary",
      value: facebookSummaryResult.body
    },
    {
      title: "Facebook recent",
      value: facebookRecentResult.body
    }
  ]);

  await persistItem(EXPANDED_PROMPT_KEY, {
    value: document.prompt,
    version: `${DEFAULT_VERSION}-staging`,
    tokenEstimate: document.tokenEstimate,
    byteSize: document.byteSize,
    assembledAt: nowIso(),
    sourceKeys: {
      base: BASE_PROMPT_KEY,
      youtube: YOUTUBE_KNOWLEDGE_KEY,
      facebookSummary: FACEBOOK_SUMMARY_KEY,
      facebookRecent: FACEBOOK_RECENT_KEY
    },
    sourceCounts: {
      youtube: youtubeResult.sourceCount,
      facebookSummary: facebookSummaryResult.sourceCount,
      facebookRecent: facebookRecentResult.sourceCount
    },
    failures: {
      youtube: youtubeResult.failures,
      facebookSummary: facebookSummaryResult.failures,
      facebookRecent: facebookRecentResult.failures
    }
  });

  return document;
}

exports.handler = async (event = {}) => {
  const startedAt = Date.now();
  const requestTimestamp = nowIso();
  const useApiYoutube = event.useApiYoutube !== false;
  const youtubeSources = event.youtubeSources || event.youtubeUrls || process.env.YOUTUBE_SOURCES || [];
  const forceFullRebuild = parseBoolean(event.forceFullRebuild) || parseBoolean(process.env.FACEBOOK_FORCE_FULL_REBUILD);

  try {
    const basePrompt = normalizePromptText(event.basePrompt || await getBasePrompt());
    const baseStats = {
      byteSize: Buffer.byteLength(basePrompt, "utf8"),
      tokenEstimate: estimateTokenCount(basePrompt)
    };

    logStage("base-prompt-loaded", {
      timestamp: requestTimestamp,
      byteSize: baseStats.byteSize,
      tokenEstimate: baseStats.tokenEstimate,
      promptKey: BASE_PROMPT_KEY
    });

    const youtubeResult = useApiYoutube
      ? await buildYouTubeKnowledgeFromApi()
      : await scrapeKnowledgeSource("youtube", youtubeSources);

    await writeKnowledgeItem(YOUTUBE_KNOWLEDGE_KEY, youtubeResult);

    const facebookResult = await buildFacebookKnowledgeFromApi({ forceFullRebuild });
    const facebookSummaryResult = {
      sourceCount: facebookResult.fetchedPostCount,
      successCount: facebookResult.rawStoredCount,
      failureCount: 0,
      failures: [],
      body: facebookResult.summaryContent,
      document: facebookResult.summaryDocument,
      byteSize: facebookResult.summaryDocument.byteSize,
      tokenEstimate: facebookResult.summaryDocument.tokenEstimate
    };
    const facebookRecentResult = {
      sourceCount: facebookResult.fetchedPostCount,
      successCount: facebookResult.recentStoredCount,
      failureCount: 0,
      failures: [],
      body: facebookResult.recentContent,
      document: facebookResult.recentDocument,
      byteSize: facebookResult.recentDocument.byteSize,
      tokenEstimate: facebookResult.recentDocument.tokenEstimate
    };

    const expanded = await writeExpandedPrompt(basePrompt, youtubeResult, facebookSummaryResult, facebookRecentResult);

    logStage("staging-prompt-built", {
      timestamp: requestTimestamp,
      promptByteSize: expanded.byteSize,
      tokenEstimate: expanded.tokenEstimate,
      scrapeCounts: {
        youtube: youtubeResult.successCount,
        facebookSummary: facebookSummaryResult.successCount,
        facebookRecent: facebookRecentResult.successCount
      },
      failureCounts: {
        youtube: youtubeResult.failureCount,
        facebookSummary: facebookSummaryResult.failureCount,
        facebookRecent: facebookRecentResult.failureCount
      },
      elapsedMs: Date.now() - startedAt
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        version: `${DEFAULT_VERSION}-staging`,
        promptKey: EXPANDED_PROMPT_KEY,
        promptByteSize: expanded.byteSize,
        tokenEstimate: expanded.tokenEstimate,
        scrapeCounts: {
          youtube: youtubeResult.successCount,
          facebookSummary: facebookSummaryResult.successCount,
          facebookRecent: facebookRecentResult.successCount
        },
        failureCounts: {
          youtube: youtubeResult.failureCount,
          facebookSummary: facebookSummaryResult.failureCount,
          facebookRecent: facebookRecentResult.failureCount
        }
      })
    };
  } catch (error) {
    logStage("staging-prompt-build-failed", {
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
  assemblePromptDocument,
  scrapeKnowledgeSource,
  extractKnowledgeText,
  buildFacebookKnowledgeFromApi,
  buildYouTubeKnowledgeFromApi
};
