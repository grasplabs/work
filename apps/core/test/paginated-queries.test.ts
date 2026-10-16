import type { Id } from "@grasp-os/sdk";
import { GraspError } from "@grasp-os/sdk/client";
import { clientInternals, GraspClient } from "@grasp-os/sdk/host";
import type { ClientTransport } from "@grasp-os/sdk/host";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import type { Role } from "@grasp-os/shared/roles";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import {
  appFunctionPath,
  rateLimitedRetryMs,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import { liveWindowMaxItems } from "@grasp-os/shared/store-limits";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import type { DataStore } from "../src/data-store.ts";
import { appHost, inJurisdiction } from "../src/durable-objects.ts";
import { windowPages } from "../src/query-windows.ts";
import { pastAccessRecheck } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { apiOf, notesFiles, referenceTo } from "./notes-client-app.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { openRpc, routed, signedInApi } from "./sign-in.ts";

// Live paginated lists (spec 10.6, 11.6) through the session client and
// core, as a screen's `usePaginatedQuery` reads them: a window of a
// Notes App's list that stays one server-order prefix while notes are
// inserted, deleted and moved between Load Mores and while it is shown;
// Load Mores that join; a window that is never pushed torn while writes
// land between its pages; cursors that can't be forged or carried to
// another person; windows core refuses; and a list cleared once the
// person loses access.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/**
 * The Notes App, with what these tests need besides: a mutation that
 * saves many notes in one commit, and one that moves the oldest note to
 * the top of the list (its update time changes).
 */
const files: Record<string, string> = {
  ...notesFiles,
  "operations/notes.ts": `${notesFiles["operations/notes.ts"] ?? ""}
export const seed = mutation({
  args: { prefix: v.string(), count: v.number().integer().min(1).max(100) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (let at = 0; at < args.count; at += 1) {
      await ctx.db.insert("notes", { title: args.prefix + " " + String(at) });
    }
    return null;
  },
});

/** The notes, newest first, never more than ten a page, whatever is asked. */
export const listTen = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(doc("notes")),
  handler: async (ctx, args) =>
    await ctx.db
      .query("notes")
      .withIndex("by_updated")
      .order("desc")
      .paginate({ ...args.pagination, pageSize: Math.min(args.pagination.pageSize, 10) }),
});

export const touchOldest = mutation({
  args: { stamp: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const oldest = await ctx.db.query("notes").withIndex("by_updated").order("asc").first();
    if (oldest) {
      await ctx.db.patch("notes", oldest._id, { body: args.stamp }, { expectedRevision: oldest._rev });
    }
    return null;
  },
});
`,
  "app.ts": (notesFiles["app.ts"] ?? "")
    .replace(
      'import { big, create, echo, get, list, remove, stamp, update } from "./operations/notes.ts";',
      'import { big, create, echo, get, list, listTen, remove, seed, stamp, touchOldest, update } from "./operations/notes.ts";'
    )
    .replace(
      "operations: { notes: { list, get, create, update, remove, echo, stamp, big } }",
      "operations: { notes: { list, listTen, get, create, update, remove, echo, stamp, big, seed, touchOldest } }"
    ),
};

/**
 * A builder's Notes App, made current, its screen approved by an admin and
 * opened: the release, the screen's lease, and the builder's session.
 */
const openedApp = async () => {
  const builder = await personApi("builder");
  const admin = await personApi("admin");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await builder.api.apps.files.commit(id, files, "First");
  await builder.api.apps.versions.setCurrent(id, version);
  const review = await admin.api.screenTrust.review(id);
  await admin.api.screenTrust.approve(id, {
    version: review.version,
    generation: review.generation,
    artifacts: builtArtifacts(review.screens),
  });
  const { lease } = await builder.api.screens.open(id, "notes");
  await builder.api.screens.present(id, lease);
  const release = await loadRelease(env, id, version);
  return {
    app: id,
    lease,
    cookie: builder.session,
    userId: builder.userId,
    release,
    builder,
    screens: builder.api.screens,
  };
};

type Opened = Awaited<ReturnType<typeof openedApp>>;

/**
 * What the page does with what the frame sends (apps/web's
 * screen-host.ts): a call posted to core's function route under the
 * screen's lease, a refusal rejected with its code; a query followed over
 * the page's connection to core, the callback's disposal telling the
 * client core let go of it.
 */
const pageTransport = (
  {
    app,
    lease,
    cookie,
    userId,
  }: Pick<Opened, "app" | "lease" | "cookie" | "userId">,
  screens: Opened["screens"],
  counts: { follows: number }
): ClientTransport => ({
  watch: async (request, onSnapshot, onLost) => {
    counts.follows += 1;
    const callback = Object.assign(
      (push: unknown): void => {
        onSnapshot(push);
      },
      { [Symbol.dispose]: onLost }
    );
    const subscription = await screens.watchQuery(
      app,
      lease,
      request,
      callback
    );
    return {
      release: () => {
        void subscription.release().catch(() => {
          // Gone with the connection.
        });
      },
    };
  },
  call: async (request) => {
    const response = await routed(`${appFunctionPath}/${app}`, {
      method: "POST",
      headers: {
        origin: clientOrigin,
        "content-type": "application/json",
        cookie,
        [screenLeaseHeader]: lease,
        [screenPersonHeader]: userId,
      },
      body: request,
    });
    const answer: unknown = await response.json();
    if (response.ok) {
      return answer;
    }
    const payload = errorPayloadSchema.parse(answer);
    throw Object.assign(new Error(payload.message), { code: payload.code });
  },
});

/** A client over the page's transport, as the frame's runtime mounts it. */
const clientFor = (
  opened: Opened,
  screens: Opened["screens"] = opened.screens
) => {
  const counts = { follows: 0 };
  return {
    client: new GraspClient(pageTransport(opened, screens, counts)),
    counts,
  };
};

/** Another tab of the opened App's builder: its own connection to core. */
const otherTab = async (opened: Opened) => {
  const { core } = await openRpc(opened.cookie);
  const { screens } = core.authenticate();
  await screens.present(opened.app, opened.lease);
  return clientFor(opened, screens).client;
};

/** The code a promise rejected with. */
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraspError) {
      return error.code;
    }
    throw error;
  }
  return "ok";
};

