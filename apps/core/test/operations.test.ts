import {
  AppError,
  app,
  defineSchema,
  defineTable,
  v,
  paginationOptionsValidator,
  paginationResultValidator,
} from "@grasp-os/sdk";
import type { Id } from "@grasp-os/sdk";
import { inspectApp, manifestText } from "@grasp-os/sdk/host";
import { runFunction } from "@grasp-os/sdk/runner";
import type { OperationChannel } from "@grasp-os/sdk/runner";
import { serverModule } from "@grasp-os/sdk/server";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import type { Role } from "@grasp-os/shared/roles";
import { commitMaxWrites } from "@grasp-os/shared/stores";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { operationRoles } from "../src/app-access.ts";
import { createApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { appMembers } from "../src/db/core/schema.ts";
import { callOperation } from "../src/operations.ts";
import type { HostedApp, Invocation, Runner } from "../src/operations.ts";

// An App's server functions run through core's operation host
// (operations.ts) against a real business store and the App's real roles:
// the complete Notes operations of spec 9.4 end to end, then the ways the
// host can be misused, from its threat model. App code runs here as the
// SDK's runner runs it; "malicious" runners stand for App code that talks
// to its channel directly, as code in an isolate could.

/** The public operation output limit of spec 18.1: 256 KiB of UTF-8 JSON. */
const outputLimit = 256 * 1024;

const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
  summary: v.string().max(10_000).nullable().default(null),
};

const schema = defineSchema({
  notes: defineTable(noteFields)
    .index("by_updated", ["_updatedAt"])
    .index("by_title", ["title"]),
});

const { query, mutation, internalQuery, doc } = serverModule(schema);

const list = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(doc("notes")),
  handler: async (ctx, args) =>
    await ctx.db
      .query("notes")
      .withIndex("by_updated")
      .order("desc")
      .paginate(args.pagination),
});

const get = query({
  args: { id: v.id("notes") },
  returns: doc("notes").nullable(),
  handler: async (ctx, args) => await ctx.db.get("notes", args.id),
});

const create = mutation({
  args: { title: noteFields.title, body: noteFields.body },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

const update = mutation({
  args: {
    id: v.id("notes"),
    expectedRevision: v.number().integer().min(1),
    title: noteFields.title,
    body: v.string().max(100_000),
  },
  returns: doc("notes"),
  handler: async (ctx, args) => {
    const previous = await ctx.db.get("notes", args.id, {
      expectedRevision: args.expectedRevision,
    });
    if (!previous) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    await ctx.db.patch(
      "notes",
      args.id,
      { title: args.title, body: args.body },
      { expectedRevision: args.expectedRevision }
    );
    const updated = await ctx.db.get("notes", args.id);
    if (!updated) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    return updated;
  },
});

const remove = mutation({
  args: { id: v.id("notes"), expectedRevision: v.number().integer().min(1) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete("notes", args.id, {
      expectedRevision: args.expectedRevision,
    });
    return null;
  },
});

/** Inserts a note, then reads the table in the same staged state. */
const createAndCount = mutation({
  args: { title: noteFields.title },
  returns: v.number(),
  handler: async (ctx, args) => {
    await ctx.db.insert("notes", { title: args.title });
    const all = await ctx.db.query("notes").collect();
    return all.length;
  },
});

/** Narrowed by `operationAccess` to inserting only. */
const insertOnly = mutation({
  args: { id: v.id("notes"), expectedRevision: v.number().integer().min(1) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete("notes", args.id, {
      expectedRevision: args.expectedRevision,
    });
    return null;
  },
});

/** Narrowed by `operationAccess` to inserting only: it may not read. */
const peek = mutation({
  args: { id: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.get("notes", args.id);
    return null;
  },
});

/**
 * Stages `inserts` notes with bodies of `size` characters, then reads the
 * table `reads` times, for the bounds on what one mutation stages and reads.
 */
/** Reads one more time than an invocation may, catching it, then inserts. */
const readPastThenWrite = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    let refused = 0;
    for (
      let index = 0;
      index <= platformLimits.invocationHostCalls;
      index += 1
    ) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one read after the other
        await ctx.db.query("notes").first();
      } catch {
        refused += 1;
      }
    }
    await ctx.db.insert("notes", { title: "after", body: "" });
    return refused;
  },
});

const stress = mutation({
  args: {
    inserts: v.number().integer().min(0).max(100),
    size: v.number().integer().min(0).max(100_000),
    reads: v.number().integer().min(0).max(1000),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    let id: Id<"notes"> | undefined;
    for (let index = 0; index < args.inserts; index += 1) {
      // One write after the other, as App code stages them.
      // oxlint-disable-next-line no-await-in-loop -- see above
      id = await ctx.db.insert("notes", {
        title: `n${index}`,
        body: "x".repeat(args.size),
      });
    }
    for (let index = 0; index < args.reads; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- see above
      await ctx.db.query("notes").first();
    }
    return id === undefined ? 0 : args.inserts;
  },
});

/** Inserts a note, then reads it asserting the revision a new one has. */
const insertThenGuard = mutation({
  args: { title: noteFields.title },
  returns: v.number(),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("notes", args);
    const note = await ctx.db.get("notes", id, { expectedRevision: 1 });
    return note?._rev ?? 0;
  },
});

/** Returns a string of `size` characters. */
const echo = mutation({
  args: { size: v.number().integer().min(0).max(1_000_000) },
  returns: v.string(),
  handler: (_ctx, args) => "x".repeat(args.size),
});

