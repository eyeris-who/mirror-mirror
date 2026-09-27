/**
 * Roll up server/data/metrics.jsonl into a latency + routing report.
 *   node eval/report.mjs               all events
 *   node eval/report.mjs --since 24h   last 24 hours only
 *   node eval/report.mjs --since 30m
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "metrics.jsonl");

const sinceArg = process.argv[process.argv.indexOf("--since") + 1];
let sinceMs = 0;
if (sinceArg) {
  const m = sinceArg.match(/^(\d+)\s*([hmd])$/);
  const unit = { m: 60e3, h: 3600e3, d: 864e5 }[m?.[2]];
  if (!unit) {
    console.error(`bad --since "${sinceArg}" — use e.g. 30m, 24h, 7d`);
    process.exit(1);
  }
  sinceMs = Date.now() - Number(m[1]) * unit;
}

let lines;
try {
  lines = (await readFile(FILE, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
} catch {
  console.error(`no metrics yet at ${FILE}`);
  process.exit(1);
}
if (sinceMs) lines = lines.filter((l) => Date.parse(l.ts) >= sinceMs);

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const col = (rows, key) => rows.map((r) => r[key]).filter((v) => typeof v === "number");

function line(label, arr) {
  if (!arr.length) return `${label.padEnd(22)}  (no data)`;
  return `${label.padEnd(22)}  n=${String(arr.length).padStart(4)}   p50 ${String(pct(arr, 50)).padStart(6)}ms   p90 ${String(pct(arr, 90)).padStart(6)}ms   max ${String(Math.max(...arr)).padStart(6)}ms`;
}

const commands = lines.filter((l) => l.kind === "command");
const recalls = lines.filter((l) => l.kind === "recall");
const voice = lines.filter((l) => l.kind === "voice");

console.log(
  `\nMetrics from ${lines.length} events${sinceMs ? ` since ${sinceArg} ago` : ""} (${FILE})\n`,
);

console.log("— stage latency —");
console.log(line("STT (whisper)", col(voice, "sttMs")));
{
  const c = col(voice, "sttConfidence");
  if (c.length) {
    const mean = c.reduce((a, b) => a + b, 0) / c.length;
    const low = c.filter((x) => x < 0.5).length;
    console.log(
      `${"STT confidence".padEnd(22)}  n=${String(c.length).padStart(4)}   mean ${mean.toFixed(2)}   below 0.5: ${low} (${((low / c.length) * 100).toFixed(0)}%)`,
    );
  }
}
console.log(line("router", col(commands, "routeMs")));
console.log(line("tool exec", col(commands, "toolMs")));
console.log(line("  recall: embed", col(recalls, "embedMs")));
console.log(line("  recall: retrieval", col(recalls, "retrievalMs")));
console.log(line("  recall: synthesis", col(recalls, "synthMs")));
console.log(line("TTS", col(voice, "ttsMs")));
console.log(line("wake → reply (e2e)", col(voice, "wakeToReplyMs")));

console.log("\n— routing —");
const byTier = {};
for (const c of commands) byTier[c.tier] = (byTier[c.tier] ?? 0) + 1;
const tierName = { "0": "0 rules", "1": "1 local", "2": "2 cloud", "-1": "unhandled" };
for (const [t, n] of Object.entries(byTier).sort()) {
  const share = ((n / commands.length) * 100).toFixed(0);
  console.log(`  tier ${(tierName[t] ?? t).padEnd(10)} ${String(n).padStart(4)}  ${share}%`);
}

console.log("\n— recall synthesis source —");
const bySynth = {};
for (const r of recalls) bySynth[r.synthTier] = (bySynth[r.synthTier] ?? 0) + 1;
for (const [s, n] of Object.entries(bySynth)) console.log(`  ${String(s).padEnd(6)} ${n}`);

const topTools = {};
for (const c of commands) if (c.tool) topTools[c.tool] = (topTools[c.tool] ?? 0) + 1;
console.log("\n— top tools —");
for (const [t, n] of Object.entries(topTools).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${t.padEnd(20)} ${n}`);
}
console.log();
