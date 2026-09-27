import { runTool, continueNewsFlow, continueForgetFlow } from "./tools.js";
import { route } from "./router.js";
import { runSetupStep } from "./setupFlow.js";
import { logMetric, textFields } from "./metrics.js";
import { logTurn, PRIVATE_PLACEHOLDER } from "../memory/index.js";

/**
 * Turn a transcript into a spoken reply.
 *
 * `session` is per-caller state the server keeps between turns: a rolling
 * `history` transcript (for follow-ups like "and tomorrow?"), an in-progress
 * setup flow, a pending news-headline choice, or a forget waiting for "yes".
 * Returns:
 *   { speak, segments?, action?, expectReply, replyTimeoutMs?, setup, newsFlow, forgetFlow, tier }
 */
const MAX_HISTORY = 8; // 4 exchanges — enough to resolve references, cheap to send

// Replies that read memory back out loud ("your gate code is 4471", or the
// "Forget this: …?" confirmation). Their text is kept out of conversations.jsonl
// — otherwise forgetting a memory would leave a copy in the log — and out of the
// rolling history, which a later turn may send to the cloud tier.
const PRIVATE_TOOLS = new Set(["recall", "forget", "forget_confirm"]);

export async function handleCommand(text, session = {}, meta = {}) {
  const t0 = Date.now();

  const remember = (r, tier, tool) =>
    logTurn({
      role: "assistant",
      text: PRIVATE_TOOLS.has(tool) && r?.speak ? PRIVATE_PLACEHOLDER : r?.speak,
      tier,
      tool,
      sessionId: meta.sessionId,
    }).catch(() => {});

  // The user cut off a question ("Say a number…", "Say yes to delete it") —
  // drop whatever flow was waiting, silently.
  if (text === "__cancel__") {
    session.setup = null;
    session.newsFlow = null;
    session.forgetFlow = null;
    logMetric({ kind: "flow_cancel", totalMs: Date.now() - t0 });
    return { ...pack({ speak: "" }), tier: 0 };
  }

  // Mid-setup: the last reply asked a question, so treat this as the answer.
  if (session.setup) {
    const r = await runSetupStep(session.setup, text);
    logMetric({ kind: "setup", totalMs: Date.now() - t0 });
    remember(r, 0, "setup");
    return { ...pack(r), tier: 0 };
  }

  // Mid-news: the headline prompt is waiting for a number / keyword / "skip".
  if (session.newsFlow) {
    const r = await continueNewsFlow(session.newsFlow, text);
    logMetric({ kind: "news_choice", totalMs: Date.now() - t0 });
    remember(r, 0, "news_choice");
    return { ...pack(r), tier: 0 };
  }

  // Pending "Forget this …? Say yes." A yes/no (or silence) settles it; anything
  // else cancels the delete and is handled as a new command below.
  if (session.forgetFlow) {
    const flow = session.forgetFlow;
    session.forgetFlow = null;
    const r = await continueForgetFlow(flow, text);
    if (r) {
      logMetric({ kind: "forget_confirm", totalMs: Date.now() - t0 });
      remember(r, 0, "forget_confirm");
      return { ...pack(r), tier: 0 };
    }
  }

  // A real command (not a setup/news follow-up) — remember what was said.
  logTurn({ role: "user", text, sessionId: meta.sessionId }).catch(() => {});

  const routed = await route(text, { history: session.history ?? [] });
  const tRoute = Date.now();

  let result;
  if (routed.tool) {
    result = await runTool(routed.tool, routed.args);
    if (result.startSetup) result = await runSetupStep(null, null);
  } else {
    result = { speak: routed.text || "I'm not sure how to help with that." };
  }
  const tDone = Date.now();

  logMetric({
    kind: "command",
    ...textFields(text),
    tier: routed.tier ?? -1,
    tool: routed.tool ?? null,
    routeMs: tRoute - t0,
    toolMs: tDone - tRoute,
    totalMs: tDone - t0,
  });

  remember(result, routed.tier ?? -1, routed.tool ?? null);

  // Roll the transcript forward for the next turn in this conversation.
  const privateReply = PRIVATE_TOOLS.has(routed.tool) && result.speak;
  session.history = [
    ...(session.history ?? []),
    { role: "user", content: text },
    { role: "assistant", content: privateReply ? PRIVATE_PLACEHOLDER : (result.speak ?? "") },
  ].slice(-MAX_HISTORY);

  return { ...pack(result), tier: routed.tier ?? -1 };
}

function pack(r) {
  return {
    speak: r.speak,
    segments: r.segments ?? null,
    action: r.action ?? null,
    expectReply: Boolean(r.expectReply),
    replyTimeoutMs: r.replyTimeoutMs ?? null,
    setup: r.setup ?? null,
    newsFlow: r.newsFlow ?? null,
    forgetFlow: r.forgetFlow ?? null,
  };
}
