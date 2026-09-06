import { describeCode } from "./weatherCodes.js";

const {
  LATITUDE = "40.7128",
  LONGITUDE = "-74.0060",
  FORECAST_HOUR = "18",
  TEMPERATURE_UNIT = "fahrenheit",
} = process.env;

const forecastHour = Number(FORECAST_HOUR);

// Simple in-memory cache so we never hammer the API (and the mirror still
// shows something if the network blips).
let cache = { at: 0, data: null };
const TTL_MS = 10 * 60 * 1000; // 10 minutes

function buildUrl() {
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", LATITUDE);
  u.searchParams.set("longitude", LONGITUDE);
  u.searchParams.set("current", "temperature_2m,weather_code,is_day");
  u.searchParams.set("hourly", "temperature_2m,weather_code");
  u.searchParams.set("temperature_unit", TEMPERATURE_UNIT);
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("forecast_days", "2");
  return u.toString();
}

function pickForecastSlot(hourly) {
  // hourly.time is an array of local ISO strings like "2026-09-06T18:00".
  const now = new Date();
  const target = new Date(now);
  target.setHours(forecastHour, 0, 0, 0);
  const label = target > now ? "later today" : "tomorrow";
  if (target <= now) target.setDate(target.getDate() + 1);

  const wantPrefix =
    `${target.getFullYear()}-` +
    `${String(target.getMonth() + 1).padStart(2, "0")}-` +
    `${String(target.getDate()).padStart(2, "0")}T` +
    `${String(forecastHour).padStart(2, "0")}:00`;

  const idx = hourly.time.findIndex((t) => t.startsWith(wantPrefix));
  if (idx === -1) return null;
  const code = hourly.weather_code[idx];
  return {
    label,
    hour: forecastHour,
    time: hourly.time[idx],
    temperature: Math.round(hourly.temperature_2m[idx]),
    ...describeCode(code),
  };
}

export async function getWeather() {
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data;

  const res = await fetch(buildUrl());
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const raw = await res.json();

  const currentCode = raw.current.weather_code;
  const data = {
    unit: raw.current_units?.temperature_2m ?? "°",
    current: {
      temperature: Math.round(raw.current.temperature_2m),
      isDay: raw.current.is_day === 1,
      ...describeCode(currentCode),
    },
    forecast: pickForecastSlot(raw.hourly),
    updatedAt: new Date().toISOString(),
  };

  cache = { at: Date.now(), data };
  return data;
}
