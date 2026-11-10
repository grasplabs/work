import type { Id } from "@grasp-os/sdk";
import { GraspError } from "@grasp-os/sdk/client";
import { clientInternals, GraspClient } from "@grasp-os/sdk/host";
import type { ClientTransport } from "@grasp-os/sdk/host";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import {
  appFunctionPath,
  pageLeaseHeader,
  pagePersonHeader,
} from "@grasp-os/shared/pages";
import type { Role } from "@grasp-os/shared/roles";
import { queryMaxScannedEntries } from "@grasp-os/shared/store-limits";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { commitApp, withFiles } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { pastAccessRecheck } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { apiOf, notesFiles, referenceTo } from "./notes-client-app.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { openRpc, routed, signedInApi } from "./sign-in.ts";

// Live paginated lists (spec 10.6, 11.6) through the session client and
// core, as a page's `usePaginatedQuery` reads them: pages of a Notes
// App's list, each a live query ended where the next starts, that stay
// one server-order prefix while notes are inserted, deleted and moved
// between Load Mores and while they are shown; a write that pushes only
// the pages it changed; lists past a thousand records; Load Mores that
// join; a list that starts again once its cursors expire; cursors that
// can't be forged or carried to another person; and a list cleared once
// the person loses access.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/**
 * The Notes App, with what these tests need besides: a mutation that
 * saves many notes in one commit, and one that moves the oldest note to
 * the top of the list (its update time changes).
 */
const files: TestApp = withFiles(notesFiles, {
  "server/notes.ts": `${notesFiles.files["server/notes.ts"] ?? ""}
export const seed = mutation({
  args: {
    prefix: v.string(),
    count: v.number().integer().min(1).max(100),
    body: v.string().max(100_000).default(""),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (let at = 0; at < args.count; at += 1) {
      await ctx.db.insert("notes", {
        title: args.prefix + " " + String(at),
        body: args.body,
      });
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
      await ctx.db.patch("notes", oldest._id, { body: args.stamp });
    }
    return null;
  },
});
`,
});

/**
 * A builder's Notes App, made current and opened: the release, the
 * page's lease, and the builder's session.
 */
const openedApp = async () => {
  const builder = await personApi("builder");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await commitApp(
    builder.api.apps.files,
    id,
    files,
    "First"
  );
  await builder.api.apps.versions.setCurrent(id, version);
  await builder.api.apps.publish(id);
  const { lease } = await builder.api.pages.open(id);
  const release = await loadRelease(env, id, version);
  return {
    app: id,
    lease,
    cookie: builder.session,
    userId: builder.userId,
    release,
    builder,
    pages: builder.api.pages,
  };
};

type Opened = Awaited<ReturnType<typeof openedApp>>;

/**
 * What the page does with what the frame sends (apps/web's
 * page-host.ts): a call posted to core's function route under the
 * page's lease, a refusal rejected with its code; a query followed over
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
  pages: Opened["pages"],
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
    const subscription = await pages
      .frame(app, lease)
      .watchQuery(request, callback);
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
        [pageLeaseHeader]: lease,
        [pagePersonHeader]: userId,
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
const clientFor = (opened: Opened, pages: Opened["pages"] = opened.pages) => {
  const counts = { follows: 0 };
  return {
    client: new GraspClient(pageTransport(opened, pages, counts)),
    counts,
  };
};

/** Another tab of the opened App's builder: its own connection to core. */
const otherTab = async (opened: Opened) => {
  const { core } = await openRpc(opened.cookie);
  const { pages } = core.authenticate();
  return clientFor(opened, pages).client;
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
 * A page's paginated list of `reference`, as `usePaginatedQuery`
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

/** A call of `path` as a page's client sends it, raw, with a window. */
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
    reference: { name: reference.name, kind: "query" },
    args: input,
    window,
  });
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

