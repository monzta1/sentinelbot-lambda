const fs = require("fs");
const path = require("path");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const EVENT_STREAM_TABLE_NAME = process.env.EVENT_STREAM_TABLE_NAME || process.env.DYNAMO_TABLE || "EventStream";
const TEST_EVENT_STATE_FILE = process.env.SHIELD_CLI_EVENT_STATE_FILE || "";

function nowIso() {
  return new Date().toISOString();
}

function normalizeValue(value) {
  if (value == null) return "";
  return String(value).trim();
}

function loadTestEvents() {
  if (!TEST_EVENT_STATE_FILE) return [];
  try {
    const raw = fs.readFileSync(TEST_EVENT_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function saveTestEvents(events) {
  if (!TEST_EVENT_STATE_FILE) return;
  const directory = path.dirname(TEST_EVENT_STATE_FILE);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${TEST_EVENT_STATE_FILE}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(events, null, 2)}\n`);
  fs.renameSync(tempPath, TEST_EVENT_STATE_FILE);
}

function buildSongEventItem(event) {
  const timestamp = normalizeValue(event?.timestamp) || nowIso();
  const songId = normalizeValue(event?.songId);
  const source = normalizeValue(event?.source) || "shield-ingest-cli";
  const eventType = normalizeValue(event?.eventType);
  const title = normalizeValue(event?.title);
  const contentHash = normalizeValue(event?.contentHash);
  const lyrics = normalizeValue(event?.lyrics);
  const artworkUrl = normalizeValue(event?.artworkUrl);
  const songMeaning = normalizeValue(event?.songMeaning);
  const payload = {
    eventType,
    songId,
    title,
    timestamp,
    contentHash,
    source,
    lyrics,
    artworkUrl,
    songMeaning
  };
  const streamKey = timestamp;

  return {
    id: `${songId}#${streamKey}#${eventType}`,
    pk: songId,
    sk: streamKey,
    songId,
    eventType,
    title,
    timestamp,
    source,
    contentHash,
    lyrics,
    artworkUrl,
    songMeaning,
    payload,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function emitSongEvent(event) {
  if (!event || normalizeValue(event.eventType) === "SONG_UNCHANGED") {
    return { emitted: false, skipped: true };
  }

  const item = buildSongEventItem(event);

  if (TEST_EVENT_STATE_FILE) {
    const events = loadTestEvents();
    events.push(item);
    saveTestEvents(events);
    return { emitted: true, item };
  }

  /* c8 ignore start: DynamoDB write path requires AWS, exercised end-to-end via shield-cli tests with TEST_EVENT_STATE_FILE shim */
  try {
    await dynamo.send(new PutCommand({
      TableName: EVENT_STREAM_TABLE_NAME,
      Item: item,
      ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)"
    }));
    return { emitted: true, item };
  } catch (error) {
    if (error?.name === "ConditionalCheckFailedException") {
      return { emitted: false, duplicate: true, item };
    }
    console.error(error);
    throw error;
  }
  /* c8 ignore stop */
}

module.exports = {
  emitSongEvent
};
