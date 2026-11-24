import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { ToolError } from "../src/connector.ts";
import { egressHeader, egressKind } from "../src/manifest.ts";
import { providerFetch } from "../src/provider.ts";

// How every connector turns its provider's failed answers into errors a
// caller can act on: once here, for all of them. What sets one provider
// apart (how it names an error, which answers are rate limits) is tested
// with its connector, in connect.

const provider = providerFetch({
  name: "Example",
  errorCodeOf: (body) =>
    z.object({ code: z.string() }).safeParse(body).data?.code,
  isThrottled: (status, code) => status === 403 && code === "slowDown",
  invalidStatuses: [400, 409],
});

const url = new URL("https://api.example.test/v1/items");

/** The provider answers the next request with `response`. */
const answers = (response: Response) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
};

const errorBody = (code: unknown, status: number, headers: HeadersInit = {}) =>
  Response.json({ code }, { status, headers });

/** What a caller learns of the failure: the ToolError's parts. */
const failureOf = async (method = "GET") => {
  try {
    await provider.fetch(url, { method });
  } catch (error) {
    if (error instanceof ToolError) {
      return {
        message: error.message,
        ...error.details,
        notPerformed: error.notPerformed,
        outcomeUnknown: error.outcomeUnknown,
      };
    }
    throw error;
  }
  throw new Error("The request didn't fail");
};

