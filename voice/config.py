"""Voice-service config. Wake phrase and ack come from the Node server
(so changing them at /setup or by voice takes effect on restart); model and
device come from the environment."""

import os
import requests

SERVER = os.environ.get("MIRROR_SERVER", "http://localhost:3001")

DEFAULTS = {
    "wakePhrase": "mirror mirror on the wall",
    "ackPhrase": "Hmm?",
}


def load():
    cfg = dict(DEFAULTS)
    try:
        r = requests.get(f"{SERVER}/api/settings", timeout=3)
        a = r.json().get("assistant", {}) or {}
        cfg["wakePhrase"] = a.get("wakePhrase") or cfg["wakePhrase"]
        cfg["ackPhrase"] = a.get("ackPhrase") or cfg["ackPhrase"]
    except Exception as e:  # server not up yet — fine, use defaults
        print(f"[config] couldn't read server settings, using defaults ({e})")

    cfg["server"] = SERVER
    # tiny.en / base.en / small.en — bigger = more accurate, slower.
    cfg["whisper_model"] = os.environ.get("WHISPER_MODEL", "base.en")
    cfg["input_device"] = os.environ.get("MIRROR_MIC")  # None = system default
    return cfg
