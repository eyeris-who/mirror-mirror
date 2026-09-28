import { getSettings } from "../settings.js";
import { TOOLS } from "./tools.js";
import * as llm from "./llm.js";
import { RECALL_RE } from "./patterns.js";
import { selectTools } from "./toolSelect.js";

/**
 * Hybrid router. Three tiers, cheapest first:
 *
 *   tier 0  deterministic patterns   — 0 ms, $0, offline
 *   tier 1  local model (Ollama)     — ~hundreds of ms, $0, offline
 *   tier 2  cloud model (Claude)     — ~1 s, costs money, needs internet
 *
 * A request only falls through to the next tier when the current one can't
 * answer confidently. Every command carries its tier into the metrics log so
 * you can see the local/cloud split.
 */

/**
 * Repair what speech-to-text reliably gets wrong before any matching happens.
 * Each rule comes from a real transcript in data/metrics.jsonl — keep the list
 * short and evidence-based; it runs on every command.
 */
export function normalizeTranscript(text) {
  return (
    String(text ?? "")
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      // "what s the time" (apostrophe turned into a space somewhere upstream)
      .replace(/\b(what|who|where|when|that|it|there|how|here) s\b/gi, "$1's")
      // "low-fi" / "low fi" / "Lo-Fi" -> "lofi" (what Audius and the router expect)
      .replace(/\blo(?:w)?[\s-]?fi\b/gi, "lofi")
      // clipped/misheard "play": "Place on low-fi", "Plays some jazz"
      .replace(/^(?:place|plays|played|lay|pay) (?:on|some) /i, "play some ")
      // "A trending low-fi" — "play" swallowed down to "a"
      .replace(/^(?:a|uh) (trending|top)\b/i, "play $1")
      // trailing sentence punctuation from Whisper ("Pause?")
      .replace(/[.!?]+$/, "")
  );
}

const NUMBER_WORD =
  "(?:\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|forty-five|sixty|half an?)";
// "me in one minute to brush teeth" — "remind" clipped off the front
const CLIPPED_REMINDER = new RegExp(
  `^(?:me\\s+|remind\\s+)?in\\s+${NUMBER_WORD}\\s+(?:minutes?|mins?|hours?|hrs?|seconds?)\\s+(?:to|that|about)\\s+\\S`,
);

// "forget what I said about the gate code", "delete my note about parking"
const FORGET_RE =
  /^(?:please\s+)?(?:forget|erase|delete|remove)\s+(?!.*\breminders?\b)(?:(?:what|everything)\s+i\s+(?:said|told you|mentioned|noted|wrote)\s+(?:about\s+)?|(?:my|the)\s+(?:last\s+)?(?:note|journal entry|memory)\s*(?:about\s+|that\s+)?|about\s+)?(.*)$/;

