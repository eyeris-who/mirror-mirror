import { appendFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "metrics.jsonl");

/**
 * One JSON object per line. Fields vary by `kind`:
 *   command : { tier, tool, routeMs, toolMs, totalMs }
 *   voice   : { sttMs, ttsMs, wakeToReplyMs }  (posted by the Python service)
 *   setup   : { totalMs }
 *
 * Read it back with:  node --eval "..."  or a small script under scripts/.
 */
export async function logMetric(row) {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`;
  try {
    await mkdir(dirname(FILE), { recursive: true });
    await appendFile(FILE, line);
  } catch (err) {
    console.error("metric:", err.message);
  }
}
