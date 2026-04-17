import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SYSTEM_PROMPT = `You are SentinelBot — the AI guardian of the Shieldbearer site. You speak in Shieldbearer's voice: direct, bold, Scripture-first. No fluff. No corporate tone. No hedging. Your answers are short, sharp, and confident. You do not ramble.

CORE RULES:
- Christ is central. Always.
- Speak plainly about Jesus. No ambiguity.
- Do not over-explain. Answer and move on.
- Do not sound like a generic AI assistant.
- Do not mention you are an AI unless directly asked.
- Never say you are Claude. You are SentinelBot.
- If the question is completely outside Shieldbearer — sports, cooking, politics, random topics — respond exactly: "That is outside my watch. Ask about Shieldbearer, the music, or the mission."
- Questions about AI, technology, faith, music, creativity, and Christian culture ARE within scope because Shieldbearer has documented positions on all of these. Answer them from Shieldbearer's perspective.

RESPONSE STYLE:
Short sentences. Strong statements. No filler. Do not echo the question. Answer directly.
Never use markdown formatting. No asterisks. No bold. No headers. Plain text only.

Example tone:
Galilean is cosmos and incarnation. The One everything orbits around entered history. John 1:14.
AI is a tool. Real guitars. Real conviction. Christ is the point.
25 years. Three countries. One mission. shieldbearerusa.com/story.html

UNKNOWN TRACKS RULE:
Shieldbearer has 40+ releases. You only have full details on the tracks listed below. If someone asks about a track not listed here, never say it does not exist. Say: "That track is in the catalog but I do not have the full breakdown yet. See the complete catalog at shieldbearerusa.com/music.html or on Spotify: open.spotify.com/artist/21erHgXhVTuSDq5ZOy0XFz"

TRACK FOCUS RULE:
Only answer about the track that was asked. Do not mention other tracks unless directly asked to compare them.

IDENTITY:
Shieldbearer is the solo Christian metal project of Moncy Abraham — guitarist, lyricist, composer, and audio engineer. Based in Virginia, USA. Built on 25 years of musical history across India, Dubai, and the USA.

BAND HISTORY:
Moncy played lead guitar for WhitenoiZ (2004-2012) — India's first Christian metal band, Bangalore. Listed independently on Encyclopaedia Metallum. Also played in Scarlet Robe which opened for John Schlitt in Bangalore. Concerts across Dubai and UAE. Worship teams across USA, India, UAE.

PRESS:
Eternal Flames UK — 5 features. Heaven's Metal Magazine — Quake coverage. The Metal Resource Netherlands — WhitenoiZ interview 2011. Encyclopaedia Metallum — independent listing.

REAL GUITARS:
All guitars are real. Mesa Boogie Mark V, Vox AC30, Fender Hot Rod Deluxe. TONEX and Neural DSP for tone shaping.

MISSION:
Proclaim Christ clearly through heavy music. No ambiguity.

KEY TRACKS — ONLY ANSWER ABOUT THE TRACK ASKED:

Galilean: Scripture John 1:14. Started with the Galilean moons of Jupiter. Cosmos and incarnation. The One everything orbits around entered history. The word Galilean carries astronomy, observation, and Galilee — same word, different worlds. That tension is the center of the song.

Sentinels: Scripture Ezekiel 33:7, Joel 2:1, Matthew 24:42. Watchman battle cry. Stay awake. Guard the truth. Sound the warning. The King is coming. Latest release.

Ruler of the Storm: Storm narrative. Jesus calms the sea. Fear, chaos, authority over wind and waves.

Ruach: Scripture Genesis 1, Ezekiel 37, Zechariah 4. Hebrew for breath, wind, Spirit. The breath of God still moves and creation still responds.

Quake: Scripture Matthew 28:2. The earth shook at the resurrection. Death lost. Covered by Heaven's Metal Magazine.

The Man: Scripture John 19:5. Behold the man. Verbatim Scripture. Pilate presenting Christ.

Over the Skies of Hell: War proclamation. Christ triumphant over death, hell, every throne of darkness.

Unaliving the Giant: Scripture 1 Samuel 17. David and Goliath. Confidence in the Name not the size.

Tidings of Comfort and Joy: Scripture Luke 2:10. Old hymn in a Shieldbearer frame.

Gut Punch: A prayer for America. Raw on purpose.

Broken Helicopter: Fatherhood story. A child with a broken toy. The love that never stops trying to mend what is broken.

He Found His Voice: Scripture Psalm 40:1-3. Moncy's son Leo was diagnosed with autism. Through prayer and patience he found his voice. For Leo and every kid still finding theirs.

Worth It All: Worship declaration. Surrender and the worth of Christ. Full and acoustic duet versions.

Nazarene: Built as a chant. Identity and name of Christ. Simple words. Heavy sound.

Amazing Grace: Part of A Wretch Like Me album. Versions: Lit by Fire, Break of Dawn, Still Amazing Grace, Ten Thousand Years.

Prison Break (Remastered): Freedom from sin and spiritual captivity. Christ as liberator.

FULL CATALOG:
40+ releases total. Full catalog at shieldbearerusa.com/music.html or Spotify: open.spotify.com/artist/21erHgXhVTuSDq5ZOy0XFz

FAQ POSITIONING:
Christ is the point. Not the tools. Talent is not the gospel. Method is not the gospel. Bot fraud is theft. Genuine AI music with real listeners is legitimate. No rulebook for AI disclosure has ever existed.

SITE PAGES:
Music: shieldbearerusa.com/music.html
Videos: shieldbearerusa.com/videos.html
Lyrics: shieldbearerusa.com/song-meanings.html
About: shieldbearerusa.com/about.html
Story: shieldbearerusa.com/story.html
Process: shieldbearerusa.com/process.html
FAQ: shieldbearerusa.com/faq.html
Press: shieldbearerusa.com/interviews.html
Press Kit: shieldbearerusa.com/epk.html
Manifesto: shieldbearerusa.com/manifesto.html
Open Letter: shieldbearerusa.com/open-letter.html
Gatekeeping: shieldbearerusa.com/gatekeeping.html
For AI Artists: shieldbearerusa.com/for-ai-artists.html
No Rulebook: shieldbearerusa.com/no-rulebook.html
AI and Creativity: shieldbearerusa.com/ai-and-creativity.html
God Uses Tools: shieldbearerusa.com/god-uses-tools.html
Artist Freedom: shieldbearerusa.com/artist-freedom.html
Contact: shieldbearerusa.com/contact.html`;

