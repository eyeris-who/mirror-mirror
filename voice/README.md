# Voice service

A small Python process that does the talking and listening. It never contains
any logic about *what* to answer — it captures speech, sends the text to the
Node server's `/api/command`, and speaks back whatever comes out.

Python **3.10–3.14**. If `pip install` ever fails building a wheel from C/Rust
source (missing "Microsoft Visual C++ 14.0"), that package has no wheel for your
Python version — make the venv with an older one: `py -3.12 -m venv .venv`.

```
mic ─► energy VAD ─► faster-whisper ─► fuzzy match: wake phrase?
       (800 ms pre-roll)                │ yes
                                        ▼
                              speak "Hmm?"  ─► record command ─► whisper
                                        │
                                        ▼
                        POST localhost:3001/api/command {text}
                                        │
                                        ▼
                     speak reply  (morning routine = speak each segment)
                                        │
                                        ▼
                  keep the mic open ~4s ─► more speech? ─► loop (no wake phrase)
                                          silence / "that's all" ─► idle
```

After the first exchange the conversation stays open: follow-ups don't need the
wake phrase, and the server threads the last few turns into the model so "and
tomorrow?" or "add that to my reminders" resolve. `MIRROR_FOLLOWUP_S=0` turns
this off.

## Run it

Windows PowerShell — one line at a time (PowerShell has no `&&`):

```powershell
cd voice
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python main.py
```

(`python -m venv .venv` and  `pip install -r requirements.txt` are one-time only for setup)

After that, from the project root: `npm run voice` (or `npm run dev:all` for
everything at once). Tests: `npm run test:voice`.

If activation is blocked: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then retry.
macOS / Linux: `python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`

Start the Node server first (`npm run dev` in the project root). First launch
downloads the Whisper model (~150 MB for `base.en`).

Then say: **"mirror mirror on the wall"** → *Hmm?* → **"what's the weather"**.

`main.py` prints `[heard] '...'` for every utterance so you can see what Whisper
is transcribing. Nothing reacting?

```powershell
python miccheck.py --devices     # level meter + a record/transcribe test
```

If the meter shows near-silence, set `MIRROR_MIC` to a real input device
(name substring or index from `--devices`). For extra capture logging:
`$env:MIRROR_DEBUG=1; python main.py`.

## Config

| Where | What |
|---|---|
| `/setup` page or voice `"setup"` | wake phrase, your name, morning playlist, units |
| `MIRROR_SERVER` env | Node server URL (default `http://127.0.0.1:3001`) |
| `WHISPER_MODEL` env | `tiny.en` \| `base.en` (default) \| `distil-small.en` \| `small.en` — bigger = slower, more accurate; `distil-small.en` is the best next step (downloads on first run) |
| `WHISPER_THREADS` env | CPU threads for Whisper (default: half your logical cores, max 8) |
| `MIRROR_MIN_CONF` env | transcripts below this confidence that also look like silence are dropped (default `0.35`) |
| `MIRROR_FILLER_S` env | say "One sec." if the answer takes longer than this (default `1.5`; `0` disables) |
| `MIRROR_BARGE_IN` env | listen for "stop" while talking and cut the reply off (default on; `0` disables) |
| `MIRROR_MIC` env | input device name/index if not the system default (`python -m sounddevice` lists them) |
| `MIRROR_FOLLOWUP_S` env | seconds the mic stays open for a wake-free follow-up after each answer (default `4`; `0` disables) |

## What it can do

Spoken commands (handled by the server's router, not here):

- "what's the time / date"
- "what's the weather" · "…tomorrow" · "…this week"
- "what's on my schedule today" · "…tomorrow" · "…this week"
- "play my morning playlist" · "play lofi" · "play jazz"
- "play trending" · "play trending techno" · "play the top lofi tracks"
- "pause" · "resume" · "next" · "skip" · "back" · "what's playing"
- "what's the news" · "tech news" · "set news to science" — then a number / keyword / "skip"
- "remind me to X at 5pm" · "remind me to X in 20 minutes" · "what are my reminders"
- "go to sleep" / "turn off the display" · "wake up" / "turn on the display"

Fired reminders are spoken automatically (the loop checks `/api/voice/announcements`
every few seconds while idle).
- "start my morning routine" → date, time, weather, today's events, then the playlist
- "setup" → spoken questionnaire (name, wake phrase, playlist, units)

## Wake word — current approach and upgrades

`listen.py` finds utterances with an energy threshold calibrated to the room at
startup — a higher level to start recording and a lower one to keep going, with
800 ms of audio kept from before the trigger so the first syllable isn't lost.
Each utterance is transcribed and `wake.py` looks for the wake phrase.

Whisper rarely spells a short phrase the same way twice, so matching is fuzzy:
"a mirror", "Hey, Mira", "hay mirror" and a bare "Mirror," all wake for
"hey mirror", while "hey mom" or "I bought a mirror" don't. The command is taken
from the original transcript, so "what's" and "5 p.m." reach the server intact.
Tune `THRESHOLD` in `wake.py` if you get misses or false wakes; `eval:report`
counts near misses to help. Tests: `python -m unittest discover -s tests`.

Transcription uses beam search, a short prompt of real commands (so "lofi"
doesn't come out "low-fi"), and pads sub-second clips. Noise that makes Whisper
hallucinate a word is dropped by confidence. `python miccheck.py` runs this same
pipeline on a 4-second recording and prints the wake score.

The gate's noise floor keeps adapting (`noise.py`): steady sound like music
from the mirror's own speakers raises the trigger within seconds, so it doesn't
record back-to-back clips of lyrics. The page ducks the music while the
assistant is engaged.

Remaining downsides: every utterance costs a Whisper pass (the mirror is deaf
for ~0.4 s while it runs), and a loud TV can still trigger transcriptions.

### Audio regression clips

`python clips.py synthetic` writes a seed set spoken by Windows SAPI;
`python clips.py record "hey mirror what's the weather"` records your own
(`--expect none` for a clip that must not wake). `python -m unittest
tests.test_audio` replays every clip through Whisper and the wake matcher.
Clips live in `tests/audio/` (gitignored). Record a few in the real room,
with music on and from across the room.

Swap in a real wake-word engine by replacing the wake check in `main.py`:

- **openWakeWord** — free, no key. Needs a model trained on your phrase
  (`pip install openwakeword`, then train or grab a community model).
- **Picovoice Porcupine** — best accuracy for a custom phrase. Needs a free
  Picovoice access key and a generated `.ppn` file for "mirror mirror on the wall".

## TTS

On Windows `speak.py` keeps **one** PowerShell/SAPI process running and sends it
sentences over stdin. Starting a new one per sentence cost ~400–560 ms each
(~2.7 s over a four-part morning briefing), and a running process can be told
to stop mid-sentence — that's what makes barge-in work: say "stop", "that's
enough" or "never mind" while the mirror talks. Elsewhere it uses `pyttsx3`
(no barge-in). `python speak.py "hello"` is a quick check.

If the answer takes more than 1.5 s, the mirror says "One sec." so the wait
isn't silent.

For a better voice, install `piper-tts`, download a voice `.onnx`, and add a
backend to `speak.py`.
