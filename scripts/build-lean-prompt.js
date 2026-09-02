#!/usr/bin/env node
// Build the lean system prompt and the per-video knowledge rows from the
// assembled monolith at config:system-prompt-expanded.
//
// The monolith re-sent 145KB of per-video deep material with every question.
// This splits it: the BASE PROMPT section plus a one-line-per-video index
// become config:system-prompt-lean (always sent), and each video's deep
// material becomes its own knowledge:video:<id> row (retrieved only for
// questions that match it; see lookupVideoKnowledge in index.js).
//
// Idempotent: reads the expanded item fresh each run and overwrites the lean
// item, the index row, and the video rows. The expanded item is never
// modified, so rollback is deleting the SYSTEM_PROMPT_KEY env var.
//
// Run: node scripts/build-lean-prompt.js [--dry-run]

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const TABLE = process.env.DYNAMO_TABLE || "shieldbearer-sentinel-logs";
const DRY = process.argv.includes("--dry-run");

// One record per "- TITLE | 2025-05-04T03:07:07Z" header inside the
// YOUTUBE KNOWLEDGE section. Titles themselves may contain pipes, so the
// only reliable anchor is the trailing ISO timestamp.
const VIDEO_HEADER = /^- (.+) \| (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s*$/gm;

function splitMonolith(text) {
  const base = text.split("=== YOUTUBE KNOWLEDGE ===")[0].trim();
  const youtube = text.includes("=== YOUTUBE KNOWLEDGE ===")
    ? text.split("=== YOUTUBE KNOWLEDGE ===").slice(1).join("")
        .split("=== FACEBOOK KNOWLEDGE ===")[0]
    : "";
  const videos = [];
  const headers = [...youtube.matchAll(VIDEO_HEADER)];
  headers.forEach((m, i) => {
    const start = m.index;
    const end = i + 1 < headers.length ? headers[i + 1].index : youtube.length;
    const title = m[1].trim();
    const publishedAt = m[2].trim();
    const idMatch = youtube.slice(start, end).match(/^Video ID: (\S+)$/m);
    const id = idMatch ? idMatch[1] : `row-${i}`;
    videos.push({ id, title, publishedAt, body: youtube.slice(start, end).trim() });
  });
  return { base, videos };
}

function buildLean(base, videos) {
  const indexLines = videos.map((v) =>
    `- ${v.title} | published ${v.publishedAt.slice(0, 10)} | https://www.youtube.com/watch?v=${v.id}`);
  return base
    + "\n\n=== VIDEO INDEX ===\n"
    + "Every released video, one line each. Deep material about a song or "
    + "video (its story, description, scripture grounding) is retrieved per "
    + "question and appears as a 'Song and Video Knowledge' block when "
    + "relevant; when that block is absent and a question needs that depth, "
    + "point to the song's page rather than inventing detail.\n\n"
    + indexLines.join("\n") + "\n";
}

async function main() {
  const res = await dynamo.send(new GetCommand({
    TableName: TABLE, Key: { id: "config:system-prompt-expanded" }
  }));
  const monolith = res?.Item?.value;
  if (!monolith) throw new Error("config:system-prompt-expanded has no value");
  const { base, videos } = splitMonolith(String(monolith));
  if (!base || videos.length === 0) {
    throw new Error(`refusing to write: base ${base.length} chars, ${videos.length} videos parsed`);
  }
  const lean = buildLean(base, videos);
  const now = new Date().toISOString();
  console.log(`base ${base.length} chars, ${videos.length} videos, lean ${lean.length} chars`);
  if (DRY) {
    videos.forEach((v) => console.log(`  ${v.id}  ${v.title} (${v.body.length} chars)`));
    return;
  }
  await dynamo.send(new PutCommand({
    TableName: TABLE,
    Item: { id: "config:system-prompt-lean", value: lean, updatedAt: now,
            sourceKey: "config:system-prompt-expanded" }
  }));
  await dynamo.send(new PutCommand({
    TableName: TABLE,
    Item: { id: "knowledge:video-index", updatedAt: now,
            value: videos.map((v) => ({ id: v.id, title: v.title })) }
  }));
  for (const v of videos) {
    await dynamo.send(new PutCommand({
      TableName: TABLE,
      Item: { id: `knowledge:video:${v.id}`, value: v.body, updatedAt: now }
    }));
  }
  console.log("written: config:system-prompt-lean, knowledge:video-index, "
    + `${videos.length} knowledge:video rows`);
}

module.exports = { splitMonolith, buildLean };

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
