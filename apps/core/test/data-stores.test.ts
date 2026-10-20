import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import type { ValueShape } from "@grasp-os/sdk";
import {
  manifestMaxBytes,
  manifestText,
  schemaHash as hashOf,
  schemaManifest,
} from "@grasp-os/sdk/host";
import type { AccessMode } from "@grasp-os/sdk/host";
import { canonicalJson } from "@grasp-os/shared/json";
import { storeMaxTables } from "@grasp-os/shared/store-limits";
import {
  cascadeJobMaxRecords,
  commitMaxCascade,
  commitMaxGuards,
  commitMaxInputBytes,
  commitMaxWrites,
  documentMaxBytes,
  dataErrors,
  documentMaxDepth,
} from "@grasp-os/shared/stores";
import type {
  Commit,
  Committed,
  StoreFields,
  WriterRoles,
} from "@grasp-os/shared/stores";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { allEvents } from "./audit-events.ts";
import { failure } from "./sealed-apps.ts";
import {
  manifestHash,
  memberRoles,
  newRecordId,
  tablesManifest,
} from "./store-schemas.ts";

/** Who creates the stores these tests use: a builder of the organization. */
const builder: Acting = {
  userId: "ada",
  role: "builder",
  teams: [],
  staff: false,
};

// Business stores through core's own way in (data-stores.ts) and each
// store's Durable Object (data-store.ts): what the operations to come
// rely on when they read and commit records. Each test makes stores of
// its own.

const ada = { userId: "ada" };
const grace = { userId: "grace" };
const storeManifest = tablesManifest("notes");
/** A later schema of the same store: one more table. */
const laterManifest = tablesManifest("notes", "drafts");
const schemaHash = await manifestHash(storeManifest);
const laterHash = await manifestHash(laterManifest);

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
  commit: Omit<Commit, "storeId" | "receipt" | "roles" | "stagedAt"> &
    Partial<Pick<Commit, "roles" | "stagedAt">>
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
  return await store.commit({
    roles: memberRoles,
    stagedAt: Date.now(),
    ...commit,
    receipt: claimed.held,
  });
};

