import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import type { ValueShape } from "@grasp-os/sdk";
import {
  manifestText,
  readSchemaManifest,
  schemaManifest,
} from "@grasp-os/sdk/host";
import type { AccessMode } from "@grasp-os/sdk/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type {
  Commit,
  Committed,
  DefinedTables,
  StoreFields,
} from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import type { Acting } from "../src/auth/identity.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { planIndexes } from "../src/store-indexes.ts";
import { manifestHash, memberRoles, newRecordId } from "./store-schemas.ts";

// A store's data contract (spec 17.4): every schema handed to a store
// (`defineTables`) is planned against the union of the schemas it
// accepted, applied only when the change is safe, in one transaction with
// its tables, indexes and the consumer's receipt, and refused otherwise.
// Through the store's own way in (data-stores.ts) and its Durable Object;
// the rules themselves are unit-tested in the SDK (schema-plan.test.ts),
// activation end to end in app-activation.test.ts.

const builder: Acting = {
  userId: "ada",
  role: "builder",
  teams: [],
  staff: false,
};

const ada = { userId: "ada" };

const noteFields = { title: v.string().min(1).max(200) };

/** What a test chooses of a notes schema besides its fields. */
interface SchemaOptions {
  readonly indexed?: boolean;
  readonly read?: AccessMode;
}

/** A notes schema of `fields`, read and written by the App's members. */
const notes = (
  fields: ValueShape = noteFields,
  { indexed = false, read = "appMembers" }: SchemaOptions = {}
): string => {
  const base = schemaManifest(defineSchema({ notes: defineTable(fields) }), {
    tables: { notes: { read, write: "appMembers" } },
  });
  // The index as data, read back through the host's checks.
  return manifestText(
    readSchemaManifest(
      JSON.stringify({
        ...base,
        tables: {
          notes: {
            ...base.tables.notes,
            indexes: indexed ? { by_title: { fields: ["title"] } } : {},
          },
        },
      })
    ).manifest
  );
};

const v1 = notes();
const v2 = notes({ ...noteFields, category: v.string().optional() });

const consumer = (resourceVersion: number) => ({
  resourceId: "notes-app",
  resourceVersion,
});

const newStore = async (): Promise<OpenStore> =>
  await openStore(env, await createStore(env, builder));

/** Commits `writes` for Ada under a receipt of its own, pinned to `schemaHash`. */
const commit = async (
  store: OpenStore,
  schemaHash: string,
  writes: Commit["writes"]
): Promise<Committed> => {
  const claimed = await store.claim({
    scope: {
      principal: "ada",
      resource: "notes-app",
      binding: null,
      contractId: "notes.update",
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
    principal: ada,
    roles: memberRoles,
    stagedAt: Date.now(),
    schemaHash,
    writes,
    receipt: claimed.held,
  });
};

/** Inserts a note with `fields` under `schemaHash`, and answers its ID. */
const insert = async (
  store: OpenStore,
  schemaHash: string,
  fields: StoreFields
): Promise<string> => {
  const id = newRecordId();
  await commit(store, schemaHash, [
    { op: "insert", table: "notes", id, fields },
  ]);
  return id;
};

/** Runs `run` on the store's own SQLite. */
const inStore = async <T>(
  store: OpenStore,
  run: (sql: SqlStorage) => T
): Promise<T> =>
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    (_instance, state) => run(state.storage.sql)
  );

/**
 * Applies each of `schemas` to the store at once, inside its object, so
 * each call's awaits interleave with the others' (calls over RPC may be
 * delivered one after the other).
 */
const atOnce = async (
  store: OpenStore,
  schemas: readonly (readonly [string, ReturnType<typeof consumer>])[]
): Promise<PromiseSettledResult<DefinedTables>[]> =>
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    async (instance) =>
      await Promise.allSettled(
        schemas.map(
          async ([manifest, by]) =>
            await instance.defineTables(store.id, manifest, by)
        )
      )
  );

/** JSON text of `value` with every object's keys in reverse order. */
const reversedText = (value: unknown): string =>
  JSON.stringify(value, (_key, part: unknown) =>
    typeof part === "object" && part !== null && !Array.isArray(part)
      ? Object.fromEntries(Object.entries(part).toReversed())
      : part
  );