/** The code what `make` throws, or "ok". */
const thrownBy = (make: () => unknown): string => {
  try {
    make();
  } catch (error) {
    if (error instanceof GraspError) {
      return error.code;
    }
    throw error;
  }
  return "ok";
};

const noteSchema = z.object({
  _id: z.string(),
  _updatedAt: z.number(),
  title: z.string(),
});

/**
 * A screen's paginated list of `reference`, as `usePaginatedQuery`
 * subscribes: its snapshots as they come, and its controls.
 */
const listing = (
  client: GraspClient,
  reference: unknown,
  initialPageSize: number
) => {
  const internals = clientInternals(client);
  const pager = internals.pager(reference, {}, initialPageSize);
  const seen: (typeof pager.snapshot)[] = [];
  const stop = internals.subscribePager(pager, () => {
    seen.push(pager.snapshot);
  });
  const notes = () => z.array(noteSchema).parse(pager.snapshot.view.items);
  return {
    pager,
    stop,
    seen,
    titles: () => notes().map(({ title }) => title),
    notes,
    view: () => pager.snapshot.view,
  };
};

/** How long a push may take to arrive, and how often to look. */
const pushWait = { timeout: 20_000, interval: 50 };

/** Once `look` passes. */
const eventually = async (look: () => void): Promise<void> => {
  await vi.waitFor(look, pushWait);
};

/** The App's own notes, newest first, as one read answers them. */
const allTitles = async (
  client: GraspClient,
  api: ReturnType<typeof apiOf>
): Promise<string[]> => {
  const page = await client.query(api.list, { pagination: { pageSize: 100 } });
  return page.items.map(({ title }) => title);
};

/** A call of `path` as a screen's client sends it, raw, with a window. */
const windowRequest = (
  opened: Opened,
  path: string,
  input: unknown,
  window?: unknown
): string => {
  const reference = referenceTo<unknown, unknown, "query">(
    opened.release,
    path
  );
  return JSON.stringify({
    reference: {
      resourceId: reference.resourceId,
      resourceVersion: reference.resourceVersion,
      contractId: reference.contractId,
      fingerprint: reference.fingerprint,
      kind: reference.kind,
    },
    input,
    window,
  });
};

/** A refusal core threw: its code, and how long it said to wait. */
const refusalOf = (error: unknown) => {
  const parsed = z
    .object({
      code: z.string(),
      details: z.object({ retryAfterMs: z.number() }).optional(),
    })
    .safeParse(error);
  return parsed.success
    ? {
        code: parsed.data.code,
        retryAfterMs: parsed.data.details?.retryAfterMs,
      }
    : "failed";
};

/** What core answered a raw call: its value, or the code it failed with. */
const answerOf = (answer: unknown): unknown => {
  const { result } = z
    .object({
      result: z.union([
        z.object({ ok: z.literal(true), value: z.unknown() }),
        z.object({
          ok: z.literal(false),
          error: z.object({ code: z.string() }),
        }),
      ]),
    })
    .parse(answer);
  return result.ok ? result.value : result.error.code;
};

/** The Notes App's store's object. */
const storeObjectOf = (opened: Opened) => {
  const storeId = opened.release.store?.storeId;
  if (storeId === undefined) {
    throw new Error("The Notes App has a store");
  }
  return inJurisdiction(env, env.DATA_STORES).getByName(storeId);
};

/**
 * 160 notes, saved by `client`: a window of all of them takes two pages
 * of core's.
 */
const seeded = async (opened: Opened, client: GraspClient): Promise<void> => {
  const seed = referenceTo<{ prefix: string; count: number }, null, "mutation">(
    opened.release,
    "notes.seed"
  );
  await client.mutation(seed, { prefix: "A", count: 100 });
  await client.mutation(seed, { prefix: "B", count: 60 });
};

const pagedReadSchema = z.object({
  kind: z.literal("query"),
  query: z.object({
    terminal: z.object({
      kind: z.literal("paginate"),
      cursor: z.string().nullable(),
    }),
  }),
});

/**
 * Runs `act` in the opened App's store's object just before each of the
 * next `times` reads of a page: the first page of a window (`"first"`,
 * no cursor) or a page after it (`"later"`, a cursor's). Answers what
 * puts the store's object back as it was.
 */
