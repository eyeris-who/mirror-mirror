import { usePolling } from "../hooks/usePolling.js";

/** Shows the current Spotify track, or nothing when playback is stopped. */
export default function NowPlaying() {
  const { data } = usePolling("/api/spotify/now-playing", 5000);

  if (!data || data.error || !data.playing) return null;

  return (
    <div className="nowplaying">
      {data.artUrl && (
        <img className="nowplaying__art" src={data.artUrl} alt="" />
      )}
      <div className="nowplaying__meta">
        <div className="nowplaying__track">{data.track}</div>
        <div className="nowplaying__artist">{data.artists}</div>
      </div>
    </div>
  );
}
