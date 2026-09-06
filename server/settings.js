import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "data", "settings.json");

// Runtime settings the user can change from /setup. Seeded from .env, then
// overridden by whatever is saved here. Gitignored (machine-specific).
const DEFAULTS = {
  location: {
    name: process.env.DEFAULT_CITY || "Toronto",
    admin1: process.env.DEFAULT_REGION || "Ontario",
    country: process.env.DEFAULT_COUNTRY || "Canada",
    countryCode: "",
    latitude: Number(process.env.LATITUDE || 43.6495374),
    longitude: Number(process.env.LONGITUDE || -79.3817104),
  },
};
let mem = null;

async function load() {
  if (mem) return mem;
  try {
    mem = { ...DEFAULTS, ...JSON.parse(await readFile(FILE, "utf8")) };
  } catch {
    mem = { ...DEFAULTS };
  }
  return mem;
}

export async function getSettings() {
  return load();
}

export async function setLocation(location) {
  const all = await load();
  all.location = location;
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(all, null, 2));
  return all.location;
}
