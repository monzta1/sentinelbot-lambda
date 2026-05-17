/* =============================================================
   ARE YOU AN AI BAND. Quiz submission logger + admin read.

   Same AWS account and region as SentinelBot (us-east-1).
   AWS SDK v3 is bundled in the nodejs runtime, so this function
   has zero npm dependencies and zips to a single file.

   Source IP is taken from the request context server side. The
   client never sends it and could not be trusted to. Location is
   resolved with the same ipinfo.io path the SentinelBot logger
   uses, with the same private-range skip and fail-safe to null.

   Routes:

   POST  (no x-admin-key)  new submission
     { path, answers, score, category, shared, user_agent, email? }
     -> writes one row with ip + location, returns { submission_id }

   POST  (no x-admin-key)  mark shared
     { submission_id, shared: true }
     -> flips shared true, returns { ok: true }

   GET   (x-admin-key: <QUIZ_ADMIN_KEY>)  admin list
     -> { count, items: [...] } newest first, for the admin UI
   ============================================================= */
const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  ScanCommand
} = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const TABLE_NAME = process.env.QUIZ_TABLE || "ai_band_quiz_submissions";
const ALLOWED_ORIGIN = process.env.QUIZ_ALLOWED_ORIGIN || "https://shieldbearerusa.com";
const ADMIN_KEY = process.env.QUIZ_ADMIN_KEY || "shieldbearer-admin-2026";
const ADMIN_MAX_ITEMS = 5000;

const VALID_PATHS = ["musician", "listener"];
const MAX_ANSWERS = 20;
const MAX_FIELD = 600;

const IP_LOOKUP_TIMEOUT_MS = 2500;
const ipCache = new Map();

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

function clip(value, max) {
  return String(value == null ? "" : value).slice(0, max);
}

function readBody(event) {
  if (!event || !event.body) return {};
  var raw = event.body;
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function headerValue(event, name) {
  const h = (event && event.headers) || {};
  return h[name] || h[name.toLowerCase()] || h[name.toUpperCase()] || "";
}

function sourceIpOf(event) {
  return (
    (event && event.requestContext && event.requestContext.http && event.requestContext.http.sourceIp) ||
    (headerValue(event, "x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

// Skip private and reserved ranges so we never spend a lookup on
// traffic that has no public location. Mirrors the SentinelBot logger.
function isResolvableIp(ip) {
  if (!ip || typeof ip !== "string") return false;
  const t = ip.trim();
  if (!t || t === "unknown") return false;
  if (/^10\./.test(t)) return false;
  if (/^192\.168\./.test(t)) return false;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(t)) return false;
  if (/^127\./.test(t)) return false;
  if (/^169\.254\./.test(t)) return false;
  if (/^203\.0\.113\./.test(t)) return false;
  if (/^198\.5[12]\./.test(t)) return false;
  if (/^192\.0\.2\./.test(t)) return false;
  return true;
}

const US_STATE_CODES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR",
  california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN",
  iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY", "puerto rico": "PR"
};

function formatLocation(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.error || payload.bogon) return null;
  const city = String(payload.city || "").trim();
  const regionName = String(payload.region || "").trim();
  const countryCode = String(payload.country || "").trim().toUpperCase();
  let region = regionName;
  if (region && countryCode === "US") {
    region = US_STATE_CODES[regionName.toLowerCase()] || regionName;
  }
  const subdivision = region || countryCode;
  if (!city && !subdivision) return null;
  if (city && subdivision) return city + ", " + subdivision;
  return city || subdivision;
}

async function resolveIpLocation(ip) {
  if (!isResolvableIp(ip)) return null;
  if (ipCache.has(ip)) return ipCache.get(ip);
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, IP_LOOKUP_TIMEOUT_MS);
  try {
    const resp = await fetch("https://ipinfo.io/" + encodeURIComponent(ip) + "/json", {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const location = formatLocation(data);
    ipCache.set(ip, location);
    return location;
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function handleAdminList() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await dynamo.send(new ScanCommand({
      TableName: TABLE_NAME,
      ExclusiveStartKey
    }));
    for (const it of out.Items || []) items.push(it);
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey && items.length < ADMIN_MAX_ITEMS);

  items.sort(function (a, b) {
    return String(b.timestamp || "").localeCompare(String(a.timestamp || ""));
  });
  return reply(200, { count: items.length, items: items.slice(0, ADMIN_MAX_ITEMS) });
}

exports.handler = async (event) => {
  const method =
    (event && event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.httpMethod ||
    "POST";

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }

  // Admin read. Constant-time-ish key check, no body.
  if (method === "GET") {
    const provided = String(headerValue(event, "x-admin-key") || "");
    const expected = String(ADMIN_KEY);
    const ok =
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!ok) return reply(401, { error: "unauthorized" });
    try {
      return await handleAdminList();
    } catch (err) {
      console.error(JSON.stringify({ stage: "admin-list-failed", error: err && err.message }));
      return reply(500, { error: "list_failed" });
    }
  }

  if (method !== "POST") {
    return reply(405, { error: "method_not_allowed" });
  }

  const body = readBody(event);
  if (body === null) return reply(400, { error: "invalid_json" });

  // Mark an existing submission as shared.
  if (body.submission_id && body.shared === true && body.path === undefined) {
    const id = clip(body.submission_id, 64);
    try {
      await dynamo.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { submission_id: id },
        UpdateExpression: "SET shared = :t",
        ConditionExpression: "attribute_exists(submission_id)",
        ExpressionAttributeValues: { ":t": true }
      }));
      return reply(200, { ok: true });
    } catch (err) {
      if (err && err.name === "ConditionalCheckFailedException") {
        return reply(404, { error: "not_found" });
      }
      console.error(JSON.stringify({ stage: "mark-shared-failed", error: err && err.message }));
      return reply(500, { error: "write_failed" });
    }
  }

  // New submission.
  if (VALID_PATHS.indexOf(body.path) === -1) return reply(400, { error: "invalid_path" });
  const score = Number(body.score);
  if (!Number.isInteger(score) || score < 0 || score > 10) {
    return reply(400, { error: "invalid_score" });
  }
  if (!Array.isArray(body.answers) || body.answers.length === 0 || body.answers.length > MAX_ANSWERS) {
    return reply(400, { error: "invalid_answers" });
  }

  const answers = body.answers.slice(0, MAX_ANSWERS).map(function (a) {
    return {
      question_id: clip(a && a.question_id, 32),
      answer: clip(a && a.answer, MAX_FIELD)
    };
  });

  const ip = sourceIpOf(event);
  const location = await resolveIpLocation(ip);

  const item = {
    submission_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    path: body.path,
    answers: answers,
    score: score,
    category: clip(body.category, 160),
    shared: body.shared === true,
    user_agent: clip(body.user_agent, MAX_FIELD),
    ip: ip,
    location: location || "unknown"
  };

  const email = clip(body.email, 254).trim();
  if (email && email.indexOf("@") > 0 && email.length <= 254) {
    item.email = email;
  }

  try {
    await dynamo.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  } catch (err) {
    console.error(JSON.stringify({ stage: "submission-write-failed", error: err && err.message }));
    return reply(500, { error: "write_failed" });
  }

  return reply(200, { submission_id: item.submission_id });
};
