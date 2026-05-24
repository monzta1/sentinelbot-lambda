/* =============================================================
   SHIELDBEARER. DistroKid stats screenshot parser.

   Mirrors the visitor-logger / metrics-publisher pattern:
   - API Gateway HTTP trigger, x-admin-key auth for both POST + GET
   - Same AWS account/region as the rest of the fleet
   - DynamoDB single-line JSON writes
   - GitHub commit of the canonical public artifact
   - No new paid AWS resources beyond Lambda + API Gateway + DynamoDB

   Flow:
     POST /stats  (x-admin-key, body: { image_base64, mime_type })
       1. Call Claude vision model with a tight prompt for the
          DistroKid screenshot layouts (totals screen A, country
          screen B). Returns strict JSON only.
       2. Sanity check the parsed total_streams against the last
          published total. Reject if lower OR if the jump exceeds
          STATS_SANITY_CEILING (default 2500 streams per update).
       3. If sane: merge with existing per_country (operator may
          upload only the totals screen sometimes, or only the
          country screen). Write to stats_history table. Commit
          /reach.json to shieldbearer-website. Return the parse.
       4. If rejected: write the suspect parse with published=false
          and review_flag set. Do NOT update /reach.json. Return
          the rejected parse so the admin page can display the
          flag.

     GET /stats  (x-admin-key)
       Returns the latest published record + the recent suspect
       parses flagged for review.

   The public website fetches /reach.json directly from the repo
   (no Lambda call per pageview, matching site.json + admin/metrics.json).
   ============================================================= */
const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  QueryCommand
} = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const TABLE_NAME = process.env.STATS_TABLE || "shieldbearer_stats_history";
const ALLOWED_ORIGIN = process.env.STATS_ALLOWED_ORIGIN || "https://shieldbearerusa.com";
const ADMIN_KEY = process.env.STATS_ADMIN_KEY || "shieldbearer-stats-2026";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const SANITY_CEILING = Math.max(100, Number.parseInt(process.env.STATS_SANITY_CEILING || "2500", 10) || 2500);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "monzta1";
const GITHUB_REPO = process.env.GITHUB_REPO || "shieldbearer-website";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "sentinelbot-stable";
const REACH_JSON_PATH = "reach.json";

// Anthropic vision model. Sonnet 4.6 is current per CLAUDE.md
// memory; vision-capable; same key as SentinelBot handler.
const VISION_MODEL = process.env.STATS_VISION_MODEL || "claude-sonnet-4-6";

function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-admin-key",
    "Content-Type": "application/json"
  };
}

function reply(statusCode, body) {
  return { statusCode, headers: cors(), body: JSON.stringify(body) };
}