/** Returns `count` copies of `unit`: one character, of one or more bytes. */
const repeated = query({
  args: {
    unit: v.string().min(1).max(2),
    count: v.number().integer().min(0).max(1_000_000),
  },
  returns: v.string(),
  handler: (_ctx, args) => args.unit.repeat(args.count),
});

/**
 * Patches a note, reads it back (at the revision its staged change shows),
 * and patches it again at that revision: one commit, one revision more.
 */
const editTwice = mutation({
  args: { id: v.id("notes"), expectedRevision: v.number().integer().min(1) },
  returns: v.number(),
  handler: async (ctx, args) => {
    await ctx.db.patch(
      "notes",
      args.id,
      { title: "first" },
      { expectedRevision: args.expectedRevision }
    );
    const staged = await ctx.db.get("notes", args.id);
    await ctx.db.patch(
      "notes",
      args.id,
      { body: "second" },
      { expectedRevision: staged?._rev ?? 0 }
    );
    return staged?._rev ?? 0;
  },
});

/** Takes the first title off its arguments, then inserts a note of it. */
const takeFirst = mutation({
  args: { titles: v.array(noteFields.title).min(1) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const title = args.titles.shift() ?? "";
    await ctx.db.insert("notes", { title });
    await ctx.db.query("notes").first();
    return title;
  },
});

/**
 * Reads note `id` asserting its revision, falling back to inserting
 * another note when the assertion fails.
 */
const guardedOrFallback = mutation({
  args: { id: v.id("notes"), expectedRevision: v.number().integer().min(1) },
  returns: v.string(),
  handler: async (ctx, args) => {
    try {
      await ctx.db.get("notes", args.id, {
        expectedRevision: args.expectedRevision,
      });
    } catch {
      await ctx.db.insert("notes", { title: "fallback" });
      return "fallback";
    }
    await ctx.db.query("notes").first();
    return "guarded";
  },
});

/** Reads the table `reads` times. */
const readTimes = query({
  args: { reads: v.number().integer().min(0).max(1000) },
  returns: v.number(),
  handler: async (ctx, args) => {
    for (let index = 0; index < args.reads; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one read after the other
      await ctx.db.query("notes").first();
    }
    return args.reads;
  },
});

/**
 * Stages an insert its schema refuses without waiting for it, then
 * stages one it accepts.
 */
const floatingBadWrite = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    ctx.db.insert("notes", { title: "  " }).catch(() => null);
    await ctx.db.query("notes").first();
    await ctx.db.insert("notes", { title: "kept" });
    return "done";
  },
});

/** Reads each of `ids` asserting it is at revision 1. */
const assertMany = mutation({
  args: { ids: v.array(v.id("notes")).max(200) },
  returns: v.number(),
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      // oxlint-disable-next-line no-await-in-loop -- one read after the other
      await ctx.db.get("notes", id, { expectedRevision: 1 });
    }
    return args.ids.length;
  },
});

const secret = internalQuery({
  args: {},
  returns: v.string(),
  handler: () => "internal",
});

const notesApp = app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: {
    notes: {
      list,
      get,
      create,
      update,
      remove,
      createAndCount,
      insertOnly,
      peek,
      stress,
      readPastThenWrite,
      insertThenGuard,
      echo,
      repeated,
      editTwice,
      takeFirst,
      guardedOrFallback,
      readTimes,
      floatingBadWrite,
      assertMany,
    },
  },
  internalOperations: { secret },
  operationAccess: {
    "notes.insertOnly": { tables: { notes: { insert: true } } },
    "notes.peek": { tables: { notes: { insert: true } } },
  },
  screens: [],
  uses: [],
});

const { manifest } = inspectApp(notesApp);

/** The Notes App as the host runs it, with `run` in place of its runner. */
const hosted = (run?: Runner): HostedApp => ({
  manifest,
  run:
    run ??
    (async (path, args, channel) =>
      await runFunction(notesApp, path, args, channel)),
});

/** A person of the organization in `role`, as their session has them. */
const person = async (role: Role): Promise<Acting> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return { userId, role, teams: [], staff: false };
};

interface Fixture {
  readonly owner: Acting;
  readonly appId: AppId;
  readonly store: OpenStore;
}

/** A Notes App of a builder's, with its store holding the Notes schema. */
const notes = async (): Promise<Fixture> => {
  const owner = await person("builder");
  const { id: appId } = await createApp(env, owner, { name: "Notes" });
  const store = await openStore(env, await createStore(env, owner));
  await store.defineTables(manifestText(manifest.schema));
  return { owner, appId, store };
};

/** Shares the fixture's App with `by`, as a user of its screens. */
const share = async ({ appId, owner }: Fixture, by: Acting) => {
  await drizzle(env.DB).insert(appMembers).values({
    appId,
    memberType: "person",
    memberId: by.userId,
    role: "user",
    addedBy: owner.userId,
    addedAt: new Date(),
  });
};

/** Stops sharing the fixture's App with `by`. */
const unshare = async ({ appId }: Fixture, by: Acting) => {
  await drizzle(env.DB)
    .delete(appMembers)
    .where(
      and(eq(appMembers.appId, appId), eq(appMembers.memberId, by.userId))
    );
};

/** An invocation for `by` through the fixture's App at `version`. */
const invocationOf = (
  { appId, store }: Fixture,
  by: Acting,
  version = 1
): Invocation => ({
  principal: by.userId,
  consumer: { resourceId: appId, resourceVersion: version },
  store,
  requestId: crypto.randomUUID(),
  deadline: Date.now() + 60_000,
  runId: null,
  authorize: async () => await operationRoles(env, by, appId),
});