// First-person facts worth keeping: "I need to buy printer ink", "I parked on
// level 3", "my locker code is 12". Checked at tier 0, AFTER every command
// pattern — measured: llama3.2:3b sent "I need to buy printer ink and stamps"
// to get_news after 13s. Kept deliberately narrow (errands and where-things-
// are), so "I want to hear jazz" still reaches the models.
const DECLARATIVE_RE =
  /^(?:i|we)\s+(?:need to|have to|got to|gotta|must)\s+(?:buy|get|pick up|grab|order|call|email|text|pay|renew|return|book|fix|clean|finish|send|schedule|cancel|replace|drop off|bring|pack|submit|sign)\b|^(?:i|we)\s+(?:parked|left|put|hid|lent|loaned|owe|borrowed|moved|stored)\b|^(?:i|we)(?:'ve| have)\s+(?:parked|left|put|lent|borrowed|moved)\b|^(?:my|our)\s+.{2,40}?\s+(?:is|are|was|were)\s+\S/;

export function implicitNote(text) {
  const t = text.toLowerCase().trim();
  if (t.split(/\s+/).length < 3 || /\?$/.test(text)) return null;
  if (/^(what|when|where|who|why|how|is|are|do|does|did|can|could|will|would|should i)\b/.test(t))
    return null;
  return DECLARATIVE_RE.test(t) ? { text: text.trim() } : null;
}

function detectRange(t) {
  if (/\btomorrow\b/.test(t)) return "tomorrow";
  if (/\b(this|next|the)\s+week\b|week ahead|next seven days|rest of the week/.test(t))
    return "week";
  return "today";
}

export function tier0(text) {
  const t = text.toLowerCase().trim();
  const range = detectRange(t);

  if (/morning routine|start (my )?(morning|day)|^good morning\b/.test(t))
    return { tier: 0, tool: "run_morning_routine" };

  // --- memory: take a note ---
  {
    const m = text.match(
      /^\s*(?:hey mirror[,\s]*)?(?:(?:please )?(?:take a |make a )?note[:\s]+(?:that\s+)?|remember that\s+|(journal)[:\s]+(?:that\s+)?|(?:add (?:a |an )?journal entry[:\s]+))(.+)/i,
    );
    if (m) {
      return {
        tier: 0,
        tool: "add_note",
        args: { text: m[2].trim(), journal: Boolean(m[1]) },
      };
    }
  }

  // --- memory: forget something (checked before recall — "forget what I said…") ---
  {
    const m = t.match(FORGET_RE);
    if (m) return { tier: 0, tool: "forget", args: { query: m[1].trim() } };
  }

  // --- memory: recall a past thing the user said / noted ---
  if (RECALL_RE.test(t))
    return { tier: 0, tool: "recall", args: { query: text } };

  // --- display sleep / wake ---
  if (
    /\b(go to sleep|sleep mode|goodnight|good night)\b|turn off (the )?(display|screen|mirror)|(display|screen|mirror) off|shut (off|down) (the )?(display|screen)/.test(
      t,
    )
  )
    return { tier: 0, tool: "sleep_display" };
  if (
    /\bwake up\b|turn on (the )?(display|screen|mirror)|(display|screen|mirror) on|wake the (mirror|screen|display)|^wake\b/.test(
      t,
    )
  )
    return { tier: 0, tool: "wake_display" };

  if (/\bset ?up\b|configure( the)? (mirror|assistant)|change (my )?settings/.test(t))
    return { tier: 0, tool: "open_setup" };

  // --- reminders (check "remind me" before anything else) ---
  if (/\bremind me\b|set (a |an )?reminder|make (a |an )?reminder/.test(t))
    return { tier: 0, tool: "set_reminder", args: { phrase: text } };
  if (/\b(list|show|what( are|'?s)|check|any of my|do i have( any)?)\b.*\breminders?\b/.test(t))
    return { tier: 0, tool: "list_reminders" };
  if (/\b(clear|cancel|delete|remove|forget)\b.*\breminders?\b/.test(t))
    return { tier: 0, tool: "clear_reminders" };
  // looser forms STT produces: "reminder in two minutes to…", "me in one minute to…"
  if (
    /^(?:a |the )?reminder\b.*\b(?:in|at|on|for|tomorrow|tonight)\b/.test(t) ||
    CLIPPED_REMINDER.test(t)
  )
    return { tier: 0, tool: "set_reminder", args: { phrase: text } };

  // --- news ---
  {
    const cat = t.match(
      /\b(tech(nology)?|world|business|finance|science|health|sports?|entertainment)\b.*\bnews\b|\bnews\b.*\b(tech(nology)?|world|business|finance|science|health|sports?|entertainment)\b/,
    );
    if (/\bset (the |my )?news( category)? to \b|\bchange (the )?news (category )?to \b/.test(t)) {
      const m = t.match(/news( category)? to ([a-z]+)/);
      return { tier: 0, tool: "set_news_category", args: { category: m?.[2] } };
    }
    if (
      /\b(the )?news\b|\bheadlines\b|what'?s (happening|going on|in the news)|read me the news|catch me up/.test(
        t,
      )
    ) {
      const c = cat ? (cat[1] || cat[2] || "").replace(/^tech$/, "technology") : null;
      return { tier: 0, tool: "get_news", args: c ? { category: c } : {} };
    }
  }

  // --- music transport (check before "play …") ---
  if (/^(pause|stop)( the| this)?( music| song| playback| track)?[.!]?$/.test(t))
    return { tier: 0, tool: "pause_music" };
  if (/^(resume|unpause|continue|keep playing)( the| it)?( music| song| playback)?[.!]?$/.test(t))
    return { tier: 0, tool: "resume_music" };
  if (/^(next|skip)( song| track| this)?[.!]?$|skip (this|the) (song|track)|next one/.test(t))
    return { tier: 0, tool: "next_track" };
  if (/^(previous|prev|back|go back|last)( song| track| one)?[.!]?$|previous (song|track)|go back a (song|track)|restart (the |this )?(song|track)/.test(t))
    return { tier: 0, tool: "previous_track" };
  if (/what('?s| is) (playing|this( song)?)|what song is this|who('?s| is) (this|singing)|name of this song|who (sings|sang|is singing|performs) (this|that|it)\b|who('?s| is) this by|what artist is this/.test(t))
    return { tier: 0, tool: "whats_playing" };

  // trending / charts (check before generic "play X")
  {
    const tr = t.match(
      /\bplay\b (?:me |us )?(?:the |some )?(?:(?:top|trending|popular|hot|hits?|charts?|best)\b|what'?s (?:trending|popular|hot|charting))(.*)$/,
    );
    if (tr) {
      const genre = (tr[1] || "")
        .replace(
          /\b(tracks?|songs?|music|hits?|right now|today|now|on audius|please|for me|of|in|on|the|charts?)\b/g,
          "",
        )
        .replace(/[.!?]/g, "")
        .trim();
      return { tier: 0, tool: "play_trending", args: genre ? { genre } : {} };
    }
  }

  // saved morning playlist
  if (/play (my )?(morning )?(playlist|mix|music)$|my morning playlist|put on (some )?music|start (the )?music/.test(t))
    return { tier: 0, tool: "play_playlist", args: {} };

  // "play X" / "put on X" — X can be a playlist name, genre, mood, artist.
  // "put on" only at the start: "I need to put on sunscreen" is a note.
  {
    const m = t.match(
      /(?:(?:^|\b)play|^(?:please )?put on) (?:me |us )?(?:some )?(.+?)(?:\s+(?:music|playlist|please|for me))?[.!]?$/,
    );
    if (m && m[1]) {
      const raw = m[1].replace(/^(my|the|a)\s+/, "").replace(/^something\s+(?=\S)/, "").trim();
      const generic = /^(music|playlist|something|tunes|songs?|anything)$/.test(raw);
      return {
        tier: 0,
        tool: "play_playlist",
        args: generic ? {} : { name: raw },
      };
    }
  }

  if (/what('?s| is) the time|what time is it|the current time|tell me the time/.test(t))
    return { tier: 0, tool: "get_time" };

  if (/what('?s| is) the date|what day is it|today'?s date|the date today/.test(t))
    return { tier: 0, tool: "get_date" };

  if (/weather|forecast|temperature|is it (going to |gonna )?(rain|snow)|how (hot|cold|warm)|need an umbrella/.test(t))
    return { tier: 0, tool: "get_weather", args: { when: range } };

  if (
    /schedule|calendar|agenda|appointments|events|meetings|what('?s| is) on|what am i doing|my day|am i (free|busy)|anything (on|planned)/.test(
      t,
    ) ||
    // "what does tomorrow / the week look like", "how's my week"
    (range !== "today" && /look(s|ing)? like|how('?s| is)|going on|planned|happening/.test(t))
  )
    return { tier: 0, tool: "get_schedule", args: { range } };

  // last: a first-person fact nothing above claimed becomes a note
  const note = implicitNote(text);
  if (note) return { tier: 0, tool: "add_note", args: { text: note.text, implicit: true } };

  return null;
}

/**
 * Which tool schemas the local model sees (measured with `eval:router`).
 * Llama 3.2's chat template puts the tool block AFTER the conversation, so:
 *  - a fresh request gets every tool — the prompt prefix is identical each
 *    time and Ollama's prompt cache makes it ~0.9s
 *  - a follow-up (history present) shifts that ~1,300-token block out of the
 *    cache, which cost up to 12s to reprocess; send only the few closest tools
 *    instead (worst case 2.2s)
 */
async function toolsForLocal(text, history) {
  if (!history.length) return TOOLS;
  return (await selectTools(text, TOOLS, { history })).tools;
}

/**
 * Keep the local router fast after idle: load the model, process the full
 * tool block into Ollama's prompt cache, and embed the tool descriptions. A
 * cold first request otherwise costs ~11s on CPU and would hit the timeout.
 */
export async function warmLocalRouter() {
  if (!(await llm.localAvailable())) return false;
  const { assistant } = await getSettings();
  try {
    await Promise.all([
      llm.localToolCall({ model: assistant.models.local, text: "what time is it", tools: TOOLS, timeoutMs: 60_000 }),
      selectTools("warm up", TOOLS, { history: [{ role: "user", content: "hi" }] }),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function route(rawText, { history = [] } = {}) {
  const text = normalizeTranscript(rawText);

  // tier 0 — patterns. Deterministic and self-contained: no history needed.
  const hit = tier0(text);
  if (hit) return hit;

  const { assistant } = await getSettings();

  // tier 1 — local model. Prior turns go in so "and tomorrow?" resolves.
  if (await llm.localAvailable()) {
    try {
      const r = await llm.localToolCall({
        model: assistant.models.local,
        text,
        tools: await toolsForLocal(text, history),
        history,
      });
      if (r.confident && r.tool) return { tier: 1, tool: r.tool, args: r.args };
      if (r.confident && r.text && !llm.cloudConfigured())
        return { tier: 1, text: r.text };
    } catch (err) {
      console.error("router tier1:", err.message);
      if (err.name === "TypeError") llm.markLocalDown(); // connection refused, not slow
    }
  }

  // tier 2 — cloud model
  if (llm.cloudConfigured()) {
    try {
      const r = await llm.cloudToolCall({
        model: assistant.models.cloud,
        text,
        tools: TOOLS,
        history,
        context: null, // reserved for extra grounding text; unused for now
      });
      if (r.tool) return { tier: 2, tool: r.tool, args: r.args };
      return { tier: 2, text: r.text };
    } catch (err) {
      console.error("router tier2:", err.message);
    }
  }

  return {
    tier: -1,
    text: "I can't help with that yet. Try asking about the time, weather, or your schedule.",
  };
}
