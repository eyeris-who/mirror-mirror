import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "data", "tokens.json");

// Shape: { google: {...oauth tokens}, spotify: {...oauth tokens} }
// This file holds refresh tokens — it is gitignored. Do not commit it.

let mem = null;

async function load() {
  if (mem) return mem;
  try {
    mem = JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    mem = {};
  }
  return mem;
}

export async function getTokens(service) {
  return (await load())[service] ?? null;
}

export async function setTokens(service, tokens) {
  const all = await load();
  all[service] = { ...(all[service] ?? {}), ...tokens };
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(all, null, 2));
  return all[service];
}

export async function clearTokens(service) {
  const all = await load();
  delete all[service];
  await writeFile(FILE, JSON.stringify(all, null, 2));
}
