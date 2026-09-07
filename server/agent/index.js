import { runTool, continueNewsFlow } from "./tools.js";
import { route } from "./router.js";
import { runSetupStep } from "./setupFlow.js";
import { logMetric } from "./metrics.js";

/**
 * Turn a transcript into a spoken reply.
 *
 * `session` is per-caller state the server keeps between turns: an in-progress
 * setup flow, or a pending news-headline choice. Returns:
 *   { speak, segments?, action?, expectReply, replyTimeoutMs?, setup, newsFlow, tier }
 */
export async function handleCommand(text, session = {}) {
  const t0 = Date.now();

  // Mid-setup: the last reply asked a question, so treat this as the answer.
  if (session.setup) {
    const r = await runSetupStep(session.setup, text);
    logMetric({ kind: "setup", text, totalMs: Date.now() - t0 });
    return { ...pack(r), tier: 0 };
  }

  // Mid-news: the headline prompt is waiting for a number / keyword / "skip".
  if (session.newsFlow) {
    const r = await continueNewsFlow(session.newsFlow, text);
    logMetric({ kind: "news_choice", text, totalMs: Date.now() - t0 });
    return { ...pack(r), tier: 0 };
  }

  const routed = await route(text);
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
    text,
    tier: routed.tier ?? -1,
    tool: routed.tool ?? null,
    routeMs: tRoute - t0,
    toolMs: tDone - tRoute,
    totalMs: tDone - t0,
  });

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
  };
}