describe("a provider's failed answer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("says a rate limit did nothing, with the wait it asks for, an hour at most", async () => {
    answers(errorBody("tooMany", 429, { "retry-after": "7" }));
    await expect(failureOf("POST")).resolves.toMatchObject({
      code: "throttled",
      retryAfterSeconds: 7,
      notPerformed: true,
    });
    answers(
      errorBody("tooMany", 429, {
        "retry-after": new Date(Date.now() + 30_000).toUTCString(),
      })
    );
    const { retryAfterSeconds } = await failureOf();
    expect(Math.abs((retryAfterSeconds ?? 0) - 30)).toBeLessThanOrEqual(1);
    answers(errorBody("tooMany", 429, { "retry-after": "86400" }));
    await expect(failureOf()).resolves.toMatchObject({
      retryAfterSeconds: 3600,
    });
    answers(errorBody("tooMany", 429));
    await expect(failureOf()).resolves.toMatchObject({
      retryAfterSeconds: 60,
    });
  });

  it("takes what the provider says is a rate limit for one", async () => {
    answers(errorBody("slowDown", 403));
    await expect(failureOf()).resolves.toMatchObject({
      code: "throttled",
      notPerformed: true,
    });
    answers(errorBody("forbidden", 403));
    await expect(failureOf()).resolves.toMatchObject({
      code: "access_denied",
      notPerformed: false,
    });
  });

  it("says an unavailable read did nothing, but not a write, which may have gone through", async () => {
    answers(errorBody("down", 503, { "retry-after": "5" }));
    await expect(failureOf()).resolves.toMatchObject({
      code: "unavailable",
      retryAfterSeconds: 5,
      notPerformed: true,
      outcomeUnknown: false,
    });
    answers(errorBody("down", 503));
    await expect(failureOf("POST")).resolves.toMatchObject({
      code: "unavailable",
      notPerformed: false,
      outcomeUnknown: true,
    });
  });

  it("says a write a server error answered is of unknown outcome, and one it refused failed", async () => {
    const outcomes = await Promise.all(
      [500, 502, 504, 400, 404, 409].map(async (status) => {
        answers(errorBody("somethingWrong", status));
        const { code, notPerformed, outcomeUnknown } = await failureOf("PATCH");
        return { status, code, notPerformed, outcomeUnknown };
      })
    );
    expect(outcomes).toStrictEqual([
      {
        status: 500,
        code: "failed",
        notPerformed: false,
        outcomeUnknown: true,
      },
      {
        status: 502,
        code: "failed",
        notPerformed: false,
        outcomeUnknown: true,
      },
      {
        status: 504,
        code: "failed",
        notPerformed: false,
        outcomeUnknown: true,
      },
      {
        status: 400,
        code: "invalid",
        notPerformed: false,
        outcomeUnknown: false,
      },
      {
        status: 404,
        code: "not_found",
        notPerformed: false,
        outcomeUnknown: false,
      },
      {
        status: 409,
        code: "invalid",
        notPerformed: false,
        outcomeUnknown: false,
      },
    ]);
  });

  it("says a write whose answer was lost on its way back is of unknown outcome", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Network connection lost.")
    );
    await expect(failureOf("POST")).resolves.toMatchObject({
      code: "egress_failed",
      notPerformed: false,
      outcomeUnknown: true,
    });
  });

  it("gets a code by its status, naming the provider's code but never its message", async () => {
    const outcomes = await Promise.all(
      [401, 404, 400, 409, 422, 500].map(async (status) => {
        answers(errorBody("somethingWrong", status));
        const { code, message, notPerformed } = await failureOf();
        return { status, code, message, notPerformed };
      })
    );
    expect(outcomes).toStrictEqual([
      {
        status: 401,
        code: "access_denied",
        message: "Example refused access (somethingWrong)",
        notPerformed: false,
      },
      {
        status: 404,
        code: "not_found",
        message: "Example has no such item (somethingWrong)",
        notPerformed: false,
      },
      {
        status: 400,
        code: "invalid",
        message: "Example refused the request (somethingWrong)",
        notPerformed: false,
      },
      {
        status: 409,
        code: "invalid",
        message: "Example refused the request (somethingWrong)",
        notPerformed: false,
      },
      {
        status: 422,
        code: "failed",
        message: "Example answered 422 (somethingWrong)",
        notPerformed: false,
      },
      {
        status: 500,
        code: "failed",
        message: "Example answered 500 (somethingWrong)",
        notPerformed: false,
      },
    ]);
  });

  it("names no code that isn't an identifier, nor one of an answer that isn't JSON", async () => {
    const messages = await Promise.all(
      [
        errorBody("<script>", 404),
        errorBody(42, 404),
        new Response("Not found", { status: 404 }),
      ].map(async (response) => {
        answers(response);
        const { message } = await failureOf();
        return message;
      })
    );
    expect(messages).toStrictEqual(
      messages.map(() => "Example has no such item")
    );
  });

  it("is told from connect's egress's own answer, whatever its status", async () => {
    const codes = await Promise.all(
      [egressKind.refused, egressKind.failed, "anything else"].map(
        async (kind) => {
          answers(
            new Response("Refused", {
              status: 429,
              headers: { [egressHeader]: kind },
            })
          );
          const { code, notPerformed } = await failureOf();
          return { code, notPerformed };
        }
      )
    );
    expect(codes).toStrictEqual([
      { code: "egress_refused", notPerformed: false },
      { code: "egress_failed", notPerformed: false },
      { code: "egress_failed", notPerformed: false },
    ]);
  });

  it("says a write the egress refused never left, and one it withheld the answer of is of unknown outcome", async () => {
    const outcomes = await Promise.all(
      [egressKind.refused, egressKind.failed].map(async (kind) => {
        answers(
          new Response("Withheld", {
            status: 502,
            headers: { [egressHeader]: kind },
          })
        );
        const { code, outcomeUnknown } = await failureOf("POST");
        return { code, outcomeUnknown };
      })
    );
    expect(outcomes).toStrictEqual([
      { code: "egress_refused", outcomeUnknown: false },
      { code: "egress_failed", outcomeUnknown: true },
    ]);
  });
});

describe("a provider's JSON answer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is what the tool expects of it, or a failure the caller isn't told about", async () => {
    const itemSchema = z.object({ id: z.string() });
    answers(Response.json({ id: "item-1" }));
    await expect(provider.json(url, itemSchema)).resolves.toStrictEqual({
      id: "item-1",
    });
    answers(Response.json({ name: "item-1" }));
    let failure: unknown;
    try {
      await provider.json(url, itemSchema);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ToolError);
  });

  it("is, to a write, of unknown outcome when the tool can't read it: the write went through", async () => {
    const itemSchema = z.object({ id: z.string() });
    const unreadable = await Promise.all(
      [
        Response.json({ name: "item-1" }, { status: 201 }),
        new Response("<html>", { status: 200 }),
      ].map(async (response) => {
        answers(response);
        try {
          await provider.json(url, itemSchema, { method: "POST" });
        } catch (error) {
          return error instanceof ToolError ? error.outcomeUnknown : error;
        }
        return "read";
      })
    );
    expect(unreadable).toStrictEqual([true, true]);
  });
});