/** The code of an error a call was refused with. */
const codeOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error
    ? error.code
    : error;

/** Everything the store's SQLite holds that a schema change could touch. */
const snapshot = async (store: OpenStore) =>
  await inStore(store, (sql) => ({
    master: sql
      .exec("SELECT type, name, sql FROM sqlite_master ORDER BY name")
      .toArray(),
    tables: sql.exec("SELECT * FROM sdk_tables ORDER BY name").toArray(),
    schemas: sql
      .exec("SELECT schema_hash FROM sdk_schemas ORDER BY schema_hash")
      .toArray(),
    records: sql.exec("SELECT * FROM sdk_records ORDER BY record_id").toArray(),
    contract: sql
      .exec("SELECT contract_hash, contract_manifest FROM sdk_store")
      .toArray(),
    receipts: sql
      .exec(
        "SELECT * FROM sdk_schema_activations ORDER BY resource_version, receipt_id"
      )
      .toArray(),
  }));

/** The fields of the contract the store holds. */
const contractFields = async (store: OpenStore): Promise<string[]> => {
  const text = await inStore(
    store,
    (sql) =>
      sql
        .exec<{ manifest: string }>(
          "SELECT contract_manifest AS manifest FROM sdk_store"
        )
        .one().manifest
  );
  return Object.keys(
    readSchemaManifest(text).manifest.tables.notes?.fields ?? {}
  );
};

describe("safe changes", () => {
  it("add an optional field without rewriting any record, and keep a receipt", async () => {
    const store = await newStore();
    const first = await store.defineTables(v1, consumer(1));
    await insert(store, first.schemaHash, { title: "Launch" });
    const before = await snapshot(store);

    const second = await store.defineTables(v2, consumer(2));
    const after = await snapshot(store);

    expect(second.contract).toMatchObject({
      hash: second.schemaHash,
      changed: true,
    });
    expect(second.contract.receiptId).toMatch(/^[0-9a-f]{64}$/u);
    expect(after.records).toStrictEqual(before.records);
    await expect(contractFields(store)).resolves.toStrictEqual([
      "category",
      "title",
    ]);
    expect(
      after.receipts.map(({ resource_version, base_hash, contract_hash }) => ({
        resource_version,
        base_hash,
        contract_hash,
      }))
    ).toStrictEqual([
      { resource_version: 1, base_hash: null, contract_hash: first.schemaHash },
      {
        resource_version: 2,
        base_hash: first.schemaHash,
        contract_hash: second.schemaHash,
      },
    ]);
  });

  it("apply the same schema again as a no-op: no DDL, no write, the first receipt", async () => {
    const store = await newStore();
    await store.defineTables(v1, consumer(1));
    const applied = await store.defineTables(
      notes(noteFields, { indexed: true }),
      consumer(2)
    );
    const before = await snapshot(store);

    const again = await store.defineTables(
      notes(noteFields, { indexed: true }),
      consumer(2)
    );

    await expect(snapshot(store)).resolves.toStrictEqual(before);
    expect(again.contract).toStrictEqual(applied.contract);
  });

  it("keep a field and its data when a later schema leaves it out", async () => {
    const store = await newStore();
    await store.defineTables(v1);
    const second = await store.defineTables(v2);
    const id = await insert(store, second.schemaHash, {
      title: "Launch",
      category: "news",
    });

    const narrower = await store.defineTables(v1);

    expect(narrower.contract).toMatchObject({
      hash: second.schemaHash,
      changed: false,
    });
    await expect(contractFields(store)).resolves.toStrictEqual([
      "category",
      "title",
    ]);
    const kept = await store.get("notes", id);
    expect(kept?.fields).toStrictEqual({
      title: "Launch",
      category: "news",
    });
  });
});

