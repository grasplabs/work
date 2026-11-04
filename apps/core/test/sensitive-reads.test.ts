import { GraspClient } from "@grasp-os/sdk/host";
import { appDataImportLimits } from "@grasp-os/shared/app-data";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import type { Role } from "@grasp-os/shared/roles";
import {
  queryMaxScannedBytes,
  queryMaxScannedEntries,
} from "@grasp-os/shared/store-limits";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { AppDataRpc } from "../src/app-data.ts";
import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { identify } from "../src/auth/identity.ts";
import { release } from "./apps.ts";
import { eventsAfter, logHead } from "./audit-events.ts";
import { apiOf, notesFiles } from "./notes-client-app.ts";
import {
  eventually,
  mockSessionIdp,
  openedApp,
  pageTransport,
  reading,
  shown,
} from "./screen-client.ts";
import { signedInApi } from "./sign-in.ts";

// Reads of a table its schema declares sensitive (core's
// sensitive-reads.ts), from its threat model: every read App code makes
// of one is recorded, once a call for each function and table however
// many reads and records, with who read, through which function and how
// many records; a read of any other table records nothing; a read that
// answered none is recorded too; a live query's every push is; and App
// code can't keep a read off the record by failing, or by catching what
// a read failed with.

const idp = mockSessionIdp();

const files: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  salaries: defineTable({ person: v.string(), amount: v.number() })
    .index("by_person", ["person"])
    .searchIndex(["person"])
    .sensitive(),
  notes: defineTable({
    text: v.string(),
    salary: v.id("salaries").optional(),
    payslips: v.array(v.id("salaries")).optional(),
  }),
});
`,
  "operations/pay.ts": `import { AppError, v } from "@grasp-os/sdk";
import { mutation, query } from "#grasp/server";

export const pay = mutation({
  args: { person: v.string(), amount: v.number() },
  returns: v.id("salaries"),
  handler: async (ctx, args) => await ctx.db.insert("salaries", args),
});

export const note = mutation({
  args: { text: v.string(), salary: v.id("salaries").optional() },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

/** Two reads of the salaries: every one, then the first again. */
export const salaries = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const all = await ctx.db.query("salaries").take(100);
    await ctx.db.query("salaries").first();
    return all.length;
  },
});

/** The notes, with the salary each names. */
export const notes = query({
  args: { related: v.boolean() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const found = args.related
      ? await ctx.db.query("notes").with("salary").take(100)
      : await ctx.db.query("notes").take(100);
    return found.length;
  },
});

/** As many salaries as asked, each of as many letters: their IDs. */
export const stuff = mutation({
  args: { count: v.number(), size: v.number() },
  returns: v.array(v.id("salaries")),
  handler: async (ctx, args) => {
    const ids = [];
    for (let at = 0; at < args.count; at += 1) {
      ids.push(await ctx.db.insert("salaries", { person: "x".repeat(args.size), amount: at }));
    }
    return ids;
  },
});

/** A note naming the payslips given. */
export const bundle = mutation({
  args: { payslips: v.array(v.id("salaries")) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", { text: "Bundle", payslips: args.payslips }),
});

/** The notes with their payslips, or the code that read failed with, caught. */
export const bundles = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    try {
      return String((await ctx.db.query("notes").with("payslips").take(100)).length);
    } catch (error) {
      return String(Reflect.get(Object(error), "code"));
    }
  },
});

/** How many salaries a search finds, or the code it failed with, caught. */
export const find = query({
  args: { text: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    try {
      return String(await ctx.db.search("salaries", args.text).count());
    } catch (error) {
      return String(Reflect.get(Object(error), "code"));
    }
  },
});

/** Whom a search finds first, or none. */
export const lookup = query({
  args: { text: v.string() },
  returns: v.string(),
  handler: async (ctx, args) =>
    (await ctx.db.search("salaries", args.text).first())?.person ?? "none",
});

