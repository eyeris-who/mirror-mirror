"""The conversation loop, driven by fake mic / speaker / server (no audio,
no Whisper, no network). python -m unittest discover -s tests"""

import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import main  # noqa: E402
import noise  # noqa: E402

CFG = {"wakePhrase": "hey mirror", "ackPhrase": "Hmm?"}


class FakeHandle:
    def __init__(self, seconds=0.0):
        self._end = time.time() + seconds
        self.cancelled = False

    def done(self):
        return self.cancelled or time.time() >= self._end

    def wait(self, timeout=None):
        while not self.done():
            time.sleep(0.005)
        return True


class FakeVoice:
    def __init__(self, speech_seconds=0.0, can_interrupt=True):
        self.spoken = []
        self.stopped = 0
        self.speech_seconds = speech_seconds
        self.can_interrupt = can_interrupt
        self._current = None

    def speak_async(self, text):
        self.spoken.append(text)
        self._current = FakeHandle(self.speech_seconds)
        return self._current

    def say(self, text):
        self.speak_async(text).wait()

    def stop(self):
        self.stopped += 1
        if self._current:
            self._current.cancelled = True


class FakeEars:
    """Returns scripted transcripts. `utterances` is a list of strings (or None
    for silence) consumed by next_utterance; transcribe returns the same text."""

    def __init__(self, utterances):
        self.queue = list(utterances)
        self.last_stt_ms = 5
        self.last_confidence = 0.9
        self.calls = []

    def next_utterance(self, **kw):
        self.calls.append(kw)
        stop_when = kw.get("stop_when")
        if not self.queue:
            if stop_when:  # barge-in listening: wait for speech to end
                while not stop_when():
                    time.sleep(0.005)
            return None
        return self.queue.pop(0)

    def transcribe(self, utt):
        return utt or ""


class FakeServer:
    def __init__(self, replies, delay=0.0):
        self.replies = dict(replies)
        self.sent = []
        self.states = []
        self.metrics = []
        self.delay = delay

    def send(self, server, text):
        self.sent.append(text)
        time.sleep(self.delay)
        r = self.replies.get(text, {"speak": "Okay.", "tier": 0})
        return r

    def install(self, test):
        patches = {
            "send_command": self.send,
            "post_state": lambda server, **kw: self.states.append(kw.get("state")),
            "post_metric": lambda server, **kw: self.metrics.append(kw),
        }
        for name, fn in patches.items():
            orig = getattr(main, name)
            setattr(main, name, fn)
            test.addCleanup(setattr, main, name, orig)


