import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "data", "settings.json");

// Runtime settings the user changes from /setup or by voice. Seeded from .env,
// then overridden by whatever is saved here. Gitignored (machine-specific).
const DEFAULTS = {
  location: {
    name: process.env.DEFAULT_CITY || "Toronto",
    admin1: process.env.DEFAULT_REGION || "Ontario",
    country: process.env.DEFAULT_COUNTRY || "Canada",
    countryCode: "",
    latitude: Number(process.env.LATITUDE || 43.6495374),
    longitude: Number(process.env.LONGITUDE || -79.3817104),
  },
  assistant: {
    wakePhrase: process.env.WAKE_PHRASE || "mirror mirror on the wall",
    ackPhrase: "Hmm?",
    userName: "",
    morningPlaylist: "", // display name
    morningPlaylistId: "", // Spotify playlist id (set when picked from the list)
    units: process.env.TEMPERATURE_UNIT || "fahrenheit", // "celsius" | "fahrenheit"
    // Ordered steps for "start my morning routine".
    morningRoutine: ["date", "time", "weather", "events", "playlist"],
    // Which model handles which tier — see server/agent/router.js.
    models: {
      local: process.env.OLLAMA_MODEL || "qwen3:8b",
      cloud: process.env.CLOUD_MODEL || "claude-opus-5",
    },
  },
};

let mem = null;

async function load() {
  if (mem) return mem;
  try {
    const saved = JSON.parse(await readFile(FILE, "utf8"));
    mem = {
      ...DEFAULTS,
      ...saved,
      location: { ...DEFAULTS.location, ...(saved.location ?? {}) },
      assistant: {
        ...DEFAULTS.assistant,
        ...(saved.assistant ?? {}),
        models: {
          ...DEFAULTS.assistant.models,
          ...(saved.assistant?.models ?? {}),
        },
      },
    };
  } catch {
    mem = structuredClone(DEFAULTS);
  }
  return mem;
}

export async function getSettings() {
  return load();
}

async function persist(all) {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(all, null, 2));
}

export async function setLocation(location) {
  const all = await load();
  all.location = location;
  await persist(all);
  return all.location;
}

export async function updateAssistant(patch) {
  const all = await load();
  all.assistant = { ...all.assistant, ...patch };
  await persist(all);
  return all.assistant;
}