/** Reads the salaries, then fails. */
export const leak = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    await ctx.db.query("salaries").take(100);
    throw new AppError("leak.failed", "Failed on purpose.");
  },
});

/** Whether more than one salary is there, told by \`unique\` failing. */
export const probe = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    try {
      await ctx.db.query("salaries").unique();
      return "one";
    } catch (error) {
      return String(Reflect.get(Object(error), "code"));
    }
  },
});

/** One person's exact salary, as the greatest of theirs. */
export const highest = query({
  args: { person: v.string() },
  returns: v.number().nullable(),
  handler: async (ctx, args) =>
    await ctx.db
      .query("salaries")
      .withIndex("by_person", (range) => range.eq("person", args.person))
      .aggregate({ operation: "max", field: "amount" }),
});

/** Who is paid: the salaries' people, by group. */
export const byPerson = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) =>
    (await ctx.db.query("salaries").group({ by: ["person"] })).length,
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { bundle, bundles, byPerson, find, highest, leak, lookup, note, notes, pay, probe, salaries, stuff } from "./operations/pay.ts";
import schema from "./schema.ts";

export default app({
  name: "Payroll",
  schema,
  access: {
    tables: {
      salaries: { read: "appMembers", write: "appMembers" },
      notes: { read: "appMembers", write: "appMembers" },
    },
  },
  operations: { pay: { bundle, bundles, byPerson, find, highest, leak, lookup, note, notes, pay, probe, salaries, stuff } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
  "screens/pay.tsx": `export default function Pay() {
  return <p>Pay</p>;
}
`,
};

type Person = Awaited<ReturnType<typeof signedInApi>> & { role: Role };

/** A builder's Payroll App, released and published. */
const payrollApp = async () => {
  const builder: Person = {
    ...(await signedInApi(idp, "builder")),
    role: "builder",
  };
  const { id } = await builder.api.apps.create({ name: "Payroll" });
  const version = await release(builder, id, files);
  return { builder, app: id, version };
};

type Payroll = Awaited<ReturnType<typeof payrollApp>>;

/** What calling `path` of the App with `input` answered its builder. */
const call = async (
  { builder, app, version }: Payroll,
  path: string,
  input: Json = {}
): Promise<OperationResult> => {
  const current = await loadRelease(env, appIdSchema.parse(app), version);
  const { result } = await callAppFunction(
    env,
    { userId: builder.userId, role: builder.role, teams: [] },
    app,
    JSON.stringify({
      reference: {
        resourceId: current.manifest.resourceId,
        resourceVersion: current.manifest.resourceVersion,
        contractId: path,
        fingerprint: current.fingerprints[path] ?? "",
        kind: current.app.operations[path]?.kind ?? "query",
      },
      input,
    }),
    Date.now() + 30_000
  );
  return result;
};

/** What `call` answered, or the code it failed with. */
const valueOf = (result: OperationResult): Json =>
  result.ok ? result.value : result.error.code;

/** The sensitive reads of App `app` recorded after log position `after`. */
const recordedOf = async (
  app: string,
  after: number
): Promise<AuditEvent[]> => {
  const events = await eventsAfter(after);
  return events.filter(
    ({ action, target }) => action === "app.data.read" && target?.id === app
  );
};

/** The `keys` of the details of `recordedOf`. */
const readsOf = async (
  app: string,
  after: number,
  keys: readonly string[]
): Promise<Record<string, unknown>[]> => {
  const recorded = await recordedOf(app, after);
  return recorded.map(({ detail }) =>
    Object.fromEntries(keys.map((key) => [key, detail[key]]))
  );
};

/**
 * Payslips enough that their bytes pass a read's scan bound
 * (`queryMaxScannedBytes`), made a mutation's staged bytes at a time.
 */
const payslipLetters = 120_000;
const payslipsPerBatch = 5;
const payslipBatches =
  Math.ceil(queryMaxScannedBytes / payslipLetters / payslipsPerBatch) + 1;

/** Pays `count` people. */
const payroll = async (payrollFixture: Payroll, count: number) => {
  for (let paid = 0; paid < count; paid += 1) {
    // One after the other, as a person would.
    // oxlint-disable-next-line no-await-in-loop -- see above
    await call(payrollFixture, "pay.pay", {
      person: `Person ${paid}`,
      amount: 1000 + paid,
    });
  }
};

/** Imports `count` salaries through the data page. */
const importSalaries = async (
  { builder, app, version }: Payroll,
  count: number
): Promise<void> => {
  const people = Array.from(
    { length: count },
    (_person, at) => `Person ${at},${1000 + at}`
  );
  const imported = await builder.api.apps.data.import(app, "salaries", {
    version,
    csv: ["person,amount", ...people].join("\n"),
    mapping: { person: "person", amount: "amount" },
  });
  expect(imported).toStrictEqual({ ok: true, inserted: count });
};

/**
 * The App's data over `/rpc` for its builder, on `on`: read here a pull at
 * a time, as a client takes a page in, where a connection's transport may
 * read ahead of the client.
 */
const exportRpc = ({ builder }: Payroll, on: Env = env): AppDataRpc => {
  const headers = new Headers({ cookie: builder.session });
  return new AppDataRpc(on, async () => {
    const identity = await identify(env, headers);
    if (!identity) {
      throw new Error("Session ended");
    }
    return identity;
  });
};

/**
 * `env`, whose stores' reads wait while held: `hold` holds the next ones
 * and resolves once one waits; `release` lets them go.
 */
const heldStoreReads = () => {
  let gate: Promise<null> | undefined;
  let open: ((value: null) => void) | undefined;
  let entered: ((value: null) => void) | undefined;
  const holding = <Stub extends object>(stub: Stub): Stub =>
    new Proxy(stub, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        if (property !== "read") {
          const bound: unknown = value.bind(target);
          return bound;
        }
        return async (...args: unknown[]): Promise<unknown> => {
          entered?.(null);
          await gate;
          return await Reflect.apply(value, target, args);
        };
      },
    });
  const namespace = <Namespace extends object>(target: Namespace): Namespace =>
    new Proxy(target, {
      get: (inner, property) => {
        const value: unknown = Reflect.get(inner, property);
        if (typeof value !== "function") {
          return value;
        }
        if (property === "jurisdiction") {
          return (...args: unknown[]): unknown => {
            const scoped: unknown = Reflect.apply(value, inner, args);
            return typeof scoped === "object" && scoped !== null
              ? namespace(scoped)
              : scoped;
          };
        }
        if (property === "getByName") {
          return (...args: unknown[]): unknown => {
            const stub: unknown = Reflect.apply(value, inner, args);
            return typeof stub === "object" && stub !== null
              ? holding(stub)
              : stub;
          };
        }
        const bound: unknown = value.bind(inner);
        return bound;
      },
    });
  return {
    env: { ...env, DATA_STORES: namespace(env.DATA_STORES) },
    hold: async (): Promise<void> => {
      const held = Promise.withResolvers<null>();
      gate = held.promise;
      open = held.resolve;
      const waiting = Promise.withResolvers<null>();
      entered = waiting.resolve;
      await waiting.promise;
    },
    release: () => {
      open?.(null);
    },
  };
};

