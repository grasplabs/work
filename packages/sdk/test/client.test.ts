import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { clientInternals, GraspClient } from "../src/client-core.ts";
import { GraspError } from "../src/client-error.ts";
import type { ClientTransport } from "../src/client-transport.ts";
import type { FileRef } from "../src/file-references.ts";
import type { Id } from "../src/index.ts";
import { GraspProvider, useFile } from "../src/react.ts";
import { api } from "./notes/server/_generated/api.ts";

// The session client against the network and the page it reaches through:
// what it does with what comes back, where core's own route isn't what
// is tested (apps/core/test/page-client*.test.ts go through that).
// The page refuses for the person's request budget; core answers a call's
// result, or a failure; and a connection loses answers. Each case is one
// a page meets: a budget used up by re-reads, a sandbox that went away
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
    code: "page.rate_limited",
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
    // Live queries are core's own test (page-client-live.test.ts): these
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

/** The code a call failed with, or "ok". */
const codeOf = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call();
    return "ok";
  } catch (error) {
    return error instanceof GraspError ? error.code : String(error);
  }
};

/** `args`, deliberately not what a reference takes, as unchecked data may be. */
const loose = (args: object): never =>
  // SAFETY: never read as the type it claims; the client checks it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  args as never;

describe("the session client's paginated list", () => {
  it("asks Load More for the arguments it was given, whatever the caller does to them after", async () => {
    const followed: { input?: unknown }[] = [];
    const client = new GraspClient({
      call: async () => await Promise.reject(new Error("No calls here")),
      watch: async (request, onSnapshot) => {
        const sent: unknown = JSON.parse(request);
        followed.push(
          typeof sent === "object" && sent !== null && "input" in sent
            ? { input: sent.input }
            : {}
        );
        await Promise.resolve();
        onSnapshot({
          revision: followed.length,
          result: {
            ok: true,
            value: { items: [], hasMore: true, nextCursor: "next" },
          },
        });
        return { release: () => {} };
      },
    });
    const internals = clientInternals(client);
    const args = { search: "launch" };
    const pager = internals.pager(api.notes.list, args, 2);
    const stop = internals.subscribePager(pager, () => {});
    for (let tick = 0; tick < 20 && followed.length === 0; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- waits for the first follow
      await Promise.resolve();
    }
    // Shown once its first page is.
    await pager.loadMore();
    // The caller's object, changed once the list was asked for.
    args.search = "changed";
    await pager.loadMore();
    expect(followed.map(({ input }) => input)).toStrictEqual([
      // The first page; then, for the Load More once it shows, that page
      // ended where it ends and the page after it.
      { search: "launch", pagination: { pageSize: 2, cursor: null } },
      {
        search: "launch",
        pagination: { pageSize: 2, cursor: null, endCursor: "next" },
      },
      { search: "launch", pagination: { pageSize: 2, cursor: "next" } },
    ]);
    stop();
  });
});

/** A page a list asks the host for, as its `pagination` argument. */
interface Asked {
  readonly pageSize: number;
  readonly cursor: string | null;
  readonly endCursor?: string;
}

/**
 * A host that answers a list of `titles` in title order, keyset pages
 * whose cursors (`<version>:<title>`) expire with `version`, as core's
 * do with a release. What the test controls: `version`, records `hidden`
 * from the person, `broken` (every page with a cursor refused, as when
 * its anchor ranks before its start), and `hold` (answers held until
 * `release`: to pages with a cursor, or to all). `reread` pushes every page followed, as
 * a write would; `asked` is every page followed, in order.
 */
/** The title a test host's cursor (`<version>:<title>`) is after. */
const titleOf = (cursor: string): string =>
  cursor.slice(cursor.indexOf(":") + 1);

