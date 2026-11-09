import { defineApp, defineSchema, defineTable, rows, v } from "@grasp-os/sdk";
import type { Id, SchemaDefinition } from "@grasp-os/sdk";
import {
  inspectApp,
  manifestText,
  registerApp,
  schemaManifest,
} from "@grasp-os/sdk/host";
import { runFunction } from "@grasp-os/sdk/runner";
import { serverModule } from "@grasp-os/sdk/server";
import { fromBase64Url, toBase64Url } from "@grasp-os/shared/encoding";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { queryMaxScannedEntries } from "@grasp-os/shared/store-limits";
import { storedFieldsSchema } from "@grasp-os/shared/stores";
import type { Commit, StoreFields, WriterRoles } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { operationRoles } from "../src/app-access.ts";
import { AppDataRpc } from "../src/app-data.ts";
import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { createApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { appMembers, teamMembers, teams } from "../src/db/core/schema.ts";
import { callOperation } from "../src/operations.ts";
import type { Runner } from "../src/operations.ts";
import type { SessionCheck } from "../src/session-check.ts";
import type { MigrationRow } from "../src/store-host.ts";
import { reviewVersion } from "../src/version-review.ts";
import { testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { storeOfNewApp } from "./app-stores.ts";
import { published, release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { refusalOf } from "./migrated-apps.ts";
import { objectOf, schemaHashOf } from "./notes-stores.ts";
import { appWith, failure, person } from "./sealed-apps.ts";
import { signedInApi } from "./sign-in.ts";
import {
  applied,
  appliedTables,
  manifestHash,
  namedIds,
  newRecordId,
} from "./store-schemas.ts";

// Row rules (`defineTable(...).access`, store-rules.ts): who reads and who
// changes which rows of a table, by owner, by a person field, by a team
// field and by App role. Asked as App code asks (`ctx.db` in a real App's
// functions), through the operation host and the store, with each
// caller's roles and teams read from core's own records as every call
// reads them (`operationRoles`). The cases follow the threat model:
// every read path (get, queries and their terminals, pages, searches,
// groups, related records), every write (insert, patch, replace, delete,
// a reference, a cascade, a restricted deletion a hidden row refers to),
// a team left between two calls, and a migration's transform (one team's
// rows a batch, never a rule's field rewritten), for two people in
// different teams, a builder and someone outside the App.

const schema = defineSchema({
  requests: defineTable({
    title: v.string(),
    team: v.string(),
    assignee: v.person().optional(),
    status: v.string(),
    amount: v.number(),
  })
    .index("by_status", ["status"])
    .searchIndex(["title"])
    .access({
      read: "appMembers",
      write: "appMembers",
      rows: {
        read: [
          rows.owner(),
          rows.person("assignee"),
          rows.team("team"),
          rows.role("builder"),
        ],
        write: [rows.owner(), rows.person("assignee"), rows.role("builder")],
      },
    }),
  // Changed only by members of the team a row names: its owner included.
  accounts: defineTable({ name: v.string(), team: v.string() }).access({
    read: "appMembers",
    write: "appMembers",
    rows: {
      write: [rows.team("team")],
    },
  }),
  // Rows that point at requests, with no rules of their own.
  orders: defineTable({ request: v.id("requests"), note: v.string() }).access({
    read: "appMembers",
    write: "appMembers",
  }),
  // Read and changed by its team alone: no write rules of its own, so its
  // read rules hold for writing too.
  tickets: defineTable({ title: v.string(), team: v.string() }).access({
    read: "appMembers",
    write: "appMembers",
    rows: {
      read: [rows.team("team")],
    },
  }),
  // What a mutation saw, with no rules of its own.
  logs: defineTable({ text: v.string() }).access({
    read: "appMembers",
    write: "appMembers",
  }),
  // Each person's own notes on a request, gone with it.
  notes: defineTable({
    request: v.id("requests", { onDelete: "cascade" }),
    text: v.string(),
  }).access({
    read: "appMembers",
    write: "appMembers",
    rows: { read: [rows.owner()], write: [rows.owner()] },
  }),
});

const { mutation, query } = serverModule(schema);

const requestFields = {
  title: v.string(),
  team: v.string(),
  assignee: v.string().optional(),
  status: v.string(),
  amount: v.number(),
};

const titles = (docs: readonly { title: string }[]): string[] =>
  docs.map(({ title }) => title).toSorted();

const addRequest = mutation({
  args: requestFields,
  returns: v.id("requests"),
  handler: async (ctx, args) => await ctx.db.insert("requests", args),
});

const getRequest = query({
  args: { id: v.id("requests") },
  returns: v.string().nullable(),
  handler: async (ctx, { id }) => {
    const found = await ctx.db.get("requests", id);
    return found?.title ?? null;
  },
});

const listRequests = query({
  args: {},
  returns: v.object({
    all: v.array(v.string()),
    count: v.number(),
    open: v.array(v.string()),
    first: v.string().nullable(),
  }),
  handler: async (ctx) => {
    const won = await ctx.db
      .query("requests")
      .filter({ status: "won" })
      .first();
    return {
      all: titles(await ctx.db.query("requests").collect()),
      count: await ctx.db.query("requests").count(),
      open: titles(
        await ctx.db
          .query("requests")
          .withIndex("by_status", (range) => range.eq("status", "open"))
          .collect()
      ),
      first: won?.title ?? null,
    };
  },
});

/** One page of titles, as `paginate` answers it. */
interface TitlePage {
  readonly items: readonly { readonly title: string }[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

const pageRequests = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one page after the other
      const read: TitlePage = await ctx.db
        .query("requests")
        .paginate({ pageSize: 1, cursor });
      seen.push(...read.items.map(({ title }) => title));
      if (!read.hasMore) {
        break;
      }
      cursor = read.nextCursor;
    }
    return seen.toSorted();
  },
});

const searchRequests = query({
  args: { text: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { text }) =>
    titles(await ctx.db.search("requests", text).collect()),
});

const groupRequests = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const groups = await ctx.db
      .query("requests")
      .group({ by: ["status"], sum: ["amount"] });
    return groups.map(
      ({ key, count, sum }) => `${key.status}: ${count}, ${String(sum.amount)}`
    );
  },
});

/** A related request as a read shows it: its title, null or withheld. */
const shownRequest = (
  related: { readonly title: string } | { readonly _withheld: true } | null
): string => {
  if (related === null) {
    return "null";
  }
  return "_withheld" in related ? "withheld" : related.title;
};

const addOrder = mutation({
  args: { request: v.id("requests"), note: v.string() },
  returns: v.id("orders"),
  handler: async (ctx, args) => await ctx.db.insert("orders", args),
});

const ordersWithRequests = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const found = await ctx.db.query("orders").with("request").collect();
    return found
      .map(({ note, _with }) => `${note}: ${shownRequest(_with.request)}`)
      .toSorted();
  },
});

const assign = mutation({
  args: { id: v.id("requests"), assignee: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, assignee }) => {
    await ctx.db.patch("requests", id, { assignee });
    return null;
  },
});

const retitle = mutation({
  args: { id: v.id("requests"), title: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, title }) => {
    await ctx.db.patch("requests", id, { title });
    return null;
  },
});

const replaceRequest = mutation({
  args: { id: v.id("requests"), ...requestFields },
  returns: v.null(),
  handler: async (ctx, { id, ...fields }) => {
    await ctx.db.replace("requests", id, fields);
    return null;
  },
});

