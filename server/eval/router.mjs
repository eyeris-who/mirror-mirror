/**
 * Tier-1 routing eval: does the local model pick the right tool, and how fast?
 *
 *   node eval/router.mjs                 all tools vs preselected tools
 *   node eval/router.mjs --runs 3        repeat each case (latency spread)
 *
 * Cases are phrasings that tier 0 does NOT match (checked below), several taken
 * from real transcripts in data/metrics.jsonl. Needs Ollama with the local
 * model and nomic-embed-text. Logs nothing to your metrics.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.METRICS_FILE = join(process.env.TEMP || "/tmp", "mirror-router-eval-metrics.jsonl");

const here = dirname(fileURLToPath(import.meta.url));
const runsIdx = process.argv.indexOf("--runs");
const RUNS = runsIdx !== -1 ? Number(process.argv[runsIdx + 1]) : 1;

const { tier0, normalizeTranscript } = await import("../agent/router.js");
const { TOOLS } = await import("../agent/tools.js");
const llm = await import("../agent/llm.js");
const { selectTools } = await import("../agent/toolSelect.js");
const { getSettings } = await import("../settings.js");

const cases = JSON.parse(await readFile(join(here, "router-cases.json"), "utf8"));
const { assistant } = await getSettings();
const model = assistant.models.local;

if (!(await llm.localAvailable())) {
  console.error("Ollama not reachable.");
  process.exit(1);
}

for (const c of cases) {
  if (tier0(normalizeTranscript(c.text))) {
    console.warn(`  ! tier 0 already handles "${c.text}" — not a tier-1 case`);
  }
}

// warm the model so the first case doesn't pay the load
await llm.localToolCall({ model, text: "hello", tools: TOOLS.slice(0, 3) }).catch(() => {});

// all:      every tool, every time (stable prompt prefix → Ollama's cache hits)
// selected: embedding-preselected tools, every time
// hybrid:   all tools for a fresh request, preselected for a follow-up — what
//           the router does (history shifts the tool block past the cache)
const MODES = ["all", "selected", "hybrid"];

async function toolsFor(mode, c) {
  const history = c.history ?? [];
  if (mode === "all" || (mode === "hybrid" && !history.length)) return TOOLS;
  return (await selectTools(c.text, TOOLS, { history })).tools;
}

async function runMode(mode) {
  // warm this mode's prompt shape so the first timed case isn't a cold prefill
  await llm.localToolCall({ model, text: "pause", tools: await toolsFor(mode, { text: "pause" }) }).catch(() => {});
  const out = [];
  for (let run = 0; run < RUNS; run++) {
    for (const c of cases) {
      const history = c.history ?? [];
      const t0 = Date.now();
      const tools = await toolsFor(mode, c);
      const selectedHasAnswer = c.tool && tools !== TOOLS ? tools.some((t) => t.name === c.tool) : null;
      let picked = null;
      let error = null;
      try {
        const r = await llm.localToolCall({ model, text: c.text, tools, history });
        picked = r.tool ?? null;
      } catch (err) {
        error = err.name;
      }
      out.push({ ...c, ms: Date.now() - t0, picked, ok: picked === (c.tool ?? null), selectedHasAnswer, error });
    }
  }
  return out;
}

// nearest-rank on (n-1): the median of [a, b] is a, not the max
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.round((p / 100) * (s.length - 1))];
};

const results = {};
for (const mode of MODES) {
  results[mode] = await runMode(mode);
}

console.log(`\nmodel ${model} · ${cases.length} cases × ${RUNS} run(s) · median ms per case\n`);
console.log(`| case | expected | ${MODES.join(" | ")} |`);
console.log(`|---|---|${MODES.map(() => "---").join("|")}|`);
for (const c of cases) {
  const cell = (mode) => {
    const rs = results[mode].filter((r) => r.text === c.text);
    const miss = rs.some((x) => x.selectedHasAnswer === false) ? " (not offered)" : "";
    const picks = [...new Set(rs.map((x) => x.picked ?? x.error ?? "—"))].join("/");
    return `${rs.every((x) => x.ok) ? "✓" : "✗"} ${picks} ${pct(rs.map((x) => x.ms), 50)}${miss}`;
  };
  console.log(`| ${c.text}${c.history ? " _(follow-up)_" : ""} | ${c.tool ?? "(no tool)"} | ${MODES.map(cell).join(" | ")} |`);
}
console.log();
for (const mode of MODES) {
  const rs = results[mode];
  const line = (label, subset) => {
    const ms = subset.map((r) => r.ms);
    return `${label.padEnd(12)} accuracy ${subset.filter((r) => r.ok).length}/${subset.length}   p50 ${pct(ms, 50)}ms   p90 ${pct(ms, 90)}ms   max ${Math.max(...ms)}ms`;
  };
  console.log(`${mode}`);
  console.log(`  ${line("all cases", rs)}`);
  console.log(`  ${line("follow-ups", rs.filter((r) => r.history))}`);
  console.log(`  ${line("fresh", rs.filter((r) => !r.history))}`);
}
process.exit(0);
