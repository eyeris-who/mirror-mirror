import { search, followUps } from "./search.js";
import { available } from "./embed.js";
import { getSettings } from "../settings.js";
import * as llm from "../agent/llm.js";
import { logMetric, textFields } from "../agent/metrics.js";

export class MemoryNotReady extends Error {
  name = "MemoryNotReady";
}

const DAY = 864e5;
const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const todayFmt = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

// Local synthesis past this is dead air — fall back to reading the best
// excerpt. (Measured p90 was 25s with the old 25s timeout.)
const SYNTH_TIMEOUT_MS = Number(process.env.MEMORY_SYNTH_TIMEOUT_MS || 12_000);
// Excerpts whose cosine is more than this below the closest one are dropped
// before synthesis — a small model otherwise works them into the answer
// ("…and you also parked on level 3"). Cosine, not the recency-weighted score:
// recency ranks, but it shouldn't decide relevance (a 24-day-old "renew my
// passport" had the 2nd-best cosine and the worst score).
const RELEVANCE_MARGIN = Number(process.env.MEMORY_RELEVANCE_MARGIN || 0.1);

// ---- prompts -----------------------------------------------------------
// v1 is the original, kept so `eval:memory -- --prompt v1` can measure the
// difference. v2 is what the mirror uses.

const SYSTEM_V1 =
  "You are the smart mirror's memory. Answer ONLY from the dated excerpts of the " +
  "user's own past messages and notes below. When they conflict, trust the most " +
  "recent and mention that things changed. If the excerpts don't answer the " +
  "question, say you don't have anything about that. Reply in one or two short " +
  "sentences, spoken aloud — no lists, no preamble.";

function promptV1(query, hits) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const lines = hits.map((h) => `[${fmt.format(new Date(h.ts))}] ${h.text}`).join("\n");
  return `${lines}\n\nQuestion: ${query}`;
}

// The worked examples deliberately use topics that are NOT in eval/corpus.jsonl
// (a library book, car insurance, a dentist) so the eval still measures
// generalisation, not recall of the examples.
const SYSTEM_V2 = [
  "You are the memory of a smart mirror, answering the user out loud.",
  "You get excerpts of things the user said or wrote, oldest first, each with how long ago it was.",
  "Rules:",
  "1. Use only the excerpts. If they don't answer the question, say you don't have anything about that.",
  "2. Excerpts marked (LATEST) are the most recent word on their topic. If an earlier excerpt says something that a later one changed, answer with how things stand NOW — even when the question is in the past tense (\"what did I need…\"), say how it turned out.",
  "3. If the question asks about a specific past time (\"two weeks ago\", \"yesterday\"), answer about that time instead.",
  "4. If several excerpts answer the question, mention every one of them.",
  "5. Ignore excerpts that don't answer the question.",
  "6. Say \"you\". One or two short spoken sentences, no lists, no preamble.",
  "",
  "Example 1",
  "Excerpts:",
  "- [3 weeks ago, said] I have to return the library book by Friday",
  "- [2 days ago, said] (LATEST) returned the library book this morning",
  "Question: what did I have to return?",
  "Answer: The library book — but you already returned it two days ago.",
  "",
  "Example 2",
  "Excerpts:",
  "- [a month ago, asked for a reminder] remind me to renew the car insurance in March",
  "- [a week ago, said] (LATEST) the dentist wants to see me again in March",
  "Question: what's coming up in March?",
  "Answer: Your car insurance renewal and a dentist visit are both in March.",
].join("\n");

