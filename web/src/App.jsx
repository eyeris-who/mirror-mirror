import DateTime from "./components/DateTime.jsx";
import Weather from "./components/Weather.jsx";
import Schedule from "./components/Schedule.jsx";
import MusicPlayer from "./components/MusicPlayer.jsx";
import VoiceHUD from "./components/VoiceHUD.jsx";
import Setup from "./Setup.jsx";
import { usePolling } from "./hooks/usePolling.js";
import { useSpotifyPlayer } from "./hooks/useSpotifyPlayer.js";

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

  // "go to sleep" / "wake up" — server holds the state, page fades to black.
  const { data: display } = usePolling("/api/display", 2000);
  const asleep = display?.on === false;

  return (
    <>
      <main className={`mirror${asleep ? " mirror--asleep" : ""}`}>
        <section className="col col--left">
          <DateTime />
          <Weather />
          <MusicPlayer />
        </section>

        <section className="col col--right">
          <Schedule />
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