/** The page a followed request asks for, read from its JSON. */
const askedOf = (request: string): Asked => {
  const sent: unknown = JSON.parse(request);
  const input: unknown =
    typeof sent === "object" && sent !== null ? Reflect.get(sent, "input") : {};
  const pagination: unknown =
    typeof input === "object" && input !== null
      ? Reflect.get(input, "pagination")
      : {};
  const field = (name: string): unknown =>
    typeof pagination === "object" && pagination !== null
      ? Reflect.get(pagination, name)
      : undefined;
  const pageSize = field("pageSize");
  const cursor = field("cursor");
  const endCursor = field("endCursor");
  return {
    pageSize: typeof pageSize === "number" ? pageSize : 0,
    cursor: typeof cursor === "string" ? cursor : null,
    ...(typeof endCursor === "string" ? { endCursor } : {}),
  };
};

/** Which answers a test host holds back until it releases them. */
type Holding = "none" | "cursors" | "all";

const listHost = (titles: readonly string[]) => {
  const state: {
    version: number;
    hidden: Set<string>;
    broken: boolean;
    hold: Holding;
  } = {
    version: 0,
    hidden: new Set<string>(),
    broken: false,
    hold: "none",
  };
  interface Followed {
    readonly asked: Asked;
    readonly onSnapshot: (push: unknown) => void;
    revision: number;
  }
  const followed = new Set<Followed>();
  const held: Followed[] = [];
  const asked: Asked[] = [];
  const resultOf = ({ pageSize, cursor, endCursor }: Asked) => {
    const cursors = [cursor, endCursor ?? null].filter(
      (each): each is string => each !== null
    );
    if (
      (state.broken && cursors.length > 0) ||
      cursors.some((each) => !each.startsWith(`${state.version}:`))
    ) {
      return failedWith("data.cursor_expired", "domain").result;
    }
    const after = cursor === null ? undefined : titleOf(cursor);
    const visible = titles.filter(
      (title) =>
        !state.hidden.has(title) && (after === undefined || title > after)
    );
    const until = endCursor === undefined ? undefined : titleOf(endCursor);
    const items =
      until === undefined
        ? visible.slice(0, pageSize)
        : visible.filter((title) => title <= until);
    const last = items.at(-1);
    const hasMore = visible.length > items.length;
    const nextCursor =
      endCursor ?? (last === undefined ? null : `${state.version}:${last}`);
    return {
      ok: true,
      value:
        hasMore && nextCursor !== null
          ? { items: items.map((title) => ({ title })), hasMore, nextCursor }
          : {
              items: items.map((title) => ({ title })),
              hasMore: false,
              nextCursor: null,
            },
    };
  };
  const push = (page: Followed): void => {
    page.revision += 1;
    page.onSnapshot({ revision: page.revision, result: resultOf(page.asked) });
  };
  const transport: ClientTransport = {
    call: async () => await Promise.reject(new Error("No calls here")),
    watch: async (request, onSnapshot) => {
      const page: Followed = {
        asked: askedOf(request),
        onSnapshot,
        revision: 0,
      };
      asked.push(page.asked);
      followed.add(page);
      await Promise.resolve();
      if (
        state.hold === "all" ||
        (state.hold === "cursors" && page.asked.cursor !== null)
      ) {
        held.push(page);
      } else {
        push(page);
      }
      return {
        release: () => {
          followed.delete(page);
        },
      };
    },
  };
  return {
    state,
    asked,
    client: new GraspClient(transport),
    reread: () => {
      // Those followed now: a page followed meanwhile is read anew.
      const now = [...followed];
      for (const page of now) {
        push(page);
      }
    },
    release: () => {
      state.hold = "none";
      for (const page of held.splice(0)) {
        if (followed.has(page)) {
          push(page);
        }
      }
    },
  };
};

/** A list of `host`'s, followed, `size` a page, and what it shows. */
const listOf = (host: ReturnType<typeof listHost>, size: number) => {
  const internals = clientInternals(host.client);
  const pager = internals.pager(api.notes.list, {}, size);
  const stop = internals.subscribePager(pager, () => {});
  const titles = (): unknown[] =>
    pager.snapshot.view.items.map((item) =>
      typeof item === "object" && item !== null && "title" in item
        ? item.title
        : item
    );
  return { pager, stop, titles };
};

