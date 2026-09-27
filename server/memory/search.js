import * as chrono from "chrono-node";
import { getDb } from "./db.js";
import { embed } from "./embed.js";

const DAY = 864e5;
const HALFLIFE_DAYS = Number(process.env.MEMORY_HALFLIFE_DAYS || 14);

/** Pull a time window out of the query ("last week", "this month", "yesterday"). */
export function timeWindow(query) {
  const now = new Date();
  const res = chrono.parse(query, now);
  if (!res.length) return null;
  const r = res[0];
  const from = r.start?.date();
  const to = r.end?.date() ?? now;
  if (!from) return null;
  // Loose ranges like "last week" parse to a single day — widen to ±3.5d.
  const span = to.getTime() - from.getTime();
  if (span < DAY) {
    return { from: from.getTime() - 3.5 * DAY, to: from.getTime() + 3.5 * DAY };
  }
  return { from: from.getTime(), to: to.getTime() };
}

/**
 * Retrieve memory relevant to `query`.
 *   1. embed the query (local)
 *   2. KNN over sqlite-vec (top 40)
 *   3. filter to a time window if the query implies one
 *   4. re-rank by cosine × recency decay
 */
export async function search(query, { k = 6, pool = 40 } = {}) {
  const t0 = Date.now();
  const qvec = await embed(query);
  const embedMs = Date.now() - t0;

  const t1 = Date.now();
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.source, c.kind, c.ts, c.text, c.meta, v.distance
         FROM vec_chunks v JOIN chunks c ON c.id = v.rowid
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance`,
    )
    .all(new Float32Array(qvec), pool);
  const retrievalMs = Date.now() - t1;

  const win = timeWindow(query);
  const now = Date.now();

  const scored = rows
    .filter((r) => !win || (r.ts >= win.from && r.ts <= win.to))
    .map((r) => {
      const cosine = 1 - r.distance; // vec_chunks uses distance_metric=cosine
      const ageDays = Math.max(0, (now - r.ts) / DAY);
      const recency = Math.pow(0.5, ageDays / HALFLIFE_DAYS);
      return {
        id: r.id,
        source: r.source,
        kind: r.kind,
        ts: r.ts,
        text: r.text,
        meta: r.meta ? JSON.parse(r.meta) : {},
        cosine,
        score: cosine * (0.4 + 0.6 * recency), // recency shapes, doesn't dominate
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return {
    hits: scored,
    window: win,
    timings: { embedMs, retrievalMs },
  };
}
