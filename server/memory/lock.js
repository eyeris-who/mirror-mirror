/**
 * Tiny async mutex: `run(fn)` waits for every earlier caller to finish.
 *
 * The memory module needs two of these:
 *   - files: appends to conversations.jsonl / notes.jsonl must never interleave
 *     with a rewrite of the same file (forget / retention scrub a line out)
 *   - index: an ingest pass reads a log and then advances a line-number cursor;
 *     a scrub that removes lines has to adjust that cursor, so the two can't
 *     overlap
 */
export function createLock() {
  let tail = Promise.resolve();
  return function run(fn) {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
}
