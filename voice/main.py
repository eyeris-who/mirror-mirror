"""Smart-mirror voice loop.

  wait for wake phrase  ->  "Hmm?"  ->  record command  ->  POST /api/command
  ->  speak the reply (say "stop" to cut it off)  ->  hold a short wake-free
  window so you can keep talking  ->  idle

Run the Node server first (npm run dev), then:  python main.py
Ctrl+C to stop.
"""

import concurrent.futures
import os
import random
import re
import time

from config import load
from speak import Voice
from wake import split_on_wake, wake_score

SESSION_ID = "voice"

# After an answer, keep listening this long (no wake phrase needed) for a
# follow-up. Silence closes the conversation. Override with MIRROR_FOLLOWUP_S=0
# to disable and go back to wake-phrase-every-time.
FOLLOWUP_WINDOW_S = float(os.environ.get("MIRROR_FOLLOWUP_S", "4"))

# If the server hasn't answered after this long, say a short filler so the
# wait isn't dead air (local-model routing and memory synthesis can take a few
# seconds). 0 disables.
FILLER_AFTER_S = float(os.environ.get("MIRROR_FILLER_S", "1.5"))
FILLERS = ("One sec.", "Let me check.", "Hmm, one moment.")

# Listen for "stop" while speaking and cut the reply off. Needs the persistent
# SAPI voice (speak.py); 0 disables.
BARGE_IN = os.environ.get("MIRROR_BARGE_IN", "1") != "0"

# A wake phrase plus a command fits in this; capping idle captures keeps steady
# background sound (music) from producing 12 s clips to transcribe.
IDLE_MAX_CAPTURE_S = 8

# Bare phrases that end the conversation instead of being sent as a command.
# ("stop" is deliberately NOT here — it's the router's "pause the music".)
_END_RE = re.compile(
    r"^(that'?s (all|it)|that (will|would) be all|nothing( else)?|"
    r"never ?mind|no,? (thanks|thank you)|i'?m (good|done)|we'?re good|"
    r"all good|done|goodbye|bye|thanks|thank you)[.!]?$"
)

# What interrupts the mirror mid-sentence.
_STOP_RE = re.compile(
    r"\b(stop|enough|quiet|shut up|cancel|never ?mind|okay okay|alright alright)\b"
)

_pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)


def is_end_phrase(s):
    return bool(_END_RE.match(s.strip().lower()))


def _norm(s):
    return re.sub(r"[^a-z' ]", " ", (s or "").lower().replace("’", "'"))


def is_stop_phrase(heard, speaking):
    """A short "stop"/"that's enough" heard while the mirror talks. The mic also
    hears the mirror's own voice, so ignore long transcripts (that's the reply
    leaking back in) and stop words the reply itself contains."""
    words = _norm(heard).split()
    if not words or len(words) > 5:
        return False
    m = _STOP_RE.search(" ".join(words))
    if not m:
        return False
    return not re.search(rf"\b{re.escape(m.group(1))}\b", _norm(speaking))


# ---- server calls --------------------------------------------------------
# `requests` is imported inside each call so the loop can be unit-tested on a
# bare Python (tests replace these functions).


def post_state(server, **kw):
    try:
        import requests

        requests.post(f"{server}/api/voice/state", json=kw, timeout=2)
    except Exception:
        pass


def send_command(server, text):
    import requests

    r = requests.post(
        f"{server}/api/command",
        json={"text": text, "sessionId": SESSION_ID},
        timeout=45,
    )
    r.raise_for_status()
    return r.json()


def post_metric(server, **fields):
    try:
        import requests

        requests.post(f"{server}/api/voice/metric", json=fields, timeout=2)
    except Exception:
        pass


def cancel_flow(server):
    """Drop a half-finished scripted flow (news pick, setup, forget confirm)
    after the user cut the question off, so their next words aren't taken as
    the answer."""
    try:
        send_command(server, "__cancel__")
    except Exception:
        pass


def fetch_reply(server, voice, text):
    """send_command, but if it's slow, say a filler while waiting."""
    fut = _pool.submit(send_command, server, text)
    if FILLER_AFTER_S <= 0:
        return fut.result()
    try:
        return fut.result(timeout=FILLER_AFTER_S)
    except concurrent.futures.TimeoutError:
        handle = voice.speak_async(random.choice(FILLERS))
        reply = fut.result()  # re-raises a failed request
        handle.wait(5)
        return reply


