import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getWeather, clearCache as clearWeatherCache } from "./weather.js";
import { getSchedule } from "./schedule.js";
import { getSettings, setLocation, updateAssistant } from "./settings.js";
import * as geo from "./geo.js";
import * as google from "./google.js";
import * as spotify from "./spotify.js";
import * as audius from "./audius.js";
import * as musicctl from "./musicctl.js";
import * as player from "./player.js";
import * as display from "./display.js";
import * as news from "./news.js";
import * as reminders from "./reminders.js";
import * as llm from "./agent/llm.js";
import { handleCommand } from "./agent/index.js";
import { warmLocalRouter } from "./agent/router.js";
import { logMetric } from "./agent/metrics.js";
import * as memory from "./memory/index.js";
import * as events from "./events.js";
import { accessPolicy } from "./security.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3001);
const WEB_ORIGIN = process.env.WEB_ORIGIN || "http://localhost:5173";
// Loopback only by default: the page, the voice service and this server all
// run on the mirror itself, and this API hands out personal memory.
const HOST = process.env.HOST || "";

// Host + Origin checks — see security.js for why both.
const access = accessPolicy({
  webOrigin: WEB_ORIGIN,
  port: PORT,
  allowedHosts: process.env.ALLOWED_HOSTS,
});
app.use(access.middleware);
app.use(cors({ origin: access.origins }));
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ---- data --------------------------------------------------------------
app.get("/api/weather", async (_req, res) => {
  try {
    res.json(await getWeather());
  } catch (err) {
    console.error("weather:", err.message);
    res.status(502).json({ error: "weather_unavailable" });
  }
});

app.get("/api/schedule", async (_req, res) => {
  try {
    res.json({ events: await getSchedule() });
  } catch (err) {
    console.error("schedule:", err.message);
    res.status(500).json({ error: "schedule_unavailable" });
  }
});

// ---- location settings ----------------------------------------------
app.get("/api/settings", async (_req, res) => {
  res.json(await getSettings());
});

app.put("/api/settings/location", async (req, res) => {
  const loc = req.body ?? {};
  if (!Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) {
    return res.status(400).json({ error: "bad_location" });
  }
  try {
    const saved = await setLocation(loc);
    clearWeatherCache();
    res.json(saved);
  } catch (err) {
    console.error("settings:", err.message);
    res.status(500).json({ error: "save_failed" });
  }
});

app.put("/api/settings/assistant", async (req, res) => {
  try {
    const saved = await updateAssistant(req.body ?? {});
    clearWeatherCache(); // units may have changed
    res.json(saved);
  } catch (err) {
    console.error("assistant settings:", err.message);
    res.status(500).json({ error: "save_failed" });
  }
});

app.get("/api/geo/search", async (req, res) => {
  try {
    res.json({ results: await geo.search(String(req.query.q ?? "")) });
  } catch (err) {
    console.error("geo search:", err.message);
    res.status(502).json({ error: "geocoding_unavailable" });
  }
});

app.get("/api/geo/reverse", async (req, res) => {
  try {
    res.json(await geo.reverse(Number(req.query.lat), Number(req.query.lon)));
  } catch (err) {
    console.error("geo reverse:", err.message);
    res.status(502).json({ error: "reverse_geocoding_unavailable" });
  }
});

// ---- connection status (drives the setup page) ------------------------
app.get("/api/status", async (_req, res) => {
  res.json({
    google: {
      configured: google.isConfigured(),
      connected: await google.isConnected(),
    },
    spotify: {
      configured: spotify.isConfigured(),
      connected: await spotify.isConnected(),
      premium: (await spotify.isConnected()) && (await spotify.isPremium()),
    },
    music: { source: await musicctl.activeSource() },
    assistant: {
      cloudConfigured: llm.cloudConfigured(),
      localReachable: await llm.localAvailable(),
    },
  });
});

// ---- Google OAuth ----------------------------------------------------
app.get("/api/auth/google", (_req, res) => {
  if (!google.isConfigured())
    return res.status(400).send("Google not configured — see server/.env");
  res.redirect(google.authUrl());
});

