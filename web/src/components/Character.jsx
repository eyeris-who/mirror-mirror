import { useEffect, useRef, useState } from "react";
import { usePolling } from "../hooks/usePolling.js";

/**
 * Placeholder for the animated character. It already computes the live state —
 * drop the animation runtime in where noted and drive it from `state`.
 *
 * States: "idle" | "talking" | "sleeping" | "going to sleep" | "waking up"
 */
export default function Character() {
  const { data: display } = usePolling("/api/display", 2000);
  const { data: voice } = usePolling("/api/voice/state", 1000);

  const awake = display?.on !== false;
  const [transition, setTransition] = useState(null);
  const prevAwake = useRef(awake);

  useEffect(() => {
    if (display == null || awake === prevAwake.current) return;
    setTransition(awake ? "waking up" : "going to sleep");
    prevAwake.current = awake;
    const t = setTimeout(() => setTransition(null), 1600);
    return () => clearTimeout(t);
  }, [awake, display]);

  const state = transition
    ? transition
    : !awake
      ? "sleeping"
      : voice?.state === "speaking"
        ? "talking"
        : "idle";

  return (
    <div className="character" data-state={state}>
      {/* --- swap this box for the animation ---
          Rive:   <Rive src="/character.riv" stateMachines="mirror" ... />
          Lottie: <Lottie animationData={clips[state]} loop /> (cross-fade on change)
      */}
      <div className="character__box">
        <span className="character__label">Character</span>
        <span className="character__state">{state}</span>
      </div>
    </div>
  );
}
