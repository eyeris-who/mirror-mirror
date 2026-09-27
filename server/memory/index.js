import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DIR, stats } from "./db.js";
import { ingestAll } from "./ingest.js";
import { available } from "./embed.js";

export { search } from "./search.js";
export { recall } from "./recall.js";
export { stats } from "./db.js";
export { available };

const CONV_LOG = join(DIR, "conversations.jsonl");
const NOTES_LOG = join(DIR, "notes.jsonl");

async function append(file, obj) {
  await mkdir(DIR, { recursive: true });
  await appendFile(file, `${JSON.stringify(obj)}\n`);
}

/** Log one side of a voice exchange for later recall. */
export async function logTurn({ role, text, tier, tool, sessionId }) {
  if (!text || !text.trim()) return;
  await append(CONV_LOG, {
    ts: new Date().toISOString(),
    role,
    text: text.trim(),
    tier,
    tool,
    sessionId,
  });
}

/** "note that…" / "add a journal entry…" */
export async function addNote(text, kind = "note") {
  await append(NOTES_LOG, {
    ts: new Date().toISOString(),
    kind,
    text: text.trim(),
  });
  ingest().catch(() => {}); // pick it up now
}

// ---- background ingestion ------------------------------------------------

let timer = null;
export function ingest() {
  return ingestAll();
}

export function startIngestLoop(everyMs = 10 * 60 * 1000) {
  const tick = async () => {
    try {
      await ingestAll();
    } catch (err) {
      console.error("memory ingest:", err.message);
    }
    timer = setTimeout(tick, everyMs);
  };
  timer = setTimeout(tick, 8000); // first run shortly after boot
}

export async function status() {
  return { embedModelReady: await available(), ...stats() };
}