const beforePageReads = async (
  opened: Opened,
  { times, which }: { times: number; which: "first" | "later" },
  act: (sql: SqlStorage) => Promise<void>
): Promise<() => void> => {
  const storeId = opened.release.store?.storeId;
  let left = times;
  let undo: (() => void) | undefined;
  await runInDurableObject(storeObjectOf(opened), (instance, state) => {
    // SAFETY: a store's object's prototype holds its methods.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const methods = Object.getPrototypeOf(instance) as {
      read: (...args: Parameters<DataStore["read"]>) => Promise<string>;
    };
    const original: unknown = Reflect.get(methods, "read");
    if (typeof original !== "function") {
      throw new TypeError("A store's object reads");
    }
    methods.read = async function read(
      this: unknown,
      ...args: Parameters<DataStore["read"]>
    ): Promise<string> {
      const [id, , request] = args;
      const paged = pagedReadSchema.safeParse(request);
      if (
        id === storeId &&
        left > 0 &&
        paged.success &&
        (paged.data.query.terminal.cursor === null) === (which === "first")
      ) {
        left -= 1;
        await act(state.storage.sql);
      }
      const answer: unknown = await Reflect.apply(original, this, args);
      return String(answer);
    };
    undo = () => {
      Reflect.set(methods, "read", original);
    };
  });
  return () => {
    undo?.();
  };
};

/**
 * Has a write land in the opened App's store just before each of the
 * next `times` reads of a page after the first: it retitles every note
 * and moves the table on, as a commit between two pages of a window
 * would.
 */
const writeBetweenPages = async (
  opened: Opened,
  times: number
): Promise<() => void> =>
  await beforePageReads(opened, { times, which: "later" }, async (sql) => {
    sql.exec(
      "UPDATE sdk_records SET value_json = json_set(value_json, '$.title', 'Changed ' || record_id), revision = revision + 1"
    );
    sql.exec("UPDATE sdk_tables SET generation = generation + 1");
    await Promise.resolve();
  });

const pushSchema = z.object({
  revision: z.number(),
  result: z.union([
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
  ]),
});

/**
 * A page's callback for a raw subscription: what reached it, and whether
 * core let go of it.
 */
const pageFollower = () => {
  const received: z.infer<typeof pushSchema>[] = [];
  const state = { released: false };
  const callback = Object.assign(
    (push: unknown): void => {
      received.push(pushSchema.parse(push));
    },
    {
      [Symbol.dispose]: (): void => {
        state.released = true;
      },
    }
  );
  return { received, state, callback };
};

/** The extent of the window a raw request asks for, if any. */
const windowExtentIn = (request: string): number | undefined => {
  const parsed = z
    .object({ window: z.object({ extent: z.number() }) })
    .safeParse(JSON.parse(request));
  return parsed.success ? parsed.data.window.extent : undefined;
};

