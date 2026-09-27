import { useEffect, useState } from "react";
import { useServerEvents } from "../hooks/useServerEvents.js";

/**
 * The mirror's face: a light line drawing (black is invisible through a
 * two-way mirror) animated entirely in CSS from `data-state`.
 *
 * States: "idle" | "listening" | "thinking" | "talking" | "sleeping"
 *         | "going to sleep" | "waking up"
 */
export default function Character() {
  const { display, voice } = useServerEvents();

  const awake = display?.on !== false;

  // Start the sleep/wake transition in the same render the change arrives in
  // (an effect would paint one frame of the old state first). The first value
  // from the server isn't a change, so loading the page while asleep doesn't
  // play "going to sleep".
  const [phase, setPhase] = useState({ awake: null, transition: null });
  if (display != null && phase.awake !== awake) {
    setPhase({
      awake,
      transition: phase.awake === null ? null : awake ? "waking up" : "going to sleep",
    });
  }
  useEffect(() => {
    if (!phase.transition) return;
    const t = setTimeout(() => setPhase((p) => ({ ...p, transition: null })), 1600);
    return () => clearTimeout(t);
  }, [phase]);

  const v = voice?.state;
  const state = phase.transition
    ? phase.transition
    : !awake
      ? "sleeping"
      : v === "speaking"
        ? "talking"
        : v === "listening" || v === "wake"
          ? "listening"
          : v === "thinking"
            ? "thinking"
            : "idle";

  return (
    <div className="character" data-state={state} role="img" aria-label={`mirror is ${state}`}>
      <svg className="character__face" viewBox="0 0 200 150" aria-hidden="true">
        <circle className="character__halo" cx="100" cy="75" r="56" />
        <circle className="character__ring" cx="100" cy="75" r="56" />

        <g className="character__eyes">
          <ellipse className="character__eye" cx="80" cy="68" rx="6.5" ry="10" />
          <ellipse className="character__eye" cx="120" cy="68" rx="6.5" ry="10" />
        </g>

        <path className="character__smile" d="M86 97 Q100 106 114 97" />
        <ellipse className="character__mouth" cx="100" cy="99" rx="9" ry="6" />

        <g className="character__dots">
          <circle cx="88" cy="112" r="2.4" />
          <circle cx="100" cy="112" r="2.4" />
          <circle cx="112" cy="112" r="2.4" />
        </g>

        <g className="character__z">
          <text x="146" y="44">z</text>
          <text x="158" y="28">z</text>
        </g>
      </svg>
    </div>
  );
}
