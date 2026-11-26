/**
 * Linear's MCP server, as the connect Worker reaches it in core's tests:
 * connect's own faithful fake (connect's test/linear-mcp-fake.ts), run in
 * Node behind the `LINEAR` service of the outside systems' Worker
 * (test/connect-providers.ts), which sends it every request to its
 * origins: Linear's own, which the built-in Linear serves, and the copy's
 * (`linearCopyOrigin`), which a test adds by its URL. Their state lives in
 * this process for the whole run, so a test file adds its own connector
 * and never resets it under another. Tests stand in for the person
 * approving the sign-in through `linearConsentUrl`. Imported by
 * vite.config.ts (Node) and the tests (workerd), which read only its URLs.
 */
import { z } from "zod";

import {
  linearCopyOrigin,
  linearMcpFake,
  linearOrigin,
} from "../../connect/test/linear-mcp-fake.ts";

/**
 * Where tests approve a sign-in at Linear: POST `{ url }`, the
 * authorization URL connect built, answered with what Linear's redirect
 * back carries (`Consent`).
 */
export const linearConsentUrl = "https://linear-control.test/consent";

/** The origins the `LINEAR` service answers. */
export const linearOrigins = [linearOrigin, linearCopyOrigin];

/**
 * Where tests make Linear's next tool call fail with a structured error:
 * POST `{ url, error }`, Linear's server at `url` then answering its next
 * `tools/call` with `error` as its structured content.
 */
export const linearToolErrorUrl = "https://linear-control.test/tool-error";

const consentRequestSchema = z.object({ url: z.string() });

const toolErrorRequestSchema = z.object({
  url: z.string(),
  error: z.union([z.string(), z.record(z.string(), z.unknown())]),
});

const toolCallSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.literal("tools/call"),
});

const fakes = new Map<string, ReturnType<typeof linearMcpFake>>();

/** The fake at `url`'s origin, made on first use. */
const fakeAt = (url: string): ReturnType<typeof linearMcpFake> => {
  const { origin } = new URL(url);
  const fake = fakes.get(origin) ?? linearMcpFake(origin);
  fakes.set(origin, fake);
  return fake;
};

/** The `LINEAR` service's answer to `request`, in Node. */
export const linearService = async (request: Request): Promise<Response> => {
  if (request.url === linearConsentUrl) {
    const { url } = consentRequestSchema.parse(await request.json());
    return Response.json(fakeAt(url).consent(url));
  }
  if (request.url === linearToolErrorUrl) {
    const { url, error } = toolErrorRequestSchema.parse(await request.json());
    const fake = fakeAt(url);
    const failing = async (sent: Request): Promise<Response | undefined> => {
      let body: unknown;
      try {
        body = JSON.parse(await sent.clone().text());
      } catch {
        body = undefined;
      }
      const call = toolCallSchema.safeParse(body);
      if (!call.success) {
        fake.next = failing;
        return undefined;
      }
      return Response.json({
        jsonrpc: "2.0",
        id: call.data.id,
        result:
          typeof error === "string"
            ? {
                resultType: "complete",
                content: [{ type: "text", text: error }],
                isError: true,
              }
            : {
                resultType: "complete",
                content: [{ type: "text", text: JSON.stringify(error) }],
                structuredContent: error,
                isError: true,
              },
      });
    };
    fake.next = failing;
    return new Response(null, { status: 204 });
  }
  return await fakeAt(request.url).handle(request);
};
