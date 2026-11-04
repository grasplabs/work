import { GraspClient } from "@grasp-os/sdk/host";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
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
  salaries: defineTable({ person: v.string(), amount: v.number() }).sensitive(),
  notes: defineTable({ text: v.string(), salary: v.id("salaries").optional() }),
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
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { leak, note, notes, pay, probe, salaries } from "./operations/pay.ts";
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
  operations: { pay: { leak, note, notes, pay, probe, salaries } },
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

  it("can't be kept off the record by App code failing, or catching what a read failed with", async () => {
    const fixture = await payrollApp();
    await payroll(fixture, 2);
    const after = await logHead();

    const leaked = await call(fixture, "pay.leak");
    const probed = await call(fixture, "pay.probe");
    const recorded = await readsOf(fixture.app, after, [
      "function",
      "reads",
      "rows",
    ]);

    expect({
      leaked: valueOf(leaked),
      probed: valueOf(probed),
      recorded: recorded.toSorted((one, other) =>
        String(one.function).localeCompare(String(other.function))
      ),
    }).toStrictEqual({
      leaked: "leak.failed",
      probed: "data.not_unique",
      recorded: [
        { function: "pay.leak", reads: 1, rows: 2 },
        // `unique` read two records to know there were more than one.
        { function: "pay.probe", reads: 1, rows: 2 },
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
