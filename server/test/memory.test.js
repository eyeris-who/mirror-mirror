// Memory store: ingest filtering, forget (index + vector + log + tombstone),
// cursor correctness after scrubbing, and retention. Runs against a throwaway
// directory with the hashing embedder, so it needs no Ollama.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mirror-mem-test-"));
const notesDir = mkdtempSync(join(tmpdir(), "mirror-notes-test-"));
process.env.MEMORY_DIR = dir;
process.env.NOTES_DIR = notesDir;
process.env.EMBED_FAKE = "1";

const DAY = 864e5;
const ago = (days, extraMs = 0) => new Date(Date.now() - days * DAY + extraMs).toISOString();
const CONV = join(dir, "conversations.jsonl");
const NOTES = join(dir, "notes.jsonl");
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const S = "voice";

writeFileSync(
  CONV,
  jsonl([
    { ts: ago(40), role: "user", text: "I started learning the cello", sessionId: S },
    { ts: ago(40, 1000), role: "assistant", text: "Nice.", tier: 1, sessionId: S },
    { ts: ago(3), role: "user", text: "I left my spare key under the blue flowerpot", sessionId: S },
    { ts: ago(3, 1000), role: "assistant", text: "Got it.", tier: 1, sessionId: S },
    { ts: ago(3, 2000), role: "user", text: "what's the weather", sessionId: S },
    { ts: ago(3, 3000), role: "assistant", text: "Sunny.", tier: 0, tool: "get_weather", sessionId: S },
    { ts: ago(2), role: "user", text: "my bike lock combination is 9912", sessionId: S },
    { ts: ago(2, 1000), role: "assistant", text: "Okay.", tier: 1, sessionId: S },
    // an old-style recall answer that read the secret back into the log
    { ts: ago(2, 1500), role: "user", text: "what's my bike lock code", sessionId: S },
    { ts: ago(2, 1600), role: "assistant", text: "Your bike lock code is 9912.", tier: 0, tool: "recall", sessionId: S },
    // never answered: must NOT borrow the tier-0 reply two rows down
    { ts: ago(2, 2000), role: "user", text: "the dentist moved my appointment to friday", sessionId: S },
    { ts: ago(2, 3000), role: "user", text: "play some jazz", sessionId: S },
    { ts: ago(2, 4000), role: "assistant", text: "Playing jazz.", tier: 0, tool: "play_playlist", sessionId: S },
  ]),
);
// the spoken command that created the wifi note, logged just before it
const noteTs = ago(5);
appendFileSync(
  CONV,
  jsonl([
    { ts: new Date(Date.parse(noteTs) - 400).toISOString(), role: "user", text: "note that the wifi password is sunflower42", sessionId: "default" },
    { ts: new Date(Date.parse(noteTs) + 100).toISOString(), role: "assistant", text: "Noted.", tier: 0, tool: "add_note", sessionId: "default" },
  ]),
);
writeFileSync(
  NOTES,
  jsonl([
    { ts: noteTs, kind: "note", text: "the wifi password is sunflower42" },
    { ts: ago(1), kind: "journal", text: "felt really good after the gym today" },
  ]),
);
writeFileSync(join(notesDir, "house.md"), "The water shutoff valve is behind the dryer.");

const memory = await import("../memory/index.js");
const db = await import("../memory/db.js");
const { pairedReply } = await import("../memory/ingest.js");
const tools = await import("../agent/tools.js");

const texts = () => db.recentChunks({ limit: 500 }).map((c) => c.text);
const find = (needle) => db.recentChunks({ limit: 500 }).find((c) => c.text.includes(needle));
const vecCount = () => db.getDb().prepare("SELECT COUNT(*) n FROM vec_chunks").get().n;
const chunkCount = () => db.getDb().prepare("SELECT COUNT(*) n FROM chunks").get().n;