app.get("/api/auth/google/callback", async (req, res) => {
  try {
    await google.handleCallback(req.query.code);
    res.redirect(`${WEB_ORIGIN}/setup?google=connected`);
  } catch (err) {
    console.error("google callback:", err.message);
    res.redirect(`${WEB_ORIGIN}/setup?google=error`);
  }
});

app.post("/api/auth/google/disconnect", async (_req, res) => {
  await google.disconnect();
  res.json({ ok: true });
});

// ---- Spotify OAuth -------------------------------------------------
app.get("/api/auth/spotify", (_req, res) => {
  if (!spotify.isConfigured())
    return res.status(400).send("Spotify not configured — see server/.env");
  res.redirect(spotify.authUrl());
});

app.get("/api/auth/spotify/callback", async (req, res) => {
  try {
    await spotify.handleCallback(req.query.code);
    // Free accounts can't stream through the API — reject the connection.
    const profile = await spotify.me().catch(() => null);
    if (!profile || profile.product !== "premium") {
      await spotify.disconnect();
      return res.redirect(`${WEB_ORIGIN}/setup?spotify=free`);
    }
    res.redirect(`${WEB_ORIGIN}/setup?spotify=connected`);
  } catch (err) {
    console.error("spotify callback:", err.message);
    res.redirect(`${WEB_ORIGIN}/setup?spotify=error`);
  }
});

app.post("/api/auth/spotify/disconnect", async (_req, res) => {
  await spotify.disconnect();
  res.json({ ok: true });
});

