import * as chrono from "chrono-node";
import { getDb } from "./db.js";
import { embed } from "./embed.js";

const DAY = 864e5;
const HALFLIFE_DAYS = Number(process.env.MEMORY_HALFLIFE_DAYS || 14);

/** Pull a time window out of the query ("last week", "this month", "yesterday"). */
export function timeWindow(query, now = new Date()) {
  const res = chrono.parse(query, now);
  if (!res.length) return null;
  const r = res[0];
  const start = r.start?.date();
  if (!start) return null;

  // An explicit range ("between Monday and Wednesday").
  if (r.end) return { from: start.getTime(), to: r.end.date().getTime() };

  // A single point. chrono returns one instant for "yesterday" or "two weeks
  // ago"; widen it to what the phrase means. (Using `now` as the end, as this
  // used to, made "yesterday" = the last 24h, which drops yesterday morning.)
  const text = r.text.toLowerCase();
  const around = (days) => ({ from: start.getTime() - days * DAY, to: start.getTime() + days * DAY });
  if (/\byears?\b/.test(text)) return around(180);
  if (/\bmonths?\b/.test(text)) return around(15);
  if (/\bweeks?\b|\bweekend\b/.test(text)) return around(3.5);

  // a day ("yesterday", "on Monday", "on the 3rd"): that whole local day
  const d0 = new Date(start);
  d0.setHours(0, 0, 0, 0);
  return { from: d0.getTime(), to: d0.getTime() + DAY };
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

// Measured with nomic-embed-text on the eval corpus: a later message that
// updates an earlier one ("I need milk, eggs…" → "fridge is fully stocked")
// scores 0.60–0.79 against it; unrelated pairs 0.38–0.48.
const FOLLOW_UP_MIN_COSINE = Number(process.env.MEMORY_FOLLOW_UP_MIN || 0.58);

/**
 * Update chaining. An update is often phrased nothing like the question
 * ("what did I need from the store?" vs "fridge is fully stocked now"), so it
 * ranks low or not at all. For each hit, pull in LATER chunks whose embedding
 * is close to the hit's own — the follow-ups on the same topic — so the
 * synthesizer sees how things turned out.
 */
export function followUps(hits, { minCosine = FOLLOW_UP_MIN_COSINE, perHit = 3, pool = 12 } = {}) {
  const d = getDb();
  const have = new Set(hits.map((h) => h.id));
  const vecOf = d.prepare("SELECT embedding FROM vec_chunks WHERE rowid = ?");
  const knn = d.prepare(
    `SELECT c.id, c.source, c.kind, c.ts, c.text, c.meta, v.distance
       FROM vec_chunks v JOIN chunks c ON c.id = v.rowid
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance`,
  );

  const out = [];
  for (const h of hits) {
    const row = vecOf.get(BigInt(h.id));
    if (!row) continue;
    const later = knn
      .all(row.embedding, pool)
      .filter((r) => r.ts > h.ts && !have.has(r.id) && 1 - r.distance >= minCosine)
      .slice(0, perHit);
    for (const r of later) {
      have.add(r.id);
      out.push({
        id: r.id,
        source: r.source,
        kind: r.kind,
        ts: r.ts,
        text: r.text,
        meta: r.meta ? JSON.parse(r.meta) : {},
        cosine: null,
        score: null,
        followUpOf: h.id,
        similarity: 1 - r.distance,
      });
    }
  }
  return out;
}
