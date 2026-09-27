"""Adaptive speech gate thresholds (stdlib only, so it's unit-testable anywhere).

The noise floor used to be measured once at startup. Start music on the
mirror's own speakers and every frame is suddenly "louder than 3× the floor":
the gate records back-to-back max-length clips and Whisper transcribes lyrics
non-stop. The tracker follows the room instead — the floor is a low percentile
of the last ~10 s of frame levels, so steady background (music, a fan) raises
it within a few seconds, while speech, which has gaps between words, doesn't.
"""

import collections

# Speech if a frame's RMS is this many times the noise floor, or above a hard
# minimum (covers a silent room where the floor is ~0).
NOISE_MULT = 3.0
MIN_RMS = 0.010
# Never let a loud room push the trigger past this (you still need to be heard).
MAX_THRESHOLD = 0.06


def thresholds(floor):
    """(trigger, sustain): a higher level to START capturing and a lower one to
    KEEP capturing, so soft syllables mid-sentence don't end the utterance."""
    trigger = min(MAX_THRESHOLD, max(MIN_RMS, floor * NOISE_MULT))
    sustain = min(trigger, max(floor * 1.5, trigger * 0.5))
    return trigger, sustain


class NoiseTracker:
    def __init__(self, initial_floor=MIN_RMS, window_frames=333, percentile=20, every=33):
        # 333 frames × 30 ms ≈ 10 s of history, recomputed about once a second
        self.levels = collections.deque(maxlen=window_frames)
        self.percentile = percentile
        self.every = every
        self.floor = max(MIN_RMS, initial_floor)
        self._since = 0

    def reset(self, floor):
        self.levels.clear()
        self.floor = max(MIN_RMS, floor)
        self._since = 0

    def update(self, level):
        """Feed one frame's RMS; returns True when the floor was recomputed."""
        self.levels.append(level)
        self._since += 1
        # need a few seconds of evidence before overriding calibration
        if self._since < self.every or len(self.levels) < self.levels.maxlen // 3:
            return False
        self._since = 0
        ordered = sorted(self.levels)
        idx = min(len(ordered) - 1, int(len(ordered) * self.percentile / 100))
        self.floor = max(MIN_RMS, ordered[idx])
        return True

    def thresholds(self):
        return thresholds(self.floor)
