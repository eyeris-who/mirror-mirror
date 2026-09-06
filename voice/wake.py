"""Wake-phrase matching on a transcript.

This is deliberately simple: transcribe every utterance, look for the wake
phrase, and treat whatever follows it as the command. Good enough for a quiet
room and zero extra dependencies.

To make it always-on and cheaper, drop in openWakeWord (train a model on the
phrase) or Picovoice Porcupine (needs a free access key + a custom .ppn) and
have main.py call that instead of transcribing every utterance."""

import re


def _norm(s):
    # lowercase, drop punctuation, collapse whitespace ("Mirror, mirror" -> "mirror mirror")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", s.lower())).strip()


def split_on_wake(transcript, wake_phrase):
    """If the wake phrase is present, return the command text after it
    ('' when nothing follows). Return None when the phrase isn't there."""
    t = _norm(transcript)
    w = _norm(wake_phrase)
    if not w:
        return None

    if w in t:
        return t.split(w, 1)[1].strip()

    # tolerate a dropped word or two at the head ("mirror on the wall")
    words = w.split()
    for n in range(len(words), 2, -1):
        head = " ".join(words[:n])
        if head in t:
            return t.split(head, 1)[1].strip()

    return None
