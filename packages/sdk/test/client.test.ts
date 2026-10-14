import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { GraspClient } from "../src/client-core.ts";
import type { ClientTransport } from "../src/client-core.ts";
import { GraspError } from "../src/client-error.ts";
import type { Id } from "../src/index.ts";
import { api } from "./notes/.grasp/references.ts";

// The session client against the network and the page it reaches through:
// what it does with what comes back, where core's own route isn't what
// is tested (apps/core/test/screen-client.test.ts goes through that).
// The page refuses for the person's request budget; core answers a call's
// result, or a failure; and a connection loses answers. Each case is one
// a screen meets: a budget used up by re-reads, a sandbox that went away
// mid-call, a release revoked while a read is under way, a network that
// never comes back.

/** What core answers a call: its value. */
const answered = (value: unknown) => ({ result: { ok: true, value } });

/** What core answers a call that failed. */
const failedWith = (code: string, category = "operational") => ({
  result: {
    ok: false,
    error: { code, message: code, category, retryable: false, requestId: "r" },
  },
});

/** What the page rejects a call with when the person's budget is used up. */
const rateLimited = () =>
  Object.assign(new Error("Too much at once."), {
    code: "screen.rate_limited",
    details: { retryAfterMs: 20 },
  });

/** A transport that answers by `answer`, counting calls and those at once. */
const network = (
  answer: (call: number, request: string) => Promise<unknown>
) => {
  let calls = 0;
  let atOnce = 0;
  let mostAtOnce = 0;
  const transport: ClientTransport = {
    call: async (request) => {
      calls += 1;
      atOnce += 1;
      mostAtOnce = Math.max(mostAtOnce, atOnce);
      try {
        return await answer(calls, request);
      } finally {
        atOnce -= 1;
      }
    },
  };
  return {
    client: new GraspClient(transport),
    calls: () => calls,
    mostAtOnce: () => mostAtOnce,
  };
};

/** The structured error `promise` rejected with. */
const failureOf = async (promise: Promise<unknown>): Promise<GraspError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraspError) {
      return error;
    }
    throw error;
  }
  throw new Error("It resolved");
};

/** A note ID, as the App's store makes them. */
const idOf = (suffix: number): Id<"notes"> =>
  // SAFETY: the form of the store's IDs; nothing here reads it further.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  `01890000-0000-7000-8000-${String(suffix).padStart(12, "0")}` as Id<"notes">;

const noteId = idOf(1);

describe("the session client and the request budget", () => {
  it("sends a save again past its budget's refusals, waiting as each says, until it is taken", async () => {
    const { client, calls } = network(async (call) => {
      await Promise.resolve();
      if (call <= 5) {
        throw rateLimited();
      }
      return answered(noteId);
    });
    await expect(
      client.mutation(api.notes.create, { title: "Saved" })
    ).resolves.toBe(noteId);
    expect(calls()).toBe(6);
  });

  it("reads at most four queries at once, the rest waiting their turn", async () => {
    const { client, mostAtOnce } = network(async () => {
      const { promise, resolve } = Promise.withResolvers<null>();
      setTimeout(() => {
        resolve(null);
      }, 10);
      await promise;
      return answered(null);
    });
    const ids = Array.from({ length: 12 }, (_, index) => idOf(index));
    await Promise.all(
      ids.map(async (id) => await client.query(api.notes.get, { id }))
    );
    expect(mostAtOnce()).toBe(4);
  });
});