/** Calls `path` of kind `kind` for `by`. */
const call = async (
  fixture: Fixture,
  by: Acting,
  kind: string,
  path: string,
  args: unknown,
  more: { run?: Runner; idempotencyKey?: string; version?: number } = {}
): Promise<OperationResult> =>
  await callOperation(
    hosted(more.run),
    invocationOf(fixture, by, more.version),
    { path, kind },
    args,
    more.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: more.idempotencyKey }
  );

/** The value of a call that succeeded; fails the test otherwise. */
const valueOf = (result: OperationResult): Json => {
  if (!result.ok) {
    throw new Error(`The call failed: ${result.error.code}`);
  }
  return result.value;
};

/** The error code of a call that failed, or "ok". */
const codeOf = (result: OperationResult): string =>
  result.ok ? "ok" : result.error.code;

/** A note's ID, as callers pass one. */
const idOf = (value: Json): Id<"notes"> => {
  if (typeof value !== "string") {
    throw new TypeError("Not an ID");
  }
  // SAFETY: a value the host answered for `v.id("notes")`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return value as Id<"notes">;
};

/** A JSON object: `Array.isArray` doesn't narrow a readonly array type. */
const isObject = (
  value: Json | undefined
): value is Readonly<Record<string, Json | undefined>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A field of a JSON object. */
const fieldOf = (value: Json | undefined, key: string): Json | undefined =>
  isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;

/** The IDs of a page's notes, in order. */
const idsOf = (page: Json): (Json | undefined)[] => {
  const items = fieldOf(page, "items");
  const notesOf: readonly Json[] =
    typeof items === "object" && items !== null && !isObject(items)
      ? items
      : [];
  return notesOf.map((item) => fieldOf(item, "_id"));
};

/**
 * A failed call's error without its request ID, which must be there: a
 * new one each call, so what else it says can be compared whole.
 */
const failureOf = (result: OperationResult) => {
  if (result.ok) {
    throw new Error("The call succeeded");
  }
  const { requestId, ...rest } = result.error;
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
  return rest;
};

/** A runner that does `misuse` with its channel, then answers null. */
const misusing = (
  misuse: (channel: OperationChannel) => Promise<unknown>
): Runner => {
  const run: Runner = async (_path, _args, channel) => {
    await misuse(channel);
    return null;
  };
  return run;
};

/** An object whose `_id` getter throws an error with `code`. */
const getter = (code: string, message: string) =>
  Object.defineProperty({}, "_id", {
    enumerable: true,
    get: () => {
      throw Object.assign(new Error(message), { code });
    },
  });
/** A runner whose App code answers `value`. */
const returning = (value: unknown): Runner => {
  const run: Runner = async () => await Promise.resolve(value);
  return run;
};

/** A runner whose read request's `table` getter throws a platform error. */
const smuggled: Runner = async (_path, _args, channel) =>
  await channel.read(
    // SAFETY: deliberately a request whose field is a throwing getter.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    Object.defineProperty({ kind: "get" }, "table", {
      enumerable: true,
      get: () => {
        throw Object.assign(new Error("Denied"), {
          code: "data.access_denied",
        });
      },
    }) as never
  );

/** A runner whose App code throws an AppError in the connections' namespace. */
const platformAppError: Runner = async () =>
  await Promise.reject(
    Object.assign(new Error("Connect the mailbox first."), {
      name: "AppError",
      code: "connection.not_offered",
    })
  );

describe("the Notes operations", () => {
  it("create, get, list, update and delete a note through the host", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    // The caller leaves out `body`: its default fills it; the store's
    // `summary` default fills the rest.
    const id = idOf(
      valueOf(
        await call(fixture, owner, "mutation", "notes.create", {
          title: "  Launch  ",
        })
      )
    );
    const created = valueOf(
      await call(fixture, owner, "query", "notes.get", { id })
    );
    expect(created).toMatchObject({
      _id: id,
      _ownerId: owner.userId,
      _rev: 1,
      title: "Launch",
      body: "",
      summary: null,
    });

    const updated = valueOf(
      await call(fixture, owner, "mutation", "notes.update", {
        id,
        expectedRevision: 1,
        title: "Launch day",
        body: "Agenda",
      })
    );
    // What the mutation returned is exactly what committed.
    const read = valueOf(
      await call(fixture, owner, "query", "notes.get", { id })
    );
    expect(updated).toStrictEqual(read);
    expect(read).toMatchObject({
      _rev: 2,
      title: "Launch day",
      body: "Agenda",
    });

    const second = idOf(
      valueOf(
        await call(fixture, owner, "mutation", "notes.create", {
          title: "Retro",
        })
      )
    );
    const page = valueOf(
      await call(fixture, owner, "query", "notes.list", {
        pagination: { pageSize: 1 },
      })
    );
    expect(fieldOf(page, "hasMore")).toBeTruthy();
    const cursor = fieldOf(page, "nextCursor");
    const rest = valueOf(
      await call(fixture, owner, "query", "notes.list", {
        pagination: { pageSize: 1, cursor },
      })
    );
    const removed = valueOf(
      await call(fixture, owner, "mutation", "notes.remove", {
        id,
        expectedRevision: 2,
      })
    );
    expect({
      listed: [...idsOf(page), ...idsOf(rest)],
      removed,
      afterwards: valueOf(
        await call(fixture, owner, "query", "notes.get", { id })
      ),
    }).toStrictEqual({ listed: [second, id], removed: null, afterwards: null });
  });

  it("refuses a stale edit, and a missing note, as domain failures that change nothing", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const id = idOf(
      valueOf(
        await call(fixture, owner, "mutation", "notes.create", {
          title: "Draft",
        })
      )
    );
    const stale = await call(fixture, owner, "mutation", "notes.update", {
      id,
      expectedRevision: 3,
      title: "X",
      body: "",
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "data.conflict", category: "domain", retryable: false },
    });
    await call(fixture, owner, "mutation", "notes.remove", {
      id,
      expectedRevision: 1,
    });
    const missing = await call(fixture, owner, "mutation", "notes.update", {
      id,
      expectedRevision: 1,
      title: "X",
      body: "",
    });
    expect(failureOf(missing)).toStrictEqual({
      code: "note.not_found",
      message: "The note is unavailable.",
      category: "domain",
      retryable: false,
    });
  });

  it("answers a retried submission its outcome, and refuses its key for other input", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const first = await call(
      fixture,
      owner,
      "mutation",
      "notes.create",
      { title: "Once" },
      { idempotencyKey: "k1" }
    );
    const retry = await call(
      fixture,
      owner,
      "mutation",
      "notes.create",
      { title: "Once" },
      { idempotencyKey: "k1" }
    );
    expect(retry).toStrictEqual(first);
    const other = await call(
      fixture,
      owner,
      "mutation",
      "notes.create",
      { title: "Twice" },
      { idempotencyKey: "k1" }
    );
    expect(codeOf(other)).toBe("submission.key_conflict");
    const page = valueOf(
      await call(fixture, owner, "query", "notes.list", { pagination: {} })
    );
    expect(fieldOf(page, "items")).toHaveLength(1);
  });

  it("lets a mutation read what it staged, as its commit will make it", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    await call(fixture, owner, "mutation", "notes.create", { title: "One" });
    expect(
      valueOf(
        await call(fixture, owner, "mutation", "notes.createAndCount", {
          title: "Two",
        })
      )
    ).toBe(2);
    // A staged read keeps nothing: the store holds what committed only.
    const page = valueOf(
      await call(fixture, owner, "query", "notes.list", { pagination: {} })
    );
    expect(fieldOf(page, "items")).toHaveLength(2);
  });
});

