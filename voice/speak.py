"""Text-to-speech.

On Windows the mirror talks through the built-in SAPI voice. It used to start a
fresh PowerShell for every sentence, which cost ~400–560 ms before any sound
(measured) — the morning routine's six segments wasted ~2.5 s. Now ONE
PowerShell process stays up and takes commands on stdin:

    S <id> <base64 text>   speak asynchronously; replies "D <id>" when done
    X                      stop speaking now (barge-in); pending ids complete
    V <0-100>              volume

so speech starts immediately and can be interrupted. If that process dies it is
restarted; if it can't start, each sentence falls back to a one-shot process.
Elsewhere (or MIRROR_TTS=pyttsx3) pyttsx3 is used, which can't be interrupted.

For a nicer voice, install `piper-tts`, grab a voice `.onnx`, and add a backend
here that pipes piper's PCM to sounddevice."""

import base64
import itertools
import os
import platform
import shutil
import subprocess
import tempfile
import threading
import time

_FORCE = os.environ.get("MIRROR_TTS", "").lower()
_USE_SAPI = _FORCE == "sapi" or (
    _FORCE != "pyttsx3"
    and platform.system() == "Windows"
    and shutil.which("powershell")
)

# Runs inside the long-lived PowerShell. Reads stdin without blocking the loop
# (StreamReader.ReadLineAsync on the raw stdin stream) so it can report each
# utterance finishing while still accepting commands such as X (stop).
_SERVER_PS = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = __RATE__
$s.Volume = __VOLUME__
$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$out = [Console]::Out
$pending = New-Object System.Collections.ArrayList
$read = $in.ReadLineAsync()
$out.WriteLine('READY'); $out.Flush()
while ($true) {
  if ($read.IsCompleted) {
    $line = $read.Result
    if ($null -eq $line) { break }
    $parts = $line.Split(' ', 3)
    switch ($parts[0]) {
      'S' {
        $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[2]))
        $p = $s.SpeakAsync($text)
        [void]$pending.Add(@($parts[1], $p))
      }
      'X' { $s.SpeakAsyncCancelAll() }
      'V' { $s.Volume = [int]$parts[1] }
    }
    $read = $in.ReadLineAsync()
  }
  for ($i = $pending.Count - 1; $i -ge 0; $i--) {
    if ($pending[$i][1].IsCompleted) {
      $out.WriteLine('D ' + $pending[$i][0]); $out.Flush()
      $pending.RemoveAt($i)
    }
  }
  Start-Sleep -Milliseconds 15
}
"""


def _one_shot_sapi(text, volume=100):
    """Fallback: a fresh PowerShell per sentence (the old, slow path). Text goes
    through a UTF-8 temp file so quotes/dashes can't break the command."""
    fd, path = tempfile.mkstemp(suffix=".txt", prefix="mirror-tts-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        script = (
            "$ErrorActionPreference='Stop';"
            f"$t=[IO.File]::ReadAllText('{path}',[Text.Encoding]::UTF8);"
            "Add-Type -AssemblyName System.Speech;"
            "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
            f"$s.Rate=1;$s.Volume={int(volume)};$s.Speak($t)"
        )
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            check=False, capture_output=True, text=True,
        )
        if r.returncode != 0:
            print(f"[speak] SAPI error: {(r.stderr or '').strip()[:200]}")
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