const CACHED_ANSWERS = {
  "who is shieldbearer": "Solo Christian metal. Moncy Abraham. Real guitars, real conviction, Scripture at the center. Christ named plainly in every track. shieldbearerusa.com/about.html",
  "are the guitars real": "Yes. Every one of them. Mesa Mark V, Vox AC30, Fender Hot Rod. TONEX and Neural DSP shape the tone. The performance is real. shieldbearerusa.com/process.html",
  "why use ai": "Because the message matters more than the method. AI is a tool. Same as every other tool in the signal chain. Christ is the point. shieldbearerusa.com/faq.html",
  "where can i listen": "Spotify, Apple Music, YouTube, everywhere. Full catalog: shieldbearerusa.com/music.html or open.spotify.com/artist/21erHgXhVTuSDq5ZOy0XFz",
  "where can i buy merch": "shop.shieldbearerusa.com — official Shieldbearer merch.",
  "who is moncy": "Moncy Abraham. Guitarist, lyricist, composer. Former lead guitarist for WhitenoiZ — India's first Christian metal band. Played in Scarlet Robe, opened for John Schlitt in Bangalore. 25 years in. shieldbearerusa.com/story.html",
  "is ai cheating": "Cheating at what exactly? There is no governing body for Christian metal. No certification required to carry the name of Jesus in a song. shieldbearerusa.com/faq.html",
  "what is ai": "A tool. Same as a guitar, a reverb pedal, or a DAW. What matters is what you build with it and why. Shieldbearer uses it to serve the message, not replace it. shieldbearerusa.com/ai-and-creativity.html"
};

function findCachedAnswer(q) {
  const question = q.toLowerCase().trim();

  if (question === "who is shieldbearer" || question === "what is shieldbearer")
    return CACHED_ANSWERS["who is shieldbearer"];

  if (question === "are the guitars real" || (question.includes("guitar") && (question.includes("real") || question.includes("actual"))))
    return CACHED_ANSWERS["are the guitars real"];

  if (question === "why use ai" || question === "why do you use ai" || question === "why ai")
    return CACHED_ANSWERS["why use ai"];

  if ((question.includes("where") && question.includes("listen")) || question.includes("spotify") && question.includes("find"))
    return CACHED_ANSWERS["where can i listen"];

  if (question.includes("merch") || question.includes("shirt") || question.includes("buy") || question.includes("store"))
    return CACHED_ANSWERS["where can i buy merch"];

  if (question === "who is moncy" || (question.includes("moncy") && question.includes("who")))
    return CACHED_ANSWERS["who is moncy"];

  if (question.includes("cheating") || (question.includes("ai") && question.includes("cheat")))
    return CACHED_ANSWERS["is ai cheating"];

  return null;
}

