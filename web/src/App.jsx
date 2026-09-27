import DateTime from "./components/DateTime.jsx";
import Weather from "./components/Weather.jsx";
import Schedule from "./components/Schedule.jsx";
import Character from "./components/Character.jsx";
import Reminders from "./components/Reminders.jsx";
import MusicPlayer from "./components/MusicPlayer.jsx";
import VoiceHUD from "./components/VoiceHUD.jsx";
import Setup from "./Setup.jsx";
import { useEffect, useState } from "react";
import { useServerEvents } from "./hooks/useServerEvents.js";
import { useSpotifyPlayer } from "./hooks/useSpotifyPlayer.js";

// An always-on display showing the same layout for months will burn in. Every
// few minutes, nudge everything by a few pixels — invisible to a person.
const DRIFT_EVERY_MS = 3 * 60_000;
const DRIFT_PX = 3;

function useBurnInDrift() {
  const [offset, setOffset] = useState([0, 0]);
  useEffect(() => {
    const px = () => Math.round((Math.random() * 2 - 1) * DRIFT_PX);
    const id = setInterval(() => setOffset([px(), px()]), DRIFT_EVERY_MS);
    return () => clearInterval(id);
  }, []);
  return offset;
}

const setDisplay = (on) =>
  fetch("/api/display", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ on }),
  }).catch(() => {});

function Mirror() {
  // Register this browser as the "Smart Mirror" Spotify device so music can
  // play through the laptop speakers. No-op until Spotify is connected.
  useSpotifyPlayer(true);

  // "go to sleep" / "wake up" — server holds the state (pushed over SSE), page
  // fades to black.
  const { display } = useServerEvents();
  const asleep = display?.on === false;
  const [dx, dy] = useBurnInDrift();

  return (
    <>
      <main
        className={`mirror${asleep ? " mirror--asleep" : ""}`}
        style={{ transform: `translate(${dx}px, ${dy}px)` }}
      >
        <section className="col col--left">
          <DateTime />
          <Weather />
          <MusicPlayer />
        </section>

        <section className="col col--right">
          <Schedule />
          <Reminders />
          <Character />
        </section>

        <VoiceHUD />
      </main>

      {asleep && (
        <div
          className="mirror__wake"
          title="tap to wake"
          onClick={() => setDisplay(true)}
        />
      )}
    </>
  );
}

export default function App() {
  if (window.location.pathname.startsWith("/setup")) return <Setup />;
  return <Mirror />;
}
