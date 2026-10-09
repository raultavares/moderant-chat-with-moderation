/**
 * moderant moderation Worker.
 *
 * Pipeline:
 *   M3a  wordlist         deterministic LDNOOBW match. Instant block.
 *                         severity = "mild" if all matched terms are in
 *                         MILD_TERMS; otherwise "severe".
 *   M3a2 safe-shortcuts   exact-match allowlist for gaming tokens. Instant pass.
 *   M3b  Clef big         gaming-aware prompt via AI Gateway. Threshold is
 *                         request.threshold || CLEF_THRESHOLD. Watched users
 *                         get a stricter threshold passed in.
 *   M3c  Llama Guard 3 8B fallback if Clef errors. Via same AI Gateway.
 *        fail-closed       if both AI layers fail, block the message.
 *
 * POST /check { text, lang?, threshold? } ->
 *   { decision, layer, severity?, matched?, categories?, score? }
 */

type Decision = "clean" | "block";
type Layer = "wordlist" | "clef" | "guardrails" | "unavailable";
type Severity = "mild" | "severe";

interface CheckResult {
  decision: Decision;
  layer: Layer;
  severity?: Severity;
  matched?: string[];
  categories?: string[];
  score?: number;
}

interface CheckBody {
  text?: unknown;
  lang?: unknown;
  threshold?: unknown;
}

const SAFE_SHORTCUTS = new Set<string>([
  "gg", "wp", "ggwp", "gg wp", "gl", "glhf", "hf", "nt", "nice", "noice",
  "ok", "k", "kk", "okay", "ty", "thx", "thanks", "np", "yw",
  "yes", "no", "y", "n", "yep", "nope", "sure", "maybe",
  "hi", "hello", "hey", "yo", "sup", "wassup", "bye", "cya", "gn", "gnight",
  "lol", "lmao", "rofl", "omg", "wow", "nice shot", "well played", "good game",
  "brb", "afk", "bb", "clutch", "ez", "same", "agreed", "true", "fr", "tru",
  "!", "?", "!!", "??", "...", ".",
]);

const CLEF_INSTRUCTIONS =
  "TASK: classify a gaming chat message as unsafe or safe.\n\n" +
  "ALWAYS SAFE:\n" +
  "- In-game violence verbs (kill, destroy, wreck, frag, headshot, nuke, bomb, snipe, crush, dominate, camp, rush, trap) when aimed at opponents, teammates, bots, enemies, 'them', 'him', 'you', 'us', 'next round', 'this match'.\n" +
  "- Trash talk: suck, ez, pathetic, trash, bots, noobs, cope, ratio, skill issue, washed, mid, dogshit.\n" +
  "- 'your mom' / 'ur mom' jokes without slurs.\n" +
  "- Mild profanity as emphasis: fuck, shit, damn, hell, bitch, bastard, mofo, motherfucker (when NOT a slur against an identity group).\n" +
  "- Gaming shorthand: gg, wp, glhf, hf, nt, brb, afk, rip, ff, ggwp.\n" +
  "- Greetings, strategy, emotes expressed as text.\n\n" +
  "ALWAYS UNSAFE:\n" +
  "- Slurs targeting race, ethnicity, religion, sexuality, gender identity, or disability (nigger, faggot, retard, kike, chink, spic, tranny, etc.) in any context.\n" +
  "- Self-harm or suicide directed at a person: 'kys', 'kill yourself', 'end it all', 'go die irl'.\n" +
  "- Real-world threats: 'I know where you live', 'I'll find your house', doxxing, addresses, phone numbers.\n" +
  "- Sexual content involving a real person or any content involving minors.\n" +
  "- Instructions for real-world weapons, bombs, or violence.\n\n" +
  "QUESTION: is this message unsafe?";

const wordlistCache: Map<string, Promise<WordlistIndex>> = new Map();
let mildTermsCache: Set<string> | null = null;

interface WordlistIndex {
  terms: string[];
  regex: RegExp;
}

function buildIndex(terms: string[]): WordlistIndex {
  const escaped = terms
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = `(?:^|[^a-z0-9])(${escaped.join("|")})(?=$|[^a-z0-9])`;
  return { terms, regex: new RegExp(pattern, "gi") };
}

async function loadWordlist(env: Env, lang: string): Promise<WordlistIndex> {
  let cached = wordlistCache.get(lang);
  if (cached) return cached;
  cached = (async () => {
    const raw = await env.WORDLIST.get(lang);
    if (!raw) return buildIndex([]);
    const terms = JSON.parse(raw) as string[];
    return buildIndex(terms);
  })();
  wordlistCache.set(lang, cached);
  return cached;
}