class Loop(unittest.TestCase):
    def setUp(self):
        for name, value in {"FILLER_AFTER_S": 0.2, "FOLLOWUP_WINDOW_S": 4, "BARGE_IN": True}.items():
            orig = getattr(main, name)
            setattr(main, name, value)
            self.addCleanup(setattr, main, name, orig)

    def test_wake_with_command_then_quiet(self):
        srv = FakeServer({"what's the time": {"speak": "It's 9:41.", "tier": 0}})
        srv.install(self)
        voice, ears = FakeVoice(), FakeEars([None])
        woke = main.handle_utterance("s", voice, ears, CFG, "Hey mirror, what's the time?")
        self.assertTrue(woke)
        self.assertEqual(srv.sent, ["what's the time"])
        self.assertIn("It's 9:41.", voice.spoken)
        self.assertEqual(srv.states[-1], "idle")

    def test_no_wake_phrase_does_nothing(self):
        srv = FakeServer({})
        srv.install(self)
        self.assertFalse(main.handle_utterance("s", FakeVoice(), FakeEars([]), CFG, "what's the time"))
        self.assertEqual(srv.sent, [])

    def test_follow_up_strips_a_repeated_wake_phrase(self):
        srv = FakeServer({"play jazz": {"speak": "Playing jazz.", "tier": 0}})
        srv.install(self)
        ears = FakeEars(["Hey mirror, pause", None])
        main.handle_utterance("s", FakeVoice(), ears, CFG, "hey mirror play jazz")
        self.assertEqual(srv.sent, ["play jazz", "pause"])

    def test_filler_when_the_server_is_slow(self):
        srv = FakeServer({"where did i park": {"speak": "Level 3.", "tier": 0}}, delay=0.5)
        srv.install(self)
        voice = FakeVoice()
        main.handle_utterance("s", voice, FakeEars([None]), CFG, "hey mirror where did i park")
        self.assertIn(voice.spoken[0], main.FILLERS)
        self.assertEqual(voice.spoken[1], "Level 3.")

    def test_no_filler_when_fast(self):
        srv = FakeServer({"what's the time": {"speak": "It's 9:41.", "tier": 0}})
        srv.install(self)
        voice = FakeVoice()
        main.handle_utterance("s", voice, FakeEars([None]), CFG, "hey mirror what's the time")
        self.assertEqual(voice.spoken, ["It's 9:41."])

    def test_stop_cuts_off_a_long_reply(self):
        article = "A very long article about something. " * 20
        srv = FakeServer({"read me the news": {"speak": article, "tier": 0}})
        srv.install(self)
        voice = FakeVoice(speech_seconds=5)
        ears = FakeEars(["stop", None])  # "stop" heard while speaking, then quiet
        t = time.time()
        main.handle_utterance("s", voice, ears, CFG, "hey mirror read me the news")
        self.assertLess(time.time() - t, 2, "didn't stop speaking")
        self.assertEqual(voice.stopped, 1)
        self.assertTrue(srv.metrics[-1]["interrupted"])

    def test_stop_during_a_question_cancels_the_flow(self):
        srv = FakeServer({
            "forget the gate code": {"speak": "Forget this? Say yes to delete it.", "tier": 0, "expectReply": True, "replyTimeoutMs": 10000},
        })
        srv.install(self)
        voice = FakeVoice(speech_seconds=5)
        main.handle_utterance("s", voice, FakeEars(["be quiet", None]), CFG, "hey mirror forget the gate code")
        self.assertIn("__cancel__", srv.sent)
        self.assertNotIn("__timeout__", srv.sent)

    def test_own_voice_leaking_into_the_mic_does_not_interrupt(self):
        text = "Here are today's headlines. One: markets stop rising."
        srv = FakeServer({"news": {"speak": text, "tier": 0}})
        srv.install(self)
        voice = FakeVoice(speech_seconds=0.3)
        ears = FakeEars(["here are today's headlines one markets stop rising", "stop rising", None])
        main.handle_utterance("s", voice, ears, CFG, "hey mirror news")
        self.assertEqual(voice.stopped, 0)

    def test_blocking_voice_skips_barge_in(self):
        srv = FakeServer({"x": {"speak": "Long reply.", "tier": 0}})
        srv.install(self)
        voice = FakeVoice(can_interrupt=False)
        ears = FakeEars([None])
        main.handle_utterance("s", voice, ears, CFG, "hey mirror x")
        self.assertFalse(any(c.get("stop_when") for c in ears.calls))


class StopPhrase(unittest.TestCase):
    def test_stop_phrases(self):
        for heard in ["stop", "Stop.", "okay stop", "that's enough", "be quiet", "never mind", "hey mirror stop"]:
            with self.subTest(heard=heard):
                self.assertTrue(main.is_stop_phrase(heard, "The weather is sunny."))

    def test_not_stop(self):
        self.assertFalse(main.is_stop_phrase("", "x"))
        self.assertFalse(main.is_stop_phrase("the bus stop is two blocks away from here", "x"), "too long")
        self.assertFalse(main.is_stop_phrase("stop", "Say stop to end."), "the reply itself says stop")
        self.assertFalse(main.is_stop_phrase("what's the weather", "x"))


class Noise(unittest.TestCase):
    def test_floor_rises_with_steady_music_and_falls_back(self):
        t = noise.NoiseTracker(0.01)
        quiet_trigger = t.thresholds()[0]
        for _ in range(400):
            t.update(0.03)  # music on the mirror's speakers
        loud_trigger = t.thresholds()[0]
        self.assertGreater(loud_trigger, quiet_trigger)
        self.assertLessEqual(loud_trigger, noise.MAX_THRESHOLD)
        for _ in range(400):
            t.update(0.005)  # music off
        self.assertAlmostEqual(t.thresholds()[0], quiet_trigger)

    def test_speech_does_not_drag_the_floor_up(self):
        t = noise.NoiseTracker(0.01)
        before = t.floor
        # talking: bursts of loud frames with quiet gaps between words
        for i in range(400):
            t.update(0.08 if i % 3 else 0.008)
        self.assertEqual(t.floor, before)

    def test_sustain_is_below_trigger_and_above_floor(self):
        for floor in (0.001, 0.01, 0.02, 0.05):
            trig, sus = noise.thresholds(floor)
            self.assertLessEqual(sus, trig)
            self.assertGreaterEqual(sus, min(trig, floor))


if __name__ == "__main__":
    unittest.main()
