import Anthropic from "@anthropic-ai/sdk";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const LOCAL_ROUTE_TIMEOUT_MS = Number(process.env.LOCAL_ROUTE_TIMEOUT_MS || 10_000);

const SYSTEM = `You are the voice of a smart mirror. Pick the single tool that answers the user's request and call it. If no tool fits, reply with one short spoken sentence. Never write more than one sentence of spoken text.`;

// ---- local tier: Ollama (OpenAI-compatible endpoint) ---------------------

// Probing Ollama costs a round trip (up to the 1.5s timeout when it's down) and
// used to happen on every tier-1 route and again inside recall. Cache the
// answer: long when it's up, short when it's down so starting Ollama is noticed.
const PROBE_TTL_UP_MS = 30_000;
const PROBE_TTL_DOWN_MS = 5_000;
let probe = { at: 0, ok: false, pending: null };

export async function localAvailable() {
  const ttl = probe.ok ? PROBE_TTL_UP_MS : PROBE_TTL_DOWN_MS;
  if (Date.now() - probe.at < ttl) return probe.ok;
  probe.pending ??= (async () => {
    let ok = false;
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, {
        signal: AbortSignal.timeout(1500),
      });
      ok = r.ok;
    } catch {
      ok = false;
    }
    probe = { at: Date.now(), ok, pending: null };
    return ok;
  })();
  return probe.pending;
}

/** Forget the cached probe — call when a local request fails outright. */
export function markLocalDown() {
  probe = { at: Date.now(), ok: false, pending: null };
}

/** Trim a rolling transcript to the last few turns, starting on a user turn. */
function trimHistory(history = [], max = 6) {
  let h = history
    .filter(
      (m) => m?.content && (m.role === "user" || m.role === "assistant"),
    )
    .slice(-max);
  while (h.length && h[0].role !== "user") h = h.slice(1);
  return h;
}

export async function localToolCall({
  model,
  text,
  tools,
  history = [],
  timeoutMs = LOCAL_ROUTE_TIMEOUT_MS,
}) {
  const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        ...trimHistory(history),
        { role: "user", content: text },
      ],
      tools: tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      })),
      temperature: 0,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
      keep_alive: "30m", // keep the model resident — a cold reload + the full
      // tool schema can blow past the timeout on the first query after idle
    }),
    // Warm routing measured ≤2.2s at worst; past this the user is hearing dead
    // air. Falls through to the cloud tier (if configured) or a polite dead end.
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);

  const data = await res.json();
  const msg = data.choices?.[0]?.message ?? {};
  const call = msg.tool_calls?.[0];
  if (call) {
    return {
      tool: call.function.name,
      args: safeParse(call.function.arguments),
      confident: true,
    };
  }
  const content = (msg.content ?? "").trim();
  return { text: content, confident: content.length > 0 };
}

// ---- cloud tier: Claude -------------------------------------------------

export function cloudConfigured() {
  return Boolean(
    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
  );
}

let _client;
function client() {
  return (_client ??= new Anthropic());
}

export async function cloudToolCall({ model, text, tools, context, history = [] }) {
  const msg = await client().messages.create({
    model,
    max_tokens: 1024,
    // Router work is simple — keep effort (and latency/cost) low. The claude-api
    // skill recommends low effort over disabling thinking on Opus-class models.
    output_config: { effort: "low" },
    system: context ? `${SYSTEM}\n\nContext:\n${context}` : SYSTEM,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    })),
    messages: [
      ...trimHistory(history).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: text },
    ],
  });

  const toolUse = msg.content.find((b) => b.type === "tool_use");
  if (toolUse) return { tool: toolUse.name, args: toolUse.input, confident: true };

  const textBlock = msg.content.find((b) => b.type === "text");
  return { text: (textBlock?.text ?? "").trim(), confident: true };
}

// ---- plain chat (used by the memory synthesizer) ----------------------

export async function localChat({ model, system, prompt, timeoutMs = 25000 }) {
  const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
      temperature: 0,
      stream: false,
      // qwen3 and other hybrid-reasoning models: skip the <think> pass so recall
      // stays snappy. Ignored by models that don't support it.
      chat_template_kwargs: { enable_thinking: false },
      keep_alive: "30m",
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ollama chat ${res.status}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

export async function cloudChat({ model, system, prompt }) {
  const msg = await client().messages.create({
    model,
    max_tokens: 400,
    output_config: { effort: "low" },
    system,
    messages: [{ role: "user", content: prompt }],
  });
  return (msg.content.find((b) => b.type === "text")?.text ?? "").trim();
}

function safeParse(s) {
  try {
    return typeof s === "string" ? JSON.parse(s) : (s ?? {});
  } catch {
    return {};
  }
}