describe("a mutation's commit", () => {
  it("stamps the records it changes with the time it staged them, as its staged reads saw", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const id = idOf(
      valueOf(
        await call(fixture, owner, "mutation", "notes.create", { title: "a" })
      )
    );
    // Time passes between the handler's staged read and the commit.
    const run: Runner = async (path, args, channel) => {
      const answer = await runFunction(notesApp, path, args, channel);
      await scheduler.wait(20);
      return answer;
    };
    const returned = valueOf(
      await call(
        fixture,
        owner,
        "mutation",
        "notes.update",
        { id, expectedRevision: 1, title: "b", body: "" },
        { run }
      )
    );
    expect(returned).toStrictEqual(
      valueOf(await call(fixture, owner, "query", "notes.get", { id }))
    );
  });

  it("runs the mutation again when a commit made its reads stale", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    let runs = 0;
    // Another caller commits after the first run read the table.
    const run: Runner = async (path, args, channel) => {
      runs += 1;
      const answer = await runFunction(notesApp, path, args, channel);
      if (runs === 1) {
        await call(fixture, owner, "mutation", "notes.create", {
          title: "Meanwhile",
        });
      }
      return answer;
    };
    const counted = valueOf(
      await call(
        fixture,
        owner,
        "mutation",
        "notes.createAndCount",
        { title: "Mine" },
        { run }
      )
    );
    const page = valueOf(
      await call(fixture, owner, "query", "notes.list", { pagination: {} })
    );
    expect({ runs, counted, stored: idsOf(page).length }).toStrictEqual({
      runs: 2,
      counted: 2,
      stored: 2,
    });
  });
});

describe("who a call is for", () => {
  it("is the App's roles, read from the App: an outsider is refused, a member sees their own notes only", async () => {
    const fixture = await notes();
    const outsider = await person("user");
    const member = await person("user");
    await share(fixture, member);
    await call(fixture, fixture.owner, "mutation", "notes.create", {
      title: "Owner's",
    });
    await expect(
      call(fixture, outsider, "query", "notes.list", { pagination: {} })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "app.not_found", category: "authorization" },
    });
    const own = valueOf(
      await call(fixture, member, "mutation", "notes.create", {
        title: "Member's",
      })
    );
    const page = valueOf(
      await call(fixture, member, "query", "notes.list", { pagination: {} })
    );
    expect(idsOf(page)).toStrictEqual([own]);
  });

  it("is authorized again just before a mutation commits", async () => {
    const fixture = await notes();
    const member = await person("user");
    await share(fixture, member);
    // The member loses the App while their mutation runs.
    const run: Runner = async (path, args, channel) => {
      const answer = await runFunction(notesApp, path, args, channel);
      await unshare(fixture, member);
      return answer;
    };
    const result = await call(
      fixture,
      member,
      "mutation",
      "notes.create",
      { title: "Late" },
      { run }
    );
    expect(codeOf(result)).toBe("app.not_found");
    const page = valueOf(
      await call(fixture, fixture.owner, "query", "notes.list", {
        pagination: {},
      })
    );
    expect(fieldOf(page, "items")).toStrictEqual([]);
  });

  it("can't be named by App code: a read carrying a scope is refused", async () => {
    const fixture = await notes();
    const victim = await person("user");
    await share(fixture, victim);
    await call(fixture, victim, "mutation", "notes.create", {
      title: "Private",
    });
    const run: Runner = async (_path, _args, channel) => {
      // Deliberately ill-typed, as a hostile App would call it.
      const read = async (request: unknown): Promise<unknown> =>
        await Reflect.apply(channel.read, channel, [request]);
      return await read({
        kind: "query",
        query: {
          descriptorVersion: 1,
          table: "notes",
          index: null,
          range: [],
          filter: null,
          order: "asc",
          terminal: { kind: "collect" },
        },
        // What a hostile App would try: another person, and builder rights.
        scope: { principal: victim.userId, appBuilder: true },
      });
    };
    await expect(
      call(
        fixture,
        fixture.owner,
        "query",
        "notes.get",
        { id: "0190a0a0-0000-7000-8000-000000000000" },
        { run }
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "data.invalid_query" },
    });
  });
});

