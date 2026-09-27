// In-process pub/sub for things the mirror page should see the moment they
// change (display on/off, voice state). Streamed to the browser over
// Server-Sent Events at /api/events instead of the page polling every second.

const listeners = new Set();

export function publish(type, data) {
  for (const fn of listeners) {
    try {
      fn(type, data);
    } catch {
      /* a broken stream shouldn't stop the others */
    }
  }
}

/** Returns an unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