class _SapiServer:
    def __init__(self, rate=1, volume=100):
        self.rate = rate
        self.volume = volume
        self._proc = None
        self._lock = threading.Lock()
        self._done = {}  # id -> threading.Event
        self._ids = itertools.count(1)
        self._ready = threading.Event()

    def _start(self):
        script = _SERVER_PS.replace("__RATE__", str(int(self.rate))).replace(
            "__VOLUME__", str(int(self.volume))
        )
        encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        self._ready.clear()
        self._proc = subprocess.Popen(
            ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        threading.Thread(target=self._reader, args=(self._proc,), daemon=True).start()
        if not self._ready.wait(15):
            raise RuntimeError("SAPI server did not start")

    def _reader(self, proc):
        for raw in iter(proc.stdout.readline, b""):
            line = raw.decode("utf-8", "replace").strip()
            if line == "READY":
                self._ready.set()
            elif line.startswith("D "):
                ev = self._done.pop(line[2:], None)
                if ev:
                    ev.set()
        # process ended: release anyone waiting
        for ev in list(self._done.values()):
            ev.set()
        self._done.clear()

    def _alive(self):
        return self._proc is not None and self._proc.poll() is None

    def _send(self, line):
        with self._lock:
            if not self._alive():
                self._start()
            self._proc.stdin.write((line + "\n").encode("utf-8"))
            self._proc.stdin.flush()

    def speak_async(self, text):
        uid = str(next(self._ids))
        ev = threading.Event()
        self._done[uid] = ev
        payload = base64.b64encode(text.encode("utf-8")).decode("ascii")
        self._send(f"S {uid} {payload}")
        return ev

    def stop(self):
        if self._alive():
            self._send("X")

    def close(self):
        if self._alive():
            try:
                self._proc.stdin.close()
                self._proc.wait(3)
            except Exception:
                self._proc.kill()


class Voice:
    """`say()` blocks until spoken. `speak_async()` returns a handle with
    `.wait(timeout)` and `.done()`; `stop()` interrupts (SAPI only)."""

    def __init__(self, rate=182, volume=100):
        self.rate = rate
        self.volume = volume
        self._pyttsx = None
        self._server = None
        self.can_interrupt = False
        if _USE_SAPI:
            try:
                self._server = _SapiServer(rate=1, volume=volume)
                self._server._start()
                self.can_interrupt = True
                print("[speak] using Windows SAPI (persistent)")
            except Exception as ex:
                print(f"[speak] persistent SAPI unavailable ({ex}); one process per sentence")
                self._server = None
        else:
            import pyttsx3

            self._pyttsx = pyttsx3.init()
            self._pyttsx.setProperty("rate", rate)
            n = len(self._pyttsx.getProperty("voices") or [])
            print(f"[speak] using pyttsx3 ({n} system voice(s))")

    @staticmethod
    def _clean(text):
        return " ".join((text or "").split())  # collapse newlines/spaces

    def speak_async(self, text):
        text = self._clean(text)
        if not text:
            return _Handle(None)
        if self._server:
            try:
                return _Handle(self._server.speak_async(text))
            except Exception as ex:
                print(f"[speak] SAPI server failed ({ex}); falling back")
                self._server = None
                self.can_interrupt = False
        # blocking backends: speak now, hand back a finished handle
        self._say_blocking(text)
        return _Handle(None)

    def say(self, text):
        self.speak_async(text).wait()

    def stop(self):
        if self._server:
            self._server.stop()

    def _say_blocking(self, text):
        try:
            if _USE_SAPI:
                _one_shot_sapi(text, self.volume)
            else:
                self._pyttsx.say(text)
                self._pyttsx.runAndWait()
        except Exception as ex:
            print(f"[speak] TTS failed: {ex}")

    def close(self):
        if self._server:
            self._server.close()


class _Handle:
    def __init__(self, event):
        self._event = event

    def done(self):
        return self._event is None or self._event.is_set()

    def wait(self, timeout=120):
        if self._event is not None:
            self._event.wait(timeout)
        return self.done()


if __name__ == "__main__":
    # quick manual check:  python speak.py "hello there"
    import sys

    v = Voice()
    t = time.time()
    h = v.speak_async(" ".join(sys.argv[1:]) or "Mirror voice check.")
    print(f"started in {int((time.time() - t) * 1000)} ms")
    h.wait()
    print(f"finished after {int((time.time() - t) * 1000)} ms")
    v.close()
