import { getTokens, setTokens, clearTokens } from "./tokenStore.js";

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI = "http://localhost:3001/api/auth/spotify/callback",
} = process.env;

// streaming + playback control (needs Spotify Premium to actually play).
const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
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
    expires_at: Date.now() + t.expires_in * 1000,
  });
}

export async function isConnected() {
  return Boolean(await getTokens("spotify"));
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
  if (!res.ok) throw new Error(`spotify ${method} ${path} → ${res.status}`);
  return res.json();
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
  api(
    `/me/player/play${opts.deviceId ? `?device_id=${opts.deviceId}` : ""}`,
    { method: "PUT", body: opts.contextUri ? { context_uri: opts.contextUri } : opts.uris ? { uris: opts.uris } : undefined },
  );
export const pause = () => api("/me/player/pause", { method: "PUT" });
export const next = () => api("/me/player/next", { method: "POST" });
export const previous = () => api("/me/player/previous", { method: "POST" });
export const transfer = (deviceId, playNow = true) =>
  api("/me/player", {
    method: "PUT",
    body: { device_ids: [deviceId], play: playNow },
  });

/** Search + play the first matching playlist/track. `type` = "playlist"|"track". */
export async function playSearch(query, type = "playlist") {
  const r = await api(
    `/search?q=${encodeURIComponent(query)}&type=${type}&limit=1`,
  );
  const item = r[`${type}s`]?.items?.[0];
  if (!item) throw new Error("nothing_found");
  if (type === "track") return play({ uris: [item.uri] });
  return play({ contextUri: item.uri });
}
