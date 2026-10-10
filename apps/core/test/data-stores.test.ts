import { canonicalJson } from "@grasp-os/shared/json";
import {
  commitMaxGuards,
  commitMaxInputBytes,
  commitMaxWrites,
  documentMaxBytes,
  documentMaxDepth,
  storeMaxTables,
} from "@grasp-os/shared/stores";
import type { Commit, Committed, StoreFields } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";

// Business stores through core's own way in (data-stores.ts) and each
// store's Durable Object (data-store.ts): what the operations to come
// rely on when they read and commit records. Each test makes stores of
// its own.

const ada = { userId: "ada" };
const grace = { userId: "grace" };
const schemaHash = "a".repeat(64);
const laterHash = "b".repeat(64);

/** Who commits in these tests: one operation's pinned contract, for Ada. */
const scope = {
  principal: "ada",
  resource: "notes-app",
  binding: null,
  contractId: "notes.update",
  contractVersion: 1,
  operationKind: "mutation",
} as const;

/** Some input's hash: these commits each claim a key of their own. */
const inputHash = "c".repeat(64);

/**
 * Commits `commit` under a new receipt of its own, as a mutation's first
 * attempt does: claimed, then committed.
 */
const commitIn = async (
  store: OpenStore,
  commit: Omit<Commit, "storeId" | "receipt">
): Promise<Committed> => {
  const claimed = await store.claim({
    scope: { ...scope, principal: commit.principal.userId },
    key: [crypto.randomUUID()],
    inputHash,
    runId: null,
    deadline: Date.now() + 60_000,
  });
  if (!("held" in claimed)) {
    throw new Error("A new key found an outcome");
  }
  return await store.commit({ ...commit, receipt: claimed.held });
};

/** A new store with a `notes` table. */
const newStore = async (): Promise<OpenStore> => {
  const store = await openStore(env, await createStore(env, ada.userId));
  await store.defineTables(["notes"]);
  return store;
};

/** Inserts one note for `principal` and answers its ID. */
const insertNote = async (
  store: OpenStore,
  fields?: StoreFields,
  principal = ada
): Promise<string> => {
  const { inserted } = await commitIn(store, {
    principal,
    schemaHash,
    writes: [
      { op: "insert", table: "notes", fields: fields ?? { title: "Launch" } },
    ],
  });
  const [id] = inserted;
  if (id === undefined) {
    throw new Error("Nothing was inserted");
  }
  return id;
};

/**
 * Fields a caller's types wouldn't let through, sent as a confused or
 * hostile caller would: the store checks them itself.
 */
const untyped = (fields: unknown): StoreFields =>
  // SAFETY: none, on purpose: the store must refuse what isn't fields.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately ill-typed input
  fields as StoreFields;

/** `count` inserts of a small note. */
const inserts = (count: number) =>
  Array.from({ length: count }, () => ({
    op: "insert" as const,
    table: "notes",
    fields: { title: "Note" },
  }));

/** The store's object, addressed directly. */
const objectOf = (id: string) => env.DATA_STORES.getByName(id);

/** How many records the store's database holds, of every table. */
const recordCount = async (store: OpenStore): Promise<number> =>
  await runInDurableObject(objectOf(store.id), (_instance, state) => {
    const [row] = state.storage.sql
      .exec<{ count: number }>("SELECT count(*) AS count FROM sdk_records")
      .toArray();
    return row?.count ?? 0;
  });

