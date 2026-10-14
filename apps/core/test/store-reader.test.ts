import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import type { Id } from "@grasp-os/sdk";
import { databaseReader } from "@grasp-os/sdk/database";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { Commit, StoreFields } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { queryMaxReruns } from "../src/call-limits.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { readConsistently, StoreReader } from "../src/store-reader.ts";
import { memberRoles, newRecordId } from "./store-schemas.ts";

// A query operation's reads as one state of the store (spec 6.3), through
// core's way into a store and its Durable Object: the host-side reader
// records the generation of each table read, and `readConsistently`
// reruns an operation whose reads a commit made stale, then gives up with
// the retryable `query.concurrent_change`. Commits land between reads
// here exactly as they would from another caller: through the store.

const builder: Acting = {
  userId: "ada",
  role: "builder",
  teams: [],
  staff: false,
};

const schema = defineSchema({
  notes: defineTable({ title: v.string() }).index("by_title", ["title"]),
  people: defineTable({ name: v.string() }),
  drafts: defineTable({ title: v.string() }),
});

interface Fixture {
  store: OpenStore;
  schemaHash: string;
  scope: ReadScope;
}

const storeWithNotes = async (): Promise<Fixture> => {
  const store = await openStore(env, await createStore(env, builder));
  const { schemaHash } = await store.defineTables(
    manifestText(
      schemaManifest(schema, {
        tables: {
          notes: { read: "appMembers", write: "appMembers" },
          people: { read: "appMembers", write: "appMembers" },
          // Read by the App's builders only: refused to Ada's reads.
          drafts: { read: "appBuilders", write: "appMembers" },
        },
      })
    )
  );
  return {
    store,
    schemaHash,
    scope: {
      schemaHash,
      principal: "ada",
      appMember: true,
      appBuilder: false,
      consumer: { resourceId: "notes-app", resourceVersion: 1 },
    },
  };
};

