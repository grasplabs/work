/**
 * The AI providers, as the e2e stack reaches them: a local server that
 * stands in for Mistral and Anthropic, so no request of a test leaves the
 * machine. Connect sends every fixed provider's request here instead of
 * the provider's own host (its `AI_PROVIDER_ORIGIN`, set by
 * e2e/connect-config.ts), its path unchanged and the provider's host in
 * `x-forwarded-host`. It refuses every key, as a provider refuses one it
 * doesn't know (401, in the provider's own error shape), which the chat
 * tests show as the model failing to answer (e2e/chat.e2e.ts). The global
 * setup proves the stack's requests land here (`expectModelRequestsHere`).
 *
 * Started by Playwright beside the stack (playwright.config.ts), on the
 * checkout's port for it (e2e/stack.ts):
 *
 *   node e2e/model-fake.ts
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { modelFakeOrigin, modelFakePort } from "./stack.ts";

/** Where the fake lists the requests it got: GET, as JSON. */
const requestsPath = "/requests";

/** One request the fake got, as it lists it. */
export interface FakeModelRequest {
  method: string;
  path: string;
  /** The provider's own host, as connect named it. */
  forwardedHost: string | null;
}

/** A provider's refusal of a key it doesn't know, in its own shape. */
const refusalOf = (path: string): unknown =>
  path.startsWith("/v1/messages")
    ? {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      }
    : { message: "Unauthorized", type: "invalid_request_error" };

const serve = (): void => {
  const got: FakeModelRequest[] = [];
  const answer = (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "/";
    if (request.method === "GET" && path === requestsPath) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(got));
      return;
    }
    const forwarded = request.headers["x-forwarded-host"];
    got.push({
      method: request.method ?? "",
      path,
      forwardedHost: typeof forwarded === "string" ? forwarded : null,
    });
    // Read whole first: a refusal mid-upload resets the connection.
    request.resume();
    request.on("end", () => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify(refusalOf(path)));
    });
  };
  // On the loopback addresses only, whichever `localhost` resolves to.
  createServer(answer).listen(modelFakePort, "127.0.0.1");
  createServer(answer)
    .on("error", () => {
      // No IPv6 loopback here: `localhost` is 127.0.0.1 alone.
    })
    .listen(modelFakePort, "::1");
};

/**
 * Fails unless a request for each of `hosts` reached the fake: what the
 * stack sends a provider lands here, never at the provider. Each host's
 * request is one the setup just made (an admin's test of the provider),
 * so had connect sent it to the provider itself, the fake wouldn't have it.
 */
export const expectModelRequestsHere = async (
  hosts: readonly string[]
): Promise<void> => {
  const response = await fetch(`${modelFakeOrigin}${requestsPath}`);
  // SAFETY: the fake answers with its own list (`serve`).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const got = (await response.json()) as FakeModelRequest[];
  const reached = new Set(got.map(({ forwardedHost }) => forwardedHost));
  const missing = hosts.filter((host) => !reached.has(host));
  if (missing.length > 0) {
    throw new Error(
      `No request for ${missing.join(", ")} reached the fake providers at ${modelFakeOrigin}: the stack sent it elsewhere, maybe to the provider itself. Connect sends them here only with AI_PROVIDER_ORIGIN (e2e/connect-config.ts).`
    );
  }
};

if (import.meta.main) {
  serve();
}
