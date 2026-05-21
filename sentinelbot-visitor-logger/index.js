/* =============================================================
   SHIELDBEARER. Visitor pageview logger + admin read.

   Mirrors the ai-band-quiz-logger pattern: same account/region,
   same IP capture rules, same ipinfo.io location resolver,
   same admin-key check style.

   What it does:
     POST  (no auth)  one pageview beacon from a browser
       Body: { session_id, path, referrer?, user_agent? }
       Server side, the function captures the source IP from the
       request context (browsers cannot be trusted to send their
       own), resolves location via ipinfo.io with a 2.5s timeout
       and a private-range skip, and writes one DynamoDB row with
       the pk=session_id + sk=ts_open shape.
       Returns 204 with no body. Beacons are fire-and-forget.

     GET   (x-admin-key: <VISITOR_ADMIN_KEY>)  admin list
       Scans the table, returns the most recent N items newest
       first. The /admin/visitors page groups by session_id on
       the client.

   Auth:
     POST is open (anyone can fire a beacon at us). The page path
     and IP are not interesting enough to require auth on write,
     and adding auth would mean shipping a token to every browser.
     We rate-limit-by-IP nothing today; revisit if abuse appears.

     GET requires the same x-admin-key header pattern as the quiz
     logger. Static page hides the key behind the SHA-256
     passphrase gate, same one /admin/quiz uses.

   Cost shape:
     PAY_PER_REQUEST DynamoDB. One write per pageview. At current
     ~114 sessions/month with ~3 pageviews avg = ~350 writes/mo.
     That is $0.0004/mo at the on-demand write rate. The ipinfo
     lookup is free under their 50K/mo tier. CloudWatch logs are
     trivial at this volume. Total cost: a rounding error.
   ============================================================= */
const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand
} = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const TABLE_NAME = process.env.VISITOR_TABLE || "shieldbearer_visits";
const ALLOWED_ORIGIN = process.env.VISITOR_ALLOWED_ORIGIN || "https://shieldbearerusa.com";
const ADMIN_KEY = process.env.VISITOR_ADMIN_KEY || "shieldbearer-visits-2026";
const ADMIN_MAX_ITEMS = 5000;

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
  return {
    statusCode,
    headers: cors(),
    body: body == null ? "" : JSON.stringify(body)
  };
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
    return String(b.ts_open || "").localeCompare(String(a.ts_open || ""));
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

  const sessionId = clip(body.session_id, 80);
  const path = clip(body.path, 300);
  if (!sessionId || !path) {
    return reply(400, { error: "missing_session_or_path" });
  }

  const ip = sourceIpOf(event);
  const location = await resolveIpLocation(ip);
  const ts_open = new Date().toISOString();

  const item = {
    session_id: sessionId,
    ts_open,
    path,
    referrer: clip(body.referrer, MAX_FIELD),
    user_agent: clip(body.user_agent || headerValue(event, "user-agent"), MAX_FIELD),
    ip: ip || "unknown",
    location: location || "unknown"
  };

  try {
    await dynamo.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  } catch (err) {
    console.error(JSON.stringify({ stage: "visit-write-failed", error: err && err.message, sessionId }));
    return reply(500, { error: "write_failed" });
  }

  return { statusCode: 204, headers: cors(), body: "" };
};