describe("paths", () => {
  it("refuse an internal or unknown path alike, and a call of the wrong kind", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    expect({
      internal: codeOf(await call(fixture, owner, "query", "secret", {})),
      unknown: codeOf(await call(fixture, owner, "query", "notes.missing", {})),
      kind: codeOf(
        await call(fixture, owner, "mutation", "notes.get", { id: "x" })
      ),
    }).toStrictEqual({
      internal: "operation.not_found",
      unknown: "operation.not_found",
      kind: "operation.kind_mismatch",
    });
  });
});

describe("contracts", () => {
  it("refuse input past 128 KiB before validating it, and input that doesn't fit", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    expect({
      large: codeOf(
        await call(fixture, owner, "mutation", "notes.create", {
          title: "a",
          body: "x".repeat(128 * 1024),
        })
      ),
      extraKey: codeOf(
        await call(fixture, owner, "mutation", "notes.create", {
          title: "a",
          _ownerId: "u",
        })
      ),
      empty: codeOf(
        await call(fixture, owner, "mutation", "notes.create", { title: "  " })
      ),
    }).toStrictEqual({
      large: "contract.input_too_large",
      extraKey: "contract.invalid_args",
      empty: "contract.invalid_args",
    });
  });

  it("refuse a return the contract doesn't allow, and commit nothing", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const run: Runner = async (path, args, channel) => {
      await runFunction(notesApp, path, args, channel);
      return "not-an-id";
    };
    expect(
      codeOf(
        await call(
          fixture,
          owner,
          "mutation",
          "notes.create",
          { title: "a" },
          { run }
        )
      )
    ).toBe("contract.invalid_return");
    const page = valueOf(
      await call(fixture, owner, "query", "notes.list", { pagination: {} })
    );
    expect(fieldOf(page, "items")).toStrictEqual([]);
  });

  it("refuse a return that is valid only once normalized, rather than repair it", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const id = idOf(
      valueOf(
        await call(fixture, owner, "mutation", "notes.create", { title: "a" })
      )
    );
    // The note as stored, with a title the contract would trim.
    const run: Runner = async (path, args, channel) => {
      const note = await runFunction(notesApp, path, args, channel);
      return typeof note === "object" && note !== null
        ? { ...note, title: " a " }
        : note;
    };
    expect(
      codeOf(await call(fixture, owner, "query", "notes.get", { id }, { run }))
    ).toBe("contract.invalid_return");
  });

  it("narrow a function to its `operationAccess` at run time", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const id = idOf(
      valueOf(
        await call(fixture, owner, "mutation", "notes.create", {
          title: "Keep",
        })
      )
    );
    await expect(
      call(fixture, owner, "mutation", "notes.insertOnly", {
        id,
        expectedRevision: 1,
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "data.write_denied", category: "authorization" },
    });
  });

  it("keep a function from reading a table its `operationAccess` leaves out", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const id = idOf(
      valueOf(
        await call(fixture, owner, "mutation", "notes.create", {
          title: "Keep",
        })
      )
    );
    expect(
      failureOf(await call(fixture, owner, "mutation", "notes.peek", { id }))
    ).toMatchObject({ code: "data.access_denied", category: "authorization" });
  });

  it("answer an expired cursor once the App's version moved on, so the list restarts", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    await call(fixture, owner, "mutation", "notes.create", { title: "a" });
    await call(fixture, owner, "mutation", "notes.create", { title: "b" });
    const page = valueOf(
      await call(fixture, owner, "query", "notes.list", {
        pagination: { pageSize: 1 },
      })
    );
    const cursor = fieldOf(page, "nextCursor");
    expect(
      codeOf(
        await call(
          fixture,
          owner,
          "query",
          "notes.list",
          { pagination: { pageSize: 1, cursor } },
          { version: 2 }
        )
      )
    ).toBe("data.cursor_expired");
  });
});

describe("a mutation's own staged state", () => {
  it("lets a later write assert the revision an earlier one's staged read showed", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const id = idOf(
      valueOf(
        await call(fixture, owner, "mutation", "notes.create", { title: "t" })
      )
    );
    const shown = valueOf(
      await call(fixture, owner, "mutation", "notes.editTwice", {
        id,
        expectedRevision: 1,
      })
    );
    expect({
      shown,
      stored: valueOf(await call(fixture, owner, "query", "notes.get", { id })),
    }).toMatchObject({
      shown: 2,
      stored: { _rev: 2, title: "first", body: "second" },
    });
  });

  it("gives every run its arguments as admitted, whatever an earlier run did to them", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    let runs = 0;
    // Another caller commits after the first run read the table: it runs
    // again, and must take the first title again.
    const run: Runner = async (path, args, channel) => {
      runs += 1;
      const answer = await runFunction(notesApp, path, args, channel);
      if (runs === 1) {
        await call(fixture, owner, "mutation", "notes.create", {
          title: "meanwhile",
        });
      }
      return answer;
    };
    const taken = valueOf(
      await call(
        fixture,
        owner,
        "mutation",
        "notes.takeFirst",
        { titles: ["first", "second"] },
        { run }
      )
    );
    const page = valueOf(
      await call(fixture, owner, "query", "notes.list", { pagination: {} })
    );
    const items = fieldOf(page, "items");
    const titles =
      typeof items === "object" && items !== null && !isObject(items)
        ? items.map((item) => fieldOf(item, "title"))
        : [];
    expect({
      runs,
      taken,
      titles: titles.map(String).toSorted((a, b) => a.localeCompare(b)),
    }).toStrictEqual({
      runs: 2,
      taken: "first",
      titles: ["first", "meanwhile"],
    });
  });

  it("refuses a stale guard at once, never running again to a fallback", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const id = idOf(
      valueOf(
        await call(fixture, owner, "mutation", "notes.create", { title: "t" })
      )
    );
    let runs = 0;
    // Another caller changes the guarded record after the first run read it.
    const run: Runner = async (path, args, channel) => {
      runs += 1;
      const answer = await runFunction(notesApp, path, args, channel);
      if (runs === 1) {
        await call(fixture, owner, "mutation", "notes.update", {
          id,
          expectedRevision: 1,
          title: "changed",
          body: "",
        });
      }
      return answer;
    };
    const result = await call(
      fixture,
      owner,
      "mutation",
      "notes.guardedOrFallback",
      { id, expectedRevision: 1 },
      { run }
    );
    const page = valueOf(
      await call(fixture, owner, "query", "notes.list", { pagination: {} })
    );
    expect({
      code: codeOf(result),
      runs,
      stored: idsOf(page).length,
    }).toStrictEqual({
      code: "data.conflict",
      runs: 1,
      stored: 1,
    });
  });
});

