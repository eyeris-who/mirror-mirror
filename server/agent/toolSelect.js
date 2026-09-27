import { embed, embedBatch, available } from "../memory/embed.js";

/**
 * Pick the tools worth showing the local model for one request.
 *
 * A 3B model given all ~23 tool schemas took 5s at p50 and 19s at p90 to
 * route (data/metrics.jsonl), and prompt size is most of that. Tool
 * descriptions are embedded once with the same local model memory uses; each
 * request sends only the closest few. The previous user turn is included in
 * the lookup so a follow-up like "and this weekend?" still finds get_weather.
 *
 * Falls back to every tool if embeddings aren't available.
 */

const TOP_N = Number(process.env.ROUTER_TOOL_TOP_N || 6);

let cache = null; // { key, vectors: number[][] }

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

const toolText = (t) => `${t.name.replace(/_/g, " ")}: ${t.description}`;

async function toolVectors(tools) {
  const key = tools.map((t) => t.name).join(",");
  if (cache?.key !== key) {
    cache = { key, vectors: await embedBatch(tools.map(toolText)) };
  }
  return cache.vectors;
}

/**
 * @returns {Promise<{ tools: object[], scores?: object }>}
 */
export async function selectTools(text, tools, { history = [], topN = TOP_N } = {}) {
  if (tools.length <= topN || !(await available())) return { tools };
  try {
    const lastUser = [...history].reverse().find((m) => m.role === "user")?.content;
    const query = lastUser ? `${lastUser}\n${text}` : text;
    const [qv, vectors] = await Promise.all([embed(query), toolVectors(tools)]);
    const ranked = tools
      .map((t, i) => ({ tool: t, score: cosine(qv, vectors[i]) }))
      .sort((a, b) => b.score - a.score);
    return {
      tools: ranked.slice(0, topN).map((r) => r.tool),
      scores: Object.fromEntries(ranked.map((r) => [r.tool.name, Number(r.score.toFixed(3))])),
    };
  } catch {
    return { tools };
  }
}
