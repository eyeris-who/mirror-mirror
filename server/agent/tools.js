import { getWeather } from "../weather.js";
import { getEvents } from "../schedule.js";
import { getSettings, updateAssistant } from "../settings.js";
import * as musicctl from "../musicctl.js";
import * as display from "../display.js";
import * as news from "../news.js";
import * as reminders from "../reminders.js";

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

// ---- news -------------------------------------------------------------

const ORDINAL = ["", "One", "Two", "Three", "Four", "Five"];
const NUM_WORDS = { first: 1, one: 1, "1": 1, second: 2, two: 2, "2": 2, third: 3, three: 3, "3": 3 };
const STOP = new Set([
  "tell", "about", "read", "more", "hear", "that", "this", "give", "what",
  "story", "article", "headline", "news", "please", "the", "one", "which",
]);

function resolveHeadline(headlines, text) {
  const t = (text || "").toLowerCase().trim();

  // 1. keyword overlap — a distinctive word from one of the headlines
  const words = t.split(/\W+/).filter((w) => w.length > 3 && !STOP.has(w));
  let best = null;
  let bestScore = 0;
  for (const h of headlines) {
    const title = h.title.toLowerCase();
    const score = words.filter((w) => title.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  if (bestScore >= 1) return best;

  // 2. an explicit number pick — only when the utterance is basically just that
  const m = t.match(
    /\b(?:number |headline |article |read |the )?(first|second|third|one|two|three|1|2|3)(?: one)?\b/,
  );
  if (m && t.split(/\s+/).length <= 5) {
    return headlines[NUM_WORDS[m[1]] - 1] || null;
  }
  return null;
}

/** Speak N headlines and pause for a choice. `remaining` = routine steps to run
 *  after the news interaction (empty for a standalone "news" command). */
async function newsPrompt(category, remaining = [], timeoutMs = 12000) {
  const hl = await news.headlines(category, 3).catch(() => []);
  if (!hl.length) {
    return { speak: "I couldn't reach the news right now.", _fallthrough: remaining };
  }
  const lines = [
    `Here are today's ${category} headlines.`,
    ...hl.map((h, i) => `${ORDINAL[i + 1]}: ${h.title}.`),
    "Say a number or a word from a headline to hear more, or say skip.",
  ];
  return {
    speak: lines.join(" "),
    segments: lines,
    expectReply: true,
    replyTimeoutMs: timeoutMs,
    newsFlow: { headlines: hl, category, remaining },
  };
}

async function getNewsSpoken({ category } = {}) {
  const { assistant } = await getSettings();
  return newsPrompt(normCategory(category) || assistant.newsCategory, [], 12000);
}

function normCategory(c) {
  const k = (c || "").toLowerCase().trim();
  const map = {
    tech: "technology",
    technology: "technology",
    world: "world",
    global: "world",
    business: "business",
    finance: "business",
    money: "business",
    science: "science",
    health: "health",
    sport: "sports",
    sports: "sports",
    entertainment: "entertainment",
    showbiz: "entertainment",
    top: "top",
    general: "top",
    headlines: "top",
  };
  return map[k] || (news.CATEGORIES.includes(k) ? k : "");
}

async function setNewsCategory({ category } = {}) {
  const c = normCategory(category);
  if (!c) {
    return {
      speak: `I can do ${news.CATEGORIES.join(", ")}. Which one?`,
    };
  }
  await updateAssistant({ newsCategory: c });
  return { speak: `Okay, news is set to ${c}.` };
}

/** Continue after the headline prompt: read a chosen article, then run any
 *  remaining routine steps (e.g. the playlist). */
export async function continueNewsFlow(flow, text) {
  const t = (text || "").toLowerCase().trim();
  const silent = !t || t === "__timeout__";
  const skip = /^(no|nope|skip|nothing|next|pass|move on|that'?s (all|it|enough))\b/.test(t);

  const parts = [];
  if (!silent && !skip) {
    const choice = resolveHeadline(flow.headlines, t);
    if (choice) {
      const body = await news.readArticle(choice.link);
      parts.push(
        body
          ? `${choice.title}. ${body}`
          : `${choice.title}. ${choice.snippet || "I couldn't pull up the full article."}`,
      );
    }
  }

  for (const step of flow.remaining || []) {
    try {
      const r = await STEP_RUNNERS[step]?.();
      if (r?.speak) parts.push(r.speak);
    } catch {
      /* skip a failing step */
    }
  }

  return {
    speak: parts.join(" "), // empty = silent (e.g. standalone news, no pick)
    segments: parts.length > 1 ? parts : null,
  };
}

// ---- reminders -------------------------------------------------------

function friendlyWhen(date) {
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const time = timeFmt.format(date);
  if (sameDay) return `at ${time}`;
  if (isTomorrow) return `tomorrow at ${time}`;
  return `${weekdayFmt.format(date)} at ${time}`;
}

async function setReminder({ phrase } = {}) {
  const parsed = reminders.parse(phrase || "");
  if (!parsed) {
    return {
      speak:
        "When should I remind you? Try, remind me to call mom at 5 p.m.",
    };
  }
  await reminders.add(parsed.text, parsed.at);
  return {
    speak: `Okay, I'll remind you to ${parsed.text} ${friendlyWhen(new Date(parsed.at))}.`,
  };
}

async function listReminders() {
  const p = await reminders.pending();
  if (!p.length) return { speak: "You have no reminders set." };
  const lines = p
    .slice(0, 5)
    .map((r) => `${r.text} ${friendlyWhen(new Date(r.at))}`);
  return { speak: `Your reminders: ${joinList(lines)}.` };
}

async function clearReminders() {
  const n = await reminders.clearAll();
  return {
    speak: n
      ? `Cleared ${n} reminder${n === 1 ? "" : "s"}.`
      : "You had no reminders to clear.",
  };
}

// ---- morning routine ------------------------------------------------

const STEP_RUNNERS = {
  date: () => getDate(),
  time: () => getTime(),
  weather: () => getWeatherSpoken({ when: "today" }),
  events: () => getScheduleSpoken({ range: "today" }),
  playlist: () => playPlaylist({}),
};

async function runMorningRoutine() {
  display.setOn(true); // if the mirror was asleep, wake it for the briefing
  const { assistant } = await getSettings();
  const steps = assistant.morningRoutine?.length
    ? [...assistant.morningRoutine]
    : ["date", "time", "weather", "events", "news", "playlist"];

  const greeting = assistant.userName
    ? `Good morning, ${assistant.userName}.`
    : "Good morning.";
  const segments = [greeting];

  while (steps.length) {
    const step = steps.shift();

    if (step === "news") {
      const prompt = await newsPrompt(assistant.newsCategory, steps, 7000);
      if (prompt.newsFlow) {
        return {
          speak: [...segments, prompt.speak].join(" "),
          segments: [...segments, ...prompt.segments],
          expectReply: true,
          replyTimeoutMs: 7000,
          newsFlow: prompt.newsFlow,
        };
      }
      continue; // news unavailable — carry on
    }

    try {
      const r = await STEP_RUNNERS[step]?.();
      if (r?.speak) segments.push(r.speak);
    } catch {
      segments.push(`I couldn't get your ${step}.`);
    }
  }

  return { speak: segments.join(" "), segments };
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
    name: "get_news",
    description:
      "Read the top 3 headlines, then let the user pick one to hear more. `category`: technology, world, business, science, health, sports, entertainment, or top.",
    input_schema: {
      type: "object",
      properties: { category: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "set_news_category",
    description:
      "Change which news category the mirror reads. `category` is required.",
    input_schema: {
      type: "object",
      properties: { category: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "set_reminder",
    description:
      "Set a reminder. `phrase` is the whole spoken request including the time, e.g. 'call mom at 5pm' or 'take out the trash in 20 minutes'.",
    input_schema: {
      type: "object",
      properties: { phrase: { type: "string" } },
      required: ["phrase"],
      additionalProperties: false,
    },
  },
  {
    name: "list_reminders",
    description: "Say the reminders that are set.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "clear_reminders",
    description: "Cancel all pending reminders.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_morning_routine",
    description:
      "Speak the date, time, weather, today's events and news headlines, then start the morning playlist.",
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
  get_news: getNewsSpoken,
  set_news_category: setNewsCategory,
  set_reminder: setReminder,
  list_reminders: listReminders,
  clear_reminders: clearReminders,
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
