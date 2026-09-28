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
npm run dev:all
```

`dev:all` starts the server, the page and the voice service together
(`npm run dev` is just server + page; `npm run voice` is just the voice
service). The voice service needs its virtualenv set up once — see
`voice/README.md`.

- Mirror: http://localhost:5173
- Setup / connections: http://localhost:5173/setup
- API: http://localhost:3001/api/...

Copy `server/.env.example` to `server/.env` and fill it in.

### Production (kiosk)

```bash
npm run build
npm start
```

One process: the server serves the built page at http://localhost:3001. Set
`WEB_ORIGIN=http://localhost:3001` in `server/.env` so OAuth redirects land
there. `npm run mirror` (Windows) does the whole kiosk start: server, voice
service, then Chrome full-screen — put a shortcut to
`powershell -ExecutionPolicy Bypass -File scripts\start-mirror.ps1` in
`shell:startup` to run it at login.

### Tests

```bash
npm test
```

Runs everything that needs no model or microphone:

- **server** (`node:test`): router, reminder parsing, time windows, memory
  prompt assembly, the memory store (forget, tombstones, retention), request
  security
- **voice** (`unittest`, stdlib only): wake matching, the conversation loop
  with fake mic/speaker/server (filler, barge-in, flow cancel), adaptive noise
  floor

CI (`.github/workflows/ci.yml`) runs those plus a fake-embedding pass of the
memory eval and the web build. Router cases are real transcripts from
`metrics.jsonl` that used to misroute; add one whenever a phrase goes wrong.

With models and audio available locally, three more checks:

```bash
npm --prefix server run eval:memory   # retrieval + answer quality (Ollama)
npm --prefix server run eval:router   # tier-1 tool choice + latency (Ollama)
cd voice
python clips.py synthetic             # or: python clips.py record "hey mirror …"
python -m unittest tests.test_audio   # replay clips through Whisper + wake
```

## Panels (left column)

- **Date + time** — live; seconds shown small next to the minutes.
- **Location** — the city set on `/setup`, shown under the date.
- **Weather** — 7 days: condition, high, low, for that location.
- **Now playing** — current track (Spotify or Audius); hidden when nothing is playing.

Right column: **Schedule** — today's events (Google Calendar once connected,
else the sample file) + **Character** (see below).

## Character

