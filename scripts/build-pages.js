const fs = require("fs/promises");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const pagesSourceDir = path.resolve(repoRoot, process.env.PAGES_SOURCE_DIR || "pages");
const pagesDistDir = path.resolve(repoRoot, process.env.PAGES_DIST_DIR || "pages-dist");
const siteJsonSource = path.resolve(repoRoot, "docs/site.json");

async function copyFile(source, destination) {
  const content = await fs.readFile(source, "utf8");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content, "utf8");
}

function normalizeReleaseTitle(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sortReleaseEvents(a, b) {
  const aTime = Date.parse(a?.publishedAt || a?.createdAt || a?.updatedAt || "") || 0;
  const bTime = Date.parse(b?.publishedAt || b?.createdAt || b?.updatedAt || "") || 0;
  if (bTime !== aTime) return bTime - aTime;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function buildReleaseIndex(events) {
  const index = {};
  const orderedEvents = Array.isArray(events) ? [...events].filter(Boolean).sort(sortReleaseEvents) : [];

  for (const event of orderedEvents) {
    const key = normalizeReleaseTitle(event.title || event.id || "");
    if (!key) continue;

    if (!index[key]) {
      index[key] = {
        id: event.id || "",
        title: event.title || "",
        publishedAt: event.publishedAt || event.createdAt || event.updatedAt || "",
        sourceUrl: event.sourceUrl || event.url || ""
      };
    }
  }

  return index;
}

async function main() {
  const indexSource = path.join(pagesSourceDir, "index.html");
  const indexTarget = path.join(pagesDistDir, "index.html");
  const siteJsonTarget = path.join(pagesDistDir, "site.json");

  await fs.rm(pagesDistDir, { recursive: true, force: true });
  await fs.mkdir(pagesDistDir, { recursive: true });

  await fs.access(siteJsonSource).catch(() => {
    throw new Error(`Required site.json missing: ${siteJsonSource}`);
  });

  await copyFile(indexSource, indexTarget);
  await copyFile(siteJsonSource, siteJsonTarget);

  const rawSiteJson = await fs.readFile(siteJsonSource, "utf8");
  let parsedSiteJson;
  try {
    parsedSiteJson = JSON.parse(rawSiteJson);
  } catch (error) {
    throw new Error(`Invalid JSON in ${siteJsonSource}: ${error.message}`);
  }

  const events = Array.isArray(parsedSiteJson?.events) ? parsedSiteJson.events : [];
  const releaseIndex = buildReleaseIndex(events);
  const outputSiteJson = {
    ...parsedSiteJson,
    releaseIndex
  };
  await fs.writeFile(siteJsonTarget, `${JSON.stringify(outputSiteJson, null, 2)}\n`, "utf8");

  const eventCount = events.length;
  const releaseIndexCount = Object.keys(releaseIndex).length;

  const siteJsonStat = await fs.stat(siteJsonTarget);
  console.log(JSON.stringify({
    ok: true,
    pagesDistDir,
    indexTarget,
    siteJsonTarget,
    siteJsonSource,
    artifactBytes: siteJsonStat.size,
    eventCount,
    releaseIndexCount,
    copied: true
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
