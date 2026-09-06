import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as googleCal from "./google.js";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(here, "data", "schedule.json");

/**
 * Today's events, sorted by start time:
 *   [{ id, title, start: ISO, end: ISO|null, allDay: bool, location: string|null }]
 *
 * Uses Google Calendar once connected; otherwise falls back to the local
 * schedule.json sample file so the UI still has something to render.
 */
export async function getSchedule() {
  if (await googleCal.isConnected()) {
    const events = await googleCal.getTodayEvents();
    return sortToday(events);
  }
  return sortToday(await readLocal());
}

async function readLocal() {
  const rows = JSON.parse(await readFile(DATA_FILE, "utf8"));
  return rows.map((r, i) => ({
    id: r.id ?? String(i),
    title: r.title,
    location: r.location ?? null,
    allDay: Boolean(r.allDay),
    start: new Date(r.start).toISOString(),
    end: r.end ? new Date(r.end).toISOString() : null,
  }));
}

function sortToday(events) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  return events
    .filter((e) => {
      const s = new Date(e.start);
      return s >= startOfDay && s < endOfDay;
    })
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}
