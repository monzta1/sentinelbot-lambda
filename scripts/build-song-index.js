const fs = require("fs/promises");
const path = require("path");
const vm = require("vm");

const repoRoot = path.resolve(__dirname, "..");
const websiteRoot = path.resolve(repoRoot, "..", "shieldbearer-website");
const songMeaningsPath = path.join(websiteRoot, "song-meanings.html");
const musicPath = path.join(websiteRoot, "music.html");
const siteJsonPath = path.join(repoRoot, "docs", "site.json");
const outputPath = path.join(repoRoot, "docs", "song-index.json");

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&middot;/g, "·")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&rsquo;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&hellip;/g, "…")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function loadReleaseIndex() {
  try {
    const siteJson = await readJsonFile(siteJsonPath);
    return siteJson?.releaseIndex && typeof siteJson.releaseIndex === "object" ? siteJson.releaseIndex : {};
  } catch {
    return {};
  }
}

async function loadSongDossiers() {
  const source = await fs.readFile(songMeaningsPath, "utf8");
  const marker = "var SONG_DOSSIERS = [";
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Could not find SONG_DOSSIERS in ${songMeaningsPath}`);
  }

  const endMarker = "var desktopActive = SONG_DOSSIERS[0].id;";
  const end = source.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error(`Could not find end of SONG_DOSSIERS in ${songMeaningsPath}`);
  }

  const code = `${source.slice(start, end)}\nSONG_DOSSIERS;`;
  const dossiers = vm.runInNewContext(code, Object.create(null), { timeout: 1000 });
  if (!Array.isArray(dossiers)) {
    throw new Error("SONG_DOSSIERS did not evaluate to an array");
  }
  return dossiers;
}

async function loadMusicTrackRefs() {
  try {
    const source = await fs.readFile(musicPath, "utf8");
    const refs = {};
    const trackCardPattern = /<h3 class="track-name">([\s\S]*?)<\/h3>[\s\S]*?<span class="track-ref">([\s\S]*?)<\/span>/g;
    let match;
    while ((match = trackCardPattern.exec(source))) {
      const title = normalizeTitle(decodeHtml(match[1]));
      const trackRef = decodeHtml(match[2]).replace(/\s+/g, " ").trim();
      if (title && trackRef) {
        refs[title] = trackRef;
      }
    }
    return refs;
  } catch {
    return {};
  }
}

function buildSongRecord(song, trackRefs, releaseIndex) {
  const title = String(song?.title || "").trim();
  const normalizedTitle = normalizeTitle(title);
  if (!normalizedTitle) return null;

  const releaseRecord = releaseIndex[normalizedTitle] || null;
  const meaningUrl = `https://shieldbearerusa.com/song-meanings.html#${song.id || normalizedTitle.replace(/\s+/g, "-")}`;
  const meaningSummary = Array.isArray(song.meaning) ? song.meaning.join(" ") : String(song.meaning || "").trim();
  const scriptureRef = String(song?.scripture?.ref || "").trim();
  const scriptureQuote = String(song?.scripture?.quote || "").trim();
  const tags = Array.isArray(song.tags) ? song.tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
  const theme = tags.length ? tags.join(", ") : String(song.genre || song.reference || "song meaning").trim();
  const songContext = {
    theme,
    meaning: String(song.thesis || meaningSummary || song.reference || title).trim(),
    scriptureReferences: scriptureRef ? [scriptureRef] : [],
    summary: String([meaningSummary || song.thesis || "", scriptureRef ? `Scripture: ${scriptureRef}` : ""].filter(Boolean).join(" ")).trim()
  };
  const trackRef = trackRefs[normalizedTitle] || String(song.reference || "").trim();

  return {
    songId: String(song.id || normalizedTitle.replace(/\s+/g, "-")).trim(),
    id: String(song.id || normalizedTitle.replace(/\s+/g, "-")).trim(),
    slug: String(song.id || normalizedTitle.replace(/\s+/g, "-")).trim(),
    title,
    normalizedTitle,
    number: String(song.number || "").trim(),
    genre: String(song.genre || "").trim(),
    reference: String(song.reference || "").trim(),
    releaseLabel: trackRef,
    releaseYear: trackRef.match(/\b(20\d{2})\b/) ? trackRef.match(/\b(20\d{2})\b/)[1] : "",
    publishedAt: String(releaseRecord?.publishedAt || "").trim(),
    sourceUrl: String(releaseRecord?.sourceUrl || song?.actions?.youtube || song?.actions?.spotify || meaningUrl).trim(),
    meaningUrl,
    thesis: String(song.thesis || "").trim(),
    meaningSummary,
    scriptureRef,
    scriptureQuote,
    tags,
    songContext,
    artwork: String(song.artwork || "").trim(),
    actions: {
      spotify: String(song?.actions?.spotify || "").trim(),
      youtube: String(song?.actions?.youtube || "").trim(),
      armory: String(song?.actions?.armory || "").trim()
    }
  };
}

async function main() {
  const dossiers = await loadSongDossiers();
  const trackRefs = await loadMusicTrackRefs();
  const releaseIndex = await loadReleaseIndex();
  const songs = [];
  const byTitle = {};
  const bySlug = {};

  for (const song of dossiers) {
    const record = buildSongRecord(song, trackRefs, releaseIndex);
    if (!record) continue;
    songs.push(record);
    byTitle[record.normalizedTitle] = record;
    bySlug[record.slug] = record;
  }

  songs.sort((a, b) => {
    const aNum = Number.parseInt(a.number || "0", 10) || 0;
    const bNum = Number.parseInt(b.number || "0", 10) || 0;
    if (aNum !== bNum) return aNum - bNum;
    return a.title.localeCompare(b.title);
  });

  const index = {
    generatedAt: new Date().toISOString(),
    source: "shieldbearer-website/song-meanings.html",
    count: songs.length,
    byTitle,
    bySlug,
    songs
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    ok: true,
    outputPath,
    songCount: songs.length,
    indexedTitles: Object.keys(byTitle).length,
    releaseMatches: songs.filter((song) => song.publishedAt).length
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
