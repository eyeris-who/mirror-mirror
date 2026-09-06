import { useEffect, useState } from "react";

/**
 * Loads the Spotify Web Playback SDK and registers this browser as a Spotify
 * Connect device called "Smart Mirror". Once ready, you can start playback on
 * it (e.g. POST /api/spotify/transfer { deviceId }) and the laptop's speakers
 * become the mirror's audio output. Requires Spotify Premium.
 */
export function useSpotifyPlayer(enabled) {
  const [deviceId, setDeviceId] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let player;

    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    document.body.appendChild(script);

    window.onSpotifyWebPlaybackSDKReady = () => {
      player = new window.Spotify.Player({
        name: "Smart Mirror",
        volume: 0.6,
        getOAuthToken: (cb) =>
          fetch("/api/spotify/token")
            .then((r) => r.json())
            .then((d) => d.token && cb(d.token))
            .catch(() => {}),
      });

      player.addListener("ready", ({ device_id }) => {
        setDeviceId(device_id);
        setReady(true);
      });
      player.addListener("not_ready", () => setReady(false));
      player.addListener("initialization_error", (e) => console.error(e));
      player.addListener("authentication_error", (e) => console.error(e));
      player.connect();
    };

    return () => {
      player?.disconnect();
      script.remove();
      delete window.onSpotifyWebPlaybackSDKReady;
    };
  }, [enabled]);

  return { deviceId, ready };
}