describe("the session client and an outcome it can't tell", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never sends an action again once it may have run: not after a sandbox lost mid-call, nor a busy one", async () => {
    for (const [code, category] of [
      ["operation.sandbox_lost", "uncertain"],
      ["operation.sandbox_busy", "operational"],
    ] as const) {
      const { client, calls } = network(async () => {
        await Promise.resolve();
        return failedWith(code, category);
      });
      // oxlint-disable-next-line no-await-in-loop -- one case after another
      await expect(
        failureOf(client.action(api.notes.tally))
      ).resolves.toMatchObject({ code, category });
      expect(calls()).toBe(1);
    }
  });

  it("answers an action whose sandbox was lost mid-call with the key the client chose", async () => {
    const { client } = network(async () => {
      await Promise.resolve();
      return failedWith("operation.sandbox_lost", "uncertain");
    });
    const failure = await failureOf(client.action(api.notes.tally));
    expect(failure).toMatchObject({
      code: "operation.sandbox_lost",
      category: "uncertain",
    });
    expect(failure.details).toHaveProperty("idempotencyKey");
  });

  it("sends a mutation lost mid-call again under its key, which recovers its receipt", async () => {
    const keys = new Set<unknown>();
    const { client, calls } = network(async (call, request) => {
      await Promise.resolve();
      const sent: unknown = JSON.parse(request);
      const key: unknown =
        typeof sent === "object" && sent !== null
          ? Reflect.get(sent, "idempotencyKey")
          : undefined;
      keys.add(key);
      return call === 1
        ? failedWith("operation.sandbox_lost", "uncertain")
        : answered(noteId);
    });
    await expect(
      client.mutation(api.notes.create, { title: "Once" })
    ).resolves.toBe(noteId);
    expect(calls()).toBe(2);
    expect(keys.size).toBe(1);
  });

  it("stops sending a mutation whose answers are lost after five minutes, uncertain, with its key", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { client } = network(async () => {
      await Promise.resolve();
      throw new Error("The connection was reset.");
    });
    const outcome = failureOf(
      client.mutation(api.notes.create, { title: "Lost" })
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 60_000);
    const failure = await outcome;
    expect(failure).toMatchObject({
      code: "submission.outcome_unknown",
      category: "uncertain",
    });
    expect(failure.details).toHaveProperty("idempotencyKey");
  });
});

describe("the session client and lost access", () => {
  it.each([
    "version.revoked",
    "permission.person_inactive",
    "app.not_running",
    "auth.session_ended",
  ])("drops a read under way when a call is refused with %s", async (code) => {
    const { promise: held, resolve: release } = Promise.withResolvers<null>();
    const { client } = network(async (_call, request) => {
      if (request.includes("notes.get")) {
        await held;
        return answered({ title: "Kept from before" });
      }
      await Promise.resolve();
      return failedWith(code, "authorization");
    });
    const reading = failureOf(client.query(api.notes.get, { id: noteId }));
    await expect(
      failureOf(client.mutation(api.notes.create, { title: "After" }))
    ).resolves.toMatchObject({ code });
    release(null);
    // The answer to a read sent before the refusal never shows.
    await expect(reading).resolves.toMatchObject({ code });
  });

  it("keeps what it read when the host only couldn't give a token yet", async () => {
    let refuse = false;
    const { client } = network(async () => {
      await Promise.resolve();
      if (refuse) {
        throw Object.assign(new Error("No token yet."), {
          code: "auth.token_unavailable",
        });
      }
      return answered({ title: "Kept" });
    });
    await client.query(api.notes.get, { id: noteId });
    refuse = true;
    await failureOf(client.mutation(api.notes.create, { title: "Later" }));
    refuse = false;
    // Not fenced: the query it read is still there to read again.
    await expect(
      client.query(api.notes.get, { id: noteId })
    ).resolves.toStrictEqual({ title: "Kept" });
  });

  it("never sends a key left unknown again once access was lost since", async () => {
    let signedOut = false;
    const { client, calls } = network(async (call, request) => {
      await Promise.resolve();
      if (request.includes("notes.get")) {
        return signedOut
          ? failedWith("auth.unauthenticated", "authorization")
          : answered(null);
      }
      if (call === 1) {
        throw new Error("The connection was reset.");
      }
      return answered(3);
    });
    const lost = await failureOf(client.action(api.notes.tally));
    const { details } = lost;
    const key: unknown =
      typeof details === "object" && details !== null
        ? Reflect.get(details, "idempotencyKey")
        : undefined;
    expect(key).toBeTypeOf("string");
    signedOut = true;
    await failureOf(client.query(api.notes.get, { id: noteId }));
    signedOut = false;
    const sentBefore = calls();
    await expect(
      failureOf(
        client.action(api.notes.tally, {}, { idempotencyKey: String(key) })
      )
    ).resolves.toMatchObject({ code: "auth.principal_changed" });
    expect(calls()).toBe(sentBefore);
  });
});
