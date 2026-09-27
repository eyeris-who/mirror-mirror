// Prompt assembly for memory answers (no model needed). The answer quality
// itself is measured by `npm run eval:memory` against a real model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptV2, relevantHits } from "../memory/recall.js";

const DAY = 864e5;
const NOW = new Date(2026, 8, 14, 9).getTime();
const hit = (id, daysAgo, text, extra = {}) => ({
  id,
  ts: NOW - daysAgo * DAY,
  text,
  source: "conversation",
  kind: "utterance",
  meta: {},
  cosine: 0.6,
  score: 0.5,
  ...extra,
});

test("excerpts are oldest first, dated relative to today", () => {
  const p = promptV2("q?", [hit(2, 1, "newer"), hit(1, 14, "older")], NOW);
  assert.match(p, /^Today is Monday, September 14, 2026\./);
  assert.ok(p.indexOf("older") < p.indexOf("newer"));
  assert.match(p, /2 weeks ago, said\] older/);
  assert.match(p, /yesterday, said\] newer/);
});

test("only the newest message in an update chain is marked LATEST", () => {
  const list = hit(1, 14, "I need milk, eggs and filters");
  const partial = hit(2, 8, "got milk, still need eggs", { followUpOf: 1 });
  const done = hit(3, 1, "fridge is fully stocked", { followUpOf: 1 });
  const unrelated = hit(4, 2, "I parked on level 3");
  const p = promptV2("what did I need from the store?", [list, unrelated, done, partial], NOW);
  assert.match(p, /\(LATEST\) fridge is fully stocked/);
  assert.doesNotMatch(p, /\(LATEST\) got milk/);
  assert.doesNotMatch(p, /\(LATEST\) I need milk/);
  assert.doesNotMatch(p, /\(LATEST\) I parked/, "not part of a chain");
});

test("source labels tell the model what kind of memory it is", () => {
  const p = promptV2(
    "q?",
    [
      hit(1, 3, "renew passport", { meta: { tool: "set_reminder" } }),
      hit(2, 3, "gate code 4471", { source: "note", kind: "note" }),
      hit(3, 3, "good day", { source: "journal", kind: "journal" }),
    ],
    NOW,
  );
  assert.match(p, /asked for a reminder\] renew passport/);
  assert.match(p, /note\] gate code/);
  assert.match(p, /journal\] good day/);
});

test("relevance filter uses cosine, not the recency-weighted score", () => {
  const hits = [
    hit(1, 1, "car rattles", { cosine: 0.567, score: 0.535 }),
    hit(2, 1, "parked on level 3", { cosine: 0.462, score: 0.449 }),
    hit(3, 24, "renew passport", { cosine: 0.56, score: 0.38 }), // old but relevant
  ];
  const kept = relevantHits(hits, 0.1).map((h) => h.text);
  assert.deepEqual(kept, ["car rattles", "renew passport"]);
});
