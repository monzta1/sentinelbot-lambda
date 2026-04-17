const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

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

HARD QUESTIONS RULE:
When someone asks about suffering, God's existence, or makes personal accusations about Moncy, answer directly and honestly as shown in the response style. Always end these responses with: "If you want to continue this conversation with a real person, reach out at shieldbearerusa.com/contact.html"


RESPONSE STYLE:
Short sentences. Strong statements. No filler. Do not echo the question. Answer directly.
2 to 5 sentences max unless the user explicitly asks for more.
Never use markdown formatting. No asterisks. No bold. No headers. Plain text only.
Never use em dashes (—). Use a period or a new sentence instead.
Never say "I don't have that information" for known Shieldbearer facts. Answer from the documented site context.

LINK FORMAT:
Whenever you reference a shieldbearerusa.com page, the FAQ, the contact page, the music page, a playlist, or any URL, output it as an HTML anchor tag, not plain text. Format: <a href="https://FULL_URL" target="_blank">Link Text</a>. Use descriptive link text (for example "FAQ", "Contact", "For AI Artists", "Celestial Shield playlist"), never raw URLs as the link text. Always include https:// in the href. Always include target="_blank". This is the one exception to the no-markdown rule: HTML anchor tags are required for links.
When a question maps to an FAQ topic on shieldbearerusa.com/faq.html, link directly to the FAQ page in your answer.

DEEP LINKING — SONG DOSSIERS:
The Song Meanings page has per-song anchors. When a user asks about the lyrics, meaning, scripture, or story behind a specific song, link directly to that song's anchor on shieldbearerusa.com/song-meanings.html using the slug below, not the parent page. Example: a question about Quake links to https://shieldbearerusa.com/song-meanings.html#quake with link text "Quake dossier" or "Quake lyrics and meaning".

Song slugs available on song-meanings.html:
Galilean: #galilean
Ruach: #ruach
Quake: #quake
The Man: #the-man
Over the Skies of Hell: #over-the-skies-of-hell
Unaliving the Giant: #unaliving-the-giant
Tidings of Comfort and Joy: #tidings-of-comfort-and-joy
Gut Punch: #gut-punch
Broken Helicopter: #broken-helicopter
He Found His Voice: #he-found-his-voice

If a song does not appear in this slug list (for example Sentinels, Celestial Shield, Ruler of the Storm, Worth It All, Nazarene, Amazing Grace, Prison Break), link to the parent page https://shieldbearerusa.com/song-meanings.html without an anchor.

THINGS SENTINELBOT DOES NOT KNOW:
- Sales figures, stream counts, revenue, merch units sold
- Personal details about Moncy beyond what is documented
- Future release dates
- Private business information
For these respond: "That is not in my system. Reach out directly at shieldbearerusa.com/contact.html"

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

GUITARS:
Brand: Ibanez. All guitars are real and performed live.

AMPS:
Mesa Boogie Mark V, Vox AC30, Fender Hot Rod Deluxe.

TONE SHAPING:
TONEX pedal, Neural DSP, Bogren Digital, Wampler pedals.

STUDIO:
FabFilter for mixing. EZdrummer for drums. Kontakt for strings.

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

PLAYLISTS:
Celestial Shield: open.spotify.com/playlist/1cvpC3tMLmbX3H2x8vPIvK
Ruach: open.spotify.com/playlist/2fExWWEwBAMMmZdzJmpcMz
The Armory: open.spotify.com/playlist/61qZoHGiLZ08EsvLGLOW85
Country and Gospel: open.spotify.com/playlist/2c5KpVJrnL2ngWYuZkL3oM
Worship, Amazing Grace, A Wretch Like Me (album): open.spotify.com/album/5uWD8iKku9IHK1dBBZni8R
Lanterns (album): open.spotify.com/album/5F8ABeyac6w59fnTvQYCNL
When someone asks for a playlist, recommend the one that fits and share the link.

