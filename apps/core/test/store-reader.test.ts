import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import type { Id } from "@grasp-os/sdk";
import { databaseReader } from "@grasp-os/sdk/database";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { Commit, StoreFields } from "@grasp-os/shared/stores";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import {
  queryMaxReruns,
  readConsistently,
  StoreReader,
} from "../src/store-reader.ts";

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
  notes: defineTable({ title: v.string() }),
  people: defineTable({ name: v.string() }),
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
    { op: "insert", table: "notes", fields: fields ?? { title: "a" } },
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
      { op: "insert", table: "people", fields: { name: "Grace" } },
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