describe("stores", () => {
  it("keeps each store's records apart, whatever their tables are called", async () => {
    const first = await newStore();
    const second = await newStore();
    expect(first.id).not.toBe(second.id);

    const id = await insertNote(first);
    await expect(first.get("notes", id)).resolves.toMatchObject({
      fields: { title: "Launch" },
    });
    await expect(second.get("notes", id)).resolves.toBeNull();
    await expect(
      commitIn(second, {
        principal: ada,
        schemaHash,
        writes: [
          {
            op: "patch",
            table: "notes",
            id,
            fields: { title: "Taken" },
            expectedRevision: 1,
          },
        ],
      })
    ).rejects.toMatchObject({ code: "data.conflict" });
    await expect(first.get("notes", id)).resolves.toMatchObject({
      revision: 1,
      fields: { title: "Launch" },
    });
  });

  it("mints table IDs, so two stores' tables of one name differ", async () => {
    const first = await openStore(env, await createStore(env, ada.userId));
    const second = await openStore(env, await createStore(env, ada.userId));
    const firstTables = await first.defineTables(["notes", "people"]);
    const secondTables = await second.defineTables(["notes"]);

    expect(firstTables.notes).not.toBe("notes");
    expect(firstTables.notes).not.toBe(secondTables.notes);
    // Defining tables again keeps their IDs.
    await expect(first.defineTables(["notes"])).resolves.toStrictEqual(
      firstTables
    );
  });

  it("refuses table names that aren't identifiers, or differ only in case", async () => {
    const store = await newStore();
    await Promise.all(
      [
        "_notes",
        "notes; DROP TABLE sdk_records",
        "1notes",
        "notités",
        "",
        "n".repeat(65),
      ].map(async (name) => {
        await expect(store.defineTables([name])).rejects.toMatchObject({
          code: "data.invalid",
        });
      })
    );
    await expect(store.defineTables(["Notes"])).rejects.toMatchObject({
      code: "data.table_conflict",
    });
    await expect(store.get("people", "x")).rejects.toMatchObject({
      code: "data.unknown_table",
    });
    await expect(
      commitIn(store, {
        principal: ada,
        schemaHash,
        writes: [{ op: "insert", table: "NOTES", fields: {} }],
      })
    ).rejects.toMatchObject({ code: "data.unknown_table" });
  });

  it(`holds at most ${storeMaxTables} tables`, async () => {
    const store = await openStore(env, await createStore(env, ada.userId));
    const names = Array.from({ length: storeMaxTables }, (_, n) => `t${n}`);
    await expect(store.defineTables(names)).resolves.toBeDefined();
    await expect(store.defineTables(["oneMore"])).rejects.toMatchObject({
      code: "data.too_many_tables",
    });
    // Nothing of the refused definition stays.
    const tables = await store.defineTables(["t0"]);
    expect(Object.keys(tables)).toHaveLength(storeMaxTables);
  });

  it("refuses a store it doesn't list, or one deleted, alike", async () => {
    await expect(openStore(env, crypto.randomUUID())).rejects.toMatchObject({
      code: "data.store_unavailable",
    });
    const store = await newStore();
    await env.DB.prepare(
      "UPDATE business_stores SET deleted_at = ? WHERE id = ?"
    )
      .bind(Date.now(), store.id)
      .run();
    await expect(openStore(env, store.id)).rejects.toMatchObject({
      code: "data.store_unavailable",
    });
  });

  it("serves one store per object, never another addressed at it", async () => {
    const store = await newStore();
    const id = await insertNote(store);
    const other = await createStore(env, ada.userId);
    const misaddressed = async () =>
      await objectOf(store.id).get(other, "notes", id);
    await expect(misaddressed()).rejects.toThrow(
      "This object holds another store"
    );
    // Nor does an object reached by another name take the store's ID.
    const stray = async () => await objectOf(other).get(store.id, "notes", id);
    await expect(stray()).rejects.toThrow("This object holds another store");
  });

  it("reads its records back from storage after its object is reset", async () => {
    const store = await newStore();
    const id = await insertNote(store);
    await runInDurableObject(objectOf(store.id), (_instance, state) => {
      state.abort("reset");
    }).catch(() => {});
    // The next request reaches the object anew, from its storage.
    const reopened = await openStore(env, store.id);
    await expect(reopened.get("notes", id)).resolves.toMatchObject({
      revision: 1,
      fields: { title: "Launch" },
    });
  });
});

