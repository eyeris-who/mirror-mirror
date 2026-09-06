"""Smart-mirror voice loop.

  wait for wake phrase  ->  "Hmm?"  ->  record command  ->  POST /api/command
  ->  speak the reply  ->  (handle spoken setup follow-ups)  ->  idle

Run the Node server first (npm run dev), then:  python main.py
Ctrl+C to stop.
"""

import time
import requests

from config import load
from listen import Ears
from wake import split_on_wake
from speak import Voice

SESSION_ID = "voice"


def post_state(server, **kw):
    try:
        requests.post(f"{server}/api/voice/state", json=kw, timeout=2)
    except Exception:
        pass


def send_command(server, text):
    r = requests.post(
        f"{server}/api/command",
        json={"text": text, "sessionId": SESSION_ID},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def speak_reply(voice, reply):
    """Morning routine comes back as `segments`; speak them with small pauses so
    it sounds like a briefing rather than one long run-on."""
    segments = reply.get("segments")
    if segments:
        for seg in segments:
            voice.say(seg)
            time.sleep(0.25)
    else:
        voice.say(reply.get("speak", ""))


def main():
    cfg = load()
    server = cfg["server"]
    print(f"[mirror] server={server}  wake='{cfg['wakePhrase']}'")

    ears = Ears(cfg["whisper_model"], cfg["input_device"])
    ears.calibrate()
    voice = Voice()
    voice.say("Mirror ready.")  # if you don't hear this, TTS is the problem
    post_state(server, state="idle")
    print("[mirror] listening. Say the wake phrase.")

    while True:
        utt = ears.next_utterance(max_silence_ms=600)
        if utt is None:
            continue

        t_wake = time.time()
        heard = ears.transcribe(utt)
        # Always show what was heard while you're dialing things in.
        print(f"[heard] {heard!r}" if heard else "[heard] (nothing transcribed)")

        command = split_on_wake(heard, cfg["wakePhrase"]) if heard else None
        if command is None:
            continue  # wake phrase not spoken

        print(f"[wake!] command part: {command!r}")
        post_state(server, state="wake", transcript="", response="")

        if not command:
            voice.say(cfg["ackPhrase"])  # "Hmm?"
            time.sleep(0.25)  # let the speaker settle so we don't hear ourselves
            post_state(server, state="listening")
            utt = ears.next_utterance(max_silence_ms=900, start_timeout_s=6)
            command = ears.transcribe(utt) if utt is not None else ""

        stt_ms = int((time.time() - t_wake) * 1000)
        if not command:
            voice.say("I didn't catch that.")
            post_state(server, state="idle")
            continue

        print(f"[command] {command!r}")
        post_state(server, state="thinking", transcript=command)

        try:
            reply = send_command(server, command)
        except Exception as e:
            print(f"[error] {e}")
            voice.say("Sorry, I couldn't reach the mirror.")
            post_state(server, state="idle")
            continue

        print(f"[reply] {reply.get('speak')!r}  (tier {reply.get('tier')})")
        post_state(
            server,
            state="speaking",
            transcript=command,
            response=reply.get("speak", ""),
            tier=reply.get("tier"),
        )
        t_tts = time.time()
        speak_reply(voice, reply)
        tts_ms = int((time.time() - t_tts) * 1000)
        time.sleep(0.3)  # avoid catching the tail of our own speech as a command

        # spoken setup (or any multi-turn flow): keep listening, no wake phrase
        while reply.get("expectReply"):
            post_state(server, state="listening", response=reply.get("speak", ""))
            utt = ears.next_utterance(max_silence_ms=900, start_timeout_s=12)
            answer = ears.transcribe(utt) if utt is not None else ""
            if not answer:
                break
            print(f"[reply] {answer!r}")
            try:
                reply = send_command(server, answer)
            except Exception as e:
                print(f"[error] {e}")
                break
            post_state(
                server, state="speaking", transcript=answer,
                response=reply.get("speak", ""),
            )
            speak_reply(voice, reply)

        try:
            requests.post(
                f"{server}/api/voice/metric",
                json={
                    "wakeToReplyMs": int((time.time() - t_wake) * 1000),
                    "sttMs": stt_ms,
                    "ttsMs": tts_ms,
                    "tier": reply.get("tier"),
                },
                timeout=2,
            )
        except Exception:
            pass

        post_state(server, state="idle")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[mirror] bye")