/** 160 notes, saved by `client`. */
const seeded = async (opened: Opened, client: GraspClient): Promise<void> => {
  const seed = referenceTo<{ prefix: string; count: number }, null, "mutation">(
    opened.release,
    "notes.seed"
  );
  await client.mutation(seed, { prefix: "A", count: 100 });
  await client.mutation(seed, { prefix: "B", count: 60 });
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
    // Loading at first: no empty list shown before the first page.
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
    // first page, the last loaded, follows, still three long.
    const other = await otherTab(opened);
    await other.mutation(api.create, { title: "Note 8" });
    const six = ids.get("Note 6");
    if (six === undefined) {
      throw new Error("Note 6 was saved");
    }
    await other.mutation(api.remove, { id: six });
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

    // A note saved, one deleted inside the loaded pages, and one from
    // beyond them moved to the top by an edit: each page grows or shrinks
    // as records move in and out of it, so the pages stay the exact
    // prefix of the list as it is now, the last one as long as it was.
    await other.mutation(api.create, { title: "Note 9" });
    const four = ids.get("Note 4");
    const one = ids.get("Note 1");
    if (four === undefined || one === undefined) {
      throw new Error("Notes 1 and 4 were saved");
    }
    await other.mutation(api.remove, { id: four });
    await other.mutation(api.update, {
      id: one,
      title: "Note 1, edited",
      body: "",
    });
    const now = await allTitles(client, api);
    await eventually(() => {
      expect(list.titles()).toStrictEqual(now);
    });
    expect(now).toStrictEqual([
      "Note 1, edited",
      "Note 9",
      "Note 8",
      "Note 7",
      "Note 5",
      "Note 3",
      "Note 2",
    ]);

    // The end of the list, with nothing more to load, where a Load More
    // follows nothing more.
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

  it("pushes only the pages a write changed", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const ids: Id<"notes">[] = [];
    for (let note = 1; note <= 6; note += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      ids.push(await client.mutation(api.create, { title: `Note ${note}` }));
    }
    const list = listing(client, api.list, 2);
    await eventually(() => {
      expect(list.titles()).toHaveLength(2);
    });
    await list.pager.loadMore();
    await list.pager.loadMore();
    // Every page shows its own answer, each ended where the next starts.
    await eventually(() => {
      expect(list.pager.pages.map(({ held }) => held)).toStrictEqual([
        undefined,
        undefined,
        undefined,
      ]);
    });
    const shown = () => list.pager.pages.map(({ entry }) => entry.settled);
    const before = shown();
    // Another tab deletes the oldest note, on the last page: core reads
    // every page again, and pushes the one whose records changed.
    const [oldest] = ids;
    if (oldest === undefined) {
      throw new Error("Six notes were saved");
    }
    const other = await otherTab(opened);
    await other.mutation(api.remove, { id: oldest });
    await eventually(() => {
      expect(list.titles()).toStrictEqual([
        "Note 6",
        "Note 5",
        "Note 4",
        "Note 3",
        "Note 2",
      ]);
    });
    // Time for any other push to arrive.
    await scheduler.wait(1000);
    expect(
      shown().map((count, page) => count - (before[page] ?? 0))
    ).toStrictEqual([0, 0, 1]);
    list.stop();
  });

  it("loads a list past a thousand records, page by page", async () => {
    const opened = await openedApp();
    const { client } = clientFor(opened);
    const seed = referenceTo<
      { prefix: string; count: number },
      null,
      "mutation"
    >(opened.release, "notes.seed");
    for (let batch = 0; batch < 11; batch += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await client.mutation(seed, { prefix: `N${batch}`, count: 100 });
    }
    const api = apiOf(opened.release);
    const list = listing(client, api.list, 250);
    await eventually(() => {
      expect(list.titles()).toHaveLength(250);
    });
    while (list.view().hasMore) {
      // oxlint-disable-next-line no-await-in-loop -- one Load More after the other
      await list.pager.loadMore();
    }
    expect({
      shown: list.titles().length,
      unique: new Set(list.notes().map(({ _id }) => _id)).size,
      pages: list.pager.pages.length,
      error: list.pager.snapshot.error,
    }).toStrictEqual({ shown: 1100, unique: 1100, pages: 5, error: undefined });
    list.stop();
  });

  it("starts a list again, as long as it was, once a new version expires its cursors", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    for (let note = 1; note <= 6; note += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await client.mutation(api.create, { title: `Note ${note}` });
    }
    const list = listing(client, api.list, 2);
    await eventually(() => {
      expect(list.titles()).toHaveLength(2);
    });
    await list.pager.loadMore();
    // A new version: every cursor read under the one before expires.
    const { version } = await commitApp(
      opened.builder.api.apps.files,
      opened.app,
      withFiles(files, {
        "server/notes.ts": `${files.files["server/notes.ts"] ?? ""}\n// Second.\n`,
      }),
      "Second"
    );
    await opened.builder.api.apps.versions.setCurrent(opened.app, version);
    await opened.builder.api.apps.publish(opened.app);
    // A write reads every page again, under the new version: the list
    // starts again with one first page as long as it was, showing what it
    // showed meanwhile.
    const other = await otherTab(opened);
    await other.mutation(api.create, { title: "Note 7" });
    await eventually(() => {
      expect({
        titles: list.titles(),
        // Pages of its first size, one after the other, never one long
        // page that could outgrow an answer.
        pages: list.pager.pages.map(({ pageSize, cursor }) => ({
          pageSize,
          first: cursor === null,
        })),
        error: list.pager.snapshot.error,
      }).toStrictEqual({
        titles: ["Note 7", "Note 6", "Note 5", "Note 4"],
        pages: [
          { pageSize: 2, first: true },
          { pageSize: 2, first: false },
        ],
        error: undefined,
      });
    });
    list.stop();
  });

  it("splits a page that grows past twice its size, so a newest-first feed's first page never outgrows an answer", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    for (let note = 1; note <= 3; note += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await client.mutation(api.create, { title: `Note ${note}` });
    }
    const list = listing(client, api.list, 2);
    await eventually(() => {
      expect(list.titles()).toHaveLength(2);
    });
    await list.pager.loadMore();
    // Every new note lands in the first page, which ends where it did.
    const other = await otherTab(opened);
    for (let note = 4; note <= 6; note += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await other.mutation(api.create, { title: `Note ${note}` });
    }
    await eventually(() => {
      expect({
        titles: list.titles(),
        // What each page's own query answers, once all have.
        pages: list.pager.pages.map(({ entry, held }) =>
          held === undefined
            ? z
                .object({ items: z.array(noteSchema) })
                .parse(entry.snapshot.value)
                .items.map(({ title }) => title)
            : "held"
        ),
      }).toStrictEqual({
        titles: ["Note 6", "Note 5", "Note 4", "Note 3", "Note 2", "Note 1"],
        pages: [
          ["Note 6", "Note 5"],
          ["Note 4", "Note 3", "Note 2"],
          ["Note 1"],
        ],
      });
    });
    list.stop();
  });

  it("reads a page too large to answer again at half its size, rather than fail the list for good", async () => {
    const opened = await openedApp();
    const { client } = clientFor(opened);
    const seed = referenceTo<
      { prefix: string; count: number; body: string },
      null,
      "mutation"
    >(opened.release, "notes.seed");
    // Five of these pass what one answer may be; two don't.
    await client.mutation(seed, {
      prefix: "Big",
      count: 5,
      body: "x".repeat(90_000),
    });
    const api = apiOf(opened.release);
    const list = listing(client, api.list, 5);
    await eventually(() => {
      expect({
        shown: list.titles().length,
        error: list.pager.snapshot.error?.code,
        hasMore: list.view().hasMore,
      }).toStrictEqual({ shown: 2, error: undefined, hasMore: true });
    });
    // Its first page, ended now, is past half an answer too: it is split,
    // and settles once both halves answer.
    await list.pager.loadMore(2);
    await eventually(() => {
      expect({
        titles: list.titles().length,
        unique: new Set(list.titles()).size,
        error: list.pager.snapshot.error,
      }).toStrictEqual({ titles: 4, unique: 4, error: undefined });
    });
    list.stop();
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
    // The page shows another list, then this one again, well within
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

  it("follows a query that answers pages shorter than asked, page by page", async () => {
    const opened = await openedApp();
    const { client } = clientFor(opened);
    await seeded(opened, client);
    const listTen = referenceTo<
      {
        pagination: {
          cursor?: string | null;
          endCursor?: string | null;
          pageSize?: number;
        };
      },
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
    }).toStrictEqual({ first: 10, more: 20, unique: 20, hasMore: true });
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
    // A Load More before the first page shows joins its load, adding nothing.
    await list.pager.loadMore();
    expect(list.titles()).toStrictEqual(["Note 6", "Note 5"]);
    const before = counts.follows;

    await Promise.all([
      list.pager.loadMore(),
      list.pager.loadMore(),
      list.pager.loadMore(),
    ]);

    // One Load More: the first page ended where it ends, and a page after.
    expect({
      titles: list.titles(),
      pages: list.pager.pages.length,
      follows: counts.follows - before,
    }).toStrictEqual({
      titles: ["Note 6", "Note 5", "Note 4", "Note 3"],
      pages: 2,
      follows: 2,
    });
    // A batch of none: refused before anything is followed, and thrown
    // while rendering, as a failure of the list.
    await expect(codeOf(list.pager.loadMore(0))).resolves.toBe(
      "contract.invalid_args"
    );
    expect({
      follows: counts.follows - before,
      error: list.pager.snapshot.error?.code,
    }).toStrictEqual({ follows: 2, error: "contract.invalid_args" });
    list.stop();
  });

  it("refuses a caller's own pagination, and a first page it can't ask for", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const internals = clientInternals(client);

    expect({
      ownPagination: thrownBy(() =>
        internals.pager(api.list, { pagination: { pageSize: 5 } }, 5)
      ),
      none: thrownBy(() => internals.pager(api.list, {}, 0)),
      tooMany: thrownBy(() =>
        internals.pager(api.list, {}, queryMaxScannedEntries + 1)
      ),
      fine: thrownBy(() => internals.pager(api.list, {}, 500)),
    }).toStrictEqual({
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
    it("refuses a cursor that isn't one, reads a carried one under its reader's access, and ends a page at its end cursor", async () => {
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
      // The cursor cut short: no longer base64url JSON.
      const edited = nextCursor.slice(0, -3);

      // A member of the App, with their own page: the builder's cursor
      // pages on through the member's own notes (none), never the
      // builder's.
      const member = await personApi("builder");
      await opened.builder.api.apps.members.add(opened.app, {
        type: "person",
        id: member.userId,
        role: "user",
      });
      const { lease } = await member.api.pages.open(opened.app);
      const theirs = clientFor(
        { ...opened, lease, cookie: member.session, userId: member.userId },
        member.api.pages
      ).client;

      const { call } = pageTransport(opened, opened.pages, { follows: 0 });
      const raw = async (request: string): Promise<unknown> =>
        answerOf(await call(request));
      const second = await client.query(api.list, {
        pagination: { pageSize: 2, cursor: nextCursor },
      });
      const carried = await theirs.query(api.list, {
        pagination: { pageSize: 2, cursor: nextCursor },
      });
      const carriedEnd = await theirs.query(api.list, {
        pagination: { pageSize: 2, endCursor: nextCursor },
      });
      expect({
        own: second.items.map(({ title }) => title),
        edited: await codeOf(
          client.query(api.list, {
            pagination: { pageSize: 2, cursor: edited },
          })
        ),
        carried: carried.items,
        // A live list's loaded page: from its start to where the next
        // starts, whatever its size, that end its next cursor.
        ended: await client.query(api.list, {
          pagination: { pageSize: 1, endCursor: nextCursor },
        }),
        // Carried to another person, an end reads only their own records.
        carriedEnd: carriedEnd.items,
        editedEnd: await codeOf(
          client.query(api.list, {
            pagination: { pageSize: 2, endCursor: edited },
          })
        ),
        // A call that still asks for a window is no call core reads.
        windowed: await raw(
          windowRequest(opened, "notes.list", {}, { extent: 2 })
        ),
      }).toStrictEqual({
        own: ["One"],
        edited: "data.invalid_cursor",
        carried: [],
        ended: {
          items: first.items,
          nextCursor,
          hasMore: true,
        },
        carriedEnd: [],
        editedEnd: "data.invalid_cursor",
        windowed: "contract.invalid_request",
      });
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
      const { lease } = await member.api.pages.open(opened.app);
      const theirs = clientFor(
        { ...opened, lease, cookie: member.session, userId: member.userId },
        member.api.pages
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

    it("clears a list whose page splits as the person loses access, showing none of either half", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      const member = await personApi("builder");
      const them = { type: "person", id: member.userId } as const;
      await opened.builder.api.apps.members.add(opened.app, {
        ...them,
        role: "user",
      });
      const { lease } = await member.api.pages.open(opened.app);
      const theirs = clientFor(
        { ...opened, lease, cookie: member.session, userId: member.userId },
        member.api.pages
      ).client;
      await theirs.mutation(api.create, { title: "Mine" });
      await theirs.mutation(api.create, { title: "Also mine" });
      const list = listing(theirs, api.list, 1);
      await eventually(() => {
        expect(list.titles()).toStrictEqual(["Also mine"]);
      });
      await list.pager.loadMore();
      // Their first page grows past twice its size, so it splits, while
      // their access is taken away.
      for (const title of ["Third", "Fourth"]) {
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        await theirs.mutation(api.create, { title });
      }
      // Split: three pages, the first page's two halves in place of it.
      await eventually(() => {
        expect(list.pager.pages).toHaveLength(3);
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