// ---- Spotify playback --------------------------------------------
// Browser needs a short-lived token for the Web Playback SDK.
app.get("/api/spotify/token", async (_req, res) => {
  try {
    res.json({ token: await spotify.getAccessToken() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/spotify/now-playing", async (_req, res) => {
  try {
    res.json(await spotify.nowPlaying());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/spotify/playlists", async (req, res) => {
  try {
    const all = await spotify.listPlaylists();
    const q = String(req.query.q ?? "").trim().toLowerCase();
    res.json({
      playlists: q
        ? all.filter((p) => p.name.toLowerCase().includes(q))
        : all,
    });
  } catch (err) {
    console.error("spotify playlists:", err.message);
    res.status(400).json({ error: err.message });
  }
});

const control = (fn) => async (req, res) => {
  try {
    await fn(req);
    res.json({ ok: true });
  } catch (err) {
    console.error("spotify control:", err.message);
    res.status(400).json({ error: err.message });
  }
};

app.post("/api/spotify/play", control((req) => spotify.play(req.body ?? {})));
app.post("/api/spotify/pause", control(() => spotify.pause()));
app.post("/api/spotify/next", control(() => spotify.next()));
app.post("/api/spotify/previous", control(() => spotify.previous()));
app.post(
  "/api/spotify/transfer",
  control((req) => spotify.transfer(req.body.deviceId, req.body.play ?? true)),
);
app.post(
  "/api/spotify/play-search",
  control((req) => spotify.playSearch(req.body.query, req.body.type)),
);

// ---- music (source-agnostic: Spotify Premium OR Audius) -------------
app.get("/api/music/state", async (_req, res) => {
  res.json(await musicctl.state());
});

app.post("/api/music/play", async (req, res) => {
  try {
    res.json(await musicctl.play(req.body ?? {}));
  } catch (err) {
    console.error("music play:", err.message);
    res.status(400).json({ error: err.message });
  }
});

const mctl = (fn) => async (_req, res) => {
  try {
    res.json((await fn()) ?? { ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
app.post("/api/music/pause", mctl(() => musicctl.pause()));
app.post("/api/music/resume", mctl(() => musicctl.resume()));
app.post("/api/music/next", mctl(() => musicctl.next()));
app.post("/api/music/previous", mctl(() => musicctl.previous()));

// Audius only: the mirror page reports its real <audio> position here.
app.post("/api/music/report", (req, res) => {
  res.json(player.report(req.body ?? {}));
});

// Preview Audius results (for the setup page when Spotify isn't the source).
app.get("/api/music/audius/search", async (req, res) => {
  try {
    res.json({ tracks: await audius.search(String(req.query.q ?? ""), 10) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- voice / assistant ---------------------------------------------
// Per-caller conversation state: rolling history, plus any in-progress setup or
// news-choice flow. Dropped after a lull so a new conversation starts clean.
const sessions = new Map();
const SESSION_TTL_MS = 5 * 60_000;

function sweepSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) if ((s.updatedAt ?? 0) < cutoff) sessions.delete(id);
}

app.post("/api/command", async (req, res) => {
  const { text, sessionId = "default" } = req.body ?? {};
  if (typeof text !== "string" || !text.trim())
    return res.status(400).json({ error: "no_text" });

  try {
    sweepSessions();
    const prev = sessions.get(sessionId);
    const session =
      prev && Date.now() - (prev.updatedAt ?? 0) < SESSION_TTL_MS
        ? prev
        : { history: [] };

    const out = await handleCommand(text.trim(), session, { sessionId });

    session.setup = out.setup ?? null;
    session.newsFlow = out.newsFlow ?? null;
    session.forgetFlow = out.forgetFlow ?? null;
    session.updatedAt = Date.now();
    sessions.set(sessionId, session);

    res.json({
      speak: out.speak,
      segments: out.segments,
      action: out.action,
      expectReply: out.expectReply,
      replyTimeoutMs: out.replyTimeoutMs,
      tier: out.tier,
    });
  } catch (err) {
    console.error("command:", err.message);
    res
      .status(500)
      .json({ error: "command_failed", speak: "Sorry, something went wrong." });
  }
});

// Live state for the on-mirror voice indicator. The Python service POSTs here;
// the web app polls it.
let voiceState = { state: "idle", transcript: "", response: "", tier: null };

// Is the mirror awake? The page polls this and fades to black when off.
app.get("/api/display", (_req, res) => res.json({ on: display.isOn() }));
app.post("/api/display", (req, res) => {
  res.json({ on: display.setOn(req.body?.on !== false) });
});

app.get("/api/voice/state", (_req, res) => res.json(voiceState));

app.post("/api/voice/state", (req, res) => {
  voiceState = { ...voiceState, ...(req.body ?? {}), at: new Date().toISOString() };
  events.publish("voice", voiceState);
  res.json({ ok: true });
});

app.post("/api/voice/metric", async (req, res) => {
  const body = req.body ?? {};
  const kind = body.kind === "wake" ? "wake" : "voice";
  await logMetric({ ...body, kind });
  res.json({ ok: true });
});

// Live updates for the mirror page (display on/off, voice state) as
// Server-Sent Events — replaces three 1–2s polling loops.
app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  send("display", { on: display.isOn() });
  send("voice", voiceState);
  const unsubscribe = events.subscribe(send);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

// ---- reminders ----------------------------------------------------
app.get("/api/reminders", async (_req, res) => {
  res.json({ reminders: await reminders.pending() });
});

app.delete("/api/reminders", async (_req, res) => {
  const n = await reminders.clearAll();
  res.json({ cleared: n });
});

// Things the voice service should speak (fired reminders). It polls this,
// speaks them, then acks by id.
let announcements = [];
app.get("/api/voice/announcements", (_req, res) =>
  res.json({ items: announcements }),
);
app.post("/api/voice/announcements/ack", (req, res) => {
  const ids = new Set(req.body?.ids ?? []);
  announcements = announcements.filter((a) => !ids.has(a.id));
  res.json({ ok: true });
});

// Fire reminders exactly at their time: a timer armed for the next due
// reminder, re-armed whenever the list changes or one fires. A 30s ceiling
// on the wait acts as a safety net (system sleep, clock jumps).
let reminderTimer = null;
async function scanReminders() {
  try {
    const due = await reminders.dueNow();
    for (const r of due) {
      announcements.push({ id: r.id, text: `Reminder: ${r.text}.` });
      display.setOn(true); // wake the mirror so the reminder is seen
    }
  } catch (err) {
    console.error("reminder scan:", err.message);
  }
  armReminderTimer();
}
async function armReminderTimer() {
  clearTimeout(reminderTimer);
  let delay = 30_000;
  try {
    const next = await reminders.nextDueAt();
    if (next != null) delay = Math.max(0, Math.min(next - Date.now(), 30_000));
  } catch {
    /* keep the 30s fallback */
  }
  reminderTimer = setTimeout(scanReminders, delay);
}
reminders.watch(armReminderTimer);
armReminderTimer();

// ---- news (category list for the setup page) ---------------------
app.get("/api/news/categories", (_req, res) =>
  res.json({ categories: news.CATEGORIES }),
);

// ---- memory (personal RAG) --------------------------------------
app.get("/api/memory/status", async (_req, res) => {
  res.json(await memory.status());
});

app.post("/api/memory/reindex", async (_req, res) => {
  res.json(await memory.ingest());
});

// Retrieval only — inspect what would be recalled, no synthesis.
app.get("/api/memory/search", async (req, res) => {
  try {
    res.json(await memory.search(String(req.query.q ?? "")));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// What the mirror remembers, newest first (drives the list on /setup).
app.get("/api/memory/recent", (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  try {
    res.json({ items: memory.recent({ limit, offset }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Forget one memory: index + vector + source log line + tombstone.
app.delete("/api/memory/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad_id" });
  try {
    const r = await memory.forget(id);
    if (!r) return res.status(404).json({ error: "not_found" });
    res.json({ forgotten: { id: r.id, source: r.source, file: r.file } });
  } catch (err) {
    console.error("memory forget:", err.message);
    res.status(500).json({ error: "forget_failed" });
  }
});

// Keep the local model loaded and its tool prompt cached (Ollama keep_alive is
// 30 min; re-warm before that). Cheap when already warm (~1s).
const warm = () =>
  warmLocalRouter().then((ok) => ok && console.log("local router warm"));
setTimeout(warm, 3000);
setInterval(warm, 20 * 60_000).unref();

memory.startIngestLoop(undefined, {
  retentionDays: async () => (await getSettings()).memory?.retentionDays ?? 0,
});

// ---- production: serve the built mirror page ---------------------------
// `npm run build` then `npm start` — one process, no Vite. Kiosk at
// http://localhost:3001 (set WEB_ORIGIN to that for the OAuth redirects).
const WEB_DIST = join(here, "..", "web", "dist");
if (existsSync(join(WEB_DIST, "index.html"))) {
  app.use(express.static(WEB_DIST));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(WEB_DIST, "index.html")));
}

// ---- listen ----------------------------------------------------------
// Default: both loopback addresses. "localhost" resolves to ::1 first on
// Windows, and a refused IPv6 connect there can stall ~2s before falling back.
const bindTo = HOST ? [HOST] : ["127.0.0.1", "::1"];
let bound = 0;
for (const host of bindTo) {
  http
    .createServer(app)
    .listen(PORT, host, () => {
      if (bound++ === 0) console.log(`mirror server on http://localhost:${PORT}`);
      console.log(`  listening on ${host.includes(":") ? `[${host}]` : host}:${PORT}`);
      if (HOST && !["127.0.0.1", "localhost", "::1"].includes(HOST))
        console.warn("  ! reachable from your network — see ALLOWED_HOSTS in .env.example");
    })
    .on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `\nPort ${PORT} is already in use — another mirror server (or a ` +
            `leftover one) is running.\nWindows: npx kill-port ${PORT}   ` +
            `then re-run npm run dev\n`,
        );
        process.exit(1);
      }
      // ::1 unavailable (IPv6 disabled) is fine as long as 127.0.0.1 bound
      if (host === "::1" && ["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(err.code)) return;
      throw err;
    });
}
