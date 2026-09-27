import { appendFile, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  DIR,
  stats,
  getChunk,
  getCursor,
  setCursor,
  recentChunks,
  deleteChunks,
  chunkIdsAt,
  chunkIdsOlderThan,
} from "./db.js";
import { ingestAll, withIndexLock, pairedReply } from "./ingest.js";
import { available } from "./embed.js";
import { search } from "./search.js";
import { createLock } from "./lock.js";

export { search } from "./search.js";
export { recall } from "./recall.js";
export { stats } from "./db.js";
export { available };

const CONV_LOG = join(DIR, "conversations.jsonl");
const NOTES_LOG = join(DIR, "notes.jsonl");

/** Stands in for a reply that read memory aloud — see agent/index.js. */
export const PRIVATE_PLACEHOLDER = "(answered from memory — not logged)";
const PRIVATE_REPLY_TOOLS = new Set(["recall", "forget", "forget_confirm"]);

// Appends and scrubs of the same log must not interleave. See lock.js.
const withFileLock = createLock();

async function append(file, obj) {
  await withFileLock(async () => {
    await mkdir(DIR, { recursive: true });
    await appendFile(file, `${JSON.stringify(obj)}\n`);
  });
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

// ---- forgetting ----------------------------------------------------------

/**
 * Remove rows from a JSONL log. `pick(rows)` returns the indexes to drop.
 * The ingester's cursor for that log is a line number, so every dropped line
 * that sits before the cursor moves it back by one — otherwise the next pass
 * would skip lines it hasn't read yet. Must run inside withIndexLock.
 */
async function scrubLog(file, cursorKey, pick, { redact } = {}) {
  return withFileLock(async () => {
    let lines;
    try {
      lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    } catch {
      return 0;
    }
    const rows = lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
    const drop = pick(rows);
    // rows to keep but blank out (same line count, so no cursor change)
    let redacted = 0;
    if (redact) {
      rows.forEach((r, i) => {
        if (r && !drop.has(i) && redact(r)) {
          lines[i] = JSON.stringify({ ...r, text: PRIVATE_PLACEHOLDER });
          redacted++;
        }
      });
    }
    if (!drop.size && !redacted) return 0;

    const kept = lines.filter((_, i) => !drop.has(i));
    const tmp = `${file}.tmp`;
    await writeFile(tmp, kept.length ? `${kept.join("\n")}\n` : "");
    await rename(tmp, file);

    const cur = getCursor(cursorKey);
    if (cur != null) {
      const before = [...drop].filter((i) => i < Number(cur)).length;
      if (before) setCursor(cursorKey, Number(cur) - before);
    }
    return drop.size;
  });
}

const sameMoment = (row, ts) => Date.parse(row?.ts) === ts;

/**
 * Forget one memory completely: the index row, its vector, the line in the
 * source log it came from (and, for a conversation, the reply that went with
 * it), plus a tombstone so a re-scanned source can't bring it back.
 * Returns what was forgotten, or null if the id doesn't exist.
 */
export function forget(id) {
  return withIndexLock(async () => {
    const c = getChunk(id);
    if (!c) return null;

    let ids = [c.id];
    let scrubbed = 0;

    if (c.source === "conversation") {
      scrubbed = await scrubLog(CONV_LOG, "conversation", (rows) => {
        const drop = new Set();
        rows.forEach((r, i) => {
          if (r?.role === "user" && sameMoment(r, c.ts) && r.text?.trim() === c.text) {
            drop.add(i);
            const reply = pairedReply(rows, i);
            if (reply) drop.add(rows.indexOf(reply));
          }
        });
        return drop;
      });
    } else if ((c.source === "note" || c.source === "journal") && c.kind !== "file") {
      // a long note is indexed as several pieces — forget the whole note
      ids = chunkIdsAt(c.source, c.ts);
      const head = c.text.slice(0, 80);
      scrubbed = await scrubLog(NOTES_LOG, "note", (rows) => {
        const drop = new Set();
        rows.forEach((r, i) => {
          if (sameMoment(r, c.ts) && (r.text ?? "").includes(head)) drop.add(i);
        });
        return drop;
      });
      // …and the spoken command that dictated it ("note that the gate code is
      // 4471"), logged a moment before the note itself.
      const said = head.toLowerCase();
      scrubbed += await scrubLog(CONV_LOG, "conversation", (rows) => {
        const drop = new Set();
        rows.forEach((r, i) => {
          if (
            r?.role === "user" &&
            Math.abs(Date.parse(r.ts) - c.ts) < 60_000 &&
            (r.text ?? "").toLowerCase().includes(said)
          ) {
            drop.add(i);
            const reply = pairedReply(rows, i);
            if (reply) drop.add(rows.indexOf(reply));
          }
        });
        return drop;
      });
    }
    // notes/ files and calendar events: the tombstone stops re-indexing; the
    // file itself is the user's to edit.

    // Recall answers logged before replies were redacted may have read this
    // memory aloud ("The back gate code is 4471"). A paraphrase can't be
    // matched reliably, so blank every such reply — nothing reads them back.
    await scrubLog(CONV_LOG, "conversation", () => new Set(), {
      redact: (r) =>
        r.role === "assistant" && PRIVATE_REPLY_TOOLS.has(r.tool) && r.text !== PRIVATE_PLACEHOLDER,
    });

    const removed = deleteChunks(ids);
    return {
      id: c.id,
      source: c.source,
      kind: c.kind,
      ts: c.ts,
      text: c.text,
      file: c.meta?.file ?? null,
      removed,
      scrubbedLines: scrubbed,
    };
  });
}

// Below this cosine a "forget …" query is too loose to act on — better to say
// "I couldn't find that" than to offer to delete the wrong thing.
const FORGET_MIN_COSINE = Number(process.env.MEMORY_FORGET_MIN_COSINE || 0.5);

/**
 * What would "forget <query>" delete? Empty / "that" / "the last one" means the
 * most recent spoken note. Returns a chunk (with cosine when searched) or null.
 */
export async function findForgettable(query) {
  const q = (query ?? "").trim().toLowerCase();
  if (!q || /^(that|this|the last one|last one|what i just said|my last note|the last note)$/.test(q)) {
    return (
      recentChunks({ limit: 50 }).find(
        (c) => (c.source === "note" || c.source === "journal") && c.kind !== "file",
      ) ?? null
    );
  }
  const { hits } = await search(query, { k: 1 });
  const top = hits[0];
  return top && top.cosine >= FORGET_MIN_COSINE ? top : null;
}

export function recent(opts) {
  return recentChunks(opts);
}

/**
 * Retention: drop conversation memories older than `days` from the index and
 * from conversations.jsonl. Notes and journal entries are kept — you wrote
 * those on purpose. Only lines the ingester has already processed are removed.
 */
export function pruneConversations(days) {
  if (!(days > 0)) return Promise.resolve({ removed: 0, scrubbedLines: 0 });
  const cutoff = Date.now() - days * 864e5;
  return withIndexLock(async () => {
    const removed = deleteChunks(chunkIdsOlderThan("conversation", cutoff), {
      tombstone: false,
    });
    const cursor = Number(getCursor("conversation") ?? 0);
    const scrubbedLines = await scrubLog(CONV_LOG, "conversation", (rows) => {
      const drop = new Set();
      rows.forEach((r, i) => {
        if (i < cursor && r && Date.parse(r.ts) < cutoff) drop.add(i);
      });
      return drop;
    });
    return { removed, scrubbedLines };
  });
}

// ---- background ingestion ------------------------------------------------

let timer = null;
export function ingest() {
  return ingestAll();
}

/** `retentionDays()` is read every tick so a settings change applies live. */
export function startIngestLoop(everyMs = 10 * 60 * 1000, { retentionDays } = {}) {
  const tick = async () => {
    try {
      await ingestAll();
      const days = retentionDays ? await retentionDays() : 0;
      if (days > 0) {
        const r = await pruneConversations(days);
        if (r.removed || r.scrubbedLines)
          console.log(`memory retention: dropped ${r.removed} chunks, ${r.scrubbedLines} log lines`);
      }
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
