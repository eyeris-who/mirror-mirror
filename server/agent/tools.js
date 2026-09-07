import { getWeather } from "../weather.js";
import { getEvents } from "../schedule.js";
import { getSettings } from "../settings.js";
import * as musicctl from "../musicctl.js";
import * as display from "../display.js";

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

function spokenDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min <= 0) return "";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"}`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hp = `${h} hour${h === 1 ? "" : "s"}`;
  return m ? `${hp} ${m} minute${m === 1 ? "" : "s"}` : hp;
}

async function getScheduleSpoken({ range = "today" } = {}) {
  const events = await getEvents(range);
  const label =
    range === "week" ? "the next week" : range === "tomorrow" ? "tomorrow" : "today";

  if (!events.length) {
    return { speak: `You have nothing scheduled for ${label}.`, data: [] };
  }

  const MAX_SPOKEN = 6;
  const shown = events.slice(0, MAX_SPOKEN);
  const extra = events.length - shown.length;

  const lines = shown.map((e) => {
    const start = new Date(e.start);
    if (e.allDay) return `${e.title}, all day`;

    const at =
      range === "week"
        ? `${weekdayFmt.format(start)} at ${evTimeFmt.format(start)}`
        : `at ${evTimeFmt.format(start)}`;
    const dur = e.end
      ? spokenDuration(new Date(e.end).getTime() - start.getTime())
      : "";
    return `${e.title} ${at}${dur ? ` for ${dur}` : ""}`;
  });

  let speak = `For ${label}: ${joinList(lines)}.`;
  if (extra > 0) speak += ` And ${extra} more.`;
  return { speak, data: events };
}

async function playPlaylist({ name } = {}) {
  try {
    const r = await musicctl.play({ query: name });
    if (r.source === "spotify") {
      return { speak: `Playing ${r.label || "your playlist"} on Spotify.` };
    }
    const what = name ? name : "your morning mix";
    return {
      speak: `Playing ${what} from Audius${r.count ? ` — ${r.count} tracks` : ""}.`,
    };
  } catch (err) {
    if ((err.message || "").includes("nothing_found")) {
      return { speak: "I couldn't find anything for that." };
    }
    return { speak: "I couldn't start any music." };
  }
}

async function playTrending({ genre } = {}) {
  try {
    await musicctl.play({ trending: true, genre });
    return {
      speak: genre
        ? `Playing trending ${genre} from Audius.`
        : "Playing what's trending on Audius.",
    };
  } catch {
    return { speak: "I couldn't load the trending chart." };
  }
}

async function pauseMusic() {
  await musicctl.pause();
  return { speak: "Paused." };
}

async function resumeMusic() {
  await musicctl.resume();
  return { speak: "" }; // just resume, no chatter
}

async function nextTrack() {
  await musicctl.next();
  const s = await musicctl.state();
  const t = s.track;
  const title = t?.title || t?.track;
  return { speak: title ? `Next: ${title}.` : "That's the end of the queue." };
}

async function prevTrack() {
  await musicctl.previous();
  return { speak: "" };
}

async function whatsPlaying() {
  const s = await musicctl.state();
  const t = s.track;
  const title = t?.title || t?.track;
  if (!title) return { speak: "Nothing's playing right now." };
  const artist = t?.artist || t?.artists;
  return { speak: artist ? `${title}, by ${artist}.` : title };
}

function sleepDisplay() {
  display.setOn(false);
  return { speak: "Goodnight." };
}

function wakeDisplay() {
  display.setOn(true);
  return { speak: "" }; // the screen coming back is the confirmation
}

async function runMorningRoutine() {
  display.setOn(true); // if the mirror was asleep, wake it for the briefing
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
      "Start music. `name` is a playlist, artist, genre or mood (e.g. 'lofi', 'the mornings playlist'). Omit `name` for the user's saved morning playlist. Uses Spotify if a Premium account is linked, otherwise Audius.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "play_trending",
    description:
      "Play Audius's current trending chart. `genre` is optional — e.g. 'techno', 'lofi', 'hip hop', 'ambient', 'jazz'.",
    input_schema: {
      type: "object",
      properties: { genre: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "pause_music",
    description: "Pause playback.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "resume_music",
    description: "Resume paused playback.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "next_track",
    description: "Skip to the next track.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "previous_track",
    description:
      "Go back — restart the current track, or to the previous one if it just started.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "whats_playing",
    description: "Say the track and artist currently playing.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_morning_routine",
    description:
      "Speak the date, time, weather and today's events in order, then start the morning playlist.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "sleep_display",
    description:
      "Fade the mirror to black (screen off / sleep / goodnight). Music and voice keep running.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wake_display",
    description: "Bring the mirror back (screen on / wake up).",
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
  play_trending: playTrending,
  pause_music: pauseMusic,
  resume_music: resumeMusic,
  next_track: nextTrack,
  previous_track: prevTrack,
  whats_playing: whatsPlaying,
  sleep_display: sleepDisplay,
  wake_display: wakeDisplay,
  run_morning_routine: runMorningRoutine,
  open_setup: () => ({ speak: "", startSetup: true }),
};

export async function runTool(name, args = {}) {
  const fn = IMPL[name];
  if (!fn) return { speak: "I don't know how to do that yet." };
  return fn(args || {});
}