describe("the session client's paginated list started again", () => {
  it("recovers once what failed its pages passed, rather than start again for ever", async () => {
    const host = listHost(["a", "b", "c", "d", "e", "f"]);
    const list = listOf(host, 2);
    await vi.waitFor(() => {
      expect(list.titles()).toStrictEqual(["a", "b"]);
    });
    await list.pager.loadMore();
    // Every page with a cursor is refused once, then the cause passes:
    // the pages it starts again with are the same queries, cached failed.
    host.state.broken = true;
    host.reread();
    host.state.broken = false;
    const settled = () => ({
      titles: list.titles(),
      error: list.pager.snapshot.error,
      // Loaded back whole, every page showing its own answer.
      refilling: list.pager.refill !== undefined,
      pages: list.pager.pages.map(
        ({ entry, held }) =>
          held === undefined && entry.snapshot.error === undefined
      ),
    });
    const recovered = {
      titles: ["a", "b", "c", "d"],
      error: undefined,
      refilling: false,
      pages: [true, true],
    };
    await vi.waitFor(() => {
      expect(settled()).toStrictEqual(recovered);
    });
    // A write reads every page again: still as it is, never starting
    // again and again.
    host.reread();
    await vi.waitFor(() => {
      expect(settled()).toStrictEqual(recovered);
    });
    expect(host.asked.length).toBeLessThan(20);
    list.stop();
  });

  it("never loads more from a cursor cached from before it started again", async () => {
    const host = listHost(["a", "b", "c", "d", "e", "f"]);
    const list = listOf(host, 2);
    await vi.waitFor(() => {
      expect(list.titles()).toStrictEqual(["a", "b"]);
    });
    // Three more: the page a Load More of two would ask for after the
    // first is one the list never asked for, so nothing cached answers it.
    await list.pager.loadMore(3);
    const before = host.asked.length;
    // A new version: every cursor read before expires, and the first
    // page's fresh answer is slow to come.
    host.state.version = 1;
    host.state.hold = "all";
    host.reread();
    // A Load More while the list starts again, its first page showing
    // only what was cached from before.
    const more = list.pager.loadMore();
    host.release();
    await more;
    await vi.waitFor(() => {
      expect({
        titles: list.titles(),
        refilling: list.pager.refill !== undefined,
      }).toStrictEqual({
        titles: ["a", "b", "c", "d", "e", "f"],
        refilling: false,
      });
    });
    expect(
      host.asked
        .slice(before)
        .flatMap(({ cursor, endCursor }) => [cursor, endCursor ?? null])
        .filter((cursor) => cursor?.startsWith("0:") === true)
    ).toStrictEqual([]);
    list.stop();
  });

  it("stops showing records the person may no longer see once its first page answers, the refill going on behind", async () => {
    const host = listHost(["a", "b", "c", "d", "e", "f"]);
    const list = listOf(host, 2);
    await vi.waitFor(() => {
      expect(list.titles()).toStrictEqual(["a", "b"]);
    });
    await list.pager.loadMore();
    // A rule now hides `b`, and a new version expires every cursor; the
    // refill's later pages are slow to answer.
    host.state.hidden.add("b");
    host.state.version = 1;
    host.state.hold = "cursors";
    host.reread();
    await vi.waitFor(() => {
      expect({
        titles: list.titles(),
        refilling: list.pager.refill !== undefined,
      }).toStrictEqual({ titles: ["a", "c"], refilling: true });
    });
    host.release();
    await vi.waitFor(() => {
      expect(list.titles()).toStrictEqual(["a", "c", "d", "e"]);
    });
    list.stop();
  });
});

