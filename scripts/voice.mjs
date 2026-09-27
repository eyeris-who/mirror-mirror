// `npm run voice`      — start the Python voice service with its virtualenv
// `npm run test:voice` — run the voice tests (same interpreter)
// Works from any shell, on Windows or macOS/Linux.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const voiceDir = join(root, "voice");
const python = [
  join(voiceDir, ".venv", "Scripts", "python.exe"),
  join(voiceDir, ".venv", "bin", "python"),
].find(existsSync);

if (!python) {
  console.error(
    "voice/.venv not found. Set it up once:\n" +
      "  cd voice\n  python -m venv .venv\n  .venv\\Scripts\\Activate.ps1   (or: source .venv/bin/activate)\n" +
      "  pip install -r requirements.txt",
  );
  process.exit(1);
}

const args = process.argv.includes("--test")
  ? ["-m", "unittest", "discover", "-s", "tests"]
  : ["main.py", ...process.argv.slice(2)];
const child = spawn(python, args, {
  cwd: voiceDir,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