describe("live paginated lists", { timeout: 180_000 }, () => {
  it("keeps one server-order prefix, with no note twice or missing, as notes are saved, deleted and moved between Load Mores", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, counts } = clientFor(opened);
    const ids = new Map<string, Id<"notes">>();
    for (let note = 1; note <= 7; note += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      const id = await client.mutation(api.create, { title: `Note ${note}` });
      ids.set(`Note ${note}`, id);
    }
    const list = listing(client, api.list, 3);
    // Loading at first: no empty list shown before the first window.
    expect(list.view()).toMatchObject({
      items: [],
      isLoading: true,
      hasMore: false,
    });
    await eventually(() => {
      expect(list.titles()).toStrictEqual(["Note 7", "Note 6", "Note 5"]);
    });
    expect(list.view()).toMatchObject({ isLoading: false, hasMore: true });

    // Another tab saves a note and deletes the one at the boundary: the
    // shown window follows, still three long.
    const other = await otherTab(opened);
    await other.mutation(api.create, { title: "Note 8" });
    const six = ids.get("Note 6");
    if (six === undefined) {
      throw new Error("Note 6 was saved");
    }
    await other.mutation(api.remove, { id: six, expectedRevision: 1 });
    await eventually(() => {
      expect(list.titles()).toStrictEqual(["Note 8", "Note 7", "Note 5"]);
    });

    // Three more: the next three in server order, none repeated, none
    // skipped, though the first page moved since it loaded.
    await list.pager.loadMore();
    expect(list.titles()).toStrictEqual([
      "Note 8",
      "Note 7",
      "Note 5",
      "Note 4",
      "Note 3",
      "Note 2",
    ]);

    // A note saved, one deleted inside the loaded window, and one from
    // beyond it moved to the top by an edit: the window stays six long,
    // the exact prefix of the list as it is now.
    await other.mutation(api.create, { title: "Note 9" });
    const four = ids.get("Note 4");
    const one = ids.get("Note 1");
    if (four === undefined || one === undefined) {
      throw new Error("Notes 1 and 4 were saved");
    }
    await other.mutation(api.remove, { id: four, expectedRevision: 1 });
    await other.mutation(api.update, {
      id: one,
      expectedRevision: 1,
      title: "Note 1, edited",
      body: "",
    });
    const now = await allTitles(client, api);
    await eventually(() => {
      expect(list.titles()).toStrictEqual(now.slice(0, 6));
    });
    expect(now.slice(0, 6)).toStrictEqual([
      "Note 1, edited",
      "Note 9",
      "Note 8",
      "Note 7",
      "Note 5",
      "Note 3",
    ]);

    // The rest: the end of the list, with nothing more to load, where a
    // Load More follows nothing more.
    await list.pager.loadMore();
    const followed = counts.follows;
    await list.pager.loadMore();
    expect({
      titles: list.titles(),
      hasMore: list.view().hasMore,
      isLoading: list.view().isLoading,
      unique: new Set(list.notes().map(({ _id }) => _id)).size,
      followedAtTheEnd: counts.follows - followed,
    }).toStrictEqual({
      titles: now,
      hasMore: false,
      isLoading: false,
      unique: now.length,
      followedAtTheEnd: 0,
    });
    list.stop();
  });

  it("reads a window again when a write lands between its pages, and shows it whole", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    await seeded(opened, client);
    const list = listing(client, api.list, 100);
    await eventually(() => {
      expect(list.titles()).toHaveLength(100);
    });
    const shownBefore = list.seen.length;

    // A write lands between the first and second page of the next window
    // read: it retitles every note.
    const restore = await writeBetweenPages(opened, 1);
    try {
      await list.pager.loadMore(60);
    } finally {
      restore();
    }

    // Every window shown since is one state: all retitled, or none.
    const since = list.seen
      .slice(shownBefore)
      .map((snapshot) => z.array(noteSchema).parse(snapshot.view.items))
      .filter((items) => items.length > 0)
      .map((items) => {
        const changed = items.filter(({ title }) =>
          title.startsWith("Changed")
        ).length;
        return {
          count: items.length,
          mixed: changed > 0 && changed < items.length,
        };
      });
    expect({
      titles: list.titles().every((title) => title.startsWith("Changed")),
      count: list.titles().length,
      mixed: since.filter(({ mixed }) => mixed),
    }).toStrictEqual({ titles: true, count: 160, mixed: [] });
    list.stop();
  });

  it("keeps showing a list whose read again finds the person's live-read budget spent between its pages, and updates once it recovers", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    await seeded(opened, client);
    const list = listing(client, api.list, 100);
    await eventually(() => {
      expect(list.titles()).toHaveLength(100);
    });
    await list.pager.loadMore(60);
    const shownBefore = list.seen.length;

    // Twice, a write lands between the window's pages and the person's
    // live reads are all spent: the read again is torn, and its pages
    // past what it paid are refused.
    const spend = async (): Promise<void> => {
      const host = appHost(env, opened.app);
      let take = 200;
      while (take >= 1) {
        // One take after another, halving once one is refused.
        // oxlint-disable-next-line no-await-in-loop -- see above
        if (!(await host.admitLiveRead(opened.builder.userId, take))) {
          take = Math.floor(take / 2);
        }
      }
    };
    const restore = await beforePageReads(
      opened,
      { times: 2, which: "later" },
      async (sql) => {
        sql.exec("UPDATE sdk_tables SET generation = generation + 1");
        await spend();
      }
    );
    try {
      const other = await otherTab(opened);
      await other.mutation(api.create, { title: "Fresh" });
      await eventually(() => {
        expect(list.titles()[0]).toBe("Fresh");
      });
    } finally {
      restore();
    }

    expect({
      failures: list.seen
        .slice(shownBefore)
        .map((snapshot) => snapshot.error?.code)
        .filter((code) => code !== undefined),
      shownThroughout: list.seen
        .slice(shownBefore)
        .every((snapshot) => snapshot.view.items.length === 160),
      count: list.titles().length,
    }).toStrictEqual({ failures: [], shownThroughout: true, count: 160 });
    list.stop();
  });

  it("settles a window writes keep tearing: the Load More fails, the window shown stays, and a first read is refused", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    await seeded(opened, client);
    const list = listing(client, api.list, 100);
    await eventually(() => {
      expect(list.titles()).toHaveLength(100);
    });

    // Every second page read meets a write first.
    const restore = await writeBetweenPages(opened, Number.POSITIVE_INFINITY);
    try {
      const loadMore = await codeOf(list.pager.loadMore(60));
      // A window that showed nothing yet: refused as its last push.
      const follower = pageFollower();
      await opened.screens.watchQuery(
        opened.app,
        opened.lease,
        windowRequest(opened, "notes.list", {}, { extent: 160 }),
        follower.callback
      );
      await eventually(() => {
        expect(follower.state.released).toBeTruthy();
      });
      // Through the function route as well.
      const { call } = pageTransport(opened, opened.screens, { follows: 0 });
      const throughRoute = answerOf(
        await call(
          windowRequest(opened, "notes.list", {}, { extent: 160 }),
          opened.app
        )
      );
      expect({
        loadMore,
        shown: list.titles().length,
        error: list.pager.snapshot.error?.code,
        isLoading: list.view().isLoading,
        firstRead: follower.received.map(({ result }) =>
          result.ok ? "value" : result.error.code
        ),
        routed: throughRoute,
      }).toStrictEqual({
        loadMore: "query.concurrent_change",
        shown: 100,
        error: undefined,
        isLoading: false,
        firstRead: ["query.concurrent_change"],
        routed: "query.concurrent_change",
      });
    } finally {
      restore();
    }
    list.stop();
  });

  it("fails a Load More whose larger window the client still holds, while writes keep tearing its fresh read", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    await seeded(opened, client);
    const list = listing(client, api.list, 100);
    const whole = listing(client, api.list, 80);
    await eventually(() => {
      expect(list.titles()).toHaveLength(100);
      expect(whole.titles()).toHaveLength(80);
    });
    // Another list loaded the larger window before writes began, and
    // closed: the client still holds its notes, followed no more.
    await whole.pager.loadMore(80);
    expect(whole.titles()).toHaveLength(160);
    whole.stop();
    // Core lets go of what it followed for it, as the page released it.
    await scheduler.wait(1000);

    const restore = await writeBetweenPages(opened, Number.POSITIVE_INFINITY);
    try {
      // Never settling would be the failure: given far longer than core
      // takes to refuse a torn window.
      const hung = Promise.withResolvers<string>();
      const timer = setTimeout(() => {
        hung.resolve("hung");
      }, 30_000);
      const loadMore = await Promise.race([
        codeOf(list.pager.loadMore(60)),
        hung.promise,
      ]);
      clearTimeout(timer);
      expect({ loadMore, shown: list.titles().length }).toStrictEqual({
        loadMore: "query.concurrent_change",
        shown: 100,
      });
    } finally {
      restore();
    }
    list.stop();
  });

  it("gives a window's new subscription only a read begun after it, never one already on its way", async () => {
    const opened = await openedApp();
    const { client } = clientFor(opened);
    await seeded(opened, client);
    const request = windowRequest(opened, "notes.list", {}, { extent: 160 });
    // Its first read is held between its pages, long enough for the
    // second subscription to come while it is on its way.
    const restore = await beforePageReads(
      opened,
      { times: 1, which: "later" },
      async () => {
        await scheduler.wait(3000);
      }
    );
    try {
      const first = pageFollower();
      await opened.screens.watchQuery(
        opened.app,
        opened.lease,
        request,
        first.callback
      );
      // The first read is on its way, between its pages.
      await scheduler.wait(1000);
      const second = pageFollower();
      await opened.screens.watchQuery(
        opened.app,
        opened.lease,
        request,
        second.callback
      );
      await eventually(() => {
        expect(second.received.length).toBeGreaterThan(0);
      });
      expect({
        first: first.received[0]?.revision,
        second: second.received[0]?.revision,
      }).toStrictEqual({ first: 1, second: 2 });
    } finally {
      restore();
    }
  });

  it("refuses a window's new subscription when writes keep tearing its first read, the one it joined keeping the window", async () => {
    const opened = await openedApp();
    const { client } = clientFor(opened);
    await seeded(opened, client);
    const request = windowRequest(opened, "notes.list", {}, { extent: 160 });
    const first = pageFollower();
    await opened.screens.watchQuery(
      opened.app,
      opened.lease,
      request,
      first.callback
    );
    await eventually(() => {
      expect(first.received).toHaveLength(1);
    });
    const restore = await writeBetweenPages(opened, Number.POSITIVE_INFINITY);
    try {
      const second = pageFollower();
      await opened.screens.watchQuery(
        opened.app,
        opened.lease,
        request,
        second.callback
      );
      await eventually(() => {
        expect(second.state.released).toBeTruthy();
      });
      expect({
        second: second.received.map(({ result }) =>
          result.ok ? "value" : result.error.code
        ),
        firstKept: first.state.released,
      }).toStrictEqual({
        second: ["query.concurrent_change"],
        firstKept: false,
      });
    } finally {
      restore();
    }
  });

  it("never shows a larger window older than a smaller list's newer push when it loads more", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    // The page's network holds back every push of the first follow of
    // the two-record window, as a slow delivery would.
    const counts = { follows: 0 };
    const page = pageTransport(opened, opened.screens, counts);
    const held = { first: true, pushes: 0 };
    const client = new GraspClient({
      call: page.call,
      watch: async (request, onSnapshot, onLost) => {
        const holding = held.first && windowExtentIn(request) === 2;
        held.first &&= !holding;
        let delivered = 0;
        return await page.watch(
          request,
          (push) => {
            if (holding && delivered >= 1) {
              held.pushes += 1;
              return;
            }
            delivered += 1;
            onSnapshot(push);
          },
          onLost
        );
      },
    });
    for (const title of ["One", "Two"]) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await client.mutation(api.create, { title });
    }
    const two = listing(client, api.list, 2);
    await eventually(() => {
      expect(two.titles()).toStrictEqual(["Two", "One"]);
    });
    const one = listing(client, api.list, 1);
    await eventually(() => {
      expect(one.titles()).toStrictEqual(["Two"]);
    });
    // Saved elsewhere: the list of one shows it; the list of two's push
    // is held back.
    const other = await otherTab(opened);
    await other.mutation(api.create, { title: "Three" });
    await eventually(() => {
      expect(one.titles()).toStrictEqual(["Three"]);
    });

    await one.pager.loadMore(1);

    expect(one.titles()).toStrictEqual(["Three", "Two"]);
    one.stop();
    two.stop();
  });

  it("leaves nothing unhandled when a Load More nobody awaits fails", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    await client.mutation(api.create, { title: "Only" });
    const list = listing(client, api.list, 1);
    await eventually(() => {
      expect(list.titles()).toStrictEqual(["Only"]);
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent): void => {
      unhandled.push(event.reason);
      event.preventDefault();
    };
    globalThis.addEventListener("unhandledrejection", onUnhandled);
    try {
      // A click handler that ignores what it starts.
      void list.pager.loadMore(0);
      await scheduler.wait(100);
    } finally {
      globalThis.removeEventListener("unhandledrejection", onUnhandled);
    }
    expect({
      unhandled: unhandled.length,
      error: list.pager.snapshot.error?.code,
    }).toStrictEqual({ unhandled: 0, error: "contract.invalid_args" });
    list.stop();
  });

  it("starts a list again at its first page, with no failure of before, once its readers left and one comes back", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    for (let note = 1; note <= 4; note += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await client.mutation(api.create, { title: `Note ${note}` });
    }
    const first = listing(client, api.list, 2);
    await eventually(() => {
      expect(first.titles()).toStrictEqual(["Note 4", "Note 3"]);
    });
    await first.pager.loadMore();
    await expect(first.pager.loadMore(0)).rejects.toThrow(Error);
    expect({
      titles: first.titles(),
      error: first.pager.snapshot.error?.code,
    }).toStrictEqual({
      titles: ["Note 4", "Note 3", "Note 2", "Note 1"],
      error: "contract.invalid_args",
    });
    // The screen shows another list, then this one again, well within
    // the time a list is kept for.
    first.stop();
    const other = listing(client, api.list, 3);
    await eventually(() => {
      expect(other.titles()).toHaveLength(3);
    });
    other.stop();
    await scheduler.wait(0);
    const again = listing(client, api.list, 2);
    await eventually(() => {
      expect({
        titles: again.titles(),
        error: again.pager.snapshot.error?.code,
      }).toStrictEqual({ titles: ["Note 4", "Note 3"], error: undefined });
    });
    again.stop();
  });

  it("fills a window from a query that answers short pages, and loads more of it", async () => {
    const opened = await openedApp();
    const { client } = clientFor(opened);
    await seeded(opened, client);
    const listTen = referenceTo<
      { pagination: { cursor?: string | null; pageSize?: number } },
      unknown,
      "query"
    >(opened.release, "notes.listTen");
    const list = listing(client, listTen, 30);
    await eventually(() => {
      expect(list.titles().length).toBeGreaterThan(0);
    });
    const first = list.titles().length;
    await list.pager.loadMore(30);
    expect({
      first,
      more: list.titles().length,
      unique: new Set(list.notes().map(({ _id }) => _id)).size,
      hasMore: list.view().hasMore,
    }).toStrictEqual({ first: 30, more: 60, unique: 60, hasMore: true });
    list.stop();
  });

  it("adds one batch for Load Mores made at once, and refuses a batch it can't ask for before asking", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, counts } = clientFor(opened);
    for (let note = 1; note <= 6; note += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await client.mutation(api.create, { title: `Note ${note}` });
    }
    const list = listing(client, api.list, 2);
    // A Load More before the first window joins its load, adding nothing.
    await list.pager.loadMore();
    expect(list.titles()).toStrictEqual(["Note 6", "Note 5"]);
    const before = counts.follows;

    await Promise.all([
      list.pager.loadMore(),
      list.pager.loadMore(),
      list.pager.loadMore(),
    ]);

    expect({
      titles: list.titles(),
      extent: list.pager.extent,
      follows: counts.follows - before,
    }).toStrictEqual({
      titles: ["Note 6", "Note 5", "Note 4", "Note 3"],
      extent: 4,
      follows: 1,
    });
    // A batch of none: refused before anything is followed, and thrown
    // while rendering, as a failure of the list.
    await expect(codeOf(list.pager.loadMore(0))).resolves.toBe(
      "contract.invalid_args"
    );
    expect({
      follows: counts.follows - before,
      error: list.pager.snapshot.error?.code,
    }).toStrictEqual({ follows: 1, error: "contract.invalid_args" });
    list.stop();
  });

  it("refuses a list of a query that doesn't page, a caller's own pagination, and a first page it can't ask for", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const internals = clientInternals(client);
    const id = await client.mutation(api.create, { title: "Only" });

    expect({
      notPaged: thrownBy(() => internals.pager(api.get, { id }, 5)),
      ownPagination: thrownBy(() =>
        internals.pager(api.list, { pagination: { pageSize: 5 } }, 5)
      ),
      none: thrownBy(() => internals.pager(api.list, {}, 0)),
      tooMany: thrownBy(() => internals.pager(api.list, {}, 101)),
      fine: thrownBy(() => internals.pager(api.list, {}, 100)),
    }).toStrictEqual({
      notPaged: "contract.not_paginated",
      ownPagination: "contract.invalid_args",
      none: "contract.invalid_args",
      tooMany: "contract.invalid_args",
      fine: "ok",
    });
  });
});

