"""Microphone -> utterance -> text.

Energy-gated capture: measure the room's noise floor, then treat frames louder
than a multiple of it as speech. Record from the moment speech starts until a
short trailing silence, then transcribe with faster-whisper.

Two details matter a lot for accuracy on short commands:
  - the trigger fires partway into the first word (quiet onsets like the "r"
    in "remind" sit below the threshold), so a generous pre-roll buffer is
    prepended — without it "remind me in a minute" arrives as "me in a minute"
  - hysteresis: a high level to START capturing, a lower one to KEEP capturing,
    so soft syllables mid-sentence don't end the utterance early

No always-on wake engine and no native VAD dependency. See wake.py for how the
wake phrase is matched, and the README for swapping in openWakeWord."""

import collections
import math
import os
import re
import time

import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel

from noise import MIN_RMS, NoiseTracker

SAMPLE_RATE = 16000
FRAME_MS = 30
FRAME_LEN = SAMPLE_RATE * FRAME_MS // 1000  # samples per frame

# Audio kept from BEFORE the trigger fired, so word onsets aren't clipped.
PREROLL_MS = 800
# Noise (a door, a hum) makes Whisper hallucinate short words — measured at
# confidence <= 0.29 with no-speech probability >= 0.43, vs 0.85+ for real
# speech. Transcripts below BOTH bars are treated as silence.
MIN_CONFIDENCE = float(os.environ.get("MIRROR_MIN_CONF", "0.35"))
NOISE_NO_SPEECH = 0.4

DEBUG = bool(os.environ.get("MIRROR_DEBUG"))


def _rms(frame_i16):
    x = frame_i16.astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(x * x)) + 1e-9)


