import { useEffect, useReducer, useRef, useState } from "react";
import { usePolling } from "../hooks/usePolling.js";

const fmt = (ms) => {
  if (!ms || ms < 0) return "0:00";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const post = (body) =>
  fetch("/api/music/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});

/**
 * ONE hidden <audio> element (never conditionally swapped — that spawned a
 * detached element that kept playing = double audio, and broke autoplay because
 * each new element needs its own user-gesture activation). Server state drives
 * it; it reports real position back and asks the server to advance on `ended`.
 * For Spotify (Premium) it's display-only — the Spotify SDK owns playback.
 */
export default function MusicPlayer() {
  const { data } = usePolling("/api/music/state", 1000);
  const audio = useRef(null);
  const curUrl = useRef(null);
  const [blocked, setBlocked] = useState(false);
  const [, tick] = useReducer((x) => x + 1, 0);

  const isAudius = data?.source === "audius";
  const track = data?.track;
  const playing = Boolean(data?.playing);

  // If the mirror is open in more than one tab, only the newest one makes sound
  // (otherwise you hear the same track twice, slightly out of sync).
  const birth = useRef(Date.now() + Math.random());
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    let bc;
    try {
      bc = new BroadcastChannel("mirror-music");
    } catch {
      return;
    }
    bc.onmessage = (e) => {
      if (e.data?.birth > birth.current) {
        setMuted(true);
        if (audio.current) audio.current.muted = true;
      }
    };
    bc.postMessage({ birth: birth.current });
    return () => bc.close();
  }, []);

  const title = isAudius ? track?.title : track; // spotify: track is a name string
  const artist = isAudius ? track?.artist : data?.artists;
  const art = isAudius ? track?.artworkUrl : data?.artUrl;
  const durationMs = (isAudius ? track?.durationMs : data?.durationMs) || 0;
  const serverPos = (isAudius ? data?.positionMs : data?.progressMs) || 0;

  // Reconcile the <audio> element with server state.
  useEffect(() => {
    const a = audio.current;
    if (!a) return;

    if (!isAudius || !track?.streamUrl) {
      if (!a.paused) a.pause();
      curUrl.current = null;
      return;
    }

    const tryPlay = () =>
      a.play().then(
        () => setBlocked(false),
        () => setBlocked(true),
      );

    if (track.streamUrl !== curUrl.current) {
      curUrl.current = track.streamUrl;
      a.src = track.streamUrl;
      a.load();
      if (playing) tryPlay();
      return;
    }
    if (playing && a.paused) tryPlay();
    if (!playing && !a.paused) a.pause();
    if (Math.abs(a.currentTime * 1000 - serverPos) > 3000) {
      a.currentTime = serverPos / 1000;
    }
  }, [isAudius, track?.streamUrl, playing, serverPos]);

  // Heartbeat: report real position; repaint the bar.
  useEffect(() => {
    const id = setInterval(() => {
      const a = audio.current;
      if (isAudius && a && !a.paused) {
        post({ positionMs: Math.round(a.currentTime * 1000) });
      }
      tick();
    }, 1000);
    return () => clearInterval(id);
  }, [isAudius]);

  // Unlock autoplay on the first interaction with the page.
  useEffect(() => {
    const unlock = () => {
      const a = audio.current;
      if (a && a.paused && curUrl.current) a.play().catch(() => {});
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const livePos =
    isAudius && audio.current && !audio.current.paused
      ? audio.current.currentTime * 1000
      : serverPos;
  const pct = durationMs ? Math.min(100, (livePos / durationMs) * 100) : 0;

  const send = (path) => fetch(path, { method: "POST" }).catch(() => {});
  // Act on the local <audio> immediately so a click isn't undone by the
  // 1s heartbeat before the server round-trips.
  const toggle = () => {
    const a = audio.current;
    if (isAudius && a) (playing ? a.pause() : a.play().catch(() => {}));
    send(playing ? "/api/music/pause" : "/api/music/resume");
  };
  const step = (path) => {
    if (isAudius && audio.current) audio.current.pause();
    send(path);
  };

  return (
    <>
      <audio ref={audio} hidden onEnded={() => post({ ended: true })} />

      {title && (
        <div className="player">
          {art && <img className="player__art" src={art} alt="" />}
          <div className="player__meta">
            <div className="player__title">{title}</div>
            {artist && <div className="player__artist">{artist}</div>}

            <div className="player__bar">
              <div className="player__fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="player__times">
              <span>{fmt(livePos)}</span>
              <span>{fmt(durationMs)}</span>
            </div>

            <div className="player__controls">
              <button onClick={() => step("/api/music/previous")} aria-label="previous">
                ‹‹
              </button>
              <button onClick={toggle} aria-label={playing ? "pause" : "play"}>
                {playing ? "❚❚" : "▶"}
              </button>
              <button onClick={() => step("/api/music/next")} aria-label="next">
                ››
              </button>
            </div>
            {blocked && (
              <div className="player__hint">tap the mirror once to enable audio</div>
            )}
            {muted && (
              <div className="player__hint">muted — playing in another tab</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
