import { getSettings } from "../settings.js";
import { TOOLS } from "./tools.js";
import * as llm from "./llm.js";

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

function detectRange(t) {
  if (/\btomorrow\b/.test(t)) return "tomorrow";
  if (/\b(this|next|the)\s+week\b|week ahead|next seven days|rest of the week/.test(t))
    return "week";
  return "today";
}

function tier0(text) {
  const t = text.toLowerCase().trim();
  const range = detectRange(t);

  if (/morning routine|start (my )?(morning|day)|^good morning\b/.test(t))
    return { tier: 0, tool: "run_morning_routine" };

  if (/\bset ?up\b|configure( the)? (mirror|assistant)|change (my )?settings/.test(t))
    return { tier: 0, tool: "open_setup" };

  if (/play (my |the )?.*(playlist|music)|morning playlist|put on (some )?music/.test(t))
    return { tier: 0, tool: "play_playlist", args: {} };

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

  return null;
}

export async function route(text) {
  // tier 0 — patterns
  const hit = tier0(text);
  if (hit) return hit;

  const { assistant } = await getSettings();

  // tier 1 — local model
  if (await llm.localAvailable()) {
    try {
      const r = await llm.localToolCall({
        model: assistant.models.local,
        text,
        tools: TOOLS,
      });
      if (r.confident && r.tool) return { tier: 1, tool: r.tool, args: r.args };
      if (r.confident && r.text && !llm.cloudConfigured())
        return { tier: 1, text: r.text };
    } catch (err) {
      console.error("router tier1:", err.message);
    }
  }

  // tier 2 — cloud model
  if (llm.cloudConfigured()) {
    try {
      const r = await llm.cloudToolCall({
        model: assistant.models.cloud,
        text,
        tools: TOOLS,
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