def strip_rewake(text, wake_phrase):
    """In a wake-free window people often say the wake phrase again anyway.
    Returns the text without it, '' if it was only the wake phrase."""
    cmd = split_on_wake(text, wake_phrase)
    return text if cmd is None else cmd


# ---- speaking ------------------------------------------------------------


def speak_interruptible(voice, ears, text):
    """Speak `text`; returns False if the user said "stop" and it was cut off."""
    handle = voice.speak_async(text)
    if not (BARGE_IN and getattr(voice, "can_interrupt", False)):
        handle.wait()
        return True
    while not handle.done():
        utt = ears.next_utterance(
            max_silence_ms=350,
            max_len_s=2.5,
            start_timeout_s=0.3,
            adapt=False,  # our own voice must not raise the noise floor
            stop_when=handle.done,
        )
        if utt is None:
            continue
        heard = ears.transcribe(utt)
        if heard and is_stop_phrase(heard, text):
            print(f"[barge-in] {heard!r}")
            voice.stop()
            handle.wait(3)
            return False
    return True


def speak_reply(voice, ears, reply):
    """Morning routine comes back as `segments`; speak them with small pauses so
    it sounds like a briefing rather than one long run-on. Returns False if the
    user cut it off."""
    segments = reply.get("segments") or [reply.get("speak", "")]
    for seg in segments:
        if not seg:
            continue
        if not speak_interruptible(voice, ears, seg):
            return False
        if len(segments) > 1:
            time.sleep(0.25)
    return True


def check_announcements(server, voice):
    """Fired reminders the server wants spoken. Returns True if it spoke."""
    import requests

    try:
        items = requests.get(
            f"{server}/api/voice/announcements", timeout=2
        ).json().get("items", [])
    except Exception:
        return False
    if not items:
        return False
    for a in items:
        post_state(server, state="speaking", response=a["text"])
        voice.say(a["text"])
    try:
        requests.post(
            f"{server}/api/voice/announcements/ack",
            json={"ids": [a["id"] for a in items]},
            timeout=2,
        )
    except Exception:
        pass
    post_state(server, state="idle")
    return True


# ---- conversation ----------------------------------------------------------


def converse(server, voice, ears, cfg, command, t_heard, stt_ms, stt_conf):
    """One wake-triggered exchange, then a wake-free window to keep talking.

    The server keeps the running transcript per session, so a follow-up like
    "and tomorrow?" or "add that to my reminders" is understood in context.
    Returns when the user goes quiet or says an end phrase.

    Timing: `t_heard` is when the command utterance finished (end of speech),
    `stt_ms` is Whisper's time on that utterance alone.
    """
    while True:
        print(f"[command] {command!r}")
        post_state(server, state="thinking", transcript=command)

        try:
            reply = fetch_reply(server, voice, command)
        except Exception as e:
            print(f"[error] {e}")
            voice.say("Sorry, I couldn't reach the mirror.")
            break

        reply_ms = int((time.time() - t_heard) * 1000)  # end of speech -> answer ready
        print(f"[reply] {reply.get('speak')!r}  (tier {reply.get('tier')}, {reply_ms}ms)")
        post_state(
            server,
            state="speaking",
            transcript=command,
            response=reply.get("speak", ""),
            tier=reply.get("tier"),
            action=reply.get("action"),
        )
        t_tts = time.time()
        finished = speak_reply(voice, ears, reply)
        tts_ms = int((time.time() - t_tts) * 1000)
        interrupted = not finished
        time.sleep(0.3)  # avoid catching the tail of our own speech

        # Scripted follow-ups: spoken setup, picking a news headline, confirming
        # a forget. These ask their own question and listen for the answer.
        while finished and reply.get("expectReply"):
            post_state(server, state="listening", response=reply.get("speak", ""))
            timeout_ms = reply.get("replyTimeoutMs")
            listen_s = timeout_ms / 1000 if timeout_ms else 15
            utt = ears.next_utterance(max_silence_ms=900, start_timeout_s=listen_s)
            answer = ears.transcribe(utt) if utt is not None else ""
            if answer:
                answer = strip_rewake(answer, cfg["wakePhrase"])

            if not answer:
                if timeout_ms:
                    answer = "__timeout__"  # flow wants a fallback (routine -> music)
                else:
                    break
            print(f"[reply] {answer!r}")
            try:
                reply = fetch_reply(server, voice, answer)
            except Exception as e:
                print(f"[error] {e}")
                break
            post_state(
                server, state="speaking", transcript=answer,
                response=reply.get("speak", ""),
            )
            finished = speak_reply(voice, ears, reply)
            interrupted = interrupted or not finished
            time.sleep(0.3)

        if interrupted and reply.get("expectReply"):
            cancel_flow(server)
            reply = {**reply, "expectReply": False}

        post_metric(
            server,
            kind="voice",
            sttMs=stt_ms,
            sttConfidence=stt_conf,
            replyMs=reply_ms,
            ttsMs=tts_ms,
            tier=reply.get("tier"),
            interrupted=interrupted,
        )

        # Don't hold the mic open if the last turn stalled (couldn't help, or a
        # scripted flow is still waiting on an answer the user didn't give).
        if reply.get("tier") in (None, -1) or reply.get("expectReply"):
            break
        if FOLLOWUP_WINDOW_S <= 0:
            break

        post_state(server, state="listening", response=reply.get("speak", ""))
        utt = ears.next_utterance(
            max_silence_ms=900, start_timeout_s=FOLLOWUP_WINDOW_S
        )
        t_heard = time.time()
        nxt = ears.transcribe(utt) if utt is not None else ""
        stt_ms, stt_conf = ears.last_stt_ms, ears.last_confidence
        if not nxt:
            break  # quiet — conversation over
        nxt = strip_rewake(nxt, cfg["wakePhrase"])
        if not nxt:
            print("[follow-up] (wake phrase only)")
            post_state(server, state="listening")
            utt = ears.next_utterance(max_silence_ms=900, start_timeout_s=6)
            t_heard = time.time()
            nxt = ears.transcribe(utt) if utt is not None else ""
            stt_ms, stt_conf = ears.last_stt_ms, ears.last_confidence
            if not nxt:
                break
        if is_end_phrase(nxt):
            print(f"[end] {nxt!r}")
            break

        print(f"[follow-up] {nxt!r}")
        command = nxt

    post_state(server, state="idle")


