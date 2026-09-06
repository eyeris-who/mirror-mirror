import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(here, "data", "schedule.json");

/**
 * Returns today's events, sorted by start time:
 *   [{ id, title, start: ISO, end: ISO, allDay: bool, location? }]
 *
 * For now this reads a local JSON file. To switch to Google Calendar later,
 * replace the body of this function with an API call and keep the return shape
 * identical — nothing else in the app needs to change.
 */
export async function getSchedule() {
  const rows = JSON.parse(await readFile(DATA_FILE, "utf8"));

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  return rows
    .map((r, i) => ({
      id: r.id ?? String(i),
      title: r.title,
      location: r.location ?? null,
      allDay: Boolean(r.allDay),
      start: new Date(r.start),
      end: r.end ? new Date(r.end) : null,
    }))
    .filter((e) => e.start >= startOfDay && e.start < endOfDay)
    .sort((a, b) => a.start - b.start)
    .map((e) => ({
      ...e,
      start: e.start.toISOString(),
      end: e.end ? e.end.toISOString() : null,
    }));
}
