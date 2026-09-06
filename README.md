# Smart Mirror

Old laptop behind a two-way mirror. React UI + a small Express server that
hides API keys and normalizes data.

## Stack

| Layer | Choice | Why |
|---|---|---|
| UI | React + Vite | Fast dev loop, one-command fullscreen build, kiosk in Chrome. |
| Backend | Node + Express | Hides keys, reshapes API responses, hosts the future voice layer. |
| Weather | Open-Meteo | Free, no key, 7-day daily forecast. |
| Calendar | Google Calendar API (OAuth) | Real schedule; falls back to `server/data/schedule.json` until connected. |
| Music | Spotify Web API + Web Playback SDK | Now-playing display; laptop becomes a "Smart Mirror" Spotify speaker. |
| Voice | Python service (`voice/`) + hybrid router | faster-whisper STT, pyttsx3 TTS; router picks rules / local model / Claude. |

The browser only ever calls `/api/*` on the Express server. The voice service
also only calls `/api/*` — it has no knowledge of weather, calendars, etc.

## Run

```bash
npm install
npm run dev
```

(PowerShell has no `&&` — run multi-step commands one line at a time.)

- Mirror: http://localhost:5173
- Setup / connections: http://localhost:5173/setup
- API: http://localhost:3001/api/...

Copy `server/.env.example` to `server/.env` and fill it in.

## Panels (left column)

- **Date + time** — live; seconds shown small next to the minutes.
- **Location** — the city set on `/setup`, shown under the date.
- **Weather** — 7 days: condition, high, low, for that location.
- **Now playing** — current Spotify track; hidden when nothing is playing.

Right column: **Schedule** — today's events (Google Calendar once connected,
else the sample file).

## Setting the location

Open http://localhost:5173/setup:

- **Search a city** → pick from the dropdown (Open-Meteo geocoding), or
- **Use current location** → browser geolocation + reverse geocoding
  (BigDataCloud, keyless).

The choice is saved to `server/data/settings.json` (gitignored) and the weather
cache clears immediately. `LATITUDE` / `LONGITUDE` / `DEFAULT_CITY` /
`DEFAULT_REGION` in `server/.env` are only the initial seed.
`TEMPERATURE_UNIT` (°C/°F) stays in `server/.env`.

## If `npm run dev` says "port 3001 in use"

A previous `node --watch` didn't exit. Kill it and retry:

```bash
npx kill-port 3001 5173
npm run dev
```

## Connecting Google Calendar

1. https://console.cloud.google.com/ → create a project.
2. **APIs & Services → Library →** enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen:** User type **External**, fill the
   required fields, add your own Google account under **Test users**
   (keeps you in "testing" mode — fine for personal use).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:3001/api/auth/google/callback`
5. Copy the client ID + secret into `server/.env`
   (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`). Restart the server.
6. Open http://localhost:5173/setup → **connect** next to Google Calendar →
   approve. Tokens are saved to `server/data/tokens.json` (gitignored).

## Connecting Spotify

Playback needs a **Spotify Premium** account.

1. https://developer.spotify.com/dashboard → **Create app**.
2. In the app settings, add Redirect URI:
   `http://localhost:3001/api/auth/spotify/callback`
   (also add `http://127.0.0.1:3001/api/auth/spotify/callback` — Spotify is
   picky about the two being distinct).
3. Under **APIs used**, select **Web API** and **Web Playback SDK**.
4. Copy the Client ID + Client Secret into `server/.env`. Restart the server.
5. http://localhost:5173/setup → **connect** next to Spotify → approve.
6. The mirror registers itself as a Spotify Connect device named
   **Smart Mirror**. Start playback on it from:
   - the Spotify app (Devices → Smart Mirror), or
   - `POST /api/spotify/play-search { "query": "morning coffee", "type": "playlist" }`, or
   - the voice layer later.

### Playback endpoints

| Method | Path | Body |
|---|---|---|
| GET | `/api/spotify/now-playing` | — |
| POST | `/api/spotify/play` | `{}` or `{ "uris": [...] }` or `{ "contextUri": "spotify:playlist:..." }` |
| POST | `/api/spotify/pause` `/next` `/previous` | — |
| POST | `/api/spotify/play-search` | `{ "query": "...", "type": "playlist" | "track" }` |
| POST | `/api/spotify/transfer` | `{ "deviceId": "...", "play": true }` |

## Voice assistant

```
voice/main.py ──► POST /api/command {text}
                       │
                  server/agent/index.js
                       │
                  router.js  ── tier 0: regex patterns     (0 ms, $0, offline)
                       │      ── tier 1: Ollama local model (~300 ms, $0, offline)
                       │      ── tier 2: Claude             (~1 s, paid, online)
                       │
                  tools.js  ── get_time · get_date · get_weather(when)
                              get_schedule(range) · play_playlist(name)
                              run_morning_routine · open_setup
```

**Hybrid router** — a request stops at the first tier that can answer it. Every
one of the listed commands is handled at **tier 0**, so the assistant works with
no model at all. Tiers 1 and 2 only exist for phrasing the patterns miss; tier 2
only runs if `ANTHROPIC_API_KEY` is set. The tier that answered is written to
`server/data/metrics.jsonl` along with per-stage timings.

### Setup

Run `voice/` (see `voice/README.md`), then say **"mirror mirror on the wall" →
"setup"**. The spoken flow asks for your name, wake phrase, morning playlist and
units. The same fields are editable on `/setup`. Wake-phrase changes need a
voice-service restart.

### Commands

| Say | Does |
|---|---|
| "what's the time" / "what's the date" | speaks it |
| "what's the weather" / "…tomorrow" / "…this week" | current, next day, or 7-day |
| "what's on my schedule today / tomorrow / this week" | calendar events for the range |
| "play my morning playlist" | plays the saved Spotify playlist |
| "start my morning routine" | date → time → weather → today's events → playlist |
| "setup" | spoken questionnaire |

## APIs & auth — what each feature needs

| Feature | Service | Auth | Cost |
|---|---|---|---|
| Weather | Open-Meteo + BigDataCloud | none | free |
| Calendar | Google Calendar API | OAuth (browser, one-time) | free |
| Music | Spotify Web API + Playback SDK | OAuth (browser) + **Premium** | free API, paid account |
| Speech-to-text | faster-whisper | none (downloads model weights) | free, local |
| Text-to-speech | pyttsx3 (OS voice) | none | free, local |
| Wake word | transcribe-and-match (default) | none | free, local |
| Local model tier | Ollama + a pulled model | none | free, local |
| Cloud model tier | Claude (`ANTHROPIC_API_KEY`) | API key | per-token, **only tier 2** |

Everything except the Claude tier runs fully offline. Leave `ANTHROPIC_API_KEY`
blank to stay local-only.

## Kiosk

`chrome --kiosk --app=http://localhost:5173` on laptop login.