const removeRequest = mutation({
  args: { id: v.id("requests") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await ctx.db.delete("requests", id);
    return null;
  },
});

const addAccount = mutation({
  args: { name: v.string(), team: v.string() },
  returns: v.id("accounts"),
  handler: async (ctx, args) => await ctx.db.insert("accounts", args),
});

const renameAccount = mutation({
  args: { id: v.id("accounts"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, name }) => {
    await ctx.db.patch("accounts", id, { name });
    return null;
  },
});

const addNote = mutation({
  args: { request: v.id("requests"), text: v.string() },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

const countNotes = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => await ctx.db.query("notes").count(),
});

const addTicket = mutation({
  args: { title: v.string(), team: v.string() },
  returns: v.id("tickets"),
  handler: async (ctx, args) => await ctx.db.insert("tickets", args),
});

const moveTicket = mutation({
  args: { id: v.id("tickets"), team: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, team }) => {
    await ctx.db.patch("tickets", id, { team });
    return null;
  },
});

const replaceTicket = mutation({
  args: { id: v.id("tickets"), title: v.string(), team: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, ...fields }) => {
    await ctx.db.replace("tickets", id, fields);
    return null;
  },
});

const removeTicket = mutation({
  args: { id: v.id("tickets") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await ctx.db.delete("tickets", id);
    return null;
  },
});

const pageFrom = query({
  args: { cursor: v.string().nullable(), search: v.string().optional() },
  returns: v.object({
    titles: v.array(v.string()),
    next: v.string().nullable(),
  }),
  handler: async (ctx, { cursor, search }) => {
    const read: TitlePage = await (
      search === undefined
        ? ctx.db.query("requests")
        : ctx.db.search("requests", search)
    ).paginate({ pageSize: 1, cursor });
    return {
      titles: read.items.map(({ title }) => title),
      next: read.nextCursor,
    };
  },
});

/** Counts the requests it may read, and logs what it saw. */
const logCount = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const seen = await ctx.db.query("requests").count();
    await ctx.db.insert("logs", { text: `seen ${seen}` });
    return seen;
  },
});

const readLogs = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const logs = await ctx.db.query("logs").collect();
    return logs.map(({ text }) => text);
  },
});

const operations = {
  addRequest,
  addTicket,
  moveTicket,
  replaceTicket,
  removeTicket,
  pageFrom,
  logCount,
  readLogs,
  getRequest,
  listRequests,
  pageRequests,
  searchRequests,
  groupRequests,
  addOrder,
  ordersWithRequests,
  assign,
  retitle,
  replaceRequest,
  removeRequest,
  addAccount,
  renameAccount,
  addNote,
  countNotes,
};

const ruledApp = registerApp({
  config: defineApp({ name: "Requests" }),
  schema,
  modules: { requests: operations },
  migrations: [],
});

const { manifest } = inspectApp(ruledApp);

type Operation = keyof typeof operations;

const mutations = new Set<Operation>([
  "addRequest",
  "addTicket",
  "moveTicket",
  "replaceTicket",
  "removeTicket",
  "logCount",
  "addOrder",
  "assign",
  "retitle",
  "replaceRequest",
  "removeRequest",
  "addAccount",
  "renameAccount",
  "addNote",
]);

interface World {
  readonly appId: AppId;
  readonly store: OpenStore;
  readonly tableIds: Readonly<Record<string, string>>;
  /** A builder of the App, in no team. */
  readonly carol: Acting;
  /** A user of the App, in Sales. */
  readonly ada: Acting;
  /** A user of the App, in Support. */
  readonly bob: Acting;
  readonly sales: string;
  readonly support: string;
}

const db = drizzle(env.DB);

const joinTeam = async (
  team: string,
  member: Pick<Acting, "userId">
): Promise<void> => {
  await db
    .insert(teamMembers)
    .values({ id: crypto.randomUUID(), teamId: team, userId: member.userId });
};

const newTeam = async (name: string, ...members: Acting[]): Promise<string> => {
  const id = crypto.randomUUID();
  await db.insert(teams).values({
    id,
    name,
    organizationId: "organization",
    createdAt: new Date(),
  });
  for (const member of members) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of rows
    await joinTeam(id, member);
  }
  return id;
};

const leaveTeam = async (
  team: string,
  member: Pick<Acting, "userId">
): Promise<void> => {
  await db
    .delete(teamMembers)
    .where(
      and(eq(teamMembers.teamId, team), eq(teamMembers.userId, member.userId))
    );
};

/** Shares App `appId` with `member`, in App role `role`. */
const share = async (
  appId: AppId,
  owner: Acting,
  member: Acting,
  role: "user" | "builder"
): Promise<void> => {
  await db.insert(appMembers).values({
    appId,
    memberType: "person",
    memberId: member.userId,
    role,
    addedBy: owner.userId,
    addedAt: new Date(),
  });
};

/** The App, its store, and Carol, Ada (Sales) and Bob (Support). */
const world = async (): Promise<World> => {
  const owner = await person("builder");
  const { id: appId } = await createApp(env, owner, { name: "Requests" });
  await published(appId);
  const store = await openStore(env, await storeOfNewApp(env, owner));
  const defined = await appliedTables(store, manifestText(manifest.schema));
  const [carol, ada, bob] = await Promise.all([
    person("builder"),
    person("user"),
    person("user"),
  ]);
  await share(appId, owner, carol, "builder");
  await share(appId, owner, ada, "user");
  await share(appId, owner, bob, "user");
  return {
    appId,
    store,
    tableIds: defined.tables,
    carol,
    ada,
    bob,
    sales: await newTeam("Sales", ada),
    support: await newTeam("Support", bob),
  };
};

/**
 * What `by` gets calling `path` with `args`, as the operation host runs
 * an App's function: their roles and teams read from core's records now,
 * unless `roles` stands in for whoever core resolved.
 */
const call = async (
  { appId, store }: World,
  by: Acting,
  path: Operation,
  args: Record<string, unknown> = {},
  {
    roles,
    run = async (name, input, channel) =>
      await runFunction(ruledApp, name, input, channel),
  }: {
    /** Stands in for whoever core resolved. */
    roles?: WriterRoles;
    /** Runs the App's code: its own, unless a test steps in between. */
    run?: Runner;
  } = {}
): Promise<OperationResult> =>
  await callOperation(
    { manifest, run },
    {
      principal: by.userId,
      actor: { type: "person", userId: by.userId },
      // A test of the host, on a store only it reaches.
      sensitiveReads: null,
      consumer: { resourceId: appId, resourceVersion: 1 },
      store,
      requestId: crypto.randomUUID(),
      deadline: Date.now() + 60_000,
      runId: null,
      authorize: async () => roles ?? (await operationRoles(env, by, appId)),
    },
    {
      path: `requests.${path}`,
      kind: mutations.has(path) ? "mutation" : "query",
    },
    args
  );

/** What a call answered, or the code it was refused with. */
const outcome = (result: OperationResult): unknown =>
  result.ok ? result.value : result.error.code;

/** Field `field` of `value`, or undefined. */
const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, field)
    : undefined;

/** A refusal as its caller sees it, but for the record it names. */
const refusal = (result: OperationResult): unknown => {
  if (result.ok) {
    return result.value;
  }
  const { code, message, category, retryable, details } = result.error;
  const table: unknown =
    typeof details === "object" && details !== null
      ? Reflect.get(details, "table")
      : undefined;
  return { code, message, category, retryable, table };
};