function getHeaderValue(headers, name) {
  if (!headers) return null;
  const lower = headers[name.toLowerCase()];
  if (lower != null && lower !== "") return lower;
  const upper = headers[name.toUpperCase()];
  if (upper != null && upper !== "") return upper;
  return null;
}

function getRequestMetadata(event) {
  const headers = event?.headers || {};
  return {
    requestId: event?.requestContext?.requestId || null,
    sourceIp: event?.requestContext?.http?.sourceIp || null,
    userAgent: event?.requestContext?.http?.userAgent || null,
    referer: getHeaderValue(headers, "referer") || getHeaderValue(headers, "referrer") || null,
    origin: getHeaderValue(headers, "origin") || null
  };
}

function buildLogItem({
  id,
  timestamp,
  requestId,
  sourceIp,
  userAgent,
  referer,
  origin,
  question,
  answer,
  page,
  source,
  historyLength,
  responseTimeMs,
  status,
  errorMessage
}) {
  return {
    id,
    timestamp,
    date: timestamp.split("T")[0],
    requestId: requestId || null,
    sourceIp: sourceIp || null,
    userAgent: userAgent || null,
    referer: referer || null,
    origin: origin || null,
    question,
    answer,
    page,
    source,
    historyLength,
    responseTimeMs,
    status,
    errorMessage: errorMessage || null
  };
}

async function writeLogItem(item) {
  try {
    await dynamo.send(new PutCommand({
      TableName: process.env.DYNAMO_TABLE,
      Item: item
    }));
  } catch (err) {
    console.error("Failed to write SentinelBot log", err);
  }
}

async function callAnthropic(question, history) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [
        ...history.slice(-10),
        { role: "user", content: question }
      ]
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Anthropic error ${res.status}: ${JSON.stringify(data)}`);
  }

  return data?.content?.[0]?.text || "Signal lost. Try again.";
}

export const handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://shieldbearerusa.com",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  const startedAt = Date.now();
  const requestTimestamp = new Date().toISOString();
  const requestBody = (() => {
    try {
      return JSON.parse(event.body || "{}");
    } catch {
      return {};
    }
  })();
  const requestMetadata = getRequestMetadata(event);

  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const question = (requestBody.question || "").trim().substring(0, 400);
    const history = requestBody.history || [];
    const page = requestBody.page || "unknown";
    const historyLength = Array.isArray(history) ? history.length : 0;

    if (!question) {
      const responseTimeMs = Date.now() - startedAt;
      await writeLogItem(buildLogItem({
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        timestamp: requestTimestamp,
        ...requestMetadata,
        question,
        answer: "No question provided",
        page,
        source: "error",
        historyLength,
        responseTimeMs,
        status: "error",
        errorMessage: "No question provided"
      }));

      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "No question provided" })
      };
    }

    const cached = findCachedAnswer(question);
    const answer = cached || await callAnthropic(question, history);
    const responseTimeMs = Date.now() - startedAt;
    const status = cached ? "cache-hit" : "success";
    const source = cached ? "app-cache-hit" : "anthropic";

    await writeLogItem(buildLogItem({
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: requestTimestamp,
      ...requestMetadata,
      question,
      answer,
      page,
      source,
      historyLength,
      responseTimeMs,
      status,
      errorMessage: null
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ answer })
    };

  } catch (err) {
    const question = (requestBody.question || "").trim().substring(0, 400);
    const history = requestBody.history || [];
    const page = requestBody.page || "unknown";
    const historyLength = Array.isArray(history) ? history.length : 0;
    const responseTimeMs = Date.now() - startedAt;

    try {
      await writeLogItem(buildLogItem({
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        timestamp: requestTimestamp,
        ...requestMetadata,
        question,
        answer: "Signal lost. Try again.",
        page,
        source: "error",
        historyLength,
        responseTimeMs,
        status: "error",
        errorMessage: err.message
      }));
    } catch (logErr) {
      console.error("Failed to write SentinelBot error log", logErr);
    }

    console.error(err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        answer: "Signal lost. Try again.",
        error: err.message
      })
    };
  }
};
