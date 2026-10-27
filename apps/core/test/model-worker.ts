/**
 * The e2e stack's scripted model, as a Worker of its own: core's AI
 * binding in the stack's config alone (e2e/core-config.ts), for the
 * end-to-end tests only, and never deployed. It answers as AI Gateway's
 * provider routes do, with the replies of model-scripts.ts, so a
 * Playwright journey can follow a chat turn through core end to end.
 * Nothing in core names it: a deployment's AI binding is AI Gateway.
 */
import { scriptedReply } from "./model-scripts.ts";
import { gatewayAnswering } from "./provider-replies.ts";

export default {
  fetch: async (request: Request): Promise<Response> =>
    // A gateway of its own for each request, which keeps nothing after it.
    await gatewayAnswering(([asked]) =>
      scriptedReply(asked?.body)
    ).binding.fetch(request),
};
