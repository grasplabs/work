import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import type { ValueShape } from "@grasp-os/sdk";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import type { SchemaIds } from "@grasp-os/sdk/host";
import type { StoreFields } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import type { OpenStore } from "../src/data-stores.ts";
import {
  codeOf,
  commit,
  consumer,
  newStore,
  objectOf,
} from "./pending-stores.ts";
import { newRecordId } from "./store-schemas.ts";

// A table renamed by its stable ID (an App definition's, GRA-1624): the
// store keeps a table's records, indexes, search index and references by
// the table's own ID, so a version that gives the table's ID another name
// takes it as it is made current, in the activation that checks every
// record, and a rollback gives it its old name back (sdk schema-plan.ts,
// store-host.ts `#renameTables`). Through core's way into a store and its
// Durable Object. What it must never do: hide a table's records under a
// name no version reads, lose a reference to one of them, let a version
// that still names the old table write on, or take a name another table
// holds.

/** Notes, with `fields`, under `name`, and tags that each refer to one. */
const schemaOf = (name: string, fields: ValueShape = {}) =>
  manifestText(
    schemaManifest(
      defineSchema({
        [name]: defineTable({ title: v.string(), ...fields }).access({
          read: "appMembers",
          write: "appMembers",
        }),
        tags: defineTable({ label: v.string(), note: v.id(name) }).access({
          read: "appMembers",
          write: "appMembers",
        }),
      })
    )
  );

/** The IDs of the notes table (`t-notes`), named `name`, and of the tags. */
const idsOf = (
  name: string,
  fields: Record<string, string> = {}
): SchemaIds => ({
  [name]: { id: "t-notes", fields: { title: "f-title", ...fields } },
  tags: { id: "t-tags", fields: { label: "f-label", note: "f-note" } },
});

/** Applies `schema` with `ids` for version `version` of the notes App. */
const define = async (
  store: OpenStore,
  schema: string,
  version: number,
  ids: SchemaIds
) => await store.defineTables(schema, consumer(version), [], [], ids);

/** Makes version `version`, on `schemaHash`, current: its state after. */
const activate = async (
  store: OpenStore,
  schemaHash: string,
  version: number
) => {
  const status = await store.activate(schemaHash, consumer(version));
  return status.state;
};

/** Inserts `fields` into `table` under `schemaHash`; the record's ID. */
const insert = async (
  store: OpenStore,
  schemaHash: string,
  table: string,
  fields: StoreFields
) => {
  const id = newRecordId();
  await commit(store, schemaHash, [{ op: "insert", table, id, fields }]);
  return id;
};

/** Every record's fields, by its table's name now, sorted by title or label. */
const tablesNow = async (store: OpenStore) => {
  const rows = await runInDurableObject(objectOf(store), (_instance, state) =>
    state.storage.sql
      .exec<{ name: string; value: string }>(
        "SELECT t.name AS name, r.value_json AS value FROM sdk_records r JOIN sdk_tables t ON t.table_id = r.table_id"
      )
      .toArray()
  );
  const byTable: Record<string, unknown[]> = {};
  for (const { name, value } of rows) {
    byTable[name] = [
      ...(byTable[name] ?? []),
      z.unknown().parse(JSON.parse(value)),
    ];
  }
  return byTable;
};

/** The names of the store's tables, sorted. */
const tableNames = async (store: OpenStore) =>
  await runInDurableObject(objectOf(store), (_instance, state) =>
    state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sdk_tables ORDER BY name")
      .toArray()
      .map(({ name }) => name)
  );

/** A store whose notes, under version 1, hold one note and one tag of it. */
const notesStore = async () => {
  const store = await newStore();
  const first = await define(store, schemaOf("notes"), 1, idsOf("notes"));
  const note = await insert(store, first.schemaHash, "notes", { title: "A" });
  await insert(store, first.schemaHash, "tags", { label: "red", note });
  return { store, first: first.schemaHash, note };
};