def handle_utterance(server, voice, ears, cfg, utt):
    """One captured utterance while idle: wake check, then the conversation.
    Returns True if the wake phrase was heard."""
    t_heard = time.time()
    heard = ears.transcribe(utt)
    stt_ms, stt_conf = ears.last_stt_ms, ears.last_confidence
    print(f"[heard] {heard!r}" if heard else "[heard] (nothing transcribed)")
    if not heard:
        return False

    command = split_on_wake(heard, cfg["wakePhrase"])
    # Wake telemetry (no transcript text): lets eval:report show how often
    # utterances nearly matched, for tuning wake.THRESHOLD.
    post_metric(
        server,
        kind="wake",
        woke=command is not None,
        score=wake_score(heard, cfg["wakePhrase"]),
        sttMs=stt_ms,
        sttConfidence=stt_conf,
    )
    if command is None:
        return False  # wake phrase not spoken

    print(f"[wake!] command part: {command!r}")
    post_state(server, state="wake", transcript="", response="")

    if not command:
        voice.say(cfg["ackPhrase"])  # "Hmm?"
        time.sleep(0.25)  # let the speaker settle so we don't hear ourselves
        post_state(server, state="listening")
        utt = ears.next_utterance(max_silence_ms=900, start_timeout_s=6)
        t_heard = time.time()
        command = ears.transcribe(utt) if utt is not None else ""
        stt_ms, stt_conf = ears.last_stt_ms, ears.last_confidence
        if command:
            command = strip_rewake(command, cfg["wakePhrase"])

    if not command:
        voice.say("I didn't catch that.")
        post_state(server, state="idle")
        return True

    converse(server, voice, ears, cfg, command, t_heard, stt_ms, stt_conf)
    return True


def main():
    from listen import Ears  # heavy (Whisper, audio); imported here so tests don't need it

    cfg = load()
    server = cfg["server"]
    print(f"[mirror] server={server}  wake='{cfg['wakePhrase']}'")

    ears = Ears(cfg["whisper_model"], cfg["input_device"], cfg["wakePhrase"])
    ears.calibrate()
    voice = Voice()
    voice.say("Mirror ready.")  # if you don't hear this, TTS is the problem
    post_state(server, state="idle")
    print("[mirror] listening. Say the wake phrase.")

    while True:
        # Return from listening every couple seconds so we can speak fired
        # reminders even while nobody's talking.
        utt = ears.next_utterance(
            max_silence_ms=600, start_timeout_s=2, max_len_s=IDLE_MAX_CAPTURE_S
        )
        if utt is None:
            check_announcements(server, voice)
            continue
        handle_utterance(server, voice, ears, cfg, utt)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[mirror] bye")
