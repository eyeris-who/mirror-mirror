import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// MEMORY_DIR override lets the eval harness run against a scratch corpus.
export const DIR = process.env.MEMORY_DIR || join(here, "..", "data", "memory");
const FILE = join(DIR, "memory.db");

// nomic-embed-text is 768-dim. If you switch embedding models, bump this and
// delete memory.db (the vec table's dimension is fixed at create time).
export const EMBED_DIM = 768;

let db = null;

export function getDb() {
  if (db) return db;
  mkdirSync(DIR, { recursive: true });
  db = new DatabaseSync(FILE, { allowExtension: true });
  sqliteVec.load(db);
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id      INTEGER PRIMARY KEY,
      source  TEXT NOT NULL,      -- conversation | note | journal | event
      kind    TEXT,
      ts      INTEGER NOT NULL,   -- unix ms (for recency + time-window filters)
      text    TEXT NOT NULL,
      hash    TEXT UNIQUE,        -- dedupe key
      meta    TEXT
    );
    CREATE INDEX IF NOT EXISTS chunks_ts ON chunks(ts);

    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      embedding float[${EMBED_DIM}] distance_metric=cosine
    );

    CREATE TABLE IF NOT EXISTS ingest_state (
      source     TEXT PRIMARY KEY,
      cursor     TEXT,            -- per-source: last line number / mtime / ISO
      updated_at INTEGER
    );

    -- Tombstones: dedupe hashes of chunks the user asked to forget, so a source
    -- that is re-scanned (notes/ files, calendar history) can't bring them back.
    -- Only the hash is kept, never the text.
    CREATE TABLE IF NOT EXISTS forgotten (
      hash       TEXT PRIMARY KEY,
      forgot_at  INTEGER
    );
  `);

  return db;
}

export function getCursor(source) {
  const row = getDb()
    .prepare("SELECT cursor FROM ingest_state WHERE source = ?")
    .get(source);
  return row?.cursor ?? null;
}

export function setCursor(source, cursor) {
  getDb()
    .prepare(
      `INSERT INTO ingest_state(source, cursor, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    )
    .run(source, String(cursor), Date.now());
}

/** Insert a chunk + its embedding. Returns false if it was a duplicate. */
export function insertChunk({ source, kind, ts, text, hash, meta }, embedding) {
  const d = getDb();
  const existing = d.prepare("SELECT 1 FROM chunks WHERE hash = ?").get(hash);
  if (existing || isForgottenChunk({ source, kind, text, hash })) return false;

  const info = d
    .prepare(
      "INSERT INTO chunks(source, kind, ts, text, hash, meta) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(source, kind ?? null, ts, text, hash, meta ? JSON.stringify(meta) : null);

  d.prepare("INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)").run(
    BigInt(info.lastInsertRowid),
    new Float32Array(embedding),
  );
  return true;
}

const rowOut = (r) => (r ? { ...r, meta: r.meta ? JSON.parse(r.meta) : {} } : null);

export function getChunk(id) {
  return rowOut(
    getDb()
      .prepare("SELECT id, source, kind, ts, text, hash, meta FROM chunks WHERE id = ?")
      .get(id),
  );
}

/** Newest first. */
export function recentChunks({ limit = 50, offset = 0 } = {}) {
  return getDb()
    .prepare(
      "SELECT id, source, kind, ts, text, meta FROM chunks ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?",
    )
    .all(limit, offset)
    .map(rowOut);
}

function isForgotten(key) {
  return Boolean(getDb().prepare("SELECT 1 FROM forgotten WHERE hash = ?").get(key));
}

/**
 * The dedupe hash includes the timestamp, which is stable for conversation and
 * note-log rows but NOT for notes/ files (ts = file mtime — saving the file
 * changes it) or calendar history. Those sources also get a content-only
 * tombstone, so a forgotten line stays forgotten when the file is touched.
 */
function contentKey({ source, kind, text }) {
  if (kind !== "file" && source !== "event") return null;
  return `c:${createHash("sha1").update(`${source}|${text}`).digest("hex").slice(0, 16)}`;
}

export function isForgottenChunk(chunk) {
  const c = contentKey(chunk);
  return isForgotten(chunk.hash) || (c !== null && isForgotten(c));
}

function tx(fn) {
  const d = getDb();
  d.exec("BEGIN");
  try {
    const out = fn(d);
    d.exec("COMMIT");
    return out;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Delete chunks from BOTH the text table and the vector table (they share the
 * rowid; deleting one alone leaves an orphan the KNN can still return).
 * `tombstone` records the hashes so re-scanned sources skip them.
 */
export function deleteChunks(ids, { tombstone = true } = {}) {
  if (!ids.length) return 0;
  return tx((d) => {
    const get = d.prepare("SELECT hash, source, kind, text FROM chunks WHERE id = ?");
    const delChunk = d.prepare("DELETE FROM chunks WHERE id = ?");
    const delVec = d.prepare("DELETE FROM vec_chunks WHERE rowid = ?");
    const stone = d.prepare(
      "INSERT OR IGNORE INTO forgotten(hash, forgot_at) VALUES (?, ?)",
    );
    let n = 0;
    for (const id of ids) {
      const row = get.get(id);
      if (!row) continue;
      delVec.run(BigInt(id));
      delChunk.run(id);
      if (tombstone) {
        if (row.hash) stone.run(row.hash, Date.now());
        const c = contentKey(row);
        if (c) stone.run(c, Date.now());
      }
      n++;
    }
    return n;
  });
}

/** Ids of every chunk from `source` with the given timestamp (one note's pieces). */
export function chunkIdsAt(source, ts) {
  return getDb()
    .prepare("SELECT id FROM chunks WHERE source = ? AND ts = ?")
    .all(source, ts)
    .map((r) => r.id);
}

export function chunkIdsOlderThan(source, ts) {
  return getDb()
    .prepare("SELECT id FROM chunks WHERE source = ? AND ts < ?")
    .all(source, ts)
    .map((r) => r.id);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

export function stats() {
  const d = getDb();
  const bySource = d
    .prepare("SELECT source, COUNT(*) n, MAX(ts) latest FROM chunks GROUP BY source")
    .all();
  const total = d.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  const ingest = d.prepare("SELECT source, updated_at FROM ingest_state").all();
  return { total, bySource, ingest };
}