def _default_threads():
    # CTranslate2 is fastest on physical cores; logical/2 is a safe guess.
    env = os.environ.get("WHISPER_THREADS")
    if env and env.isdigit():
        return int(env)
    return max(1, min(8, (os.cpu_count() or 4) // 2))


def _vocab_prompt(wake_phrase):
    """Decoder hint: the words this mirror actually hears. The wake phrase goes
    LAST so a leaked prompt never looks like "<wake phrase> <command>"."""
    w = (wake_phrase or "hey mirror").strip().rstrip(".").title()
    # No one-word sentences: on noise the decoder likes to echo a short prompt
    # sentence ("Pause.") back verbatim.
    return (
        "Play some lofi. What's the weather? Remind me to call mom in ten "
        f"minutes. Play trending lofi. What's on my schedule today? {w}."
    )


def _words(s):
    return re.sub(r"[^a-z0-9 ]", " ", s.lower().replace("'", "")).split()


class Ears:
    def __init__(self, model_name="base.en", device=None, wake_phrase=None):
        threads = _default_threads()
        print(f"[listen] loading whisper '{model_name}' ({threads} threads; first run downloads it)…")
        self.model = WhisperModel(
            model_name, device="cpu", compute_type="int8", cpu_threads=threads
        )
        self.device = device
        # thresholds follow the room (see noise.py) instead of a one-off startup
        # measurement
        self.noise = NoiseTracker(MIN_RMS)
        self.prompt = _vocab_prompt(wake_phrase)
        self._prompt_words = " ".join(_words(self.prompt))
        self.last_confidence = None
        self.last_stt_ms = None

    def _stream(self):
        return sd.InputStream(
            samplerate=SAMPLE_RATE,
            blocksize=FRAME_LEN,
            dtype="int16",
            channels=1,
            device=self.device,
        )

    @property
    def noise_floor(self):
        return self.noise.floor

    def calibrate(self, seconds=0.6):
        """Seed the noise floor from a short sample of the room."""
        vals = []
        with self._stream() as s:
            for _ in range(int(seconds * 1000 / FRAME_MS)):
                frame, _ = s.read(FRAME_LEN)
                vals.append(_rms(frame[:, 0]))
        self.noise.reset(float(np.median(vals)))
        trigger, sustain = self.noise.thresholds()
        print(
            f"[listen] noise floor ~{self.noise_floor:.4f}  trigger ~{trigger:.4f}"
            f"  sustain ~{sustain:.4f}  (adapts as the room changes)"
        )

    def next_utterance(
        self,
        max_silence_ms=800,
        max_len_s=12,
        start_timeout_s=None,
        adapt=True,
        stop_when=None,
    ):
        """Block until speech starts, capture until `max_silence_ms` of trailing
        silence, return float32 audio (or None if `start_timeout_s` passes with
        no speech).

        adapt:     feed frames to the noise tracker. Off while the mirror is
                   talking, so its own voice doesn't raise the floor.
        stop_when: optional callable checked every frame; when it returns True,
                   return what was captured so far (None if nothing).
        """
        trigger, sustain = self.noise.thresholds()
        preroll = collections.deque(maxlen=max(1, PREROLL_MS // FRAME_MS))
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
                if adapt and self.noise.update(level):
                    trigger, sustain = self.noise.thresholds()
                if stop_when is not None and stop_when():
                    if not triggered:
                        return None
                    break

                if not triggered:
                    preroll.append(mono.copy())
                    waited_ms += FRAME_MS
                    if level > trigger:
                        triggered = True
                        voiced.extend(preroll)
                        preroll.clear()
                    elif start_timeout_s and waited_ms / 1000 >= start_timeout_s:
                        return None
                else:
                    voiced.append(mono.copy())
                    silence_ms = 0 if level > sustain else silence_ms + FRAME_MS
                    too_long = len(voiced) * FRAME_MS / 1000 >= max_len_s
                    if silence_ms >= max_silence_ms or too_long:
                        break

        if DEBUG:
            secs = len(voiced) * FRAME_MS / 1000
            print(
                f"[listen] captured {secs:.1f}s  peak={peak:.4f}  "
                f"trigger={trigger:.4f} sustain={sustain:.4f}"
            )
        audio = np.concatenate(voiced).astype(np.float32) / 32768.0
        return audio

    def transcribe(self, audio):
        t0 = time.time()
        # Whisper is trained on 30s windows and gets unreliable on sub-second
        # clips; a short "hey mirror" decodes far better with some silence
        # around it.
        pad = SAMPLE_RATE // 4
        if len(audio) < SAMPLE_RATE:
            audio = np.pad(audio, (0, SAMPLE_RATE - len(audio)))
        audio = np.pad(audio, (pad, pad)).astype(np.float32)

        segments, _ = self.model.transcribe(
            audio,
            language="en",
            beam_size=5,
            condition_on_previous_text=False,
            temperature=[0.0, 0.2, 0.4],
            initial_prompt=self.prompt,
        )
        # Whisper's own "this was silence" rule: drop segments it's unsure of.
        segs = [
            s for s in segments
            if not (s.no_speech_prob > 0.6 and s.avg_logprob < -1.0)
        ]
        text = " ".join(s.text for s in segs).strip()

        conf = _confidence(segs)
        nsp = (sum(s.no_speech_prob for s in segs) / len(segs)) if segs else 1.0
        if text and conf < MIN_CONFIDENCE and nsp > NOISE_NO_SPEECH:
            if DEBUG:
                print(f"[listen] dropped low-confidence {text!r} conf={conf} nsp={nsp:.2f}")
            segs, text = [], ""

        # A noise clip can make the decoder parrot its prompt back. Drop
        # anything that is a long verbatim run of the prompt.
        words = _words(text)
        if len(words) >= 5 and " ".join(words) in self._prompt_words:
            if DEBUG:
                print(f"[listen] dropped prompt echo: {text!r}")
            segs, text = [], ""

        self.last_confidence = _confidence(segs)  # 0..1, for observability
        self.last_stt_ms = int((time.time() - t0) * 1000)
        return text


def _confidence(segs):
    """Rough transcription confidence from Whisper's own logprobs."""
    if not segs:
        return 0.0
    lp = sum(getattr(s, "avg_logprob", -1.0) for s in segs) / len(segs)
    nsp = sum(getattr(s, "no_speech_prob", 0.0) for s in segs) / len(segs)
    return round(max(0.0, min(1.0, math.exp(lp) * (1.0 - nsp))), 3)
