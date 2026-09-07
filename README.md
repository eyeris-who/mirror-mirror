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
| Music | Spotify (Premium) with **Audius** fallback | Spotify if a Premium account is linked; otherwise Audius (free, keyless, full tracks) streamed by the mirror page. Queue / skip / back / progress, voice-controlled. |
| Voice | Python service (`voice/`) + hybrid router | faster-whisper STT, Windows SAPI TTS; router picks rules / local model / Claude. |

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
else the sample file) + **Character** (placeholder box for now — see below).

## Character animation (planned)

`web/src/components/Character.jsx` computes a live state and shows a placeholder
box under the schedule. States: `idle`, `talking`, `sleeping`, `going to sleep`,
`waking up` — derived from `/api/display` and `/api/voice/state`. When the mirror
sleeps, the panels fade to black but the character stays (so it can play a
sleeping animation).

Recommended format: a **Rive** `.riv` file with a state machine (inputs for
awake/talking, transition clips for sleep/wake) driven by `@rive-app/react-canvas`,
or **Lottie** `.json` clips (one per state) cross-faded on change. Design them
light-on-transparent — black is invisible through a two-way mirror.

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

## Music

Two sources, picked automatically:

- **Spotify** — used only when a **Premium** account is linked. Free accounts
  cannot stream through the Web API at all (not full tracks, not previews), so
  the connect flow checks `product` and **rejects a Free account** with a
  warning. Premium playback uses Spotify Connect + the Web Playback SDK (the
  mirror shows up as a device called "Smart Mirror").
- **Audius** (default) — free, no key, full-length tracks from independent
  artists. The mirror page streams them through a plain `<audio>` element. Used
  whenever Spotify isn't a linked Premium account. Set a genre / mood / artist
  as your "Morning music" on `/setup` (e.g. `lofi`, `jazz`, `acoustic`).
  `"play trending [genre]"` pulls Audius's trending chart instead of a keyword
  search — usually better picks. Audius catalog is indie/electronic-heavy;
  no major-label artists.

The player (queue, history, skip, back, real progress bar) works the same for
both — `/api/music/*` routes to whichever source is active.

### Music voice commands

| Say | Does |
|---|---|
| "play lofi" / "play jazz" / "play &lt;anything&gt;" | search that on the active source, queue it |
| "play trending" / "play trending techno" / "play the top lofi tracks" | Audius trending chart, optionally by genre (better picks than search) |
| "play my morning playlist" | your saved morning playlist / query |
| "pause" · "resume" | pause / resume |
| "next" · "skip" | next track |
| "back" · "previous" · "go back" | restart the track, or previous if it just started |
| "what's playing" | says the track and artist |

### Connecting Spotify (Premium only)

1. https://developer.spotify.com/dashboard → **Create app**.
2. In the app settings, add exactly this Redirect URI:
   `http://127.0.0.1:3001/api/auth/spotify/callback`
   Spotify **rejects `localhost`** (as of April 2025) — it must be the loopback
   IP `127.0.0.1`. This has to match `SPOTIFY_REDIRECT_URI` in `server/.env`
   character-for-character.
3. Under **APIs used**, select **Web API** and **Web Playback SDK**.
4. **User Management** tab → add yourself: your name + the **email on your
   Spotify account**. New apps are in *Development mode*, where only listed users
   can call the API — without this every request returns
   `403 The user is not registered for this application`.
5. Copy the Client ID + Client Secret into `server/.env`. Restart the server.
6. http://localhost:5173/setup → **connect** next to Spotify → approve.
   (You'll briefly land on a `127.0.0.1:3001` page mid-redirect — that's normal.)
   If you connected before adding yourself in step 4, click **disconnect** then
   **connect** again. A Free account is rejected here with a warning.
7. Once connected (Premium), pick your morning playlist from the dropdown on
   `/setup`.

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
| "play my morning playlist" · "play lofi" · "pause" · "next" · "back" · "what's playing" | music (see the Music section) |
| "go to sleep" / "turn off the display" / "goodnight" | fades the mirror to black (music + voice keep running; tap the screen or say "wake up" to bring it back) |
| "wake up" / "turn on the display" | brings the mirror back |
| "start my morning routine" | date → time → weather → today's events → playlist (also wakes the display) |
| "setup" | spoken questionnaire |

## APIs & auth — what each feature needs

| Feature | Service | Auth | Cost |
|---|---|---|---|
| Weather | Open-Meteo + BigDataCloud | none | free |
| Calendar | Google Calendar API | OAuth (browser, one-time) | free |
| Music (default) | Audius | none | free |
| Music (if linked) | Spotify Web API + Playback SDK | OAuth (browser) + **Premium** | free API, paid account |
| Speech-to-text | faster-whisper | none (downloads model weights) | free, local |
| Text-to-speech | Windows SAPI (`pyttsx3` elsewhere) | none | free, local |
| Wake word | transcribe-and-match (default) | none | free, local |
| Local model tier | Ollama + a pulled model | none | free, local |
| Cloud model tier | Claude (`ANTHROPIC_API_KEY`) | API key | per-token, **only tier 2** |

Everything except the Claude tier runs fully offline. Leave `ANTHROPIC_API_KEY`
blank to stay local-only.

## Kiosk

`chrome --kiosk --app=http://localhost:5173` on laptop login.
