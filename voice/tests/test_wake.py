"""python -m unittest discover -s tests   (from voice/)"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from wake import split_on_wake  # noqa: E402

HEY = "hey mirror"
LONG = "mirror mirror on the wall"


class HeyMirror(unittest.TestCase):
    def test_real_whisper_variants_wake(self):
        cases = {
            "hey mirror whats the weather": "whats the weather",
            "Hey mirror, what's the weather?": "what's the weather",
            "a mirror whats the weather": "whats the weather",
            "A mirror, play some jazz.": "play some jazz",
            "Hey Mira, what is the weather": "what is the weather",
            "hay mirror whats the weather": "whats the weather",
            "he mirror whats the time": "whats the time",
            "Mirror, what's the weather?": "what's the weather",
            "8 mirror whats the weather": "whats the weather",
            "Hey, mirror. Remind me at 5 p.m. to call mom.": "Remind me at 5 p.m. to call mom",
            "Hey mirror, remind me in one minute to brush teeth": "remind me in one minute to brush teeth",
            "Okay, hey mirror, what's playing?": "what's playing",
        }
        for heard, want in cases.items():
            with self.subTest(heard=heard):
                self.assertEqual(split_on_wake(heard, HEY), want)

    def test_bare_wake_phrase_returns_empty(self):
        for heard in ["Hey mirror.", "hey mirror", "A mirror?", "Hey Mira!"]:
            with self.subTest(heard=heard):
                self.assertEqual(split_on_wake(heard, HEY), "")

    def test_ordinary_speech_does_not_wake(self):
        for heard in [
            "hey mom",
            "what's the weather",
            "I bought a new mirror yesterday",
            "hey, can you pass the salt",
            "turn on the TV",
            "Thanks for watching!",
            "you",
            "",
        ]:
            with self.subTest(heard=heard):
                self.assertIsNone(split_on_wake(heard, HEY))

    def test_apostrophes_survive_for_the_router(self):
        # regression: _norm used to turn "what's" into "what s", which no
        # router pattern matches
        self.assertEqual(split_on_wake("Hey mirror, what's the time?", HEY), "what's the time")
        self.assertEqual(split_on_wake("Hey mirror, who’s singing?", HEY), "who's singing")


class LongPhrase(unittest.TestCase):
    def test_long_phrase_and_partials(self):
        cases = {
            "Mirror, mirror on the wall, what's the weather?": "what's the weather",
            "mirror mirror on the wall": "",
            "mirror mirror on the what's the time": "what's the time",
            "mirror on the wall play jazz": "play jazz",
        }
        for heard, want in cases.items():
            with self.subTest(heard=heard):
                self.assertEqual(split_on_wake(heard, LONG), want)

    def test_long_phrase_ignores_chatter(self):
        for heard in ["the wall needs paint", "on the wall", "what's on the calendar"]:
            with self.subTest(heard=heard):
                self.assertIsNone(split_on_wake(heard, LONG))


if __name__ == "__main__":
    unittest.main()
