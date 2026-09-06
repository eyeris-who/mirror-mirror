import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as googleCal from "./google.js";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(here, "data", "schedule.json");

/** Start/end Date pair for a named range, in local time. */
export function windowFor(range = "today") {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const start = new Date(startOfToday);
  const end = new Date(startOfToday);

  if (range === "tomorrow") {
    start.setDate(start.getDate() + 1);
    end.setDate(end.getDate() + 2);
  } else if (range === "week") {
    end.setDate(end.getDate() + 7);
  } else {
    end.setDate(end.getDate() + 1); // today
  }
  return { start, end };
}

/**
 * Events for a range ("today" | "tomorrow" | "week"), sorted by start time:
 *   [{ id, title, start: ISO, end: ISO|null, allDay: bool, location: string|null }]
 *
 * Google Calendar once connected; otherwise the local sample file.
 */
export async function getEvents(range = "today") {
  const { start, end } = windowFor(range);
  const events = (await googleCal.isConnected())
    ? await googleCal.getEvents(start, end)
    : await readLocal();

  return events
    .filter((e) => {
      const s = new Date(e.start);
      return s >= start && s < end;
    })
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

/** Back-compat: today's events, for GET /api/schedule. */
export function getSchedule() {
  return getEvents("today");
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
