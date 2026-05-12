#!/usr/bin/env node
/**
 * scripts/backfill-ip-locations.js
 *
 * One-off backfill: read every sentinelbot chat log row that does
 * not yet have a `location` field, resolve each unique sourceIp
 * via ipapi.co, and update every row that shares that IP with the
 * resolved `City, Country` string. Rows whose sourceIp is missing,
 * "unknown", private, or in a documentation range get
 * `location: null` so the same row is not retried on the next run.
 *
 * Run:
 *   node scripts/backfill-ip-locations.js            # writes to DynamoDB
 *   node scripts/backfill-ip-locations.js --dry-run  # prints what it would do
 *
 * Why this script exists: the chat Lambda was updated to resolve
 * location at write time, but ~330 historical rows have no
 * location field. This fills them once and exits. Safe to re-run
 * (idempotent) because it skips rows that already have location.
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const TABLE_NAME = process.env.DYNAMO_TABLE || "shieldbearer-sentinel-logs";
const IPAPI_BASE = "https://ipinfo.io";
const RATE_LIMIT_MS = 100; // ipinfo.io anonymous tier is generous
const DRY_RUN = process.argv.includes("--dry-run");
const RETRY_NULL = process.argv.includes("--retry-null");
const FORCE = process.argv.includes("--force");

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

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

function isResolvableIp(ip) {
  if (!ip || typeof ip !== "string") return false;
  const t = ip.trim();
  if (!t || t === "unknown") return false;
  if (/^10\./.test(t)) return false;
  if (/^192\.168\./.test(t)) return false;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(t)) return false;
  if (/^127\./.test(t)) return false;
  if (/^169\.254\./.test(t)) return false;
  if (/^203\.0\.113\./.test(t)) return false; // TEST-NET-3
  if (/^198\.5[12]\./.test(t)) return false;
  if (/^192\.0\.2\./.test(t)) return false;
  return true;
}

function formatLocation(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.error) return null;
  if (payload.success === false) return null;
  if (payload.bogon) return null;
  const city = String(payload.cityName || payload.city || "").trim();
  const regionCode = String(payload.regionCode || payload.region_code || "").trim();
  const regionName = String(payload.region || payload.regionName || payload.region_name || "").trim();
  const countryCode = String(payload.countryCode || payload.country_code || payload.country || "").trim().toUpperCase();
  let region = regionCode;
  if (!region && regionName) {
    if (countryCode === "US") {
      region = US_STATE_CODES[regionName.toLowerCase()] || regionName;
    } else {
      region = regionName;
    }
  }
  const subdivision = region || countryCode;
  if (!city && !subdivision) return null;
  if (city && subdivision) return `${city}, ${subdivision}`;
  return city || subdivision;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveIp(ip) {
  try {
    const resp = await fetch(`${IPAPI_BASE}/${encodeURIComponent(ip)}/json`, {
      headers: { "Accept": "application/json" }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return formatLocation(data);
  } catch (err) {
    console.error(`  fetch failed for ${ip}: ${err.message}`);
    return null;
  }
}

async function scanAllLogs() {
  const items = [];
  let cursor = null;
  // Default: only rows that have never been processed (no location
  // attribute at all). Three operator-controlled escape hatches:
  //   --retry-null  also re-process rows whose stored location is
  //                 null (a prior attempt failed transiently).
  //   --force       re-process every sentinelbot row regardless of
  //                 current location value. Used when the format
  //                 itself changes (e.g. City, Country -> City, RegionCode)
  //                 and existing data needs to be re-resolved.
  let filterExpr;
  const values = { ":lt": "sentinelbot" };
  if (FORCE) {
    filterExpr = "logType = :lt";
  } else if (RETRY_NULL) {
    filterExpr = "logType = :lt AND (attribute_not_exists(#loc) OR #loc = :nullVal)";
    values[":nullVal"] = null;
  } else {
    filterExpr = "logType = :lt AND attribute_not_exists(#loc)";
  }
  do {
    const input = {
      TableName: TABLE_NAME,
      FilterExpression: filterExpr,
      ExpressionAttributeValues: values
    };
    // Only declare the #loc alias when the filter actually references
    // it. DynamoDB rejects ExpressionAttributeNames entries that are
    // unused in any expression.
    if (!FORCE) {
      input.ExpressionAttributeNames = { "#loc": "location" };
    }
    if (cursor) input.ExclusiveStartKey = cursor;
    const page = await dynamo.send(new ScanCommand(input));
    items.push(...(page.Items || []));
    cursor = page.LastEvaluatedKey || null;
  } while (cursor);
  return items;
}

async function updateRowLocation(id, location) {
  if (DRY_RUN) return;
  await dynamo.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { id },
    UpdateExpression: "SET #loc = :loc",
    ExpressionAttributeNames: { "#loc": "location" },
    // null tells DynamoDB to store an actual null attribute. The chat
    // Lambda writes null for the same condition; staying consistent.
    ExpressionAttributeValues: { ":loc": location === null ? null : location }
  }));
}

async function main() {
  console.log(`Backfill IP locations on ${TABLE_NAME}${DRY_RUN ? " (DRY RUN)" : ""}`);
  console.log("");

  const rows = await scanAllLogs();
  console.log(`Found ${rows.length} sentinelbot rows without a location field.`);

  // Group rows by sourceIp so each unique IP is resolved exactly once.
  const byIp = new Map();
  for (const row of rows) {
    const ip = row.sourceIp || "";
    if (!byIp.has(ip)) byIp.set(ip, []);
    byIp.get(ip).push(row.id);
  }

  console.log(`Unique sourceIp values: ${byIp.size}`);
  console.log("");

  const resolvableIps = Array.from(byIp.keys()).filter(isResolvableIp);
  const unresolvableIps = Array.from(byIp.keys()).filter((ip) => !isResolvableIp(ip));

  console.log(`Resolvable: ${resolvableIps.length}  Unresolvable: ${unresolvableIps.length}`);
  console.log("");

  // First pass: rows whose IP cannot be resolved get location: null
  // explicitly, so the next backfill run skips them.
  let nullUpdates = 0;
  for (const ip of unresolvableIps) {
    const ids = byIp.get(ip);
    console.log(`  [unresolvable: ${ip || "<missing>"}] marking ${ids.length} rows location=null`);
    for (const id of ids) {
      await updateRowLocation(id, null);
      nullUpdates += 1;
    }
  }
  console.log(`  ${nullUpdates} rows marked unresolvable.`);
  console.log("");

  // Second pass: resolve each public IP once via ipapi.co, then
  // fan out the result to every row sharing that IP.
  let resolved = 0;
  let failed = 0;
  let rowUpdates = 0;
  for (const ip of resolvableIps) {
    const ids = byIp.get(ip);
    process.stdout.write(`  [resolve: ${ip}] (${ids.length} rows) ... `);
    const location = await resolveIp(ip);
    if (location) {
      console.log(`-> ${location}`);
      resolved += 1;
    } else {
      console.log("-> null (lookup failed or empty)");
      failed += 1;
    }
    for (const id of ids) {
      await updateRowLocation(id, location);
      rowUpdates += 1;
    }
    await sleep(RATE_LIMIT_MS);
  }

  console.log("");
  console.log("=========================================");
  console.log(`Rows scanned:      ${rows.length}`);
  console.log(`Unique IPs:        ${byIp.size}`);
  console.log(`Resolved IPs:      ${resolved}`);
  console.log(`Failed IPs:        ${failed}`);
  console.log(`Row updates:       ${nullUpdates + rowUpdates}${DRY_RUN ? " (dry run, no DB writes)" : ""}`);
  console.log("=========================================");
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
