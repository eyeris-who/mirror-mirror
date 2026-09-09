import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as chrono from "chrono-node";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "data", "reminders.json");

// [{ id, text, at: ISO, fired: bool }]  — gitignored (personal + transient)
let mem = null;

// Called whenever the list changes so the server can re-arm its fire timer.
let onChange = () => {};
export function watch(fn) {
  onChange = fn;
}

async function load() {
  if (mem) return mem;
  try {
    mem = JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    mem = [];
  }
  return mem;
}

async function persist() {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(mem, null, 2));
}

/**
 * Parse a natural-language phrase into { text, at }.
 *   "remind me to take out the trash at 8pm"
 *   "call mom in 20 minutes"
 * Returns null if no time could be found.
 */
export function parse(phrase) {
  const cleaned = phrase
    .replace(/^\s*(hey mirror[,\s]*)?/i, "")
    .replace(/^\s*(set (a )?reminder( to| for| that)?|remind me( to| that| about)?)\s*/i, "")
    .trim();

  const results = chrono.parse(cleaned, new Date(), { forwardDate: true });
  if (!results.length) return null;

  const r = results[0];
  let at = r.start.date();

  // "remind me at 8" (no am/pm) after 8am resolves to a past 8am — nudge it
  // forward: 12h if the am/pm was ambiguous ("8" -> 8pm), else a day.
  const grace = Date.now() - 60_000;
  if (at.getTime() < grace) {
    if (!r.start.isCertain("meridiem")) at = new Date(at.getTime() + 12 * 3600e3);
    if (at.getTime() < grace) at = new Date(at.getTime() + 24 * 3600e3);
  }
  const text =
    (cleaned.slice(0, r.index) + cleaned.slice(r.index + r.text.length))
      .replace(/\b(at|on|by|around|this|next)\s*$/i, "")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s,]+|[\s,]+$/g, "")
      .trim() || "your reminder";

  return { text, at: at.toISOString() };
}

export async function add(text, atISO) {
  await load();
  const reminder = {
    id: Math.random().toString(36).slice(2, 9),
    text,
    at: atISO,
    fired: false,
  };
  mem.push(reminder);
  mem.sort((a, b) => new Date(a.at) - new Date(b.at));
  await persist();
  onChange();
  return reminder;
}

/** Timestamp (ms) of the soonest not-yet-fired reminder, or null. */
export async function nextDueAt() {
  await load();
  const times = mem
    .filter((r) => !r.fired)
    .map((r) => new Date(r.at).getTime());
  return times.length ? Math.min(...times) : null;
}

/** Not-yet-fired, plus fired ones from the last 3h so overdue reminders linger
 *  on screen instead of vanishing the instant they're announced. */
export async function pending() {
  await load();
  const keepFiredAfter = Date.now() - 3 * 60 * 60 * 1000;
  return mem
    .filter((r) => !r.fired || new Date(r.at).getTime() > keepFiredAfter)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
}

export async function clearAll() {
  await load();
  const n = mem.length;
  mem = [];
  await persist();
  onChange();
  return n;
}

/** Reminders whose time has arrived; marks them fired. */
export async function dueNow() {
  await load();
  const now = Date.now();
  const due = mem.filter((r) => !r.fired && new Date(r.at).getTime() <= now);
  if (due.length) {
    for (const r of due) r.fired = true;
    await persist();
  }
  return due;
}
