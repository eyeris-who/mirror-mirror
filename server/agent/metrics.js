import { appendFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
// METRICS_FILE override keeps test / smoke runs out of your real numbers.
const FILE = process.env.METRICS_FILE || join(here, "..", "data", "metrics.jsonl");

/**
 * One JSON object per line. Fields vary by `kind`:
 *   command : { tier, tool, routeMs, toolMs, totalMs }
 *   voice   : { sttMs, sttConfidence, replyMs, ttsMs, tier }  (Python service)
 *   wake    : { woke, score, sttMs, sttConfidence }  (every transcribed utterance)
 *   recall  : { nHits, topScore, embedMs, retrievalMs, synthMs, … }
 *   setup   : { totalMs }
 *
 * Read it back with:  node --eval "..."  or a small script under scripts/.
 */
/**
 * What to log instead of what the user said. Metrics are for latency and
 * routing, and they sit in a plain file — "what's the wifi password" shouldn't.
 * A short hash still lets you count repeats of the same phrasing.
 * METRICS_LOG_TEXT=1 keeps the raw text (useful while debugging the router).
 */
export function textFields(text, key = "text") {
  const t = String(text ?? "");
  if (process.env.METRICS_LOG_TEXT === "1") return { [key]: t };
  return {
    [`${key}Hash`]: createHash("sha256").update(t.toLowerCase().trim()).digest("hex").slice(0, 12),
    [`${key}Words`]: t.trim() ? t.trim().split(/\s+/).length : 0,
  };
}

export async function logMetric(row) {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`;
  try {
    await mkdir(dirname(FILE), { recursive: true });
    await appendFile(FILE, line);
  } catch (err) {
    console.error("metric:", err.message);
  }
}