/** The ID a call that inserted answered. */
const idOf = (result: OperationResult): Id<"requests"> => {
  if (!(result.ok && typeof result.value === "string")) {
    throw new Error(`Nothing was inserted: ${JSON.stringify(result)}`);
  }
  // SAFETY: the insert's operation returns a record ID of its table.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return result.value as Id<"requests">;
};

/**
 * The requests each person sees, by title:
 *
 * - `sales lead alpha`: Ada's own, for Sales;
 * - `sales follow up alpha`: Bob's, for Sales (Ada's team, not his);
 * - `support ticket alpha`: Bob's own, for Support;
 * - `handed to ada alpha`: Bob's, for Support, assigned to Ada;
 * - `board alpha`: Carol's, for no team either of them is in.
 */
const filled = async (of: World): Promise<Record<string, Id<"requests">>> => {
  const { ada, bob, carol, sales, support } = of;
  const add = async (
    by: Acting,
    title: string,
    fields: { team: string; status: string; amount: number; assignee?: string }
  ): Promise<[string, Id<"requests">]> => [
    title,
    idOf(await call(of, by, "addRequest", { title, ...fields })),
  ];
  return Object.fromEntries([
    await add(ada, "sales lead alpha", {
      team: sales,
      status: "open",
      amount: 10,
    }),
    await add(bob, "sales follow up alpha", {
      team: sales,
      status: "open",
      amount: 7,
    }),
    await add(bob, "support ticket alpha", {
      team: support,
      status: "open",
      amount: 20,
    }),
    await add(bob, "handed to ada alpha", {
      team: support,
      status: "won",
      amount: 5,
      assignee: ada.userId,
    }),
    await add(carol, "board alpha", {
      team: "board",
      status: "open",
      amount: 100,
    }),
  ]);
};

const idIn = (
  ids: Record<string, Id<"requests">>,
  title: string
): Id<"requests"> => {
  const id = ids[title];
  if (id === undefined) {
    throw new Error(`No request ${title}`);
  }
  return id;
};

describe("reading a table with row rules", () => {
  it("answers each person the rows they own, are assigned or share a team with, on every query terminal", async () => {
    const of = await world();
    await filled(of);
    const [ada, bob, carol] = await Promise.all([
      call(of, of.ada, "listRequests"),
      call(of, of.bob, "listRequests"),
      call(of, of.carol, "listRequests"),
    ]);
    expect({
      ada: outcome(ada),
      bob: outcome(bob),
      carol: outcome(carol),
    }).toStrictEqual({
      ada: {
        all: [
          "handed to ada alpha",
          "sales follow up alpha",
          "sales lead alpha",
        ],
        count: 3,
        open: ["sales follow up alpha", "sales lead alpha"],
        first: "handed to ada alpha",
      },
      bob: {
        all: [
          "handed to ada alpha",
          "sales follow up alpha",
          "support ticket alpha",
        ],
        count: 3,
        open: ["sales follow up alpha", "support ticket alpha"],
        first: "handed to ada alpha",
      },
      // `rows.role("builder")`: every row.
      carol: {
        all: [
          "board alpha",
          "handed to ada alpha",
          "sales follow up alpha",
          "sales lead alpha",
          "support ticket alpha",
        ],
        count: 5,
        open: [
          "board alpha",
          "sales follow up alpha",
          "sales lead alpha",
          "support ticket alpha",
        ],
        first: "handed to ada alpha",
      },
    });
  });

  it("answers a row the rules keep from someone as one that isn't there", async () => {
    const of = await world();
    const ids = await filled(of);
    const get = async (by: Acting, title: string) =>
      outcome(await call(of, by, "getRequest", { id: idIn(ids, title) }));
    const gone = idOf(
      await call(of, of.ada, "addRequest", {
        title: "gone alpha",
        team: of.sales,
        status: "open",
        amount: 1,
      })
    );
    await call(of, of.ada, "removeRequest", { id: gone });
    expect({
      adaOwn: await get(of.ada, "sales lead alpha"),
      adaAssigned: await get(of.ada, "handed to ada alpha"),
      adaOtherTeam: await get(of.ada, "support ticket alpha"),
      adaBoard: await get(of.ada, "board alpha"),
      bobSalesLead: await get(of.bob, "sales lead alpha"),
      missing: outcome(await call(of, of.ada, "getRequest", { id: gone })),
    }).toStrictEqual({
      adaOwn: "sales lead alpha",
      adaAssigned: "handed to ada alpha",
      adaOtherTeam: null,
      adaBoard: null,
      bobSalesLead: null,
      missing: null,
    });
  });

  it("pages, searches and groups over the rows each person may read, and nothing else", async () => {
    const of = await world();
    await filled(of);
    const read = async (by: Acting) => ({
      pages: outcome(await call(of, by, "pageRequests")),
      search: outcome(await call(of, by, "searchRequests", { text: "alpha" })),
      groups: outcome(await call(of, by, "groupRequests")),
    });
    expect({ ada: await read(of.ada), bob: await read(of.bob) }).toStrictEqual({
      ada: {
        pages: [
          "handed to ada alpha",
          "sales follow up alpha",
          "sales lead alpha",
        ],
        search: [
          "handed to ada alpha",
          "sales follow up alpha",
          "sales lead alpha",
        ],
        // No count or sum of a row they can't read: Bob's 20 and
        // Carol's 100 are in no group.
        groups: ["open: 2, 17", "won: 1, 5"],
      },
      bob: {
        pages: [
          "handed to ada alpha",
          "sales follow up alpha",
          "support ticket alpha",
        ],
        search: [
          "handed to ada alpha",
          "sales follow up alpha",
          "support ticket alpha",
        ],
        groups: ["open: 2, 27", "won: 1, 5"],
      },
    });
  });

  it("answers a related row the rules keep from someone as null, as a missing one", async () => {
    const of = await world();
    const ids = await filled(of);
    for (const title of [
      "sales lead alpha",
      "support ticket alpha",
      "board alpha",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one order after the other
      await call(of, of.carol, "addOrder", {
        request: idIn(ids, title),
        note: `order for ${title}`,
      });
    }
    expect(outcome(await call(of, of.ada, "ordersWithRequests"))).toStrictEqual(
      [
        "order for board alpha: null",
        "order for sales lead alpha: sales lead alpha",
        "order for support ticket alpha: null",
      ]
    );
  });

  it("never lets someone refer to a row the rules keep from them", async () => {
    const of = await world();
    const ids = await filled(of);
    const order = async (title: string) =>
      outcome(
        await call(of, of.ada, "addOrder", {
          request: idIn(ids, title),
          note: "mine",
        })
      );
    expect({
      readable: typeof (await order("handed to ada alpha")),
      hidden: await order("support ticket alpha"),
    }).toStrictEqual({ readable: "string", hidden: "data.reference_invalid" });
  });

  it("counts nothing someone can't read against a read's scan bound", async () => {
    const of = await world();
    await filled(of);
    // More of Carol's rows for the board than one read may examine.
    await runInDurableObject(
      env.DATA_STORES.getByName(of.store.id),
      (_instance, state) => {
        for (let index = 0; index <= queryMaxScannedEntries; index += 1) {
          state.storage.sql.exec(
            "INSERT INTO sdk_records (table_id, record_id, owner_id, revision, created_at, updated_at, value_json, schema_hash) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
            of.tableIds.requests,
            `r_board_${index}`,
            of.carol.userId,
            index,
            index,
            JSON.stringify({
              title: `board item alpha ${index}`,
              team: "board",
              status: "open",
              amount: 1,
            }),
            "a".repeat(64)
          );
        }
      }
    );
    expect({
      adaList: outcome(await call(of, of.ada, "listRequests")),
      adaSearch: outcome(
        await call(of, of.ada, "searchRequests", { text: "alpha" })
      ),
      adaGroups: outcome(await call(of, of.ada, "groupRequests")),
      carolSearch: outcome(
        await call(of, of.carol, "searchRequests", { text: "alpha" })
      ),
    }).toStrictEqual({
      adaList: {
        all: [
          "handed to ada alpha",
          "sales follow up alpha",
          "sales lead alpha",
        ],
        count: 3,
        open: ["sales follow up alpha", "sales lead alpha"],
        first: "handed to ada alpha",
      },
      adaSearch: [
        "handed to ada alpha",
        "sales follow up alpha",
        "sales lead alpha",
      ],
      adaGroups: ["open: 2, 17", "won: 1, 5"],
      carolSearch: "data.scan_limit",
    });
  });

  it("reads under the teams someone is in at the call: a team left counts from the next read", async () => {
    const of = await world();
    await filled(of);
    const before = outcome(
      await call(of, of.ada, "searchRequests", { text: "alpha" })
    );
    await leaveTeam(of.sales, of.ada);
    await joinTeam(of.support, of.ada);
    expect({
      before,
      after: outcome(
        await call(of, of.ada, "searchRequests", { text: "alpha" })
      ),
    }).toStrictEqual({
      before: [
        "handed to ada alpha",
        "sales follow up alpha",
        "sales lead alpha",
      ],
      // Still her own lead; Bob's sales follow up is Sales' alone now.
      after: [
        "handed to ada alpha",
        "sales lead alpha",
        "support ticket alpha",
      ],
    });
  });

  it("refuses someone with no role in the App, as a visitor, before any row", async () => {
    const of = await world();
    await filled(of);
    const visitor = await person("user");
    expect(
      outcome(
        await call(
          of,
          visitor,
          "listRequests",
          {},
          { roles: { appMember: false, appBuilder: false } }
        )
      )
    ).toBe("data.access_denied");
  });
});

describe("writing a table whose read rules are its write rules", () => {
  it("never lets a write reach a row the writer can't read, nor move one into their sight or out of it", async () => {
    const of = await world();
    const ticketOf = async (by: Acting, title: string, team: string) =>
      idOf(await call(of, by, "addTicket", { title, team }));
    const ours = await ticketOf(of.ada, "Ada's", of.sales);
    const hidden = await ticketOf(of.bob, "Bob's", of.support);
    const gone = await ticketOf(of.ada, "Gone", of.sales);
    await call(of, of.ada, "removeTicket", { id: gone });
    const asAda = async (path: Operation, args: Record<string, unknown>) =>
      refusal(await call(of, of.ada, path, args));
    const missing = await asAda("removeTicket", { id: gone });
    expect({
      // Moving Bob's Support ticket into Sales would let her read it.
      moveHiddenIn: await asAda("moveTicket", { id: hidden, team: of.sales }),
      replaceHidden: await asAda("replaceTicket", {
        id: hidden,
        title: "Ada's now",
        team: of.sales,
      }),
      removeHidden: await asAda("removeTicket", { id: hidden }),
      // And her own, moved to Support, would leave her sight.
      moveOursOut: outcome(
        await call(of, of.ada, "moveTicket", { id: ours, team: of.support })
      ),
    }).toStrictEqual({
      moveHiddenIn: missing,
      replaceHidden: missing,
      removeHidden: missing,
      moveOursOut: "data.write_denied",
    });
    expect(missing).toMatchObject({ code: "data.conflict" });
    // Bob's ticket is as it was: still at its first revision, for him.
    expect(
      outcome(
        await call(of, of.bob, "replaceTicket", {
          id: hidden,
          title: "Bob's",
          team: of.support,
        })
      )
    ).toBeNull();
  });
});

/** `of.ada`'s page from `cursor` (its titles and next cursor), or its refusal. */
const adaPage = async (
  of: World,
  cursor: unknown,
  search?: string
): Promise<unknown> =>
  outcome(
    await call(of, of.ada, "pageFrom", {
      cursor,
      ...(search === undefined ? {} : { search }),
    })
  );

/** The next cursor of `page`, which must have one. */
const nextOf = (page: unknown): string => {
  const next = fieldOf(page, "next");
  if (typeof next !== "string") {
    throw new TypeError("No next page");
  }
  return next;
};

/** `cursor` ending at record `id`, by its ID alone, as a caller could make it. */
const forgedAt = (cursor: string, id: string): string => {
  const held = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(new TextDecoder().decode(fromBase64Url(cursor))));
  return toBase64Url(
    new TextEncoder().encode(JSON.stringify({ ...held, id, values: undefined }))
  );
};

