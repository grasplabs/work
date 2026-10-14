import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { clientInternals, GraspClient } from "../src/client-core.ts";
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

/** The category core gives `code`, of those these tests answer with. */
const categoryOf = (code: string): string =>
  code === "submission.key_conflict" ? "contract" : "operational";

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
    // Live queries are core's own test (screen-client.test.ts): these
    // cases only make calls.
    watch: async () => {
      await Promise.resolve();
      throw new Error("Nothing here follows a query.");
    },
  };
  return {
    client: new GraspClient(transport),
    calls: () => calls,
    mostAtOnce: () => mostAtOnce,
  };
};

/** A transport's `watch` where nothing follows a query. */
const unwatched: ClientTransport["watch"] = async () => {
  await Promise.resolve();
  throw new Error("Nothing here follows a query.");
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

/** What a test doesn't listen to. */
const unheard = (): void => {
  // Nothing to hear.
};

/**
 * A client following a stream that never ends, whose page answers a
 * cancel with `answer`: the `cancel` a hook is handed, and how to stop.
 */
const following = async (answer: () => Promise<unknown>) => {
  const transport: ClientTransport = {
    call: async () => await Promise.reject(new Error("Not this.")),
    watch: unwatched,
    stream: async () => await Promise.resolve({ release: () => null }),
    cancelStream: answer,
  };
  const client = new GraspClient(transport);
  const started = Promise.withResolvers<() => Promise<void>>();
  const controller = new AbortController();
  const running = (async () => {
    try {
      await clientInternals(client).stream(
        api.notes.exportAll,
        { format: "csv" },
        { signal: controller.signal },
        {
          onStarted: (cancel) => {
            started.resolve(cancel);
          },
          onRecovering: unheard,
          onAttached: unheard,
          onProgress: unheard,
        }
      );
    } catch {
      // Stopped following below.
    }
  })();
  const cancel = await started.promise;
  return {
    cancel,
    stop: async () => {
      controller.abort();
      await running;
    },
  };
};

/** "acknowledged", or the code a cancel answered by `answer` was refused with. */
const cancelled = async (answer: () => Promise<unknown>): Promise<string> => {
  const { cancel, stop } = await following(answer);
  try {
    await cancel();
    return "acknowledged";
  } catch (error) {
    return error instanceof GraspError ? error.code : "thrown";
  } finally {
    await stop();
  }
};

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

  it("never sends a key left unknown again once access was lost since, though a resend found it out", async () => {
    let signedOut = false;
    const sent: string[] = [];
    const { client } = network(async (_call, request) => {
      await Promise.resolve();
      if (request.includes("notes.get")) {
        return signedOut
          ? failedWith("auth.unauthenticated", "authorization")
          : answered(null);
      }
      sent.push(request);
      if (sent.length === 1) {
        throw new Error("The connection was reset.");
      }
      return signedOut
        ? failedWith("auth.unauthenticated", "authorization")
        : answered(3);
    });
    const lost = await failureOf(client.action(api.notes.tally));
    const { details } = lost;
    const key: unknown =
      typeof details === "object" && details !== null
        ? Reflect.get(details, "idempotencyKey")
        : undefined;
    expect(key).toBeTypeOf("string");
    const keyed = { idempotencyKey: String(key) };
    // The person's session ended: the resend is what finds it out.
    signedOut = true;
    const found = await failureOf(client.action(api.notes.tally, {}, keyed));
    // Someone signs in, and the key is sent again: never as them.
    signedOut = false;
    const after = await failureOf(client.action(api.notes.tally, {}, keyed));
    expect({
      found: found.code,
      after: after.code,
      sent: sent.length,
    }).toStrictEqual({
      found: "auth.unauthenticated",
      after: "auth.principal_changed",
      sent: 2,
    });
  });

  it.each([
    "operation.sandbox_busy",
    "operation.sandbox_unavailable",
    "mutation.concurrent_change",
    "submission.superseded",
    // Answered while the first call's receipt has no outcome yet.
    "submission.key_conflict",
    "submission.expired",
    "operation.deadline_exceeded",
  ])(
    "never sends a key left unknown as the next person after a resend refused with %s",
    async (code) => {
      let signedOut = false;
      const sent: string[] = [];
      const { client } = network(async (_call, request) => {
        await Promise.resolve();
        if (request.includes("notes.get")) {
          return signedOut
            ? failedWith("auth.unauthenticated", "authorization")
            : answered(null);
        }
        sent.push(request);
        if (sent.length === 1) {
          throw new Error("The connection was reset.");
        }
        // The resend may not have run: the outcome is as unknown as it was.
        return sent.length === 2
          ? failedWith(code, categoryOf(code))
          : answered(3);
      });
      const lost = await failureOf(client.action(api.notes.tally));
      const { details } = lost;
      const key: unknown =
        typeof details === "object" && details !== null
          ? Reflect.get(details, "idempotencyKey")
          : undefined;
      const keyed = { idempotencyKey: String(key) };
      await failureOf(client.action(api.notes.tally, {}, keyed));
      // The person's session ends; someone else signs in and sends it.
      signedOut = true;
      await failureOf(client.query(api.notes.get, { id: noteId }));
      signedOut = false;
      const after = await failureOf(client.action(api.notes.tally, {}, keyed));
      expect({ after: after.code, sent: sent.length }).toStrictEqual({
        after: "auth.principal_changed",
        sent: 2,
      });
    }
  );

  it("keeps whose a key left unknown is when the host's answer to a resend fences", async () => {
    const sent: string[] = [];
    const { client } = network(async (_call, request) => {
      await Promise.resolve();
      sent.push(request);
      if (sent.length === 1) {
        throw new Error("The connection was reset.");
      }
      // Core's own answer, with its request ID: the App stopped running.
      return sent.length === 2 ? failedWith("app.not_running") : answered(3);
    });
    const lost = await failureOf(client.action(api.notes.tally));
    const { details } = lost;
    const key: unknown =
      typeof details === "object" && details !== null
        ? Reflect.get(details, "idempotencyKey")
        : undefined;
    const keyed = { idempotencyKey: String(key) };
    const fenced = await failureOf(client.action(api.notes.tally, {}, keyed));
    const after = await failureOf(client.action(api.notes.tally, {}, keyed));
    expect({
      fenced: fenced.code,
      after: after.code,
      sent: sent.length,
    }).toStrictEqual({
      fenced: "app.not_running",
      after: "auth.principal_changed",
      sent: 2,
    });
  });

  it("fences on core's refusal of a resend as someone else's, and never sends the key again", async () => {
    const sent: string[] = [];
    const { client } = network(async (_call, request) => {
      await Promise.resolve();
      sent.push(request);
      if (sent.length === 1) {
        throw new Error("The connection was reset.");
      }
      // The page relays core's refusal: the browser's session is someone
      // else's than the screen's now.
      throw Object.assign(new Error("Someone else signed in."), {
        code: "auth.principal_changed",
      });
    });
    const lost = await failureOf(client.action(api.notes.tally));
    const { details } = lost;
    const key: unknown =
      typeof details === "object" && details !== null
        ? Reflect.get(details, "idempotencyKey")
        : undefined;
    const keyed = { idempotencyKey: String(key) };
    const refused = await failureOf(client.action(api.notes.tally, {}, keyed));
    const after = await failureOf(client.action(api.notes.tally, {}, keyed));
    expect({
      refused: refused.code,
      after: after.code,
      sent: sent.length,
    }).toStrictEqual({
      refused: "auth.principal_changed",
      after: "auth.principal_changed",
      sent: 2,
    });
  });

  it("keeps whose a key left unknown is for its operation, whatever another operation under the key does", async () => {
    let signedOut = false;
    const tallies: string[] = [];
    const { client } = network(async (_call, request) => {
      await Promise.resolve();
      if (request.includes("notes.get")) {
        return signedOut
          ? failedWith("auth.unauthenticated", "authorization")
          : answered(null);
      }
      if (request.includes("notes.create")) {
        return answered(noteId);
      }
      tallies.push(request);
      throw new Error("The connection was reset.");
    });
    const keyed = { idempotencyKey: "weekly" };
    // X's outcome is left unknown; Y, under the same key, goes through.
    await failureOf(client.action(api.notes.tally, {}, keyed));
    await client.mutation(api.notes.create, { title: "Y" }, keyed);
    signedOut = true;
    await failureOf(client.query(api.notes.get, { id: noteId }));
    signedOut = false;
    const retried = await failureOf(client.action(api.notes.tally, {}, keyed));
    expect({ retried: retried.code, tallies: tallies.length }).toStrictEqual({
      retried: "auth.principal_changed",
      tallies: 1,
    });
  });

  it("never sends a lost save again once access was lost while it waited to", async () => {
    let signedOut = false;
    const creates: string[] = [];
    const { client } = network(async (_call, request) => {
      await Promise.resolve();
      if (request.includes("notes.get")) {
        return signedOut
          ? failedWith("auth.unauthenticated", "authorization")
          : answered(null);
      }
      creates.push(request);
      throw new Error("The connection was reset.");
    });
    const saving = failureOf(
      client.mutation(api.notes.create, { title: "A's" })
    );
    // Its first answer is lost; before it is sent again, access is lost.
    await expect.poll(() => creates.length).toBe(1);
    signedOut = true;
    await failureOf(client.query(api.notes.get, { id: noteId }));
    await expect(saving).resolves.toMatchObject({
      code: "submission.outcome_unknown",
    });
    expect(creates).toHaveLength(1);
  });
});

