import "dotenv/config";
import express from "express";
import cors from "cors";
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
import { logMetric } from "./agent/metrics.js";

const app = express();
const PORT = process.env.PORT || 3001;
const WEB_ORIGIN = process.env.WEB_ORIGIN || "http://localhost:5173";

app.use(cors());
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
// Per-caller conversation state (just an in-progress setup flow for now).
const sessions = new Map();

app.post("/api/command", async (req, res) => {
  const { text, sessionId = "default" } = req.body ?? {};
  if (!text || !text.trim()) return res.status(400).json({ error: "no_text" });

  try {
    const session = sessions.get(sessionId) ?? {};
    const out = await handleCommand(text.trim(), session);

    if (out.setup) sessions.set(sessionId, { setup: out.setup });
    else if (out.newsFlow) sessions.set(sessionId, { newsFlow: out.newsFlow });
    else sessions.delete(sessionId);

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
  res.json({ ok: true });
});

app.post("/api/voice/metric", async (req, res) => {
  await logMetric({ kind: "voice", ...(req.body ?? {}) });
  res.json({ ok: true });
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

app
  .listen(PORT, () => console.log(`mirror server on http://localhost:${PORT}`))
  .on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `\nPort ${PORT} is already in use — another mirror server (or a ` +
          `leftover one) is running.\nWindows: npx kill-port ${PORT}   ` +
          `then re-run npm run dev\n`,
      );
      process.exit(1);
    }
    throw err;
  });
