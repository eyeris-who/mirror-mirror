import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, basename } from "node:path";
import { getDb, DIR, getCursor, setCursor, insertChunk } from "./db.js";
import { embedBatch, available } from "./embed.js";
import * as google from "../google.js";
import { RECALL_RE } from "../agent/patterns.js";

const here = dirname(fileURLToPath(import.meta.url));
const CONV_LOG = join(DIR, "conversations.jsonl");
const NOTES_LOG = join(DIR, "notes.jsonl");
// project-root /notes  (NOTES_DIR override keeps the eval isolated)
const NOTES_FOLDER = process.env.NOTES_DIR || join(here, "..", "..", "notes");

const hashOf = (s) => createHash("sha1").update(s).digest("hex").slice(0, 16);

function splitLong(text, max = 1200) {
  if (text.length <= max) return [text];
  const paras = text.split(/\n\s*\n/);
  const out = [];
  let buf = "";
  for (const p of paras) {
    if ((buf + p).length > max && buf) {
      out.push(buf.trim());
      buf = "";
    }
    buf += (buf ? "\n\n" : "") + p;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// ---- sources: each yields { source, kind, ts, text, meta } chunks ------

async function fromConversations() {
  let lines;
  try {
    lines = (await readFile(CONV_LOG, "utf8")).split("\n").filter(Boolean);
  } catch {
    return { chunks: [], cursor: "0" };
  }
  const start = Number(getCursor("conversation") ?? 0);
  const rows = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  });
  const chunks = [];

  // Give a turn ~2 min to settle before indexing: the assistant reply (which
  // tells us whether this was a recall query) is written after synthesis, and
  // synthesis can take 20s+. Stop at the first unsettled row and resume later.
  const settleCutoff = Date.now() - 120_000;
  let cursor = start;

  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    cursor = i + 1;
    if (!row || row.role !== "user") continue;

    const ts = Date.parse(row.ts) || Date.now();
    if (ts > settleCutoff) {
      cursor = i; // not settled yet — re-read from here next pass
      break;
    }

    // The paired assistant reply tells us what this turn was for.
    const reply = rows.slice(i + 1).find((r) => r?.role === "assistant") ?? null;

    const text = row.text.trim();
    if (text.length < 4) continue;

    // Don't index the turn if:
    //  - it created a note — the note text is already ingested from notes.jsonl
    //  - it's a memory-lookup question (routed to recall, or just phrased as one)
    //  - the assistant couldn't handle it — a dead-end turn isn't a memory
    if (reply?.tool === "recall" || reply?.tool === "add_note") continue;
    if (RECALL_RE.test(text.toLowerCase())) continue;
    if (reply?.text?.startsWith("I can't help with that yet")) continue;
    chunks.push({
      source: "conversation",
      kind: "utterance",
      ts,
      text, // what the synthesizer sees — the user's own words
      meta: { reply: reply?.text ?? null, tool: reply?.tool ?? null },
    });
  }
  return { chunks, cursor: String(cursor) };
}

async function fromNotesLog() {
  let lines;
  try {
    lines = (await readFile(NOTES_LOG, "utf8")).split("\n").filter(Boolean);
  } catch {
    return { chunks: [], cursor: "0" };
  }
  const start = Number(getCursor("note") ?? 0);
  const chunks = [];
  for (let i = start; i < lines.length; i++) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    for (const piece of splitLong((row.text || "").trim())) {
      if (piece.length < 4) continue;
      chunks.push({
        source: row.kind === "journal" ? "journal" : "note",
        kind: row.kind || "note",
        ts: Date.parse(row.ts) || Date.now(),
        text: piece,
        meta: {},
      });
    }
  }
  return { chunks, cursor: String(lines.length) };
}

async function fromNotesFolder() {
  let files;
  try {
    files = await readdir(NOTES_FOLDER);
  } catch {
    return { chunks: [], cursor: "{}" };
  }
  const seen = JSON.parse(getCursor("notefile") ?? "{}");
  const chunks = [];
  const next = { ...seen };

  for (const name of files) {
    if (![".md", ".txt", ".markdown"].includes(extname(name).toLowerCase()))
      continue;
    const full = join(NOTES_FOLDER, name);
    const s = await stat(full).catch(() => null);
    if (!s) continue;
    if (seen[name] === s.mtimeMs) continue; // unchanged
    next[name] = s.mtimeMs;

    const body = (await readFile(full, "utf8")).trim();
    for (const piece of splitLong(body)) {
      if (piece.length < 4) continue;
      chunks.push({
        source: "note",
        kind: "file",
        ts: s.mtimeMs,
        text: piece,
        meta: { file: basename(name) },
      });
    }
  }
  return { chunks, cursor: JSON.stringify(next) };
}

async function fromCalendarHistory() {
  if (process.env.MEMORY_INDEX_CALENDAR !== "1") return { chunks: [], cursor: "" };
  if (!(await google.isConnected())) return { chunks: [], cursor: "" };
  const end = new Date();
  const start = new Date(end.getTime() - 90 * 864e5); // last 90 days
  const events = await google.getEvents(start, end).catch(() => []);
  const chunks = events
    .filter((e) => new Date(e.start) < end)
    .map((e) => ({
      source: "event",
      kind: "calendar",
      ts: Date.parse(e.start) || Date.now(),
      text: [e.title, e.location].filter(Boolean).join(" — "),
      meta: { end: e.end },
    }));
  return { chunks, cursor: new Date().toISOString() };
}

// ---- run --------------------------------------------------------------

let running = false;

/** Incremental ingest of every source. Returns a per-source summary. */
export async function ingestAll() {
  if (running) return { skipped: true };
  running = true;
  const summary = {};
  try {
    if (!(await available())) {
      running = false;
      return { error: "embed_model_unavailable" };
    }

    const sources = [
      ["conversation", fromConversations],
      ["note", fromNotesLog],
      ["notefile", fromNotesFolder],
      ["event", fromCalendarHistory],
    ];

    for (const [key, fn] of sources) {
      const { chunks, cursor } = await fn();
      const fresh = chunks
        .map((c) => ({ ...c, hash: hashOf(`${c.source}|${c.ts}|${c.text}`) }))
        .filter((c) => !hasHash(c.hash));

      let added = 0;
      for (let i = 0; i < fresh.length; i += 32) {
        const batch = fresh.slice(i, i + 32);
        const vecs = await embedBatch(batch.map((c) => c.text));
        batch.forEach((c, j) => {
          if (insertChunk(c, vecs[j])) added++;
        });
      }
      if (cursor !== "") setCursor(key, cursor);
      summary[key] = { scanned: chunks.length, added };
    }
  } finally {
    running = false;
  }
  return summary;
}

const _hashCache = new Set();
function hasHash(h) {
  if (_hashCache.has(h)) return true;
  const row = getDb().prepare("SELECT 1 FROM chunks WHERE hash = ?").get(h);
  if (row) _hashCache.add(h);
  return Boolean(row);
}
