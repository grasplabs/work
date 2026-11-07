import { schemaHash } from "@grasp-os/sdk/host";
import type { RecordChange } from "@grasp-os/shared/app-data";
import { recordChangeLimits } from "@grasp-os/shared/app-data";
import type { AuditActor } from "@grasp-os/shared/audit";
import {
  appIdSchema,
  chatIdSchema,
  runIdSchema,
  workflowIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { mintRecordId } from "@grasp-os/shared/record-ids";
import type { Role } from "@grasp-os/shared/roles";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { AppDataRpc } from "../src/app-data.ts";
import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { identify } from "../src/auth/identity.ts";
import { openStore } from "../src/data-stores.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { appDefinition, withSensitive } from "./app-definitions.ts";
import { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// An App's data from its page (core's app-data.ts) and the change history
// its store keeps (store-changes.ts), from their threat model: a change
// nobody can attribute, or one whose fields go unrecorded; a sensitive
// table's values copied into the history; someone who doesn't build the
// App reading, exporting or importing its data; an import landing half
// of a file; and a table that doesn't come back as it went out.

const idp = mockIdp();

const files: Record<string, string> = {
  ...appDefinition({
    name: "Notes",
    tables: {
      notes: {
        fields: {
          title: "v.string().min(1).max(200)",
          status: "v.string().optional()",
          done: "v.boolean().default(false)",
          tags: "v.array(v.string()).default([])",
        },
        access: { read: "appMembers", write: "appMembers" },
      },
      salaries: {
        fields: { person: "v.string()", amount: "v.number()" },
        sensitive: true,
        access: { read: "appMembers", write: "appMembers" },
      },
      pins: {
        fields: { text: "v.string()" },
        access: { read: "owner", write: "owner" },
      },
      // Each task read by the person it's for alone: a row rule.
      tasks: {
        fields: { title: "v.string()", assignee: "v.person()" },
        access: {
          read: "appMembers",
          write: "appMembers",
          rows: { read: [{ kind: "person", field: "assignee" }] },
        },
      },
      labels: {
        fields: {
          name: "v.string()",
          nick: "v.string().nullable()",
          note: "v.string().optional()",
          extra: "v.string().nullable().optional()",
        },
        access: { read: "appMembers", write: "appMembers" },
      },
    },
  }),
  "server/notes.ts": `import { mutation } from "@server/_generated/server";
import { v } from "@grasp-os/sdk";

export const create = mutation({
  args: { title: v.string().min(1).max(200), status: v.string().optional() },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const rename = mutation({
  args: { id: v.id("notes"), title: v.string().min(1).max(200) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const found = await ctx.db.get("notes", args.id);
    if (found !== null) {
      await ctx.db.patch("notes", args.id, { title: args.title }, { expectedRevision: found._rev });
    }
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const found = await ctx.db.get("notes", args.id);
    if (found !== null) {
      await ctx.db.delete("notes", args.id, { expectedRevision: found._rev });
    }
    return null;
  },
});

export const label = mutation({
  args: {
    name: v.string(),
    nick: v.string().nullable(),
    note: v.string().optional(),
    extra: v.string().nullable().optional(),
  },
  returns: v.id("labels"),
  handler: async (ctx, args) => await ctx.db.insert("labels", args),
});

export const pin = mutation({
  args: { text: v.string() },
  returns: v.id("pins"),
  handler: async (ctx, args) => await ctx.db.insert("pins", args),
});

export const pay = mutation({
  args: { person: v.string(), amount: v.number() },
  returns: v.id("salaries"),
  handler: async (ctx, args) => await ctx.db.insert("salaries", args),
});
`,

  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Notes() {
  return <p>Notes</p>;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
};

type Person = Awaited<ReturnType<typeof signedInApi>> & { role: Role };

const personApi = async (role: Role): Promise<Person> => ({
  ...(await signedInApi(idp, role)),
  role,
});

/** A builder's Notes App, released and published. */
const notesApp = async () => {
  const builder = await personApi("builder");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const version = await release(builder, id, files);
  return { builder, app: id, version };
};

type Notes = Awaited<ReturnType<typeof notesApp>>;

/**
 * Calls `path` of the App as `by` (a page's call), or as an agent acting
 * for them: what it answered.
 */
const call = async (
  { app }: Notes,
  by: Person,
  path: string,
  input: Json,
  agentId?: string
): Promise<unknown> => {
  const answer = await callAppFunction(
    env,
    { userId: by.userId, role: by.role, teams: [] },
    app,
    JSON.stringify({
      reference: { name: path, kind: "mutation" },
      input,
    }),
    Date.now() + 30_000,
    undefined,
    undefined,
    agentId === undefined
      ? undefined
      : {
          agentId,
          workspaceId: workspaceIdSchema.parse(crypto.randomUUID()),
          chatId: chatIdSchema.parse(crypto.randomUUID()),
        }
  );
  if (!answer.result.ok) {
    throw new Error(`${path} failed: ${answer.result.error.code}`);
  }
  return answer.result.value;
};

/** The whole history of `table`'s record `id`, newest first. */
const historyOf = async (
  { builder, app, version }: Notes,
  table: string,
  id: string
): Promise<RecordChange[]> => {
  const changes: RecordChange[] = [];
  let before: number | null = null;
  do {
    // oxlint-disable-next-line no-await-in-loop -- a page after the other
    const page = await builder.api.apps.data.history(
      app,
      table,
      version,
      id,
      before
    );
    changes.push(...page.changes);
    before = page.next;
  } while (before !== null);
  return changes;
};

/** Every record of `table`, as the data browser pages through it. */
const everyRecord = async ({ builder, app, version }: Notes, table: string) => {
  const records = [];
  let cursor: string | null = null;
  do {
    // oxlint-disable-next-line no-await-in-loop -- a page after the other
    const page = await builder.api.apps.data.records(
      app,
      table,
      version,
      cursor
    );
    records.push(...page.records);
    ({ cursor } = page);
  } while (cursor !== null);
  return records;
};

/** `table` as its CSV export streams it. */
const exported = async ({ builder, app }: Notes, table: string) => {
  const stream = await builder.api.apps.data.export(app, table);
  return await new Response(stream).text();
};

/** The fields of `records`, in the order of their titles. */
const byTitle = (records: readonly { fields: Record<string, unknown> }[]) =>
  records
    .map(({ fields }) => fields)
    .toSorted((left, right) =>
      String(left.title).localeCompare(String(right.title))
    );

/** The fields of `records`, in the order of their names. */
const byName = (records: readonly { fields: Record<string, unknown> }[]) =>
  records
    .map(({ fields }) => fields)
    .toSorted((left, right) =>
      String(left.name).localeCompare(String(right.name))
    );

/** A CSV of four notes, the second without a title, the third's `done` not one. */
const badCsv = [
  "Title,Status,done",
  "First,open,false",
  ",open,true",
  "Third,,maybe",
  "Fourth,done,true",
].join("\n");

describe("an App's data, from its page", { timeout: 120_000 }, () => {
  it("records every change in the store, with who made it, when, and the fields it changed", async () => {
    const notes = await notesApp();
    const { builder } = notes;
    const started = Date.now();
    const id = await call(notes, builder, "notes.create", {
      title: "Plan",
      status: "open",
    });
    if (typeof id !== "string") {
      throw new TypeError("Expected the note's ID");
    }
    await call(
      notes,
      builder,
      "notes.rename",
      { id, title: "Plan B" },
      "grasp"
    );
    await call(notes, builder, "notes.remove", { id });

    const [removed, renamed, created] = await historyOf(notes, "notes", id);
    expect(created).toMatchObject({
      record: id,
      table: "notes",
      op: "insert",
      source: "commit",
      actor: { type: "person", userId: builder.userId },
      fields: ["done", "status", "tags", "title"],
      before: {},
      after: { title: "Plan", status: "open", done: false, tags: [] },
      valuesLeftOut: null,
    });
    expect(Date.parse(created?.at ?? "")).toBeGreaterThanOrEqual(
      started - 1000
    );
    // The agent acting for the builder, and only the field it changed.
    expect(renamed).toMatchObject({
      op: "update",
      actor: { type: "agent", agentId: "grasp", onBehalfOf: builder.userId },
      fields: ["title"],
      before: { title: "Plan" },
      after: { title: "Plan B" },
    });
    expect(removed).toMatchObject({
      op: "delete",
      actor: { type: "person", userId: builder.userId },
      fields: ["done", "status", "tags", "title"],
      before: { title: "Plan B", status: "open" },
      after: {},
    });
    // Gone from the table, its history still there for the App's builders.
    await expect(
      builder.api.apps.data.record(notes.app, "notes", notes.version, id)
    ).resolves.toBeNull();
  });

  it("keeps which fields changed in a table declared sensitive, never their values", async () => {
    const notes = await notesApp();
    const id = await call(notes, notes.builder, "notes.pay", {
      person: "Ada",
      amount: 5000,
    });
    if (typeof id !== "string") {
      throw new TypeError("Expected the salary's ID");
    }
    const tables = await notes.builder.api.apps.data.tables(notes.app);
    expect(tables.tables.find(({ name }) => name === "salaries")).toMatchObject(
      { sensitive: true }
    );
    const [paid] = await historyOf(notes, "salaries", id);
    expect(paid).toMatchObject({
      op: "insert",
      fields: ["amount", "person"],
      before: null,
      after: null,
      valuesLeftOut: "sensitive",
    });
    // The record itself reads as it is, to whoever may read the table.
    await expect(
      notes.builder.api.apps.data.record(
        notes.app,
        "salaries",
        notes.version,
        id
      )
    ).resolves.toMatchObject({ fields: { person: "Ada", amount: 5000 } });
  });

  it("opens an App's data to its builders and the organization's admins, and to nobody else", async () => {
    const notes = await notesApp();
    const { app, builder } = notes;
    await call(notes, builder, "notes.create", { title: "Plan" });
    const [admin, user, stranger] = await Promise.all([
      personApi("admin"),
      personApi("user"),
      personApi("builder"),
    ]);
    // Someone the App is shared with to use it, and another builder it
    // isn't shared with at all.
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const csv = "title\nSneaked in\n";
    for (const outsider of [user, stranger]) {
      const { data } = outsider.api.apps;
      // oxlint-disable-next-line no-await-in-loop -- one outsider at a time
      const refusals = await Promise.all([
        outcome(data.tables(app)),
        outcome(data.records(app, "notes", notes.version, null)),
        outcome(data.export(app, "notes")),
        outcome(data.previewImport(app, "notes", csv)),
        outcome(
          data.import(app, "notes", {
            version: notes.version,
            csv,
            mapping: { title: "title" },
          })
        ),
      ]);
      expect(new Set(refusals)).toStrictEqual(
        new Set([outsider === user ? "role.forbidden" : "app.not_found"])
      );
    }
    const records = await admin.api.apps.data.records(
      app,
      "notes",
      notes.version,
      null
    );
    expect(records.records.map(({ fields }) => fields.title)).toStrictEqual([
      "Plan",
    ]);
  });

  it("lands nothing from an import with a bad row, and says which row and why", async () => {
    const notes = await notesApp();
    const { app, builder } = notes;
    const csv = badCsv;
    const preview = await builder.api.apps.data.previewImport(
      app,
      "notes",
      csv
    );
    expect(preview).toStrictEqual({
      columns: ["Title", "Status", "done"],
      rows: 4,
      mapping: { Title: "title", Status: "status", done: "done" },
    });
    const result = await builder.api.apps.data.import(app, "notes", {
      version: notes.version,
      csv,
      mapping: preview.mapping,
    });
    expect(result.ok).toBeFalsy();
    if (result.ok) {
      return;
    }
    // The second row has no title; the third's `done` isn't a boolean.
    expect(
      result.errors.map(({ row, field }) => ({ row, field }))
    ).toStrictEqual([
      { row: 2, field: "title" },
      { row: 3, field: "done" },
    ]);
    await expect(everyRecord(notes, "notes")).resolves.toStrictEqual([]);
  });

  it("lands every row of an import as the importer's records, recorded as their import", async () => {
    const notes = await notesApp();
    const { app, builder } = notes;
    const fixed = await builder.api.apps.data.import(app, "notes", {
      version: notes.version,
      csv: badCsv
        .replace(",open,true", "Second,open,true")
        .replace("maybe", "false"),
      mapping: { Title: "title", Status: "status", done: "done" },
    });
    expect(fixed).toStrictEqual({ ok: true, inserted: 4 });
    const records = await everyRecord(notes, "notes");
    expect(byTitle(records).map(({ title }) => title)).toStrictEqual([
      "First",
      "Fourth",
      "Second",
      "Third",
    ]);
    const first = records.find(({ fields }) => fields.title === "First");
    expect(first?.owner).toBe(builder.userId);
    const [imported] = await historyOf(notes, "notes", first?.id ?? "");
    expect(imported).toMatchObject({
      op: "insert",
      source: "import",
      actor: { type: "person", userId: builder.userId },
      after: { title: "First", status: "open", done: false },
    });
    const events = await allEvents();
    expect(
      events.filter(
        ({ action, target }) =>
          action === "app.data.imported" && target?.id === app
      )
    ).toMatchObject([{ detail: { table: "notes", rows: 4 } }]);
  });

  it("counts each table's records as they are added and deleted, and gives no count where a person reads only some, by owner or a row rule", async () => {
    const notes = await notesApp();
    const { builder, app } = notes;
    const counted = async () => {
      const { tables } = await builder.api.apps.data.tables(app);
      return Object.fromEntries(
        tables.map(({ name, records }) => [name, records])
      );
    };
    const before = await counted();
    await builder.api.apps.data.import(app, "notes", {
      version: notes.version,
      csv: "Title\nFirst\nSecond\nThird\n",
      mapping: { Title: "title" },
    });
    const held = await everyRecord(notes, "notes");
    const first = held.find(({ fields }) => fields.title === "First");
    await call(notes, builder, "notes.remove", { id: first?.id ?? "" });
    await call(notes, builder, "notes.pin", { text: "mine" });

    expect({ before, after: await counted() }).toStrictEqual({
      before: { notes: 0, salaries: 0, pins: null, tasks: null, labels: 0 },
      // Three imported, one deleted; an owner table's pins are each
      // person's own, and each task its assignee's, so neither whole
      // count is anybody's to see here.
      after: { notes: 2, salaries: 0, pins: null, tasks: null, labels: 0 },
    });
  });

  it("round-trips a table through its CSV export and an import", async () => {
    const notes = await notesApp();
    const { builder } = notes;
    const titles = [
      "Plain",
      "With, a comma",
      'With "quotes"',
      "Two\nlines",
      "=SUM(A1:A2)",
      "'quoted",
    ];
    for (const title of titles) {
      // oxlint-disable-next-line no-await-in-loop -- one note at a time
      await call(notes, builder, "notes.create", { title, status: "" });
    }
    const csv = await exported(notes, "notes");
    // A formula is never one in a spreadsheet.
    expect(csv).toContain("'=SUM(A1:A2)");
    const before = await everyRecord(notes, "notes");

    const other = await notesApp();
    const preview = await other.builder.api.apps.data.previewImport(
      other.app,
      "notes",
      csv
    );
    expect(preview.mapping).toStrictEqual({
      _id: null,
      done: "done",
      status: "status",
      tags: "tags",
      title: "title",
    });
    await expect(
      other.builder.api.apps.data.import(other.app, "notes", {
        version: other.version,
        csv,
        mapping: preview.mapping,
      })
    ).resolves.toStrictEqual({ ok: true, inserted: before.length });
    const after = await everyRecord(other, "notes");
    expect(byTitle(after)).toStrictEqual(byTitle(before));
    await expect(exported(other, "notes")).resolves.toStrictEqual(
      expect.stringContaining('"Two\nlines"')
    );
  });

  it("shows a builder only their own records of an owner table, in the browser, the export and the history", async () => {
    const notes = await notesApp();
    const { app, builder } = notes;
    const member = await personApi("user");
    await builder.api.apps.members.add(app, {
      type: "person",
      id: member.userId,
      role: "user",
    });
    await call(notes, builder, "notes.pin", { text: "Builder's pin" });
    const theirs = await call(notes, member, "notes.pin", {
      text: "Member's pin",
    });
    if (typeof theirs !== "string") {
      throw new TypeError("Expected the pin's ID");
    }
    const pins = await everyRecord(notes, "pins");
    expect(pins.map(({ fields }) => fields.text)).toStrictEqual([
      "Builder's pin",
    ]);
    const csv = await exported(notes, "pins");
    expect(csv).toContain("Builder's pin");
    expect(csv).not.toContain("Member's pin");
    await expect(
      builder.api.apps.data.history(app, "pins", notes.version, theirs, null)
    ).resolves.toStrictEqual({ changes: [], next: null });
  });

  it("erases the values of every change made for a person, whoever acted, and keeps who acted", async () => {
    const notes = await notesApp();
    const { builder } = notes;
    const mine = await call(notes, builder, "notes.create", { title: "Mine" });
    if (typeof mine !== "string") {
      throw new TypeError("Expected the note's ID");
    }
    await call(
      notes,
      builder,
      "notes.rename",
      { id: mine, title: "B" },
      "grasp"
    );
    const current = await loadRelease(
      env,
      appIdSchema.parse(notes.app),
      notes.version
    );
    if (current.store === null) {
      throw new Error("Expected the App's store");
    }
    const store = await openStore(env, current.store.storeId);
    const pinned = await schemaHash(current.app.schema);
    /** Inserts a note as a commit of `actor`'s for `principal` does. */
    const insertAs = async (
      principal: string,
      actor: AuditActor
    ): Promise<string> => {
      const claimed = await store.claim({
        scope: {
          principal,
          resource: notes.app,
          binding: null,
          contractId: "notes.create",
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
      const id = mintRecordId();
      await store.commit({
        principal: { userId: principal },
        actor,
        roles: { appMember: true, appBuilder: false },
        schemaHash: pinned,
        stagedAt: Date.now(),
        receipt: claimed.held,
        writes: [
          { op: "insert", table: "notes", id, fields: { title: "Kept" } },
        ],
      });
      return id;
    };
    // A workflow run of the App's, for them; and a note of someone else's.
    const byRun = await insertAs(builder.userId, {
      type: "workflow",
      appId: appIdSchema.parse(notes.app),
      workflowId: workflowIdSchema.parse(crypto.randomUUID()),
      runId: runIdSchema.parse(crypto.randomUUID()),
    });
    const others = await insertAs("someone-else", {
      type: "person",
      userId: "someone-else",
    });

    await inJurisdiction(env, env.DATA_STORES)
      .getByName(store.id)
      .forgetPerson(store.id, builder.userId);

    const erased = [
      ...(await historyOf(notes, "notes", mine)),
      ...(await historyOf(notes, "notes", byRun)),
    ];
    expect(
      erased.map(({ actor, before, after, valuesLeftOut, fields }) => ({
        actor: actor.type,
        before,
        after,
        valuesLeftOut,
        named: fields.length > 0,
      }))
    ).toStrictEqual(
      ["agent", "person", "workflow"].map((actor) => ({
        actor,
        before: null,
        after: null,
        valuesLeftOut: "erased",
        named: true,
      }))
    );
    const [kept] = await historyOf(notes, "notes", others);
    expect(kept).toMatchObject({
      after: { title: "Kept" },
      valuesLeftOut: null,
    });
  });

  it("keeps no values of a table first declared sensitive in a later version, its earlier changes included", async () => {
    const sensitiveFiles = withSensitive(files, "notes");
    expect(sensitiveFiles["server/schema.ts"]).not.toBe(
      files["server/schema.ts"]
    );
    // The first version: notes as they were; then one declaring them sensitive.
    const builder = await personApi("builder");
    const { id: app } = await builder.api.apps.create({ name: "Notes" });
    const version = await release(builder, app, files);
    const notes = { builder, app, version };
    const id = await call(notes, builder, "notes.create", { title: "Plan" });
    if (typeof id !== "string") {
      throw new TypeError("Expected the note's ID");
    }
    const later = await release(builder, app, sensitiveFiles);

    const [created] = await historyOf(
      { ...notes, version: later },
      "notes",
      id
    );
    expect(created).toMatchObject({
      op: "insert",
      fields: ["done", "tags", "title"],
      before: null,
      after: null,
      valuesLeftOut: "sensitive",
    });
    const { tables } = await builder.api.apps.data.tables(app);
    expect(tables.find(({ name }) => name === "notes")?.sensitive).toBeTruthy();
  });

  it("refuses a CSV with more columns than an import takes, before reading its rows", async () => {
    const { builder, app } = await notesApp();
    const columns = Array.from({ length: 257 }, (_, at) => `c${at}`);
    const csv = `${columns.join(",")}\n${columns.map(() => "x").join(",")}\n`;
    await expect(
      outcome(builder.api.apps.data.previewImport(app, "notes", csv))
    ).resolves.toBe("app_data.invalid");
  });

  it("drops aged history and an import's rows left staged, with the store's alarm, idle or not", async () => {
    const notes = await notesApp();
    const { builder } = notes;
    await call(notes, builder, "notes.create", { title: "Old" });
    const current = await loadRelease(
      env,
      appIdSchema.parse(notes.app),
      notes.version
    );
    if (current.store === null) {
      throw new Error("Expected the App's store");
    }
    const store = await openStore(env, current.store.storeId);
    // An import whose rows were staged and never landed.
    await store.stageImport({
      importId: crypto.randomUUID(),
      principal: builder.userId,
      table: "notes",
      from: 0,
      rows: [{ id: mintRecordId(), fields: { title: "Never landed" } }],
    });
    const object = inJurisdiction(env, env.DATA_STORES).getByName(store.id);
    const left = async () =>
      await runInDurableObject(object, (_instance, state) => ({
        changes: state.storage.sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM sdk_record_changes")
          .one().n,
        staged: state.storage.sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM sdk_import_rows")
          .one().n,
      }));
    await expect(left()).resolves.toStrictEqual({ changes: 1, staged: 1 });

    // Nobody writes to it again; past its history's retention, its alarm.
    vi.useFakeTimers({
      toFake: ["Date"],
      now: Date.now() + (recordChangeLimits.retentionDays + 1) * 86_400_000,
    });
    try {
      await runDurableObjectAlarm(object);
    } finally {
      vi.useRealTimers();
    }
    await expect(left()).resolves.toStrictEqual({ changes: 0, staged: 0 });
  });

  it("round-trips null, empty text and no value, in required, nullable and optional fields", async () => {
    const notes = await notesApp();
    const { builder } = notes;
    const labels = [
      { name: "", nick: null },
      { name: "null", nick: "", note: "" },
      { name: "x", nick: "null", note: "null", extra: null },
      { name: "y", nick: null, extra: "" },
    ];
    for (const fields of labels) {
      // oxlint-disable-next-line no-await-in-loop -- one label at a time
      await call(notes, builder, "notes.label", fields);
    }
    const csv = await exported(notes, "labels");
    const other = await notesApp();
    const { mapping } = await other.builder.api.apps.data.previewImport(
      other.app,
      "labels",
      csv
    );
    await expect(
      other.builder.api.apps.data.import(other.app, "labels", {
        version: other.version,
        csv,
        mapping,
      })
    ).resolves.toStrictEqual({ ok: true, inserted: labels.length });
    expect(byName(await everyRecord(other, "labels"))).toStrictEqual(
      byName(labels.map((fields) => ({ fields })))
    );
  });

  it("stops an export, rather than mixing two versions, once another version is made current", async () => {
    const notes = await notesApp();
    const { app, builder } = notes;
    await call(notes, builder, "notes.create", { title: "Plan" });
    // Read here a pull at a time, as a client takes a page in, with the
    // session checked before each, as a connection checks it.
    const headers = new Headers({ cookie: builder.session });
    const rpc = new AppDataRpc(env, async () => {
      const identity = await identify(env, headers);
      if (!identity) {
        throw new Error("Session ended");
      }
      return identity;
    });
    const stream = await rpc.export(app, "notes");
    const reader = stream.getReader();
    const header = await reader.read();
    expect(new TextDecoder().decode(header.value)).toContain("_id,");
    await release(builder, app, {
      ...files,
      "src/routes/index.tsx": `${files["src/routes/index.tsx"] ?? ""}\n// v2\n`,
    });
    await expect(reader.read()).rejects.toThrow(/This App changed/u);
  });

  it("refuses the page's reads and imports once another version is current, never under other tables", async () => {
    const notes = await notesApp();
    const { app, builder } = notes;
    const id = await call(notes, builder, "notes.create", { title: "Plan" });
    if (typeof id !== "string") {
      throw new TypeError("Expected the note's ID");
    }
    const { version } = await builder.api.apps.data.tables(app);
    expect(version).toBe(notes.version);
    await release(builder, app, {
      ...files,
      "src/routes/index.tsx": `${files["src/routes/index.tsx"] ?? ""}\n// v2\n`,
    });
    const { data } = builder.api.apps;
    const refusals = await Promise.all([
      outcome(data.records(app, "notes", notes.version, null)),
      outcome(data.record(app, "notes", notes.version, id)),
      outcome(data.history(app, "notes", notes.version, id, null)),
      outcome(
        data.import(app, "notes", {
          version: notes.version,
          csv: "title\nLate\n",
          mapping: { title: "title" },
        })
      ),
    ]);
    expect(new Set(refusals)).toStrictEqual(
      new Set(["app_data.version_changed"])
    );
    // The version it reads now serves them.
    const now = await data.tables(app);
    await expect(
      data.record(app, "notes", now.version ?? 0, id)
    ).resolves.toMatchObject({ id });
  });
});