describe("reads of a sensitive table", { timeout: 120_000 }, () => {
  it("are recorded once a call, with who read, through which function and how many records", async () => {
    const fixture = await payrollApp();
    await payroll(fixture, 3);
    const after = await logHead();

    const read = await call(fixture, "pay.salaries");

    const recorded = await recordedOf(fixture.app, after);

    expect({
      read: valueOf(read),
      recorded: recorded.map(({ actor, requestId, detail }) => ({
        actor,
        requestId: typeof requestId,
        detail,
      })),
    }).toStrictEqual({
      read: 3,
      recorded: [
        {
          actor: { type: "person", userId: fixture.builder.userId },
          requestId: "string",
          detail: {
            version: fixture.version,
            person: fixture.builder.userId,
            runId: null,
            via: "function",
            function: "pay.salaries",
            table: "salaries",
            // Two reads, the first answering every salary, the second one.
            reads: 2,
            rows: 4,
          },
        },
      ],
    });
  });

  it("records nothing for a read of a table that isn't sensitive", async () => {
    const fixture = await payrollApp();
    await call(fixture, "pay.note", { text: "Lunch on Friday" });
    const after = await logHead();

    const read = await call(fixture, "pay.notes", { related: false });

    const recorded = await recordedOf(fixture.app, after);

    expect({ read: valueOf(read), recorded }).toStrictEqual({
      read: 1,
      recorded: [],
    });
  });

  it("records a read that answered no records", async () => {
    // A read that answered none is recorded with no rows: a filter on a
    // sensitive table's fields that matched nothing still tells what
    // they don't hold, so leaving it out would let App code probe them
    // off the record.
    const fixture = await payrollApp();
    const after = await logHead();

    const read = await call(fixture, "pay.salaries");

    expect({
      read: valueOf(read),
      recorded: await readsOf(fixture.app, after, ["reads", "rows"]),
    }).toStrictEqual({ read: 0, recorded: [{ reads: 2, rows: 0 }] });
  });

  it("records the sensitive records a read of another table loads as related ones", async () => {
    const fixture = await payrollApp();
    await payroll(fixture, 2);
    const salary = valueOf(
      await call(fixture, "pay.pay", { person: "Someone", amount: 1 })
    );
    await call(fixture, "pay.note", { text: "Raise", salary });
    await call(fixture, "pay.note", { text: "Another" });
    const after = await logHead();

    const read = await call(fixture, "pay.notes", { related: true });

    expect({
      read: valueOf(read),
      recorded: await readsOf(fixture.app, after, [
        "function",
        "table",
        "reads",
        "rows",
      ]),
    }).toStrictEqual({
      read: 2,
      recorded: [
        { function: "pay.notes", table: "salaries", reads: 1, rows: 1 },
      ],
    });
  });

  it("records no read of a sensitive table whose related records were never looked up", async () => {
    // `with("salary")` names the salaries, yet a read whose notes name no
    // salary (none at all, or none that holds one) reads none of them.
    const fixture = await payrollApp();
    await payroll(fixture, 1);
    const after = await logHead();

    const none = await call(fixture, "pay.notes", { related: true });
    await call(fixture, "pay.note", { text: "No salary" });
    const unrelated = await call(fixture, "pay.notes", { related: true });
    const recorded = await recordedOf(fixture.app, after);

    expect({
      none: valueOf(none),
      unrelated: valueOf(unrelated),
      recorded,
    }).toStrictEqual({ none: 0, unrelated: 1, recorded: [] });
  });

  it("can't be kept off the record by App code failing, or catching what a read failed with", async () => {
    const fixture = await payrollApp();
    await payroll(fixture, 2);
    // Another App's note naming more payslips than one read may scan the
    // bytes of.
    const bulky = await payrollApp();
    const payslips: string[] = [];
    for (let batch = 0; batch < payslipBatches; batch += 1) {
      // One batch after the other, each a mutation's worth of bytes.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const stuffed = await call(bulky, "pay.stuff", {
        count: payslipsPerBatch,
        size: payslipLetters,
      });
      payslips.push(...z.array(z.string()).parse(valueOf(stuffed)));
    }
    await call(bulky, "pay.bundle", { payslips });
    const after = await logHead();

    const leaked = await call(fixture, "pay.leak");
    const probed = await call(fixture, "pay.probe");
    const bundled = await call(bulky, "pay.bundles");
    const recorded = [
      ...(await readsOf(fixture.app, after, ["function", "reads", "rows"])),
      ...(await readsOf(bulky.app, after, ["function", "reads", "rows"])),
    ];

    expect({
      leaked: valueOf(leaked),
      probed: valueOf(probed),
      bundled: valueOf(bundled),
      recorded: recorded.toSorted((one, other) =>
        String(one.function).localeCompare(String(other.function))
      ),
    }).toStrictEqual({
      leaked: "leak.failed",
      probed: "data.not_unique",
      bundled: "data.scan_limit",
      recorded: [
        // The payslips' statement ran, and failed past the bytes bound
        // before it answered one.
        { function: "pay.bundles", reads: 1, rows: 0 },
        { function: "pay.leak", reads: 1, rows: 2 },
        // `unique` read two records to know there were more than one.
        { function: "pay.probe", reads: 1, rows: 2 },
      ],
    });
  });

  it("records a search that ran and matched nothing, but not one with no words, which runs nothing", async () => {
    const fixture = await payrollApp();
    await payroll(fixture, 2);
    const after = await logHead();

    const empty = await call(fixture, "pay.lookup", { text: "" });
    const emptyRecorded = await recordedOf(fixture.app, after);
    const missed = await call(fixture, "pay.lookup", { text: "Nobody" });
    const recorded = await readsOf(fixture.app, after, [
      "function",
      "reads",
      "rows",
    ]);

    expect({
      empty: valueOf(empty),
      emptyRecorded,
      missed: valueOf(missed),
      recorded,
    }).toStrictEqual({
      empty: "none",
      emptyRecorded: [],
      missed: "none",
      recorded: [{ function: "pay.lookup", reads: 1, rows: 0 }],
    });
  });

  it("records a search that fails past the scan bound before it reads a record", async () => {
    // The search is refused on its count of matches, before any record is
    // read: the salaries were still looked at, and a refusal tells there
    // are more than the bound.
    const fixture = await payrollApp();
    const batches = Math.ceil(
      (queryMaxScannedEntries + 1) / appDataImportLimits.maxRows
    );
    for (let batch = 0; batch < batches; batch += 1) {
      // One import after the other, as a person would.
      // oxlint-disable-next-line no-await-in-loop -- see above
      await importSalaries(fixture, appDataImportLimits.maxRows);
    }
    const after = await logHead();

    const found = await call(fixture, "pay.find", { text: "Person" });

    expect({
      found: valueOf(found),
      recorded: await readsOf(fixture.app, after, [
        "function",
        "table",
        "reads",
        "rows",
      ]),
    }).toStrictEqual({
      found: "data.scan_limit",
      recorded: [
        { function: "pay.find", table: "salaries", reads: 1, rows: 0 },
      ],
    });
  });

  it("records each page and record the data browser reads", async () => {
    const fixture = await payrollApp();
    await payroll(fixture, 2);
    const after = await logHead();

    const page = await fixture.builder.api.apps.data.records(
      fixture.app,
      "salaries",
      fixture.version,
      null
    );
    await fixture.builder.api.apps.data.records(
      fixture.app,
      "notes",
      fixture.version,
      null
    );

    expect({
      shown: page.records.length,
      recorded: await readsOf(fixture.app, after, [
        "via",
        "function",
        "table",
        "reads",
        "rows",
      ]),
    }).toStrictEqual({
      shown: 2,
      recorded: [
        {
          via: "browser",
          function: null,
          table: "salaries",
          reads: 1,
          rows: 2,
        },
      ],
    });
  });

  it("records an export once, as it ends", async () => {
    const fixture = await payrollApp();
    await payroll(fixture, 2);
    const after = await logHead();

    const csv = await new Response(
      await fixture.builder.api.apps.data.export(fixture.app, "salaries")
    ).text();

    expect({
      lines: csv.trim().split("\n").length,
      recorded: await readsOf(fixture.app, after, ["via", "table", "rows"]),
    }).toStrictEqual({
      lines: 3,
      recorded: [{ via: "export", table: "salaries", rows: 2 }],
    });
  });

  it("records an export the client lets go of after its first page", async () => {
    const fixture = await payrollApp();
    // More than one export page: one page read, and more to come.
    await importSalaries(fixture, 150);
    const after = await logHead();

    const stream = await exportRpc(fixture).export(fixture.app, "salaries");
    const reader = stream.getReader();
    // The header, then the first page.
    await reader.read();
    const page = await reader.read();
    await reader.cancel();

    expect({
      page: new TextDecoder().decode(page.value).trim().split("\n").length,
      recorded: await readsOf(fixture.app, after, [
        "via",
        "table",
        "reads",
        "rows",
      ]),
    }).toStrictEqual({
      page: 100,
      recorded: [{ via: "export", table: "salaries", reads: 1, rows: 100 }],
    });
  });

  it("records the page a pull is reading when the client lets go", async () => {
    const fixture = await payrollApp();
    await importSalaries(fixture, 150);
    const after = await logHead();
    const held = heldStoreReads();
    const stream = await exportRpc(fixture, held.env).export(
      fixture.app,
      "salaries"
    );
    const reader = stream.getReader();
    await reader.read();

    // The first page's read held in the store while the client lets go.
    const entered = held.hold();
    const pending = reader.read();
    await entered;
    const cancelling = reader.cancel();
    held.release();
    await cancelling;
    const ended = await pending;

    expect({
      ended: ended.done,
      recorded: await readsOf(fixture.app, after, [
        "via",
        "table",
        "reads",
        "rows",
      ]),
    }).toStrictEqual({
      ended: true,
      recorded: [{ via: "export", table: "salaries", reads: 1, rows: 100 }],
    });
  });

  it("records the records an aggregate or a group is computed over", async () => {
    // Neither answers a record, yet the greatest salary of one person is
    // their salary, and a group tells each distinct value of its field.
    const fixture = await payrollApp();
    await payroll(fixture, 3);
    const after = await logHead();

    const highest = await call(fixture, "pay.highest", { person: "Person 1" });
    const grouped = await call(fixture, "pay.byPerson");
    const recorded = await readsOf(fixture.app, after, [
      "function",
      "reads",
      "rows",
    ]);

    expect({
      highest: valueOf(highest),
      grouped: valueOf(grouped),
      recorded: recorded.toSorted((one, other) =>
        String(one.function).localeCompare(String(other.function))
      ),
    }).toStrictEqual({
      highest: 1001,
      grouped: 3,
      recorded: [
        { function: "pay.byPerson", reads: 1, rows: 3 },
        { function: "pay.highest", reads: 1, rows: 1 },
      ],
    });
  });
});