FAQ POSITIONING:
Christ is the point. Not the tools. Talent is not the gospel. Method is not the gospel. Bot fraud is theft. Genuine AI music with real listeners is legitimate. No rulebook for AI disclosure has ever existed.
When recommending music or answering questions about songs, always end with a listening link.
Use: open.spotify.com/artist/21erHgXhVTuSDq5ZOy0XFz for the full catalog.
Use the YouTube channel for videos: youtube.com/@ShieldbearerUSA

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
  "who is shieldbearer": 'Solo Christian metal. Moncy Abraham. Real guitars, real conviction, Scripture at the center. Christ named plainly in every track. <a href="https://shieldbearerusa.com/about.html" target="_blank">About</a>',
  "what is shieldbearer": 'Solo Christian metal. Moncy Abraham. Real guitars, real conviction, Scripture at the center. Christ named plainly in every track. <a href="https://shieldbearerusa.com/about.html" target="_blank">About</a>',
  "who is this": "I'm SentinelBot for Shieldbearer. I answer questions about the music, the theology behind it, and the mission: proclaiming Christ clearly through heavy music. Shieldbearer is led by Moncy Abraham. Christian metal, real guitars, unambiguous faith. What do you want to know?",
  "what is the top song": 'Celestial Shield and Ruler of the Storm have the highest YouTube views. Galilean is the foundation. Cosmos and incarnation, John 1:14. Start there. Full catalog: <a href="https://open.spotify.com/artist/21erHgXhVTuSDq5ZOy0XFz" target="_blank">Spotify</a>',
  "what is the best song": 'Celestial Shield and Ruler of the Storm have the highest YouTube views. Galilean is the foundation. Cosmos and incarnation, John 1:14. Start there. Full catalog: <a href="https://open.spotify.com/artist/21erHgXhVTuSDq5ZOy0XFz" target="_blank">Spotify</a>',
  "what is the most popular song": 'Celestial Shield and Ruler of the Storm have the highest YouTube views. Galilean is the foundation. Cosmos and incarnation, John 1:14. Start there. Full catalog: <a href="https://open.spotify.com/artist/21erHgXhVTuSDq5ZOy0XFz" target="_blank">Spotify</a>',
  "what guitar does he play": 'Ibanez. All real, all performed. <a href="https://shieldbearerusa.com/process.html" target="_blank">Process</a>',
  "how many tshirts sold": 'That is not in my system. Reach out directly at <a href="https://shieldbearerusa.com/contact.html" target="_blank">Contact</a>',
  "are you stealing musicians jobs": 'No. Shieldbearer is one man\'s tool for one mission: Christ proclaimed through heavy music.<br><br>Read the full answer at <a href="https://shieldbearerusa.com/for-ai-artists.html" target="_blank">For AI Artists</a> and <a href="https://shieldbearerusa.com/no-rulebook.html" target="_blank">No Rulebook</a>.',
  "what is galilean about": "Galilean is cosmos and incarnation. The word carries two worlds: Galileo's moons of Jupiter, and Galilee where Jesus walked. Same word. Different everything. That tension is the song. John 1:14. The Word became flesh. The One everything orbits around entered history. Infinite into finite. Creator into creation. Galilean is about that collision.",
  "are the guitars real": 'Yes. Every one of them. Mesa Mark V, Vox AC30, Fender Hot Rod. TONEX and Neural DSP shape the tone. The performance is real. <a href="https://shieldbearerusa.com/process.html" target="_blank">Process</a>',
  "who owns shieldbearer": 'Moncy Abraham. Guitarist, lyricist, composer, and audio engineer. Shieldbearer is his solo Christian metal project. <a href="https://shieldbearerusa.com/about.html" target="_blank">About</a>',
  "why use ai": 'Because the message matters more than the method. AI is a tool. Same as every other tool in the signal chain. Christ is the point. <a href="https://shieldbearerusa.com/faq.html" target="_blank">FAQ</a>',
  "what genre": "Christian metal. Heavy music with Christ at the center. Scripture first. No compromise.",
  "where can i listen": 'Spotify, Apple Music, YouTube, everywhere. Full catalog: <a href="https://shieldbearerusa.com/music.html" target="_blank">Music</a> or <a href="https://open.spotify.com/artist/21erHgXhVTuSDq5ZOy0XFz" target="_blank">Spotify</a>',
  "where can i buy merch": 'Official Shieldbearer merch: <a href="https://shop.shieldbearerusa.com" target="_blank">shop.shieldbearerusa.com</a>',
  "who is moncy": 'Moncy Abraham. Guitarist, lyricist, composer. Former lead guitarist for WhitenoiZ. India\'s first Christian metal band. Played in Scarlet Robe, opened for John Schlitt in Bangalore. 25 years in. <a href="https://shieldbearerusa.com/story.html" target="_blank">Story</a>',
  "is ai cheating": 'Cheating at what exactly? There is no governing body for Christian metal. No certification required to carry the name of Jesus in a song. <a href="https://shieldbearerusa.com/faq.html" target="_blank">FAQ</a>',
  "what is ai": 'A tool. Same as a guitar, a reverb pedal, or a DAW. What matters is what you build with it and why. Shieldbearer uses it to serve the message, not replace it. <a href="https://shieldbearerusa.com/ai-and-creativity.html" target="_blank">AI and Creativity</a>'
};

const recentQuestions = new Map();

function normalizeQuestion(q) {
  return (q || "").toLowerCase().trim();
}

