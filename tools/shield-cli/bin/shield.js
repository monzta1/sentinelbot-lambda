#!/usr/bin/env node

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { emitSongEvent } = require("../src/event-stream");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const SONGS_TABLE_NAME = process.env.SONGS_TABLE_NAME || "shieldbearer-songs";
const TEST_STATE_FILE = process.env.SHIELD_CLI_DYNAMO_STATE_FILE || "";
const DEFAULT_DROPZONE_DIR = process.env.SHIELD_CLI_DROPZONE_DIR || path.join(os.homedir(), "Shieldbearer", "dropzone");
const DEFAULT_ARTWORK_PUBLIC_DIR = process.env.SHIELD_CLI_ARTWORK_PUBLIC_DIR || path.resolve(__dirname, "../../../../shieldbearer-website/images/signal-room");
const DEFAULT_ARTWORK_PUBLIC_BASE_URL = process.env.SHIELD_CLI_ARTWORK_PUBLIC_BASE_URL || "https://shieldbearerusa.com";
const DEFAULT_SITE_JSON_PATH = process.env.SHIELD_CLI_SITE_JSON_PATH || path.resolve(__dirname, "../../../../shieldbearer-website/site.json");

const helpText = `Shield Ingest CLI

Usage:
  shield ingest                  Scan the default dropzone for *.txt
  shield ingest dropzone         Same (alias, works from any cwd)
  shield ingest /path/to/dir     Scan that directory for *.txt
  shield ingest /path/to/file    Ingest a single .txt file
  shield ingest -                Same as no-args (scan default dropzone)

Default dropzone: ${DEFAULT_DROPZONE_DIR}
Override with SHIELD_CLI_DROPZONE_DIR.

Options:
  --help     Show help
  --dry-run  Preview without writing
`;

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function logMissingTitleDebug(filePath) {
  if (process.env.SHIELD_CLI_DEBUG_MISSING_TITLE !== "1") return;
  try {
    console.error(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(error);
  }
}

function normalizeValue(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function slugifyTitle(title) {
  return String(title || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeMatchName(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\.[^.]+$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mimeTypeFromArtworkPath(artworkPath) {
  const ext = path.extname(String(artworkPath || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return null;
}

function publishArtwork(filePath, songId) {
  const targetDirectory = DEFAULT_ARTWORK_PUBLIC_DIR;
  const fileName = `${songId}.jpg`;
  const targetPath = path.join(targetDirectory, fileName);
  fs.mkdirSync(targetDirectory, { recursive: true });
  if (process.env.SHIELD_CLI_ARTWORK_COPY_ONLY === "1") {
    fs.copyFileSync(filePath, targetPath);
  } else {
    try {
      execFileSync("sips", ["-s", "format", "jpeg", "-Z", "1024", filePath, "--out", targetPath], { stdio: "ignore" });
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  const baseUrl = String(DEFAULT_ARTWORK_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return `${baseUrl}/images/signal-room/${fileName}`;
}

function writeSiteJsonSnapshot(snapshot) {
  let siteJson = {};
  try {
    const raw = fs.readFileSync(DEFAULT_SITE_JSON_PATH, "utf8");
    siteJson = JSON.parse(raw);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  siteJson.comingSoon = snapshot ? [{
    title: snapshot.title || "",
    lyrics: snapshot.lyrics || "",
    teaserLyrics: "",
    artwork: snapshot.artworkUrl || "",
    songMeaning: snapshot.songMeaning || "",
    status: "coming_soon"
  }] : [];

  const directory = path.dirname(DEFAULT_SITE_JSON_PATH);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${DEFAULT_SITE_JSON_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(siteJson, null, 2)}\n`);
  fs.renameSync(tempPath, DEFAULT_SITE_JSON_PATH);
}

function runGit(args, cwd) {
  return require("child_process").spawnSync("git", args, { cwd, encoding: "utf8" });
}

function autoPushWebsiteRepo(snapshot) {
  if (process.env.SHIELD_CLI_AUTO_PUSH === "0") {
    return { pushed: false, skipped: true, reason: "disabled" };
  }
  if (process.env.SHIELD_CLI_SITE_JSON_PATH) {
    return { pushed: false, skipped: true, reason: "custom-site-json-path" };
  }

  const repoRoot = path.dirname(DEFAULT_SITE_JSON_PATH);
  const revParse = runGit(["rev-parse", "--is-inside-work-tree"], repoRoot);
  if (revParse.status !== 0) {
    return { pushed: false, skipped: true, reason: "not-a-git-repo" };
  }

  const siteJsonRel = path.relative(repoRoot, DEFAULT_SITE_JSON_PATH);
  const artworkRel = path.relative(repoRoot, DEFAULT_ARTWORK_PUBLIC_DIR);

  // Stage deletions of previously-tracked .jpg files that no longer exist
  const trackedJpgs = runGit(["ls-files", "--", `${artworkRel}/*.jpg`], repoRoot);
  if (trackedJpgs.status === 0 && trackedJpgs.stdout) {
    const deleted = trackedJpgs.stdout.split("\n").filter(Boolean).filter((rel) => !fs.existsSync(path.join(repoRoot, rel)));
    if (deleted.length > 0) {
      runGit(["rm", "--quiet", "--", ...deleted], repoRoot);
    }
  }

  // Stage current .jpg files in the artwork directory (skip legacy .png / .webp)
  if (fs.existsSync(DEFAULT_ARTWORK_PUBLIC_DIR)) {
    const jpgs = fs.readdirSync(DEFAULT_ARTWORK_PUBLIC_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".jpg")
      .map((entry) => path.join(artworkRel, entry.name));
    if (jpgs.length > 0) {
      runGit(["add", "--", ...jpgs], repoRoot);
    }
  }

  runGit(["add", "--", siteJsonRel], repoRoot);

  const diffCached = runGit(["diff", "--cached", "--quiet"], repoRoot);
  if (diffCached.status === 0) {
    return { pushed: false, skipped: true, reason: "no-changes" };
  }

  const message = snapshot
    ? "Refresh Signal Room song data via shield ingest"
    : "Clear Signal Room song data after empty dropzone ingest";
  const commitResult = runGit(["commit", "-m", message], repoRoot);
  if (commitResult.status !== 0) {
    return { pushed: false, skipped: false, reason: "commit-failed", error: (commitResult.stderr || "").trim() };
  }

  const pushResult = runGit(["push"], repoRoot);
  if (pushResult.status !== 0) {
    return { pushed: false, skipped: false, reason: "push-failed", error: (pushResult.stderr || "").trim() };
  }

  return { pushed: true, message };
}

// Permanent backdrop assets in images/signal-room/ that ingest must
// never delete. Adding to this set protects more files going forward.
const RESERVED_ARTWORK_FILES = new Set(["desk.jpg"]);

function cleanupPublishedArtwork(keepSongId) {
  const directory = DEFAULT_ARTWORK_PUBLIC_DIR;
  if (!fs.existsSync(directory)) return;
  const keepName = keepSongId ? `${keepSongId}.jpg` : null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== ".jpg") continue;
    if (RESERVED_ARTWORK_FILES.has(entry.name)) continue;
    if (keepName && entry.name === keepName) continue;
    fs.rmSync(path.join(directory, entry.name), { force: true });
  }
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

function getDropzoneTargets(dropzoneDir) {
  const files = listFiles(dropzoneDir);
  const textFiles = files.filter((file) => path.extname(file).toLowerCase() === ".txt");
  return textFiles.map((file) => path.join(dropzoneDir, file));
}

function isExistingDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function parseSongFile(rawContent) {
  const normalized = String(rawContent || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  const headingPattern = /^[ \t]*#([a-zA-Z]+)\s*$/gm;
  const headings = [];
  let headingMatch;

  while ((headingMatch = headingPattern.exec(normalized)) !== null) {
    headings.push({
      name: headingMatch[1].toLowerCase(),
      contentStart: headingPattern.lastIndex,
      headingStart: headingMatch.index
    });
  }

  const sections = {};
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    const next = headings[index + 1];
    const value = normalized.slice(current.contentStart, next ? next.headingStart : normalized.length)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (value.length > 0 && sections[current.name] == null) {
      sections[current.name] = value;
    }
  }

  return {
    title: sections.title || null,
    songmeaning: sections.songmeaning || null,
    lyrics: sections.lyrics || null,
    reference: sections.reference || null,
    scriptureRef: sections.scriptureref || null,
    scriptureQuote: sections.scripturequote || null
  };
}

function normalizeContentField(value) {
  const normalized = normalizeValue(value);
  return normalized;
}

// ============================================================
// songMeaning sanitizer.
//
// Markdown songmeaning sections sometimes hold the raw YouTube
// description -- hashtag dumps, emoji CTAs, scripture-list lines,
// and the artist URL. Those land in DynamoDB, propagate to
// site.json, and (post publisher-stamp) get rendered into the
// static index.html fallback. Strip the promo noise at ingest so
// every downstream consumer reads clean prose.
//
// Algorithm: split into paragraphs on blank lines. Drop any
// paragraph that contains a promo-signal line (emoji-prefix
// CTA, hashtag-only, URL-only, scripture-list). Keep prose
// paragraphs intact. Real prose paragraphs that happen to cite
// a single scripture reference at the end survive because
// the scripture-list pattern requires 2+ refs joined by a
// punctuation separator.
// ============================================================

const PROMO_LEADING_EMOJI_RE = /^\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F004}\u{1F0CF}]/u;
const HASHTAG_ONLY_LINE_RE = /^\s*#\S+(?:\s+#\S+)*\s*$/;
const URL_ONLY_LINE_RE = /^\s*https?:\/\/\S+\s*$/i;
// Matches lines like "Exodus 3:7-10 · Exodus 5:1" or "Psalm 34:17, John 8:36".
// Requires 2+ Book-Chapter:Verse fragments separated by middle-dot, comma, or semicolon.
const SCRIPTURE_LIST_LINE_RE = /^\s*(?:[1-3]\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+\d+:\d+(?:-\d+)?(?:\s*[·,;]\s*(?:[1-3]\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+\d+:\d+(?:-\d+)?)+\s*$/;

function isPromoLine(line) {
  if (!line) return false;
  if (PROMO_LEADING_EMOJI_RE.test(line)) return true;
  if (HASHTAG_ONLY_LINE_RE.test(line)) return true;
  if (URL_ONLY_LINE_RE.test(line)) return true;
  if (SCRIPTURE_LIST_LINE_RE.test(line)) return true;
  return false;
}

function cleanSongMeaning(raw) {
  if (raw == null) return raw;
  const str = String(raw);
  if (!str.trim()) return str;

  const normalized = str.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const paragraphs = normalized.split(/\n\s*\n/);

  const cleaned = paragraphs.filter((paragraph) => {
    const lines = paragraph.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return false;
    return !lines.some(isPromoLine);
  });

  return cleaned
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");
}

function normalizeLyricsBlock(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractLyricsPreview(lyrics) {
  const normalized = normalizeLyricsBlock(lyrics);
  if (!normalized) return "";
  return normalized.split("\n").slice(0, 5).join("\n");
}

function buildContentHash(song) {
  const payload = {
    artworkUrl: normalizeContentField(song.artworkUrl),
    lyrics: normalizeContentField(song.lyrics),
    songMeaning: normalizeContentField(song.songMeaning),
    songmeaning: normalizeContentField(song.songmeaning),
    title: normalizeContentField(song.title),
    reference: normalizeContentField(song.reference),
    scripture: song.scripture && typeof song.scripture === "object" ? {
      ref: normalizeContentField(song.scripture.ref) || "",
      quote: normalizeContentField(song.scripture.quote) || ""
    } : null
  };

  const stablePayload = {
    artworkUrl: payload.artworkUrl,
    lyrics: payload.lyrics,
    songMeaning: payload.songMeaning,
    songmeaning: payload.songmeaning,
    title: payload.title,
    reference: payload.reference,
    scripture: payload.scripture
  };

  return crypto.createHash("sha256").update(JSON.stringify(stablePayload)).digest("hex");
}

function detectArtwork(filePath, title, slug) {
  if (!title && !slug) return null;

  const directory = path.dirname(filePath);
  const supportedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const matchTitle = normalizeMatchName(title);
  const matchSlug = normalizeMatchName(slug);

  const exactMatch = entries.find((entry) => {
    if (!entry.isFile()) return false;
    const parsed = path.parse(entry.name);
    if (!supportedExtensions.has(parsed.ext.toLowerCase())) return false;
    const stem = normalizeMatchName(parsed.name);
    return stem === matchSlug || stem === matchTitle;
  });

  if (exactMatch) {
    return exactMatch.name;
  }

  const containsMatch = entries.find((entry) => {
    if (!entry.isFile()) return false;
    const parsed = path.parse(entry.name);
    if (!supportedExtensions.has(parsed.ext.toLowerCase())) return false;
    const stem = normalizeMatchName(parsed.name);
    return (matchSlug && stem.includes(matchSlug)) || (matchTitle && stem.includes(matchTitle));
  });

  if (containsMatch) {
    return containsMatch.name;
  }

  const textFileCount = entries.filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".txt").length;
  if (textFileCount > 1) {
    return null;
  }

  const anyImage = entries.find((entry) => {
    if (!entry.isFile()) return false;
    return supportedExtensions.has(path.parse(entry.name).ext.toLowerCase());
  });

  return anyImage ? anyImage.name : null;
}

function isQualifyingSong(parsed, songPayload) {
  const title = normalizeValue(parsed?.title);
  if (!title) {
    return false;
  }

  const lyrics = normalizeValue(songPayload?.lyrics);
  const artworkUrl = normalizeValue(songPayload?.artworkUrl);

  if (lyrics) {
    return true;
  }

  if (artworkUrl) {
    return true;
  }

  return false;
}

function buildSongContentPayload(filePath, parsed, slug) {
  const artworkFile = detectArtwork(filePath, parsed.title, slug);
  const lyrics = normalizeValue(parsed.lyrics);
  const songMeaning = cleanSongMeaning(normalizeValue(parsed.songmeaning));
  const artworkPath = artworkFile ? path.join(path.dirname(filePath), artworkFile) : null;
  const artworkUrl = artworkPath ? publishArtwork(artworkPath, slug) : null;
  // Reference is a free-form pipe-separated string ("Exodus 5:1 |
  // Exodus 7:16"). Scripture is a structured { ref, quote } pair
  // built from two separate template sections so the user can write
  // a multi-line quote without escaping. Both default to null when
  // the template did not include them, so existing templates without
  // these sections still ingest cleanly. But a missing Reference is
  // almost always an oversight on a Shieldbearer release -- the songs
  // are built from Scripture -- so loudly warn the operator so the
  // missing refs don't silently ship to the live site.
  const reference = normalizeValue(parsed.reference);
  const scriptureRef = normalizeValue(parsed.scriptureRef);
  const scriptureQuote = normalizeValue(parsed.scriptureQuote);
  const scripture = (scriptureRef || scriptureQuote)
    ? { ref: scriptureRef || "", quote: scriptureQuote || "" }
    : null;
  // Only warn when this looks like a real ingest (lyrics present).
  // The empty-template / skip paths have their own handling and a
  // warning there would be noise.
  if (!reference && lyrics) {
    warnMissingReference(slug, parsed.title);
  }
  return {
    lyrics,
    lyricsPreview: extractLyricsPreview(parsed.lyrics),
    songMeaning,
    songmeaning: songMeaning,
    artwork: artworkFile || null,
    artworkUrl,
    reference,
    scripture
  };
}

// Loud stderr warning when an ingest is about to ship a song without
// a #Reference section. Goes to stderr so stdout JSON stays clean for
// scripts that pipe ingest output. Operator can still proceed; this
// is just a visible nudge.
function warnMissingReference(slug, title) {
  const label = title || slug || "this release";
  const banner = "================================================================================";
  process.stderr.write([
    "",
    banner,
    "  WARNING: no #Reference section found for \"" + label + "\".",
    "",
    "  Shieldbearer songs are built from Scripture and every release on the site",
    "  carries its primary Scripture references. Without a #Reference section",
    "  this song will deploy with EMPTY scripture data in site.json, and the",
    "  /song-meanings dossier will have nothing to link to BibleGateway.",
    "",
    "  Add a section like this to the source .txt file and re-run ingest:",
    "",
    "    #Reference",
    "    Book Chapter:Verse | Book Chapter:Verse | Book Chapter:Verse",
    "",
    "    #ScriptureRef",
    "    Book Chapter:Verse",
    "",
    "    #ScriptureQuote",
    "    \"The verse text to pull up on the page.\"",
    "",
    "  Continuing anyway. Re-ingest with refs to fix the live site.",
    banner,
    ""
  ].join("\n"));
}

function readSongFile(filePath) {
  const rawContent = fs.readFileSync(filePath, "utf8");
  return parseSongFile(rawContent);
}

function loadTestState() {
  if (!TEST_STATE_FILE) return {};
  try {
    const raw = fs.readFileSync(TEST_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function saveTestState(state) {
  if (!TEST_STATE_FILE) return;
  const directory = path.dirname(TEST_STATE_FILE);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${TEST_STATE_FILE}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tempPath, TEST_STATE_FILE);
}

async function fetchExistingSong(songId) {
  if (TEST_STATE_FILE) {
    const state = loadTestState();
    return state[songId] || null;
  }

  const response = await dynamo.send(new GetCommand({
    TableName: SONGS_TABLE_NAME,
    Key: { songId }
  }));

  return response?.Item || null;
}

function buildInsertItem(song, contentHash, nowIso) {
  const item = {
    songId: song.songId,
    title: song.title,
    contentHash,
    status: "coming_soon",
    createdAt: nowIso,
    updatedAt: nowIso
  };

  if (normalizeValue(song.songMeaning)) item.songMeaning = normalizeValue(song.songMeaning);
  if (normalizeValue(song.songmeaning)) item.songmeaning = normalizeValue(song.songmeaning);
  if (normalizeValue(song.lyrics)) item.lyrics = normalizeValue(song.lyrics);
  if (normalizeValue(song.lyricsPreview)) item.lyricsPreview = normalizeValue(song.lyricsPreview);
  if (normalizeValue(song.artworkUrl)) item.artworkUrl = normalizeValue(song.artworkUrl);
  if (normalizeValue(song.artwork)) item.artwork = normalizeValue(song.artwork);
  if (normalizeValue(song.reference)) item.reference = normalizeValue(song.reference);
  if (song.scripture && typeof song.scripture === "object" && (song.scripture.ref || song.scripture.quote)) {
    item.scripture = {
      ref: String(song.scripture.ref || "").trim(),
      quote: String(song.scripture.quote || "").trim()
    };
  }

  return item;
}

function buildMergedUpdate(existing, song, contentHash, nowIso) {
  const next = { ...existing };
  next.songId = existing.songId || song.songId;
  const nextTitle = normalizeValue(song.title);
  const nextSongMeaning = normalizeValue(song.songMeaning);
  const nextSongmeaning = normalizeValue(song.songmeaning);
  const nextLyrics = normalizeValue(song.lyrics);
  const nextLyricsPreview = normalizeValue(song.lyricsPreview);
  const nextArtwork = normalizeValue(song.artworkUrl);

  if (normalizeValue(existing.title) !== nextTitle) next.title = nextTitle;
  if (nextSongMeaning != null && normalizeValue(existing.songMeaning) !== nextSongMeaning) next.songMeaning = nextSongMeaning;
  if (nextSongmeaning != null && normalizeValue(existing.songmeaning) !== nextSongmeaning) next.songmeaning = nextSongmeaning;
  if (nextLyrics != null && normalizeValue(existing.lyrics) !== nextLyrics) next.lyrics = nextLyrics;
  if (nextLyricsPreview != null && normalizeValue(existing.lyricsPreview) !== nextLyricsPreview) next.lyricsPreview = nextLyricsPreview;
  if (nextArtwork != null && normalizeValue(existing.artworkUrl) !== nextArtwork) next.artworkUrl = nextArtwork;
  if (normalizeValue(song.artwork) != null && normalizeValue(existing.artwork) !== normalizeValue(song.artwork)) next.artwork = normalizeValue(song.artwork);

  if (nextSongMeaning == null) delete next.songMeaning;
  if (nextSongmeaning == null) delete next.songmeaning;
  if (nextLyrics == null) delete next.lyrics;
  if (nextLyricsPreview == null) delete next.lyricsPreview;
  if (nextArtwork == null) {
    delete next.artworkUrl;
    delete next.artwork;
  }

  const nextReference = normalizeValue(song.reference);
  if (nextReference != null) {
    next.reference = nextReference;
  } else {
    delete next.reference;
  }

  if (song.scripture && typeof song.scripture === "object" && (song.scripture.ref || song.scripture.quote)) {
    next.scripture = {
      ref: String(song.scripture.ref || "").trim(),
      quote: String(song.scripture.quote || "").trim()
    };
  } else {
    delete next.scripture;
  }

  next.contentHash = contentHash;
  next.updatedAt = nowIso;
  if (!normalizeValue(next.status)) next.status = "coming_soon";

  return next;
}

async function writeInsert(song, contentHash, nowIso) {
  const item = buildInsertItem(song, contentHash, nowIso);

  if (TEST_STATE_FILE) {
    const state = loadTestState();
    state[song.songId] = item;
    saveTestState(state);
    return;
  }

  /* c8 ignore start: production DynamoDB write path; tests run with TEST_STATE_FILE shim above */
  await dynamo.send(new PutCommand({
    TableName: SONGS_TABLE_NAME,
    Item: item,
    ConditionExpression: "attribute_not_exists(songId)"
  }));
  /* c8 ignore stop */
}

async function writeUpdate(existing, song, contentHash, nowIso) {
  if (TEST_STATE_FILE) {
    const state = loadTestState();
    state[song.songId] = buildMergedUpdate(state[song.songId] || existing, song, contentHash, nowIso);
    saveTestState(state);
    return;
  }
  /* c8 ignore start: production DynamoDB UpdateCommand path; tests run with TEST_STATE_FILE shim above */

  const expressionNames = {
    "#contentHash": "contentHash",
    "#songId": "songId",
    "#status": "status",
    "#updatedAt": "updatedAt"
  };
  const expressionValues = {
    ":comingSoon": "coming_soon",
    ":contentHash": contentHash,
    ":updatedAt": nowIso
  };
  const setExpressions = [
    "#title = :title",
    "#contentHash = :contentHash",
    "#updatedAt = :updatedAt",
    "#status = if_not_exists(#status, :comingSoon)"
  ];
  const removeExpressions = [];

  expressionNames["#title"] = "title";
  expressionValues[":title"] = normalizeValue(song.title);

  if (normalizeValue(song.songmeaning) != null) {
    expressionNames["#songmeaning"] = "songmeaning";
    expressionValues[":songmeaning"] = normalizeValue(song.songmeaning);
    setExpressions.push("#songmeaning = :songmeaning");
  } else {
    expressionNames["#songmeaning"] = "songmeaning";
    removeExpressions.push("#songmeaning");
  }

  if (normalizeValue(song.lyrics) != null) {
    expressionNames["#lyrics"] = "lyrics";
    expressionValues[":lyrics"] = normalizeValue(song.lyrics);
    setExpressions.push("#lyrics = :lyrics");
  } else {
    expressionNames["#lyrics"] = "lyrics";
    removeExpressions.push("#lyrics");
  }

  if (normalizeValue(song.artworkUrl) != null) {
    expressionNames["#artworkUrl"] = "artworkUrl";
    expressionValues[":artworkUrl"] = normalizeValue(song.artworkUrl);
    setExpressions.push("#artworkUrl = :artworkUrl");
  } else {
    expressionNames["#artworkUrl"] = "artworkUrl";
    removeExpressions.push("#artworkUrl");
  }

  if (normalizeValue(song.artwork) != null) {
    expressionNames["#artwork"] = "artwork";
    expressionValues[":artwork"] = normalizeValue(song.artwork);
    setExpressions.push("#artwork = :artwork");
  } else {
    expressionNames["#artwork"] = "artwork";
    removeExpressions.push("#artwork");
  }

  if (normalizeValue(song.reference) != null) {
    expressionNames["#reference"] = "reference";
    expressionValues[":reference"] = normalizeValue(song.reference);
    setExpressions.push("#reference = :reference");
  } else {
    expressionNames["#reference"] = "reference";
    removeExpressions.push("#reference");
  }

  if (song.scripture && typeof song.scripture === "object" && (song.scripture.ref || song.scripture.quote)) {
    expressionNames["#scripture"] = "scripture";
    expressionValues[":scripture"] = {
      ref: String(song.scripture.ref || "").trim(),
      quote: String(song.scripture.quote || "").trim()
    };
    setExpressions.push("#scripture = :scripture");
  } else {
    expressionNames["#scripture"] = "scripture";
    removeExpressions.push("#scripture");
  }

  const updateSegments = [`SET ${setExpressions.join(", ")}`];
  if (removeExpressions.length > 0) {
    updateSegments.push(`REMOVE ${removeExpressions.join(", ")}`);
  }

  await dynamo.send(new UpdateCommand({
    TableName: SONGS_TABLE_NAME,
    Key: { songId: song.songId },
    ConditionExpression: "attribute_exists(#songId)",
    UpdateExpression: updateSegments.join(" "),
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: expressionValues
  }));
  /* c8 ignore stop */
}

function parseArgs(argv) {
  const args = argv.slice(2);
  /* c8 ignore start: --help/empty-args branch exits the process; not exercised in unit tests */
  if (args.length === 0 || args.includes("--help")) {
    process.stdout.write(helpText);
    process.exit(0);
  }
  /* c8 ignore stop */

  const command = args[0];
  const fileArg = args.find((arg, index) => index > 0 && !arg.startsWith("--"));
  const isDryRun = args.includes("--dry-run");
  return { command, fileArg, isDryRun };
}

async function ingestSongFile(filePath, { dryRun = false } = {}) {
  let parsed;
  try {
    parsed = readSongFile(filePath);
  } catch (error) {
    /* c8 ignore start: file-read failure path, exercised end-to-end via shield-cli tests */
    console.error(error);
    return {
      status: "rejected",
      reason: "missing_title",
      songId: null,
      filePath
    };
    /* c8 ignore stop */
  }

  if (!parsed.title) {
    logMissingTitleDebug(filePath);
    return {
      status: "rejected",
      reason: "missing_title",
      songId: null,
      writtenToDynamo: false,
      filePath
    };
  }

  const songId = slugifyTitle(parsed.title);
  /* c8 ignore start: defensive guard, parsed.title is guaranteed non-empty by the check above */
  if (!songId) {
    return {
      status: "rejected",
      reason: "missing_title",
      songId: null,
      writtenToDynamo: false,
      filePath
    };
  }
  /* c8 ignore stop */

  const contentPayload = buildSongContentPayload(filePath, parsed, songId);
  if (!isQualifyingSong(parsed, contentPayload)) {
    return {
      status: "skipped",
      reason: "not_qualifying",
      songId,
      writtenToDynamo: false,
      filePath
    };
  }

  try {
    const persisted = await persistSong({
      songId,
      title: parsed.title,
      songMeaning: contentPayload.songMeaning,
      songmeaning: contentPayload.songmeaning,
      lyrics: contentPayload.lyrics,
      lyricsPreview: contentPayload.lyricsPreview,
      artwork: contentPayload.artwork,
      artworkUrl: contentPayload.artworkUrl,
      reference: contentPayload.reference,
      scripture: contentPayload.scripture
    }, {
      dryRun
    });

    return {
      ...persisted,
      filePath,
      snapshot: {
        songId,
        title: parsed.title,
        lyrics: contentPayload.lyrics || "",
        songMeaning: contentPayload.songMeaning || "",
        artworkUrl: contentPayload.artworkUrl || ""
      }
    };
  /* c8 ignore start: DynamoDB error path requires AWS-side failure to test, exercised end-to-end via shield-cli tests */
  } catch (error) {
    console.error(error);
    return {
      status: "error",
      reason: "dynamodb_write_failed",
      songId,
      writtenToDynamo: false,
      filePath
    };
  }
  /* c8 ignore stop */
}

async function persistSong(song, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const contentHash = buildContentHash(song);
  const existing = await fetchExistingSong(song.songId);
  const nowIso = new Date().toISOString();
  const nextArtworkUrl = normalizeValue(song.artworkUrl);
  const nextLyrics = normalizeValue(song.lyrics);
  const nextSongMeaning = normalizeValue(song.songMeaning);
  const nextSongmeaning = normalizeValue(song.songmeaning);
  const existingArtworkUrl = normalizeValue(existing?.artworkUrl);
  const existingLyrics = normalizeValue(existing?.lyrics);
  const existingSongMeaning = normalizeValue(existing?.songMeaning);
  const existingSongmeaning = normalizeValue(existing?.songmeaning);
  const hasMissingMetadata =
    (nextArtworkUrl && existingArtworkUrl !== nextArtworkUrl) ||
    (nextLyrics && existingLyrics !== nextLyrics) ||
    (nextSongMeaning && existingSongMeaning !== nextSongMeaning) ||
    (nextSongmeaning && existingSongmeaning !== nextSongmeaning);

  if (!existing) {
    if (!dryRun) {
      await writeInsert(song, contentHash, nowIso);
      void emitSongEvent({
        eventType: "SONG_CREATED",
        songId: song.songId,
        title: song.title,
        contentHash,
        artworkUrl: song.artworkUrl,
        lyrics: song.lyrics,
        songMeaning: song.songMeaning,
        timestamp: nowIso,
        source: "shield-ingest-cli"
      }).catch((error) => {
        /* c8 ignore start: best-effort event-stream catch, not on the unit-test path */
        console.error(JSON.stringify({
          stage: "eventstream_write_failed",
          songId: song.songId,
          updateType: "insert",
          error: error?.message || String(error)
        }));
        /* c8 ignore stop */
      });
    }
    return {
      status: "processed",
      songId: song.songId,
      writtenToDynamo: !dryRun,
      updateType: "insert",
      contentHash
    };
  }

  const existingHash = normalizeValue(existing.contentHash);
  if (existingHash === contentHash && !hasMissingMetadata) {
    return {
      status: "unchanged",
      songId: song.songId,
      writtenToDynamo: false,
      updateType: "skip",
      contentHash
    };
  }

  if (!dryRun) {
    await writeUpdate(existing, song, contentHash, nowIso);
    void emitSongEvent({
      eventType: "SONG_UPDATED",
      songId: song.songId,
      title: song.title,
      contentHash,
      artworkUrl: song.artworkUrl,
      lyrics: song.lyrics,
      songMeaning: song.songMeaning,
      timestamp: nowIso,
      source: "shield-ingest-cli"
    }).catch((error) => {
      /* c8 ignore start: best-effort event-stream catch, not on the unit-test path */
      console.error(JSON.stringify({
        stage: "eventstream_write_failed",
        songId: song.songId,
        updateType: "update",
        error: error?.message || String(error)
      }));
      /* c8 ignore stop */
    });
  }
  return {
    status: "updated",
    songId: song.songId,
    writtenToDynamo: !dryRun,
    updateType: "update",
    contentHash
  };
}

/* c8 ignore start: CLI entry point and IO orchestration, exercised end-to-end via shield-cli tests rather than unit tests */
function main() {
  return (async () => {
    const { command, fileArg, isDryRun } = parseArgs(process.argv);

    // Resolve fileArg into a directory if possible so `shield ingest` works
    // from anywhere. Accepted forms (all do the same thing as the no-arg
    // scan of DEFAULT_DROPZONE_DIR, with the directory arg variant scoped
    // to whichever directory was named):
    //   shield ingest                  -> scan DEFAULT_DROPZONE_DIR
    //   shield ingest -                 -> scan DEFAULT_DROPZONE_DIR
    //   shield ingest dropzone          -> alias for the same default scan
    //   shield ingest /any/dir          -> scan that directory (if it exists)
    //   shield ingest /any/file.txt     -> ingest that single file (legacy)
    const cwdResolvedArg = (fileArg && fileArg !== "-")
      ? path.resolve(process.cwd(), fileArg)
      : null;
    const argIsDir = cwdResolvedArg ? isExistingDirectory(cwdResolvedArg) : false;
    const argIsDropzoneAlias = typeof fileArg === "string" && fileArg.toLowerCase() === "dropzone";
    const shouldScanDropzone = command === "ingest" && (!fileArg || fileArg === "-" || argIsDropzoneAlias || argIsDir);

    if (command !== "ingest" || shouldScanDropzone) {
      // When fileArg points at an existing directory other than the literal
      // "dropzone" alias, scan that directory. Otherwise scan the default.
      const dropzoneDir = (argIsDir && !argIsDropzoneAlias) ? cwdResolvedArg : DEFAULT_DROPZONE_DIR;
      const targets = shouldScanDropzone ? getDropzoneTargets(dropzoneDir) : [];

      if (command !== "ingest") {
        process.stdout.write(helpText);
        process.exit(0);
      }

      if (!targets.length) {
        let sitePush = null;
        if (!isDryRun) {
          writeSiteJsonSnapshot(null);
          cleanupPublishedArtwork(null);
          sitePush = autoPushWebsiteRepo(null);
        }
        printJson({
          status: "processed",
          mode: "dropzone",
          scanned: 0,
          queued: 0,
          skipped: 0,
          rejected: 0,
          writtenToDynamo: false,
          sitePush
        });
        return;
      }

      const results = [];
      for (const target of targets) {
        results.push(await ingestSongFile(target, { dryRun: isDryRun }));
      }

      let sitePush = null;
      if (!isDryRun) {
        const snapshot = results.find((result) => result?.snapshot)?.snapshot || null;
        writeSiteJsonSnapshot(snapshot);
        cleanupPublishedArtwork(snapshot?.artworkUrl ? snapshot.songId : null);
        sitePush = autoPushWebsiteRepo(snapshot);
      }

      const summary = {
        status: "processed",
        mode: "dropzone",
        scanned: results.length,
        queued: results.filter((result) => result.status === "processed" || result.status === "updated").length,
        skipped: results.filter((result) => result.status === "skipped").length,
        rejected: results.filter((result) => result.status === "rejected").length,
        writtenToDynamo: results.some((result) => Boolean(result.writtenToDynamo)),
        sitePush
      };

      printJson(summary);
      return;
    }

    let filePath;
    try {
      filePath = path.resolve(process.cwd(), fileArg);
      const result = await ingestSongFile(filePath, { dryRun: isDryRun });
      if (!isDryRun) {
        const snapshot = result?.snapshot || null;
        writeSiteJsonSnapshot(snapshot);
        cleanupPublishedArtwork(snapshot?.artworkUrl ? snapshot.songId : null);
        result.sitePush = autoPushWebsiteRepo(snapshot);
      }
      printJson(result);
    } catch (error) {
      printJson({
        status: "error",
        reason: "dynamodb_write_failed",
        songId: null
      });
    }
  })();
}

if (require.main === module) {
  main().catch(() => {
    printJson({
      status: "error",
      reason: "dynamodb_write_failed",
      songId: null
    });
  });
}
/* c8 ignore stop */

module.exports = {
  cleanSongMeaning,
  isPromoLine
};
