import { useSyncExternalStore } from "react";

/**
 * Live server state pushed over Server-Sent Events (`/api/events`):
 *   { display: { on }, voice: { state, transcript, response, tier, … } }
 *
 * One EventSource is shared by every component that uses this hook (the page,
 * the voice HUD and the character all read it), and the browser reconnects on
 * its own if the server restarts. Values are null until the first event.
 */

let snapshot = { display: null, voice: null, connected: false };
const listeners = new Set();
let source = null;

function emit(patch) {
  snapshot = { ...snapshot, ...patch };
  for (const fn of listeners) fn();
}

function parse(e) {
  try {
    return JSON.parse(e.data);
  } catch {
    return null;
  }
}

function connect() {
  if (source) return;
  source = new EventSource("/api/events");
  source.addEventListener("display", (e) => emit({ display: parse(e) }));
  source.addEventListener("voice", (e) => emit({ voice: parse(e) }));
  source.onopen = () => emit({ connected: true });
  source.onerror = () => emit({ connected: false }); // EventSource retries itself
}

function subscribe(fn) {
  listeners.add(fn);
  connect();
  return () => {
    listeners.delete(fn);
    if (!listeners.size && source) {
      source.close();
      source = null;
    }
  };
}

export function useServerEvents() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
