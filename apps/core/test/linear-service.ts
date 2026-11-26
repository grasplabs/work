/**
 * Linear's MCP server, as the connect Worker reaches it in core's tests:
 * connect's own faithful fake (connect's test/linear-mcp-fake.ts), run in
 * Node behind the `LINEAR` service of the outside systems' Worker
 * (test/connect-providers.ts), which sends it every request to Linear's
 * origin. Its state lives in this process for the whole run, so a test
 * file adds its own connector to it and never resets it under another.
 * Tests stand in for the person approving the sign-in through
 * `linearConsentUrl`. Imported by vite.config.ts (Node) and the tests
 * (workerd), which read only its URL.
 */
import { z } from "zod";

import { linearMcpFake } from "../../connect/test/linear-mcp-fake.ts";

/**
 * Where tests approve a sign-in at Linear: POST `{ url }`, the
 * authorization URL connect built, answered with what Linear's redirect
 * back carries (`Consent`).
 */
export const linearConsentUrl = "https://linear-control.test/consent";

const consentRequestSchema = z.object({ url: z.string() });

let fake: ReturnType<typeof linearMcpFake> | undefined;

/** The `LINEAR` service's answer to `request`, in Node. */
export const linearService = async (request: Request): Promise<Response> => {
  fake ??= linearMcpFake();
  if (request.url === linearConsentUrl) {
    const { url } = consentRequestSchema.parse(await request.json());
    return Response.json(fake.consent(url));
  }
  return await fake.handle(request);
};