after(() => {
  db.closeDb();
  for (const d of [dir, notesDir]) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

test("pairedReply only pairs a turn with its own answer", () => {
  const rows = readFileSync(CONV, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(pairedReply(rows, 2).text, "Got it.");
  const dentist = rows.findIndex((r) => r.text.includes("dentist"));
  assert.equal(pairedReply(rows, dentist), null, "unanswered turn borrowed a later reply");
});

test("ingest keeps what you told it, skips commands", async () => {
  await memory.ingest();
  const t = texts();
  for (const want of ["cello", "spare key", "bike lock", "dentist", "wifi password", "gym", "shutoff valve"]) {
    assert.ok(t.some((x) => x.includes(want)), `missing ${want}`);
  }
  for (const skip of ["what's the weather", "play some jazz"]) {
    assert.ok(!t.includes(skip), `indexed command: ${skip}`);
  }
  assert.equal(vecCount(), chunkCount(), "every chunk has exactly one vector");
});

test("forget a conversation turn removes it everywhere", async () => {
  const c = find("bike lock");
  const cursorBefore = Number(db.getCursor("conversation"));
  const vecsBefore = vecCount();

  const r = await memory.forget(c.id);
  assert.equal(r.removed, 1);
  assert.equal(r.scrubbedLines, 2, "user line + its reply");

  assert.equal(find("bike lock"), undefined);
  assert.equal(vecCount(), vecsBefore - 1, "vector row deleted too");
  assert.ok(!readFileSync(CONV, "utf8").includes("9912"), "secret still in conversations.jsonl");
  assert.equal(Number(db.getCursor("conversation")), cursorBefore - 2, "cursor moved back past removed lines");

  const { hits } = await memory.search("my bike lock combination is 9912", { k: 6 });
  assert.ok(!hits.some((h) => h.text.includes("9912")));
});

test("after a scrub, new turns are still ingested and forgotten ones stay gone", async () => {
  appendFileSync(
    CONV,
    jsonl([
      { ts: ago(0, -10 * 60_000), role: "user", text: "I lent my ladder to the neighbours", sessionId: S },
      { ts: ago(0, -10 * 60_000 + 1000), role: "assistant", text: "Okay.", tier: 1, sessionId: S },
    ]),
  );
  await memory.ingest();
  assert.ok(find("ladder"), "line after the scrubbed ones was skipped");
  assert.equal(find("bike lock"), undefined, "forgotten turn came back");
});

test("forget a spoken note scrubs notes.jsonl and keeps the notes cursor right", async () => {
  const convCursor = Number(db.getCursor("conversation"));
  const r = await memory.forget(find("wifi password").id);
  assert.equal(r.scrubbedLines, 3, "note line + dictating command + its reply");
  assert.ok(!readFileSync(NOTES, "utf8").includes("sunflower42"));
  assert.ok(!readFileSync(CONV, "utf8").includes("sunflower42"), "dictating command left in the log");
  assert.equal(Number(db.getCursor("conversation")), convCursor - 2);

  appendFileSync(NOTES, jsonl([{ ts: ago(0, -5000), kind: "note", text: "the recycling goes out on tuesdays" }]));
  await memory.ingest();
  assert.ok(find("recycling"), "note added after a scrub was skipped");
  assert.equal(find("wifi password"), undefined);
});

test("a forgotten line from notes/ stays forgotten when the file is saved again", async () => {
  const r = await memory.forget(find("shutoff valve").id);
  assert.equal(r.file, "house.md");
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(notesDir, "house.md"), later, later); // new mtime -> re-scan
  await memory.ingest();
  assert.equal(find("shutoff valve"), undefined);
});

test("findForgettable: empty query means the latest spoken note", async () => {
  const hit = await memory.findForgettable("");
  assert.ok(hit.text.includes("recycling"));
  const exact = await memory.findForgettable("I left my spare key under the blue flowerpot");
  assert.ok(exact.text.includes("spare key"));
});

test("retention drops old conversation memories, keeps notes", async () => {
  const r = await memory.pruneConversations(30);
  assert.equal(r.removed, 1);
  assert.equal(r.scrubbedLines, 2);
  assert.equal(find("cello"), undefined);
  assert.ok(find("spare key") && find("gym"), "recent memories and journal kept");
  assert.equal(vecCount(), chunkCount());

  // and ingestion still lines up afterwards
  appendFileSync(
    CONV,
    jsonl([
      { ts: ago(0, -5 * 60_000), role: "user", text: "I moved the spare tire to the garage", sessionId: S },
      { ts: ago(0, -5 * 60_000 + 1000), role: "assistant", text: "Okay.", tier: 1, sessionId: S },
    ]),
  );
  await memory.ingest();
  assert.ok(find("spare tire"));
});

test("spoken forget flow: no / silence keep it, yes deletes, anything else is a new command", async () => {
  const id = find("spare key").id;
  assert.equal((await tools.continueForgetFlow({ id }, "no")).speak, "Okay, I'll keep it.");
  assert.equal((await tools.continueForgetFlow({ id }, "__timeout__")).speak, "Okay, I'll keep it.");
  assert.equal(await tools.continueForgetFlow({ id }, "play some jazz"), null);
  assert.ok(find("spare key"));
  assert.equal((await tools.continueForgetFlow({ id }, "Yes.")).speak, "Forgotten.");
  assert.equal(find("spare key"), undefined);
});

test("toSecondPerson reads a note back naturally", () => {
  assert.equal(tools.toSecondPerson("I need to buy printer ink and stamps"), "you need to buy printer ink and stamps");
  assert.equal(tools.toSecondPerson("my locker code is 12."), "your locker code is 12");
  assert.equal(tools.toSecondPerson("I'm out of coffee"), "you're out of coffee");
});
