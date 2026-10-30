/**
 * The AI providers connect reaches in core's tests (test/connect-providers.ts):
 * Anthropic, OpenAI, Mistral, OpenRouter and an organization's own
 * OpenAI-compatible endpoint, each at its own host. Each answers the
 * replies a test planned for the key it is sent (`aiProvidersControlUrl`),
 * one per request, and refuses a key it has no plan for, as a provider
 * refuses a key it doesn't know. Every request it got is kept, with all of
 * its headers, so a test can read where a key went and in which header.
 *
 * Serialized into the providers Worker with `toString()`, so it closes
 * over nothing: what it needs is in its own body.
 */

/** Where tests plan replies (POST) and read the requests a key sent (GET). */
export const aiProvidersControlUrl = "https://ai-providers-control.test/";

/** The host of the organization's OpenAI-compatible endpoint in the tests. */
export const compatibleHost = "llm.acme-ai.test";

/**
 * One planned reply: a refusal (`status`, with its `headers`), a whole
 * stream (`sse`), a stream that sends `begin` and then nothing more until
 * its reader goes away (`hold`), no answer at all until the request is
 * dropped (`hang`), or a redirect elsewhere (`redirect`).
 */
export type PlannedReply =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  | { sse: string }
  | { hold: string }
  | { hang: true }
  | { redirect: string };

/** One request a provider got, as it got it. */
export interface ProviderRequest {
  host: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  /** The key it carried, from `x-api-key` or a bearer token. */
  key: string | null;
  /** Set once its sender dropped it while it waited for an answer (`hang`). */
  dropped?: true;
}

export const aiProvidersFake = () => {
  const hosts = new Set([
    "api.anthropic.com",
    "api.openai.com",
    "api.mistral.ai",
    "openrouter.ai",
    "llm.acme-ai.test",
  ]);
  const plans = new Map<string, PlannedReply[]>();
  const seen: ProviderRequest[] = [];
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: its source is embedded
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const isReply = (value: unknown): value is PlannedReply =>
    isRecord(value) &&
    (typeof value.status === "number" ||
      typeof value.sse === "string" ||
      typeof value.hold === "string" ||
      value.hang === true ||
      typeof value.redirect === "string");
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: its source is embedded
  const keyOf = (request: Request): string | null => {
    const apiKey = request.headers.get("x-api-key");
    if (apiKey !== null) {
      return apiKey;
    }
    const bearer = /^Bearer (?<key>.+)$/u.exec(
      request.headers.get("authorization") ?? ""
    );
    return bearer?.groups?.key ?? null;
  };
  const encoder = new TextEncoder();
  const refusal = {
    type: "error",
    error: { type: "api_error", message: "Refused by the fake provider" },
  };
  /** How the provider answers `reply`. */
  const answerOf = async (
    reply: PlannedReply,
    request: Request,
    seenAs: ProviderRequest
  ): Promise<Response> => {
    if ("status" in reply) {
      return Response.json(reply.body ?? refusal, {
        status: reply.status,
        headers: reply.headers ?? {},
      });
    }
    if ("redirect" in reply) {
      return new Response(null, {
        status: 307,
        headers: { location: reply.redirect },
      });
    }
    if ("hang" in reply) {
      // No answer for longer than any test waits: the request is dropped
      // by its sender first, and it notes that it was. A timer, so workerd
      // doesn't take the wait for a Worker that hung.
      const dropped = Promise.withResolvers<true>();
      request.signal.addEventListener(
        "abort",
        () => {
          seenAs.dropped = true;
          dropped.resolve(true);
        },
        { once: true }
      );
      await Promise.race([scheduler.wait(10 * 60_000), dropped.promise]);
      return new Response("Too late", { status: 504 });
    }
    if ("hold" in reply) {
      const { readable, writable } = new TransformStream<Uint8Array>();
      const writer = writable.getWriter();
      void writer.write(encoder.encode(reply.hold));
      return new Response(readable, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(reply.sse, {
      headers: {
        "content-type": "text/event-stream",
        "request-id": `req-${seen.length}`,
      },
    });
  };
  /** Plans replies (POST), or lists what reached the providers (GET). */
  const control = async (request: Request, url: URL): Promise<Response> => {
    if (request.method === "POST") {
      const asked: unknown = await request.json();
      if (
        !isRecord(asked) ||
        typeof asked.key !== "string" ||
        !Array.isArray(asked.replies) ||
        !asked.replies.every(isReply)
      ) {
        return new Response("Not a plan", { status: 400 });
      }
      plans.set(asked.key, [...(plans.get(asked.key) ?? []), ...asked.replies]);
      return new Response(null, { status: 204 });
    }
    // Every request whose headers or body carry the text `anywhere` names
    // (a key, or a placeholder that should be nowhere).
    const anywhere = url.searchParams.get("anywhere") ?? "";
    return Response.json(
      seen.filter((one) => JSON.stringify(one).includes(anywhere))
    );
  };
  return {
    handles: (url: URL): boolean =>
      hosts.has(url.hostname) || url.hostname === "ai-providers-control.test",
    answer: async (request: Request, url: URL): Promise<Response> => {
      if (url.hostname === "ai-providers-control.test") {
        return await control(request, url);
      }
      const key = keyOf(request);
      const seenAs: ProviderRequest = {
        host: url.hostname,
        method: request.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
        key,
      };
      seen.push(seenAs);
      const reply = key === null ? undefined : plans.get(key)?.shift();
      // A key it was told nothing of: refused, as a provider refuses a key
      // it doesn't know.
      return reply === undefined
        ? Response.json(
            {
              type: "error",
              error: { type: "authentication_error", message: "invalid key" },
            },
            { status: 401 }
          )
        : await answerOf(reply, request, seenAs);
    },
  };
};
