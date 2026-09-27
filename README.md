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
cd voice
.venv\Scripts\Activate.ps1
python main.py
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
- **Now playing** — current track (Spotify or Audius); hidden when nothing is playing.

Right column: **Schedule** — today's events (Google Calendar once connected,
else the sample file) + **Reminders** + **Character** (placeholder box for now —
see below).

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
                  router.js  ── tier 0: regex patterns          (0 ms, $0, offline)
                       │      ── tier 1: Ollama local model      (~1 s, $0, offline)
                       │      ── tier 2: Claude                  (~1 s, paid, online)
                       │
                  tools.js  ── ~20 tools, real JSON schemas: get_weather(when),
                              get_schedule(range), play_playlist, get_news,
                              set_reminder, recall(query), add_note, … — the
                              LLM tiers pick and chain them; a failed/uncertain
                              tool degrades gracefully rather than crashing
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
| "what's the news" / "tech news" / "world news" | reads 3 headlines, then waits for a number or a keyword to read one (say "skip" to stop) |
| "set news to science" | change the news category |
| "remind me to call mom at 5pm" · "remind me to X in 20 minutes" | sets a reminder (natural-language time) |
| "what are my reminders" · "clear my reminders" | list / cancel |
| "go to sleep" / "turn off the display" / "goodnight" | fades the mirror to black (music + voice keep running; tap the screen or say "wake up" to bring it back) |
| "wake up" / "turn on the display" | brings the mirror back |
| "note that…" · "remember that…" · "journal:…" | saves a note / journal entry into memory |
| "what did I say about…" · "have I mentioned…" · "when did I…" | recalls from your own past — see Personal memory |
| "start my morning routine" | date → time → weather → events → **3 headlines** (7s to pick one, else) → playlist. Also wakes the display. |
| "setup" | spoken questionnaire |

<<<<<<< HEAD
Reminders show on the mirror (right column) and are spoken when due — the server
wakes the mirror and queues them at `/api/voice/announcements`, which the voice
service polls between wake-word listens. Reminders are stored in
`server/data/reminders.json` (gitignored).
=======
Reminders show on the mirror and are spoken when due — the server wakes the
mirror and queues them at `/api/voice/announcements`, which the voice service
polls between wake-word listens. Stored in `server/data/reminders.json`
(gitignored).

## Personal memory (RAG)

The mirror remembers **your own stuff** — never external documents:

| Source | How it gets in |
|---|---|
| Past conversations | every voice exchange is appended to `server/data/memory/conversations.jsonl` |
| Spoken notes / journal | "note that…", "journal:…" → `notes.jsonl` |
| Text files | drop `.md` / `.txt` in the project-root `notes/` folder |
| Calendar history | last 90 days of events, if `MEMORY_INDEX_CALENDAR=1` |

```
ingest.js  chunk + dedupe + incremental cursors
   │
embed.js   nomic-embed-text via Ollama  ── LOCAL: personal data never leaves the box
   │
sqlite-vec  one file, no server (node:sqlite + prebuilt extension, zero native build)
   │
search.js  KNN 40 (vec0 cosine)  →  time-window filter (chrono parses "last week")
   │        →  re-rank by  cosine × (0.4 + 0.6 · 0.5^(age / 14d))  →  top 6
recall.js  synthesize from the dated excerpts — local model first, cloud only on
           fallback and only the snippets, never the corpus
```

Query turns are **not** indexed back into memory: a "what did I say about…"
question, a note-taking command (the note itself is already stored), or anything
the assistant couldn't answer is skipped by the ingester, so the store stays
signal.

**Hard parts, handled:**
- *Recency* — recency-weighted score, plus a hard time filter when the question
  says "this month" / "last week".
- *Contradiction* — excerpts are dated and the synthesizer is told to trust the
  most recent and say when things changed ("you needed milk, but you picked it
  up on the 8th").
- *Privacy* — embeddings **and** synthesis are local by default;
  `MEMORY_LOCAL_ONLY=1` refuses the cloud entirely.

### Setup

```bash
ollama pull nomic-embed-text     # embeddings (~275 MB), always local
ollama pull llama3.2:3b          # router + memory synthesis, ~2s answers
# optional: ollama pull qwen3:8b, then set OLLAMA_MODEL=qwen3:8b for better
# answers at ~15s — the mirror falls back to reading the raw excerpt if the
# model is slow or down, and to Claude only if a key is set.
```

Conversation logging is automatic. `POST /api/memory/reindex` forces a pass;
`GET /api/memory/status` shows chunk counts; `GET /api/memory/search?q=…` shows
raw retrieval without synthesis.

### Eval

```bash
npm --prefix server run eval:memory              # recall@k + MRR on a fixture corpus
npm --prefix server run eval:report              # latency per stage from real usage
npm --prefix server run eval:report -- --since 24h   # …last 24h only
```

`eval:memory` builds a synthetic personal corpus, indexes it, and scores
retrieval against `server/eval/questions.json` (writes `server/eval/results.md`).
`eval:report` rolls up `metrics.jsonl` — STT / router / retrieval / synthesis
latency percentiles, STT confidence, and how often each router tier fired.

Measured on a laptop (16-item corpus, `--since` window of clean runs):

| stage | p50 | p90 | notes |
|---|---:|---:|---|
| memory: embed query (`nomic-embed-text`) | 17 ms | 20 ms | local |
| memory: vector search (`sqlite-vec` KNN 40) | 6 ms | 6 ms | local |
| memory: synthesis (`llama3.2:3b`) | 1.8 s | 2.4 s | local; 0 cloud calls |
| recall end-to-end (route → spoken answer) | 1.7 s | 2.5 s | |
| retrieval quality | recall@1 **75%** · recall@6 **100%** · MRR **0.88** | | |
| router tier split | tier-0 rules **85%** · tier-1 local **15%** · cloud 0% | | |
| STT (`faster-whisper base`) | 6.1 s | 9.8 s | dominates e2e latency |
| STT confidence (`e^avg_logprob · (1−p_no_speech)`) | mean **0.6** | | flags low-confidence turns |
>>>>>>> 134f5db (add RAG stuff)

## APIs & auth — what each feature needs

| Feature | Service | Auth | Cost |
|---|---|---|---|
| Weather | Open-Meteo + BigDataCloud | none | free |
| Calendar | Google Calendar API | OAuth (browser, one-time) | free |
| News | Publisher RSS (BBC, The Verge, Ars, ESPN) + readability extraction | none | free |
| Reminders | `chrono-node` (local NL time parsing) | none | free |
| Memory embeddings | Ollama + `nomic-embed-text` | none | free, local |
| Memory vector store | `sqlite-vec` (`node:sqlite`, prebuilt extension) | none | free, local |
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
