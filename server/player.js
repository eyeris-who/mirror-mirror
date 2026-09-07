// In-memory player for browser-streamed audio (Audius). The server owns the
// queue + index + playing flag; the mirror page plays state().track.streamUrl
// and reports its real position back via report(). Voice commands and the
// on-screen controls both mutate this.
//
// Spotify Premium playback does NOT go through here — it's driven by the
// Spotify Web Playback SDK / Connect API in spotify.js. musicctl.js picks.

const p = {
  queue: [], // resolved track objects (see audius.normalize)
  index: 0,
  playing: false,
  positionMs: 0,
  source: "", // label for the current queue
  updatedAt: Date.now(),
};

const touch = () => {
  p.updatedAt = Date.now();
};

export function load(tracks, sourceLabel = "") {
  p.queue = tracks;
  p.index = 0;
  p.positionMs = 0;
  p.playing = tracks.length > 0;
  p.source = sourceLabel;
  touch();
  return state();
}

export function pause() {
  p.playing = false;
  touch();
  return state();
}

export function resume() {
  if (p.queue.length) p.playing = true;
  touch();
  return state();
}

export function next() {
  if (p.index < p.queue.length - 1) {
    p.index += 1;
    p.positionMs = 0;
    p.playing = true;
  } else {
    p.playing = false; // end of queue
  }
  touch();
  return state();
}

export function previous() {
  // >3s into a track, "back" restarts it (like every music player)
  if (p.positionMs > 3000 || p.index === 0) {
    p.positionMs = 0;
  } else {
    p.index -= 1;
    p.positionMs = 0;
  }
  p.playing = p.queue.length > 0;
  touch();
  return state();
}

export function seek(ms) {
  p.positionMs = Math.max(0, ms | 0);
  touch();
  return state();
}

/**
 * Browser heartbeat — reports real playback position, and asks to advance when
 * a track ends. It does NOT set `playing`: the server owns that (so a voice
 * "pause" isn't immediately undone by an in-flight heartbeat).
 */
export function report({ positionMs, ended } = {}) {
  if (ended) return next();
  if (typeof positionMs === "number") p.positionMs = positionMs;
  touch();
  return state();
}

export function hasQueue() {
  return p.queue.length > 0;
}

export function state() {
  const track = p.queue[p.index] ?? null;
  return {
    track, // { source, id, title, artist, durationMs, artworkUrl, streamUrl } | null
    playing: p.playing,
    index: p.index,
    queueLength: p.queue.length,
    positionMs: p.positionMs,
    label: p.source, // what the queue was built from (query/playlist name)
    history: p.queue.slice(Math.max(0, p.index - 5), p.index).map((t) => t.title),
    upNext: p.queue.slice(p.index + 1, p.index + 6).map((t) => t.title),
  };
}
