import { search } from "./search.js";
import { available } from "./embed.js";
import { getSettings } from "../settings.js";
import * as llm from "../agent/llm.js";
import { logMetric } from "../agent/metrics.js";

export class MemoryNotReady extends Error {
  name = "MemoryNotReady";
}

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const SYSTEM =
  "You are the smart mirror's memory. Answer ONLY from the dated excerpts of the " +
  "user's own past messages and notes below. When they conflict, trust the most " +
  "recent and mention that things changed. If the excerpts don't answer the " +
  "question, say you don't have anything about that. Reply in one or two short " +
  "sentences, spoken aloud — no lists, no preamble.";

function buildPrompt(query, hits) {
  const lines = hits
    .map((h) => `[${dateFmt.format(new Date(h.ts))}] ${h.text}`)
    .join("\n");
  return `${lines}\n\nQuestion: ${query}`;
}

/**
 * Retrieve + synthesize. Synthesis uses the local model first (privacy), and
 * only falls back to the cloud when local is unavailable — and even then only
 * the retrieved snippets are sent, never the whole corpus.
 */
export async function recall(query) {
  const t0 = Date.now();
  if (!(await available())) throw new MemoryNotReady("embed model not running");

  const { assistant, memory } = await getSettings();
  const { hits, window, timings } = await search(query, {
    k: memory?.topK ?? 6,
  });

  if (!hits.length) {
    logMetric({ kind: "recall", query, nHits: 0, ...timings });
    return {
      speak: "I don't have anything about that in memory yet.",
      data: { hits: [] },
    };
  }

  const prompt = buildPrompt(query, hits);
  const tSynth = Date.now();
  let answer = "";
  let synthTier = "none";

  try {
    if (await llm.localAvailable()) {
      answer = await llm.localChat({
        model: assistant.models.local,
        system: SYSTEM,
        prompt,
      });
      synthTier = "local";
    }
  } catch {
    /* fall through */
  }

  if (!answer && !memory?.localOnly && llm.cloudConfigured()) {
    try {
      answer = await llm.cloudChat({
        model: assistant.models.cloud,
        system: SYSTEM,
        prompt,
      });
      synthTier = "cloud";
    } catch {
      /* fall through */
    }
  }

  if (!answer) {
    // no LLM available — read back the single best excerpt
    answer = `From ${dateFmt.format(new Date(hits[0].ts))}: ${hits[0].text}`;
    synthTier = "raw";
  }

  logMetric({
    kind: "recall",
    query,
    nHits: hits.length,
    topScore: Number(hits[0].score.toFixed(3)),
    window: window ? "yes" : "no",
    synthTier,
    ...timings,
    synthMs: Date.now() - tSynth,
    totalMs: Date.now() - t0,
  });

  return { speak: answer, data: { hits, synthTier } };
}
