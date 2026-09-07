# Voice service

A small Python process that does the talking and listening. It never contains
any logic about *what* to answer — it captures speech, sends the text to the
Node server's `/api/command`, and speaks back whatever comes out.

Python **3.10–3.14**. If `pip install` ever fails building a wheel from C/Rust
source (missing "Microsoft Visual C++ 14.0"), that package has no wheel for your
Python version — make the venv with an older one: `py -3.12 -m venv .venv`.

```
mic ─► energy VAD ─► faster-whisper ─► "mirror mirror on the wall" ?
                                        │ yes
                                        ▼
                              speak "Hmm?"  ─► record command ─► whisper
                                        │
                                        ▼
                        POST localhost:3001/api/command {text}
                                        │
                                        ▼
                     speak reply  (morning routine = speak each segment)
```

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
| `MIRROR_SERVER` env | Node server URL (default `http://localhost:3001`) |
| `WHISPER_MODEL` env | `tiny.en` \| `base.en` (default) \| `small.en` — bigger = slower, more accurate |
| `MIRROR_MIC` env | input device name/index if not the system default (`python -m sounddevice` lists them) |

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

Right now `listen.py` uses a plain energy threshold (calibrated to the room at
startup) to find utterances, then transcribes each one and checks for the wake
phrase (`wake.py`). Simple, no native dependencies, fine in a quiet room.
Downsides: constant Whisper load, and it struggles with background noise or a TV.

Swap in a real wake-word engine by replacing the wake check in `main.py`:

- **openWakeWord** — free, no key. Needs a model trained on your phrase
  (`pip install openwakeword`, then train or grab a community model).
- **Picovoice Porcupine** — best accuracy for a custom phrase. Needs a free
  Picovoice access key and a generated `.ppn` file for "mirror mirror on the wall".

## TTS

`speak.py` uses `pyttsx3` (offline, uses the OS voice — SAPI5 on Windows). For a
better voice, install `piper-tts`, download a voice `.onnx`, and swap `Voice.say`.