describe("the session client and a change it confirmed", () => {
  it("answers a query asked after a confirmed change with a read sent after it, not one under way since before", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<null>();
    let saved = false;
    let reads = 0;
    const { client } = network(async (_call, request) => {
      if (request.includes("notes.create")) {
        saved = true;
        return answered(noteId);
      }
      reads += 1;
      // The first read was sent before the save; its answer comes late.
      if (reads === 1) {
        await held;
        return answered({ title: "Before" });
      }
      await Promise.resolve();
      return answered({ title: saved ? "After" : "Before" });
    });
    const early = client.query(api.notes.get, { id: noteId });
    await client.mutation(api.notes.create, { title: "After" });
    const later = client.query(api.notes.get, { id: noteId });
    release(null);

    await expect(Promise.all([early, later])).resolves.toStrictEqual([
      { title: "Before" },
      { title: "After" },
    ]);
  });
});

describe("the session client following a query", () => {
  it("waits as long as a refusal for the request budget says before following again", async () => {
    let follows = 0;
    const transport: ClientTransport = {
      call: async () => await Promise.resolve(answered(null)),
      watch: async () => {
        follows += 1;
        await Promise.resolve();
        throw Object.assign(new Error("Too much at once."), {
          code: "screen.rate_limited",
          details: { retryAfterMs: 2000 },
        });
      },
    };
    const client = new GraspClient(transport);
    const internals = clientInternals(client);
    const entry = internals.entry(api.notes.get, { id: noteId });
    const stop = internals.subscribe(entry, () => {
      // A component reading it.
    });
    try {
      const { promise, resolve } = Promise.withResolvers<null>();
      setTimeout(() => {
        resolve(null);
      }, 1500);
      await promise;
      expect(follows).toBe(1);
    } finally {
      stop();
    }
  });
});

