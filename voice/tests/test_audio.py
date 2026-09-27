"""Replay recorded clips through the real transcription + wake path.

Skipped when there are no clips (tests/audio/ is gitignored) or when Whisper
isn't installed (CI). See clips.py for recording them."""

import os
import re
import sys
import unittest
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))

import clips  # noqa: E402
from wake import split_on_wake  # noqa: E402

LABELS = clips.load_labels()

try:
    import numpy as np
    from faster_whisper import WhisperModel

    import listen
except Exception:  # CI: no audio stack
    listen = None


def _norm(s):
    return re.sub(r"[^a-z0-9 ]", "", (s or "").lower().replace("'", "")).split()


@unittest.skipIf(listen is None, "faster-whisper / numpy not installed")
@unittest.skipIf(not LABELS, "no clips — run: python clips.py synthetic (or record)")
class AudioReplay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from config import load

        cfg = load()
        cls.wake_phrase = os.environ.get("MIRROR_TEST_WAKE", "hey mirror")
        ears = listen.Ears.__new__(listen.Ears)  # no microphone needed
        ears.model = WhisperModel(
            cfg["whisper_model"], device="cpu", compute_type="int8",
            cpu_threads=listen._default_threads(),
        )
        ears.prompt = listen._vocab_prompt(cls.wake_phrase)
        ears._prompt_words = " ".join(listen._words(ears.prompt))
        cls.ears = ears

    def test_clips(self):
        for name, label in sorted(LABELS.items()):
            path = os.path.join(clips.AUDIO_DIR, name)
            if not os.path.exists(path):
                continue
            with self.subTest(clip=name):
                with wave.open(path) as w:
                    audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
                heard = self.ears.transcribe(audio.astype(np.float32) / 32768.0)
                cmd = split_on_wake(heard, self.wake_phrase)
                expect = label["expect"]
                if expect is None:
                    self.assertIsNone(cmd, f"woke on {heard!r}")
                else:
                    self.assertIsNotNone(cmd, f"didn't wake on {heard!r}")
                    self.assertEqual(_norm(cmd), _norm(expect), f"heard {heard!r}")


if __name__ == "__main__":
    unittest.main()
