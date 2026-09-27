import { useEffect, useRef } from "react";
import { useServerEvents } from "./useServerEvents.js";

// While the assistant is engaged, music drops to this fraction of its volume:
// the command after the wake phrase is captured over quieter music, and the
// reply is audible.
export const DUCK_LEVEL = 0.2;
const ENGAGED = new Set(["wake", "listening", "thinking", "speaking"]);
const RAMP_MS = 250;
const RAMP_STEPS = 10;

/** True while the voice assistant is mid-conversation. */
export function useDucked() {
  const { voice } = useServerEvents();
  return ENGAGED.has(voice?.state);
}

/**
 * Ramp a volume setter between full and ducked whenever the assistant
 * engages or goes idle. `setVolume(v)` receives 0..1 (already scaled by
 * `base`); `base` is the un-ducked volume.
 */
export function useDuckedVolume(setVolume, base = 1) {
  const ducked = useDucked();
  const current = useRef(base);

  useEffect(() => {
    const target = base * (ducked ? DUCK_LEVEL : 1);
    const from = current.current;
    // Timers, not requestAnimationFrame: rAF stops entirely when the page
    // isn't visible, and the mirror must still duck its music then. (Hidden
    // tabs clamp timers to ~1s, so just jump straight to the target.)
    if (typeof document !== "undefined" && document.hidden) {
      current.current = target;
      setVolume(target);
      return undefined;
    }
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      const v = from + ((target - from) * i) / RAMP_STEPS;
      current.current = v;
      setVolume(v);
      if (i >= RAMP_STEPS) clearInterval(id);
    }, RAMP_MS / RAMP_STEPS);
    return () => clearInterval(id);
    // setVolume is expected to be stable (a ref-backed callback)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ducked, base]);

  return ducked;
}
