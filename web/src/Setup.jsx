import { useEffect, useState } from "react";

function Row({ name, state, onConnect, onDisconnect, note }) {
  const { configured, connected } = state;
  return (
    <div className="setup__row setup__row--stack">
      <div className="setup__loc-head">
        <span className="setup__name">{name}</span>
        {!configured && (
          <span className="setup__hint">
            add credentials to <code>server/.env</code>, then restart the server
          </span>
        )}
        {configured && connected && (
          <span>
            <span className="setup__ok">connected</span>{" "}
            <button onClick={onDisconnect}>disconnect</button>
          </span>
        )}
        {configured && !connected && (
          <button onClick={onConnect}>connect</button>
        )}
      </div>
      {note && <span className="setup__hint">{note}</span>}
    </div>
  );
}

function LocationSetting() {
  const [current, setCurrent] = useState(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const loadCurrent = () =>
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => setCurrent(s.location))
      .catch(() => {});

  useEffect(() => {
    loadCurrent();
  }, []);

  // Debounced city search.
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      fetch(`/api/geo/search?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((d) => setResults(d.results ?? []))
        .catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const save = (loc) => {
    setBusy(true);
    setMsg(null);
    fetch("/api/settings/location", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(loc),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((saved) => {
        setCurrent(saved);
        setResults([]);
        setQ("");
        setMsg("saved");
      })
      .catch(() => setMsg("could not save"))
      .finally(() => setBusy(false));
  };

  const useCurrentLocation = () => {
    setMsg(null);
    if (!navigator.geolocation) {
      setMsg("geolocation not available in this browser");
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        fetch(`/api/geo/reverse?lat=${latitude}&lon=${longitude}`)
          .then((r) => r.json())
          .then((loc) => {
            if (loc.error) throw new Error();
            save(loc);
          })
          .catch(() => {
            setMsg("could not detect city");
            setBusy(false);
          });
      },
      () => {
        setMsg("location permission denied");
        setBusy(false);
      },
      { timeout: 10000 },
    );
  };

  return (
    <div className="setup__row setup__row--stack">
      <div className="setup__loc-head">
        <span className="setup__name">Location</span>
        <span className="setup__current">
          {current
            ? [current.name, current.admin1, current.country]
                .filter(Boolean)
                .join(", ")
            : "…"}
        </span>
      </div>

      <div className="setup__loc-controls">
        <input
          className="setup__input"
          placeholder="Search a city…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button onClick={useCurrentLocation} disabled={busy}>
          Use current location
        </button>
      </div>

      {results.length > 0 && (
        <ul className="setup__results">
          {results.map((r, i) => (
            <li key={`${r.latitude},${r.longitude},${i}`}>
              <button onClick={() => save(r)}>{r.label}</button>
            </li>
          ))}
        </ul>
      )}

      {msg && <span className="setup__hint">{msg}</span>}
    </div>
  );
}

function PlaylistPicker({ connected, value, onPick }) {
  const [all, setAll] = useState(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!connected) return;
    fetch("/api/spotify/playlists")
      .then((r) => r.json())
      .then((d) => setAll(d.playlists ?? []))
      .catch(() => setAll([]));
  }, [connected]);

  if (!connected) {
    return (
      <div className="setup__field setup__field--stack">
        <span>Morning music</span>
        <div style={{ flex: 1 }}>
          <input
            className="setup__input"
            value={value ?? ""}
            onChange={(e) => onPick({ name: e.target.value, id: "" })}
            placeholder="a genre, mood or artist — e.g. lofi, jazz, acoustic"
          />
          <div className="setup__hint">
            played from Audius (free). Link a Spotify Premium account above to use
            your own playlists instead.
          </div>
        </div>
      </div>
    );
  }

  const shown = (all ?? []).filter((p) =>
    p.name.toLowerCase().includes(q.trim().toLowerCase()),
  );

  return (
    <div className="setup__field setup__field--stack">
      <span>Morning playlist</span>
      <div style={{ flex: 1, position: "relative" }}>
        <input
          className="setup__input"
          value={open ? q : (value ?? "")}
          placeholder={all ? "Search your playlists…" : "loading playlists…"}
          onFocus={() => {
            setOpen(true);
            setQ("");
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => setQ(e.target.value)}
        />
        {open && shown.length > 0 && (
          <ul className="setup__results setup__results--float">
            {shown.slice(0, 8).map((p) => (
              <li key={p.id}>
                <button
                  onMouseDown={() => {
                    onPick({ name: p.name, id: p.id });
                    setOpen(false);
                  }}
                >
                  {p.name}
                  <span className="setup__hint"> · {p.tracks} tracks</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function AssistantSetting({ status }) {
  const [a, setA] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => setA(s.assistant))
      .catch(() => {});
  }, []);

  if (!a) return null;

  const set = (k) => (e) => setA({ ...a, [k]: e.target.value });

  const save = () => {
    setMsg(null);
    fetch("/api/settings/assistant", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wakePhrase: a.wakePhrase,
        userName: a.userName,
        morningPlaylist: a.morningPlaylist,
        morningPlaylistId: a.morningPlaylistId ?? "",
        units: a.units,
        newsCategory: a.newsCategory,
      }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((saved) => {
        setA(saved);
        setMsg("saved — restart the voice service if you changed the wake phrase");
      })
      .catch(() => setMsg("could not save"));
  };

  const asst = status.assistant ?? {};
  // Spotify only drives music when it's a Premium account (the active source).
  const spotifyActive = status.music?.source === "spotify";

  return (
    <div className="setup__row setup__row--stack">
      <span className="setup__name">Voice assistant</span>

      <label className="setup__field">
        <span>Wake phrase</span>
        <input
          className="setup__input"
          value={a.wakePhrase ?? ""}
          onChange={set("wakePhrase")}
        />
      </label>
      <label className="setup__field">
        <span>Call me</span>
        <input
          className="setup__input"
          value={a.userName ?? ""}
          onChange={set("userName")}
          placeholder="(your name)"
        />
      </label>

      <PlaylistPicker
        connected={spotifyActive}
        value={a.morningPlaylist}
        onPick={({ name, id }) =>
          setA({ ...a, morningPlaylist: name, morningPlaylistId: id })
        }
      />

      <label className="setup__field">
        <span>Units</span>
        <select
          className="setup__input"
          value={a.units ?? "fahrenheit"}
          onChange={set("units")}
        >
          <option value="fahrenheit">Fahrenheit</option>
          <option value="celsius">Celsius</option>
        </select>
      </label>
      <label className="setup__field">
        <span>News</span>
        <select
          className="setup__input"
          value={a.newsCategory ?? "technology"}
          onChange={set("newsCategory")}
        >
          {["top", "world", "business", "technology", "science", "health", "sports", "entertainment"].map(
            (c) => (
              <option key={c} value={c}>
                {c[0].toUpperCase() + c.slice(1)}
              </option>
            ),
          )}
        </select>
      </label>

      <div className="setup__models">
        <span>
          Local model (Ollama):{" "}
          <b className={asst.localReachable ? "setup__ok" : ""}>
            {asst.localReachable ? "reachable" : "not running"}
          </b>
        </span>
        <span>
          Cloud model (Claude):{" "}
          <b className={asst.cloudConfigured ? "setup__ok" : ""}>
            {asst.cloudConfigured ? "key set" : "no API key"}
          </b>
        </span>
      </div>

      <div>
        <button onClick={save}>Save</button>
      </div>
      {msg && <span className="setup__hint">{msg}</span>}
    </div>
  );
}

export default function Setup() {
  const [status, setStatus] = useState(null);

  const load = () =>
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ error: true }));

  useEffect(() => {
    load();
  }, []);

  if (!status) return <div className="setup">Loading…</div>;

  const params = new URLSearchParams(window.location.search);
  const spotifyFree = params.get("spotify") === "free";
  const musicSource = status.music?.source ?? "audius";

  return (
    <div className="setup">
      <h1>Mirror setup</h1>

      <LocationSetting />
      <AssistantSetting status={status} />

      <Row
        name="Google Calendar"
        state={status.google ?? {}}
        onConnect={() => (window.location.href = "/api/auth/google")}
        onDisconnect={() =>
          fetch("/api/auth/google/disconnect", { method: "POST" }).then(load)
        }
      />
      <Row
        name="Spotify"
        state={status.spotify ?? {}}
        onConnect={() => (window.location.href = "/api/auth/spotify")}
        onDisconnect={() =>
          fetch("/api/auth/spotify/disconnect", { method: "POST" }).then(load)
        }
        note={
          spotifyFree || (status.spotify?.connected && !status.spotify?.premium)
            ? "This is a Spotify Free account — it can't stream through apps. Music plays from Audius instead. Disconnect and link a Premium account to use your Spotify playlists."
            : status.spotify?.premium
              ? "Premium — music plays from your Spotify playlists."
              : "Optional. Music plays from Audius (free) until a Spotify Premium account is linked."
        }
      />

      <p className="setup__hint" style={{ marginTop: "1rem" }}>
        Music source right now: <b>{musicSource}</b>
      </p>

      <p className="setup__foot">
        <a href="/">← back to mirror</a>
      </p>
    </div>
  );
}