describe("a forged cursor", () => {
  it("ends at no row the rules keep from its reader, in a query or a search", async () => {
    const of = await world();
    const ids = await filled(of);
    const hidden = idIn(ids, "board alpha");
    const queried = nextOf(await adaPage(of, null));
    const searched = nextOf(await adaPage(of, null, "alpha"));
    // As missing as a row that never was: never a page after it, nor its
    // relevance to seek by.
    expect({
      query: await adaPage(of, forgedAt(queried, hidden)),
      search: await adaPage(of, forgedAt(searched, hidden), "alpha"),
    }).toStrictEqual({
      query: "data.cursor_expired",
      search: "data.cursor_expired",
    });
  });
});

describe("a person's teams changing", () => {
  it("pages on under the teams they have now", async () => {
    const of = await world();
    await filled(of);
    const first = await adaPage(of, null);
    await joinTeam(of.support, of.ada);
    const rest: unknown[] = [];
    let next: unknown = nextOf(first);
    while (typeof next === "string") {
      // One page after the other.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const page = await adaPage(of, next);
      rest.push(fieldOf(page, "titles"));
      next = fieldOf(page, "next");
    }
    expect({ first: fieldOf(first, "titles"), rest }).toStrictEqual({
      first: ["sales lead alpha"],
      // Support's ticket too, now Ada is in support.
      rest: [
        ["sales follow up alpha"],
        ["support ticket alpha"],
        ["handed to ada alpha"],
      ],
    });
  });

  it("runs a mutation again under the teams they have when one changes between its reads and its commit", async () => {
    const of = await world();
    await filled(of);
    let runs = 0;
    const result = await call(
      of,
      of.ada,
      "logCount",
      {},
      {
        run: async (name, input, channel) => {
          runs += 1;
          const answer = await runFunction(ruledApp, name, input, channel);
          // Ada leaves Sales once the first run read what it read.
          if (runs === 1) {
            await leaveTeam(of.sales, of.ada);
          }
          return answer;
        },
      }
    );
    expect({
      // Her own lead and the request assigned to her; Sales' follow up
      // is out of her sight now, and nothing read in it was committed.
      result: outcome(result),
      runs,
      logged: outcome(await call(of, of.carol, "readLogs")),
    }).toStrictEqual({ result: 2, runs: 2, logged: ["seen 2"] });
  });
});