function loadMildTerms(env: Env): Set<string> {
  if (mildTermsCache) return mildTermsCache;
  try {
    const arr = JSON.parse(env.MILD_TERMS || "[]") as string[];
    mildTermsCache = new Set(arr.map((t) => t.trim().toLowerCase()));
  } catch {
    mildTermsCache = new Set();
  }
  return mildTermsCache;
}

function checkWordlist(index: WordlistIndex, text: string): string[] {
  const matched = new Set<string>();
  index.regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = index.regex.exec(text)) !== null) {
    matched.add(m[1]!.toLowerCase());
    if (matched.size >= 5) break;
  }
  return [...matched];
}

/** Classify a wordlist hit as "mild" (all matched terms in MILD_TERMS) or "severe". */
function classifySeverity(matched: string[], mild: Set<string>): Severity {
  if (matched.length === 0) return "severe";
  for (const term of matched) {
    if (!mild.has(term)) return "severe";
  }
  return "mild";
}

/**
 * M3b: Clef big via AI Gateway. Noul question returns probability [0,1]
 * that message is unsafe. Block when prob >= threshold.
 */
async function checkClef(env: Env, text: string, threshold: number): Promise<CheckResult> {
  const result = (await env.AI.run(
    "@cf/cloudflare/clef" as never,
    {
      model: "clef",
      state: text,
      questions: {
        unsafe: { type: "noul", instructions: CLEF_INSTRUCTIONS },
      },
    } as never,
    { gateway: { id: env.AI_GATEWAY_ID } },
  )) as { answers?: { unsafe?: { type: string; noul: number } } };

  const prob = result.answers?.unsafe?.noul;
  if (typeof prob !== "number") {
    throw new Error("clef returned no probability");
  }
  const decision: Decision = prob >= threshold ? "block" : "clean";
  return { decision, layer: "clef", score: prob };
}

/**
 * M3c: Llama Guard 3 8B via AI Gateway. Fallback if Clef errors.
 * Parses "safe" / "unsafe\nS1,S2,..." output.
 */
async function checkLlamaGuard(env: Env, text: string): Promise<CheckResult> {
  const result = (await env.AI.run(
    "@cf/meta/llama-guard-3-8b" as never,
    { messages: [{ role: "user", content: text }] } as never,
    { gateway: { id: env.AI_GATEWAY_ID } },
  )) as { response?: string };

  const response = (result.response ?? "").trim();
  if (response.toLowerCase().startsWith("unsafe")) {
    const lines = response.split(/\r?\n/);
    const cats = (lines[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return { decision: "block", layer: "guardrails", categories: cats };
  }
  return { decision: "clean", layer: "guardrails" };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz" && request.method === "GET") {
      return Response.json({
        ok: true,
        service: "moderant-moderation",
        version: "0.2.0",
        pipeline: "wordlist(severity) -> shortcuts -> clef -> llama-guard -> fail-closed",
      });
    }

    if (url.pathname === "/check" && request.method === "POST") {
      return handleCheck(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleCheck(request: Request, env: Env): Promise<Response> {
  let body: CheckBody;
  try {
    body = (await request.json()) as CheckBody;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text : null;
  if (!text) {
    return Response.json({ error: "missing_text" }, { status: 400 });
  }
  const lang = typeof body.lang === "string" ? body.lang : "en";
  const defaultThreshold = Number.parseFloat(env.CLEF_THRESHOLD ?? "0.3");
  const threshold =
    typeof body.threshold === "number" && body.threshold > 0 && body.threshold <= 1
      ? body.threshold
      : defaultThreshold;

  // M3a: wordlist
  const index = await loadWordlist(env, lang);
  const matched = checkWordlist(index, text);
  if (matched.length > 0) {
    const mild = loadMildTerms(env);
    const severity = classifySeverity(matched, mild);
    return Response.json({
      decision: "block",
      layer: "wordlist",
      severity,
      matched,
    } satisfies CheckResult);
  }

  // M3a2: safe-shortcuts
  const normalized = text.trim().toLowerCase();
  if (SAFE_SHORTCUTS.has(normalized)) {
    return Response.json({ decision: "clean", layer: "wordlist" } satisfies CheckResult);
  }

  // M3b: Clef big (primary)
  try {
    const result = await checkClef(env, text, threshold);
    return Response.json(result);
  } catch (err) {
    console.warn("M3b (clef) failed, trying M3c:", (err as Error).message);
  }

  // M3c: Llama Guard (fallback)
  try {
    const result = await checkLlamaGuard(env, text);
    return Response.json(result);
  } catch (err) {
    console.error("M3c (llama-guard) failed, failing closed:", (err as Error).message);
  }

  // Fail-closed: both AI layers errored.
  return Response.json({ decision: "block", layer: "unavailable" } satisfies CheckResult);
}
