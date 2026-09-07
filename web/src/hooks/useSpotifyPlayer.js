import { useEffect, useState } from "react";

/**
 * Loads the Spotify Web Playback SDK and registers this browser as a Spotify
 * Connect device called "Smart Mirror", so the laptop's speakers become the
 * mirror's output. Requires Spotify Premium — it self-gates on /api/status and
 * does nothing (no script, no errors) when Spotify isn't a connected account.
 */
export function useSpotifyPlayer(enabled = true) {
  const [deviceId, setDeviceId] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let player;
    let cancelled = false;

    fetch("/api/status")
      .then((r) => r.json())
      .then((s) => {
        // only when Spotify is the *active* source (i.e. a Premium account)
        if (cancelled || s?.music?.source !== "spotify") return;

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

        const script = document.createElement("script");
        script.src = "https://sdk.scdn.co/spotify-player.js";
        script.async = true;
        script.id = "spotify-sdk";
        document.body.appendChild(script);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      player?.disconnect();
      document.getElementById("spotify-sdk")?.remove();
      window.onSpotifyWebPlaybackSDKReady = () => {};
    };
  }, [enabled]);

  return { deviceId, ready };
}
