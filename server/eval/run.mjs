/**
 * Retrieval eval for the personal-memory RAG.
 *
 *   node eval/run.mjs            # recall@k + MRR over eval/questions.json
 *   node eval/run.mjs --answers  # also print the synthesized answer per question
 *
 * Runs against a scratch corpus (eval/corpus.jsonl) in a temp dir — your real
 * memory.db is untouched. Needs Ollama + the embed model running.
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const WANT_ANSWERS = process.argv.includes("--answers");
const K = 6;

// point the memory modules at a throwaway dir BEFORE importing them
const dir = mkdtempSync(join(tmpdir(), "mirror-mem-eval-"));
const emptyNotes = mkdtempSync(join(tmpdir(), "mirror-mem-notes-"));
process.env.MEMORY_DIR = dir;
process.env.NOTES_DIR = emptyNotes; // don't index the real notes/ folder

const corpus = (await readFile(join(here, "corpus.jsonl"), "utf8"))
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);
const questions = JSON.parse(await readFile(join(here, "questions.json"), "utf8"));

// materialise the corpus as a conversation + notes log
const DAY = 864e5;
const conv = [];
const notes = [];
for (const row of corpus) {
  const ts = new Date(Date.now() + row.day * DAY).toISOString();
  if (/^journal:/i.test(row.text)) {
    notes.push({ ts, kind: "journal", text: row.text.replace(/^journal:\s*/i, "") });
  } else if (/^note that/i.test(row.text)) {
    notes.push({ ts, kind: "note", text: row.text.replace(/^note that\s*/i, "") });
  } else {
    conv.push({ ts, role: "user", text: row.text });
  }
}
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "conversations.jsonl"), conv.map((r) => JSON.stringify(r)).join("\n"));
writeFileSync(join(dir, "notes.jsonl"), notes.map((r) => JSON.stringify(r)).join("\n"));

const memory = await import("../memory/index.js");
const { search } = memory;
const { recall } = await import("../memory/recall.js");

if (!(await memory.available())) {
  console.error(
    "\n  Ollama embed model not reachable. Run:  ollama pull nomic-embed-text\n",
  );
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

console.log(`ingesting ${conv.length + notes.length} items…`);
await memory.ingest();

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
let hitAt1 = 0;
let hitAtK = 0;
let mrrSum = 0;
const rows = [];

for (const item of questions) {
  const t0 = Date.now();
  const { hits, window, timings } = await search(item.q, { k: K });
  const ms = Date.now() - t0;

  // a hit "matches" if a retrieved chunk contains one of the expected phrases
  const expects = item.expect.map(norm);
  const rank = hits.findIndex((h) =>
    expects.some((e) => norm(h.text).includes(e)),
  );
  const found = rank !== -1;
  if (rank === 0) hitAt1++;
  if (found) {
    hitAtK++;
    mrrSum += 1 / (rank + 1);
  }

  let answer = "";
  if (WANT_ANSWERS) {
    answer = (await recall(item.q)).speak;
  }

  rows.push({
    q: item.q,
    rank: found ? rank + 1 : "—",
    top: hits[0] ? hits[0].text.slice(0, 54) : "(nothing)",
    win: window ? "⏱" : "",
    ms,
    embedMs: timings.embedMs,
    answer,
  });
}

const n = questions.length;
const table = rows
  .map(
    (r) =>
      `| ${r.q.padEnd(46)} | ${String(r.rank).padStart(4)} | ${r.win.padEnd(2)} | ${String(r.ms).padStart(4)}ms | ${r.top} |`,
  )
  .join("\n");

const report = `# Memory retrieval eval

Corpus: ${conv.length + notes.length} items (${conv.length} conversation turns, ${notes.length} notes/journal).
Model: nomic-embed-text · top-k ${K} · recency half-life 14d

| question | rank | win | latency | top retrieved chunk |
|---|---:|:--:|---:|---|
${table}

**recall@1: ${((hitAt1 / n) * 100).toFixed(0)}%** · **recall@${K}: ${((hitAtK / n) * 100).toFixed(0)}%** · **MRR: ${(mrrSum / n).toFixed(2)}**
median retrieval latency: ${[...rows].map((r) => r.ms).sort((a, b) => a - b)[Math.floor(n / 2)]}ms
`;

console.log("\n" + report);
if (WANT_ANSWERS) {
  console.log("\n## Synthesized answers\n");
  for (const r of rows) console.log(`Q: ${r.q}\nA: ${r.answer}\n`);
}

writeFileSync(join(here, "results.md"), report);
console.log(`\nwrote ${join(here, "results.md")}`);

const { closeDb } = await import("../memory/db.js");
closeDb();
for (const d of [dir, emptyNotes]) {
  try {
    rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* temp dir — OS will clean it up */
  }
}
