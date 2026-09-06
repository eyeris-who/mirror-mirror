import "dotenv/config";
import express from "express";
import cors from "cors";
import { getWeather } from "./weather.js";
import { getSchedule } from "./schedule.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

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

// --- Where the voice layer plugs in later -----------------------------------
// app.post("/api/command", async (req, res) => {
//   const { text } = req.body;              // transcript from Whisper
//   const result = await routeCommand(text); // LLM + tool calling
//   res.json(result);
// });
// ---------------------------------------------------------------------------

app.listen(PORT, () => console.log(`mirror server on http://localhost:${PORT}`));