describe("managed fields", () => {
  it("sets them itself: the owner, revision 1 and the commit's time", async () => {
    const store = await newStore();
    const before = Date.now();
    const id = await insertNote(store, { title: "Launch" }, grace);
    const record = await store.get("notes", id);

    expect(record).toMatchObject({
      id,
      ownerId: "grace",
      revision: 1,
      schemaHash,
      fields: { title: "Launch" },
    });
    expect(record?.createdAt).toBeGreaterThanOrEqual(before);
    expect(record?.updatedAt).toBe(record?.createdAt);
  });

  it("refuses any write that names one", async () => {
    const store = await newStore();
    const id = await insertNote(store);
    const managed = [
      { _id: "mine" },
      { _ownerId: "mallory" },
      { _rev: 9 },
      { _createdAt: 0 },
      { _updatedAt: 0 },
    ].map((fields) => untyped(fields));
    await Promise.all(
      managed.map(async (fields) => {
        await expect(
          commitIn(store, {
            principal: ada,
            schemaHash,
            writes: [{ op: "insert", table: "notes", fields }],
          })
        ).rejects.toMatchObject({ code: "data.invalid" });
        await expect(
          commitIn(store, {
            principal: ada,
            schemaHash,
            writes: [
              { op: "patch", table: "notes", id, fields, expectedRevision: 1 },
            ],
          })
        ).rejects.toMatchObject({ code: "data.invalid" });
      })
    );
    await expect(
      commitIn(store, {
        principal: ada,
        schemaHash,
        writes: [
          {
            op: "patch",
            table: "notes",
            id,
            fields: {},
            unset: ["_ownerId"],
            expectedRevision: 1,
          },
        ],
      })
    ).rejects.toMatchObject({ code: "data.invalid" });
    await expect(store.get("notes", id)).resolves.toMatchObject({
      ownerId: "ada",
      revision: 1,
    });
  });

  it("moves the revision on once per commit, however many writes change the record", async () => {
    const store = await newStore();
    const id = await insertNote(store, { title: "Launch", body: "" });
    const created = await store.get("notes", id);

    await commitIn(store, {
      principal: grace,
      schemaHash: laterHash,
      writes: [
        {
          op: "patch",
          table: "notes",
          id,
          fields: { title: "Launch day" },
          expectedRevision: 1,
        },
        {
          op: "patch",
          table: "notes",
          id,
          fields: { body: "Agenda" },
          expectedRevision: 1,
        },
      ],
    });

    const updated = await store.get("notes", id);
    expect(updated).toMatchObject({
      revision: 2,
      // Changing a record doesn't make it someone else's.
      ownerId: "ada",
      schemaHash: laterHash,
      createdAt: created?.createdAt,
      fields: { title: "Launch day", body: "Agenda" },
    });
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(created?.updatedAt ?? 0);
  });

  it("keeps a record inserted and changed in one commit at revision 1", async () => {
    const store = await newStore();
    const first = await insertNote(store);
    // A commit inserts another note and, in the same commit, can only
    // change the first one: it doesn't know the new ID until it commits.
    const { inserted } = await commitIn(store, {
      principal: ada,
      schemaHash,
      writes: [
        { op: "insert", table: "notes", fields: { title: "Second" } },
        {
          op: "patch",
          table: "notes",
          id: first,
          fields: { title: "First" },
          expectedRevision: 1,
        },
      ],
    });
    await expect(store.get("notes", inserted[0] ?? "")).resolves.toMatchObject({
      revision: 1,
    });
    await expect(store.get("notes", first)).resolves.toMatchObject({
      revision: 2,
    });
  });

  it("leaves the revision and time alone when nothing changes", async () => {
    const store = await newStore();
    const id = await insertNote(store, { title: "Launch", tags: ["a", "b"] });
    const created = await store.get("notes", id);

    // The same fields in another order are the same record.
    await commitIn(store, {
      principal: ada,
      schemaHash: laterHash,
      writes: [
        {
          op: "replace",
          table: "notes",
          id,
          fields: { tags: ["a", "b"], title: "Launch" },
          expectedRevision: 1,
        },
      ],
    });
    await expect(store.get("notes", id)).resolves.toStrictEqual(created);
  });
});