describe("changes that need a migration", () => {
  it.each([
    ["a changed type", notes({ title: v.number() }), "field_changed"],
    [
      "a required field",
      notes({ ...noteFields, priority: v.number() }),
      "required_field_added",
    ],
    [
      "a defaulted field",
      notes({ ...noteFields, summary: v.string().default("") }),
      "defaulted_field_added",
    ],
    [
      "a field turned into a reference",
      manifestText(
        schemaManifest(
          defineSchema({
            notes: defineTable({
              ...noteFields,
              category: v.id("tags").optional(),
            }),
            tags: defineTable({ name: v.string() }),
          }),
          {
            tables: {
              notes: { read: "appMembers", write: "appMembers" },
              tags: { read: "appMembers", write: "appMembers" },
            },
          }
        )
      ),
      "field_changed",
    ],
    [
      "a tighter access mode",
      notes(noteFields, { read: "owner" }),
      "access_changed",
    ],
  ])("refuse %s, before anything is written", async (_name, next, reason) => {
    const store = await newStore();
    await store.defineTables(v2);
    await insert(store, await manifestHash(v2), {
      title: "Launch",
      category: "news",
    });
    const before = await snapshot(store);

    await expect(store.defineTables(next, consumer(3))).rejects.toMatchObject({
      code: "migration.required",
      details: { changes: [expect.objectContaining({ reason })] },
    });
    await expect(snapshot(store)).resolves.toStrictEqual(before);
  });

  it("refuse a damaged contract, or one its own recorded schemas don't fit", async () => {
    const edited = await newStore();
    await edited.defineTables(v1);
    await inStore(edited, (sql) => {
      sql.exec(
        "UPDATE sdk_store SET contract_manifest = replace(contract_manifest, '200', '300')"
      );
    });

    const unreadable = await newStore();
    await unreadable.defineTables(v1);
    await inStore(unreadable, (sql) => {
      sql.exec("UPDATE sdk_store SET contract_manifest = '{'");
    });

    const halved = await newStore();
    await halved.defineTables(v1);
    await inStore(halved, (sql) => {
      sql.exec("UPDATE sdk_store SET contract_manifest = NULL");
    });

    // The same manifest in other text, its hash rewritten to match: only
    // the canonical text is the contract.
    const respelled = await newStore();
    await respelled.defineTables(v1);
    const reordered = reversedText(JSON.parse(v1));
    const reorderedHash = await sha256Hex(reordered);
    await inStore(respelled, (sql) => {
      sql.exec(
        "UPDATE sdk_store SET contract_manifest = ?, contract_hash = ?",
        reordered,
        reorderedHash
      );
    });

    // Consistent in itself, but narrower than what the store recorded.
    const narrowed = await newStore();
    const older = await narrowed.defineTables(v1);
    await narrowed.defineTables(v2);
    await inStore(narrowed, (sql) => {
      sql.exec(
        "UPDATE sdk_store SET contract_manifest = ?, contract_hash = ?",
        v1,
        older.schemaHash
      );
    });

    for (const store of [edited, unreadable, halved, respelled, narrowed]) {
      // One at a time, so a failure names its store.
      // oxlint-disable-next-line no-await-in-loop -- see above
      await expect(store.defineTables(v2)).rejects.toMatchObject({
        code: "migration.metadata_corrupt",
      });
    }
  });

  it("rebuild a missing contract from the schemas the store recorded", async () => {
    const store = await newStore();
    await store.defineTables(v1);
    const second = await store.defineTables(v2);
    await insert(store, second.schemaHash, {
      title: "Launch",
      category: "news",
    });
    await inStore(store, (sql) => {
      sql.exec(
        "UPDATE sdk_store SET contract_hash = NULL, contract_manifest = NULL"
      );
    });

    const again = await store.defineTables(v1);

    // The fold of both recorded schemas, so the second's field is kept.
    expect(again.contract).toMatchObject({ hash: second.schemaHash });
    await expect(
      store.defineTables(
        notes({ ...noteFields, category: v.number().optional() })
      )
    ).rejects.toMatchObject({ code: "migration.required" });
  });

  it("refuse a missing contract its recorded schemas can't rebuild, or records with no schema", async () => {
    const conflicting = await newStore();
    await conflicting.defineTables(v2);
    const retyped = notes({ ...noteFields, category: v.number().optional() });
    const retypedHash = await manifestHash(retyped);
    await inStore(conflicting, (sql) => {
      sql.exec(
        "UPDATE sdk_store SET contract_hash = NULL, contract_manifest = NULL"
      );
      sql.exec(
        "INSERT INTO sdk_schemas (schema_hash, manifest, created_at) VALUES (?, ?, ?)",
        retypedHash,
        retyped,
        Date.now() + 1000
      );
    });

    const orphaned = await newStore();
    const defined = await orphaned.defineTables(v1);
    await insert(orphaned, defined.schemaHash, { title: "Launch" });
    await inStore(orphaned, (sql) => {
      sql.exec("DELETE FROM sdk_schemas");
      sql.exec(
        "UPDATE sdk_store SET contract_hash = NULL, contract_manifest = NULL"
      );
    });

    for (const store of [conflicting, orphaned]) {
      // One at a time, so a failure names its store.
      // oxlint-disable-next-line no-await-in-loop -- see above
      await expect(store.defineTables(v1)).rejects.toMatchObject({
        code: "migration.metadata_missing",
      });
    }
  });
});

