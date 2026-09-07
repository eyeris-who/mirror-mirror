// Audius — free, keyless, full-length tracks from independent artists.
// Used as the fallback music source when Spotify isn't a connected Premium
// account. Docs: https://docs.audius.org/api/

const APP = process.env.AUDIUS_APP_NAME || "mirror-mirror";

let host = null;
let hostAt = 0;
const HOST_TTL = 60 * 60 * 1000;

async function getHost() {
  if (host && Date.now() - hostAt < HOST_TTL) return host;
  const r = await fetch("https://api.audius.co");
  if (!r.ok) throw new Error(`audius host discovery ${r.status}`);
  const { data = [] } = await r.json();
  if (!data.length) throw new Error("no audius hosts");
  host = data[Math.floor(Math.random() * data.length)];
  hostAt = Date.now();
  return host;
}

function normalize(t, h) {
  const art = t.artwork || {};
  return {
    source: "audius",
    id: t.id,
    title: t.title,
    artist: t.user?.name ?? "",
    durationMs: t.duration ? t.duration * 1000 : null,
    artworkUrl: art["480x480"] || art["150x150"] || null,
    // <audio> follows the 302 this returns to the real audio file.
    streamUrl: `${h}/v1/tracks/${t.id}/stream?app_name=${encodeURIComponent(APP)}`,
  };
}

async function get(path, params) {
  const h = await getHost();
  const u = new URL(`${h}${path}`);
  u.searchParams.set("app_name", APP);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null) u.searchParams.set(k, v);
  }
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`audius ${path} ${r.status}`);
  const { data = [] } = await r.json();
  return { data, host: h };
}

export async function search(query, limit = 30) {
  const { data, host: h } = await get("/v1/tracks/search", { query });
  return data
    .filter((t) => t.is_streamable !== false && t.duration)
    .slice(0, limit)
    .map((t) => normalize(t, h));
}

// Spoken genre words -> the exact strings Audius's trending endpoint expects.
const GENRE_ALIASES = {
  lofi: "Lo-Fi",
  "lo fi": "Lo-Fi",
  "lo-fi": "Lo-Fi",
  chillhop: "Lo-Fi",
  "hip hop": "Hip-Hop/Rap",
  hiphop: "Hip-Hop/Rap",
  rap: "Hip-Hop/Rap",
  edm: "Electronic",
  electronic: "Electronic",
  dance: "Electronic",
  "deep house": "Deep House",
  "tech house": "Tech House",
  house: "House",
  techno: "Techno",
  trance: "Trance",
  dubstep: "Dubstep",
  dnb: "Drum & Bass",
  "drum and bass": "Drum & Bass",
  "drum n bass": "Drum & Bass",
  trap: "Trap",
  "future bass": "Future Bass",
  ambient: "Ambient",
  jazz: "Jazz",
  acoustic: "Acoustic",
  folk: "Folk",
  rock: "Rock",
  metal: "Metal",
  punk: "Punk",
  pop: "Pop",
  classical: "Classical",
  rnb: "R&B/Soul",
  "r and b": "R&B/Soul",
  "r&b": "R&B/Soul",
  soul: "R&B/Soul",
  funk: "Funk",
  reggae: "Reggae",
  country: "Country",
  blues: "Blues",
  latin: "Latin",
  world: "World",
  experimental: "Experimental",
  hyperpop: "Hyperpop",
  disco: "Disco",
  downtempo: "Downtempo",
};

export function toAudiusGenre(s) {
  const k = (s || "").trim().toLowerCase();
  if (!k) return undefined;
  if (GENRE_ALIASES[k]) return GENRE_ALIASES[k];
  return k.replace(/\b\w/g, (c) => c.toUpperCase()); // last-ditch: Title Case
}

/** Audius's trending chart (top ~100), shuffled and trimmed. */
export async function trending(genre, limit = 40) {
  const { data, host: h } = await get("/v1/tracks/trending", {
    genre: toAudiusGenre(genre),
  });
  const tracks = data
    .filter((t) => t.is_streamable !== false && t.duration)
    .map((t) => normalize(t, h));
  return shuffle(tracks).slice(0, limit);
}

/** Best-effort track list for a query: search, falling back to trending. */
export async function tracksFor(query, limit = 40) {
  const q = (query || "").trim();
  if (q) {
    const hits = await search(q, limit);
    if (hits.length) return hits;
  }
  return trending(undefined, limit);
}

function shuffle(a) {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}
