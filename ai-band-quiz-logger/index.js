/* =============================================================
   ARE YOU AN AI BAND. Quiz submission logger.

   Same AWS account and region as SentinelBot (us-east-1).
   AWS SDK v3 is bundled in the nodejs runtime, so this function
   has zero npm dependencies and zips to a single file.

   Two request shapes, both POST JSON:

   1. New submission
      { path, answers, score, category, shared, user_agent, email? }
      -> writes one row, returns { submission_id }

   2. Mark shared
      { submission_id, shared: true }
      -> flips shared to true on an existing row, returns { ok: true }

   Results are anonymous. email is stored only when the visitor
   typed one. user_agent is kept for spam triage only.
   ============================================================= */
const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand
} = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const TABLE_NAME = process.env.QUIZ_TABLE || "ai_band_quiz_submissions";

// Only this origin may call the endpoint from a browser.
const ALLOWED_ORIGIN = process.env.QUIZ_ALLOWED_ORIGIN || "https://shieldbearerusa.com";

const VALID_PATHS = ["musician", "listener"];
const MAX_ANSWERS = 20;
const MAX_FIELD = 600;

function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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
  if (event.isBase64Encoded) {
    raw = Buffer.from(raw, "base64").toString("utf8");
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

exports.handler = async (event) => {
  const method =
    (event && event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.httpMethod ||
    "POST";

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }
  if (method !== "POST") {
    return reply(405, { error: "method_not_allowed" });
  }

  const body = readBody(event);
  if (body === null) {
    return reply(400, { error: "invalid_json" });
  }

  // Shape 2: mark an existing submission as shared.
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

  // Shape 1: new submission. Validate before writing.
  if (VALID_PATHS.indexOf(body.path) === -1) {
    return reply(400, { error: "invalid_path" });
  }
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

  const item = {
    submission_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    path: body.path,
    answers: answers,
    score: score,
    category: clip(body.category, 160),
    shared: body.shared === true,
    user_agent: clip(body.user_agent, MAX_FIELD)
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