describe("the session client and arguments JSON can't hold", () => {
  it("refuses them as invalid arguments, sending nothing", async () => {
    const { client, calls } = network(async () => {
      await Promise.resolve();
      return answered(null);
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect({
      nan: await codeOf(
        async () => await client.query(api.notes.get, loose({ id: Number.NaN }))
      ),
      infinity: await codeOf(
        async () =>
          await client.query(
            api.notes.get,
            loose({ id: Number.POSITIVE_INFINITY })
          )
      ),
      bigint: await codeOf(
        async () => await client.query(api.notes.get, loose({ id: 1n }))
      ),
      cycle: await codeOf(
        async () => await client.query(api.notes.get, loose(cyclic))
      ),
      saved: await codeOf(
        async () =>
          await client.mutation(api.notes.create, loose({ title: Number.NaN }))
      ),
      holes: await codeOf(
        async () =>
          await client.query(
            api.notes.get,
            loose({ id: [undefined, undefined] })
          )
      ),
      sent: calls(),
    }).toStrictEqual({
      nan: "contract.invalid_args",
      infinity: "contract.invalid_args",
      bigint: "contract.invalid_args",
      cycle: "contract.invalid_args",
      saved: "contract.invalid_args",
      holes: "contract.invalid_args",
      sent: 0,
    });
  });
});

describe("the session client and an outcome it can't tell", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never sends an action again once it may have run: not after a sandbox lost mid-call, nor a busy one", async () => {
    for (const [code, category] of [
      ["function.sandbox_lost", "uncertain"],
      ["function.sandbox_busy", "operational"],
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
      return failedWith("function.sandbox_lost", "uncertain");
    });
    const failure = await failureOf(client.action(api.notes.tally));
    expect(failure).toMatchObject({
      code: "function.sandbox_lost",
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
        ? failedWith("function.sandbox_lost", "uncertain")
        : answered(noteId);
    });
    await expect(
      client.mutation(api.notes.create, { title: "Once" })
    ).resolves.toBe(noteId);
    expect(calls()).toBe(2);
    expect(keys.size).toBe(1);
  });

  it("recovers a long action's lost answer through a throttled resend, within the lost answer's budget", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { client, calls } = network(async (call) => {
      if (call === 1) {
        // It ran 20 s, then its answer was lost.
        const ran = Promise.withResolvers<null>();
        setTimeout(() => {
          ran.resolve(null);
        }, 20_000);
        await ran.promise;
        throw new Error("The connection was reset.");
      }
      await Promise.resolve();
      if (call === 2) {
        throw rateLimited();
      }
      return answered(3);
    });
    const outcome = client.action(api.notes.tally);
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(outcome).resolves.toBe(3);
    expect(calls()).toBe(3);
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
        // An outcome the host can't tell: the action's key is left
        // unknown (a lost answer would be sent again for its receipt).
        return failedWith("function.sandbox_lost", "uncertain");
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
    "function.sandbox_busy",
    "function.sandbox_unavailable",
    "mutation.concurrent_change",
    "submission.superseded",
    // Answered while the first call's receipt has no outcome yet.
    "submission.key_conflict",
    "submission.expired",
    "function.deadline_exceeded",
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
          // An outcome the host can't tell: the action's key is left
          // unknown (a lost answer would be sent again for its receipt).
          return failedWith("function.sandbox_lost", "uncertain");
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
        // An outcome the host can't tell: the action's key is left
        // unknown (a lost answer would be sent again for its receipt).
        return failedWith("function.sandbox_lost", "uncertain");
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
        // An outcome the host can't tell: the action's key is left
        // unknown (a lost answer would be sent again for its receipt).
        return failedWith("function.sandbox_lost", "uncertain");
      }
      // The page relays core's refusal: the browser's session is someone
      // else's than the page's now.
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
      // An outcome the host can't tell: the action's key is left
      // unknown (a lost answer would be sent again for its receipt).
      return failedWith("function.sandbox_lost", "uncertain");
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

  it("keeps a read under way when an App's own error carries a refusal among its details", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<null>();
    const { client } = network(async (_call, request) => {
      if (request.includes("notes.get")) {
        await held;
        return answered({ title: "Kept" });
      }
      await Promise.resolve();
      // The App's own failure, whose details happen to name a refusal.
      return {
        result: {
          ok: false,
          error: {
            code: "note.locked",
            message: "Locked.",
            category: "domain",
            retryable: false,
            requestId: "r",
            details: { refusal: "page.revoked" },
          },
        },
      };
    });
    const reading = client.query(api.notes.get, { id: noteId });
    await expect(
      failureOf(client.action(api.notes.tally))
    ).resolves.toMatchObject({ code: "note.locked" });
    release(null);
    // No access was refused: the read under way still shows.
    await expect(reading).resolves.toStrictEqual({ title: "Kept" });
  });

  it("drops a read under way when an action's answer is withheld for a revoked build, its outcome unknown", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<null>();
    const { client } = network(async (_call, request) => {
      if (request.includes("notes.get")) {
        await held;
        return answered({ title: "Kept from before" });
      }
      await Promise.resolve();
      // As core answers an action that ran, its answer withheld.
      return {
        result: {
          ok: false,
          error: {
            code: "submission.outcome_unknown",
            message: "Withheld.",
            category: "uncertain",
            retryable: false,
            requestId: "r",
            details: { idempotencyKey: "k", refusal: "page.revoked" },
          },
        },
      };
    });
    const reading = failureOf(client.query(api.notes.get, { id: noteId }));
    await expect(
      failureOf(client.action(api.notes.tally))
    ).resolves.toMatchObject({
      code: "submission.outcome_unknown",
      details: { refusal: "page.revoked" },
    });
    release(null);
    await expect(reading).resolves.toMatchObject({ code: "page.revoked" });
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
          code: "page.rate_limited",
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
      unreadable: "function.unreachable",
      lost: "function.unreachable",
      refused: "page.rate_limited",
    });
  });
});