describe("a live query of a sensitive table", { timeout: 120_000 }, () => {
  it("is recorded on every push, not only the first", async () => {
    const opened = await openedApp({
      ...notesFiles,
      "schema.ts": (notesFiles["schema.ts"] ?? "").replace(
        '.index("by_updated", ["_updatedAt"])',
        '.index("by_updated", ["_updatedAt"]).sensitive()'
      ),
    });
    const api = apiOf(opened.release);
    const client = new GraspClient(pageTransport(opened, opened.screens));
    const after = await logHead();
    const list = reading(client, api.list, { pagination: { pageSize: 10 } });
    await eventually(() => {
      expect(shown(list.now())).toStrictEqual([]);
    });

    await client.mutation(api.create, { title: "A raise" });
    await eventually(() => {
      expect(shown(list.now())).toStrictEqual(["A raise"]);
    });

    const recorded = await readsOf(opened.app, after, ["function", "rows"]);
    const pushed = recorded
      .filter((read) => read.function === "notes.list")
      .map(({ rows }) => rows);
    list.stop();
    // The first read answered none, and the push after the change the one
    // note (a push may read more than once while changes settle).
    expect({
      first: pushed[0],
      last: pushed.at(-1),
      pushes: pushed.length >= 2,
    }).toStrictEqual({ first: 0, last: 1, pushes: true });
  });
});
