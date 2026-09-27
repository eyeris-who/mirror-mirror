/**
 * Personal-memory eval: retrieval AND answers.
 *
 *   node eval/run.mjs                   retrieval + answer checks, writes eval/results.md
 *   node eval/run.mjs --prompt v1       same, with the original synthesis prompt
 *   node eval/run.mjs --retrieval-only  skip synthesis (no chat model needed)
 *   node eval/run.mjs --no-write        print only
 *
 * The corpus goes in the way real speech does: each line is routed by the
 * production router (tier 0) and logged as a conversation turn with the reply
 * tier/tool the mirror would record, notes land in notes.jsonl — so the
 * ingester's skip rules apply exactly as in production.
 *
 * Answers are scored without an LLM judge: each question lists required
 * concepts (any synonym matches) and phrases that must not appear.
 *
 * Runs in a temp dir — your real memory.db and metrics are untouched. Needs
 * Ollama + nomic-embed-text (and the chat model for answers), or EMBED_FAKE=1
 * for a wiring check (much lower scores — never publish those).
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);

const NO_WRITE = flag("--no-write");
const RETRIEVAL_ONLY = flag("--retrieval-only");
const PROMPT = opt("--prompt", "v2");
const FAKE = process.env.EMBED_FAKE === "1";
const K = 6;
const DAY = 864e5;

// point every module at throwaway locations BEFORE importing them
const dir = mkdtempSync(join(tmpdir(), "mirror-mem-eval-"));
const emptyNotes = mkdtempSync(join(tmpdir(), "mirror-mem-notes-"));
process.env.MEMORY_DIR = dir;
process.env.NOTES_DIR = emptyNotes; // don't index the real notes/ folder
process.env.METRICS_FILE = join(dir, "metrics.jsonl");

const corpus = (await readFile(join(here, "corpus.jsonl"), "utf8"))
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);
const questions = JSON.parse(await readFile(join(here, "questions.json"), "utf8"));

const { tier0, normalizeTranscript } = await import("../agent/router.js");

// ---- materialize the corpus through the production router ---------------
const conv = [];
const notes = [];
const routedAs = {};
corpus.forEach((row, i) => {
  const t = Date.now() + row.day * DAY + i * 1000; // stable order within a day
  const ts = new Date(t).toISOString();
  const later = (ms) => new Date(t + ms).toISOString();
  const hit = tier0(normalizeTranscript(row.text));
  const sessionId = "eval";

  conv.push({ ts, role: "user", text: row.text, sessionId });
  if (hit?.tool === "add_note") {
    notes.push({ ts: later(100), kind: hit.args.journal ? "journal" : "note", text: hit.args.text });
    conv.push({ ts: later(200), role: "assistant", text: "Noted.", tier: 0, tool: "add_note", sessionId });
  } else if (hit) {
    conv.push({ ts: later(200), role: "assistant", text: "Okay.", tier: 0, tool: hit.tool, sessionId });
  } else {
    // nothing at tier 0: in real use a model answers conversationally
    conv.push({ ts: later(200), role: "assistant", text: "Okay.", tier: 1, tool: null, sessionId });
  }
  const label = hit?.tool ?? "tier1";
  routedAs[label] = (routedAs[label] ?? 0) + 1;
});

mkdirSync(dir, { recursive: true });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
writeFileSync(join(dir, "conversations.jsonl"), jsonl(conv));
writeFileSync(join(dir, "notes.jsonl"), jsonl(notes));

const memory = await import("../memory/index.js");
const { recall } = await import("../memory/recall.js");
const llm = await import("../agent/llm.js");
const { getSettings } = await import("../settings.js");

if (!(await memory.available())) {
  console.error("\n  Ollama embed model not reachable. Run:  ollama pull nomic-embed-text\n");
  cleanup();
  process.exit(1);
}
const wantAnswers = !RETRIEVAL_ONLY && !FAKE && (await llm.localAvailable());
if (!RETRIEVAL_ONLY && !wantAnswers) {
  console.log("(no local chat model reachable — answer checks skipped)");
}

console.log(`routing: ${JSON.stringify(routedAs)}`);
const summary = await memory.ingest();
console.log(`ingested: ${JSON.stringify(summary)}`);

// ---- scoring ---------------------------------------------------------------
const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]/g, " ")
    .replace(/\s+/g, " ");

function checkAnswer(answer, spec) {
  const a = norm(answer);
  const missing = (spec.include ?? []).filter((group) => !group.some((w) => a.includes(norm(w).trim())));
  const present = (spec.exclude ?? []).filter((w) => a.includes(norm(w).trim()));
  return { pass: !missing.length && !present.length, missing, present };
}

const pct = (arr, p) => {
  const s = [...arr].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null;
};

const rows = [];
for (const item of questions) {
  if (item.forget) {
    const target = memory.recent({ limit: 500 }).find((c) => c.text.includes(item.forget));
    if (target) await memory.forget(target.id);
    else console.warn(`forget target not found: ${item.forget}`);
  }

  const t0 = Date.now();
  const { hits } = await memory.search(item.q, { k: K });
  const retrievalMs = Date.now() - t0;

  let rank = null;
  if (item.expect) {
    const expects = item.expect.map(norm);
    const i = hits.findIndex((h) => expects.some((e) => norm(h.text).includes(e)));
    rank = i === -1 ? 0 : i + 1; // 0 = not found
  }
  const leaked = item.forget ? hits.some((h) => h.text.includes(item.forget)) : false;

  let answer = "";
  let check = null;
  let synthMs = null;
  if (wantAnswers && item.answer) {
    const t1 = Date.now();
    const r = await recall(item.q, { promptVersion: PROMPT });
    synthMs = Date.now() - t1;
    answer = r.speak;
    check = checkAnswer(answer, item.answer);
  }

  if (flag("--debug") && (!check || !check.pass)) {
    console.log(`\n  ${item.q}`);
    for (const h of hits) {
      console.log(`    score ${h.score.toFixed(3)}  cos ${h.cosine.toFixed(3)}  ${h.text.slice(0, 70)}`);
    }
  }

  rows.push({ ...item, rank, leaked, retrievalMs, answer, check, synthMs });
  process.stdout.write(check ? (check.pass ? "✓" : "✗") : ".");
}
console.log();

// ---- report ----------------------------------------------------------------
const ranked = rows.filter((r) => r.rank !== null && r.kind !== "forgotten");
const at1 = ranked.filter((r) => r.rank === 1).length;
const atK = ranked.filter((r) => r.rank > 0).length;
const mrr = ranked.reduce((s, r) => s + (r.rank > 0 ? 1 / r.rank : 0), 0) / (ranked.length || 1);
const answered = rows.filter((r) => r.check);
const passed = answered.filter((r) => r.check.pass).length;

const kinds = [...new Set(rows.map((r) => r.kind))];
const byKind = kinds
  .map((k) => {
    const a = answered.filter((r) => r.kind === k);
    return `| ${k} | ${rows.filter((r) => r.kind === k).length} | ${a.length ? `${a.filter((r) => r.check.pass).length}/${a.length}` : "—"} |`;
  })
  .join("\n");

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const table = rows
  .map((r) => {
    const why = r.check && !r.check.pass
      ? ` _(missing: ${r.check.missing.map((g) => g[0]).join(", ") || "—"}${r.check.present.length ? `; said: ${r.check.present.join(", ")}` : ""})_`
      : "";
    return `| ${r.kind} | ${esc(r.q)} | ${r.rank === null ? "" : r.rank || "—"}${r.leaked ? " ⚠ leaked" : ""} | ${r.check ? (r.check.pass ? "✓" : "✗") : ""} | ${esc(r.answer.slice(0, 140))}${why} |`;
  })
  .join("\n");

const synth = answered.map((r) => r.synthMs);
const { assistant } = await getSettings();
const report = `# Memory eval

Corpus: ${corpus.length} utterances routed through the production router (${Object.entries(routedAs).map(([k, v]) => `${k} ${v}`).join(", ")}).
Embeddings: ${FAKE ? "EMBED_FAKE hashing embedder (wiring check only)" : process.env.EMBED_MODEL || "nomic-embed-text"} · top-k ${K} · recency half-life ${process.env.MEMORY_HALFLIFE_DAYS || 14}d
${wantAnswers ? `Answers: ${assistant.models.local} · prompt ${PROMPT} · scored by required/forbidden phrases (no LLM judge)` : "Answers: not run"}

**Retrieval** (${ranked.length} questions with a known source): recall@1 **${((at1 / ranked.length) * 100).toFixed(0)}%** · recall@${K} **${((atK / ranked.length) * 100).toFixed(0)}%** · MRR **${mrr.toFixed(2)}** · forgotten items leaked: **${rows.filter((r) => r.leaked).length}**
${wantAnswers ? `**Answers**: **${passed}/${answered.length}** pass (${((passed / answered.length) * 100).toFixed(0)}%) · synthesis p50 ${pct(synth, 50)}ms · p90 ${pct(synth, 90)}ms\n` : ""}
| kind | questions | answers pass |
|---|---:|---:|
${byKind}

| kind | question | rank | ok | answer |
|---|---|---:|:-:|---|
${table}
`;

console.log(`\n${report}`);
if (NO_WRITE || FAKE || RETRIEVAL_ONLY || PROMPT !== "v2") {
  console.log("(not writing results.md)");
} else {
  writeFileSync(join(here, "results.md"), report);
  console.log(`wrote ${join(here, "results.md")}`);
}

// recall() logs metrics fire-and-forget; let those land before the dir goes
await new Promise((r) => setTimeout(r, 300));
cleanup();

function cleanup() {
  import("../memory/db.js").then(({ closeDb }) => {
    closeDb();
    for (const d of [dir, emptyNotes]) {
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* temp dir — OS will clean it up */
      }
    }
  });
}