function readBody(event) {
  if (!event || !event.body) return {};
  let raw = event.body;
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function headerValue(event, name) {
  const h = (event && event.headers) || {};
  return h[name] || h[name.toLowerCase()] || h[name.toUpperCase()] || "";
}

function checkAdminKey(event) {
  const provided = String(headerValue(event, "x-admin-key") || "");
  const expected = String(ADMIN_KEY);
  if (!provided || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

// Country canonical names + ISO codes + flag emoji. Built from the
// names DistroKid uses; extend as new countries appear in uploads.
const COUNTRY_TABLE = {
  "United States": { code: "US", flag: "🇺🇸" },
  "USA": { code: "US", flag: "🇺🇸" },
  "United Kingdom": { code: "GB", flag: "🇬🇧" },
  "UK": { code: "GB", flag: "🇬🇧" },
  "Germany": { code: "DE", flag: "🇩🇪" },
  "France": { code: "FR", flag: "🇫🇷" },
  "The Netherlands": { code: "NL", flag: "🇳🇱" },
  "Netherlands": { code: "NL", flag: "🇳🇱" },
  "Belgium": { code: "BE", flag: "🇧🇪" },
  "Sweden": { code: "SE", flag: "🇸🇪" },
  "Canada": { code: "CA", flag: "🇨🇦" },
  "Switzerland": { code: "CH", flag: "🇨🇭" },
  "Spain": { code: "ES", flag: "🇪🇸" },
  "Brazil": { code: "BR", flag: "🇧🇷" },
  "Italy": { code: "IT", flag: "🇮🇹" },
  "Singapore": { code: "SG", flag: "🇸🇬" },
  "Mexico": { code: "MX", flag: "🇲🇽" },
  "Austria": { code: "AT", flag: "🇦🇹" },
  "India": { code: "IN", flag: "🇮🇳" },
  "United Arab Emirates": { code: "AE", flag: "🇦🇪" },
  "UAE": { code: "AE", flag: "🇦🇪" },
  "Australia": { code: "AU", flag: "🇦🇺" },
  "Japan": { code: "JP", flag: "🇯🇵" },
  "South Korea": { code: "KR", flag: "🇰🇷" },
  "Korea": { code: "KR", flag: "🇰🇷" },
  "Poland": { code: "PL", flag: "🇵🇱" },
  "Norway": { code: "NO", flag: "🇳🇴" },
  "Denmark": { code: "DK", flag: "🇩🇰" },
  "Finland": { code: "FI", flag: "🇫🇮" },
  "Ireland": { code: "IE", flag: "🇮🇪" },
  "Portugal": { code: "PT", flag: "🇵🇹" },
  "Greece": { code: "GR", flag: "🇬🇷" },
  "Czech Republic": { code: "CZ", flag: "🇨🇿" },
  "Czechia": { code: "CZ", flag: "🇨🇿" },
  "Hungary": { code: "HU", flag: "🇭🇺" },
  "Romania": { code: "RO", flag: "🇷🇴" },
  "Russia": { code: "RU", flag: "🇷🇺" },
  "Ukraine": { code: "UA", flag: "🇺🇦" },
  "Turkey": { code: "TR", flag: "🇹🇷" },
  "Israel": { code: "IL", flag: "🇮🇱" },
  "South Africa": { code: "ZA", flag: "🇿🇦" },
  "Argentina": { code: "AR", flag: "🇦🇷" },
  "Chile": { code: "CL", flag: "🇨🇱" },
  "Colombia": { code: "CO", flag: "🇨🇴" },
  "Philippines": { code: "PH", flag: "🇵🇭" },
  "Indonesia": { code: "ID", flag: "🇮🇩" },
  "Malaysia": { code: "MY", flag: "🇲🇾" },
  "Thailand": { code: "TH", flag: "🇹🇭" },
  "Vietnam": { code: "VN", flag: "🇻🇳" },
  "China": { code: "CN", flag: "🇨🇳" },
  "Hong Kong": { code: "HK", flag: "🇭🇰" },
  "Taiwan": { code: "TW", flag: "🇹🇼" },
  "New Zealand": { code: "NZ", flag: "🇳🇿" },
  "Saudi Arabia": { code: "SA", flag: "🇸🇦" },
  "Egypt": { code: "EG", flag: "🇪🇬" },
  "Nigeria": { code: "NG", flag: "🇳🇬" },
  "Kenya": { code: "KE", flag: "🇰🇪" }
};

function canonicalizeCountry(name) {
  if (!name) return null;
  const trimmed = String(name).trim();
  if (COUNTRY_TABLE[trimmed]) {
    return { country: trimmed, code: COUNTRY_TABLE[trimmed].code, flag: COUNTRY_TABLE[trimmed].flag };
  }
  // Case-insensitive fallback.
  const lower = trimmed.toLowerCase();
  for (const k of Object.keys(COUNTRY_TABLE)) {
    if (k.toLowerCase() === lower) {
      return { country: k, code: COUNTRY_TABLE[k].code, flag: COUNTRY_TABLE[k].flag };
    }
  }
  // Unknown -- still record it but with empty code so the public
  // page can surface "unmapped" rows for the operator to extend
  // COUNTRY_TABLE later.
  return { country: trimmed, code: "", flag: "" };
}

// =====================================================
// Vision call. Tight prompt, strict-JSON contract.
// =====================================================
async function parseScreenshot(imageBase64, mimeType) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const prompt = [
    "You are reading a DistroKid stats screenshot from a phone.",
    "Return ONLY valid JSON in the shape below. No prose, no markdown fences, no commentary.",
    "",
    "Two screen types exist. Whichever you see, extract what is visible. Omit fields you cannot see; do not invent.",
    "",
    "Screen A (totals): has a Spotify header and rows like 'Last 365 days' / 'Last 90 days' / 'Last 30 days' / 'Last 7 days' each followed by a number formatted like '9,724 streams'.",
    "Screen B (countries): has a 'Streams by Country' list. Each row is a flag + country name + a number. Examples: 'United States 3,164', 'The Netherlands 218', 'United Arab Emirates 17'.",
    "",
    "Rules:",
    "- Strip ALL commas from numbers. '9,724' becomes 9724.",
    "- Numbers are integers. No decimals.",
    "- Use the country name exactly as displayed (e.g. 'United Kingdom', 'The Netherlands').",
    "- If the screenshot is cropped, return only what is visible.",
    "- Do NOT guess at numbers you cannot read.",
    "",
    "Output exactly this JSON shape (omit fields not visible):",
    "{",
    '  "total_streams": <integer, from "Last 365 days" line>,',
    '  "last_90": <integer>,',
    '  "last_30": <integer>,',
    '  "last_7": <integer>,',
    '  "per_country": [ {"country": "<name>", "streams": <integer>}, ... ]',
    "}"
  ].join("\n");

  const body = {
    model: VISION_MODEL,
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mimeType || "image/jpeg", data: imageBase64 }
          },
          { type: "text", text: prompt }
        ]
      }
    ]
  };

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error("Anthropic HTTP " + resp.status + ": " + text.slice(0, 300));
  }
  const data = await resp.json();
  const text = (data && data.content && data.content[0] && data.content[0].text) || "";
  // Be defensive: strip code fences if the model added them despite the prompt.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, "");
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Model output was not valid JSON. First 200 chars: " + cleaned.slice(0, 200));
  }
  return normalizeParsed(parsed);
}