describe("audit follow-ups", () => {
  it("gives every run of a call its own reads, so reruns under contention still answer", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    let runs = 0;
    // Another caller commits during each of the first two runs.
    const run: Runner = async (path, args, channel) => {
      if (path === "notes.readTimes") {
        runs += 1;
      }
      const answer = await runFunction(notesApp, path, args, channel);
      if (path === "notes.readTimes" && runs < 3) {
        await call(fixture, owner, "mutation", "notes.create", {
          title: `c${runs}`,
        });
      }
      return answer;
    };
    expect({
      answer: valueOf(
        await call(
          fixture,
          owner,
          "query",
          "notes.readTimes",
          { reads: 100 },
          { run }
        )
      ),
      runs,
    }).toStrictEqual({ answer: 100, runs: 3 });
  });

  it("gives every attempt of a mutation its own staged-bytes budget", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    let runs = 0;
    const run: Runner = async (path, args, channel) => {
      if (path === "notes.stress") {
        runs += 1;
      }
      const answer = await runFunction(notesApp, path, args, channel);
      if (path === "notes.stress" && runs === 1) {
        await call(fixture, owner, "mutation", "notes.create", {
          title: "meanwhile",
        });
      }
      return answer;
    };
    expect({
      answer: codeOf(
        await call(
          fixture,
          owner,
          "mutation",
          "notes.stress",
          { inserts: 6, size: 100_000, reads: 20 },
          { run }
        )
      ),
      runs,
    }).toStrictEqual({ answer: "ok", runs: 2 });
  });

  it("fails a mutation whose staged write was refused, awaited or not", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const result = await call(
      fixture,
      owner,
      "mutation",
      "notes.floatingBadWrite",
      {}
    );
    const page = valueOf(
      await call(fixture, owner, "query", "notes.list", { pagination: {} })
    );
    expect({ code: codeOf(result), stored: idsOf(page).length }).toStrictEqual({
      code: "data.invalid",
      stored: 0,
    });
  });

  // The guard limit itself is held at the read (store-reader.test.ts): a
  // mutation's host calls end before a commit's guards would.
  it("lets a mutation assert as many revisions as a commit holds, and its host calls end there", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const ids = await Promise.all(
      Array.from({ length: 101 }, async (_, index) =>
        valueOf(
          await call(fixture, owner, "mutation", "notes.create", {
            title: `n${index}`,
          })
        )
      )
    );
    expect({
      within: codeOf(
        await call(fixture, owner, "mutation", "notes.assertMany", {
          ids: ids.slice(0, 100),
        })
      ),
      past: codeOf(
        await call(fixture, owner, "mutation", "notes.assertMany", { ids })
      ),
    }).toStrictEqual({ within: "ok", past: "operation.call_limit" });
  });
});

