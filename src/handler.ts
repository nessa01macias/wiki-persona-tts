import type { AppHandler } from "@sauna/apps-runtime";

const PERSONAS: Record<string, string> = {
  announcer:
    "You are a vintage radio announcer delivering history as live play-by-play. Crisp, urgent, vivid verbs, present tense. Treat every fact like a developing scene. You address the listener directly. Output ONLY spoken words — no stage directions, no headings, no markdown.",
  socialite:
    "You are a 1940s gossip columnist reading a society page aloud. Warm, conspiratorial, dramatic pauses, plenty of 'darling' and 'oh' interjections. The facts are delivered like hot tea. Output ONLY spoken words — no stage directions, no headings, no markdown.",
  philosopher:
    "You are a contemplative philosopher who turns every topic into a series of gentle questions. Slow, reflective cadence, soft rhetorical questions, woven facts. Output ONLY spoken words — no stage directions, no headings, no markdown.",
};

const PERSONA_VOICES: Record<string, string> = {
  announcer: "onwK4e9ZLuTAKqWW03F9",   // Daniel — Steady Broadcaster (play-by-play)
  socialite: "cgSgspJ2msm6clMCkdW9",   // Jessica — Playful, Bright, Warm (gossip column)
  philosopher: "pqHfZKP75CvOlQylNhV4", // Bill — Wise, Mature, Balanced (contemplative)
};
const OPENAI_MODEL = "gpt-4o-mini";
const ELEVENLABS_MODEL = "eleven_turbo_v2_5";
const USER_AGENT = "SaunaWikiPersonaTTS/1.0";
const WORDS_PER_MINUTE = 150;
const ALLOWED_MINUTES = [5, 8, 10] as const;
type Minutes = (typeof ALLOWED_MINUTES)[number];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function base64FromArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function fetchFullArticleText(title: string): Promise<string> {
  const params = new URLSearchParams({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    format: "json",
    redirects: "1",
    titles: title,
  });
  const res = await fetch(
    `https://en.wikipedia.org/w/api.php?${params.toString()}`,
    { headers: { accept: "application/json", "user-agent": USER_AGENT } },
  );
  if (!res.ok) {
    throw Object.assign(new Error(`Wikipedia fetch failed (${res.status})`), {
      status: res.status,
    });
  }
  const data = (await res.json()) as {
    query?: { pages?: Record<string, { extract?: string; title?: string }> };
  };
  const pages = data.query?.pages ?? {};
  const first = Object.values(pages)[0];
  const text = (first?.extract ?? "").trim();
  if (!text) {
    throw Object.assign(new Error(`No article text for "${title}"`), {
      status: 404,
    });
  }
  // Trim to a safe size — feed the LLM ~6000 chars of source material.
  return text.length > 6000 ? text.slice(0, 6000) : text;
}

