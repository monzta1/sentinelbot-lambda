const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const EVENT_STREAM_TABLE_NAME = process.env.EVENT_STREAM_TABLE_NAME || process.env.DYNAMO_TABLE || "shieldbearer-sentinel-logs";

function parseTimestamp(value) {
  const parsed = Date.parse(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeEventRecord(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const payload = item.payload && typeof item.payload === "object" ? item.payload : null;
  const eventType = String(item.eventType || payload?.eventType || "").trim().toUpperCase();
  const songId = String(item.songId || payload?.songId || payload?.id || "").trim();
  const timestamp = String(item.timestamp || payload?.timestamp || payload?.publishedAt || item.createdAt || item.updatedAt || "").trim();
  if (!eventType || !songId || !timestamp) {
    return null;
  }

  return {
    eventType,
    songId,
    title: String(item.title || payload?.title || "").trim(),
    timestamp,
    data: {
      id: String(item.id || payload?.id || "").trim(),
      source: String(item.source || payload?.source || "").trim(),
      sourceUrl: String(item.sourceUrl || payload?.sourceUrl || payload?.youtubeUrl || "").trim(),
      youtubeUrl: String(item.youtubeUrl || payload?.youtubeUrl || payload?.sourceUrl || "").trim(),
      contentHash: String(item.contentHash || payload?.contentHash || "").trim(),
      stateAfter: String(item.stateAfter || payload?.stateAfter || "").trim(),
      traceId: String(item.traceId || payload?.traceId || "").trim(),
      payload
    }
  };
}

function eventDedupKey(event) {
  return String(event?.data?.id || "") || [
    String(event?.songId || "").trim(),
    String(event?.timestamp || "").trim(),
    String(event?.eventType || "").trim()
  ].join("|");
}

function dedupeAndSortEvents(events) {
  const seen = new Set();
  return (Array.isArray(events) ? events : [])
    .filter(Boolean)
    .filter((event) => {
      const key = eventDedupKey(event);
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const delta = parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp);
      if (delta !== 0) {
        return delta;
      }
      return String(a.songId || "").localeCompare(String(b.songId || "")) || String(a.eventType || "").localeCompare(String(b.eventType || ""));
    });
}

async function queryEventStream(since = "") {
  const cleanSince = String(since || "").trim();
  const sinceTime = cleanSince ? parseTimestamp(cleanSince) : 0;
  const hasSince = sinceTime > 0;
  const records = [];
  let exclusiveStartKey = null;

  do {
    const params = {
      TableName: EVENT_STREAM_TABLE_NAME,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: {
        "#pk": "pk",
        "#sk": "sk"
      },
      ExpressionAttributeValues: {
        ":pk": "eventstream"
      },
      ScanIndexForward: true,
      ExclusiveStartKey: exclusiveStartKey || undefined,
      ProjectionExpression: "id, songId, eventType, title, timestamp, source, sourceUrl, youtubeUrl, contentHash, stateAfter, traceId, payload, createdAt, updatedAt, pk, sk"
    };

    if (hasSince) {
      params.KeyConditionExpression = "#pk = :pk AND #sk > :sinceSk";
      params.ExpressionAttributeValues[":sinceSk"] = `${cleanSince}#\uffff`;
    }

    const response = await dynamo.send(new QueryCommand(params));

    for (const item of response?.Items || []) {
      const event = normalizeEventRecord(item);
      if (!event) {
        continue;
      }

      if (hasSince && !(parseTimestamp(event.timestamp) > sinceTime)) {
        continue;
      }

      records.push(event);
    }

    exclusiveStartKey = response?.LastEvaluatedKey || null;
  } while (exclusiveStartKey);

  return dedupeAndSortEvents(records);
}

async function handler(event = {}) {
  console.log("API EVENTS HIT");
  const since = String(event?.queryStringParameters?.since || "").trim();
  try {
    const events = await queryEventStream(since);
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "https://shieldbearerusa.com",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify({ events })
    };
  } catch (error) {
    console.warn("EventStream API unavailable", error.message);
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "https://shieldbearerusa.com",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify({ events: [] })
    };
  }
}

module.exports = {
  handler,
  queryEventStream,
  normalizeEventRecord,
  dedupeAndSortEvents
};
