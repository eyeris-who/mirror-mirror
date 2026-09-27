import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
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
  const existing = d
    .prepare("SELECT 1 FROM chunks WHERE hash = ?")
    .get(hash);
  if (existing) return false;

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
