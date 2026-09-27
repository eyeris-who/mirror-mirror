"""Diagnose the microphone before running main.py.

  python miccheck.py            # live level meter + a 4s record/transcribe test
  python miccheck.py --devices  # list input devices, then meter
  MIRROR_MIC="2" python miccheck.py   # test a specific device (name or index)
"""

import os
import sys
import time
import numpy as np
import sounddevice as sd

SR = 16000
FRAME = SR * 30 // 1000


def rms(x):
    x = x.astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(x * x)))


def list_devices():
    print(sd.query_devices())
    try:
        default_in = sd.default.device[0]
        print(f"\ndefault input device index: {default_in}")
    except Exception:
        pass
    print()


def meter(device, seconds=8):
    print(f"\nLevel meter for {seconds}s — talk normally, say your wake phrase:")
    peak = 0.0
    with sd.InputStream(samplerate=SR, blocksize=FRAME, dtype="int16",
                        channels=1, device=device) as s:
        end = time.time() + seconds
        while time.time() < end:
            frame, _ = s.read(FRAME)
            level = rms(frame[:, 0])
            peak = max(peak, level)
            bar = "#" * int(level * 300)
            print(f"\r{level:6.4f} |{bar:<40}|", end="", flush=True)
    print(f"\n\npeak level: {peak:.4f}")
    if peak < 0.01:
        print("  -> that's basically silence. Wrong device, muted, or mic gain too low.")
        print("     Run:  python miccheck.py --devices   and set MIRROR_MIC to a real input.")
    elif peak < 0.04:
        print("  -> quiet. Move closer or raise mic level in Windows Sound settings.")
    else:
        print("  -> good signal.")
    return peak


def record_test(device, seconds=4):
    # Same model, decoding and wake matching as main.py, so this is a real test.
    from config import load
    from listen import Ears
    from wake import split_on_wake, wake_score

    cfg = load()
    phrase = cfg["wakePhrase"]
    ears = Ears(cfg["whisper_model"], device, phrase)

    print(f"Recording {seconds}s NOW — say: \"{phrase}, what's the weather\"")
    audio = sd.rec(int(seconds * SR), samplerate=SR, channels=1, dtype="float32",
                   device=device)
    sd.wait()
    text = ears.transcribe(audio[:, 0])
    print(f"\ntranscript: {text!r}  ({ears.last_stt_ms}ms, confidence {ears.last_confidence})")
    if not text:
        print("  -> whisper heard nothing. Check the level meter result above.")
        return
    cmd = split_on_wake(text, phrase)
    print(f"wake match: score {wake_score(text, phrase)}  command {cmd!r}")
    if cmd is None:
        print("  -> wake phrase not recognized. Try again, or lower wake.THRESHOLD.")


if __name__ == "__main__":
    dev = os.environ.get("MIRROR_MIC")
    if dev is not None and dev.isdigit():
        dev = int(dev)

    if "--devices" in sys.argv:
        list_devices()

    if meter(dev) >= 0.01:
        record_test(dev)
