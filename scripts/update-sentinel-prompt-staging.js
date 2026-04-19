#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  estimateTokenCount,
  normalizePromptText
} = require("../sentinelbot-scraper-staging/prompt-assembly");

const ROOT = path.join(__dirname, "..");
const TABLE_NAME = process.env.DYNAMO_TABLE || "shieldbearer-sentinel-logs";
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const VERSION_BASE = process.env.SENTINELBOT_STAGING_VERSION || process.env.SENTINELBOT_VERSION || "1.0";
const VERSION = VERSION_BASE.endsWith("-staging") ? VERSION_BASE : `${VERSION_BASE}-staging`;
const PROMPT_FILE = path.join(ROOT, "sentinelbot-prompt.txt");
const INDEX_FILE = path.join(ROOT, "index.js");
const BASE_KEY = "config:system-prompt-base-staging";
const ACTIVE_KEY = "config:system-prompt-active-staging";

function timestamp() {
  return new Date().toISOString();
}

function loadPromptText() {
  const fileText = fs.readFileSync(PROMPT_FILE, "utf8").trim();
  if (fileText.startsWith("@source index.js")) {
    const indexText = fs.readFileSync(INDEX_FILE, "utf8");
    const match = indexText.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;\n/);
    if (!match) {
      throw new Error("Could not extract SYSTEM_PROMPT from index.js");
    }
    return match[1];
  }
  return fileText;
}

function putItem(item) {
  execFileSync(
    "aws",
    [
      "dynamodb",
      "put-item",
      "--region",
      REGION,
      "--table-name",
      TABLE_NAME,
      "--item",
      JSON.stringify(item)
    ],
    { stdio: "inherit" }
  );
}

function buildBaseItem(promptText, updatedAt) {
  return {
    id: { S: BASE_KEY },
    value: { S: promptText },
    version: { S: VERSION },
    tokenEstimate: { N: String(estimateTokenCount(promptText)) },
    byteSize: { N: String(Buffer.byteLength(promptText, "utf8")) },
    updatedAt: { S: updatedAt }
  };
}

function buildActiveItem(updatedAt) {
  return {
    id: { S: ACTIVE_KEY },
    promptKey: { S: BASE_KEY },
    version: { S: VERSION },
    updatedAt: { S: updatedAt }
  };
}

function main() {
  const updatedAt = timestamp();
  const promptText = normalizePromptText(loadPromptText());
  const byteSize = Buffer.byteLength(promptText, "utf8");
  const tokenEstimate = estimateTokenCount(promptText);

  console.log(JSON.stringify({
    stage: "prompt-staging-update",
    timestamp: updatedAt,
    version: VERSION,
    byteSize,
    tokenEstimate,
    promptFile: path.relative(ROOT, PROMPT_FILE),
    baseKey: BASE_KEY,
    activeKey: ACTIVE_KEY
  }));

  putItem(buildBaseItem(promptText, updatedAt));
  putItem(buildActiveItem(updatedAt));

  console.log(JSON.stringify({
    ok: true,
    timestamp: updatedAt,
    version: VERSION,
    baseKey: BASE_KEY,
    activeKey: ACTIVE_KEY,
    byteSize,
    tokenEstimate
  }));
}

main();