async function handleGenerate(request: Request): Promise<Response> {
  let body: { persona?: string; minutes?: number; title?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const { persona, minutes, title } = body;
  if (!persona || !PERSONAS[persona]) {
    return json({ error: "Unknown persona" }, 400);
  }
  if (
    typeof minutes !== "number" ||
    !ALLOWED_MINUTES.includes(minutes as Minutes)
  ) {
    return json(
      { error: "minutes must be one of 5, 8, 10" },
      400,
    );
  }
  const cleanTitle = (title ?? "").trim();
  if (!cleanTitle) {
    return json({ error: "Missing title" }, 400);
  }

  // 1) full Wikipedia text
  let articleText: string;
  try {
    articleText = await fetchFullArticleText(cleanTitle);
  } catch (e: unknown) {
    const err = e as { message?: string; status?: number };
    console.error("wikipedia", err.status, err.message);
    return json({ error: err.message ?? "Wikipedia lookup failed" }, err.status ?? 502);
  }

  // 2) OpenAI script
  const targetWords = minutes * WORDS_PER_MINUTE;
  const llmRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: "system",
          content:
            `${PERSONAS[persona]}\n\nYou are writing a spoken monologue for a ` +
            `${minutes}-minute radio edition. Target about ${targetWords} words ` +
            `(roughly ${WORDS_PER_MINUTE} words per minute read aloud). Stay faithful ` +
            `to the source material but reorganize it for spoken delivery. ` +
            `Output ONLY the spoken words — no stage directions, no headings, no markdown.`,
        },
        {
          role: "user",
          content: `Source text from the Wikipedia article "${cleanTitle}":\n\n${articleText}`,
        },
      ],
    }),
  });
  if (!llmRes.ok) {
    console.error("openai", llmRes.status, await llmRes.text());
    return json({ error: "Script generation failed" }, 502);
  }
  const llmData = (await llmRes.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const script = (llmData.choices?.[0]?.message?.content ?? "").trim();
  if (!script) {
    return json({ error: "Empty script from model" }, 502);
  }

  // 3) ElevenLabs TTS — chunk the script if it exceeds ElevenLabs' per-request cap.
  const MAX_CHARS = 4500;
  const chunks: string[] = [];
  if (script.length <= MAX_CHARS) {
    chunks.push(script);
  } else {
    let rest = script;
    while (rest.length > MAX_CHARS) {
      let cut = rest.lastIndexOf(". ", MAX_CHARS);
      if (cut < MAX_CHARS / 2) cut = rest.lastIndexOf(" ", MAX_CHARS);
      if (cut <= 0) cut = MAX_CHARS;
      chunks.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) chunks.push(rest);
  }

  const audioBuffers: ArrayBuffer[] = [];
  for (const chunk of chunks) {
    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${PERSONA_VOICES[persona]}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: chunk, model_id: ELEVENLABS_MODEL }),
      },
    );
    if (!ttsRes.ok) {
      console.error("elevenlabs", ttsRes.status, await ttsRes.text());
      return json({ error: "Text-to-speech failed" }, 502);
    }
    audioBuffers.push(await ttsRes.arrayBuffer());
  }

  // 4) concatenate MP3 chunks
  const total = audioBuffers.reduce((n, b) => n + b.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const buf of audioBuffers) {
    merged.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  const audioBase64 = base64FromArrayBuffer(merged.buffer);

  return json({
    script,
    persona,
    minutes,
    title: cleanTitle,
    chunks: chunks.length,
    audio: `data:audio/mpeg;base64,${audioBase64}`,
  });
}

// Curated pool of profiles for the dice roll. Stored as wiki slugs
// (the final path segment of the Wikipedia URL) so they can be turned
// into REST/API lookups by appending them to the Wikipedia base.
const PROFILE_POOL: readonly string[] = [
  "Kenneth_McDuff",
  "William_Lewis_Reece",
  "Elmer_Wayne_Henley",
  "Billy_Chemirmir",
  "Robert_Ben_Rhoades",
  "John_Edward_Robinson",
  "Luka_Magnotta",
  "Dennis_Nilsen",
  "Joseph_James_DeAngelo",
  "Jack_Unterweger",
];

async function handleRandom(): Promise<Response> {
  // Pick a curated slug and fetch its Wikipedia summary server-side. Returning
  // the full summary (not just a title) means the dice flow doesn't depend on
  // a follow-up client-side fetch — which can be flaky in browsers.
  const slug = PROFILE_POOL[Math.floor(Math.random() * PROFILE_POOL.length)];
  try {
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`,
      { headers: { accept: "application/json", "user-agent": USER_AGENT } },
    );
    if (!res.ok) {
      return json({ error: `Wikipedia fetch failed for "${slug}" (${res.status})` }, 502);
    }
    const summary = (await res.json()) as {
      title?: string;
      extract?: string;
      description?: string;
      content_urls?: { desktop?: { page?: string } };
    };
    return json({
      title: summary.title ?? slug.replace(/_/g, " "),
      slug,
      extract: summary.extract ?? "",
      description: summary.description ?? "wikipedia article",
      content_urls: summary.content_urls ?? { desktop: { page: `https://en.wikipedia.org/wiki/${slug}` } },
      pool: PROFILE_POOL.length,
    });
  } catch (e) {
    return json({ error: (e as Error).message ?? "random lookup failed" }, 502);
  }
}

export default {
  async fetch(request, _env, _ctx) {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/generate") {
      try { return await handleGenerate(request); }
      catch (e) {
        console.error("generate crash", e);
        return json({ error: "Internal error" }, 500);
      }
    }
    if (request.method === "GET" && pathname === "/random") {
      try { return await handleRandom(); }
      catch (e) {
        console.error("random crash", e);
        return json({ error: "Internal error" }, 500);
      }
    }
    return json({ error: "Not found" }, 404);
  },
} satisfies AppHandler;
