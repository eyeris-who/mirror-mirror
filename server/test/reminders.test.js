import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../reminders.js";

const MIN = 60_000;

function near(iso, ms, slack = 5_000) {
  return Math.abs(Date.parse(iso) - (Date.now() + ms)) < slack;
}

test("text is what to do, without the trigger words", () => {
  const cases = {
    "remind me to call mom at 5pm": "call mom",
    "remind me in one minute to brush teeth": "brush teeth",
    "set a reminder for 8pm to take out the trash": "take out the trash",
    "remind me to stretch in 20 minutes.": "stretch",
    "Remind me at 5 p.m. to call mom": "call mom",
  };
  for (const [phrase, text] of Object.entries(cases)) {
    assert.equal(parse(phrase)?.text, text, phrase);
  }
});

test("clipped starts from speech-to-text still parse", () => {
  const cases = {
    "me in one minute to brush teeth": ["brush teeth", 1 * MIN],
    "in one minute to brush teeth": ["brush teeth", 1 * MIN],
    "reminder in two minutes to finish my homework": ["finish my homework", 2 * MIN],
  };
  for (const [phrase, [text, ms]] of Object.entries(cases)) {
    const r = parse(phrase);
    assert.equal(r?.text, text, phrase);
    assert.ok(near(r.at, ms), `${phrase}: ${r.at}`);
  }
});

test("times are always in the future", () => {
  const r = parse("remind me to drink water at 8");
  assert.ok(Date.parse(r.at) > Date.now() - MIN);
});

test("no time -> null (the tool asks when)", () => {
  assert.equal(parse("remind me to message my mentor"), null);
});
