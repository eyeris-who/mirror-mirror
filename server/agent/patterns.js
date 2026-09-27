// Shared intent patterns. Kept in their own module so the memory ingester can
// reuse them without importing the whole router (which would be a cycle:
// router -> tools -> memory -> ingest -> router).

/** Questions that mean "look something up in my memory". */
export const RECALL_RE =
  /\bwhat did i\b|\bhave i (ever |already )?(said|mentioned|told you|written|noted)\b|\bdid i (say|mention|tell you|write|note)\b|\bwhen did i\b|\bdo you remember\b|\bremind me what i\b|\bwhat was i\b|\bhave i been\b|\baccording to (my )?(notes|journal)\b|\bfrom (my )?(memory|notes|journal)\b|\blast time i\b|\bwh(at|ere)(’s| is| was|s)? (the|my|our) .{0,40}\b(code|combination|password|passcode|pin|wifi|network|login|username|account number|confirmation number|address|birthday|anniversary|recommendation)\b/;
