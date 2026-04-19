const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.DYNAMO_TABLE || "shieldbearer-sentinel-logs";
const EVENT_STREAM_PK = "eventstream";
const SITE_STATE_PK = "sitestate#homepage";
const SITE_STATE_SK = "current";
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() !== "false";
const PAGE_SIZE = Math.max(1, Number.parseInt(process.env.EVENT_CONSUMER_PAGE_SIZE || "25", 10) || 25);

function nowIso() {
  return new Date().toISOString();
}

function logStage(stage, details) {
  console.log(JSON.stringify({
    stage,
    timestamp: nowIso(),
    dryRun: DRY_RUN,
    ...details
  }));
}

function parseReleaseEventPayload(item) {
  const payload = item?.payload || item?.releaseEvent || null;
  if (!payload || typeof payload !== "object") {
    throw new Error(`Missing release payload for event ${item?.sk || item?.id || "unknown"}`);
  }

  const id = payload.id || item?.id || null;
  const source = payload.source || item?.source || null;
  const eventType = payload.eventType || item?.eventType || null;
  const title = payload.title || null;
  const publishedAt = payload.publishedAt || null;
  const sourceUrl = payload.sourceUrl || null;

  if (!id || !source || !eventType) {
    throw new Error(`Incomplete release payload for event ${item?.sk || item?.id || "unknown"}`);
  }

  return {
    id,
    source,
    eventType,
    title,
    publishedAt,
    sourceUrl,
    payload
  };
}

function buildSiteUpdateActions(event) {
  return [
    {
      action: "homepage banner update",
      reason: `New ${event.source} release detected`,
      target: event.title || event.id
    },
    {
      action: "release metadata update",
      reason: `Sync release details for ${event.id}`,
      target: {
        id: event.id,
        source: event.source,
        publishedAt: event.publishedAt,
        sourceUrl: event.sourceUrl
      }
    }
  ];
}

function buildNextSiteState(event, currentState) {
  const previous = currentState || {};
  const nextBannerTitle = event.title || previous.bannerTitle || "New release";
  const nextSourceUrl = event.sourceUrl || previous.sourceUrl || "";
  const nextUpdatedAt = nowIso();

  return {
    pk: SITE_STATE_PK,
    sk: SITE_STATE_SK,
    activeReleaseId: event.id,
    bannerTitle: nextBannerTitle,
    bannerImage: previous.bannerImage ?? null,
    sourceUrl: nextSourceUrl,
    lastUpdatedAt: nextUpdatedAt
  };
}

function buildSitePayload(nextSiteState) {
  const state = nextSiteState || {};
  return {
    homepage: {
      banner: {
        title: state.bannerTitle || "",
        image: null,
        sourceUrl: state.sourceUrl || "",
        activeReleaseId: state.activeReleaseId || ""
      },
      lastUpdatedAt: state.lastUpdatedAt || ""
    },
    release: {
      id: state.activeReleaseId || "",
      source: "youtube",
      publishedAt: state.publishedAt || ""
    }
  };
}

function buildSiteArtifact(sitePayload) {
  const payload = sitePayload || {};
  const homepage = payload.homepage || {};
  const banner = homepage.banner || {};
  const release = payload.release || {};

  return {
    generatedAt: homepage.lastUpdatedAt || nowIso(),
    source: "sentinelbot-event-consumer",
    homepage: {
      banner: {
        title: banner.title || "",
        image: banner.image ?? null,
        sourceUrl: banner.sourceUrl || "",
        activeReleaseId: banner.activeReleaseId || ""
      },
      release: {
        id: release.id || "",
        source: release.source || "",
        publishedAt: release.publishedAt || ""
      }
    }
  };
}

async function loadCurrentSiteState() {
  const response = await dynamo.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "#pk = :pk AND #sk = :sk",
    ExpressionAttributeNames: {
      "#pk": "pk",
      "#sk": "sk"
    },
    ExpressionAttributeValues: {
      ":pk": SITE_STATE_PK,
      ":sk": SITE_STATE_SK
    },
    Limit: 1,
    ScanIndexForward: false
  }));

  return response?.Items?.[0] || null;
}