function findCachedAnswer(question) {
  if (!question) return null;

  if (question === "who is shieldbearer" || question === "what is shieldbearer")
    return CACHED_ANSWERS["who is shieldbearer"];

  if (question === "who is this")
    return CACHED_ANSWERS["who is this"];

  if ((question.includes("top") || question.includes("best") || question.includes("popular") || question.includes("most streamed")) && (question.includes("song") || question.includes("track")))
    return CACHED_ANSWERS["what is the top song"];

  if (question.includes("guitar") && (question.includes("brand") || question.includes("what") || question.includes("play") || question.includes("which")))
    return CACHED_ANSWERS["what guitar does he play"];

  if ((question.includes("how many") || question.includes("sold") || question.includes("sales") || question.includes("revenue") || question.includes("units")) &&
      (question.includes("shirt") || question.includes("shirts") || question.includes("tshirt") || question.includes("tshirts") || question.includes("merch")))
    return CACHED_ANSWERS["how many tshirts sold"];

  if (question === "are you stealing musicians jobs" || question === "are you stealing musicians job")
    return CACHED_ANSWERS["are you stealing musicians jobs"];

  if (question === "what genre" || question === "what genre is shieldbearer" || question === "what kind of music is this")
    return CACHED_ANSWERS["what genre"];

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

function isUsableAnswer(answer) {
  if (typeof answer !== "string") return false;
  const text = answer.trim();
  if (!text) return false;
  if (text.length < 8) return false;

  const weakPatterns = [
    "signal lost",
    "i don't have that information",
    "i do not have that information",
    "i'm not sure",
    "i am not sure",
    "cannot answer",
    "i can't answer",
    "i can’t answer",
    "i don't know",
    "i do not know"
  ];

  const lower = text.toLowerCase();
  return !weakPatterns.some((pattern) => lower.includes(pattern));
}

function markRepeat(question) {
  if (!question) return false;

  const now = Date.now();
  const lastSeen = recentQuestions.get(question);
  recentQuestions.set(question, now);

  return Boolean(lastSeen && (now - lastSeen) < 10 * 60 * 1000);
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
  const sourceIp =
    event?.requestContext?.http?.sourceIp ||
    event?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
    "unknown";
  return {
    requestId: event?.requestContext?.requestId || null,
    sourceIp,
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
  repeat,
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
    logType: "sentinelbot",
    requestId: requestId || null,
    sourceIp: sourceIp || null,
    userAgent: userAgent || null,
    referer: referer || null,
    origin: origin || null,
    repeat: Boolean(repeat),
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
    throw err;
  }
}

async function incrementLogCounter() {
  await dynamo.send(new UpdateCommand({
    TableName: process.env.DYNAMO_TABLE,
    Key: {
      id: "meta:log-count"
    },
    UpdateExpression: "ADD totalLogs :inc",
    ExpressionAttributeValues: {
      ":inc": 1
    }
  }));
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

exports.handler = async (event) => {
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
    const question = normalizeQuestion(requestBody.question).substring(0, 400);
    const history = requestBody.history || [];
    const page = requestBody.page || "unknown";
    const historyLength = Array.isArray(history) ? history.length : 0;
    const repeat = markRepeat(question);

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
        errorMessage: "No question provided",
        repeat
      }));

      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "No question provided" })
      };
    }

    const cached = findCachedAnswer(question);
    let answer = cached;
    let status = cached ? "success" : "success";
    let source = cached ? "app-cache-hit" : "anthropic";
    let errorMessage = null;

    if (!answer) {
      try {
        answer = await callAnthropic(question, history);
      } catch (err) {
        answer = "Signal lost. Try again.";
        status = "error";
        source = "error";
        errorMessage = err.message;
      }
    }

    if (!isUsableAnswer(answer)) {
      answer = "Signal lost. Try again.";
      if (status !== "error") {
        status = "fallback";
        source = "anthropic";
      }
      errorMessage = errorMessage || null;
    }

    const responseTimeMs = Date.now() - startedAt;

    await writeLogItem(buildLogItem({
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: requestTimestamp,
      ...requestMetadata,
      repeat,
      question,
      answer,
      page,
      source,
      historyLength,
      responseTimeMs,
      status,
      errorMessage
    }));
    await incrementLogCounter();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ answer })
    };

  } catch (err) {
    const question = normalizeQuestion(requestBody.question).substring(0, 400);
    const history = requestBody.history || [];
    const page = requestBody.page || "unknown";
    const historyLength = Array.isArray(history) ? history.length : 0;
    const responseTimeMs = Date.now() - startedAt;
    const repeat = markRepeat(question);

    try {
      await writeLogItem(buildLogItem({
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        timestamp: requestTimestamp,
        ...requestMetadata,
        repeat,
        question,
        answer: "Signal lost. Try again.",
        page,
        source: "error",
        historyLength,
        responseTimeMs,
        status: "error",
        errorMessage: err.message
      }));
      await incrementLogCounter();
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
