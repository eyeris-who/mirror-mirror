// Local embeddings via Ollama — personal data never leaves the machine.
//   ollama pull nomic-embed-text

import { createHash } from "node:crypto";
import { EMBED_DIM } from "./db.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.EMBED_MODEL || "nomic-embed-text";

// EMBED_FAKE=1 uses a crude local hashing embedding instead of Ollama — lets the
// eval harness and pipeline run without pulling a model. Retrieval quality is
// much lower; it is only for wiring checks / CI.
const FAKE = process.env.EMBED_FAKE === "1";

function fakeEmbed(text) {
  const v = new Float64Array(EMBED_DIM);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) || []) {
    const h = createHash("md5").update(w).digest();
    for (let i = 0; i < 8; i++) {
      v[h[i] % EMBED_DIM] += ((h[i + 8] & 1) ? 1 : -1) * (1 / (1 + i));
    }
  }
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  return Array.from(v, (x) => x / norm);
}

export async function available() {
  if (FAKE) return true;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(700),
    });
    if (!r.ok) return false;
    const { models = [] } = await r.json();
    return models.some((m) => (m.name || "").startsWith(MODEL));
  } catch {
    return false;
  }
}

/** Embed one string → Float32-friendly number[]. */
export async function embed(text) {
  if (FAKE) return fakeEmbed(text);
  const [v] = await embedBatch([text]);
  return v;
}

/** Embed many strings. Ollama's embed endpoint takes them one at a time, so we
 *  pipeline a few concurrently. */
export async function embedBatch(texts, concurrency = 4) {
  if (FAKE) return texts.map(fakeEmbed);
  const out = new Array(texts.length);
  let i = 0;

  async function worker() {
    while (i < texts.length) {
      const idx = i++;
      const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, prompt: texts[idx] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) throw new Error(`ollama embeddings ${r.status}`);
      const { embedding } = await r.json();
      out[idx] = embedding;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, texts.length) }, worker),
  );
  return out;
}
