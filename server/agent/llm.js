import Anthropic from "@anthropic-ai/sdk";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

const SYSTEM = `You are the voice of a smart mirror. Pick the single tool that answers the user's request and call it. If no tool fits, reply with one short spoken sentence. Never write more than one sentence of spoken text.`;

// ---- local tier: Ollama (OpenAI-compatible endpoint) ---------------------

export async function localAvailable() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(600),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function localToolCall({ model, text, tools }) {
  const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
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
    }),
    signal: AbortSignal.timeout(20000),
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

export async function cloudToolCall({ model, text, tools, context }) {
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
    messages: [{ role: "user", content: text }],
  });

  const toolUse = msg.content.find((b) => b.type === "tool_use");
  if (toolUse) return { tool: toolUse.name, args: toolUse.input, confident: true };

  const textBlock = msg.content.find((b) => b.type === "text");
  return { text: (textBlock?.text ?? "").trim(), confident: true };
}

function safeParse(s) {
  try {
    return typeof s === "string" ? JSON.parse(s) : (s ?? {});
  } catch {
    return {};
  }
}
