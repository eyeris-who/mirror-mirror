import { updateAssistant } from "../settings.js";

// A tiny spoken questionnaire. Each step asks one question; the answer is
// parsed loosely (people don't speak in clean values) and collected. When the
// last step is done we save everything at once.
const STEPS = [
  {
    key: "userName",
    ask: "What should I call you?",
    parse: (s) =>
      s
        .trim()
        .replace(/^(i'?m|it'?s|my name is|call me|you can call me)\s+/i, "")
        .replace(/[.?!]+$/, "")
        .trim(),
  },
  {
    key: "wakePhrase",
    ask: "What wake phrase should I listen for? Say the whole phrase.",
    parse: (s) => s.trim().toLowerCase().replace(/[.?!]+$/, ""),
  },
  {
    key: "morningPlaylist",
    ask: "What is your morning playlist called on Spotify?",
    parse: (s) =>
      s
        .trim()
        .replace(/^(it'?s|the|my|called)\s+/i, "")
        .replace(/[.?!]+$/, "")
        .trim(),
  },
  {
    key: "units",
    ask: "Should I give temperatures in Celsius or Fahrenheit?",
    parse: (s) =>
      /celsius|celcius|centigrade|\bc\b/i.test(s) && !/fahren/i.test(s)
        ? "celsius"
        : "fahrenheit",
  },
];

/**
 * state === null  -> begin: returns the first question.
 * state present   -> record `answer` for the current step, return the next
 *                    question, or finish and persist.
 *
 * Return shape: { speak, expectReply, setup }  (setup is the next state, or null)
 */
export async function runSetupStep(state, answer) {
  if (!state) {
    return {
      speak: `Okay, let's set up. ${STEPS[0].ask}`,
      expectReply: true,
      setup: { i: 0, collected: {} },
    };
  }

  const step = STEPS[state.i];
  const collected = { ...state.collected, [step.key]: step.parse(answer) };
  const next = state.i + 1;

  if (next < STEPS.length) {
    return {
      speak: STEPS[next].ask,
      expectReply: true,
      setup: { i: next, collected },
    };
  }

  await updateAssistant(collected);
  return {
    speak:
      `Got it. I'll call you ${collected.userName || "you"}, ` +
      `listen for "${collected.wakePhrase}", ` +
      `play "${collected.morningPlaylist}" in the mornings, ` +
      `and use ${collected.units}. ` +
      `Connect Google Calendar and Spotify on the mirror's setup page if you haven't. ` +
      `If you changed the wake phrase, restart the voice service.`,
    expectReply: false,
    setup: null,
  };
}
