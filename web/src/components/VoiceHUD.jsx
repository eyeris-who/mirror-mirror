import { useEffect, useRef } from "react";
import { usePolling } from "../hooks/usePolling.js";

const TIER = {
  0: "local · rules",
  1: "local · model",
  2: "cloud",
};

const STATUS = {
  wake: "…",
  listening: "Listening",
  thinking: "Thinking",
};

/** Bottom overlay that shows what the voice assistant is doing. Hidden at idle. */
export default function VoiceHUD() {
  const { data } = usePolling("/api/voice/state", 1000);
  const lastAction = useRef("");

  // e.g. free Spotify account: "play my playlist" opens the playlist page.
  useEffect(() => {
    const a = data?.action;
    if (a?.type === "open_url" && a.url && a.url !== lastAction.current) {
      lastAction.current = a.url;
      window.open(a.url, "_blank", "noopener");
    }
  }, [data?.action]);

  const state = data?.state;
  if (!state || state === "idle") return null;

  return (
    <div className="voicehud">
      <span className="voicehud__dot" data-state={state} />
      <div className="voicehud__body">
        {data.transcript ? (
          <div className="voicehud__you">"{data.transcript}"</div>
        ) : (
          STATUS[state] && <div className="voicehud__status">{STATUS[state]}</div>
        )}
        {state === "speaking" && data.response && (
          <div className="voicehud__reply">{data.response}</div>
        )}
        {state === "speaking" && TIER[data.tier] && (
          <div className="voicehud__tier">{TIER[data.tier]}</div>
        )}
      </div>
    </div>
  );
}
