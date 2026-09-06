"""Microphone -> utterance -> text.

Energy-gated capture: measure the room's noise floor, then treat frames louder
than a multiple of it as speech. Record from the moment speech starts until a
short trailing silence, then transcribe with faster-whisper.

No always-on wake engine and no native VAD dependency. See wake.py for how the
wake phrase is matched, and the README for swapping in openWakeWord."""

import collections
import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel

SAMPLE_RATE = 16000
FRAME_MS = 30
FRAME_LEN = SAMPLE_RATE * FRAME_MS // 1000  # samples per frame

# Speech if a frame's RMS is this many times the measured noise floor, or above
# a hard minimum (covers a silent room where the floor is ~0).
NOISE_MULT = 3.0
MIN_RMS = 0.010
# Never let a noisy calibration push the trigger past this.
MAX_THRESHOLD = 0.06

DEBUG = bool(__import__("os").environ.get("MIRROR_DEBUG"))


def _rms(frame_i16):
    x = frame_i16.astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(x * x)) + 1e-9)


class Ears:
    def __init__(self, model_name="base.en", device=None):
        print(f"[listen] loading whisper '{model_name}' (first run downloads it)…")
        self.model = WhisperModel(model_name, device="cpu", compute_type="int8")
        self.device = device
        self.noise_floor = MIN_RMS

    def _stream(self):
        return sd.InputStream(
            samplerate=SAMPLE_RATE,
            blocksize=FRAME_LEN,
            dtype="int16",
            channels=1,
            device=self.device,
        )

    def calibrate(self, seconds=0.6):
        """Sample ambient noise so the threshold adapts to the room."""
        vals = []
        with self._stream() as s:
            for _ in range(int(seconds * 1000 / FRAME_MS)):
                frame, _ = s.read(FRAME_LEN)
                vals.append(_rms(frame[:, 0]))
        self.noise_floor = max(MIN_RMS, float(np.median(vals)))
        thr = min(MAX_THRESHOLD, max(MIN_RMS, self.noise_floor * NOISE_MULT))
        print(
            f"[listen] noise floor ~{self.noise_floor:.4f}  trigger ~{thr:.4f}"
            "  (say something ~2x louder than the floor to trigger)"
        )

    def next_utterance(self, max_silence_ms=800, max_len_s=12, start_timeout_s=None):
        """Block until speech starts, capture until `max_silence_ms` of trailing
        silence, return float32 audio (or None if `start_timeout_s` passes with
        no speech)."""
        threshold = min(MAX_THRESHOLD, max(MIN_RMS, self.noise_floor * NOISE_MULT))
        preroll = collections.deque(maxlen=max(1, 300 // FRAME_MS))
        triggered = False
        voiced = []
        silence_ms = 0
        waited_ms = 0
        peak = 0.0

        with self._stream() as s:
            while True:
                frame, _ = s.read(FRAME_LEN)
                mono = frame[:, 0]
                level = _rms(mono)
                peak = max(peak, level)
                speech = level > threshold

                if not triggered:
                    preroll.append(mono.copy())
                    waited_ms += FRAME_MS
                    if speech:
                        triggered = True
                        voiced.extend(preroll)
                        preroll.clear()
                    elif start_timeout_s and waited_ms / 1000 >= start_timeout_s:
                        return None
                else:
                    voiced.append(mono.copy())
                    silence_ms = 0 if speech else silence_ms + FRAME_MS
                    too_long = len(voiced) * FRAME_MS / 1000 >= max_len_s
                    if silence_ms >= max_silence_ms or too_long:
                        break

        if DEBUG:
            secs = len(voiced) * FRAME_MS / 1000
            print(f"[listen] captured {secs:.1f}s  peak={peak:.4f}  thr={threshold:.4f}")
        audio = np.concatenate(voiced).astype(np.float32) / 32768.0
        return audio

    def transcribe(self, audio):
        segments, _ = self.model.transcribe(audio, language="en", beam_size=1)
        return " ".join(s.text for s in segments).strip()
