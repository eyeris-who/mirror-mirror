// Routes music commands to whichever source is active:
//   Spotify  — when a Premium account is connected (Free is rejected at /connect)
//   Audius   — otherwise (also the fallback for Premium users if Spotify errors)

import * as spotify from "./spotify.js";
import * as audius from "./audius.js";
import * as player from "./player.js";
import { getSettings } from "./settings.js";

export async function activeSource() {
  // New connections reject Free accounts, but an older token might linger —
  // double-check Premium here so Free never routes to Spotify.
  if ((await spotify.isConnected()) && (await spotify.isPremium())) {
    return "spotify";
  }
  return "audius";
}

async function playAudius(query) {
  const { assistant } = await getSettings();
  const q = query || assistant.morningPlaylist || "morning chill";
  const tracks = await audius.tracksFor(q, 40);
  if (!tracks.length) throw new Error("nothing_found");
  player.load(tracks, q);
  return { source: "audius", label: q, count: tracks.length };
}

export async function play({ query, trending, genre } = {}) {
  // Trending is an Audius chart — always play it from Audius, even for Premium.
  if (trending) {
    const tracks = await audius.trending(genre, 40);
    if (!tracks.length) throw new Error("nothing_found");
    const label = genre ? `trending ${genre}` : "trending";
    player.load(tracks, label);
    return { source: "audius", label, count: tracks.length, trending: true };
  }

  const src = await activeSource();

  if (src === "spotify") {
    const { assistant } = await getSettings();
    try {
      if (!query && assistant.morningPlaylistId) {
        await spotify.playPlaylistById(assistant.morningPlaylistId);
      } else {
        await spotify.playSearch(query || assistant.morningPlaylist || "morning", "playlist");
      }
      return { source: "spotify", label: query || assistant.morningPlaylist };
    } catch (err) {
      // Premium lapsed / no active device / restricted — fall back to Audius.
      console.error("spotify play failed, falling back to audius:", err.message);
      return playAudius(query);
    }
  }

  return playAudius(query);
}

export async function pause() {
  return (await activeSource()) === "spotify"
    ? spotify.pause()
    : player.pause();
}

export async function resume() {
  return (await activeSource()) === "spotify"
    ? spotify.play({})
    : player.resume();
}

export async function next() {
  return (await activeSource()) === "spotify"
    ? spotify.next()
    : player.next();
}

export async function previous() {
  return (await activeSource()) === "spotify"
    ? spotify.previous()
    : player.previous();
}

export function report(body) {
  return player.report(body); // Audius only — Spotify reports its own state
}

export async function state() {
  const src = await activeSource();
  if (src === "spotify") {
    try {
      return { ...(await spotify.nowPlaying()), source: "spotify" };
    } catch {
      return { source: "spotify", playing: false, track: null };
    }
  }
  return { ...player.state(), source: "audius" };
}