async function queryPendingEvents(exclusiveStartKey) {
  const response = await dynamo.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "#pk = :pk",
    FilterExpression: "processed = :processed",
    ExpressionAttributeNames: {
      "#pk": "pk"
    },
    ExpressionAttributeValues: {
      ":pk": EVENT_STREAM_PK,
      ":processed": false
    },
    ExclusiveStartKey: exclusiveStartKey,
    Limit: PAGE_SIZE,
    ScanIndexForward: true
  }));

  return {
    items: response?.Items || [],
    lastEvaluatedKey: response?.LastEvaluatedKey || null
  };
}

async function markEventProcessed(item) {
  const timestamp = nowIso();
  try {
    await dynamo.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        id: item.id
      },
      UpdateExpression: "SET processed = :true, processedAt = :processedAt, updatedAt = :updatedAt",
      ConditionExpression: "processed = :false",
      ExpressionAttributeValues: {
        ":true": true,
        ":false": false,
        ":processedAt": timestamp,
        ":updatedAt": timestamp
      }
    }));
    return { processed: true };
  } catch (error) {
    if (error?.name === "ConditionalCheckFailedException") {
      return { processed: false, duplicate: true };
    }
    throw error;
  }
}

exports.handler = async () => {
  const startedAt = Date.now();
  let exclusiveStartKey = null;
  let scannedCount = 0;
  let processedCount = 0;
  let duplicateCount = 0;
  let skippedCount = 0;
  let batchCount = 0;
  let currentSiteState = await loadCurrentSiteState();

  try {
    do {
      const page = await queryPendingEvents(exclusiveStartKey);
      batchCount += 1;

      for (const item of page.items) {
        scannedCount += 1;

        let releaseEvent;
        try {
          releaseEvent = parseReleaseEventPayload(item);
        } catch (error) {
          skippedCount += 1;
          logStage("event-parse-failed", {
            eventId: item?.id || null,
            sk: item?.sk || null,
            error: error.message
          });
          continue;
        }

        const actions = buildSiteUpdateActions(releaseEvent);
        const nextSiteState = buildNextSiteState(releaseEvent, currentSiteState);
        const sitePayload = buildSitePayload({
          ...nextSiteState,
          source: releaseEvent.source,
          publishedAt: releaseEvent.publishedAt
        });
        const siteArtifact = buildSiteArtifact(sitePayload);
        logStage("site-update-planned", {
          eventId: releaseEvent.id,
          source: releaseEvent.source,
          eventType: releaseEvent.eventType,
          title: releaseEvent.title,
          publishedAt: releaseEvent.publishedAt,
          sourceUrl: releaseEvent.sourceUrl,
          actions,
          currentSiteState,
          nextSiteState,
          sitePayload,
          siteArtifact,
          siteStateKey: {
            pk: SITE_STATE_PK,
            sk: SITE_STATE_SK
          }
        });
        currentSiteState = nextSiteState;

        const result = await markEventProcessed(item);
        if (result.processed) {
          processedCount += 1;
        } else if (result.duplicate) {
          duplicateCount += 1;
        }
      }

      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey);

    logStage("event-consumer-complete", {
      scannedCount,
      processedCount,
      duplicateCount,
      skippedCount,
      batchCount,
      elapsedMs: Date.now() - startedAt
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        dryRun: DRY_RUN,
        scannedCount,
        processedCount,
        duplicateCount,
        skippedCount,
        batchCount
      })
    };
  } catch (error) {
    logStage("event-consumer-failed", {
      error: error.message,
      scannedCount,
      processedCount,
      duplicateCount,
      skippedCount,
      batchCount,
      elapsedMs: Date.now() - startedAt
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: error.message
      })
    };
  }
};

module.exports = {
  handler: exports.handler,
  parseReleaseEventPayload,
  buildSiteUpdateActions,
  buildNextSiteState,
  buildSitePayload,
  buildSiteArtifact,
  loadCurrentSiteState,
  queryPendingEvents,
  markEventProcessed
};
