/**
 * Roll up server/data/metrics.jsonl into a latency + routing report.
 *   node eval/report.mjs               all events
 *   node eval/report.mjs --since 24h   last 24 hours only
 *   node eval/report.mjs --since 30m
 *
 * Report the unfiltered numbers when you publish them. p90 and the dead-end
 * rate are the honest ones; p50 alone hides the slow tier.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = process.env.METRICS_FILE || join(here, "..", "data", "metrics.jsonl");

const sinceIdx = process.argv.indexOf("--since");
const sinceArg = sinceIdx !== -1 ? process.argv[sinceIdx + 1] : null;
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
  lines = (await readFile(FILE, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
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
const share = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : "—");

function line(label, arr) {
  if (!arr.length) return `${label.padEnd(24)}  (no data)`;
  return `${label.padEnd(24)}  n=${String(arr.length).padStart(4)}   p50 ${String(pct(arr, 50)).padStart(6)}ms   p90 ${String(pct(arr, 90)).padStart(6)}ms   max ${String(Math.max(...arr)).padStart(6)}ms`;
}

const commands = lines.filter((l) => l.kind === "command");
const recalls = lines.filter((l) => l.kind === "recall");
const wakes = lines.filter((l) => l.kind === "wake");
const voiceAll = lines.filter((l) => l.kind === "voice");
// Rows written before the timing fix have `wakeToReplyMs` and an `sttMs` that
// included the "Hmm?" ack, the pause, and a second listen. Don't mix them in.
const voice = voiceAll.filter((l) => "replyMs" in l);
const legacyVoice = voiceAll.length - voice.length;

console.log(
  `\nMetrics from ${lines.length} events${sinceMs ? ` since ${sinceArg} ago` : ""} (${FILE})\n`,
);

console.log("— voice pipeline —");
console.log(line("STT (whisper, 1 clip)", col(voice, "sttMs")));
{
  const c = col(voice, "sttConfidence");
  if (c.length) {
    const mean = c.reduce((a, b) => a + b, 0) / c.length;
    const low = c.filter((x) => x < 0.5).length;
    console.log(
      `${"STT confidence".padEnd(24)}  n=${String(c.length).padStart(4)}   mean ${mean.toFixed(2)}   below 0.5: ${low} (${share(low, c.length)})`,
    );
  }
}
console.log(line("end of speech → answer", col(voice, "replyMs")));
console.log(line("TTS (speaking time)", col(voice, "ttsMs")));
if (legacyVoice)
  console.log(`  (${legacyVoice} older voice rows skipped: their sttMs included the ack + a second listen)`);

console.log("\n— wake phrase —");
if (wakes.length) {
  const woke = wakes.filter((w) => w.woke).length;
  const near = wakes.filter((w) => !w.woke && w.score >= 0.6).length;
  console.log(`  utterances transcribed   ${wakes.length}`);
  console.log(`  woke                     ${woke} (${share(woke, wakes.length)})`);
  console.log(`  near misses (score ≥0.6) ${near} — if these were you, lower wake.THRESHOLD`);
  console.log(line("  STT on idle chatter", col(wakes.filter((w) => !w.woke), "sttMs")));
} else {
  console.log("  (no data yet — written by the voice service on every transcribed utterance)");
}

console.log("\n— routing —");
const tierName = { "0": "0 rules", "1": "1 local", "2": "2 cloud", "-1": "dead end" };
for (const t of ["0", "1", "2", "-1"]) {
  const rows = commands.filter((c) => String(c.tier) === t);
  if (!rows.length) continue;
  console.log(
    `  tier ${tierName[t].padEnd(9)} ${String(rows.length).padStart(4)}  ${share(rows.length, commands.length).padStart(4)}   ` +
      `route p50 ${pct(col(rows, "routeMs"), 50)}ms  p90 ${pct(col(rows, "routeMs"), 90)}ms`,
  );
}
{
  const dead = commands.filter((c) => c.tier === -1).length;
  console.log(`  dead-end rate: ${share(dead, commands.length)} of ${commands.length} commands`);
}

console.log("\n— memory recall —");
console.log(line("embed query", col(recalls, "embedMs")));
console.log(line("vector search", col(recalls, "retrievalMs")));
console.log(line("synthesis", col(recalls, "synthMs")));
console.log(line("recall end-to-end", col(recalls, "totalMs")));
const bySynth = {};
for (const r of recalls) bySynth[r.synthTier ?? "none"] = (bySynth[r.synthTier ?? "none"] ?? 0) + 1;
console.log(
  `  synthesized by: ${Object.entries(bySynth).map(([s, n]) => `${s} ${n}`).join(" · ") || "—"}`,
);

const topTools = {};
for (const c of commands) if (c.tool) topTools[c.tool] = (topTools[c.tool] ?? 0) + 1;
console.log("\n— top tools —");
for (const [t, n] of Object.entries(topTools).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${t.padEnd(20)} ${n}`);
}
console.log();