describe("the session client and a reconnect that never opens", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on stalled reconnects, unknown with its key, and lets a late one go unheard", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const stalled: PromiseWithResolvers<{ release: () => null }>[] = [];
    let released = 0;
    let heard = 0;
    const late: ((frame: unknown) => void)[] = [];
    const transport: ClientTransport = {
      watch: unwatched,
      call: async () => await Promise.reject(new Error("Not this.")),
      stream: async (what, _request, onFrame) => {
        if (what === "stream") {
          await Promise.resolve();
          // It started; its connection drops.
          setTimeout(() => {
            onFrame({ type: "closed" });
          }, 0);
          return { release: () => null };
        }
        // Every reconnect stops answering.
        const opening = Promise.withResolvers<{ release: () => null }>();
        stalled.push(opening);
        late.push(onFrame);
        return await opening.promise;
      },
      cancelStream: async () => await Promise.resolve({ requested: true }),
    };
    const client = new GraspClient(transport);
    const outcome = failureOf(
      client.stream(
        api.notes.exportAll,
        { format: "csv" },
        {
          onProgress: () => {
            heard += 1;
          },
        }
      )
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const failure = await outcome;
    expect(failure.code).toBe("stream.outcome_unknown");
    expect(failure.details).toHaveProperty("idempotencyKey");
    // The stalled reconnects open after all: let go of, never heard.
    const release = (): null => {
      released += 1;
      return null;
    };
    for (const opening of stalled) {
      opening.resolve({ release });
    }
    for (const onFrame of late) {
      onFrame({ type: "progress", seq: 9, value: { done: 9 } });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect({ released, heard }).toStrictEqual({
      released: stalled.length,
      heard: 0,
    });
  });
});

