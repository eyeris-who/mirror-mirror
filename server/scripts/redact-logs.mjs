/**
 * One-off privacy cleanup for logs written before redaction existed.
 *
 *   node scripts/redact-logs.mjs           dry run: counts what would change
 *   node scripts/redact-logs.mjs --apply   rewrite the files
 *
 *  - data/metrics.jsonl: raw `text` / `query` fields become the same hash +
 *    word count new rows use (latency and routing numbers are untouched)
 *  - data/memory/conversations.jsonl: old replies that read memory aloud
 *    ("the back gate code is 4471") become the placeholder new replies use
 *
 * Only text is replaced — no line is added or removed, so the ingester's
 * line-number cursors stay valid. Refuses to run while the server is up (it
 * appends to these files).
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { textFields } from "../agent/metrics.js";

const PLACEHOLDER = "(answered from memory — not logged)";
const PRIVATE_TOOLS = new Set(["recall", "forget", "forget_confirm"]);

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, "..", "data");
const APPLY = process.argv.includes("--apply");
const PORT = process.env.PORT || 3001;

try {
  await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(800) });
  console.error(`The mirror server is running on :${PORT} — stop it first.`);
  process.exit(1);
} catch {
  /* not running: good */
}

function rewrite(file, fix) {
  if (!existsSync(file)) return { file, changed: 0, total: 0 };
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  let changed = 0;
  const out = lines.map((line) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return line;
    }
    const next = fix(row);
    if (!next) return line;
    changed++;
    return JSON.stringify(next);
  });
  if (APPLY && changed) {
    writeFileSync(`${file}.tmp`, `${out.join("\n")}\n`);
    renameSync(`${file}.tmp`, file);
  }
  return { file, changed, total: lines.length };
}

const metrics = rewrite(join(DATA, "metrics.jsonl"), (row) => {
  if (typeof row.text !== "string" && typeof row.query !== "string") return null;
  const { text, query, ...rest } = row;
  return {
    ...rest,
    ...(typeof text === "string" ? textFields(text) : {}),
    ...(typeof query === "string" ? textFields(query, "query") : {}),
  };
});

const conversations = rewrite(join(DATA, "memory", "conversations.jsonl"), (row) =>
  row.role === "assistant" && PRIVATE_TOOLS.has(row.tool) && row.text !== PLACEHOLDER
    ? { ...row, text: PLACEHOLDER }
    : null,
);

for (const r of [metrics, conversations]) {
  console.log(`${APPLY ? "redacted" : "would redact"} ${r.changed} of ${r.total} rows in ${r.file}`);
}
if (!APPLY) console.log("\nDry run. Re-run with --apply to write.");