/** A new store with a `notes` table. */
const newStore = async (): Promise<OpenStore> => {
  const store = await openStore(env, await createStore(env, builder));
  await store.defineTables(storeManifest);
  await store.defineTables(laterManifest);
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
      {
        op: "insert",
        id: newRecordId(),
        table: "notes",
        fields: fields ?? { title: "Launch" },
      },
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
    id: newRecordId(),
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
    const first = await openStore(env, await createStore(env, builder));
    const second = await openStore(env, await createStore(env, builder));
    const firstTables = await first.defineTables(
      tablesManifest("notes", "people")
    );
    const secondTables = await second.defineTables(tablesManifest("notes"));

    expect(firstTables.tables.notes).not.toBe("notes");
    expect(firstTables.tables.notes).not.toBe(secondTables.tables.notes);
    // Defining tables again keeps their IDs.
    await expect(
      first.defineTables(tablesManifest("notes"))
    ).resolves.toMatchObject({ storeTables: firstTables.tables });
  });

  it("refuses a table whose name differs only in case from one it holds", async () => {
    const store = await newStore();
    await expect(
      store.defineTables(tablesManifest("Notes"))
    ).rejects.toMatchObject({ code: "data.table_conflict" });
    await expect(store.get("people", "x")).rejects.toMatchObject({
      code: "data.unknown_table",
    });
    await expect(
      commitIn(store, {
        principal: ada,
        schemaHash,
        writes: [
          { op: "insert", id: newRecordId(), table: "NOTES", fields: {} },
        ],
      })
    ).rejects.toMatchObject({ code: "data.unknown_table" });
  });

  it(`holds at most ${storeMaxTables} tables`, async () => {
    const store = await openStore(env, await createStore(env, builder));
    const names = Array.from({ length: storeMaxTables }, (_, n) => `t${n}`);
    await expect(
      store.defineTables(tablesManifest(...names))
    ).resolves.toBeDefined();
    await expect(
      store.defineTables(tablesManifest("oneMore"))
    ).rejects.toMatchObject({ code: "data.too_many_tables" });
    // Nothing of the refused definition stays.
    const { storeTables } = await store.defineTables(tablesManifest("t0"));
    expect(Object.keys(storeTables)).toHaveLength(storeMaxTables);
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
    const other = await createStore(env, builder);
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

/** Something that isn't text, passed as text, as a hostile caller would. */
const asText = (manifest: unknown): string =>
  // SAFETY: none, on purpose: the store must refuse what isn't text.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately ill-typed input
  manifest as string;

/** The Notes schema of the specification, with its access. */
const notesSchema = (order: "declared" | "reordered") => {
  const title = v.string().trim().min(1).max(200);
  const body = v.string().max(100_000).default("");
  const fields =
    order === "declared"
      ? { title, body }
      : { body, title: v.string().max(200).min(1).trim() };
  const notes = defineTable(fields)
    .index("by_updated", ["_updatedAt"])
    .index("by_title", ["title"]);
  return schemaManifest(
    defineSchema(
      order === "declared"
        ? { notes, people: defineTable({ name: v.string() }) }
        : { people: defineTable({ name: v.string() }), notes }
    ),
    { tables: { notes: { read: "owner", write: "owner" } } }
  );
};

/**
 * The Notes schema with one thing chosen: who reads notes, or the order its
 * indexes are declared in.
 */
const notesManifest = ({
  read = "owner",
  indexes = "declared",
}: {
  read?: AccessMode;
  indexes?: "declared" | "reversed";
} = {}) => {
  const table = defineTable({ title: v.string(), body: v.string() });
  const notes =
    indexes === "declared"
      ? table.index("by_updated", ["_updatedAt"]).index("by_title", ["title"])
      : table.index("by_title", ["title"]).index("by_updated", ["_updatedAt"]);
  return schemaManifest(defineSchema({ notes }), {
    tables: { notes: { read, write: "owner" } },
  });
};

/** The Notes manifest's JSON, changed by `change`, as text. */
const changed = (change: (json: Record<string, unknown>) => void): string => {
  // SAFETY: a manifest's text is a JSON object.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const json = JSON.parse(manifestText(notesSchema("declared"))) as Record<
    string,
    unknown
  >;
  change(json);
  return JSON.stringify(json);
};
/** The tables of a manifest's JSON. */
const tablesOf = (
  json: Record<string, unknown>
): Record<string, Record<string, unknown>> =>
  // SAFETY: the Notes manifest's JSON, as made above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  json.tables as Record<string, Record<string, unknown>>;
const notesOf = (json: Record<string, unknown>) => tablesOf(json).notes ?? {};
const fieldsOf = (json: Record<string, unknown>): Record<string, unknown> =>
  // SAFETY: as above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  notesOf(json).fields as Record<string, unknown>;

describe("schemas", () => {
  it("defines a schema's tables from its manifest and answers its hash, as the SDK computes it", async () => {
    const store = await openStore(env, await createStore(env, builder));
    const manifest = notesSchema("declared");
    const defined = await store.defineTables(manifestText(manifest));

    expect(defined.schemaHash).toBe(await hashOf(manifest));
    expect(Object.keys(defined.tables).toSorted()).toStrictEqual([
      "notes",
      "people",
    ]);
    // A later schema of fewer tables gets its own; the store keeps them all.
    const fewer = await store.defineTables(
      manifestText(
        schemaManifest(
          defineSchema({ people: defineTable({ name: v.string() }) })
        )
      )
    );
    expect(fewer.tables).toStrictEqual({ people: defined.tables.people });
    expect(fewer.storeTables).toStrictEqual(defined.tables);
    // The same schema declared in another order, its text's keys in yet
    // another, is the same schema: the same hash, the same tables.
    const reordered = manifestText(notesSchema("reordered"));
    const reversed = JSON.stringify(
      JSON.parse(reordered),
      (_key, part: unknown) =>
        typeof part === "object" && part !== null && !Array.isArray(part)
          ? Object.fromEntries(Object.entries(part).toReversed())
          : part
    );
    // Applied again, it leaves the contract as the last schema left it.
    const again = await store.defineTables(reversed);
    expect({
      ...again,
      contract: [again.contract.hash, again.contract.changed],
    }).toStrictEqual({
      ...defined,
      contract: [fewer.contract.hash, false],
    });
  });

  it("a changed access mode needs a migration, either way", async () => {
    const store = await openStore(env, await createStore(env, builder));
    await store.defineTables(manifestText(notesManifest()));
    await expect(
      store.defineTables(manifestText(notesManifest({ read: "appMembers" })))
    ).rejects.toMatchObject({
      code: "migration.required",
      details: { changes: [{ table: "notes", reason: "access_changed" }] },
    });
  });

  it("indexes declared in another order alone are the same schema", async () => {
    const store = await openStore(env, await createStore(env, builder));
    const declared = await store.defineTables(manifestText(notesManifest()));
    const reversed = await store.defineTables(
      manifestText(notesManifest({ indexes: "reversed" }))
    );
    expect({ ...reversed, contract: reversed.contract.hash }).toStrictEqual({
      ...declared,
      contract: declared.contract.hash,
    });
    expect(reversed.contract.changed).toBeFalsy();
  });

  it.each([
    ["text that isn't JSON", "{", "schema.invalid_manifest"],
    [
      "a table name that isn't an identifier",
      changed((json) => {
        json.tables = { "notes; DROP TABLE sdk_records": notesOf(json) };
      }),
      "schema.invalid_name",
    ],
    [
      "a table name with letters that aren't ASCII",
      changed((json) => {
        json.tables = { notités: notesOf(json) };
      }),
      "schema.invalid_name",
    ],
    [
      "two tables that differ only in case",
      changed((json) => {
        tablesOf(json).Notes = notesOf(json);
      }),
      "schema.name_conflict",
    ],
    [
      "a managed field declared",
      changed((json) => {
        fieldsOf(json)._ownerId = fieldsOf(json).title;
      }),
      "schema.invalid_name",
    ],
    [
      "an index on a field that isn't a scalar",
      changed((json) => {
        fieldsOf(json).tags = {
          descriptorVersion: 1,
          kind: "array",
          item: fieldsOf(json).title,
          nullable: false,
          presence: "required",
        };
        notesOf(json).indexes = { by_tags: { fields: ["tags"] } };
      }),
      "schema.invalid_index",
    ],
    [
      "a record ID naming a table it hasn't",
      changed((json) => {
        fieldsOf(json).project = {
          descriptorVersion: 1,
          kind: "id",
          tableName: "projects",
          nullable: false,
          presence: "required",
        };
      }),
      "schema.unknown_table",
    ],
    [
      "a key a manifest doesn't have",
      changed((json) => {
        notesOf(json).ddl = "CREATE INDEX x ON sdk_records(value_json)";
      }),
      "schema.invalid_manifest",
    ],
    [
      "a version this host doesn't know",
      changed((json) => {
        json.manifestVersion = 2;
      }),
      "schema.invalid_manifest",
    ],
    ["too much text", " ".repeat(manifestMaxBytes + 1), "schema.too_large"],
  ])(
    "refuses a schema with %s, and defines nothing of it",
    async (_, text, code) => {
      const store = await openStore(env, await createStore(env, builder));
      await expect(store.defineTables(text)).rejects.toMatchObject({
        code: "data.invalid_schema",
        details: { code },
      });
      await expect(store.get("notes", "x")).rejects.toMatchObject({
        code: "data.unknown_table",
      });
    }
  );

  it("refuses anything but a manifest's text", async () => {
    const store = await openStore(env, await createStore(env, builder));
    await expect(
      store.defineTables(asText(notesSchema("declared")))
    ).rejects.toMatchObject({
      code: "data.invalid_schema",
      details: { code: "schema.invalid_manifest" },
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
            writes: [
              { op: "insert", id: newRecordId(), table: "notes", fields },
            ],
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
        {
          op: "insert",
          id: newRecordId(),
          table: "notes",
          fields: { title: "Second" },
        },
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
          {
            op: "insert",
            id: newRecordId(),
            table: "notes",
            fields: { title: "Lost" },
          },
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
          {
            op: "insert",
            id: newRecordId(),
            table: "notes",
            fields: { title: "At old rate" },
          },
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
            writes: [
              {
                op: "insert",
                id: newRecordId(),
                table: "notes",
                fields: untyped(fields),
              },
            ],
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
          id: newRecordId(),
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
            id: newRecordId(),
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
          {
            op: "insert",
            id: newRecordId(),
            table: "notes",
            fields: { title: "Lost" },
          },
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

/** An insert of a new record of `table`. */
const insertInto = (table: string) => ({
  op: "insert" as const,
  table,
  id: newRecordId(),
  fields: { title: "a" },
});

describe("writes under the pinned schema's access", () => {
  /** A store whose tables are written by each mode, read by their owner. */
  const accessStore = async () => {
    const store = await openStore(env, await createStore(env, builder));
    const tables = ["owned", "members", "builders", "locked"] as const;
    const modes: Record<(typeof tables)[number], AccessMode> = {
      owned: "owner",
      members: "appMembers",
      builders: "appBuilders",
      locked: "none",
    };
    const text = manifestText(
      schemaManifest(
        defineSchema(
          Object.fromEntries(
            tables.map((name) => [name, defineTable({ title: v.string() })])
          )
        ),
        {
          tables: Object.fromEntries(
            tables.map((name) => [name, { read: "owner", write: modes[name] }])
          ),
        }
      )
    );
    const { schemaHash: hash } = await store.defineTables(text);
    return { store, hash };
  };

  /** The code a commit of `write` for `principal` with `roles` fails with, or "ok". */
  const outcomeOf = async (
    { store, hash }: { store: OpenStore; hash: string },
    write: Commit["writes"][number],
    roles: { appMember: boolean; appBuilder: boolean },
    principal = ada
  ): Promise<unknown> => {
    try {
      await commitIn(store, {
        principal,
        roles,
        schemaHash: hash,
        writes: [write],
      });
      return "ok";
    } catch (error) {
      return error instanceof Error && "code" in error ? error.code : error;
    }
  };

  const outsider = { appMember: false, appBuilder: false };
  const member = { appMember: true, appBuilder: false };
  const appBuilder = { appMember: false, appBuilder: true };

  it("admits an insert only for the roles each table's write mode admits", async () => {
    const fixture = await accessStore();
    expect({
      ownedByOutsider: await outcomeOf(fixture, insertInto("owned"), outsider),
      membersByOutsider: await outcomeOf(
        fixture,
        insertInto("members"),
        outsider
      ),
      membersByMember: await outcomeOf(fixture, insertInto("members"), member),
      membersByBuilder: await outcomeOf(
        fixture,
        insertInto("members"),
        appBuilder
      ),
      buildersByMember: await outcomeOf(
        fixture,
        insertInto("builders"),
        member
      ),
      buildersByBuilder: await outcomeOf(
        fixture,
        insertInto("builders"),
        appBuilder
      ),
      lockedByBuilder: await outcomeOf(fixture, insertInto("locked"), {
        appMember: true,
        appBuilder: true,
      }),
    }).toStrictEqual({
      ownedByOutsider: "ok",
      membersByOutsider: "data.write_denied",
      membersByMember: "ok",
      membersByBuilder: "ok",
      buildersByMember: "data.write_denied",
      buildersByBuilder: "ok",
      lockedByBuilder: "data.write_denied",
    });
  });

  it("lets an owner table's writes change only the principal's own records, as if others' didn't exist", async () => {
    const fixture = await accessStore();
    const write = insertInto("owned");
    await outcomeOf(fixture, write, outsider, ada);
    const patch = {
      op: "patch" as const,
      table: "owned",
      id: write.id,
      fields: { title: "b" },
      expectedRevision: 1,
    };
    const remove = {
      op: "delete" as const,
      table: "owned",
      id: write.id,
      expectedRevision: 1,
    };
    const missing = { ...remove, id: newRecordId() };
    expect({
      othersPatch: await outcomeOf(fixture, patch, member, grace),
      othersDelete: await outcomeOf(fixture, remove, member, grace),
      missingDelete: await outcomeOf(fixture, missing, member, grace),
      ownPatch: await outcomeOf(fixture, patch, outsider, ada),
    }).toStrictEqual({
      othersPatch: "data.conflict",
      othersDelete: "data.conflict",
      missingDelete: "data.conflict",
      ownPatch: "ok",
    });
  });

  it("refuses an insert under an ID already in use, and a table the pinned schema hasn't", async () => {
    const fixture = await accessStore();
    const write = insertInto("owned");
    await outcomeOf(fixture, write, outsider);
    expect({
      again: await outcomeOf(fixture, write, outsider),
      unknown: await outcomeOf(fixture, insertInto("other"), member),
    }).toStrictEqual({ again: "data.conflict", unknown: "data.unknown_table" });
  });
});

describe("a commit's read set", () => {
  it("refuses a commit once a table it read moved on, and takes one that is current", async () => {
    const store = await newStore();
    const [{ notes: before = 0 }] = [await store.generations(["notes"])];
    await insertNote(store);
    const stale = commitIn(store, {
      principal: ada,
      schemaHash,
      readSet: { notes: before },
      writes: [],
    });
    await expect(stale).rejects.toMatchObject({ code: "data.reads_changed" });
    const now = await store.generations(["notes"]);
    await expect(
      commitIn(store, { principal: ada, schemaHash, readSet: now, writes: [] })
    ).resolves.toMatchObject({ inserted: [] });
  });
});

describe("a commit's staging time", () => {
  it("stamps its records, and is refused more than a minute ahead of the store's clock", async () => {
    const store = await newStore();
    const write = insertInto("notes");
    const stagedAt = Date.now() - 5000;
    const ahead = commitIn(store, {
      principal: ada,
      schemaHash,
      stagedAt: Date.now() + 120_000,
      writes: [insertInto("notes")],
    });
    await expect(ahead).rejects.toMatchObject({ code: "data.invalid" });
    await commitIn(store, {
      principal: ada,
      schemaHash,
      stagedAt,
      writes: [write],
    });
    await expect(store.get("notes", write.id)).resolves.toMatchObject({
      createdAt: stagedAt,
      updatedAt: stagedAt,
    });
  });
});

describe("a staged read", () => {
  it("sees the writes it is handed as their commit would make them, and keeps none", async () => {
    const store = await newStore();
    const kept = await insertNote(store, { title: "Kept" });
    const id = newRecordId();
    const stagedAt = Date.now() - 1000;
    const reader = {
      schemaHash,
      principal: "ada",
      appMember: true,
      appBuilder: false,
      consumer: { resourceId: "notes-app", resourceVersion: 1 },
    };
    const staged = {
      stagedAt,
      writes: [
        { op: "insert" as const, table: "notes", id, fields: { title: "New" } },
        {
          op: "delete" as const,
          table: "notes",
          id: kept,
          expectedRevision: 1,
        },
      ],
    };
    const generations = await store.generations(["notes"]);
    const { value, generations: seen } = await store.read(
      reader,
      {
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
      },
      staged
    );
    expect({
      seen: value,
      generations: seen,
      kept: await store.get("notes", kept).then((record) => record?.id),
      inserted: await store.get("notes", id),
    }).toStrictEqual({
      seen: [
        {
          _id: id,
          _ownerId: "ada",
          _rev: 1,
          _createdAt: stagedAt,
          _updatedAt: stagedAt,
          title: "New",
        },
      ],
      // The generation from before the staged writes: what a commit
      // fenced on this read compares.
      generations,
      kept,
      inserted: null,
    });
  });
});

/**
 * A schema whose `links` refer to `notes`, and to each other, in every way
 * a field can hold a reference; and to `secrets`, each read by its owner
 * alone, and `drafts`, read by the App's builders alone.
 */
const linksManifest = manifestText(
  schemaManifest(
    defineSchema({
      notes: defineTable({ title: v.string() }),
      links: defineTable({
        note: v.id("notes").optional(),
        nested: v.object({ to: v.id("notes").optional() }).optional(),
        many: v.array(v.id("notes")).optional(),
        byName: v.record(v.id("notes")).optional(),
        either: v.union(v.id("notes"), v.number()).optional(),
        noteOrLink: v.union(v.id("notes"), v.id("links")).optional(),
        noneOr: v.union(v.literal("none"), v.id("notes")).optional(),
        textOr: v.union(v.string(), v.id("notes")).optional(),
        shape: v
          .union(v.object({ to: v.string() }), v.object({ to: v.id("notes") }))
          .optional(),
        parent: v.id("links").optional(),
        secret: v.id("secrets").optional(),
        draft: v.id("drafts").optional(),
        label: v.string().optional(),
      }),
      secrets: defineTable({ title: v.string() }),
      drafts: defineTable({ title: v.string() }),
    }),
    {
      tables: {
        notes: { read: "appMembers", write: "appMembers" },
        links: { read: "appMembers", write: "appMembers" },
        secrets: { read: "owner", write: "owner" },
        drafts: { read: "appBuilders", write: "appBuilders" },
      },
    }
  )
);
const linksHash = await manifestHash(linksManifest);

/** A new store with the `notes` and `links` tables. */
const newLinkedStore = async (): Promise<OpenStore> => {
  const store = await openStore(env, await createStore(env, builder));
  await store.defineTables(linksManifest);
  return store;
};

/** The tables of the links schema. */
type LinkedTable = "notes" | "links" | "secrets" | "drafts";

/** Who writes: Ada, a member and builder of the App, unless changed. */
interface Writer {
  principal: { userId: string };
  roles: WriterRoles;
}

const adaWrites: Writer = { principal: ada, roles: memberRoles };

/** Grace, a member of the App and not a builder. */
const graceWrites: Writer = {
  principal: grace,
  roles: { appMember: true, appBuilder: false },
};

/** Inserts one record of `table` with `fields`, by `writer`, and answers its ID. */
const insertLinked = async (
  store: OpenStore,
  table: LinkedTable,
  fields: StoreFields,
  writer: Writer = adaWrites
): Promise<string> => {
  const id = newRecordId();
  await commitIn(store, {
    ...writer,
    schemaHash: linksHash,
    writes: [{ op: "insert", id, table, fields }],
  });
  return id;
};

/** The details of the data error `run` is refused with. */
const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    const details: unknown =
      error instanceof Error ? Reflect.get(error, "details") : undefined;
    return { code: dataErrors.codeOf(error), details };
  }
  throw new Error("It was accepted");
};

/** Deletes the record `id` of `table`, at revision `revision`. */
const deleteFrom = async (
  store: OpenStore,
  table: LinkedTable,
  id: string,
  writer: Writer = adaWrites
): Promise<Committed> =>
  await commitIn(store, {
    ...writer,
    schemaHash: linksHash,
    writes: [{ op: "delete", table, id, expectedRevision: 1 }],
  });

/** A schema of `notes` and `links` with fields `links`, read and written by members. */
const notesAndLinks = (links: ValueShape): string =>
  manifestText(
    schemaManifest(
      defineSchema({
        notes: defineTable({ title: v.string() }),
        links: defineTable(links),
      }),
      {
        tables: {
          notes: { read: "appMembers", write: "appMembers" },
          links: { read: "appMembers", write: "appMembers" },
        },
      }
    )
  );

describe("a store's references", () => {
  it("refuses to delete a record another refers to, at any depth, and writes nothing", async () => {
    const holders = [
      (id: string) => ({ note: id }),
      (id: string) => ({ nested: { to: id } }),
      (id: string) => ({ many: [id, id] }),
      (id: string) => ({ byName: { first: id } }),
      (id: string) => ({ either: id }),
    ];
    // A store of its own for each way of holding a reference.
    await Promise.all(
      holders.map(async (holder) => {
        const store = await newLinkedStore();
        const note = await insertLinked(store, "notes", { title: "Kept" });
        await insertLinked(store, "links", holder(note));
        await expect(deleteFrom(store, "notes", note)).rejects.toMatchObject({
          code: "data.referenced",
        });
        await expect(store.get("notes", note)).resolves.not.toBeNull();
        await expect(recordCount(store)).resolves.toBe(2);
      })
    );
  });

  it("deletes a record once nothing refers to it, or with what refers to it", async () => {
    const store = await newLinkedStore();
    const first = await insertLinked(store, "notes", { title: "First" });
    const firstLink = await insertLinked(store, "links", { note: first });
    await deleteFrom(store, "links", firstLink);
    await deleteFrom(store, "notes", first);
    await expect(store.get("notes", first)).resolves.toBeNull();

    const second = await insertLinked(store, "notes", { title: "Second" });
    const secondLink = await insertLinked(store, "links", { many: [second] });
    await commitIn(store, {
      principal: ada,
      schemaHash: linksHash,
      writes: [
        { op: "delete", table: "notes", id: second, expectedRevision: 1 },
        { op: "delete", table: "links", id: secondLink, expectedRevision: 1 },
      ],
    });
    await expect(store.get("notes", second)).resolves.toBeNull();
  });

  it("follows a reference as its record changes", async () => {
    const store = await newLinkedStore();
    const first = await insertLinked(store, "notes", { title: "First" });
    const second = await insertLinked(store, "notes", { title: "Second" });
    const link = await insertLinked(store, "links", { note: first });
    await commitIn(store, {
      principal: ada,
      schemaHash: linksHash,
      writes: [
        {
          op: "patch",
          table: "links",
          id: link,
          fields: { note: second },
          expectedRevision: 1,
        },
      ],
    });
    await deleteFrom(store, "notes", first);
    await expect(deleteFrom(store, "notes", second)).rejects.toMatchObject({
      code: "data.referenced",
    });
  });

  it("reads a union's value as the member it matches, and names only the table holding the record", async () => {
    const store = await newLinkedStore();
    const note = await insertLinked(store, "notes", { title: "Kept" });
    const plain = await insertLinked(store, "notes", { title: "Free" });
    const link = await insertLinked(store, "links", { noteOrLink: note });
    // Each of these matches a member that isn't a record ID: none refers.
    const plainValues: StoreFields[] = [
      { noneOr: "none" },
      { textOr: "hello" },
      { textOr: plain },
    ];
    await Promise.all(
      plainValues.map(
        async (fields) => await insertLinked(store, "links", fields)
      )
    );
    const indexed = await runInDurableObject(
      objectOf(store.id),
      (_instance, state) =>
        state.storage.sql
          .exec<{ table: string; to: string }>(
            `SELECT tables.name AS "table", refs.to_record_id AS "to"
              FROM sdk_record_refs AS refs
              JOIN sdk_tables AS tables ON tables.table_id = refs.to_table_id`
          )
          .toArray()
    );
    expect(indexed).toStrictEqual([{ table: "notes", to: note }]);
    await expect(deleteFrom(store, "notes", note)).rejects.toMatchObject({
      code: "data.referenced",
    });
    await deleteFrom(store, "notes", plain);
    // A link's ID, the union's second record-ID member: indexed as a link.
    const holder = await insertLinked(store, "links", { noteOrLink: link });
    await expect(deleteFrom(store, "links", link)).rejects.toMatchObject({
      code: "data.referenced",
    });
    await deleteFrom(store, "links", holder);
    // A union's record ID that names no record of any of its tables.
    await expect(
      insertLinked(store, "links", { noteOrLink: newRecordId() })
    ).rejects.toMatchObject({ code: "data.reference_invalid" });
    await deleteFrom(store, "links", link);
    await deleteFrom(store, "notes", note);
  });

  it("checks each place holding a record ID on its own, whatever ID another holds", async () => {
    const store = await newLinkedStore();
    const note = await insertLinked(store, "notes", { title: "Kept" });
    // The same ID in a field naming notes and one naming secrets: the
    // note exists, no secret does.
    await expect(
      insertLinked(store, "links", { note, secret: note })
    ).rejects.toMatchObject({ code: "data.reference_invalid" });
    await deleteFrom(store, "notes", note);
  });

  it("reads a union as the first member that accepts the value, objects included", async () => {
    const store = await newLinkedStore();
    const note = await insertLinked(store, "notes", { title: "Free" });
    // The first object member takes `to` as text: no reference.
    await insertLinked(store, "links", { shape: { to: note } });
    const rows = await runInDurableObject(
      objectOf(store.id),
      (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM sdk_record_refs"
          )
          .one().count
    );
    expect(rows).toBe(0);
    await deleteFrom(store, "notes", note);
  });

  it("names only the record the refused deletion asked for", async () => {
    const store = await newLinkedStore();
    const note = await insertLinked(store, "notes", { title: "Kept" });
    await insertLinked(store, "links", { note }, graceWrites);
    await expect(
      refusalOf(async () => await deleteFrom(store, "notes", note))
    ).resolves.toStrictEqual({
      code: "data.referenced",
      details: { table: "notes", id: note },
    });
  });

  it("refuses a reference to a record that doesn't exist or that the writer can't read, alike", async () => {
    const store = await newLinkedStore();
    const secret = await insertLinked(store, "secrets", { title: "Ada's" });
    const draft = await insertLinked(store, "drafts", { title: "Builders'" });
    const gone = await insertLinked(store, "notes", { title: "Gone" });
    await deleteFrom(store, "notes", gone);
    const forged: StoreFields[] = [
      { note: newRecordId() },
      { note: gone },
      { secret },
      { draft },
      // An ID of one table, named as another's.
      { note: secret },
    ];
    const refusals = await Promise.all(
      forged.map(
        async (fields) =>
          await refusalOf(
            async () => await insertLinked(store, "links", fields, graceWrites)
          )
      )
    );
    // Each names the link it would have written, never what it named.
    expect(refusals).toMatchObject(
      refusals.map(() => ({
        code: "data.reference_invalid",
        details: { table: "links" },
      }))
    );
    // Nothing Grace tried holds Ada's records: she deletes them.
    await deleteFrom(store, "secrets", secret);
    await deleteFrom(store, "drafts", draft);
    await expect(recordCount(store)).resolves.toBe(0);
  });

  it("lets a writer refer to what they may read, a record their commit inserts included", async () => {
    const store = await newLinkedStore();
    const secret = await insertLinked(store, "secrets", { title: "Ada's" });
    const draft = await insertLinked(store, "drafts", { title: "Builders'" });
    await insertLinked(store, "links", { secret, draft });
    const own = newRecordId();
    const link = newRecordId();
    await commitIn(store, {
      ...graceWrites,
      schemaHash: linksHash,
      writes: [
        {
          op: "insert",
          id: own,
          table: "secrets",
          fields: { title: "Grace's" },
        },
        { op: "insert", id: link, table: "links", fields: { secret: own } },
      ],
    });
    await expect(
      deleteFrom(store, "secrets", own, graceWrites)
    ).rejects.toMatchObject({
      code: "data.referenced",
    });
  });

  it("keeps a reference a record held before, whoever may read its record now", async () => {
    const store = await newLinkedStore();
    const draft = await insertLinked(store, "drafts", { title: "Builders'" });
    const link = await insertLinked(store, "links", { draft });
    // A member who can't read drafts changes another field of the link.
    await commitIn(store, {
      ...graceWrites,
      schemaHash: linksHash,
      writes: [
        {
          op: "patch",
          table: "links",
          id: link,
          fields: { label: "Seen" },
          expectedRevision: 1,
        },
      ],
    });
    await expect(deleteFrom(store, "drafts", draft)).rejects.toMatchObject({
      code: "data.referenced",
    });
  });

  it("restricts or lets go as the commit that deletes a record rewrites what refers to it", async () => {
    const store = await newLinkedStore();
    const kept = await insertLinked(store, "notes", { title: "Kept" });
    const freed = await insertLinked(store, "notes", { title: "Freed" });
    const link = await insertLinked(store, "links", { note: kept });
    const rewrite = async (note: string, fields: StoreFields) =>
      await commitIn(store, {
        principal: ada,
        schemaHash: linksHash,
        writes: [
          {
            op: "patch",
            table: "links",
            id: link,
            fields,
            expectedRevision: 1,
          },
          { op: "delete", table: "notes", id: note, expectedRevision: 1 },
        ],
      });
    // Still referring after the rewrite: refused.
    await expect(rewrite(kept, { label: "Still" })).rejects.toMatchObject({
      code: "data.referenced",
    });
    // Moved away in the same commit: the note goes.
    await rewrite(kept, { note: freed });
    await expect(store.get("notes", kept)).resolves.toBeNull();
  });

  it("indexes a write under an older schema the store still holds", async () => {
    const store = await newLinkedStore();
    const later = manifestText(
      schemaManifest(
        defineSchema({
          notes: defineTable({ title: v.string() }),
          links: defineTable({ note: v.id("notes").optional() }),
          more: defineTable({ title: v.string() }),
        }),
        {
          tables: {
            notes: { read: "appMembers", write: "appMembers" },
            links: { read: "appMembers", write: "appMembers" },
            more: { read: "appMembers", write: "appMembers" },
          },
        }
      )
    );
    await store.defineTables(later);
    const note = await insertLinked(store, "notes", { title: "Kept" });
    // Written under the first schema, after the later one.
    await insertLinked(store, "links", { note });
    await expect(
      commitIn(store, {
        principal: ada,
        schemaHash: await manifestHash(later),
        writes: [
          { op: "delete", table: "notes", id: note, expectedRevision: 1 },
        ],
      })
    ).rejects.toMatchObject({ code: "data.referenced" });
  });

  it("lets a record that refers only to itself be deleted", async () => {
    const store = await newLinkedStore();
    const link = newRecordId();
    await commitIn(store, {
      principal: ada,
      schemaHash: linksHash,
      writes: [
        { op: "insert", id: link, table: "links", fields: { parent: link } },
      ],
    });
    await deleteFrom(store, "links", link);
    await expect(store.get("links", link)).resolves.toBeNull();
  });

  it("keeps a reference a newer version wrote through an older version's writes", async () => {
    const store = await openStore(env, await createStore(env, builder));
    // The older version knows no reference; the newer adds one.
    const older = notesAndLinks({ label: v.string().optional() });
    const newer = notesAndLinks({
      label: v.string().optional(),
      pin: v.id("notes").optional(),
    });
    const [olderHash, newerHash] = await Promise.all([
      manifestHash(older),
      manifestHash(newer),
    ]);
    await store.defineTables(older);
    // The older version writes first, so the store reads its contract
    // before the newer version widens it.
    const note = newRecordId();
    await commitIn(store, {
      principal: ada,
      schemaHash: olderHash,
      writes: [
        { op: "insert", id: note, table: "notes", fields: { title: "Kept" } },
      ],
    });
    await store.defineTables(newer);
    const link = newRecordId();
    await commitIn(store, {
      principal: ada,
      schemaHash: newerHash,
      writes: [
        { op: "insert", id: link, table: "links", fields: { pin: note } },
      ],
    });
    // Rolled back: the older version patches the link, then replaces it.
    await commitIn(store, {
      principal: ada,
      schemaHash: olderHash,
      writes: [
        {
          op: "patch",
          table: "links",
          id: link,
          fields: { label: "Patched" },
          expectedRevision: 1,
        },
      ],
    });
    await commitIn(store, {
      principal: ada,
      schemaHash: olderHash,
      writes: [
        {
          op: "replace",
          table: "links",
          id: link,
          fields: { label: "Replaced" },
          expectedRevision: 2,
        },
      ],
    });
    await expect(
      Promise.all(
        [olderHash, newerHash].map(
          async (pinned) =>
            await refusalOf(
              async () =>
                await commitIn(store, {
                  principal: ada,
                  schemaHash: pinned,
                  writes: [
                    {
                      op: "delete",
                      table: "notes",
                      id: note,
                      expectedRevision: 1,
                    },
                  ],
                })
            )
        )
      )
    ).resolves.toStrictEqual([
      { code: "data.referenced", details: { table: "notes", id: note } },
      { code: "data.referenced", details: { table: "notes", id: note } },
    ]);
  });
});

/**
 * A schema whose `links` are deleted with the note they refer to, and
 * whose `subs` with their link, unless a restricting field holds it too.
 * Only the App's builders write `links`.
 */
const cascadeManifest = manifestText(
  schemaManifest(
    defineSchema({
      notes: defineTable({ title: v.string() }),
      links: defineTable({
        note: v.id("notes", { onDelete: "cascade" }).optional(),
        kept: v.id("notes").optional(),
        either: v
          .union(v.id("notes", { onDelete: "cascade" }), v.id("subs"))
          .optional(),
      }),
      subs: defineTable({
        link: v.id("links", { onDelete: "cascade" }).optional(),
        pinned: v.id("links").optional(),
        parent: v.id("subs", { onDelete: "cascade" }).optional(),
      }),
    }),
    {
      tables: {
        notes: { read: "appMembers", write: "appMembers" },
        links: { read: "appMembers", write: "appBuilders" },
        subs: { read: "appMembers", write: "appMembers" },
      },
    }
  )
);
const cascadeHash = await manifestHash(cascadeManifest);

/** A new store with the `notes`, `links` and `subs` tables. */
const newCascadeStore = async (): Promise<OpenStore> => {
  const store = await openStore(env, await createStore(env, builder));
  await store.defineTables(cascadeManifest);
  return store;
};

/** Inserts records of `table`, one per entry of `fields`, and answers their IDs. */
const insertCascading = async (
  store: OpenStore,
  table: "notes" | "links" | "subs",
  ...fields: StoreFields[]
): Promise<string[]> => {
  const ids = fields.map(() => newRecordId());
  await commitIn(store, {
    principal: ada,
    schemaHash: cascadeHash,
    writes: fields.map((value, at) => ({
      op: "insert" as const,
      id: ids[at] ?? "",
      table,
      fields: value,
    })),
  });
  return ids;
};

/** A commit deleting note `id`, by a member who can't write `links`. */
const deleteNote = async (store: OpenStore, id: string): Promise<Committed> =>
  await commitIn(store, {
    principal: ada,
    schemaHash: cascadeHash,
    roles: { appMember: true, appBuilder: false },
    writes: [{ op: "delete", table: "notes", id, expectedRevision: 1 }],
  });

/** The fields of `count` links to `note`. */
const linksTo = (note: string, count: number): StoreFields[] =>
  Array.from({ length: count }, () => ({ note }));

describe("a store's cascades", () => {
  it("cascades through a field a newer version declared, after an older version's write", async () => {
    const store = await openStore(env, await createStore(env, builder));
    const older = notesAndLinks({ label: v.string().optional() });
    const newer = notesAndLinks({
      label: v.string().optional(),
      pin: v.id("notes", { onDelete: "cascade" }).optional(),
    });
    const [olderHash, newerHash] = await Promise.all([
      manifestHash(older),
      manifestHash(newer),
    ]);
    await store.defineTables(older);
    await store.defineTables(newer);
    const note = newRecordId();
    const link = newRecordId();
    await commitIn(store, {
      principal: ada,
      schemaHash: newerHash,
      writes: [
        { op: "insert", id: note, table: "notes", fields: { title: "Gone" } },
        { op: "insert", id: link, table: "links", fields: { pin: note } },
      ],
    });
    await commitIn(store, {
      principal: ada,
      schemaHash: olderHash,
      writes: [
        {
          op: "patch",
          table: "links",
          id: link,
          fields: { label: "Rolled back" },
          expectedRevision: 1,
        },
      ],
    });
    const committed = await commitIn(store, {
      principal: ada,
      schemaHash: olderHash,
      writes: [{ op: "delete", table: "notes", id: note, expectedRevision: 1 }],
    });
    expect(committed.cascaded).toStrictEqual([
      { table: "links", id: link, owner: ada.userId },
    ]);
    await expect(recordCount(store)).resolves.toBe(0);
  });

  it("deletes what refers to a deleted record where its field says so, level by level, whoever writes", async () => {
    const store = await newCascadeStore();
    const [note = ""] = await insertCascading(store, "notes", {
      title: "Gone",
    });
    const [link = ""] = await insertCascading(store, "links", { note });
    const [sub = ""] = await insertCascading(store, "subs", { link });
    const [other = ""] = await insertCascading(store, "notes", {
      title: "Kept",
    });
    const [otherLink = ""] = await insertCascading(store, "links", {
      note: other,
    });

    await deleteNote(store, note);
    await expect(store.get("notes", note)).resolves.toBeNull();
    await expect(store.get("links", link)).resolves.toBeNull();
    await expect(store.get("subs", sub)).resolves.toBeNull();
    await expect(store.get("links", otherLink)).resolves.not.toBeNull();
    // What went took its own references with it: the other note goes on
    // its own, and takes only its link.
    await deleteNote(store, other);
    await expect(recordCount(store)).resolves.toBe(0);
  });

  it("restricts where any place holding the same record ID restricts, whatever their order", async () => {
    const store = await newCascadeStore();
    const [note = ""] = await insertCascading(store, "notes", {
      title: "Held",
    });
    // `either` cascades and comes before `kept`, which restricts.
    await insertCascading(store, "links", { either: note, kept: note });
    await expect(deleteNote(store, note)).rejects.toMatchObject({
      code: "data.referenced",
    });
  });

  it("cascades through a union's record ID as the table holding the record says", async () => {
    const store = await newCascadeStore();
    const [note = ""] = await insertCascading(store, "notes", {
      title: "Gone",
    });
    const [link = ""] = await insertCascading(store, "links", { either: note });
    const committed = await deleteNote(store, note);
    expect(committed.cascaded).toStrictEqual([
      { table: "links", id: link, owner: ada.userId },
    ]);
  });

  it("takes a cycle of cascading records once, and a record the commit deletes itself", async () => {
    const store = await newCascadeStore();
    const [note = ""] = await insertCascading(store, "notes", {
      title: "Gone",
    });
    const [link = ""] = await insertCascading(store, "links", { note });
    // Two subs each deleted with the other, and with the link.
    const first = newRecordId();
    const second = newRecordId();
    await commitIn(store, {
      principal: ada,
      schemaHash: cascadeHash,
      writes: [
        {
          op: "insert",
          id: first,
          table: "subs",
          fields: { link, parent: second },
        },
        { op: "insert", id: second, table: "subs", fields: { parent: first } },
      ],
    });
    await commitIn(store, {
      principal: ada,
      schemaHash: cascadeHash,
      writes: [
        { op: "delete", table: "links", id: link, expectedRevision: 1 },
        { op: "delete", table: "notes", id: note, expectedRevision: 1 },
      ],
    });
    await expect(recordCount(store)).resolves.toBe(0);
  });

  it("refuses the deletion, writing nothing, where a restricting field holds a record it would take", async () => {
    const store = await newCascadeStore();
    const [first = "", second = ""] = await insertCascading(
      store,
      "notes",
      { title: "Held twice" },
      { title: "Held below" }
    );
    // The same note held by a cascading field and a restricting one.
    await insertCascading(store, "links", { note: first, kept: first });
    // A link that would go with its note, held by a restricting field.
    const [link = ""] = await insertCascading(store, "links", { note: second });
    await insertCascading(store, "subs", { pinned: link });

    // The note the deletion asked for is named; a link a cascade would
    // have taken, which may be another's, is not.
    await expect(
      Promise.all(
        [first, second].map(
          async (note) =>
            await refusalOf(async () => await deleteNote(store, note))
        )
      )
    ).resolves.toStrictEqual([
      { code: "data.referenced", details: { table: "notes", id: first } },
      { code: "data.referenced", details: undefined },
    ]);
    await expect(recordCount(store)).resolves.toBe(5);
  });

  it("keeps with the receipt whose records a cascade deleted", async () => {
    const store = await newCascadeStore();
    const [note = ""] = await insertCascading(store, "notes", {
      title: "Gone",
    });
    const [link = ""] = await insertCascading(store, "links", { note });
    const sub = newRecordId();
    await commitIn(store, {
      ...graceWrites,
      schemaHash: cascadeHash,
      writes: [{ op: "insert", id: sub, table: "subs", fields: { link } }],
    });
    const committed = await deleteNote(store, note);
    expect(
      committed.cascaded?.toSorted((a, b) => a.table.localeCompare(b.table))
    ).toStrictEqual([
      { table: "links", id: link, owner: ada.userId },
      { table: "subs", id: sub, owner: grace.userId },
    ]);
  });

  it("leaves a record the commit writes or guards itself to the commit, refusing what still refers", async () => {
    const store = await newCascadeStore();
    const [note = ""] = await insertCascading(store, "notes", {
      title: "Kept",
    });
    const [link = ""] = await insertCascading(store, "links", { note });
    const deleting = {
      op: "delete",
      table: "notes",
      id: note,
      expectedRevision: 1,
    } as const;
    await expect(
      Promise.all([
        // Rewritten by the commit, still referring to the note.
        refusalOf(
          async () =>
            await commitIn(store, {
              principal: ada,
              schemaHash: cascadeHash,
              writes: [
                {
                  op: "patch",
                  table: "links",
                  id: link,
                  fields: { kept: note },
                  expectedRevision: 1,
                },
                deleting,
              ],
            })
        ),
        // Asserted by the commit to be there at its revision.
        refusalOf(
          async () =>
            await commitIn(store, {
              principal: ada,
              schemaHash: cascadeHash,
              guards: [{ table: "links", id: link, expectedRevision: 1 }],
              writes: [deleting],
            })
        ),
      ])
    ).resolves.toStrictEqual([
      { code: "data.referenced", details: { table: "notes", id: note } },
      { code: "data.referenced", details: { table: "notes", id: note } },
    ]);
    await expect(recordCount(store)).resolves.toBe(2);
  });

  it("counts toward the bound only what the cascade adds to the commit's own deletions", async () => {
    const store = await newCascadeStore();
    const [note = ""] = await insertCascading(store, "notes", {
      title: "Gone",
    });
    const extra = 5;
    const links = [
      ...(await insertCascading(store, "links", ...linksTo(note, extra))),
      ...(await insertCascading(
        store,
        "links",
        ...linksTo(note, commitMaxCascade)
      )),
    ];
    // The commit deletes some links itself: the rest are within the bound.
    await commitIn(store, {
      principal: ada,
      schemaHash: cascadeHash,
      writes: [
        ...links.slice(0, extra).map((id) => ({
          op: "delete" as const,
          table: "links",
          id,
          expectedRevision: 1,
        })),
        { op: "delete", table: "notes", id: note, expectedRevision: 1 },
      ],
    });
    await expect(recordCount(store)).resolves.toBe(0);
  });

  it("deletes up to the bound in the commit itself, and leaves more to a cascade job", async () => {
    const store = await newCascadeStore();
    const [many = "", most = ""] = await insertCascading(
      store,
      "notes",
      { title: "Too many" },
      { title: "Just enough" }
    );
    await insertCascading(store, "links", ...linksTo(many, commitMaxCascade));
    await insertCascading(store, "links", ...linksTo(many, 1));
    await insertCascading(store, "links", ...linksTo(most, commitMaxCascade));
    const before = await recordCount(store);

    const pending = await deleteNote(store, many);
    // Nothing deleted yet: the job does it after the commit.
    const afterJob = await recordCount(store);
    const inline = await deleteNote(store, most);
    expect({
      pending: pending.cascadePending?.members,
      inline: inline.cascaded?.length,
      afterJob,
      afterInline: await recordCount(store),
    }).toStrictEqual({
      pending: commitMaxCascade + 2,
      inline: commitMaxCascade,
      afterJob: before,
      afterInline: before - commitMaxCascade - 1,
    });
  });

  it("shows a mutation's staged reads what its deletion takes, as its commit will", async () => {
    const store = await newCascadeStore();
    const [note = ""] = await insertCascading(store, "notes", {
      title: "Gone",
    });
    const [link = ""] = await insertCascading(store, "links", { note });
    const { value } = await store.read(
      {
        schemaHash: cascadeHash,
        principal: "ada",
        appMember: true,
        appBuilder: false,
        consumer: { resourceId: "notes-app", resourceVersion: 1 },
      },
      { kind: "get", table: "links", id: link, expectedRevision: null },
      {
        stagedAt: Date.now(),
        writes: [
          { op: "delete", table: "notes", id: note, expectedRevision: 1 },
        ],
      }
    );
    expect(value).toBeNull();
    // A staged read keeps nothing.
    await expect(store.get("links", link)).resolves.not.toBeNull();
  });
});

/** `insertCascading`, a commit's writes at a time, for any number of records. */
const insertMany = async (
  store: OpenStore,
  table: "notes" | "links" | "subs",
  fields: StoreFields[]
): Promise<string[]> => {
  const ids: string[] = [];
  for (let at = 0; at < fields.length; at += commitMaxWrites) {
    const chunk = fields.slice(at, at + commitMaxWrites);
    // oxlint-disable-next-line no-await-in-loop -- a commit's writes at a time
    const inserted = await insertCascading(store, table, ...chunk);
    ids.push(...inserted);
  }
  return ids;
};

/** The store's cascade jobs, and the members each has left. */
const cascadeJobsOf = async (store: OpenStore) =>
  await runInDurableObject(objectOf(store.id), (_instance, state) =>
    state.storage.sql
      .exec<{
        job: string;
        planned: number;
        deleted: number;
        finished: number | null;
        left: number;
      }>(
        `SELECT j.job_id AS job, j.planned, j.deleted, j.finished_at AS finished,
           (SELECT count(*) FROM sdk_cascade_members m WHERE m.job_id = j.job_id) AS left
         FROM sdk_cascade_jobs j ORDER BY j.created_at`
      )
      .toArray()
  );

/** One alarm of the store's object, as its next wake-up runs it. */
const alarmOnce = async (store: OpenStore): Promise<void> => {
  await runDurableObjectAlarm(objectOf(store.id));
};

/** The store's alarms, until no cascade job has members left. */
const cascadeDone = async (store: OpenStore): Promise<void> => {
  for (let alarms = 0; alarms < 50; alarms += 1) {
    // One alarm after the other: each goes on from where the last stopped.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const jobs = await cascadeJobsOf(store);
    if (jobs.every(({ finished }) => finished !== null)) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- see above
    await alarmOnce(store);
  }
  throw new Error("The cascade job never finished");
};

/**
 * References the store holds to records it no longer holds: what a
 * reader would follow to nothing.
 */
const danglingReferences = async (store: OpenStore): Promise<number> =>
  await runInDurableObject(
    objectOf(store.id),
    (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>(
          `SELECT count(*) AS count FROM sdk_record_refs r
         WHERE NOT EXISTS (SELECT 1 FROM sdk_records t
           WHERE t.table_id = r.to_table_id AND t.record_id = r.to_record_id)`
        )
        .one().count
  );

/**
 * A note with `links` links to it, each with `subs` subs: a cascade two
 * levels deep, inserted a commit's writes at a time.
 */
const deepCascade = async (store: OpenStore, links: number, subs: number) => {
  const [note = ""] = await insertCascading(store, "notes", { title: "Root" });
  const linkIds = await insertCascading(
    store,
    "links",
    ...linksTo(note, links)
  );
  const subFields = linkIds.flatMap((link) =>
    Array.from({ length: subs }, () => ({ link }))
  );
  for (let at = 0; at < subFields.length; at += commitMaxWrites) {
    // oxlint-disable-next-line no-await-in-loop -- a commit's writes at a time
    await insertCascading(
      store,
      "subs",
      ...subFields.slice(at, at + commitMaxWrites)
    );
  }
  return { note, links: linkIds, members: 1 + links + links * subs };
};

describe("a store's cascade jobs", { timeout: 180_000 }, () => {
  it("deletes everything a cascade reaches after its commit, leaves first, never leaving a reference to nothing, even across a restart", async () => {
    const store = await newCascadeStore();
    const { note, members } = await deepCascade(store, 10, 110);
    const before = await recordCount(store);
    const committed = await deleteNote(store, note);
    // Its first batches are due at once.
    const alarmIn = await runInDurableObject(
      objectOf(store.id),
      async (_instance, state) =>
        ((await state.storage.getAlarm()) ?? Number.POSITIVE_INFINITY) -
        Date.now()
    );
    // Still readable, all of it, until the job deletes it.
    const pending = {
      soon: alarmIn < 5000,
      outcome: committed.cascadePending?.members,
      note: (await store.get("notes", note)) !== null,
      count: await recordCount(store),
    };
    // One alarm deletes some batches (the subs first), never the root,
    // and comes again at once for the rest.
    await alarmOnce(store);
    const againIn = await runInDurableObject(
      objectOf(store.id),
      async (_instance, state) =>
        ((await state.storage.getAlarm()) ?? Number.POSITIVE_INFINITY) -
        Date.now()
    );
    const midway = {
      soon: againIn < 5000,
      dangling: await danglingReferences(store),
      note: (await store.get("notes", note)) !== null,
      deleted: before - (await recordCount(store)),
    };
    // The store's object dies mid-job: its next alarm goes on from there.
    await runInDurableObject(objectOf(store.id), (_instance, state) => {
      state.abort("Killed mid-job");
    }).catch(() => {});
    await cascadeDone(store);
    const [job] = await cascadeJobsOf(store);
    expect({
      pending,
      midway: { ...midway, partial: midway.deleted < members },
      after: {
        count: await recordCount(store),
        dangling: await danglingReferences(store),
        job: { planned: job?.planned, deleted: job?.deleted, left: job?.left },
      },
    }).toStrictEqual({
      pending: { soon: true, outcome: members, note: true, count: before },
      midway: {
        soon: true,
        dangling: 0,
        note: true,
        deleted: midway.deleted,
        partial: true,
      },
      after: {
        count: before - members,
        dangling: 0,
        job: { planned: members, deleted: members, left: 0 },
      },
    });
  });

  it("answers a retry under the same key with the same job, and starts no second", async () => {
    const store = await newCascadeStore();
    const [note = ""] = await insertCascading(store, "notes", {
      title: "Root",
    });
    await insertMany(store, "links", linksTo(note, commitMaxCascade + 5));
    const key = [crypto.randomUUID()];
    const attempt = async () => {
      const claimed = await store.claim({
        scope: { ...scope, principal: ada.userId },
        key,
        inputHash,
        runId: null,
        deadline: Date.now() + 60_000,
      });
      if ("outcome" in claimed) {
        return claimed.outcome;
      }
      if (!("held" in claimed)) {
        throw new Error("The key is busy");
      }
      return await store.commit({
        roles: { appMember: true, appBuilder: false },
        stagedAt: Date.now(),
        principal: ada,
        schemaHash: cascadeHash,
        writes: [
          { op: "delete", table: "notes", id: note, expectedRevision: 1 },
        ],
        receipt: claimed.held,
      });
    };
    const first = await attempt();
    const again = await attempt();
    const jobs = await cascadeJobsOf(store);
    expect({
      same: again.cascadePending?.job === first.cascadePending?.job,
      jobs: jobs.length,
    }).toStrictEqual({ same: true, jobs: 1 });
  });

  it("deletes nothing when planning finds a restricting reference, naming nothing", async () => {
    const store = await newCascadeStore();
    const [note = ""] = await insertCascading(store, "notes", {
      title: "Root",
    });
    const links = await insertMany(
      store,
      "links",
      linksTo(note, commitMaxCascade + 5)
    );
    // A sub that only pins one of the links: it restricts its deletion.
    await insertCascading(store, "subs", { pinned: links.at(-1) ?? "" });
    const before = await recordCount(store);
    const refused = await failure(async () => await deleteNote(store, note));
    expect({
      refused,
      count: await recordCount(store),
      jobs: await cascadeJobsOf(store),
    }).toStrictEqual({ refused: "data.referenced", count: before, jobs: [] });
  });

  it("refuses changing, deleting or newly referring to a record it is deleting", async () => {
    const store = await newCascadeStore();
    const [note = "", other = ""] = await insertCascading(
      store,
      "notes",
      { title: "Root" },
      { title: "Other" }
    );
    const [link = ""] = await insertMany(
      store,
      "links",
      linksTo(note, commitMaxCascade + 5)
    );
    await deleteNote(store, note);
    const tried = async (writes: Commit["writes"]) =>
      await failure(
        async () =>
          await commitIn(store, {
            principal: ada,
            schemaHash: cascadeHash,
            writes,
          })
      );
    expect({
      update: await tried([
        {
          op: "patch",
          table: "links",
          id: link,
          expectedRevision: 1,
          fields: { kept: other },
        },
      ]),
      delete: await tried([
        { op: "delete", table: "links", id: link, expectedRevision: 1 },
      ]),
      refer: await tried([
        { op: "insert", table: "links", id: newRecordId(), fields: { note } },
      ]),
      // A record outside the job is written as ever.
      elsewhere: await tried([
        {
          op: "insert",
          table: "links",
          id: newRecordId(),
          fields: { note: other },
        },
      ]),
    }).toStrictEqual({
      update: "data.deleting",
      delete: "data.deleting",
      refer: "data.deleting",
      elsewhere: "ok",
    });
  });

  it("refuses a deletion whose cascade would reach more than a job may delete", async () => {
    const store = await newCascadeStore();
    const [note = ""] = await insertCascading(store, "notes", {
      title: "Root",
    });
    // More links than a job may delete, planted straight into the store.
    await runInDurableObject(objectOf(store.id), (_instance, state) => {
      const linksTable = state.storage.sql
        .exec<{ id: string }>(
          "SELECT table_id AS id FROM sdk_tables WHERE name = 'links'"
        )
        .one().id;
      const notesTable = state.storage.sql
        .exec<{ id: string }>(
          "SELECT table_id AS id FROM sdk_tables WHERE name = 'notes'"
        )
        .one().id;
      for (let at = 0; at < cascadeJobMaxRecords; at += 1) {
        const id = newRecordId();
        state.storage.sql.exec(
          "INSERT INTO sdk_records (table_id, record_id, owner_id, revision, created_at, updated_at, value_json, schema_hash) VALUES (?, ?, 'ada', 1, 0, 0, ?, ?)",
          linksTable,
          id,
          JSON.stringify({ note }),
          cascadeHash
        );
        state.storage.sql.exec(
          "INSERT INTO sdk_record_refs (table_id, record_id, to_table_id, to_record_id, cascade) VALUES (?, ?, ?, ?, 1)",
          linksTable,
          id,
          notesTable,
          note
        );
      }
    });
    await expect(deleteNote(store, note)).rejects.toMatchObject({
      code: "data.cascade_limit",
      details: { limit: cascadeJobMaxRecords },
    });
    await expect(cascadeJobsOf(store)).resolves.toStrictEqual([]);
  });

  it("audits who started it, each batch's records with their owners, and its end", async () => {
    const store = await newCascadeStore();
    const [note = ""] = await insertCascading(store, "notes", {
      title: "Root",
    });
    const links = await insertMany(
      store,
      "links",
      linksTo(note, commitMaxCascade + 5)
    );
    const committed = await deleteNote(store, note);
    const job = committed.cascadePending?.job ?? "";
    await cascadeDone(store);
    const logged = await allEvents();
    const events = logged.filter(
      ({ action, detail }) =>
        action.startsWith("store.cascade_") && detail.job === job
    );
    const batches = events.filter(
      ({ action }) => action === "store.cascade_batch"
    );
    expect({
      actions: [...new Set(events.map(({ action }) => action))].toSorted(),
      actors: [...new Set(events.map(({ actor }) => JSON.stringify(actor)))],
      started: events.find(({ action }) => action === "store.cascade_started")
        ?.detail,
      batched: batches.flatMap(({ provenance }) => provenance).toSorted(),
      owners: [...new Set(batches.map(({ detail }) => detail.owner))],
      finished: events.find(({ action }) => action === "store.cascade_finished")
        ?.detail,
    }).toStrictEqual({
      actions: [
        "store.cascade_batch",
        "store.cascade_finished",
        "store.cascade_started",
      ],
      actors: [JSON.stringify({ type: "person", userId: ada.userId })],
      started: {
        job,
        table: "notes",
        id: note,
        members: links.length + 1,
        app: null,
      },
      batched: [...links, note].toSorted(),
      owners: [ada.userId],
      finished: { job, deleted: links.length + 1 },
    });
  });
});