function ago(ts, now) {
  const days = Math.floor((now - ts) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

function sourceLabel(h) {
  if (h.source === "journal") return "journal";
  if (h.source === "event") return "calendar";
  if (h.kind === "file") return "notes file";
  if (h.source === "note") return "note";
  if (h.meta?.tool === "set_reminder") return "asked for a reminder";
  return "said";
}

/**
 * Ids of excerpts that were later updated. A hit is superseded when a
 * follow-up chains from it (see search.followUps), or when it chains from the
 * same original as a newer follow-up.
 */
function supersededIds(hits) {
  const byId = new Map(hits.map((h) => [h.id, h]));
  const out = new Set();
  for (const h of hits) {
    if (!h.followUpOf) continue;
    const root = byId.get(h.followUpOf);
    if (root && root.ts < h.ts) out.add(root.id);
    for (const sib of hits) {
      if (sib !== h && sib.followUpOf === h.followUpOf && sib.ts < h.ts) out.add(sib.id);
    }
  }
  return out;
}

export function promptV2(query, hits, now = Date.now()) {
  const old = supersededIds(hits);
  const inChain = new Set(hits.flatMap((h) => (h.followUpOf ? [h.id, h.followUpOf] : [])));
  const lines = [...hits]
    .sort((a, b) => a.ts - b.ts)
    .map((h) => {
      const latest = inChain.has(h.id) && !old.has(h.id) ? "(LATEST) " : "";
      return `- [${dateFmt.format(new Date(h.ts))}, ${ago(h.ts, now)}, ${sourceLabel(h)}] ${latest}${h.text}`;
    })
    .join("\n");
  return `Today is ${todayFmt.format(new Date(now))}.\n\nExcerpts (oldest first):\n${lines}\n\nQuestion: ${query}`;
}

const PROMPTS = {
  v1: { system: SYSTEM_V1, build: promptV1, filter: false },
  v2: { system: SYSTEM_V2, build: promptV2, filter: true },
};

/** Keep hits close enough to the best match to be about the same thing. */
export function relevantHits(hits, margin = RELEVANCE_MARGIN) {
  if (!hits.length) return hits;
  const best = Math.max(...hits.map((h) => h.cosine));
  return hits.filter((h) => h.cosine >= best - margin);
}

/**
 * Retrieve + synthesize. Synthesis uses the local model first (privacy), and
 * only falls back to the cloud when local is unavailable — and even then only
 * the retrieved snippets are sent, never the whole corpus.
 */
export async function recall(query, { promptVersion = "v2" } = {}) {
  const t0 = Date.now();
  if (!(await available())) throw new MemoryNotReady("embed model not running");

  const { assistant, memory } = await getSettings();
  const { hits: found, window, timings } = await search(query, {
    k: memory?.topK ?? 6,
  });
  const P = PROMPTS[promptVersion] ?? PROMPTS.v2;
  let hits = found;
  if (P.filter) {
    hits = relevantHits(found);
    // How did it turn out? Add later updates — unless the question asks about
    // a specific past time, where later news is beside the point.
    if (!window) hits = [...hits, ...followUps(hits)];
  }

  if (!hits.length) {
    logMetric({ kind: "recall", ...textFields(query, "query"), nHits: 0, ...timings });
    return {
      speak: "I don't have anything about that in memory yet.",
      data: { hits: [] },
    };
  }

  const prompt = P.build(query, hits);
  const tSynth = Date.now();
  let answer = "";
  let synthTier = "none";

  try {
    if (await llm.localAvailable()) {
      answer = await llm.localChat({
        model: assistant.models.local,
        system: P.system,
        prompt,
        timeoutMs: SYNTH_TIMEOUT_MS,
      });
      synthTier = "local";
    }
  } catch (err) {
    if (err.name === "TypeError") llm.markLocalDown(); // connection refused
    /* fall through */
  }

  if (!answer && !memory?.localOnly && llm.cloudConfigured()) {
    try {
      answer = await llm.cloudChat({
        model: assistant.models.cloud,
        system: P.system,
        prompt,
      });
      synthTier = "cloud";
    } catch {
      /* fall through */
    }
  }

  if (!answer) {
    // no LLM in time — read back the newest of the most relevant excerpts
    const best = [...hits].sort((a, b) => b.ts - a.ts)[0];
    answer = `From ${dateFmt.format(new Date(best.ts))}: ${best.text}`;
    synthTier = "raw";
  }

  logMetric({
    kind: "recall",
    ...textFields(query, "query"),
    nHits: hits.length,
    nFollowUps: hits.filter((h) => h.followUpOf).length,
    nRetrieved: found.length,
    topScore: Number(hits[0].score.toFixed(3)),
    window: window ? "yes" : "no",
    synthTier,
    promptVersion,
    ...timings,
    synthMs: Date.now() - tSynth,
    totalMs: Date.now() - t0,
  });

  return { speak: answer, data: { hits, synthTier } };
}
