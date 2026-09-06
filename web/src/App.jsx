import DateTime from "./components/DateTime.jsx";
import Weather from "./components/Weather.jsx";
import Schedule from "./components/Schedule.jsx";
import NowPlaying from "./components/NowPlaying.jsx";
import Setup from "./Setup.jsx";
import { useSpotifyPlayer } from "./hooks/useSpotifyPlayer.js";

function Mirror() {
  // Register this browser as the "Smart Mirror" Spotify device so music can
  // play through the laptop speakers. No-op until Spotify is connected.
  useSpotifyPlayer(true);

  return (
    <main className="mirror">
      <section className="col col--left">
        <DateTime />
        <Weather />
        <NowPlaying />
      </section>

      <section className="col col--right">
        <Schedule />
      </section>
    </main>
  );
}

export default function App() {
  if (window.location.pathname.startsWith("/setup")) return <Setup />;
  return <Mirror />;
}
