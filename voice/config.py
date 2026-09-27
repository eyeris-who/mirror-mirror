"""Voice-service config. Wake phrase and ack come from the Node server
(so changing them at /setup or by voice takes effect on restart); model and
device come from the environment."""

import os

SERVER = os.environ.get("MIRROR_SERVER", "http://127.0.0.1:3001")

DEFAULTS = {
    "wakePhrase": "mirror mirror on the wall",
    "ackPhrase": "Hmm?",
}


def load():
    cfg = dict(DEFAULTS)
    try:
        import requests  # here, so importing config needs no third-party packages

        r = requests.get(f"{SERVER}/api/settings", timeout=3)
        a = r.json().get("assistant", {}) or {}
        cfg["wakePhrase"] = a.get("wakePhrase") or cfg["wakePhrase"]
        cfg["ackPhrase"] = a.get("ackPhrase") or cfg["ackPhrase"]
    except Exception as e:  # server not up yet — fine, use defaults
        print(f"[config] couldn't read server settings, using defaults ({e})")

    cfg["server"] = SERVER
    # tiny.en / base.en / distil-small.en / small.en — bigger = more accurate,
    # slower. distil-small.en is the best accuracy-per-ms step up from base.en.
    cfg["whisper_model"] = os.environ.get("WHISPER_MODEL", "base.en")
    cfg["input_device"] = os.environ.get("MIRROR_MIC")  # None = system default
    return cfg
