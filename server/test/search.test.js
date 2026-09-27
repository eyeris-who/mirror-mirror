import { test } from "node:test";
import assert from "node:assert/strict";
import { timeWindow } from "../memory/search.js";

const DAY = 864e5;
// a fixed "now": Monday Sep 14 2026, 9am local
const NOW = new Date(2026, 8, 14, 9, 0, 0);
const at = (y, m, d, h = 12) => new Date(y, m, d, h).getTime();
const inside = (w, t) => t >= w.from && t <= w.to;

test("no time phrase -> no window", () => {
  assert.equal(timeWindow("what did I decide about exercise?", NOW), null);
  assert.equal(timeWindow("what's renewing soon?", NOW), null);
});

test("yesterday covers all of yesterday, including the morning", () => {
  const w = timeWindow("how did I feel yesterday?", NOW);
  assert.ok(inside(w, at(2026, 8, 13, 7)), "yesterday 7am excluded");
  assert.ok(inside(w, at(2026, 8, 13, 22)));
  assert.ok(!inside(w, at(2026, 8, 14, 8)), "today leaked in");
  assert.ok(!inside(w, at(2026, 8, 12, 22)));
});

test("N weeks ago is a week-sized window around that point", () => {
  const w = timeWindow("what did I need to buy two weeks ago?", NOW);
  assert.ok(inside(w, NOW.getTime() - 14 * DAY));
  assert.ok(inside(w, NOW.getTime() - 12 * DAY));
  assert.ok(!inside(w, NOW.getTime() - 2 * DAY), "recent days leaked in");
});

test("a named day is that whole day", () => {
  const w = timeWindow("what did I say on Friday?", NOW);
  const fri = new Date(w.from);
  assert.equal(fri.getDay(), 5);
  assert.equal(w.to - w.from, DAY);
});
