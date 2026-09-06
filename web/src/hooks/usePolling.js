import { useEffect, useRef, useState, useCallback } from "react";

/**
 * Fetch `url` now and then every `intervalMs`. Keeps the last good value on
 * error (a mirror should never flash to blank because Wi-Fi hiccuped).
 */
export function usePolling(url, intervalMs) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const timer = useRef(null);

  const tick = useCallback(async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [url]);

  useEffect(() => {
    tick();
    timer.current = setInterval(tick, intervalMs);
    return () => clearInterval(timer.current);
  }, [tick, intervalMs]);

  return { data, error };
}