describe("the session client and a streaming action's cancel", () => {
  it("resolves a cancel only once the host acknowledged it, and never takes a lost or refused one for one", async () => {
    expect({
      acknowledged: await cancelled(
        async () => await Promise.resolve({ requested: true })
      ),
      notRunning: await cancelled(
        async () => await Promise.resolve({ requested: false })
      ),
      unreadable: await cancelled(
        async () => await Promise.resolve({ result: { ok: true, value: null } })
      ),
      lost: await cancelled(
        async () => await Promise.reject(new Error("The connection was reset."))
      ),
      refused: await cancelled(async () => await Promise.reject(rateLimited())),
    }).toStrictEqual({
      acknowledged: "acknowledged",
      notRunning: "acknowledged",
      unreadable: "operation.unreachable",
      lost: "operation.unreachable",
      refused: "screen.rate_limited",
    });
  });
});

describe("the session client and a cancel asked for while a stream opens", () => {
  it("sends the cancel only once the invocation has answered", async () => {
    const seen: string[] = [];
    const opening = Promise.withResolvers<null>();
    const transport: ClientTransport = {
      call: async () => await Promise.reject(new Error("Not this.")),
      watch: unwatched,
      stream: async () => {
        seen.push("open asked");
        await opening.promise;
        seen.push("opened");
        return { release: () => null };
      },
      cancelStream: async () => {
        seen.push("cancel sent");
        return await Promise.resolve({ requested: true });
      },
    };
    const client = new GraspClient(transport);
    const started = Promise.withResolvers<() => Promise<void>>();
    const controller = new AbortController();
    const running = (async () => {
      try {
        await clientInternals(client).stream(
          api.notes.exportAll,
          { format: "csv" },
          { signal: controller.signal },
          {
            onStarted: (cancel) => {
              started.resolve(cancel);
            },
            onRecovering: unheard,
            onAttached: unheard,
            onProgress: unheard,
          }
        );
      } catch {
        // Stopped following below.
      }
    })();
    const cancel = await started.promise;
    const cancelling = cancel();
    await vi.waitFor(() => {
      expect(seen).toContain("open asked");
    });
    opening.resolve(null);
    await cancelling;
    controller.abort();
    await running;
    expect(seen).toStrictEqual(["open asked", "opened", "cancel sent"]);
  });
});

