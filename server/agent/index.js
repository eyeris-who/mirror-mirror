import { runTool } from "./tools.js";
import { route } from "./router.js";
import { runSetupStep } from "./setupFlow.js";
import { logMetric } from "./metrics.js";

/**
 * Turn a transcript into a spoken reply.
 *
 * `session` is per-caller state the server keeps between turns — currently just
 * an in-progress setup flow. Returns:
 *   { speak, segments?, expectReply, setup, tier }
 */
export async function handleCommand(text, session = {}) {
  const t0 = Date.now();

  // Mid-setup: the last reply asked a question, so treat this as the answer.
  if (session.setup) {
    const r = await runSetupStep(session.setup, text);
    logMetric({ kind: "setup", text, totalMs: Date.now() - t0 });
    return { ...r, tier: 0 };
  }

  const routed = await route(text);
  const tRoute = Date.now();

  let result;
  if (routed.tool) {
    result = await runTool(routed.tool, routed.args);
    if (result.startSetup) {
      result = await runSetupStep(null, null); // kick off the questionnaire
    }
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

  return {
    speak: result.speak,
    segments: result.segments ?? null,
    expectReply: Boolean(result.expectReply),
    setup: result.setup ?? null,
    tier: routed.tier ?? -1,
  };
}