/** Commits `writes` for Ada under a receipt of their own, as another caller. */
const commit = async (
  { store, schemaHash }: Fixture,
  writes: Commit["writes"]
): Promise<string[]> => {
  const claimed = await store.claim({
    scope: {
      principal: "ada",
      resource: "notes-app",
      binding: null,
      contractId: "notes.write",
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
  const { inserted } = await store.commit({
    principal: { userId: "ada" },
    roles: memberRoles,
    stagedAt: Date.now(),
    schemaHash,
    receipt: claimed.held,
    writes,
  });
  return inserted;
};

const insertNote = async (
  fixture: Fixture,
  fields?: StoreFields
): Promise<string> => {
  const [id] = await commit(fixture, [
    {
      op: "insert",
      id: newRecordId(),
      table: "notes",
      fields: fields ?? { title: "a" },
    },
  ]);
  return id ?? "";
};

/** A note's ID, as App code holds one. */
const noteId = (id: string): Id<"notes"> =>
  // SAFETY: a test's ID; the store decides what, if anything, it names.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  id as Id<"notes">;

/** `ctx.db` over a host-side reader, as GRA-244 builds it. */
const dbOver = (reader: StoreReader) =>
  databaseReader(schema, async (request) => await reader.read(request));

/** The code an operation failed with, and its details. */
const failureOf = async (
  run: Promise<unknown>
): Promise<{ code?: unknown; details?: unknown }> => {
  try {
    await run;
  } catch (error) {
    return error instanceof Error
      ? {
          code: Reflect.get(error, "code"),
          details: Reflect.get(error, "details"),
        }
      : { code: error };
  }
  return {};
};

describe("a query's reads", () => {
  it("are answered after one run when nothing changed meanwhile", async () => {
    const fixture = await storeWithNotes();
    await insertNote(fixture);
    let runs = 0;
    const count = await readConsistently(
      fixture.store,
      fixture.scope,
      async (reader) => {
        runs += 1;
        const db = dbOver(reader);
        const notes = await db.query("notes").count();
        const people = await db.query("people").count();
        return notes + people;
      }
    );
    expect({ count, runs }).toStrictEqual({ count: 1, runs: 1 });
  });

  it("are read again when a commit lands between them, and answered from a state they all saw", async () => {
    const fixture = await storeWithNotes();
    await insertNote(fixture);
    let runs = 0;
    const answer = await readConsistently(
      fixture.store,
      fixture.scope,
      async (reader) => {
        runs += 1;
        const db = dbOver(reader);
        const before = await db.query("notes").count();
        if (runs === 1) {
          await insertNote(fixture, { title: "between" });
        }
        const after = await db.query("notes").count();
        return { before, after };
      }
    );
    // The first run saw 1, then 2: never answered. The second saw 2, twice.
    expect({ answer, runs }).toStrictEqual({
      answer: { before: 2, after: 2 },
      runs: 2,
    });
  });

  it(`give up after ${queryMaxReruns} reruns under persistent contention, retryably`, async () => {
    const fixture = await storeWithNotes();
    let runs = 0;
    const failure = await failureOf(
      readConsistently(fixture.store, fixture.scope, async (reader) => {
        runs += 1;
        const found = await dbOver(reader).query("notes").collect();
        await insertNote(fixture, { title: `run ${runs}` });
        return found;
      })
    );
    expect({ failure, runs }).toStrictEqual({
      failure: {
        code: "query.concurrent_change",
        details: { retryable: true },
      },
      runs: queryMaxReruns + 1,
    });
  });

  it("depend on their table even when they matched nothing", async () => {
    const fixture = await storeWithNotes();
    const reader = new StoreReader(fixture.store, fixture.scope);
    const empty = await dbOver(reader)
      .query("notes")
      .filter({ title: "later" })
      .collect();
    const before = await reader.isCurrent();
    await insertNote(fixture, { title: "later" });
    expect({ empty, before, after: await reader.isCurrent() }).toStrictEqual({
      empty: [],
      before: true,
      after: false,
    });
  });

  it("stay current through commits to other tables, and commits that change nothing", async () => {
    const fixture = await storeWithNotes();
    const id = await insertNote(fixture, { title: "same" });
    const reader = new StoreReader(fixture.store, fixture.scope);
    await dbOver(reader).query("notes").collect();
    await commit(fixture, [
      {
        op: "insert",
        id: newRecordId(),
        table: "people",
        fields: { name: "Grace" },
      },
    ]);
    // A patch to the value the record already holds changes nothing.
    await commit(fixture, [
      {
        op: "patch",
        table: "notes",
        id,
        fields: { title: "same" },
        expectedRevision: 1,
      },
    ]);
    const current = await reader.isCurrent();
    await commit(fixture, [
      {
        op: "patch",
        table: "notes",
        id,
        fields: { title: "changed" },
        expectedRevision: 1,
      },
    ]);
    expect({ current, afterChange: await reader.isCurrent() }).toStrictEqual({
      current: true,
      afterChange: false,
    });
  });
});

describe("a reader's guards", () => {
  it("record the revisions a get asserted on records it found, for a commit to check", async () => {
    const fixture = await storeWithNotes();
    const id = await insertNote(fixture);
    const reader = new StoreReader(fixture.store, fixture.scope);
    const db = dbOver(reader);
    await db.get("notes", noteId(id), { expectedRevision: 1 });
    await db.get("notes", noteId(id));
    await db.get("notes", noteId("missing"), { expectedRevision: 1 });
    expect(reader.guards()).toStrictEqual([
      { table: "notes", id, expectedRevision: 1 },
    ]);
  });
});

describe("a query that fails", () => {
  it("is run again when it failed on a torn read, and fails only as one state does", async () => {
    const fixture = await storeWithNotes();
    const id = await insertNote(fixture, { title: "only" });
    let runs = 0;
    const failure = await failureOf(
      readConsistently(fixture.store, fixture.scope, async (reader) => {
        runs += 1;
        const db = dbOver(reader);
        const found = await db.get("notes", noteId(id));
        if (runs === 1) {
          await insertNote(fixture, { title: "only" });
        }
        // Read after a concurrent insert: not unique on the first run.
        const unique = await db
          .query("notes")
          .filter({ title: "only" })
          .unique();
        return { found: found?._id, unique: unique?._id };
      })
    );
    // The first run failed on a torn read and ran again; the second saw
    // both notes from the start, and fails as one state does.
    expect({ code: failure.code, runs }).toStrictEqual({
      code: "data.not_unique",
      runs: 2,
    });
  });

  it("fails at once when its reads were one state", async () => {
    const fixture = await storeWithNotes();
    let runs = 0;
    const failure = await failureOf(
      readConsistently(fixture.store, fixture.scope, async (reader) => {
        runs += 1;
        await dbOver(reader).query("notes").count();
        throw new Error("The handler's own failure");
      })
    );
    expect({ code: failure.code, runs }).toStrictEqual({
      code: undefined,
      runs: 1,
    });
  });

  it("succeeds on a rerun when only its first, torn, run failed", async () => {
    const fixture = await storeWithNotes();
    const id = await insertNote(fixture, { title: "doomed" });
    let runs = 0;
    const answer = await readConsistently(
      fixture.store,
      fixture.scope,
      async (reader) => {
        runs += 1;
        const db = dbOver(reader);
        const count = await db.query("notes").count();
        if (runs === 1) {
          await commit(fixture, [
            { op: "delete", table: "notes", id, expectedRevision: 1 },
          ]);
        }
        const found = await db.get("notes", noteId(id));
        if (found === null && count > 0) {
          throw new Error("Counted a note that isn't there");
        }
        return { count, found: found?._id ?? null };
      }
    );
    expect({ answer, runs }).toStrictEqual({
      answer: { count: 0, found: null },
      runs: 2,
    });
  });
});

describe("generations", () => {
  it("move on with a delete, and with one commit for every table it writes", async () => {
    const fixture = await storeWithNotes();
    const id = await insertNote(fixture);
    const readerOf = async (table: "notes" | "people") => {
      const reader = new StoreReader(fixture.store, fixture.scope);
      await dbOver(reader).query(table).count();
      return reader;
    };
    const deleted = await readerOf("notes");
    await commit(fixture, [
      { op: "delete", table: "notes", id, expectedRevision: 1 },
    ]);
    const notes = await readerOf("notes");
    const people = await readerOf("people");
    await commit(fixture, [
      {
        op: "insert",
        id: newRecordId(),
        table: "notes",
        fields: { title: "b" },
      },
      {
        op: "insert",
        id: newRecordId(),
        table: "people",
        fields: { name: "Grace" },
      },
    ]);
    expect({
      afterDelete: await deleted.isCurrent(),
      notes: await notes.isCurrent(),
      people: await people.isCurrent(),
    }).toStrictEqual({ afterDelete: false, notes: false, people: false });
  });

  it("are recorded by a page as by any read", async () => {
    const fixture = await storeWithNotes();
    await insertNote(fixture);
    const reader = new StoreReader(fixture.store, fixture.scope);
    const page = await dbOver(reader)
      .query("notes")
      .paginate({ pageSize: 10, cursor: null });
    const before = await reader.isCurrent();
    await insertNote(fixture, { title: "later" });
    expect({
      items: page.items.length,
      before,
      after: await reader.isCurrent(),
    }).toStrictEqual({ items: 1, before: true, after: false });
  });
});

describe("guards, once per record", () => {
  it("record a record read again and again once", async () => {
    const fixture = await storeWithNotes();
    const id = await insertNote(fixture);
    const reader = new StoreReader(fixture.store, fixture.scope);
    const db = dbOver(reader);
    for (let read = 0; read < 150; read += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one read after another
      await db.get("notes", noteId(id), { expectedRevision: 1 });
    }
    expect(reader.guards()).toStrictEqual([
      { table: "notes", id, expectedRevision: 1 },
    ]);
  });
});

describe("a read that fails after reading", () => {
  it("still counts what it read: a caught failure and a later read across a commit rerun", async () => {
    const fixture = await storeWithNotes();
    const first = await insertNote(fixture, { title: "twin" });
    await insertNote(fixture, { title: "twin" });
    let runs = 0;
    const answer = await readConsistently(
      fixture.store,
      fixture.scope,
      async (reader) => {
        runs += 1;
        const db = dbOver(reader);
        let unique: string | null = null;
        try {
          const twin = await db
            .query("notes")
            .filter({ title: "twin" })
            .unique();
          unique = twin?._id ?? null;
        } catch {
          // Two twins: not unique, caught by the handler.
        }
        if (runs === 1) {
          await commit(fixture, [
            { op: "delete", table: "notes", id: first, expectedRevision: 1 },
          ]);
        }
        const count = await db.query("notes").count();
        return { unique: unique !== null, count };
      }
    );
    // The first run saw two twins, then one: never one state. The rerun
    // sees one twin, unique, and one note.
    expect({ answer, runs }).toStrictEqual({
      answer: { unique: true, count: 1 },
      runs: 2,
    });
  });
});

describe("a read refused before reading", () => {
  it("depends on no record: a handler's fallback is answered in one run while its table changes", async () => {
    const fixture = await storeWithNotes();
    let runs = 0;
    const answer = await readConsistently(
      fixture.store,
      fixture.scope,
      async (reader) => {
        runs += 1;
        let drafts: number | "denied" = "denied";
        try {
          drafts = await dbOver(reader).query("drafts").count();
        } catch {
          // Not Ada's to read: the handler answers without them.
        }
        // Another caller keeps changing the table Ada may not read.
        await commit(fixture, [
          {
            op: "insert",
            table: "drafts",
            id: newRecordId(),
            fields: { title: `run ${runs}` },
          },
        ]);
        return drafts;
      }
    );
    expect({ answer, runs }).toStrictEqual({ answer: "denied", runs: 1 });
  });

  it("fails with its refusal in one run while its table changes", async () => {
    const fixture = await storeWithNotes();
    let runs = 0;
    const failure = await failureOf(
      readConsistently(fixture.store, fixture.scope, async (reader) => {
        runs += 1;
        try {
          return await dbOver(reader).query("drafts").count();
        } finally {
          // Another caller changes the table after the refusal, before
          // the run's reads are checked.
          await commit(fixture, [
            {
              op: "insert",
              table: "drafts",
              id: newRecordId(),
              fields: { title: `run ${runs}` },
            },
          ]);
        }
      })
    );
    expect({ code: failure.code, runs }).toStrictEqual({
      code: "data.access_denied",
      runs: 1,
    });
  });

  it("fails with an index the store lacks in one run while its table changes", async () => {
    const fixture = await storeWithNotes();
    // A damaged store: its indexes gone, so SQLite refuses the statement.
    await runInDurableObject(
      env.DATA_STORES.getByName(fixture.store.id),
      (_instance, state) => {
        for (const { name } of state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'sdk\\_ix\\_%' ESCAPE '\\'"
          )
          .toArray()) {
          state.storage.sql.exec(`DROP INDEX ${name}`);
        }
      }
    );
    let runs = 0;
    const failure = await failureOf(
      readConsistently(fixture.store, fixture.scope, async (reader) => {
        runs += 1;
        try {
          return await dbOver(reader)
            .query("notes")
            .withIndex("by_title", (range) => range.eq("title", "a"))
            .collect();
        } finally {
          // Another caller changes the table after the refusal, before
          // the run's reads are checked.
          await insertNote(fixture, { title: `run ${runs}` });
        }
      })
    );
    expect({ code: failure.code, runs }).toStrictEqual({
      code: "data.index_required",
      runs: 1,
    });
  });
});

describe("a failed read's error", () => {
  it("reaches App code without the generations the host counted", async () => {
    const fixture = await storeWithNotes();
    await insertNote(fixture, { title: "twin" });
    await insertNote(fixture, { title: "twin" });
    const reader = new StoreReader(fixture.store, fixture.scope);
    const failure = await failureOf(
      dbOver(reader).query("notes").filter({ title: "twin" }).unique()
    );
    await insertNote(fixture, { title: "later" });
    expect({
      code: failure.code,
      generations:
        typeof failure.details === "object" &&
        failure.details !== null &&
        Object.hasOwn(failure.details, "generations"),
      counted: await reader.isCurrent(),
    }).toStrictEqual({
      code: "data.not_unique",
      generations: false,
      counted: false,
    });
  });
});