/** How many rows of imports store `storeId` holds staged, not landed yet. */
const importRowsStaged = async (storeId: string): Promise<number> =>
  await runInDurableObject(
    env.DATA_STORES.getByName(storeId),
    (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM sdk_import_rows")
        .one().n
  );

/**
 * The data page's RPC for the builder, through core's own `AppDataRpc`,
 * whose session check runs `meanwhile` (if given) before each reading of
 * the session: where a test steps in between a transfer's steps.
 */
const dataRpcOf = (
  builderId: string,
  meanwhile?: () => Promise<void>
): AppDataRpc => {
  const check: SessionCheck = async () => {
    await meanwhile?.();
    return {
      userId: builderId,
      email: `${builderId}@acme.test`,
      name: "Builder",
      role: "builder",
      teams: [],
      staff: false,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
  };
  return new AppDataRpc(env, check);
};

describe("an App's data page", () => {
  const idp = mockIdp();
  const files: TestApp = testApp(
    {
      name: "Requests",
      tables: {
        requests: {
          fields: { title: "v.string()", team: "v.string()" },
          access: {
            read: "appMembers",
            write: "appMembers",
            rows: {
              read: [{ kind: "owner" }, { kind: "team", field: "team" }],
              write: [{ kind: "team", field: "team" }],
            },
          },
        },
        memos: {
          fields: { text: "v.string()" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
    },
    {
      "server/requests.ts": `import { mutation } from "@server/_generated/server";
import { v } from "@grasp-os/sdk";

export const add = mutation({
  args: { title: v.string(), team: v.string() },
  returns: v.id("requests"),
  handler: async (ctx, args) => await ctx.db.insert("requests", args),
});

export const move = mutation({
  args: { id: v.id("requests"), team: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const found = await ctx.db.get("requests", args.id);
    if (found !== null) {
      await ctx.db.patch("requests", args.id, { team: args.team });
    }
    return null;
  },
});

export const retitle = mutation({
  args: { id: v.id("requests"), title: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const found = await ctx.db.get("requests", args.id);
    if (found !== null) {
      await ctx.db.patch("requests", args.id, { title: args.title });
    }
    return null;
  },
});
`,

      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Requests() {
  return <p>Requests</p>;
}

export const Route = createFileRoute("/")({ component: Requests });
`,
    }
  );

  /**
   * The App released by a builder in Sales, and an admin in Sales and
   * Support who calls its mutations (`asAdmin`), as a page calls them.
   */
  const dataPage = async () => {
    const builder = await signedInApi(idp, "builder");
    const admin = await signedInApi(idp, "admin");
    const { id: appId } = await builder.api.apps.create({ name: "Requests" });
    const version = await release(builder, appId, files);
    const sales = await newTeam("Sales");
    const support = await newTeam("Support");
    await db.insert(teamMembers).values([
      { id: crypto.randomUUID(), teamId: sales, userId: builder.userId },
      { id: crypto.randomUUID(), teamId: sales, userId: admin.userId },
      { id: crypto.randomUUID(), teamId: support, userId: admin.userId },
    ]);
    const current = await loadRelease(env, appIdSchema.parse(appId), version);
    const asAdmin = async (path: string, input: Json): Promise<unknown> => {
      const answer = await callAppFunction(
        env,
        { userId: admin.userId, role: "admin", teams: [] },
        appId,
        JSON.stringify({
          reference: { name: path, kind: "mutation" },
          input,
        })
      );
      if (!answer.result.ok) {
        throw new Error(`${path} failed: ${answer.result.error.code}`);
      }
      return answer.result.value;
    };
    const add = async (title: string, team: string): Promise<string> => {
      const id = await asAdmin("requests.add", { title, team });
      if (typeof id !== "string") {
        throw new TypeError("Expected the request's ID");
      }
      return id;
    };
    return {
      data: builder.api.apps.data,
      builderId: builder.userId,
      storeId: current.store?.storeId ?? "",
      appId,
      version,
      sales,
      support,
      asAdmin,
      add,
    };
  };

  it("shows a builder only the rows its rules admit them to, in the browser, the export, the history and an import", async () => {
    const { data, appId, version, sales, support, add } = await dataPage();
    const salesRow = await add("For Sales", sales);
    const supportRow = await add("For Support", support);
    const page = await data.records(appId, "requests", version, null);
    const salesHistory = await data.history(
      appId,
      "requests",
      version,
      salesRow,
      null
    );
    const csv = await new Response(await data.export(appId, "requests")).text();
    const importTo = async (team: string) =>
      await data.import(appId, "requests", {
        version,
        csv: `title,team\nImported,${team}\n`,
        mapping: { title: "title", team: "team" },
      });
    expect({
      browsed: page.records.map(({ fields }) => fields.title),
      hidden: await data.record(appId, "requests", version, supportRow),
      exported: [csv.includes("For Sales"), csv.includes("For Support")],
      salesHistory: salesHistory.changes.length,
      supportHistory: await data.history(
        appId,
        "requests",
        version,
        supportRow,
        null
      ),
      importOwnTeam: await importTo(sales),
      importOtherTeam: await importTo(support),
    }).toStrictEqual({
      browsed: ["For Sales"],
      hidden: null,
      exported: [true, false],
      salesHistory: 1,
      supportHistory: { changes: [], next: null },
      importOwnTeam: { ok: true, inserted: 1 },
      // Nothing of it lands: the row would be out of the builder's reach.
      importOtherTeam: {
        ok: false,
        errors: [
          {
            row: 0,
            column: null,
            field: null,
            message: "You can't change records of this table.",
          },
        ],
        more: false,
      },
    });
  });

  it("stops an export at the next page once the builder has left a team its rows were read by", async () => {
    const { builderId, appId, sales, add } = await dataPage();
    await add("For Sales", sales);
    const stream = await dataRpcOf(builderId).export(appId, "requests");
    // Nothing is read ahead: each read of the stream reads one more part.
    const reader = stream.getReader();
    const header = await reader.read();
    // They leave Sales once the header went out, before the first page.
    await leaveTeam(sales, { userId: builderId });
    let refused: unknown;
    let text = "";
    try {
      let read = await reader.read();
      while (!read.done) {
        text += new TextDecoder().decode(read.value);
        // oxlint-disable-next-line no-await-in-loop -- one chunk after the other
        read = await reader.read();
      }
    } catch (error) {
      refused = error instanceof Error ? Reflect.get(error, "code") : error;
    }
    expect({
      header: header.done,
      refused,
      leaked: text.includes("For Sales"),
    }).toStrictEqual({
      header: false,
      refused: "app_data.access_changed",
      leaked: false,
    });
  });

  it("finishes an export of a table no team rule reads, whatever teams the builder joins meanwhile", async () => {
    const { builderId, appId, version, sales } = await dataPage();
    const rpc = dataRpcOf(builderId);
    // More memos than one page of an export reads (100).
    const count = 150;
    await rpc.import(appId, "memos", {
      version,
      csv: `text\n${Array.from({ length: count }, (_, index) => `Memo ${index}`).join("\n")}\n`,
      mapping: { text: "text" },
    });
    const stream = await rpc.export(appId, "memos");
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const header = await reader.read();
    const firstPage = await reader.read();
    text += decoder.decode(firstPage.value);
    // Between two of its pages, they join Sales.
    await joinTeam(sales, { userId: builderId });
    let read = await reader.read();
    while (!read.done) {
      text += decoder.decode(read.value);
      // oxlint-disable-next-line no-await-in-loop -- one chunk after the other
      read = await reader.read();
    }
    expect({
      header: header.done,
      memos: text.split("\n").filter((line) => line.includes("Memo ")).length,
    }).toStrictEqual({ header: false, memos: count });
  });

  it("lands nothing of an import once the builder has left the team its rows are for", async () => {
    const { builderId, appId, version, sales, storeId } = await dataPage();
    // They leave Sales once the import's rows are staged in the store,
    // before they land: whenever their session is read next.
    const rpc = dataRpcOf(builderId, async () => {
      if ((await importRowsStaged(storeId)) > 0) {
        await leaveTeam(sales, { userId: builderId });
      }
    });
    let refused: unknown;
    try {
      await rpc.import(appId, "requests", {
        version,
        csv: `title,team\nImported,${sales}\n`,
        mapping: { title: "title", team: "team" },
      });
    } catch (error) {
      refused = error instanceof Error ? Reflect.get(error, "code") : error;
    }
    const after = await rpc.records(appId, "requests", version, null);
    expect({ refused, landed: after.records.length }).toStrictEqual({
      refused: "app_data.access_changed",
      landed: 0,
    });
  });

  it("shows a row's history only from when it was in the reader's sight: a row moved in from another team brings none of its past", async () => {
    const { data, appId, version, sales, support, asAdmin, add } =
      await dataPage();
    const id = await add("Handed over", support);
    await asAdmin("requests.retitle", { id, title: "Support's notes" });
    await asAdmin("requests.move", { id, team: sales });
    await asAdmin("requests.retitle", { id, title: "Sales' notes" });
    const { changes } = await data.history(
      appId,
      "requests",
      version,
      id,
      null
    );
    // Only the change made once it was Sales': its insert, its title in
    // Support and its move out of Support stay out of sight.
    expect(
      changes.map(({ op, before, after }) => ({ op, before, after }))
    ).toStrictEqual([
      {
        op: "update",
        before: { title: "Support's notes" },
        after: { title: "Sales' notes" },
      },
    ]);
  });
});

/** A tickets schema's manifest text. */
const ticketsText = (tickets: SchemaDefinition): string =>
  manifestText(schemaManifest(tickets));
/** Tickets read and changed by the team each names. */
const v1Text = ticketsText(
  defineSchema({
    tickets: defineTable({
      title: v.string().max(200),
      team: v.string(),
    }).access({
      read: "appMembers",
      write: "appMembers",
      rows: { read: [rows.team("team")] },
    }),
  })
);
/** A longer title, and a kind no record has yet: only a migration adds it. */
const v2Text = ticketsText(
  defineSchema({
    tickets: defineTable({
      title: v.string().max(500),
      team: v.string(),
      kind: v.enum(["lead", "ticket"]),
    }).access({
      read: "appMembers",
      write: "appMembers",
      rows: { read: [rows.team("team")] },
    }),
  })
);
const consumer = (resourceVersion: number) => ({
  resourceId: "tickets-app",
  resourceVersion,
});

/** Commits `writes` for `by`, in `inTeams`, under a receipt of its own. */
const commitAs = async (
  store: OpenStore,
  schemaHash: string,
  writes: Commit["writes"],
  by: string,
  inTeams: string[]
) => {
  const claimed = await store.claim({
    scope: {
      principal: by,
      resource: "tickets-app",
      binding: null,
      contractId: "tickets.update",
      contractVersion: 1,
      operationKind: "mutation",
    },
    key: [crypto.randomUUID()],
    inputHash: "c".repeat(64),
    runId: null,
    deadline: Date.now() + 60_000,
  });
  if (!("held" in claimed)) {
    throw new Error("A new key found an outcome");
  }
  return await store.commit({
    principal: { userId: by },
    actor: { type: "person", userId: by },
    roles: { appMember: true, appBuilder: false, teams: inTeams },
    stagedAt: Date.now(),
    schemaHash,
    writes,
    receipt: claimed.held,
  });
};

/** A store holding a ticket for each of `tickets`, under v1. */
const ticketsStore = async (
  tickets: readonly { by: string; team: string }[]
): Promise<{ store: OpenStore; ids: string[]; schemaHash: string }> => {
  const store = await openStore(
    env,
    await storeOfNewApp(env, await person("builder"))
  );
  const first = await store.applySchema(applied(v1Text));
  const ids: string[] = [];
  for (const [index, { by, team }] of tickets.entries()) {
    const id = newRecordId();
    ids.push(id);
    // One commit after the other, as people's would be.
    // oxlint-disable-next-line no-await-in-loop -- see above
    await commitAs(
      store,
      first.schemaHash,
      [
        {
          op: "insert",
          table: "tickets",
          id,
          fields: { title: `Ticket ${index}`, team },
        },
      ],
      by,
      [team]
    );
  }
  return { store, ids, schemaHash: first.schemaHash };
};

/**
 * Migrates `store` to v2, standing in for core's transform as a publish
 * runs it (migration-run.ts): every ticket the store hands out answered
 * with `rewrite` of its fields and staged, after `meanwhile` ran on what
 * was handed; then v2 applied with what was staged. What was handed, and
 * what applying answered or why it was refused.
 */
const migrateTickets = async (
  store: OpenStore,
  rewrite: (fields: StoreFields) => StoreFields,
  {
    meanwhile = async () => {
      // Nobody writes while it runs.
    },
  }: {
    meanwhile?: (handed: readonly MigrationRow[]) => Promise<void>;
  } = {}
): Promise<{ handed: MigrationRow[]; applied: string; schemaHash: string }> => {
  const { migrationId, schemaHash: from } = await store.beginMigration();
  const table = namedIds(v2Text).tickets?.id ?? "";
  const handed: MigrationRow[] = [];
  for (let after: string | null = null; ;) {
    // One page after the other, as a publish reads them.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const page = await store.migrationRows(table, after);
    if (page.length === 0) {
      break;
    }
    handed.push(...page);
    after = page.at(-1)?.id ?? null;
  }
  await meanwhile(handed);
  for (let start = 0; start < handed.length; start += 100) {
    // oxlint-disable-next-line no-await-in-loop -- one batch after the other
    await store.stageMigration({
      migrationId,
      table,
      rows: handed
        .slice(start, start + 100)
        .map(({ id, revision, fields }) => ({
          id,
          revision,
          fields: rewrite(fields),
        })),
    });
  }
  const answered = await failure(
    async () =>
      await store.applySchema(
        applied(v2Text, {
          migration: { id: migrationId, from: from ?? "", tables: ["tickets"] },
        })
      )
  );
  return {
    handed,
    applied: answered,
    schemaHash: await manifestHash(v2Text),
  };
};

/** Each ticket of `store` as it stores it, by ID. */
const storedTickets = async (store: OpenStore): Promise<StoreFields[]> =>
  await runInDurableObject(objectOf(store), (_instance, state) =>
    state.storage.sql
      .exec<{ value: string }>(
        "SELECT value_json AS value FROM sdk_records ORDER BY record_id"
      )
      .toArray()
      .map(({ value }) => storedFieldsSchema.parse(JSON.parse(value)))
  );

// A migration's transform reads every ticket, whichever team it is for.
// A builder in Sales, or the AI for them, ships one that hands Support's
// tickets to Sales (migration-run.ts keeps each call to one team's
// tickets, so its module state carries nothing between teams).
describe("a migration of a table with row rules", () => {
  it("applies every ticket's output with the schema, in one transaction", async () => {
    const { store } = await ticketsStore(
      Array.from({ length: 240 }, (_, index) => ({
        by: "bob",
        team: index % 2 === 0 ? "support" : "sales",
      }))
    );

    const { handed, applied: answered } = await migrateTickets(
      store,
      (fields) => ({ ...fields, kind: "ticket" })
    );
    const tickets = await storedTickets(store);

    expect({
      handed: handed.length,
      answered,
      kinds: new Set(tickets.map(({ kind }) => kind)),
    }).toStrictEqual({
      handed: 240,
      answered: "ok",
      kinds: new Set(["ticket"]),
    });
  });

  it("changes nothing when a ticket moves to another team while its migration runs", async () => {
    const { store, schemaHash } = await ticketsStore([
      { by: "bob", team: "support" },
      { by: "bob", team: "sales" },
    ]);

    const { applied: answered } = await migrateTickets(
      store,
      (fields) => ({ ...fields, kind: "ticket" }),
      {
        meanwhile: async ([ticket]) => {
          await commitAs(
            store,
            schemaHash,
            [
              {
                op: "patch",
                table: "tickets",
                id: ticket?.id ?? "",
                fields: { team: "triage" },
              },
            ],
            "bob",
            ["support", "sales", "triage"]
          );
        },
      }
    );

    const tickets = await storedTickets(store);
    expect({
      answered,
      schema: await schemaHashOf(store),
      teams: tickets
        .map(({ team }) => (typeof team === "string" ? team : ""))
        .toSorted((a, b) => a.localeCompare(b)),
      kinds: tickets.map(({ kind }) => kind ?? null),
    }).toStrictEqual({
      answered: "migration.busy",
      schema: schemaHash,
      teams: ["sales", "triage"],
      kinds: [null, null],
    });
  });

  it("refuses a transform that moves a ticket to another team, writing nothing", async () => {
    const { store, schemaHash } = await ticketsStore([
      { by: "bob", team: "support" },
      { by: "bob", team: "support" },
    ]);

    const { applied: answered } = await migrateTickets(store, (fields) => ({
      ...fields,
      team: "sales",
      kind: "ticket",
    }));

    const tickets = await storedTickets(store);
    expect({
      answered,
      schema: await schemaHashOf(store),
      teams: tickets.map(({ team }) => team),
    }).toStrictEqual({
      answered: "migration.failed",
      schema: schemaHash,
      teams: ["support", "support"],
    });
  });
});

describe("a record's history across a migration", () => {
  it("keeps a migration out of the history, and the history before it in sight", async () => {
    const { store, ids } = await ticketsStore([{ by: "ada", team: "sales" }]);
    const [id = ""] = ids;
    const { schemaHash } = await migrateTickets(store, (fields) => ({
      ...fields,
      kind: "ticket",
    }));
    await commitAs(
      store,
      schemaHash,
      [
        {
          op: "patch",
          table: "tickets",
          id,
          fields: { title: "Sales' ticket" },
          unset: [],
        },
      ],
      "ada",
      ["sales"]
    );

    const { changes } = await store.history(
      {
        schemaHash,
        principal: "ada",
        appMember: true,
        appBuilder: false,
        teams: ["sales"],
        consumer: consumer(2),
      },
      "tickets",
      id,
      null
    );
    expect(
      changes.map(({ op, source, before, after }) => ({
        op,
        source,
        before,
        after,
      }))
    ).toStrictEqual([
      {
        op: "update",
        source: "commit",
        before: { title: "Ticket 0" },
        after: { title: "Sales' ticket" },
      },
      {
        op: "insert",
        source: "commit",
        before: {},
        after: { title: "Ticket 0", team: "sales" },
      },
    ]);
  });
});

describe("a record's history across a rename of the field a row rule reads", () => {
  it("shows a row moved in from another team none of its past, under the field's new name", async () => {
    const { store, ids, schemaHash } = await ticketsStore([
      { by: "bob", team: "support" },
    ]);
    const [id = ""] = ids;
    await commitAs(
      store,
      schemaHash,
      [
        {
          op: "patch",
          table: "tickets",
          id,
          fields: { team: "sales" },
          unset: [],
        },
      ],
      "carol",
      ["support", "sales"]
    );
    // `team` renamed to `group`, by its stable ID.
    const renamedText = ticketsText(
      defineSchema({
        tickets: defineTable({
          title: v.string().max(200),
          group: v.string(),
        }).access({
          read: "appMembers",
          write: "appMembers",
          rows: { read: [rows.team("group")] },
        }),
      })
    );
    const table = namedIds(v1Text).tickets?.id ?? "";
    const renamed = await store.applySchema(
      applied(renamedText, {
        ids: {
          tickets: { id: table, fields: { title: "title", group: "team" } },
        },
      })
    );

    const { changes } = await store.history(
      {
        schemaHash: renamed.schemaHash,
        principal: "ada",
        appMember: true,
        appBuilder: false,
        teams: ["sales"],
        consumer: consumer(3),
      },
      "tickets",
      id,
      null
    );
    expect(changes).toStrictEqual([]);
  });
});

describe("a record's long history, read by row rules", () => {
  it("pages through every change the reader was admitted to, and none from before", async () => {
    const store = await openStore(
      env,
      await storeOfNewApp(env, await person("builder"))
    );
    const { schemaHash } = await store.applySchema(applied(v1Text));
    const id = newRecordId();
    const patch = async (
      fields: Record<string, string>,
      revision: number,
      by: string,
      inTeams: string[]
    ) =>
      await commitAs(
        store,
        schemaHash,
        [
          {
            op: "patch",
            table: "tickets",
            id,
            fields,
            unset: [],
          },
        ],
        by,
        inTeams
      );
    await commitAs(
      store,
      schemaHash,
      [
        {
          op: "insert",
          table: "tickets",
          id,
          fields: { title: "Support 0", team: "support" },
        },
      ],
      "bob",
      ["support"]
    );
    let revision = 1;
    for (let edit = 1; edit <= 5; edit += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one commit after the other
      await patch({ title: `Support ${edit}` }, revision, "bob", ["support"]);
      revision += 1;
    }
    await patch({ team: "sales" }, revision, "carol", ["support", "sales"]);
    revision += 1;
    // More changes in Sales than one read of the history takes at once.
    const inSales = 110;
    for (let edit = 1; edit <= inSales; edit += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one commit after the other
      await patch({ title: `Sales ${edit}` }, revision, "ada", ["sales"]);
      revision += 1;
    }
    const scope = {
      schemaHash,
      principal: "ada",
      appMember: true,
      appBuilder: false,
      teams: ["sales"],
      consumer: consumer(1),
    };
    const pages: number[] = [];
    const shownTitles: unknown[] = [];
    let before: number | null = null;
    do {
      // oxlint-disable-next-line no-await-in-loop -- a page after the other
      const page = await store.history(scope, "tickets", id, before);
      pages.push(page.changes.length);
      shownTitles.push(...page.changes.map(({ after }) => after?.title));
      before = page.next;
    } while (before !== null);
    // Ada's 110 edits, newest first; none of Support's, nor the move.
    expect({
      pages,
      first: shownTitles[0],
      last: shownTitles.at(-1),
    }).toStrictEqual({
      pages: [50, 50, 10],
      first: `Sales ${inSales}`,
      last: "Sales 1",
    });
  });
});

describe("a version's review", () => {
  it("shows each table's row rules as the version declares them", async () => {
    const fixture = await appWith(
      testApp({
        name: "Requests",
        tables: {
          requests: {
            fields: {
              title: "v.string()",
              team: "v.string()",
              assignee: "v.person()",
            },
            access: {
              read: "appMembers",
              write: "appMembers",
              rows: {
                read: [
                  { kind: "owner" },
                  { kind: "team", field: "team" },
                  { kind: "role", role: "builder" },
                ],
                write: [{ kind: "person", field: "assignee" }],
              },
            },
          },
          tags: {
            fields: { name: "v.string()" },
            access: { read: "appMembers", write: "appBuilders" },
          },
          deals: {
            fields: { name: "v.string()", team: "v.string()" },
            access: {
              read: "appMembers",
              write: "appMembers",
              rows: { read: [{ kind: "team", field: "team" }] },
            },
          },
          memos: {
            fields: { text: "v.string()", team: "v.string()" },
            access: {
              read: "appMembers",
              write: "owner",
              rows: { read: [{ kind: "team", field: "team" }] },
            },
          },
          notes: {
            fields: { text: "v.string()", team: "v.string()" },
            access: {
              read: "appMembers",
              write: "none",
              rows: { read: [{ kind: "team", field: "team" }] },
            },
          },
        },
      })
    );
    const review = await reviewVersion(env, fixture.owner, fixture.app, 1);
    // Only the tables that have rules: the other is its access mode's
    // alone. Writes are shown as the store holds them: read rules stand
    // for writing too where there are no write rules, an `owner` mode
    // writes its owner's rows among those, and `none` writes none.
    expect(review.rowRules).toStrictEqual([
      {
        table: "requests",
        read: [
          { kind: "owner" },
          { kind: "team", field: "team" },
          { kind: "role", role: "builder" },
        ],
        write: [{ kind: "person", field: "assignee" }],
      },
      {
        table: "deals",
        read: [{ kind: "team", field: "team" }],
        write: [{ kind: "team", field: "team" }],
      },
      {
        table: "memos",
        read: [{ kind: "team", field: "team" }],
        write: [{ kind: "owner" }],
      },
      {
        table: "notes",
        read: [{ kind: "team", field: "team" }],
        write: null,
      },
    ]);
  });
});

describe("writing a table with row rules", () => {
  it("lets someone change only rows its write rules admit them to, and answers any other as missing", async () => {
    const of = await world();
    const ids = await filled(of);
    const edit = async (by: Acting, title: string) =>
      outcome(
        await call(of, by, "retitle", {
          id: idIn(ids, title),
          title: `${title} (edited)`,
        })
      );
    expect({
      // Readable through Sales, but no write rule is about a team.
      adaTeamRow: await edit(of.ada, "sales follow up alpha"),
      adaOtherTeam: await edit(of.ada, "support ticket alpha"),
      adaAssigned: await edit(of.ada, "handed to ada alpha"),
      carolAny: await edit(of.carol, "board alpha"),
      adaRemovesHidden: outcome(
        await call(of, of.ada, "removeRequest", {
          id: idIn(ids, "support ticket alpha"),
        })
      ),
    }).toStrictEqual({
      adaTeamRow: "data.conflict",
      adaOtherTeam: "data.conflict",
      adaAssigned: null,
      carolAny: null,
      adaRemovesHidden: "data.conflict",
    });
    // Nothing of a refused write landed.
    expect(
      outcome(
        await call(of, of.bob, "getRequest", {
          id: idIn(ids, "support ticket alpha"),
        })
      )
    ).toBe("support ticket alpha");
  });

  it("refuses a write that would move a row out of the writer's reach, and lets one whose rules still hold make it", async () => {
    const of = await world();
    const ids = await filled(of);
    const id = idIn(ids, "handed to ada alpha");
    expect({
      // Ada may change it as its assignee, but handing it on would leave
      // her no rule to change it by.
      adaHandsOn: outcome(
        await call(of, of.ada, "assign", { id, assignee: of.bob.userId })
      ),
      adaReplaces: outcome(
        await call(of, of.ada, "replaceRequest", {
          id,
          title: "handed to ada alpha",
          team: of.support,
          assignee: of.bob.userId,
          status: "won",
          amount: 5,
        })
      ),
      // Bob owns it: he still does after.
      bobHandsOn: outcome(
        await call(of, of.bob, "assign", { id, assignee: of.carol.userId })
      ),
    }).toStrictEqual({
      adaHandsOn: "data.write_denied",
      adaReplaces: "data.write_denied",
      bobHandsOn: null,
    });
  });

  it("refuses an insert its rules wouldn't let the writer reach, by team", async () => {
    const of = await world();
    const ownTeam = await call(of, of.ada, "addAccount", {
      name: "Acme",
      team: of.sales,
    });
    expect({
      ownTeam: typeof outcome(ownTeam),
      otherTeam: outcome(
        await call(of, of.ada, "addAccount", {
          name: "Globex",
          team: of.support,
        })
      ),
      // Bob reads Ada's account (the table's mode), but changes none of
      // Sales'.
      bobRenames: outcome(
        await call(of, of.bob, "renameAccount", {
          id: idOf(ownTeam),
          name: "Acme (Bob)",
        })
      ),
    }).toStrictEqual({
      ownTeam: "string",
      otherTeam: "data.write_denied",
      bobRenames: "data.conflict",
    });
    // Bob joins Sales: from his next call, he may.
    await joinTeam(of.sales, of.bob);
    expect(
      outcome(
        await call(of, of.bob, "renameAccount", {
          id: idOf(ownTeam),
          name: "Acme (Bob)",
        })
      )
    ).toBeNull();
  });

  it("deletes the rows a deletion cascades to as the schema says, whoever can read them", async () => {
    const of = await world();
    const ids = await filled(of);
    const id = idIn(ids, "handed to ada alpha");
    await call(of, of.bob, "addNote", { request: id, text: "Bob's own note" });
    const before = outcome(await call(of, of.bob, "countNotes"));
    // Ada may delete it, as its assignee: Bob's note, which she can't
    // read, goes with it, as `onDelete: "cascade"` declares.
    const removed = outcome(await call(of, of.ada, "removeRequest", { id }));
    expect({
      before,
      adaSees: outcome(await call(of, of.ada, "countNotes")),
      removed,
      after: outcome(await call(of, of.bob, "countNotes")),
    }).toStrictEqual({ before: 1, adaSees: 0, removed: null, after: 0 });
  });
});

describe("deleting a record a row the rules hide refers to", () => {
  it("refuses, naming only the record deleted, never the row that refers to it", async () => {
    // Plans everyone reads; holds on them each read by their team.
    const text = manifestText(
      schemaManifest(
        defineSchema({
          plans: defineTable({ title: v.string() }).access({
            read: "appMembers",
            write: "appMembers",
          }),
          holds: defineTable({
            plan: v.id("plans"),
            reason: v.string(),
            team: v.string(),
          }).access({
            read: "appMembers",
            write: "appMembers",
            rows: { read: [rows.team("team")] },
          }),
        })
      )
    );
    const store = await openStore(
      env,
      await storeOfNewApp(env, await person("builder"))
    );
    const { schemaHash } = await store.applySchema(applied(text));
    const plan = newRecordId();
    await commitAs(
      store,
      schemaHash,
      [{ op: "insert", table: "plans", id: plan, fields: { title: "Launch" } }],
      "ada",
      ["sales"]
    );
    // Bob, in Support, holds Ada's plan for a reason only Support reads.
    await commitAs(
      store,
      schemaHash,
      [
        {
          op: "insert",
          table: "holds",
          id: newRecordId(),
          fields: { plan, reason: "Legal review", team: "support" },
        },
      ],
      "bob",
      ["support"]
    );

    const refused = await refusalOf(
      async () =>
        await commitAs(
          store,
          schemaHash,
          [{ op: "delete", table: "plans", id: plan }],
          "ada",
          ["sales"]
        )
    );

    // That something refers to the plan can't be kept from Ada: deleting
    // it would leave the hold dangling. What refers to it, and why, is.
    expect(refused).toStrictEqual({
      code: "data.referenced",
      details: { table: "plans", id: plan },
    });
  });
});