`web/src/components/Character.jsx` is a line-drawn face (light strokes only —
black is invisible through a two-way mirror) animated in pure CSS from a
`data-state` attribute: `idle` (blinks), `listening` (wide eyes, pulsing ring),
`thinking` (glances up, dots), `talking` (mouth moves), `sleeping` (eyes shut,
drifting z's), plus `going to sleep` / `waking up` transitions. When the mirror
sleeps, the panels fade to black but the character stays.

State arrives over **Server-Sent Events** (`/api/events`): the server pushes
display and voice-state changes the moment they happen (~15 ms through the Vite
proxy) instead of the page polling every second. To swap in a Rive or Lottie
character later, keep the same `state` value and replace the SVG.

The whole layout drifts by up to 3 px every 3 minutes so an always-on panel
doesn't burn in.

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
                  router.js  ── transcript repair ("what s" → "what's", "low-fi" → "lofi")
                       │      ── tier 0: regex patterns          (p90 3 ms, $0, offline)
                       │      ── tier 1: Ollama local model      (~0.9 s fresh, ≤2.2 s follow-up, $0, offline)
                       │      ── tier 2: Claude                  (paid, online)
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

The tiering is justified by the measurements, not just cost: ~90% of traffic
never touches a model. For the rest, the logs showed tier-1 routing at p90
**19 s**. `eval:router` traced that to the prompt, not the model:

- Ollama caches the processed prompt prefix, so with an identical ~1,300-token
  tool block every request, routing is ~0.9 s.
- Llama 3.2's chat template puts the tool block **after** the conversation. In
  a follow-up ("actually pause it" after "play some jazz") the history shifts
  it out of the cache, and reprocessing it on CPU took up to 12 s.

So a fresh request gets every tool (cache-friendly), and a follow-up gets only
the ~6 tools closest to it by embedding (`agent/toolSelect.js`). Measured on 13
tier-1 phrasings × 3 runs:

| strategy | fresh p50 | follow-up worst case | tool accuracy |
|---|---:|---:|---:|
| all tools, always (before) | 859 ms | 12,074 ms | 30/39 |
| preselected, always | 1,930 ms | 3,856 ms | 33/39 |
| **hybrid (now)** | **880 ms** | **2,233 ms** | 30/39 |

The server also warms the model and its tool prompt at startup and every 20
minutes, and caps tier-1 routing at 10 s (`LOCAL_ROUTE_TIMEOUT_MS`). Its two
misses — "who sings this" → recall, "put on something relaxing" →
play_trending — are now caught by tier-0 rules before the model sees them.
Known miss: it picks a tool for requests it has none for (email).

### Speech pipeline

```
mic ─► energy gate (800 ms pre-roll, hysteresis) ─► faster-whisper
          │                                          (beam 5, vocab prompt, padded clip,
          │                                           low-confidence / prompt-echo filter)
          ▼
   fuzzy wake match ─► command text (original punctuation kept) ─► POST /api/command
```

Short wake phrases never transcribe the same way twice — "hey mirror" comes
back as "a mirror", "Hey, Mira", "hay mirror", or just "Mirror," — so
`voice/wake.py` matches by similarity (with a table of common mishearings and a
required match on the phrase's last word) instead of exact substring. What each
fix addressed, from real transcripts in the logs:

| Problem (seen in `metrics.jsonl`) | Cause | Fix |
|---|---|---|
| "a mirror what's the weather" ignored | exact substring match | fuzzy matcher, `voice/tests/test_wake.py` |
| "what's the time" missed tier 0 | apostrophes normalized to "what s" | keep original text; router repairs `X s` → `X's` |
| "me in one minute to brush teeth" | the gate triggered mid-word, 300 ms pre-roll | 800 ms pre-roll + start/keep-going thresholds |
| "Place on low-fi." | greedy decode, no vocabulary hint | beam 5 + a prompt of real commands |
| "hey mirror" sent as a command | follow-up window didn't strip a re-said wake phrase | strip it everywhere the mic listens |
| noise → "Pause." | the vocabulary prompt echoed on noise | drop transcripts below confidence 0.35 with no-speech > 0.4 (0 of 30 noise clips leak) |

On synthesized test clips with `base.en`, per-clip STT went from ~530 ms to
~400 ms (threads pinned to physical cores), and a clip with its first 450 ms
cut off now still wakes. For a more robust wake word, a 5–6 syllable phrase
("mirror mirror on the wall") beats a 2-syllable one; `WHISPER_MODEL=distil-small.en`
is the next accuracy step.

**In a real room:**
- *Music.* The noise floor follows the room (a low percentile of the last
  ~10 s of mic levels), so music on the mirror's own speakers raises the
  trigger instead of making every frame look like speech. The page also
  ducks music to 20% while the assistant is awake, listening or talking.
  Idle captures are capped at 8 s.
- *Dead air.* If an answer takes more than 1.5 s, the mirror says "One sec."
  (`MIRROR_FILLER_S`).
- *Barge-in.* Say "stop", "that's enough" or "never mind" while it's talking
  and it stops mid-sentence. The mic hears the mirror's own voice too, so
  long transcripts and stop words that are part of the reply itself are
  ignored. A question cut off this way ("Say yes to delete it") is cancelled,
  so your next words aren't taken as the answer.
- *Speech startup.* One SAPI process stays running instead of one per sentence
  — measured ~2.7 s faster over a four-part briefing, and interruptible.

Not yet measured with a real microphone in a noisy room: record clips there
with `voice/clips.py` — that's what `tests/test_audio.py` replays.

**Conversation mode** — after an answer the mic stays open for ~4s (no wake
phrase). Keep talking and it keeps going; go quiet, or say "that's all", and it
stops. The server holds a rolling transcript (last 4 exchanges) per session and
feeds it to tiers 1–2, so references resolve:

```
"what's the weather"        → tier 0 · "light drizzle, high of 25"
"and this weekend?"         → tier 1 · get_weather(when: week)   ← "this weekend" from context
"remind me to pack a coat"  → tier 0 · asks when → "Saturday morning" → set
"thanks"                     → ends the conversation
```

Tier 0 stays context-free by design (it's pure pattern-match); referential
phrasing just falls through to the model. Set `MIRROR_FOLLOWUP_S=0` to disable
and require the wake phrase every time.

### Setup

Run `voice/` (see `voice/README.md`), then say **"mirror mirror on the wall" →
"setup"**. The spoken flow asks for your name, wake phrase, morning playlist and
units. The same fields are editable on `/setup`. Wake-phrase changes need a
voice-service restart.

### Commands

| Say | Does |
|---|---|
| "what's the time" / "what's the date" | speaks it |
| "what's the weather" / "…tomorrow" / "…this week" | current, next day, or the week (3 days in detail, then a one-line summary) |
| "what's on my schedule today / tomorrow / this week" | calendar events for the range |
| "play my morning playlist" · "play lofi" · "pause" · "next" · "back" · "what's playing" | music (see the Music section) |
| "what's the news" / "tech news" / "world news" | reads 3 headlines, then waits for a number or a keyword to read one (say "skip" to stop) |
| "set news to science" | change the news category |
| "remind me to call mom at 5pm" · "remind me to X in 20 minutes" | sets a reminder (natural-language time) |
| "what are my reminders" · "clear my reminders" | list / cancel |
| "go to sleep" / "turn off the display" / "goodnight" | fades the mirror to black (music + voice keep running; tap the screen or say "wake up" to bring it back) |
| "wake up" / "turn on the display" | brings the mirror back |
| "note that…" · "remember that…" · "journal:…" | saves a note / journal entry into memory |
| "I need to buy printer ink" · "I parked on level 3" · "my locker code is 12" | saved as a note and read back ("Noted: you need to buy printer ink") |
| "what did I say about…" · "have I mentioned…" · "when did I…" | recalls from your own past — see Personal memory |
| "forget what I said about…" · "delete my note about…" · "forget that" | reads the match back, deletes it on "yes" |
| "start my morning routine" | date → time → weather → events → **3 headlines** (7s to pick one, else) → playlist. Also wakes the display. |
| "setup" | spoken questionnaire |

Reminders show on the mirror (right column) and are spoken when due — the
server wakes the mirror and queues them at `/api/voice/announcements`, which the
voice service polls between wake-word listens. Stored in
`server/data/reminders.json` (gitignored).

## Personal memory (RAG)

The mirror remembers **your own stuff** — never external documents:

| Source | How it gets in |
|---|---|
| Past conversations | every voice exchange is appended to `server/data/memory/conversations.jsonl`; what you told it (and reminder requests) gets indexed |
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
search.js  KNN 40 (vec0 cosine)  →  time-window filter (chrono: "yesterday", "two weeks ago")
   │        →  re-rank by  cosine × (0.4 + 0.6 · 0.5^(age / 14d))  →  top 6
recall.js  keep hits within 0.1 cosine of the best  →  add later UPDATES of each hit
   │        →  prompt: today's date, excerpts oldest-first with "(LATEST)" on
   │           the newest of each update chain
   │        →  local model (12 s cap) · cloud only as fallback, snippets only
   │           · else read the newest relevant excerpt
```

Commands aren't memories: "pause", "what's the weather", a "what did I say
about…" question, a note-taking command (the note itself is stored) and dead
ends are skipped by the ingester. Reminder requests are kept — "remind me to
renew my passport" is also a fact you'll ask about ("what's renewing soon?").

**Hard parts, measured** (`eval:memory`, see Eval):
- *Updates.* The update is usually phrased nothing like the question: "what
  did I need from the store?" matches the shopping list (cosine .69), not
  "fridge is fully stocked now" (.53). So for each relevant hit, the recaller
  pulls in **later** chunks whose embedding is close to *that hit* — measured
  0.60–0.79 for real updates vs 0.38–0.48 for unrelated pairs, threshold 0.58
  — and marks the newest of each chain `(LATEST)`.
- *Relevance vs recency.* Recency re-ranks, but it doesn't decide what's
  relevant: a 24-day-old "renew my passport" had the 2nd-best cosine and the
  worst score. The filter before synthesis uses cosine.
- *Time windows.* "yesterday" is that whole day, "two weeks ago" a week around
  it. (A bug made "yesterday" mean the last 24 hours, so yesterday morning
  was never found; fixing it took retrieval recall@6 from 89% to 100%.)
- *Known miss.* Asked in the past tense — "what did I need from the store?" —
  llama3.2:3b answers "milk, eggs, and coffee filters" even with "(LATEST)
  fridge is fully stocked" in the prompt. The present-tense version ("do I
  still need anything?") passes. A bigger local model is the likely fix.
- *Privacy* — embeddings **and** synthesis are local by default;
  `MEMORY_LOCAL_ONLY=1` refuses the cloud entirely. Replies that read memory
  aloud are kept out of `conversations.jsonl` and out of the rolling history a
  later turn might send to the cloud tier; `metrics.jsonl` stores a hash and
  word count of what you said, not the words (`METRICS_LOG_TEXT=1` to debug).
- *Forgetting* — see below.

### Forgetting

A memory system you can't delete from isn't private. Say "forget what I said
about the gate code" (it reads the match back and waits for "yes"), or use the
✕ next to any memory on `/setup` (`DELETE /api/memory/:id`). A forget removes:

1. the chunk **and** its vector (same rowid, one transaction — deleting only one
   would leave an orphan KNN could still return)
2. the source line in `conversations.jsonl` / `notes.jsonl`, plus the reply that
   went with it and the spoken command that dictated a note
3. the text of any older recall replies that may have quoted it

and records a **tombstone** (hash only, never text) so a re-scanned source —
a `notes/` file you save again, calendar history — can't bring it back.
Line-number ingest cursors are moved back by the number of lines removed above
them, so the next pass doesn't skip anything. A line in one of your `notes/`
files is tombstoned but the file itself is left for you to edit.

`MEMORY_RETENTION_DAYS=N` drops conversation memories older than N days from
the index and the log on every ingest pass; notes and journal entries are kept.

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
raw retrieval without synthesis; `GET /api/memory/recent` lists what's stored.

### Eval

```bash
npm --prefix server run eval:memory              # retrieval + answer quality
npm --prefix server run eval:memory -- --prompt v1   # …with the original prompt
npm --prefix server run eval:router              # tier-1 tool choice + latency
npm --prefix server run eval:report              # latency per stage from real usage
```

**`eval:memory`** feeds a 23-utterance corpus through the **production router**
(so the ingester's skip rules apply as they do for real: 14 go to the model
tier, 8 become notes, 1 reminder), then asks 23 questions across updates,
facts, multi-answer, time windows, unanswerable questions and a
forget-then-ask. Retrieval is scored by rank; **answers** are scored without an
LLM judge, by required concepts and forbidden phrases per question (e.g. the
car question fails if it mentions parking). Results in `server/eval/results.md`.

| | retrieval recall@1 | recall@6 | answers pass | synthesis p90 |
|---|---:|---:|---:|---:|
| original prompt, before the time-window fix | 78% | 89% | 18/22 | 2.8 s |
| **now** (window fix, cosine filter, update chaining, dated prompt with worked examples) | **89%** | **100%** | **22/23** (stable over 3 runs) | **1.6 s** |

The worked examples in the prompt use topics that aren't in the eval corpus,
so it measures generalisation rather than memorised answers.

**`eval:report`**, unfiltered — all 201 commands and 24 recalls logged through
Sep 9, 2026, *before* the fixes on this page:

| stage | p50 | p90 | notes |
|---|---:|---:|---|
| memory: embed query | 21 ms | 55 ms | local |
| memory: vector search (`sqlite-vec` KNN 40) | 6 ms | 15 ms | local |
| memory: synthesis (`llama3.2:3b`) | 2.4 s | 25 s | 5 of 24 fell back to the raw excerpt; now capped at 12 s |
| router: tier 0 rules | 0 ms | 3 ms | **89%** of commands |
| router: tier 1 local model | 5.3 s | 19.4 s | **3%** of commands; follow-up worst case now 2.2 s (`eval:router`) |
| dead ends (nothing could answer) | | | **8%** — most were mis-transcriptions now covered by router tests |
| STT per clip (`base.en`) | ~400 ms | | synthesized clips; live numbers pending new logs |

Older `metrics.jsonl` voice rows reported "STT 6.1 s", but that field actually
measured wake → command, including the "Hmm?" reply and a second listen.
`eval:report` now skips those rows; new rows time the Whisper call alone.

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

## Security

The API can read your memory, so it isn't open to your network or other
websites:

- **Loopback only.** The server binds `127.0.0.1` and `::1`. To reach it from
  another device, set `HOST=0.0.0.0` and list the names you'll use in
  `ALLOWED_HOSTS` — and understand that anything on that network can then read
  your memory.
- **Origin check.** A request carrying an `Origin` that isn't the mirror page is
  refused (403). `cors()` alone only hides the response from the page; the
  request would still run.
- **Host check.** Requests whose `Host` isn't a loopback name (or
  `ALLOWED_HOSTS`) are refused, which blocks DNS rebinding — a hostile page
  re-resolving its own domain to 127.0.0.1.

See `server/security.js` and `server/test/security.test.js`.

**At rest — what this does *not* protect against.** `server/data/` holds your
memory (`memory/memory.db`, `conversations.jsonl`, `notes.jsonl`), OAuth
refresh tokens (`tokens.json`) and reminders as **plain files**. Anyone who can
read your Windows user profile — another admin, malware running as you, a
stolen unencrypted disk — can read them. The mitigations are the OS's: a
separate Windows account for the mirror and BitLocker on the disk. What the
app does do is keep secrets out of places they don't need to be: memory answers
aren't logged, metrics hold hashes rather than words, and forgetting removes
the text rather than hiding it. `npm --prefix server run redact-logs` applies
the same redaction to logs written before that existed.

## Kiosk

`npm run mirror` (Windows) — see *Production* under Run. Manually:
`npm run build && npm start`, then `chrome --kiosk --app=http://localhost:3001`.
(During development: `--app=http://localhost:5173`.)
