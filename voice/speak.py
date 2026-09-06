"""Text-to-speech.

On Windows we shell out to the built-in SAPI voice via PowerShell — it's
completely reliable, unlike pyttsx3 which tends to speak once and then go
silent when reused in a loop. Elsewhere (and if you set MIRROR_TTS=pyttsx3)
we use pyttsx3.

For a nicer voice, install `piper-tts`, grab a voice `.onnx`, and add a branch
here that pipes piper's PCM to sounddevice."""

import os
import platform
import shutil
import subprocess

_FORCE = os.environ.get("MIRROR_TTS", "").lower()
_USE_SAPI = _FORCE == "sapi" or (
    _FORCE != "pyttsx3"
    and platform.system() == "Windows"
    and shutil.which("powershell")
)


def _sapi_speak(text, rate):
    # rate: SAPI scale is roughly -10..10; map our ~180 wpm default to ~1.
    ps_rate = 1
    safe = text.replace("'", "''")
    script = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        f"$s.Rate = {ps_rate}; "
        f"$s.Speak('{safe}')"
    )
    subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        check=False,
        capture_output=True,
    )


class Voice:
    def __init__(self, rate=182):
        self.rate = rate
        self._pyttsx = None
        if _USE_SAPI:
            print("[speak] using Windows SAPI")
        else:
            import pyttsx3

            self._pyttsx = pyttsx3.init()
            self._pyttsx.setProperty("rate", rate)
            n = len(self._pyttsx.getProperty("voices") or [])
            print(f"[speak] using pyttsx3 ({n} system voice(s))")

    def say(self, text):
        text = " ".join((text or "").split())  # collapse newlines/spaces
        if not text:
            return
        try:
            if _USE_SAPI:
                _sapi_speak(text, self.rate)
            else:
                self._pyttsx.say(text)
                self._pyttsx.runAndWait()
        except Exception as ex:
            print(f"[speak] TTS failed: {ex}")
