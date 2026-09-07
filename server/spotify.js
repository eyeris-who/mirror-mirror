import { getTokens, setTokens, clearTokens } from "./tokenStore.js";

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  // Spotify rejects "localhost" — must be the loopback IP 127.0.0.1 (or [::1]).
  SPOTIFY_REDIRECT_URI = "http://127.0.0.1:3001/api/auth/spotify/callback",
} = process.env;

// Playback control (needs Premium) + reading the user's own playlists.
const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "playlist-read-private",
  "playlist-read-collaborative",
].join(" ");

const AUTH = "https://accounts.spotify.com";
const API = "https://api.spotify.com/v1";

export function isConfigured() {
  return Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET);
}

export function authUrl(state = "mirror") {
  const u = new URL(`${AUTH}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", SPOTIFY_CLIENT_ID);
  u.searchParams.set("scope", SCOPES);
  u.searchParams.set("redirect_uri", SPOTIFY_REDIRECT_URI);
  u.searchParams.set("state", state);
  // Force the consent screen so re-connecting picks up newly-added scopes
  // instead of silently reusing the previous authorization.
  u.searchParams.set("show_dialog", "true");
  return u.toString();
}

function basicAuth() {
  return Buffer.from(
    `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`,
  ).toString("base64");
}

export async function handleCallback(code) {
  const res = await fetch(`${AUTH}/api/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
    }),
  });
  if (!res.ok) throw new Error(`spotify token exchange ${res.status}`);
  const t = await res.json();
  await setTokens("spotify", {
    ...t,
    scope: t.scope,
    expires_at: Date.now() + t.expires_in * 1000,
  });
}

export async function isConnected() {
  return Boolean(await getTokens("spotify"));
}

/** Scopes actually granted on the stored token (helps spot a stale re-auth). */
export async function grantedScopes() {
  const t = await getTokens("spotify");
  return t?.scope ? t.scope.split(" ") : [];
}

export async function disconnect() {
  await clearTokens("spotify");
}

/** Returns a valid access token, refreshing if it is within 60s of expiry. */
export async function getAccessToken() {
  const t = await getTokens("spotify");
  if (!t) throw new Error("spotify_not_connected");
  if (t.access_token && Date.now() < (t.expires_at ?? 0) - 60_000) {
    return t.access_token;
  }
  const res = await fetch(`${AUTH}/api/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
    }),
  });
  if (!res.ok) throw new Error(`spotify refresh ${res.status}`);
  const fresh = await res.json();
  const saved = await setTokens("spotify", {
    ...fresh,
    refresh_token: fresh.refresh_token ?? t.refresh_token,
    scope: fresh.scope ?? t.scope,
    expires_at: Date.now() + fresh.expires_in * 1000,
  });
  return saved.access_token;
}

async function api(path, { method = "GET", body } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null; // no content (typical for controls)
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(
      `spotify ${method} ${path.split("?")[0]} → ${res.status} ${detail}`.trim(),
    );
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** The user's profile — `.product` is "premium" | "free" | "open". */
export async function me() {
  return api("/me");
}

/** True only for a Premium account (playback control needs it). Cached briefly. */
let premiumCache = { at: 0, value: false };
export async function isPremium() {
  if (Date.now() - premiumCache.at < 60_000) return premiumCache.value;
  let value = false;
  try {
    value = (await me()).product === "premium";
  } catch {
    value = false;
  }
  premiumCache = { at: Date.now(), value };
  return value;
}

export async function nowPlaying() {
  const data = await api("/me/player");
  if (!data || !data.item) return { playing: false };
  return {
    playing: data.is_playing,
    track: data.item.name,
    artists: data.item.artists.map((a) => a.name).join(", "),
    album: data.item.album?.name ?? null,
    artUrl: data.item.album?.images?.[0]?.url ?? null,
    device: data.device?.name ?? null,
    progressMs: data.progress_ms,
    durationMs: data.item.duration_ms,
  };
}

export const play = (opts = {}) =>
  api(`/me/player/play${opts.deviceId ? `?device_id=${opts.deviceId}` : ""}`, {
    method: "PUT",
    body: opts.contextUri
      ? { context_uri: opts.contextUri }
      : opts.uris
        ? { uris: opts.uris }
        : undefined,
  });
export const pause = () => api("/me/player/pause", { method: "PUT" });
export const next = () => api("/me/player/next", { method: "POST" });
export const previous = () => api("/me/player/previous", { method: "POST" });
export const transfer = (deviceId, playNow = true) =>
  api("/me/player", {
    method: "PUT",
    body: { device_ids: [deviceId], play: playNow },
  });

/** The user's own playlists (owned + followed), newest first. */
export async function listPlaylists(max = 100) {
  const out = [];
  let url = `/me/playlists?limit=50`;
  while (url && out.length < max) {
    const page = await api(url);
    for (const p of page.items ?? []) {
      if (!p) continue;
      out.push({
        id: p.id,
        name: p.name,
        uri: p.uri,
        owner: p.owner?.display_name ?? "",
        tracks: p.tracks?.total ?? 0,
        image: p.images?.[0]?.url ?? null,
      });
    }
    url = page.next ? page.next.replace(API, "") : null;
  }
  return out;
}

export const playPlaylistById = (id, deviceId) =>
  play({ contextUri: `spotify:playlist:${id}`, deviceId });

/** Fallback when we only have a name: search, then play the first hit. */
export async function playSearch(query, type = "playlist") {
  const r = await api(
    `/search?q=${encodeURIComponent(query)}&type=${type}&limit=1`,
  );
  const item = r[`${type}s`]?.items?.[0];
  if (!item) throw new Error("nothing_found");
  if (type === "track") return play({ uris: [item.uri] });
  return play({ contextUri: item.uri });
}