function intOrNull(v) {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function normalizeParsed(p) {
  const out = {};
  if (p.total_streams != null) out.total_streams = intOrNull(p.total_streams);
  if (p.last_90 != null) out.last_90 = intOrNull(p.last_90);
  if (p.last_30 != null) out.last_30 = intOrNull(p.last_30);
  if (p.last_7 != null) out.last_7 = intOrNull(p.last_7);
  if (Array.isArray(p.per_country)) {
    out.per_country = p.per_country
      .map((row) => {
        const c = canonicalizeCountry(row && row.country);
        const s = intOrNull(row && row.streams);
        if (!c || s == null) return null;
        return { country: c.country, code: c.code, flag: c.flag, streams: s };
      })
      .filter(Boolean);
  }
  return out;
}

// =====================================================
// Multi-image merge: the operator typically uploads two
// DistroKid screens together -- the totals screen (total_streams,
// last_90, last_30, last_7) and the country screen (per_country).
// They describe the same moment, so combine them into one parsed
// record before sanity check + write.
//
// Rules:
//   - For numeric fields, take the MAX across parses that set it.
//     DistroKid stats only increment, so if both screens happen to
//     show a total, the higher one is the freshest.
//   - For per_country, the longest non-empty list wins. If neither
//     parse carries countries, omit.
//   - Fields no parse sets are omitted (downstream preservedField
//     falls back to the last published value).
// =====================================================
function mergeParses(parses) {
  const list = Array.isArray(parses) ? parses.filter(Boolean) : [];
  if (!list.length) return {};
  if (list.length === 1) return list[0];
  const out = {};
  const numericFields = ["total_streams", "last_90", "last_30", "last_7"];
  for (const field of numericFields) {
    let best = null;
    for (const p of list) {
      if (p && p[field] != null) {
        const v = Number(p[field]);
        if (Number.isFinite(v) && (best == null || v > best)) best = v;
      }
    }
    if (best != null) out[field] = best;
  }
  let bestCountries = null;
  for (const p of list) {
    if (p && Array.isArray(p.per_country) && p.per_country.length) {
      if (!bestCountries || p.per_country.length > bestCountries.length) {
        bestCountries = p.per_country;
      }
    }
  }
  if (bestCountries) out.per_country = bestCountries;
  return out;
}

// =====================================================
// Sanity check.
// =====================================================
function sanityCheck(parsed, lastPublished) {
  // No prior record: anything goes (first upload).
  if (!lastPublished) return { ok: true };
  // No total in this parse but country data present: pass; the
  // total stays at the last value.
  if (parsed.total_streams == null) return { ok: true };
  const last = Number(lastPublished.total_streams || 0);
  const cur = Number(parsed.total_streams);
  if (cur < last) {
    return { ok: false, reason: "lower_total", detail: `parsed ${cur} < last published ${last}` };
  }
  if (cur > last + SANITY_CEILING) {
    return { ok: false, reason: "implausible_jump", detail: `parsed ${cur} - last ${last} = ${cur - last} > ceiling ${SANITY_CEILING}` };
  }
  return { ok: true };
}

// =====================================================
// DynamoDB helpers.
// =====================================================
async function loadLatestPublished() {
  // Single-table, single-PK scan. Volume is tiny (one record per
  // operator upload, kept forever). Filter to published=true and
  // pick newest by parsed_at.
  const result = await dynamo.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: "published = :p",
    ExpressionAttributeValues: { ":p": true }
  }));
  const items = (result && result.Items) || [];
  if (!items.length) return null;
  items.sort((a, b) => String(b.parsed_at || "").localeCompare(String(a.parsed_at || "")));
  return items[0];
}

