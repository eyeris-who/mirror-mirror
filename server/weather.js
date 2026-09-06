import { describeCode } from "./weatherCodes.js";
import { getSettings } from "./settings.js";

const { FORECAST_DAYS = "7" } = process.env;

// Cache so we never hammer the API and the mirror still shows something
// if the network blips. Keyed by location so it clears when the user moves.
let cache = { at: 0, key: "", data: null };
const TTL_MS = 30 * 60 * 1000; // 30 minutes

export function clearCache() {
  cache = { at: 0, key: "", data: null };
}

const DOW = new Intl.DateTimeFormat("en-US", { weekday: "short" });

function buildUrl(location, units) {
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", location.latitude);
  u.searchParams.set("longitude", location.longitude);
  u.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min",
  );
  u.searchParams.set("temperature_unit", units);
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("forecast_days", FORECAST_DAYS);
  return u.toString();
}

export async function getWeather() {
  const { location, assistant } = await getSettings();
  const units = assistant?.units === "celsius" ? "celsius" : "fahrenheit";
  const key = `${location.latitude},${location.longitude},${units}`;

  if (cache.data && cache.key === key && Date.now() - cache.at < TTL_MS) {
    return cache.data;
  }

  const res = await fetch(buildUrl(location, units));
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const raw = await res.json();

  const d = raw.daily;
  const days = d.time.map((date, i) => {
    const dt = new Date(`${date}T12:00:00`); // local noon, avoids TZ edge cases
    return {
      date, // "YYYY-MM-DD"
      day: i === 0 ? "Today" : DOW.format(dt), // "Mon", "Tue", ...
      high: Math.round(d.temperature_2m_max[i]),
      low: Math.round(d.temperature_2m_min[i]),
      ...describeCode(d.weather_code[i]), // { text, icon }
    };
  });

  const data = {
    unit: raw.daily_units?.temperature_2m_max ?? "°",
    place: {
      name: location.name,
      admin1: location.admin1,
      country: location.country,
    },
    days,
    updatedAt: new Date().toISOString(),
  };

  cache = { at: Date.now(), key, data };
  return data;
}