describe(
  "paginated windows and cursors core refuses",
  { timeout: 180_000 },
  () => {
    it("refuses a cursor edited, or carried to another person, and a window it can't read", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      const { client } = clientFor(opened);
      for (const title of ["One", "Two", "Three"]) {
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        await client.mutation(api.create, { title });
      }
      const first = await client.query(api.list, {
        pagination: { pageSize: 2 },
      });
      if (!first.hasMore) {
        throw new Error("Three notes take two pages of two");
      }
      const { nextCursor } = first;
      // One character of the cursor's sealed anchor changed.
      const at = nextCursor.indexOf(".") + 2;
      const edited = `${nextCursor.slice(0, at)}${nextCursor[at] === "A" ? "B" : "A"}${nextCursor.slice(at + 1)}`;

      // A member of the App, with their own screen: the builder's cursor
      // isn't theirs to page with.
      const member = await personApi("builder");
      await opened.builder.api.apps.members.add(opened.app, {
        type: "person",
        id: member.userId,
        role: "user",
      });
      const { lease } = await member.api.screens.open(opened.app, "notes");
      await member.api.screens.present(opened.app, lease);
      const theirs = clientFor(
        { ...opened, lease, cookie: member.session, userId: member.userId },
        member.api.screens
      ).client;

      const { call } = pageTransport(opened, opened.screens, { follows: 0 });
      const raw = async (request: string): Promise<unknown> =>
        answerOf(await call(request, opened.app));
      const second = await client.query(api.list, {
        pagination: { pageSize: 2, cursor: nextCursor },
      });
      expect({
        own: second.items.map(({ title }) => title),
        edited: await codeOf(
          client.query(api.list, {
            pagination: { pageSize: 2, cursor: edited },
          })
        ),
        carried: await codeOf(
          theirs.query(api.list, {
            pagination: { pageSize: 2, cursor: nextCursor },
          })
        ),
        // A window's pagination is core's: a caller can't slip a cursor in.
        ownPagination: await raw(
          windowRequest(
            opened,
            "notes.list",
            { pagination: { pageSize: 2, cursor: nextCursor } },
            { extent: 2 }
          )
        ),
        tooLarge: await raw(
          windowRequest(
            opened,
            "notes.list",
            {},
            { extent: liveWindowMaxItems + 1 }
          )
        ),
        notPaged: await raw(
          windowRequest(
            opened,
            "notes.get",
            { id: first.items[0]?._id },
            {
              extent: 2,
            }
          )
        ),
        // Through the function route too, a window is read whole.
        window: z
          .object({
            items: z.array(z.object({ title: z.string() })),
            hasMore: z.boolean(),
          })
          .parse(
            await raw(windowRequest(opened, "notes.list", {}, { extent: 2 }))
          ),
      }).toStrictEqual({
        own: ["One"],
        edited: "data.invalid_cursor",
        carried: "data.invalid_cursor",
        ownPagination: "contract.invalid_args",
        tooLarge: "contract.invalid_request",
        notPaged: "contract.not_paginated",
        window: {
          items: [{ title: "Three" }, { title: "Two" }],
          hasMore: true,
        },
      });
    });

    it("charges the pages a window reads again past what its request paid", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      const { client } = clientFor(opened);
      await seeded(opened, client);
      const { call } = pageTransport(opened, opened.screens, { follows: 0 });
      const ask = async (request: string): Promise<string> => {
        try {
          const answered = answerOf(await call(request, opened.app));
          return typeof answered === "string" ? answered : "ok";
        } catch (error) {
          return error instanceof Error && "code" in error
            ? String(error.code)
            : "failed";
        }
      };
      const one = JSON.stringify({
        reference: {
          resourceId: api.list.resourceId,
          resourceVersion: api.list.resourceVersion,
          contractId: api.list.contractId,
          fingerprint: api.list.fingerprint,
          kind: api.list.kind,
        },
        input: { pagination: { pageSize: 1 } },
      });
      // With the person's requests full and none coming back meanwhile: a
      // window of two pages, paid as two requests, torn once, so read
      // again, two more pages. Then single reads, until refused.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10 * 60_000 });
      const restore = await writeBetweenPages(opened, 1);
      try {
        const window = await ask(
          windowRequest(opened, "notes.list", {}, { extent: 160 })
        );
        let reads = 0;
        while (reads < 20) {
          // oxlint-disable-next-line no-await-in-loop -- one after the other
          if ((await ask(one)) !== "ok") {
            break;
          }
          reads += 1;
        }
        // Twenty at once: two paid up front, two charged as read again.
        expect({ window, reads }).toStrictEqual({ window: "ok", reads: 16 });
      } finally {
        restore();
        vi.useRealTimers();
      }
    });

    it("counts a window as the pages it reads against the person's requests", async () => {
      const opened = await openedApp();
      const { call } = pageTransport(opened, opened.screens, { follows: 0 });
      const ask = async (): Promise<string> => {
        try {
          await call(
            windowRequest(
              opened,
              "notes.list",
              {},
              {
                extent: liveWindowMaxItems,
              }
            ),
            opened.app
          );
          return "ok";
        } catch (error) {
          return error instanceof Error && "code" in error
            ? String(error.code)
            : "failed";
        }
      };
      // A moment later, with the person's requests full and none coming
      // back meanwhile: a window of ten pages counts as ten requests, so
      // two of them spend the twenty a person may make at once.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10 * 60_000 });
      try {
        const answers: string[] = [];
        for (let request = 0; request < 3; request += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one after the other
          answers.push(await ask());
        }
        expect(answers).toStrictEqual(["ok", "ok", "screen.rate_limited"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("counts a window followed through a frame as the pages it reads, and says to wait for all of them", async () => {
      const opened = await openedApp();
      const frame = await opened.screens.frame(opened.app, opened.lease);
      const window = windowRequest(
        opened,
        "notes.list",
        {},
        { extent: liveWindowMaxItems }
      );
      const follow = async (request: string): Promise<unknown> => {
        try {
          const subscription = await frame.watchQuery(
            request,
            pageFollower().callback
          );
          await subscription.release();
          return "ok";
        } catch (error) {
          return refusalOf(error);
        }
      };
      const plain = windowRequest(opened, "notes.list", {
        pagination: { pageSize: 1, cursor: null },
      });
      // With the person's requests full and none coming back meanwhile.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10 * 60_000 });
      try {
        // A window of ten pages, then nine plain follows: one request is
        // left, which the next window's own follow takes, not its pages.
        const first = await follow(window);
        const plains: unknown[] = [];
        for (let request = 0; request < 9; request += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one after the other
          plains.push(await follow(plain));
        }
        const refused = await follow(window);
        expect({
          first,
          plains: plains.every((answer) => answer === "ok"),
          refused,
        }).toStrictEqual({
          first: "ok",
          plains: true,
          refused: {
            code: "screen.rate_limited",
            retryAfterMs: rateLimitedRetryMs * windowPages(liveWindowMaxItems),
          },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("refuses an action sent with a window, under a key or not, before it runs", async () => {
      const opened = await openedApp();
      const { call } = pageTransport(opened, opened.screens, { follows: 0 });
      const reference = referenceTo<unknown, unknown, "action">(
        opened.release,
        "notes.echo"
      );
      const sent = (idempotencyKey?: string) =>
        JSON.stringify({
          reference: {
            resourceId: reference.resourceId,
            resourceVersion: reference.resourceVersion,
            contractId: reference.contractId,
            fingerprint: reference.fingerprint,
            kind: reference.kind,
          },
          input: { word: "ran" },
          window: { extent: 10 },
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        });
      const answers = [
        answerOf(await call(sent(), opened.app)),
        answerOf(await call(sent(crypto.randomUUID()), opened.app)),
      ];
      expect(answers).toStrictEqual([
        "contract.invalid_request",
        "contract.invalid_request",
      ]);
    });

    it("reads a window again when the person's roles change between its pages, rather than refuse its cursor", async () => {
      const opened = await openedApp();
      const member = await personApi("builder");
      await opened.builder.api.apps.members.add(opened.app, {
        type: "person",
        id: member.userId,
        role: "builder",
      });
      const { lease } = await member.api.screens.open(opened.app, "notes");
      await member.api.screens.present(opened.app, lease);
      const theirs = {
        ...opened,
        lease,
        cookie: member.session,
        userId: member.userId,
      };
      const { client } = clientFor(theirs, member.api.screens);
      await seeded(opened, client);
      // Just as the window's first page is read, the member becomes a
      // user: the second page is read under other roles than the cursor
      // the first page sealed.
      const restore = await beforePageReads(
        opened,
        { times: 1, which: "first" },
        async () => {
          await env.DB.prepare(
            "UPDATE app_members SET role = 'user' WHERE app_id = ? AND member_id = ?"
          )
            .bind(opened.app, member.userId)
            .run();
        }
      );
      try {
        const { call } = pageTransport(theirs, member.api.screens, {
          follows: 0,
        });
        const window = z
          .object({ items: z.array(z.unknown()), hasMore: z.boolean() })
          .safeParse(
            answerOf(
              await call(
                windowRequest(opened, "notes.list", {}, { extent: 160 }),
                opened.app
              )
            )
          );
        expect(
          window.success
            ? { items: window.data.items.length, hasMore: window.data.hasMore }
            : window.error.message
        ).toStrictEqual({ items: 160, hasMore: false });
      } finally {
        restore();
      }
    });

    it("clears a list once the person loses access, before anything more reaches it", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      const member = await personApi("builder");
      const them = { type: "person", id: member.userId } as const;
      await opened.builder.api.apps.members.add(opened.app, {
        ...them,
        role: "user",
      });
      const { lease } = await member.api.screens.open(opened.app, "notes");
      await member.api.screens.present(opened.app, lease);
      const theirs = clientFor(
        { ...opened, lease, cookie: member.session, userId: member.userId },
        member.api.screens
      ).client;
      await theirs.mutation(api.create, { title: "Mine" });
      await theirs.mutation(api.create, { title: "Also mine" });
      const list = listing(theirs, api.list, 1);
      await eventually(() => {
        expect(list.titles()).toStrictEqual(["Also mine"]);
      });

      await opened.builder.api.apps.members.remove(opened.app, them);
      const owner = clientFor(opened).client;
      await pastAccessRecheck(async () => {
        await vi.waitFor(
          async () => {
            await owner.mutation(api.create, { title: "Elsewhere" });
            expect(list.pager.snapshot.error).toBeDefined();
          },
          { timeout: 10_000, interval: 250 }
        );
      });

      expect({
        error: list.pager.snapshot.error?.code,
        items: list.view().items,
        loadMore: await codeOf(list.pager.loadMore()),
      }).toStrictEqual({
        error: "app.not_found",
        items: [],
        loadMore: "app.not_found",
      });
    });
  }
);