describe("bounds on one mutation", () => {
  it("refuses the staged write that takes a mutation past what its commit holds", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const staged = async (inserts: number) =>
      await call(fixture, owner, "mutation", "notes.stress", {
        inserts,
        size: 100_000,
        reads: 0,
      });
    expect({
      within: codeOf(await staged(6)),
      past: failureOf(await staged(8)),
    }).toStrictEqual({
      within: "ok",
      past: {
        code: "mutation.too_large",
        message:
          "This change stages more than one commit can hold, with what it returns.",
        category: "contract",
        retryable: false,
        details: { maxStagedBytes: 720_896 },
      },
    });
  });

  it("caps the host calls of one invocation, counting each read, and the staged bytes reads send the store", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const run = async (inserts: number, reads: number) =>
      codeOf(
        await call(fixture, owner, "mutation", "notes.stress", {
          inserts,
          size: inserts === 0 ? 0 : 100_000,
          reads,
        })
      );
    // A read is one host call of its invocation: one past them is refused.
    // Staged writes aren't: a commit's worth of them fits beside reads.
    expect({
      manyReads: await run(0, platformLimits.invocationHostCalls + 1),
      allowedReads: await run(0, platformLimits.invocationHostCalls),
      wholeCommit: codeOf(
        await call(fixture, owner, "mutation", "notes.stress", {
          inserts: commitMaxWrites,
          size: 1,
          reads: 1,
        })
      ),
      heavyReads: await run(6, 40),
      // The refused read caught, its write still stages and commits.
      writeAfter: valueOf(
        await call(fixture, owner, "mutation", "notes.readPastThenWrite", {})
      ),
    }).toStrictEqual({
      writeAfter: 1,
      manyReads: "operation.call_limit",
      allowedReads: "ok",
      wholeCommit: "ok",
      heavyReads: "operation.read_limit",
    });
  });

  it("holds what a query returns to the public operation output limit, in UTF-8 bytes", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    // A string's JSON is its characters and two quotes; "é" is two bytes
    // of UTF-8 but one character, so a count of characters would let
    // nearly twice the limit through.
    const returned = async (unit: string, count: number) =>
      codeOf(
        await call(fixture, owner, "query", "notes.repeated", { unit, count })
      );
    expect({
      atLimit: await returned("x", outputLimit - 2),
      pastLimit: await returned("x", outputLimit - 1),
      wideAtLimit: await returned("é", (outputLimit - 2) / 2),
      widePastLimit: await returned("é", (outputLimit - 2) / 2 + 1),
    }).toStrictEqual({
      atLimit: "ok",
      pastLimit: "contract.result_too_large",
      wideAtLimit: "ok",
      widePastLimit: "contract.result_too_large",
    });
  });

  it("holds what a mutation returns to the same limit, before committing anything", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    expect({
      large: failureOf(
        await call(fixture, owner, "mutation", "notes.echo", {
          size: outputLimit - 1,
        })
      ),
      fits: codeOf(
        await call(fixture, owner, "mutation", "notes.echo", {
          size: outputLimit - 2,
        })
      ),
    }).toStrictEqual({
      large: {
        code: "contract.result_too_large",
        message: "The operation returned more than an operation may return.",
        category: "contract",
        retryable: false,
        details: { maxBytes: 262_144 },
      },
      fits: "ok",
    });
  });

  it("reads back a record it inserted with the revision a new record has", async () => {
    const fixture = await notes();
    expect(
      valueOf(
        await call(
          fixture,
          fixture.owner,
          "mutation",
          "notes.insertThenGuard",
          {
            title: "New",
          }
        )
      )
    ).toBe(1);
  });

  it("answers a retry across an App upgrade that kept the contract with the original outcome", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const createAt = async (version: number) =>
      await call(
        fixture,
        owner,
        "mutation",
        "notes.create",
        { title: "Once" },
        { idempotencyKey: "upgrade", version }
      );
    const before = await createAt(1);
    const after = await createAt(2);
    const page = valueOf(
      await call(fixture, owner, "query", "notes.list", { pagination: {} })
    );
    expect({ same: after, stored: idsOf(page).length }).toStrictEqual({
      same: before,
      stored: 1,
    });
  });
});