describe("commits", () => {
  it("refuses a write at a stale revision, and writes nothing of its commit", async () => {
    const store = await newStore();
    const id = await insertNote(store);
    await commitIn(store, {
      principal: ada,
      schemaHash,
      writes: [
        {
          op: "patch",
          table: "notes",
          id,
          fields: { title: "Edited" },
          expectedRevision: 1,
        },
      ],
    });

    await expect(
      commitIn(store, {
        principal: ada,
        schemaHash,
        writes: [
          { op: "insert", table: "notes", fields: { title: "Lost" } },
          {
            op: "patch",
            table: "notes",
            id,
            fields: { title: "Stale" },
            expectedRevision: 1,
          },
        ],
      })
    ).rejects.toMatchObject({ code: "data.conflict" });
    await expect(store.get("notes", id)).resolves.toMatchObject({
      revision: 2,
      fields: { title: "Edited" },
    });
    await expect(recordCount(store)).resolves.toBe(1);
  });

  it("lets one of two edits from the same revision in", async () => {
    const store = await newStore();
    const id = await insertNote(store);
    const edit = async (title: string) =>
      await commitIn(store, {
        principal: ada,
        schemaHash,
        writes: [
          {
            op: "patch",
            table: "notes",
            id,
            fields: { title },
            expectedRevision: 1,
          },
        ],
      });

    const results = await Promise.allSettled([edit("One"), edit("Other")]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1
    );
    expect(
      results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      )?.reason
    ).toMatchObject({ code: "data.conflict" });
    await expect(store.get("notes", id)).resolves.toMatchObject({
      revision: 2,
    });
  });

  it("refuses a commit whose read went stale, though it writes elsewhere", async () => {
    const store = await newStore();
    const read = await insertNote(store, { title: "Rate" });
    await commitIn(store, {
      principal: ada,
      schemaHash,
      writes: [
        {
          op: "patch",
          table: "notes",
          id: read,
          fields: { title: "New rate" },
          expectedRevision: 1,
        },
      ],
    });

    await expect(
      commitIn(store, {
        principal: ada,
        schemaHash,
        guards: [{ table: "notes", id: read, expectedRevision: 1 }],
        writes: [
          { op: "insert", table: "notes", fields: { title: "At old rate" } },
        ],
      })
    ).rejects.toMatchObject({ code: "data.conflict" });
    await expect(recordCount(store)).resolves.toBe(1);
  });

  it("refuses to change or delete a record that is gone", async () => {
    const store = await newStore();
    const id = await insertNote(store);
    await commitIn(store, {
      principal: ada,
      schemaHash,
      writes: [{ op: "delete", table: "notes", id, expectedRevision: 1 }],
    });
    await expect(store.get("notes", id)).resolves.toBeNull();

    await Promise.all(
      (
        [
          { op: "delete", table: "notes", id, expectedRevision: 1 },
          {
            op: "replace",
            table: "notes",
            id,
            fields: { title: "Back" },
            expectedRevision: 1,
          },
        ] as const
      ).map(async (write) => {
        await expect(
          commitIn(store, { principal: ada, schemaHash, writes: [write] })
        ).rejects.toMatchObject({ code: "data.conflict" });
      })
    );
    await expect(recordCount(store)).resolves.toBe(0);
  });

  it("patches field by field, removes what it unsets, and replaces whole", async () => {
    const store = await newStore();
    const id = await insertNote(store, {
      title: "Launch",
      body: "Agenda",
      summary: null,
    });

    await commitIn(store, {
      principal: ada,
      schemaHash,
      writes: [
        {
          op: "patch",
          table: "notes",
          id,
          fields: { title: "Launch day" },
          unset: ["summary"],
          expectedRevision: 1,
        },
      ],
    });
    const patched = await store.get("notes", id);
    expect(patched?.fields).toStrictEqual({
      title: "Launch day",
      body: "Agenda",
    });

    await commitIn(store, {
      principal: ada,
      schemaHash,
      writes: [
        {
          op: "replace",
          table: "notes",
          id,
          fields: { title: "Only" },
          expectedRevision: 2,
        },
      ],
    });
    await expect(store.get("notes", id)).resolves.toMatchObject({
      revision: 3,
      fields: { title: "Only" },
    });

    await expect(
      commitIn(store, {
        principal: ada,
        schemaHash,
        writes: [
          {
            op: "patch",
            table: "notes",
            id,
            fields: { title: "Both" },
            unset: ["title"],
            expectedRevision: 3,
          },
        ],
      })
    ).rejects.toMatchObject({ code: "data.invalid" });
  });

  it("keeps only JSON, within its size and depth", async () => {
    const store = await newStore();
    let deep: unknown = "leaf";
    for (let level = 0; level <= documentMaxDepth; level += 1) {
      deep = { deeper: deep };
    }
    // A sparse array has a hole that no JSON value fills.
    const sparse: unknown[] = [];
    sparse[2] = "x";
    await Promise.all(
      [
        { count: Number.NaN },
        { count: Number.POSITIVE_INFINITY },
        { when: new Date(0) },
        { title: undefined },
        { list: sparse },
        { deep },
        { body: "x".repeat(documentMaxBytes) },
      ].map(async (fields) => {
        await expect(
          commitIn(store, {
            principal: ada,
            schemaHash,
            writes: [{ op: "insert", table: "notes", fields: untyped(fields) }],
          })
        ).rejects.toMatchObject({ code: "data.invalid" });
      })
    );
    await expect(recordCount(store)).resolves.toBe(0);
  });

  it(`carries at most ${commitMaxWrites} writes and ${commitMaxGuards} guards`, async () => {
    const store = await newStore();
    const { inserted } = await commitIn(store, {
      principal: ada,
      schemaHash,
      writes: inserts(commitMaxWrites),
    });
    expect(inserted).toHaveLength(commitMaxWrites);
    await expect(
      commitIn(store, {
        principal: ada,
        schemaHash,
        writes: inserts(commitMaxWrites + 1),
      })
    ).rejects.toMatchObject({ code: "data.invalid" });

    const guards = inserted.map((id) => ({
      table: "notes",
      id,
      expectedRevision: 1,
    }));
    await expect(
      commitIn(store, { principal: ada, schemaHash, guards, writes: [] })
    ).resolves.toMatchObject({ inserted: [] });
    await expect(
      commitIn(store, {
        principal: ada,
        schemaHash,
        guards: [...guards, ...guards.slice(0, 1)],
        writes: [],
      })
    ).rejects.toMatchObject({ code: "data.invalid" });
    await expect(recordCount(store)).resolves.toBe(commitMaxWrites);
  });

  it(`takes at most ${commitMaxInputBytes} bytes of writes in one commit`, async () => {
    const store = await newStore();
    // Each document fits; together they are more than one commit takes.
    const large = { body: "x".repeat(120_000) };
    const count = Math.floor(commitMaxInputBytes / 120_000) + 1;
    await expect(
      commitIn(store, {
        principal: ada,
        schemaHash,
        writes: Array.from({ length: count }, () => ({
          op: "insert" as const,
          table: "notes",
          fields: large,
        })),
      })
    ).rejects.toMatchObject({ code: "data.invalid" });
    await expect(recordCount(store)).resolves.toBe(0);
  });
});