/** The details of a `migration.required` refusal of `call`. */
const requiredOf = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (error) {
    return z
      .object({
        code: z.literal("migration.required"),
        details: z.object({
          changes: z.array(z.object({ reason: z.string() }).loose()),
        }),
      })
      .parse(error).details;
  }
  throw new Error("Not refused");
};

describe("a table renamed by its stable ID", () => {
  it("keeps its records and the references to them, taking its new name only as the version that renames it is made current", async () => {
    const { store, first, note } = await notesStore();

    const second = await define(store, schemaOf("memos"), 2, idsOf("memos"));
    // Sealed, it waits: version 1 still serves, and writes the notes.
    const sealed = {
      awaits: second.contract.awaits,
      tables: await tableNames(store),
    };
    await insert(store, first, "notes", { title: "B" });

    const state = await activate(store, second.schemaHash, 2);

    const renamed = {
      tables: await tableNames(store),
      held: await tablesNow(store),
    };
    // A tag of a memo under its new name, referring to a record it held.
    await insert(store, second.schemaHash, "tags", { label: "blue", note });
    expect({
      sealed,
      state,
      renamed,
      // Version 1 names a table no version writes: refused.
      older: await codeOf(insert(store, first, "notes", { title: "C" })),
    }).toStrictEqual({
      sealed: { awaits: true, tables: ["notes", "tags"] },
      state: "active",
      renamed: {
        tables: ["memos", "tags"],
        held: {
          memos: [{ title: "A" }, { title: "B" }],
          tags: [{ label: "red", note }],
        },
      },
      older: "migration.incompatible_write",
    });
  });

  it("gives it back its old name with a rollback, and the new one again with the version that renames it", async () => {
    const { store, first } = await notesStore();
    const second = await define(store, schemaOf("memos"), 2, idsOf("memos"));
    await activate(store, second.schemaHash, 2);
    await insert(store, second.schemaHash, "memos", { title: "B" });

    await expect(activate(store, first, 1)).resolves.toBe("active");
    await expect(tableNames(store)).resolves.toStrictEqual(["notes", "tags"]);
    await insert(store, first, "notes", { title: "C" });

    await expect(activate(store, second.schemaHash, 2)).resolves.toBe("active");
    const held = await tablesNow(store);
    expect(held.memos).toStrictEqual([
      { title: "A" },
      { title: "B" },
      { title: "C" },
    ]);
  });

  it("renames its fields, adds and checks them in the same change", async () => {
    const store = await newStore();
    const first = await define(
      store,
      schemaOf("notes", { nickname: v.string().optional() }),
      1,
      idsOf("notes", { nickname: "f-nick" })
    );
    await insert(store, first.schemaHash, "notes", {
      title: "A",
      nickname: "Ace",
    });

    const second = await define(
      store,
      schemaOf("memos", {
        displayName: v.string().optional(),
        pinned: v.boolean().default(false),
      }),
      2,
      idsOf("memos", { displayName: "f-nick", pinned: "f-pinned" })
    );
    await activate(store, second.schemaHash, 2);

    const held = await tablesNow(store);
    expect(held.memos).toStrictEqual([
      { title: "A", displayName: "Ace", pinned: false },
    ]);
  });

  it("refuses a name the store holds for another table", async () => {
    const { store } = await notesStore();

    // The notes renamed to `tags`, the tags' name, as the tags become
    // `labels`.
    const refused = await requiredOf(
      define(
        store,
        manifestText(
          schemaManifest(
            defineSchema({
              tags: defineTable({ title: v.string() }).access({
                read: "appMembers",
                write: "appMembers",
              }),
              labels: defineTable({
                label: v.string(),
                note: v.id("tags"),
              }).access({ read: "appMembers", write: "appMembers" }),
            })
          )
        ),
        2,
        {
          tags: { id: "t-notes", fields: { title: "f-title" } },
          labels: {
            id: "t-tags",
            fields: { label: "f-label", note: "f-note" },
          },
        }
      )
    );

    expect(refused.changes).toStrictEqual([
      { table: "tags", reason: "id_changed" },
    ]);
    await expect(tableNames(store)).resolves.toStrictEqual(["notes", "tags"]);
  });
});