describe("the session client and a caller who leaves while a stream opens", () => {
  it("stops waiting for an open that stalls, and lets go of the connection that arrives late", async () => {
    const opening = Promise.withResolvers<null>();
    let released = 0;
    const transport: ClientTransport = {
      call: async () => await Promise.reject(new Error("Not this.")),
      stream: async () => {
        await opening.promise;
        return {
          release: () => {
            released += 1;
          },
        };
      },
      cancelStream: async () => await Promise.resolve({ requested: true }),
    };
    const client = new GraspClient(transport);
    const controller = new AbortController();
    const running = failureOf(
      client.stream(
        api.notes.exportAll,
        { format: "csv" },
        { signal: controller.signal, onProgress: unheard }
      )
    );
    controller.abort();
    const left = await running;
    opening.resolve(null);
    await vi.waitFor(() => {
      expect(released).toBe(1);
    });
    expect(left.code).toBe("stream.cancelled");
  });
});

describe("the session client and frames that arrive after the caller left", () => {
  it("hands no progress on from a connection whose open the caller stopped waiting for", async () => {
    const opening = Promise.withResolvers<null>();
    const delivering = Promise.withResolvers<(frame: unknown) => void>();
    const transport: ClientTransport = {
      call: async () => await Promise.reject(new Error("Not this.")),
      stream: async (_what, _request, onFrame) => {
        // The page relays frames as they come, before the open resolves.
        delivering.resolve(onFrame);
        await opening.promise;
        return { release: () => null };
      },
      cancelStream: async () => await Promise.resolve({ requested: true }),
    };
    const client = new GraspClient(transport);
    const controller = new AbortController();
    const heard: unknown[] = [];
    const running = failureOf(
      client.stream(
        api.notes.exportAll,
        { format: "csv" },
        {
          signal: controller.signal,
          onProgress: (progress) => {
            heard.push(progress);
          },
        }
      )
    );
    const deliver = await delivering.promise;
    controller.abort();
    const left = await running;
    deliver({ type: "progress", seq: 1, value: { done: 1 } });
    opening.resolve(null);
    expect({ left: left.code, heard }).toStrictEqual({
      left: "stream.cancelled",
      heard: [],
    });
  });
});
