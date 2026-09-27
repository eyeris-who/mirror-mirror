"""Audio regression clips for the wake + speech-to-text path.

Text tests (tests/test_wake.py) can't catch what goes wrong in audio: clipped
onsets, a model change, noise handling. These clips can. Each clip is a WAV in
tests/audio/ plus a line in tests/audio/labels.json saying what command should
come out of it (null = must NOT wake).

  python clips.py record "hey mirror what's the weather" --expect "what's the weather"
  python clips.py record "turn on the tv" --expect none      # a clip that must not wake
  python clips.py synthetic                                  # seed set via Windows SAPI
  python -m unittest tests.test_audio                        # replay them all

tests/audio/ is gitignored: recordings of your voice stay on this machine.
Record a few in the real room — with music playing, from across the room —
because that's where the mirror actually fails.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO_DIR = os.path.join(HERE, "tests", "audio")
LABELS = os.path.join(AUDIO_DIR, "labels.json")
SR = 16000


def _slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:48] or "clip"


def load_labels():
    try:
        with open(LABELS, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_label(name, spoken, expect, source):
    os.makedirs(AUDIO_DIR, exist_ok=True)
    labels = load_labels()
    labels[name] = {"spoken": spoken, "expect": expect, "source": source}
    with open(LABELS, "w", encoding="utf-8") as f:
        json.dump(labels, f, indent=2)


def record(spoken, expect, seconds=4.0):
    import numpy as np
    import sounddevice as sd

    device = os.environ.get("MIRROR_MIC")
    if device is not None and device.isdigit():
        device = int(device)
    input(f'Press Enter, then say: "{spoken}"')
    audio = sd.rec(int(seconds * SR), samplerate=SR, channels=1, dtype="int16", device=device)
    sd.wait()
    name = f"rec-{_slug(spoken)}.wav"
    with wave.open(os.path.join(AUDIO_DIR, name), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(np.asarray(audio).tobytes())
    save_label(name, spoken, expect, "recorded")
    print(f"saved tests/audio/{name}")


SYNTHETIC = [
    ("hey mirror, what's the weather", "what's the weather"),
    ("hey mirror", ""),
    ("hey mirror, remind me in one minute to brush teeth", "remind me in one minute to brush teeth"),
    ("hey mirror, play some lofi", "play some lofi"),
    ("hey mirror, play trending lofi", "play trending lofi"),
    ("mirror, what time is it", "what time is it"),
    ("what's the time", None),
    ("turn on the TV in the living room", None),
]


def synthetic():
    """Seed clips spoken by Windows SAPI. Clean studio-like audio — useful as a
    smoke test, but record real ones too."""
    os.makedirs(AUDIO_DIR, exist_ok=True)
    for spoken, expect in SYNTHETIC:
        name = f"sapi-{_slug(spoken)}.wav"
        path = os.path.join(AUDIO_DIR, name)
        fd, txt = tempfile.mkstemp(suffix=".txt")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(spoken)
        script = (
            "Add-Type -AssemblyName System.Speech;"
            f"$t=[IO.File]::ReadAllText('{txt}',[Text.Encoding]::UTF8);"
            "$fmt=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,"
            "[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,"
            "[System.Speech.AudioFormat.AudioChannel]::Mono);"
            "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;$s.Rate=1;"
            f"$s.SetOutputToWaveFile('{path}',$fmt);$s.Speak($t);$s.Dispose()"
        )
        subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], check=True)
        os.unlink(txt)
        save_label(name, spoken, expect, "sapi")
        print(f"saved tests/audio/{name}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["synthetic"]:
        synthetic()
    elif args[:1] == ["record"] and len(args) >= 2:
        spoken = args[1]
        expect = spoken
        if "--expect" in args:
            e = args[args.index("--expect") + 1]
            expect = None if e.lower() == "none" else e
        os.makedirs(AUDIO_DIR, exist_ok=True)
        record(spoken, expect)
    else:
        print(__doc__)
