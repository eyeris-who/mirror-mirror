"""Wake-phrase matching on a transcript.

Transcribe every utterance, look for the wake phrase, and treat whatever
follows it as the command. Whisper never spells a short wake phrase the same
way twice ("hey mirror" comes back as "a mirror", "Hey, Mira", "hay mirror",
or just "Mirror," when "hey" is swallowed), so matching is fuzzy:

  1. normalize both sides (lowercase, drop apostrophes so "what's" -> "whats",
     keep digits so "at 5" survives) and map common mishearings to canonical
     words ("a" -> "hey", "mira" -> "mirror")
  2. slide a window over the first few words and score it against the phrase
     with a character-level similarity ratio; the phrase's LAST word (the
     distinctive one) must also be close, so "hey mom" doesn't wake
  3. accept a transcript that *starts* with the phrase minus its first word
     (Whisper dropping "hey"), or with a 3+ word prefix of a long phrase

The command is returned from the ORIGINAL transcript (punctuation and
apostrophes intact), so the router still sees "what's" and "5 p.m.".

To make it always-on and cheaper, drop in openWakeWord and have main.py call
that instead of transcribing every utterance."""

import re
from difflib import SequenceMatcher

# Minimum similarity (0..1) between the best window and the wake phrase.
# Lower = more forgiving of mishearings, but more false wakes.
THRESHOLD = 0.78
# How many junk words may precede the phrase ("okay hey mirror…").
MAX_LEAD = 1

# Whisper's usual mishearings of wake-phrase words -> the word meant.
_HOMOPHONES = {
    "a": "hey", "8": "hey", "hay": "hey", "eh": "hey", "hi": "hey",
    "he": "hey", "hei": "hey", "heh": "hey",
    "mira": "mirror", "mirra": "mirror", "mera": "mirror", "meara": "mirror",
    "mere": "mirror", "mirrors": "mirror", "mirrored": "mirror",
    "mirrow": "mirror", "miro": "mirror", "near": "mirror",
}


def _words(s):
    """lowercase, apostrophes removed (not split), other punctuation -> space."""
    s = s.lower().replace("'", "").replace("’", "")
    return re.sub(r"[^a-z0-9 ]", " ", s).split()


def _norm(s):
    return " ".join(_words(s))


def _canon(words):
    return [_HOMOPHONES.get(w, w) for w in words]


def _ratio(a, b):
    return SequenceMatcher(None, a, b).ratio()


def _find(tw, ww):
    """Return (score, end_word_index) of the best wake match, or (score, None)."""
    n = len(ww)
    target = " ".join(ww)
    best, best_end = 0.0, None

    spans = [n, n + 1] + ([n - 1] if n >= 3 else [])
    for start in range(0, min(MAX_LEAD + 1, len(tw))):
        for span in spans:
            window = tw[start:start + span]
            if len(window) < span:
                continue
            # the distinctive last word has to be there, roughly
            if _ratio(window[-1], ww[-1]) < 0.6:
                continue
            s = _ratio(" ".join(window), target)
            if s > best + 1e-9:
                best, best_end = s, start + span
    if best >= THRESHOLD:
        return best, best_end

    # Whisper swallowed the first word: transcript begins with the rest.
    if n >= 2:
        tail = ww[1:]
        head = tw[: len(tail)]
        if len(head) == len(tail):
            s = _ratio(" ".join(head), " ".join(tail))
            if s >= 0.85:
                return s, len(tail)

    # A long phrase cut short ("mirror mirror on …"): exact 3+ word prefix.
    for k in range(n - 1, 2, -1):
        if tw[:k] == ww[:k]:
            return k / n, k

    return best, None


def _command_after(transcript, end):
    """Text of the original transcript after normalized word index `end`."""
    tokens = transcript.split()
    count = 0
    for i, tok in enumerate(tokens):
        k = len(_words(tok))
        if count + k > end:
            if count == end:
                rest = " ".join(tokens[i:])
            else:  # this token straddles the phrase ("mirror,what's") — rare
                rest = " ".join(_words(" ".join(tokens))[end:])
            break
        count += k
    else:
        rest = ""
    rest = rest.replace("’", "'")
    rest = re.sub(r"^[\s,.!?;:\-]+", "", rest)
    rest = re.sub(r"[\s,!?;:\-]+$", "", rest)
    # a single trailing period, unless it ends an abbreviation like "p.m."
    if rest.endswith(".") and not re.search(r"\b[a-z]\.[a-z]\.$", rest, re.I):
        rest = rest[:-1]
    return rest.strip()


def wake_score(transcript, wake_phrase):
    """Best similarity between the transcript and the wake phrase (0..1)."""
    tw, ww = _canon(_words(transcript or "")), _canon(_words(wake_phrase or ""))
    if not tw or not ww:
        return 0.0
    return round(_find(tw, ww)[0], 3)


def split_on_wake(transcript, wake_phrase):
    """If the wake phrase is present, return the command text after it
    ('' when nothing follows). Return None when the phrase isn't there."""
    tw, ww = _canon(_words(transcript or "")), _canon(_words(wake_phrase or ""))
    if not ww or not tw:
        return None
    _, end = _find(tw, ww)
    if end is None:
        return None
    return _command_after(transcript, end)
