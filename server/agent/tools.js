import { getWeather } from "../weather.js";
import { getEvents } from "../schedule.js";
import { getSettings } from "../settings.js";
import * as spotify from "../spotify.js";

// Every tool returns { speak: string, data?, action?, segments? }.
// `speak` is read aloud. `data` is for the mirror HUD. `segments` is used by
// the morning routine so the HUD can step through it.

const timeFmt = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});
const dateFmt = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
});
const evTimeFmt = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});
const weekdayFmt = new Intl.DateTimeFormat("en-US", { weekday: "long" });

function joinList(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function unitWord(unit) {
  return /f/i.test(unit) ? "Fahrenheit" : "Celsius";
}

function getTime() {
  return { speak: `It's ${timeFmt.format(new Date())}.` };
}

function getDate() {
  return { speak: `Today is ${dateFmt.format(new Date())}.` };
}

async function getWeatherSpoken({ when = "today" } = {}) {
  const w = await getWeather();
  const deg = unitWord(w.unit);

  if (when === "week") {
    const parts = w.days
      .slice(0, 7)
      .map((d) => `${d.day} ${d.text.toLowerCase()}, ${d.low} to ${d.high}`);
    return {
      speak: `Here's the week in ${w.place.name}. ${joinList(parts)} degrees ${deg}.`,
      data: w,
    };
  }

  const d = w.days[when === "tomorrow" ? 1 : 0];
  const label = when === "tomorrow" ? "Tomorrow" : "Right now";
  return {
    speak: `${label} in ${w.place.name}: ${d.text.toLowerCase()}, with a high of ${d.high} and a low of ${d.low} degrees ${deg}.`,
    data: d,
  };
}

async function getScheduleSpoken({ range = "today" } = {}) {
  const events = await getEvents(range);
  const label =
    range === "week" ? "the next week" : range === "tomorrow" ? "tomorrow" : "today";

  if (!events.length) {
    return { speak: `You have nothing scheduled for ${label}.`, data: [] };
  }

  const lines = events.map((e) => {
    const start = new Date(e.start);
    if (range === "week") {
      const day = weekdayFmt.format(start);
      return e.allDay
        ? `${e.title} on ${day}`
        : `${e.title} ${day} at ${evTimeFmt.format(start)}`;
    }
    return e.allDay
      ? `${e.title}, all day`
      : `${e.title} at ${evTimeFmt.format(start)}`;
  });

  return { speak: `For ${label}: ${joinList(lines)}.`, data: events };
}

async function playPlaylist({ name } = {}) {
  const { assistant } = await getSettings();
  const query = (name || assistant.morningPlaylist || "").trim();

  if (!(await spotify.isConnected())) {
    return { speak: "Spotify isn't connected yet. Open the mirror's setup page to link it." };
  }
  if (!query) {
    return { speak: "You haven't set a morning playlist yet. Say setup to choose one." };
  }

  await spotify.playSearch(query, "playlist");
  return { speak: `Playing ${query}.`, action: { type: "spotify_play", query } };
}

async function runMorningRoutine() {
  const { assistant } = await getSettings();
  const steps = assistant.morningRoutine?.length
    ? assistant.morningRoutine
    : ["date", "time", "weather", "events", "playlist"];

  const runners = {
    date: () => getDate(),
    time: () => getTime(),
    weather: () => getWeatherSpoken({ when: "today" }),
    events: () => getScheduleSpoken({ range: "today" }),
    playlist: () => playPlaylist({}),
  };

  const segments = [];
  for (const step of steps) {
    try {
      const r = await runners[step]?.();
      if (r?.speak) segments.push(r.speak);
    } catch {
      segments.push(`I couldn't get your ${step}.`);
    }
  }

  const greeting = assistant.userName
    ? `Good morning, ${assistant.userName}.`
    : "Good morning.";

  return { speak: [greeting, ...segments].join(" "), segments: [greeting, ...segments] };
}

// --- Registry: schemas the LLM tiers see, plus the implementations ---------

export const TOOLS = [
  {
    name: "get_time",
    description: "The current time of day.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_date",
    description: "Today's date.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_weather",
    description:
      "Weather for the user's location. `when`: 'today' (default), 'tomorrow', or 'week' for the 7-day outlook.",
    input_schema: {
      type: "object",
      properties: { when: { type: "string", enum: ["today", "tomorrow", "week"] } },
      additionalProperties: false,
    },
  },
  {
    name: "get_schedule",
    description:
      "The user's calendar events. `range`: 'today' (default), 'tomorrow', or 'week'.",
    input_schema: {
      type: "object",
      properties: { range: { type: "string", enum: ["today", "tomorrow", "week"] } },
      additionalProperties: false,
    },
  },
  {
    name: "play_playlist",
    description:
      "Play a Spotify playlist by name. Omit `name` to play the user's saved morning playlist.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "run_morning_routine",
    description:
      "Speak the date, time, weather and today's events in order, then start the morning playlist.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_setup",
    description:
      "Begin the spoken setup flow (asks for the user's name, wake phrase, morning playlist and temperature units).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const IMPL = {
  get_time: getTime,
  get_date: getDate,
  get_weather: getWeatherSpoken,
  get_schedule: getScheduleSpoken,
  play_playlist: playPlaylist,
  run_morning_routine: runMorningRoutine,
  open_setup: () => ({ speak: "", startSetup: true }),
};

export async function runTool(name, args = {}) {
  const fn = IMPL[name];
  if (!fn) return { speak: "I don't know how to do that yet." };
  return fn(args || {});
}