describe("the session client and a stream its caller stops following", () => {
  it("never answers what was read before a stream that may have saved lost its follower", async () => {
    const held = Promise.withResolvers<null>();
    let reads = 0;
    const transport: ClientTransport = {
      watch: unwatched,
      call: async () => {
        reads += 1;
        if (reads === 1) {
          // Read before the stream ran: answers what was there then.
          await held.promise;
          return answered({ title: "Before" });
        }
        return answered({ title: "After" });
      },
      // It started, and saved something its progress tells of; no result.
      stream: async (_what, _request, onFrame) => {
        await Promise.resolve();
        setTimeout(() => {
          onFrame({ type: "progress", seq: 1, value: { done: 1 } });
        }, 0);
        return { release: () => null };
      },
      cancelStream: async () => await Promise.resolve({ requested: true }),
    };
    const client = new GraspClient(transport);
    const before = client.query(api.notes.get, { id: noteId });
    await vi.waitFor(() => {
      expect(reads).toBe(1);
    });
    const progressed = Promise.withResolvers<null>();
    const controller = new AbortController();
    const stopped = failureOf(
      client.stream(
        api.notes.exportAll,
        { format: "csv" },
        {
          signal: controller.signal,
          onProgress: () => {
            progressed.resolve(null);
          },
        }
      )
    );
    await progressed.promise;
    controller.abort();
    await expect(stopped).resolves.toMatchObject({
      code: "stream.cancelled",
    });
    // Asked after it stopped: a read sent after, never the one under way
    // since before.
    const after = client.query(api.notes.get, { id: noteId });
    held.resolve(null);
    await expect(before).resolves.toStrictEqual({ title: "Before" });
    await expect(after).resolves.toStrictEqual({ title: "After" });
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
      watch: unwatched,
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
      watch: unwatched,
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

describe("the session client and the hooks", () => {
  it("gives a client's hooks the same internals at every render, and another client its own", () => {
    const transport: ClientTransport = {
      call: async () => await Promise.reject(new Error("No calls here")),
      watch: async () => await Promise.reject(new Error("No follows here")),
    };
    const client = new GraspClient(transport);
    const other = new GraspClient(transport);
    // A hook's effect depends on them: new ones each render would run it
    // (and read its file) again on every render.
    const firstRender = clientInternals(client);
    const nextRender = clientInternals(client);
    expect({
      same: firstRender === nextRender,
      shared: firstRender === clientInternals(other),
    }).toStrictEqual({ same: true, shared: false });
  });
});

describe("the session client's files", () => {
  it("refuses a file reference core couldn't have minted in `useFile`, never reading it as skip", () => {
    const client = new GraspClient({
      call: async () => await Promise.reject(new Error("No calls here")),
      watch: async () => await Promise.reject(new Error("No follows here")),
    });
    const resource = {
      kind: "files",
      alias: "attachments",
      operations: ["read"],
    } as const;
    const shown = (file: unknown): string => {
      const Probe = (): null => {
        // SAFETY: deliberately not a FileRef, as unchecked data may be.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        useFile(resource, file as FileRef);
        return null;
      };
      try {
        renderToString(
          createElement(GraspProvider, { client }, createElement(Probe))
        );
        return "rendered";
      } catch (error) {
        return error instanceof GraspError ? error.code : "failed";
      }
    };
    expect([
      shown({}),
      shown({ id: crypto.randomUUID(), extra: true }),
      shown("skip"),
    ]).toStrictEqual([
      "contract.invalid_args",
      "contract.invalid_args",
      "rendered",
    ]);
  });

  it("fences the client once for refusals of file requests that started before that fence", async () => {
    const pending: ((code: string) => void)[] = [];
    const refusedLater = async (): Promise<never> => {
      const { promise, reject } = Promise.withResolvers<never>();
      pending.push((code) => {
        reject(Object.assign(new Error(code), { code }));
      });
      return await promise;
    };
    const transport: ClientTransport = {
      call: async () => await Promise.reject(new Error("No calls here")),
      watch: async () => await Promise.reject(new Error("No follows here")),
      files: {
        upload: refusedLater,
        read: refusedLater,
        download: refusedLater,
        delete: refusedLater,
      },
    };
    const client = new GraspClient(transport);
    const resource = {
      kind: "files",
      alias: "attachments",
      operations: ["read"],
    } as const;
    const first = client.files.download(resource, { id: crypto.randomUUID() });
    const second = client.files.download(resource, { id: crypto.randomUUID() });
    const settled = Promise.allSettled([first, second]);
    for (const refuse of pending) {
      refuse("auth.unauthenticated");
    }
    await settled;
    // A request after the fence, refused so too, fences it again.
    const third = client.files.download(resource, { id: crypto.randomUUID() });
    pending.at(-1)?.("auth.unauthenticated");
    await Promise.allSettled([third]);
    expect(clientInternals(client).fences()).toBe(2);
  });
});