/** How many bytes a document's stored text takes besides its strings. */
const overheadOf = (empty: Record<string, string>): number =>
  new TextEncoder().encode(canonicalJson(empty)).byteLength;

describe("document size", () => {
  const overhead = overheadOf({ a: "", b: "" });
  const firstPart = 65_000;

  it("takes a document of exactly the limit in one write", async () => {
    const store = await newStore();
    const id = await insertNote(store, {
      body: "x".repeat(documentMaxBytes - overheadOf({ body: "" })),
    });
    await expect(store.get("notes", id)).resolves.toMatchObject({
      revision: 1,
    });
  });

  it("counts bytes, not characters", async () => {
    const store = await newStore();
    // Fewer characters than the limit, but three bytes each.
    await expect(
      commitIn(store, {
        principal: ada,
        schemaHash,
        writes: [
          {
            op: "insert",
            table: "notes",
            fields: { body: "€".repeat(50_000) },
          },
        ],
      })
    ).rejects.toMatchObject({ code: "data.invalid" });
    await expect(recordCount(store)).resolves.toBe(0);
  });

  /** A note of `a` characters, patched with `b` more in field `b`. */
  const patchedNote = async (store: OpenStore, b: number): Promise<string> => {
    const id = await insertNote(store, { a: "x".repeat(firstPart) });
    await commitIn(store, {
      principal: ada,
      schemaHash,
      writes: [
        {
          op: "patch",
          table: "notes",
          id,
          fields: { b: "y".repeat(b) },
          expectedRevision: 1,
        },
      ],
    });
    return id;
  };

  it("keeps a record of exactly the limit", async () => {
    const store = await newStore();
    const id = await patchedNote(
      store,
      documentMaxBytes - overhead - firstPart
    );
    await expect(store.get("notes", id)).resolves.toMatchObject({
      revision: 2,
    });
  });

  it("refuses a patch that takes the stored record past the limit", async () => {
    const store = await newStore();
    const id = await patchedNote(
      store,
      documentMaxBytes - overhead - firstPart
    );
    // One byte more, though the patch itself is small.
    await expect(
      commitIn(store, {
        principal: ada,
        schemaHash,
        writes: [
          {
            op: "patch",
            table: "notes",
            id,
            fields: { c: "" },
            expectedRevision: 2,
          },
        ],
      })
    ).rejects.toMatchObject({ code: "data.invalid" });
    const kept = await store.get("notes", id);
    expect(kept?.revision).toBe(2);
    expect(Object.keys(kept?.fields ?? {})).toStrictEqual(["a", "b"]);
  });

  it("refuses patches in one commit that together take a record past the limit", async () => {
    const store = await newStore();
    const id = await insertNote(store, { a: "x".repeat(firstPart) });
    await expect(
      commitIn(store, {
        principal: ada,
        schemaHash,
        writes: [
          {
            op: "patch",
            table: "notes",
            id,
            fields: { b: "y".repeat(40_000) },
            expectedRevision: 1,
          },
          {
            op: "patch",
            table: "notes",
            id,
            fields: { c: "z".repeat(40_000) },
            expectedRevision: 1,
          },
        ],
      })
    ).rejects.toMatchObject({ code: "data.invalid" });
    await expect(store.get("notes", id)).resolves.toMatchObject({
      revision: 1,
    });
  });

  it("rolls back what the commit already wrote when a later record can't be stored", async () => {
    const store = await newStore();
    const full = await patchedNote(
      store,
      documentMaxBytes - overhead - firstPart
    );
    // The insert is written first; the patch then fails as its record is
    // stored, and the transaction takes the insert back.
    await expect(
      commitIn(store, {
        principal: ada,
        schemaHash,
        writes: [
          { op: "insert", table: "notes", fields: { title: "Lost" } },
          {
            op: "patch",
            table: "notes",
            id: full,
            fields: { c: "over" },
            expectedRevision: 2,
          },
        ],
      })
    ).rejects.toMatchObject({ code: "data.invalid" });
    await expect(recordCount(store)).resolves.toBe(1);
  });
});