async function loadHistory(limit) {
  const result = await dynamo.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: "published = :p",
    ExpressionAttributeValues: { ":p": true }
  }));
  const items = (result && result.Items) || [];
  items.sort((a, b) => String(a.parsed_at || "").localeCompare(String(b.parsed_at || "")));
  if (limit && items.length > limit) return items.slice(items.length - limit);
  return items;
}

async function writeRecord(record) {
  await dynamo.send(new PutCommand({ TableName: TABLE_NAME, Item: record }));
}

function newRecordId() {
  return crypto.randomUUID ? crypto.randomUUID() : ("rec-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10));
}

// =====================================================
// GitHub commit of /reach.json on every successful publish.
// =====================================================
function buildGitHubContentsUrl(p) {
  const enc = p.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${enc}`;
}
function ghHeaders() {
  return {
    "accept": "application/vnd.github+json",
    "authorization": `Bearer ${GITHUB_TOKEN}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "SentinelBot-Stats-Parser"
  };
}
async function readReachJsonSha() {
  const url = `${buildGitHubContentsUrl(REACH_JSON_PATH)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const r = await fetch(url, { method: "GET", headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("GH read failed " + r.status);
  const d = await r.json();
  return (d && d.sha) || null;
}
async function commitReachJson(artifact) {
  if (!GITHUB_TOKEN) {
    console.warn("GITHUB_TOKEN not set, skipping reach.json commit");
    return null;
  }
  const content = JSON.stringify(artifact, null, 2) + "\n";
  const sha = await readReachJsonSha();
  const body = {
    message: `auto: stats refresh ${artifact.total_streams || ""}`.trim(),
    content: Buffer.from(content, "utf8").toString("base64"),
    branch: GITHUB_BRANCH
  };
  if (sha) body.sha = sha;
  const r = await fetch(buildGitHubContentsUrl(REACH_JSON_PATH), {
    method: "PUT",
    headers: ghHeaders(),
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("GH PUT failed " + r.status + ": " + t.slice(0, 200));
  }
  const d = await r.json();
  return d && d.commit && d.commit.sha;
}

// =====================================================
// Public artifact shape (what gets committed as reach.json).
// =====================================================
function buildReachArtifact(latest, history) {
  const ts = new Date().toISOString();
  const countryRows = (latest && Array.isArray(latest.per_country)) ? latest.per_country : [];
  const sortedCountries = countryRows
    .slice()
    .sort((a, b) => (Number(b.streams) || 0) - (Number(a.streams) || 0));
  const series = history.map((rec) => ({
    t: rec.parsed_at,
    total: Number(rec.total_streams) || 0
  }));
  return {
    generated_at: ts,
    total_streams: Number((latest && latest.total_streams) || 0),
    last_90: Number((latest && latest.last_90) || 0),
    last_30: Number((latest && latest.last_30) || 0),
    last_7: Number((latest && latest.last_7) || 0),
    nations: sortedCountries.length,
    countries: sortedCountries,
    history: series,
    last_published_at: (latest && latest.parsed_at) || null
  };
}

// =====================================================
// Per-country merge: when a new parse only has totals (no per_country),
// keep the last published per_country list. When it has per_country,
// REPLACE so we always reflect the most recent country snapshot.
// =====================================================
function mergePerCountry(newParse, lastPublished) {
  if (Array.isArray(newParse.per_country) && newParse.per_country.length) {
    return newParse.per_country;
  }
  if (lastPublished && Array.isArray(lastPublished.per_country)) {
    return lastPublished.per_country;
  }
  return [];
}

function preservedTotal(newParse, lastPublished) {
  if (newParse.total_streams != null) return newParse.total_streams;
  return (lastPublished && lastPublished.total_streams) || 0;
}

function preservedField(newParse, lastPublished, field) {
  if (newParse[field] != null) return newParse[field];
  return (lastPublished && lastPublished[field]) || 0;
}

// =====================================================
// Handler.
// =====================================================
exports.handler = async (event = {}) => {
  const method =
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.httpMethod ||
    "POST";

  if (method === "OPTIONS") return { statusCode: 204, headers: cors(), body: "" };

  if (!checkAdminKey(event)) return reply(401, { error: "unauthorized" });

  if (method === "GET") {
    try {
      const latest = await loadLatestPublished();
      const history = await loadHistory(120);
      return reply(200, {
        ok: true,
        latest_published: latest,
        history_count: history.length
      });
    } catch (err) {
      console.error(JSON.stringify({ stage: "admin-get-failed", error: err && err.message }));
      return reply(500, { error: "admin_get_failed" });
    }
  }

  if (method !== "POST") return reply(405, { error: "method_not_allowed" });

  const body = readBody(event);
  if (!body || typeof body !== "object") return reply(400, { error: "invalid_json" });

  // Accept either a single image (legacy: { image_base64, mime_type })
  // or an array of images (new: { images: [{ image_base64, mime_type }, ...] }).
  // The admin page uploads both DistroKid screens (totals + countries)
  // together; we parse each and merge into one record.
  const images = [];
  if (Array.isArray(body.images) && body.images.length) {
    for (const img of body.images) {
      if (img && typeof img.image_base64 === "string" && img.image_base64) {
        images.push({ image_base64: img.image_base64, mime_type: img.mime_type || "image/jpeg" });
      }
    }
  } else {
    const single = body.image_base64 || body.image;
    if (single && typeof single === "string") {
      images.push({ image_base64: single, mime_type: body.mime_type || "image/jpeg" });
    }
  }
  if (!images.length) return reply(400, { error: "missing_image_base64" });
  if (images.length > 4) return reply(400, { error: "too_many_images", detail: "max 4 per upload" });

  let perImageParses;
  try {
    perImageParses = await Promise.all(images.map((img) => parseScreenshot(img.image_base64, img.mime_type)));
  } catch (err) {
    console.error(JSON.stringify({ stage: "vision-parse-failed", error: err && err.message }));
    return reply(502, { error: "vision_parse_failed", detail: err.message });
  }
  const parsed = mergeParses(perImageParses);

  let lastPublished = null;
  try { lastPublished = await loadLatestPublished(); }
  catch (err) {
    console.error(JSON.stringify({ stage: "load-latest-failed", error: err && err.message }));
    return reply(500, { error: "dynamo_read_failed" });
  }

  const sane = sanityCheck(parsed, lastPublished);
  const ts = new Date().toISOString();

  if (!sane.ok) {
    // Write the rejected record with published=false and a review flag.
    const rejected = {
      record_id: newRecordId(),
      parsed_at: ts,
      total_streams: parsed.total_streams || 0,
      last_90: parsed.last_90 || 0,
      last_30: parsed.last_30 || 0,
      last_7: parsed.last_7 || 0,
      per_country: parsed.per_country || [],
      published: false,
      review_flag: sane.reason,
      review_detail: sane.detail,
      last_published_total: (lastPublished && lastPublished.total_streams) || 0
    };
    try { await writeRecord(rejected); }
    catch (err) {
      console.error(JSON.stringify({ stage: "write-rejected-failed", error: err && err.message }));
    }
    return reply(200, {
      ok: true,
      published: false,
      review_flag: sane.reason,
      review_detail: sane.detail,
      parsed,
      per_image: perImageParses,
      image_count: images.length,
      last_published: lastPublished
    });
  }

  // Sane: merge with last, write published record, commit reach.json.
  const merged = {
    record_id: newRecordId(),
    parsed_at: ts,
    total_streams: preservedTotal(parsed, lastPublished),
    last_90: preservedField(parsed, lastPublished, "last_90"),
    last_30: preservedField(parsed, lastPublished, "last_30"),
    last_7: preservedField(parsed, lastPublished, "last_7"),
    per_country: mergePerCountry(parsed, lastPublished),
    published: true
  };
  try { await writeRecord(merged); }
  catch (err) {
    console.error(JSON.stringify({ stage: "write-published-failed", error: err && err.message }));
    return reply(500, { error: "dynamo_write_failed" });
  }

  let commitSha = null;
  try {
    const history = await loadHistory(120);
    const artifact = buildReachArtifact(merged, history);
    commitSha = await commitReachJson(artifact);
  } catch (err) {
    // The record is published in Dynamo; the public artifact commit
    // is best-effort. Surface to admin response so operator sees it.
    console.error(JSON.stringify({ stage: "commit-reach-failed", error: err && err.message }));
  }

  return reply(200, {
    ok: true,
    published: true,
    parsed,
    per_image: perImageParses,
    image_count: images.length,
    record: merged,
    commit_sha: commitSha
  });
};

// Exports for unit testing (no live IO).
module.exports = {
  handler: exports.handler,
  intOrNull,
  normalizeParsed,
  canonicalizeCountry,
  sanityCheck,
  mergeParses,
  mergePerCountry,
  preservedTotal,
  preservedField,
  buildReachArtifact,
  SANITY_CEILING
};
