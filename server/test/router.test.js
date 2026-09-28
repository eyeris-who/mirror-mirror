// Tier-0 routing. Most cases are real transcripts from data/metrics.jsonl that
// used to fall through to the model or dead-end — keep adding to this list
// whenever a phrase misroutes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tier0, normalizeTranscript, implicitNote } from "../agent/router.js";

const route0 = (text) => tier0(normalizeTranscript(text));

const CASES = [
  // core commands
  ["what's the time", "get_time"],
  ["whats the time", "get_time"],
  ["What's the date?", "get_date"],
  ["what's the weather", "get_weather"],
  ["what is the weather this weekend", "get_weather"],
  ["what's on my schedule tomorrow", "get_schedule"],
  ["what does the week look like", "get_schedule"],
  ["read me the news", "get_news"],
  ["play some jazz", "play_playlist"],
  ["play trending lofi", "play_trending"],
  ["pause", "pause_music"],
  ["stop", "pause_music"],
  ["Pause?", "pause_music"],
  ["what's playing", "whats_playing"],
  ["go to sleep", "sleep_display"],
  ["start my morning routine", "run_morning_routine"],

  // apostrophe mangled into a space upstream (the old wake.py bug)
  ["what s the time", "get_time"],
  ["what s the date", "get_date"],
  ["what s playing", "whats_playing"],
  ["who s singing", "whats_playing"],

  // tier-1 misses from eval:router, now caught by rules
  ["who sings this", "whats_playing"],
  ["who sang this?", "whats_playing"],
  ["what artist is this", "whats_playing"],
  ["put on something relaxing", "play_playlist"],
  ["put on some jazz", "play_playlist"],

  // speech-to-text damage seen in real logs
  ["Place on low-fi.", "play_playlist"],
  ["A trending low-fi.", "play_trending"],
  ["me in one minute to brush teeth.", "set_reminder"],
  ["in one minute to brush teeth.", "set_reminder"],
  ["reminder in two minutes to finish my homework.", "set_reminder"],

  // reminders
  ["remind me to call mom at 5pm", "set_reminder"],
  ["what are my reminders", "list_reminders"],
  ["forget my reminders", "clear_reminders"],
  ["delete all reminders", "clear_reminders"],

  // memory
  ["note that the back gate code is 4471", "add_note"],
  ["journal: felt great after the gym", "add_note"],
  ["whats the back gate code", "recall"],
  ["what did i say the back gate code was", "recall"],
  ["whats my wifi password", "recall"],
  ["forget what I said about the gate code", "forget"],
  ["delete my note about parking", "forget"],
  ["forget that", "forget"],
];

for (const [text, tool] of CASES) {
  test(`routes ${JSON.stringify(text)} -> ${tool}`, () => {
    assert.equal(route0(text)?.tool, tool);
  });
}

test("forget extracts the topic", () => {
  assert.equal(route0("forget what I said about the gate code").args.query, "the gate code");
  assert.equal(route0("delete my note about parking").args.query, "parking");
  assert.equal(route0("forget my last note").args.query, "");
});

test("unhandled phrasing falls through to the models", () => {
  for (const t of ["what about tomorrow", "and this weekend", "hey mirror", "two"]) {
    assert.equal(route0(t), null, t);
  }
});

test("normalizeTranscript", () => {
  assert.equal(normalizeTranscript("What’s the time?"), "What's the time");
  assert.equal(normalizeTranscript("play some Lo-Fi"), "play some lofi");
  assert.equal(normalizeTranscript("  play   jazz  "), "play jazz");
});

test("implicitNote keeps first-person facts only", () => {
  assert.ok(implicitNote("I need to buy printer ink and stamps"));
  assert.ok(implicitNote("I parked on level 3 near the elevator"));
  assert.ok(implicitNote("I left my keys in the blue jacket"));
  assert.ok(implicitNote("my locker code is 1234"));
  for (const t of [
    "what should I cook",
    "I need to buy ink?",
    "how many unread emails do I have",
    "hello there",
    "I'm",
    "I want to hear some jazz", // a request, not a fact — leave it to the models
    "I need a song to relax",
  ]) {
    assert.equal(implicitNote(t), null, t);
  }
});

test("statements route to an implicit note at tier 0, commands still win", () => {
  const r = route0("I need to buy printer ink and stamps");
  assert.equal(r.tool, "add_note");
  assert.equal(r.args.implicit, true);
  // also a first-person fact, but it's a reminder request — that pattern wins
  assert.equal(route0("I need to buy milk, remind me at 5pm")?.tool, "set_reminder");
});

test('"put on X" searches the mood, but only at the start of the sentence', () => {
  assert.deepEqual(route0("put on something relaxing").args, { name: "relaxing" });
  assert.deepEqual(route0("play something upbeat").args, { name: "upbeat" });
  assert.deepEqual(route0("play something").args, {});
  assert.notEqual(route0("I need to put on sunscreen before the beach")?.tool, "play_playlist");
});