describe("App code misusing its channel", () => {
  it("can't write from a query, nor reach a resource from a mutation", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const insert = {
      kind: "insert",
      table: "notes",
      fields: { title: "Smuggled" },
    } as const;
    const fromQuery = await call(
      fixture,
      owner,
      "query",
      "notes.get",
      { id: "0190a0a0-0000-7000-8000-000000000000" },
      { run: misusing(async (channel) => await channel.write(insert)) }
    );
    const fromMutation = await call(
      fixture,
      owner,
      "mutation",
      "notes.remove",
      { id: "0190a0a0-0000-7000-8000-000000000000", expectedRevision: 1 },
      {
        run: misusing(
          async (channel) =>
            await channel.resource("mail", "call", ["send", {}])
        ),
      }
    );
    expect([codeOf(fromQuery), codeOf(fromMutation)]).toStrictEqual([
      "operation.read_only",
      "operation.no_resources",
    ]);
    const page = valueOf(
      await call(fixture, owner, "query", "notes.list", { pagination: {} })
    );
    expect(fieldOf(page, "items")).toStrictEqual([]);
  });

  it("can't use a channel after its call ended", async () => {
    const fixture = await notes();
    let kept: OperationChannel | undefined;
    await call(
      fixture,
      fixture.owner,
      "query",
      "notes.list",
      { pagination: {} },
      {
        run: async (path, args, channel) => {
          kept = channel;
          return await runFunction(notesApp, path, args, channel);
        },
      }
    );
    await expect(
      kept?.write({ kind: "insert", table: "notes", fields: { title: "Late" } })
    ).rejects.toMatchObject({ code: "operation.ended" });
  });

  it("can't pass a platform error off as the host's, nor leak a cause", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const thrown = async (failure: Error) => {
      const run: Runner = async () => await Promise.reject(failure);
      return await call(
        fixture,
        owner,
        "query",
        "notes.get",
        { id: "0190a0a0-0000-7000-8000-000000000000" },
        { run }
      );
    };
    const forged = await thrown(
      Object.assign(new Error("The record changed"), { code: "data.conflict" })
    );
    const sql = await thrown(
      new Error("SQLITE_ERROR: no such column: secret_token near SELECT")
    );
    const disguised = await thrown(
      Object.assign(new Error("No"), {
        name: "AppError",
        code: "auth.unauthenticated",
      })
    );
    expect([forged, sql, disguised].map(failureOf)).toStrictEqual(
      Array.from({ length: 3 }, () => ({
        code: "internal.unexpected",
        message: "Something went wrong.",
        category: "operational",
        retryable: false,
      }))
    );
  });

  it("keeps a platform error the host itself raised to it", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    // App code rethrows the store's refusal: it is the store's, so it stands.
    const result = await call(
      fixture,
      owner,
      "mutation",
      "notes.remove",
      { id: "0190a0a0-0000-7000-8000-000000000000", expectedRevision: 1 },
      {
        run: async (_path, _args, channel) =>
          await channel.read({
            kind: "get",
            table: "missing",
            id: "x",
            expectedRevision: null,
          }),
      }
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "data.unknown_table", category: "contract" },
    });
  });

  it("can't pass an error its getters throw off as the host's", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const named = Object.defineProperty(new Error("x"), "name", {
      get: () => {
        throw Object.assign(new Error("The record changed"), {
          code: "data.conflict",
        });
      },
    });
    const throwing: Runner = async () => await Promise.reject(named);
    const getNote = async (run: Runner) =>
      failureOf(
        await call(
          fixture,
          owner,
          "query",
          "notes.get",
          { id: "0190a0a0-0000-7000-8000-000000000000" },
          { run }
        )
      );
    const unexpected = {
      code: "internal.unexpected",
      message: "Something went wrong.",
      category: "operational",
      retryable: false,
    };
    expect({
      returnGetter: await getNote(
        returning(
          getter(
            "auth.unauthenticated",
            "Session expired: sign in at evil.example"
          )
        )
      ),
      nameGetter: await getNote(throwing),
      requestGetter: await getNote(smuggled),
    }).toStrictEqual({
      returnGetter: unexpected,
      nameGetter: unexpected,
      requestGetter: {
        code: "contract.invalid_request",
        message:
          "The operation's code sent the host something that isn't JSON.",
        category: "contract",
        retryable: false,
      },
    });
  });

  it("can't throw an AppError in any platform namespace", async () => {
    const fixture = await notes();
    expect(
      failureOf(
        await call(
          fixture,
          fixture.owner,
          "query",
          "notes.get",
          { id: "0190a0a0-0000-7000-8000-000000000000" },
          { run: platformAppError }
        )
      ).code
    ).toBe("internal.unexpected");
  });

  it("can't rewrite an error the host raised to it, now or after it rethrew it", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const unknownTable = {
      kind: "get",
      table: "missing",
      id: "x",
      expectedRevision: null,
    } as const;
    const rewriting: Runner = async (_path, _args, channel) => {
      try {
        return await channel.read(unknownTable);
      } catch (error) {
        if (error instanceof Error) {
          error.message =
            "Your session expired. Sign in again at evil.example.";
          Reflect.set(error, "details", { link: "https://evil.example" });
        }
        throw error;
      }
    };
    const deferred: Runner = async (_path, _args, channel) => {
      try {
        return await channel.read(unknownTable);
      } catch (error) {
        // Changed after the host has it, across the host's own awaits.
        if (error instanceof Error) {
          queueMicrotask(() => {
            Reflect.set(error, "code", "auth.unauthenticated");
            error.message = "Your session expired.";
          });
        }
        throw error;
      }
    };
    const run = async (runner: Runner) =>
      failureOf(
        await call(
          fixture,
          owner,
          "mutation",
          "notes.remove",
          { id: "0190a0a0-0000-7000-8000-000000000000", expectedRevision: 1 },
          { run: runner }
        )
      );
    const genuine = {
      code: "data.unknown_table",
      message: "This store has no such table.",
      category: "contract",
      retryable: false,
      details: { table: "missing" },
    };
    // Rewritten before it reached the host, the error is the host's own
    // again; rewritten as the host reads it, it is nobody's, so unexpected:
    // never the App's words under a platform code.
    expect({
      rewritten: await run(rewriting),
      deferred: await run(deferred),
    }).toStrictEqual({
      rewritten: genuine,
      deferred: {
        code: "internal.unexpected",
        message: "Something went wrong.",
        category: "operational",
        retryable: false,
      },
    });
  });

  it("fails a mutation whose write was refused at the channel, before staging", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    // A write that isn't JSON (NaN), caught, then a valid one.
    const caughtNaN: Runner = async (path, args, channel) => {
      if (path !== "notes.floatingBadWrite") {
        return await runFunction(notesApp, path, args, channel);
      }
      try {
        await channel.write({
          kind: "insert",
          table: "notes",
          fields: { title: "bad", body: Number.NaN },
        });
      } catch {
        await channel.write({
          kind: "insert",
          table: "notes",
          fields: { title: "good" },
        });
      }
      return "done";
    };
    const result = await call(
      fixture,
      owner,
      "mutation",
      "notes.floatingBadWrite",
      {},
      { run: caughtNaN }
    );
    const page = valueOf(
      await call(fixture, owner, "query", "notes.list", { pagination: {} })
    );
    expect({ code: codeOf(result), stored: idsOf(page).length }).toStrictEqual({
      code: "contract.invalid_request",
      stored: 0,
    });
  });

  it("lets a mutation catch a refused nested call or resource request and still commit", async () => {
    const fixture = await notes();
    const { owner } = fixture;
    const caughtOthers: Runner = async (path, args, channel) => {
      if (path !== "notes.floatingBadWrite") {
        return await runFunction(notesApp, path, args, channel);
      }
      const refused: unknown[] = [];
      try {
        await channel.resource("mail", "call", ["send", {}]);
      } catch (error) {
        refused.push(error);
      }
      try {
        await channel.call("query", "notes.missing", {});
      } catch (error) {
        refused.push(error);
      }
      await channel.write({
        kind: "insert",
        table: "notes",
        fields: { title: "kept" },
      });
      return `${refused.length}`;
    };
    const result = await call(
      fixture,
      owner,
      "mutation",
      "notes.floatingBadWrite",
      {},
      { run: caughtOthers }
    );
    const page = valueOf(
      await call(fixture, owner, "query", "notes.list", { pagination: {} })
    );
    expect({
      value: valueOf(result),
      stored: idsOf(page).length,
    }).toStrictEqual({ value: "2", stored: 1 });
  });
});