describe("failures and races", () => {
  it("leave the contract as it was when an index fails, and apply on retry", async () => {
    const store = await newStore();
    const first = await store.defineTables(v1);
    const indexed = notes(noteFields, { indexed: true });
    // An index already holding its name with another definition: the
    // store refuses to trust it, in the transaction that would apply the
    // schema.
    const planned = await planIndexes(
      readSchemaManifest(indexed).manifest,
      first.tables
    );
    const name = planned.get("notes")?.get("by_title")?.name ?? "";
    await inStore(store, (sql) => {
      sql.exec(`CREATE INDEX ${name} ON sdk_records (record_id)`);
    });
    const before = await snapshot(store);

    await expect(
      store.defineTables(
        manifestText(
          schemaManifest(
            defineSchema({
              notes: defineTable(noteFields).index("by_title", ["title"]),
              tags: defineTable({ name: v.string() }),
            }),
            {
              tables: {
                notes: { read: "appMembers", write: "appMembers" },
                tags: { read: "appMembers", write: "appMembers" },
              },
            }
          )
        ),
        consumer(2)
      )
    ).rejects.toThrow(/another definition/u);
    await expect(snapshot(store)).resolves.toStrictEqual(before);

    await inStore(store, (sql) => {
      sql.exec(`DROP INDEX ${name}`);
    });
    await expect(
      store.defineTables(indexed, consumer(2))
    ).resolves.toMatchObject({ contract: { changed: true } });
  });

  it("answer a schema applied again with its receipt's own contract and plan", async () => {
    const store = await newStore();
    await store.defineTables(v1);
    const first = await store.defineTables(v2, consumer(2));
    await store.defineTables(
      notes({
        ...noteFields,
        category: v.string().optional(),
        size: v.number().optional(),
      }),
      consumer(3)
    );

    const again = await store.defineTables(v2, consumer(2));

    expect(again.contract).toStrictEqual(first.contract);
  });

  it("write nothing when a schema is applied again for its consumer, after another moved the contract's indexes", async () => {
    const store = await newStore();
    const first = await store.defineTables(v1, consumer(1));
    await store.defineTables(notes(noteFields, { indexed: true }), consumer(2));
    const before = await snapshot(store);

    const again = await store.defineTables(v1, consumer(1));

    await expect(snapshot(store)).resolves.toStrictEqual(before);
    expect(again.contract).toStrictEqual(first.contract);
  });

  it("record an index-only change under its own receipt, and keep the index", async () => {
    const store = await newStore();
    await store.defineTables(v1, consumer(1));
    await store.defineTables(notes(noteFields, { indexed: true }), consumer(2));
    const indexes = await inStore(store, (sql) =>
      sql
        .exec("SELECT name FROM sqlite_master WHERE name LIKE 'sdk_ix_%'")
        .toArray()
    );

    const third = await store.defineTables(v1, consumer(3));

    const { plan, manifest } = await inStore(store, (sql) => ({
      plan: sql
        .exec<{ plan: string }>(
          "SELECT plan FROM sdk_schema_activations WHERE receipt_id = ?",
          third.contract.receiptId
        )
        .one().plan,
      manifest: sql
        .exec<{ manifest: string }>(
          "SELECT contract_manifest AS manifest FROM sdk_store"
        )
        .one().manifest,
    }));
    const recorded = z
      .object({ retainedIndexes: z.array(z.array(z.string())) })
      .parse(JSON.parse(plan));
    expect({
      plan: recorded.retainedIndexes,
      indexes: await inStore(store, (sql) =>
        sql
          .exec("SELECT name FROM sqlite_master WHERE name LIKE 'sdk_ix_%'")
          .toArray()
      ),
      listed: Object.keys(
        readSchemaManifest(manifest).manifest.tables.notes?.indexes ?? {}
      ),
    }).toStrictEqual({
      plan: [["notes", "by_title"]],
      indexes,
      listed: [],
    });
  });

  it("refuse as busy, and retryable, a schema that keeps losing to others applied at once", async () => {
    const store = await newStore();
    await store.defineTables(v1);
    const fields = ["a", "b", "c", "d", "e", "f"];

    const outcomes = await atOnce(
      store,
      fields.map(
        (field, index) =>
          [
            notes({ ...noteFields, [field]: v.string().optional() }),
            consumer(index + 2),
          ] as const
      )
    );

    const applied = fields.filter(
      (_field, index) => outcomes[index]?.status === "fulfilled"
    );
    const refused = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [codeOf(outcome.reason)] : []
    );
    expect({
      someRefused: refused.length > 0,
      refused: [...new Set(refused)],
      contract: await contractFields(store),
    }).toStrictEqual({
      someRefused: true,
      refused: ["migration.busy"],
      contract: [...applied, "title"],
    });
  });

  it("give one winner of two conflicting schemas applied at once", async () => {
    const store = await newStore();
    await store.defineTables(v1);
    const asText = notes({ ...noteFields, colour: v.string().optional() });
    const asNumber = notes({ ...noteFields, colour: v.number().optional() });

    const outcomes = await atOnce(store, [
      [asText, consumer(2)],
      [asNumber, consumer(3)],
    ]);

    const won = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value.schemaHash] : []
    );
    const lost = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [codeOf(outcome.reason)] : []
    );
    expect(won).toHaveLength(1);
    expect(lost).toStrictEqual(["migration.required"]);
    const [winner] = won;
    await expect(
      snapshot(store).then(({ contract }) => contract)
    ).resolves.toStrictEqual([
      expect.objectContaining({ contract_hash: winner }),
    ]);
  });

  it("apply two compatible schemas applied at once, one after the other", async () => {
    const store = await newStore();
    await store.defineTables(v1);

    const outcomes = await atOnce(store, [
      [notes({ ...noteFields, colour: v.string().optional() }), consumer(2)],
      [notes({ ...noteFields, size: v.number().optional() }), consumer(3)],
    ]);

    expect(outcomes.map(({ status }) => status)).toStrictEqual([
      "fulfilled",
      "fulfilled",
    ]);
    await expect(contractFields(store)).resolves.toStrictEqual([
      "colour",
      "size",
      "title",
    ]);
  });
});

describe("older versions writing", () => {
  it("keep fields a newer version stored, through a patch or a replacement", async () => {
    const store = await newStore();
    const older = await store.defineTables(v1);
    const newer = await store.defineTables(v2);
    const patched = await insert(store, newer.schemaHash, {
      title: "Launch",
      category: "news",
    });
    const replaced = await insert(store, newer.schemaHash, {
      title: "Hiring",
      category: "jobs",
    });

    await commit(store, older.schemaHash, [
      {
        op: "patch",
        table: "notes",
        id: patched,
        fields: { title: "Launched" },
        unset: [],
        expectedRevision: 1,
      },
      {
        op: "replace",
        table: "notes",
        id: replaced,
        fields: { title: "Hired" },
        expectedRevision: 1,
      },
    ]);

    const afterPatch = await store.get("notes", patched);
    const afterReplace = await store.get("notes", replaced);
    expect({
      patched: afterPatch?.fields,
      replaced: afterReplace?.fields,
    }).toStrictEqual({
      patched: { title: "Launched", category: "news" },
      replaced: { title: "Hired", category: "jobs" },
    });
  });
});
