const { DynamoDBClient, DescribeTableCommand } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.SONGS_TABLE_NAME || "shieldbearer-songs";
const REQUIRED_GSI = process.env.SONGS_TABLE_TITLE_INDEX || "normalizedTitle-index";
const SAMPLE_LIMIT = Math.max(1, Number.parseInt(process.env.SONGS_TABLE_SAMPLE_LIMIT || "50", 10) || 50);

function fieldMissing(item, field) {
  const value = item?.[field];
  return value == null || value === "";
}

function buildIssue(item, reasons) {
  return {
    songId: item?.songId || item?.pk || null,
    title: item?.title || null,
    reasons
  };
}

async function describeTable() {
  try {
    const response = await dynamo.send(new DescribeTableCommand({
      TableName: TABLE_NAME
    }));
    return response?.Table || null;
  } catch (error) {
    if (error?.name === "ResourceNotFoundException") {
      return null;
    }
    throw error;
  }
}

async function scanSampleItems() {
  const response = await dynamo.send(new ScanCommand({
    TableName: TABLE_NAME,
    Limit: SAMPLE_LIMIT
  }));

  return Array.isArray(response?.Items) ? response.Items : [];
}

async function main() {
  const table = await describeTable();
  const hasTable = Boolean(table);
  const gsis = Array.isArray(table?.GlobalSecondaryIndexes) ? table.GlobalSecondaryIndexes : [];
  const gsi = gsis.find((index) => index?.IndexName === REQUIRED_GSI) || null;
  const gsiStatus = gsi?.IndexStatus || "MISSING";
  const missingIndex = !gsi;
  const sampledItems = hasTable ? await scanSampleItems() : [];

  const sampleIssues = [];
  let invalidRecordCount = 0;

  for (const item of sampledItems) {
    const reasons = [];
    if (fieldMissing(item, "songId")) reasons.push("missing_songId");
    if (fieldMissing(item, "title")) reasons.push("missing_title");
    if (fieldMissing(item, "normalizedTitle")) reasons.push("missing_normalizedTitle");
    if (fieldMissing(item, "publishedAt")) reasons.push("missing_publishedAt");

    if (reasons.length) {
      invalidRecordCount += 1;
      if (sampleIssues.length < 5) {
        sampleIssues.push(buildIssue(item, reasons));
      }
    }
  }

  const tableStatus = !hasTable
    ? "MISSING"
    : missingIndex
      ? "MISSING_INDEX"
      : invalidRecordCount > 0
        ? "DEGRADED"
        : "OK";

  const result = {
    tableStatus,
    gsiStatus,
    invalidRecordCount,
    totalScanned: sampledItems.length,
    sampleIssues
  };

  console.log(JSON.stringify(result, null, 2));

  if (!hasTable || missingIndex || invalidRecordCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    tableStatus: "MISSING",
    gsiStatus: "MISSING",
    invalidRecordCount: 0,
    totalScanned: 0,
    sampleIssues: [],
    error: error.message
  }, null, 2));
  process.exit(1);
});
