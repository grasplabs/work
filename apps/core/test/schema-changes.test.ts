import { defineSchema, defineTable, rows, v } from "@grasp-os/sdk";
import type { ValueShape } from "@grasp-os/sdk";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import type { StoreFields } from "@grasp-os/shared/stores";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { OpenStore } from "../src/data-stores.ts";
import type { SchemaIds } from "../src/schema-changes.ts";
import type { SchemaApply } from "../src/store-host.ts";
import {
  codeOf,
  commit,
  insertAll,
  newStore,
  notesOf,
  schemaHashOf,
} from "./notes-stores.ts";
import { manifestHash, newRecordId } from "./store-schemas.ts";

// A version's schema applied to its App's store as it is published
// (store-host.ts, `applySchema`; schema-changes.ts): diffed by the stable
// IDs of the App's definition, then applied in one transaction. Each case
// of its failure model, broken on purpose: a change that would lose data
// or mix up records is refused and changes nothing.

const notesId = "table:notes";
const peopleId = "table:people";

/** A schema of `notes` with `fields`, read and written by the App's members. */
const notesText = (
  fields: ValueShape,
  { table = "notes" }: { table?: string } = {}
): string =>
  manifestText(
    schemaManifest(
      defineSchema({
        [table]: defineTable(fields).access({
          read: "appMembers",
          write: "appMembers",
        }),
      })
    )
  );

/** IDs for one table: the table's, and each field's by name. */
const idsOf = (
  table: string,
  tableId: string,
  fields: Readonly<Record<string, string>>
): SchemaIds => ({ [table]: { id: tableId, fields } });

/** `text` with `ids`, as a publish applies it, for Ada. */
const change = (
  text: string,
  ids: SchemaIds,
  more: Partial<SchemaApply> = {}
): SchemaApply => ({
  manifest: text,
  ids,
  actor: { type: "person", userId: "ada" },
  ...more,
});

const title = v.string().min(1).max(200);
const v1 = notesText({ title, category: v.string().optional() });
const v1Ids = idsOf("notes", notesId, {
  title: "field:title",
  category: "field:category",
});

/** Each team's members read its notes: what a row rule reads is `team`. */
const byTeam = {
  read: "appMembers",
  write: "appMembers",
  rows: { read: [rows.team("team")] },
} as const;

/** Notes each team reads, their team optional. */
const teamOptional = manifestText(
  schemaManifest(
    defineSchema({
      notes: defineTable({ title, team: v.string().optional() }).access(byTeam),
    })
  )
);

/** Notes each team reads, their team required. */
const teamRequired = manifestText(
  schemaManifest(
    defineSchema({
      notes: defineTable({ title, team: v.string() }).access(byTeam),
    })
  )
);

/**
 * Stages `rewrite` of every record of table `table` (`notes`, by its ID
 * `tableId`) of `store` as a migration's output.
 */
const staged = async (
  store: OpenStore,
  rewrite: (fields: StoreFields) => StoreFields,
  { table = "notes", tableId = notesId } = {}
) => {
  const { migrationId, schemaHash } = await store.beginMigration();
  const read = await store.migrationRows(tableId, null);
  await store.stageMigration({
    migrationId,
    table: tableId,
    rows: read.map(({ id, revision, fields }) => ({
      id,
      revision,
      fields: rewrite(fields),
    })),
  });
  return { id: migrationId, from: schemaHash ?? "", tables: [table] };
};

/** A store under v1 holding a note of each of `fields`; their IDs. */
const storeWith = async (
  ...fields: StoreFields[]
): Promise<{ store: OpenStore; ids: string[]; schemaHash: string }> => {
  const store = await newStore();
  const { schemaHash } = await store.applySchema(change(v1, v1Ids));
  const ids = await insertAll(store, schemaHash, fields);
  return { store, ids, schemaHash };
};

/** A record's title, for ordering. */
const titleOf = ({ title: named }: StoreFields): string =>
  typeof named === "string" ? named : "";

/** Each note's fields, by title. */
const fieldsOf = async (store: OpenStore): Promise<StoreFields[]> => {
  const held = await notesOf(store);
  return [...held.values()]
    .map(({ fields }) => fields)
    .toSorted((a, b) => titleOf(a).localeCompare(titleOf(b)));
};

/** What `store` holds: its schema in force and its notes. */
const heldBy = async (store: OpenStore) => ({
  schema: await schemaHashOf(store),
  notes: await fieldsOf(store),
});

describe("a schema change by stable ID", { timeout: 120_000 }, () => {
  it("moves a renamed field's values to its new name, and back as the older schema returns", async () => {
    const { store, ids } = await storeWith(
      { title: "Launch", category: "news" },
      { title: "Hiring" }
    );
    const v2 = notesText({ title, topic: v.string().optional() });
    const v2Ids = idsOf("notes", notesId, {
      title: "field:title",
      topic: "field:category",
    });

    const renamed = await store.applySchema(change(v2, v2Ids));
    const moved = await fieldsOf(store);
    await store.applySchema(change(v1, v1Ids));
    const held = await notesOf(store);

    expect({
      changes: renamed.changes.renamedFields,
      moved,
      back: await fieldsOf(store),
      revisions: [...held.values()].map(({ revision }) => revision),
    }).toStrictEqual({
      changes: [{ table: "notes", from: "category", to: "topic" }],
      moved: [{ title: "Hiring" }, { title: "Launch", topic: "news" }],
      back: [{ title: "Hiring" }, { title: "Launch", category: "news" }],
      revisions: ids.map(() => 1),
    });
  });

  it("renames a table by its ID, keeping its records and the references to them", async () => {
    const store = await newStore();
    const schema = (notes: string) =>
      manifestText(
        schemaManifest(
          defineSchema({
            [notes]: defineTable({ title }).access({
              read: "appMembers",
              write: "appMembers",
            }),
            people: defineTable({ note: v.id(notes) }).access({
              read: "appMembers",
              write: "appMembers",
            }),
          })
        )
      );
    const ids = (notes: string): SchemaIds => ({
      [notes]: { id: notesId, fields: { title: "field:title" } },
      people: { id: peopleId, fields: { note: "field:note" } },
    });
    const { schemaHash } = await store.applySchema(
      change(schema("notes"), ids("notes"))
    );
    const note = newRecordId();
    await commit(store, schemaHash, [
      { op: "insert", table: "notes", id: note, fields: { title: "Launch" } },
      {
        op: "insert",
        table: "people",
        id: newRecordId(),
        fields: { note },
      },
    ]);

    const renamed = await store.applySchema(
      change(schema("memos"), ids("memos"))
    );

    expect({
      changes: renamed.changes.renamedTables,
      memo: await store.get("memos", note),
      gone: await codeOf(store.get("notes", note)),
      // The reference still holds it: deleting it is refused.
      deleted: await codeOf(
        commit(store, renamed.schemaHash, [
          { op: "delete", table: "memos", id: note },
        ])
      ),
    }).toMatchObject({
      changes: [{ id: notesId, from: "notes", to: "memos" }],
      memo: { fields: { title: "Launch" } },
      gone: "data.unknown_table",
      deleted: "data.referenced",
    });
  });

  it("renames a table a kept reference points at, which keeps holding the same records", async () => {
    const store = await newStore();
    const access = { read: "appMembers", write: "appMembers" } as const;
    // People, with or without the note each refers to, and the notes
    // table named `notes`.
    const schema = (notes: string, withNote: boolean) =>
      manifestText(
        schemaManifest(
          defineSchema({
            [notes]: defineTable({ title }).access(access),
            people: defineTable({
              name: v.string(),
              ...(withNote ? { note: v.id(notes).optional() } : {}),
            }).access(access),
          })
        )
      );
    const ids = (notes: string, withNote: boolean): SchemaIds => ({
      [notes]: { id: notesId, fields: { title: "field:title" } },
      people: {
        id: peopleId,
        fields: {
          name: "field:name",
          ...(withNote ? { note: "field:note" } : {}),
        },
      },
    });
    const first = await store.applySchema(
      change(schema("notes", true), ids("notes", true))
    );
    const note = newRecordId();
    const person = newRecordId();
    await commit(store, first.schemaHash, [
      { op: "insert", table: "notes", id: note, fields: { title: "Launch" } },
      {
        op: "insert",
        table: "people",
        id: person,
        fields: { name: "Ada", note },
      },
    ]);
    // The reference left out (kept), then its table renamed.
    await store.applySchema(
      change(schema("notes", false), ids("notes", false))
    );
    const renamed = await store.applySchema(
      change(schema("memos", false), ids("memos", false))
    );

    // A person written while the reference is kept carries it over.
    const written = await codeOf(
      commit(store, renamed.schemaHash, [
        {
          op: "patch",
          table: "people",
          id: person,
          fields: { name: "Ada Lovelace" },
        },
      ])
    );
    // Back, as a reference to the table by its new name: the same field.
    const back = await store.applySchema(
      change(schema("memos", true), ids("memos", true))
    );

    expect({
      written,
      added: back.changes.addedFields,
      person: await store.get("people", person),
      // The reference still holds the memo: deleting it is refused.
      deleted: await codeOf(
        commit(store, back.schemaHash, [
          { op: "delete", table: "memos", id: note },
        ])
      ),
    }).toMatchObject({
      written: "ok",
      added: [{ table: "people", field: "note" }],
      person: { fields: { name: "Ada Lovelace", note } },
      deleted: "data.referenced",
    });
  });

  it("restricts a reference that cascaded once its field says so", async () => {
    const store = await newStore();
    const access = { read: "appMembers", write: "appMembers" } as const;
    const schema = (note: ValueShape[string]) =>
      manifestText(
        schemaManifest(
          defineSchema({
            notes: defineTable({ title }).access(access),
            people: defineTable({ note }).access(access),
          })
        )
      );
    const ids: SchemaIds = {
      notes: { id: notesId, fields: { title: "field:title" } },
      people: { id: peopleId, fields: { note: "field:note" } },
    };
    const first = await store.applySchema(
      change(schema(v.id("notes", { onDelete: "cascade" })), ids)
    );
    const note = newRecordId();
    await commit(store, first.schemaHash, [
      { op: "insert", table: "notes", id: note, fields: { title: "Launch" } },
      { op: "insert", table: "people", id: newRecordId(), fields: { note } },
    ]);

    const restricted = await store.applySchema(
      change(schema(v.id("notes")), ids)
    );

    await expect(
      codeOf(
        commit(store, restricted.schemaHash, [
          { op: "delete", table: "notes", id: note },
        ])
      )
    ).resolves.toBe("data.referenced");
  });

  it("renames a field and fills in another in one change", async () => {
    const { store } = await storeWith({ title: "Launch", category: "news" });
    const v2 = notesText({
      title,
      topic: v.string().optional(),
      status: v.string().default("open"),
    });

    await store.applySchema(
      change(
        v2,
        idsOf("notes", notesId, {
          title: "field:title",
          topic: "field:category",
          status: "field:status",
        })
      )
    );

    await expect(fieldsOf(store)).resolves.toStrictEqual([
      { title: "Launch", topic: "news", status: "open" },
    ]);
  });

  it("refuses a name in force under another ID, and a name a kept field holds, changing nothing", async () => {
    const { store } = await storeWith({ title: "Launch", category: "news" });
    const before = await heldBy(store);
    const swapped = await codeOf(
      store.applySchema(
        change(
          v1,
          idsOf("notes", notesId, {
            title: "field:title",
            category: "field:other",
          })
        )
      )
    );
    // Category left out: kept, its values with it. A field under another
    // ID may not take its name.
    await store.applySchema(
      change(
        notesText({ title }),
        idsOf("notes", notesId, { title: "field:title" })
      )
    );
    const reused = await store
      .applySchema(
        change(
          v1,
          idsOf("notes", notesId, {
            title: "field:title",
            category: "field:new",
          })
        )
      )
      .catch((error: unknown) => error);

    expect({
      swapped,
      reused,
      afterSwap: before,
      notes: await fieldsOf(store),
    }).toMatchObject({
      swapped: "migration.required",
      reused: {
        code: "migration.required",
        details: {
          refused: [
            { table: "notes", field: "category", reason: "name_taken" },
          ],
        },
      },
      notes: [{ title: "Launch", category: "news" }],
    });
  });

  it("refuses a table name another table's ID holds", async () => {
    const { store } = await storeWith({ title: "Launch" });
    await expect(
      store.applySchema(
        change(v1, idsOf("notes", "table:other", v1Ids.notes?.fields ?? {}))
      )
    ).rejects.toMatchObject({
      code: "migration.required",
      details: { refused: [{ table: "notes", reason: "id_changed" }] },
    });
  });
});

describe(
  "a schema change that would lose or bend data",
  { timeout: 120_000 },
  () => {
    it("keeps a field the schema leaves out, and brings its values back with it", async () => {
      const { store } = await storeWith({ title: "Launch", category: "news" });
      const v2 = notesText({ title });

      const left = await store.applySchema(
        change(v2, idsOf("notes", notesId, { title: "field:title" }))
      );
      await insertAll(store, left.schemaHash, [{ title: "Hiring" }]);
      const kept = await fieldsOf(store);
      await store.applySchema(change(v1, v1Ids));

      expect({
        kept: left.changes.keptFields,
        held: kept,
        back: await fieldsOf(store),
      }).toStrictEqual({
        kept: [{ table: "notes", field: "category" }],
        held: [{ title: "Hiring" }, { title: "Launch", category: "news" }],
        back: [{ title: "Hiring" }, { title: "Launch", category: "news" }],
      });
    });

    it("refuses a type change without a migration, and keeps every value", async () => {
      const { store } = await storeWith({ title: "Launch", category: "news" });
      const before = await heldBy(store);

      const refused = await store
        .applySchema(
          change(notesText({ title, category: v.number().optional() }), v1Ids)
        )
        .catch((error: unknown) => error);

      expect({ refused, held: await heldBy(store) }).toMatchObject({
        refused: {
          code: "migration.required",
          details: {
            refused: [
              { table: "notes", field: "category", reason: "field_changed" },
            ],
          },
        },
        held: before,
      });
    });

    it("refuses an answer that doesn't fit its field, and fills one that does with its nested defaults", async () => {
      const { store } = await storeWith({ title: "Launch" });
      const before = await heldBy(store);
      const sized = notesText({ title, size: v.number() });
      const sizedIds = idsOf("notes", notesId, {
        title: "field:title",
        size: "field:size",
      });

      const unfit = await store
        .applySchema(
          change(sized, sizedIds, {
            answers: [{ table: "notes", field: "size", value: "abc" }],
          })
        )
        .catch((error: unknown) => error);
      const held = await heldBy(store);
      await store.applySchema(
        change(
          notesText({
            title,
            meta: v.object({ tag: v.string().default("general") }),
          }),
          idsOf("notes", notesId, { title: "field:title", meta: "field:meta" }),
          { answers: [{ table: "notes", field: "meta", value: {} }] }
        )
      );

      expect({ unfit, held, notes: await fieldsOf(store) }).toMatchObject({
        unfit: {
          code: "migration.required",
          details: {
            refused: [
              { table: "notes", field: "size", reason: "answer_unfit" },
            ],
          },
        },
        held: before,
        notes: [{ title: "Launch", meta: { tag: "general" } }],
      });
    });

    it("fills in an answer of null, as given", async () => {
      const { store } = await storeWith({ title: "Launch" });

      await store.applySchema(
        change(
          notesText({ title, note: v.string().nullable() }),
          idsOf("notes", notesId, { title: "field:title", note: "field:note" }),
          { answers: [{ table: "notes", field: "note", value: null }] }
        )
      );

      await expect(fieldsOf(store)).resolves.toStrictEqual([
        { title: "Launch", note: null },
      ]);
    });

    it("refuses a default added inside a field already defaulted, which records lack", async () => {
      // Settings, defaulted, inside a field of its own.
      const settings = (fields: ValueShape) =>
        notesText({
          title,
          prefs: v.object({ settings: v.object(fields).default({}) }),
        });
      const ids = idsOf("notes", notesId, {
        title: "field:title",
        prefs: "field:prefs",
      });
      const store = await newStore();
      const { schemaHash } = await store.applySchema(
        change(settings({ theme: v.string().default("light") }), ids)
      );
      await insertAll(store, schemaHash, [
        { title: "Launch", prefs: { settings: { theme: "dark" } } },
      ]);

      const refused = await codeOf(
        store.applySchema(
          change(
            settings({
              theme: v.string().default("light"),
              tone: v.string().default("calm"),
            }),
            ids
          )
        )
      );

      expect(refused).toBe("migration.required");
    });

    it("applies a widened field on its own", async () => {
      const { store } = await storeWith({ title: "Launch", category: "news" });
      const widened = await store.applySchema(
        change(
          notesText({
            title: v.string().min(1).max(500),
            category: v.string().optional(),
          }),
          v1Ids
        )
      );
      expect(widened.changes.widenedFields).toStrictEqual([
        { table: "notes", field: "title" },
      ]);
    });

    it("refuses a required field records lack, changing nothing, until it has an answer", async () => {
      const { store } = await storeWith(
        { title: "Launch" },
        { title: "Hiring" }
      );
      const before = await heldBy(store);
      const v2 = notesText({ title, category: v.string() });

      const lacking = await store
        .applySchema(change(v2, v1Ids))
        .catch((error: unknown) => error);
      const held = await heldBy(store);
      await store.applySchema(
        change(v2, v1Ids, {
          answers: [{ table: "notes", field: "category", value: "general" }],
        })
      );

      expect({ lacking, held, notes: await fieldsOf(store) }).toMatchObject({
        lacking: {
          code: "migration.required",
          details: {
            lacking: [{ table: "notes", field: "category", records: 2 }],
          },
        },
        held: before,
        notes: [
          { title: "Hiring", category: "general" },
          { title: "Launch", category: "general" },
        ],
      });
    });

    it("takes back what it rewrote when it is refused midway, all of it", async () => {
      const { store } = await storeWith({ title: "Launch", category: "news" });
      const before = await heldBy(store);

      // Its rename rewrites every record, then a field they lack refuses it.
      const refused = await codeOf(
        store.applySchema(
          change(
            notesText({
              title,
              topic: v.string().optional(),
              status: v.string(),
            }),
            idsOf("notes", notesId, {
              title: "field:title",
              topic: "field:category",
              status: "field:status",
            })
          )
        )
      );

      expect({ refused, held: await heldBy(store) }).toStrictEqual({
        refused: "migration.required",
        held: before,
      });
    });

    it("refuses a default or answer that would decide who sees records, or what they refer to", async () => {
      const store = await newStore();
      const ids = idsOf("notes", notesId, {
        title: "field:title",
        team: "field:team",
      });
      await store.applySchema(change(teamOptional, ids));

      await expect(
        store.applySchema(
          change(teamRequired, ids, {
            answers: [{ table: "notes", field: "team", value: "everyone" }],
          })
        )
      ).rejects.toMatchObject({
        code: "migration.required",
        details: {
          refused: [
            { table: "notes", field: "team", reason: "rule_field_filled" },
          ],
        },
      });
    });

    it("refuses reads and writes under any schema but the one in force", async () => {
      const { store, schemaHash, ids } = await storeWith({ title: "Launch" });
      const v2 = notesText({
        title,
        category: v.string().optional(),
        done: v.boolean().optional(),
      });
      await store.applySchema(
        change(
          v2,
          idsOf("notes", notesId, {
            ...v1Ids.notes?.fields,
            done: "field:done",
          })
        )
      );

      expect({
        write: await codeOf(
          commit(store, schemaHash, [
            {
              op: "patch",
              table: "notes",
              id: ids[0] ?? "",
              fields: { title: "Late" },
            },
          ])
        ),
        notes: await fieldsOf(store),
      }).toStrictEqual({
        write: "migration.not_current",
        notes: [{ title: "Launch" }],
      });
    });
  }
);

describe("a schema change's migration", { timeout: 120_000 }, () => {
  const v2 = notesText({ title, category: v.number().optional() });

  it("rewrites every record of its table with the schema, in one transaction", async () => {
    const { store } = await storeWith(
      { title: "Launch", category: "news" },
      { title: "Hiring", category: "jobs!" }
    );
    const migration = await staged(store, ({ title: named, category }) => ({
      title: named ?? "",
      category: typeof category === "string" ? category.length : 0,
    }));

    await store.applySchema(change(v2, v1Ids, { migration }));

    await expect(heldBy(store)).resolves.toStrictEqual({
      schema: await manifestHash(v2),
      notes: [
        { title: "Hiring", category: 5 },
        { title: "Launch", category: 4 },
      ],
    });
  });

  it("changes nothing when a record changed, or was added, after it read them", async () => {
    const { store, schemaHash, ids } = await storeWith({
      title: "Launch",
      category: "news",
    });
    const migration = await staged(store, (fields) => ({
      ...fields,
      category: 1,
    }));
    await commit(store, schemaHash, [
      {
        op: "patch",
        table: "notes",
        id: ids[0] ?? "",
        fields: { category: "press" },
      },
    ]);
    const before = await heldBy(store);

    const changed = await codeOf(
      store.applySchema(change(v2, v1Ids, { migration }))
    );
    const fresh = await staged(store, (fields) => ({ ...fields, category: 1 }));
    await insertAll(store, schemaHash, [{ title: "Hiring" }]);
    const added = await codeOf(
      store.applySchema(change(v2, v1Ids, { migration: fresh }))
    );

    expect({ changed, added, held: before }).toStrictEqual({
      changed: "migration.busy",
      added: "migration.busy",
      held: {
        schema: schemaHash,
        notes: [{ title: "Launch", category: "press" }],
      },
    });
  });

  it("is refused when staged from another schema than the one in force", async () => {
    const { store } = await storeWith({ title: "Launch", category: "news" });
    const migration = await staged(store, (fields) => ({
      ...fields,
      category: 1,
    }));
    await expect(
      store.applySchema(
        change(v2, v1Ids, { migration: { ...migration, from: "f".repeat(64) } })
      )
    ).rejects.toMatchObject({ code: "migration.invalid" });
  });

  it("refuses an output that rewrites a reference behind the store's index, writing nothing", async () => {
    const store = await newStore();
    const people = (size: "text" | "number") =>
      manifestText(
        schemaManifest(
          defineSchema({
            notes: defineTable({ title }).access({
              read: "appMembers",
              write: "appMembers",
            }),
            people: defineTable({
              note: v.id("notes"),
              size: size === "text" ? v.string() : v.number(),
            }).access({ read: "appMembers", write: "appMembers" }),
          })
        )
      );
    const ids: SchemaIds = {
      notes: { id: notesId, fields: { title: "field:title" } },
      people: {
        id: peopleId,
        fields: { note: "field:note", size: "field:size" },
      },
    };
    const first = await store.applySchema(change(people("text"), ids));
    const launch = newRecordId();
    const hiring = newRecordId();
    await commit(store, first.schemaHash, [
      { op: "insert", table: "notes", id: launch, fields: { title: "Launch" } },
      { op: "insert", table: "notes", id: hiring, fields: { title: "Hiring" } },
      {
        op: "insert",
        table: "people",
        id: newRecordId(),
        fields: { note: launch, size: "big" },
      },
    ]);
    const migration = await staged(store, () => ({ note: hiring, size: 3 }), {
      table: "people",
      tableId: peopleId,
    });

    const refused = await store
      .applySchema(change(people("number"), ids, { migration }))
      .catch((error: unknown) => error);

    expect({
      refused,
      schema: await schemaHashOf(store),
    }).toMatchObject({
      refused: {
        code: "migration.failed",
        details: { reason: "reference_changed" },
      },
      schema: first.schemaHash,
    });
  });

  it("refuses an output that makes a field referring to records plain text, though its value stays", async () => {
    const store = await newStore();
    const access = { read: "appMembers", write: "appMembers" } as const;
    const schema = (note: ValueShape[string]) =>
      manifestText(
        schemaManifest(
          defineSchema({
            notes: defineTable({ title }).access(access),
            people: defineTable({ note }).access(access),
          })
        )
      );
    const ids: SchemaIds = {
      notes: { id: notesId, fields: { title: "field:title" } },
      people: { id: peopleId, fields: { note: "field:note" } },
    };
    const first = await store.applySchema(
      change(schema(v.id("notes", { onDelete: "cascade" })), ids)
    );
    const note = newRecordId();
    await commit(store, first.schemaHash, [
      { op: "insert", table: "notes", id: note, fields: { title: "Launch" } },
      { op: "insert", table: "people", id: newRecordId(), fields: { note } },
    ]);
    const before = await schemaHashOf(store);

    const migration = await staged(store, (fields) => fields, {
      table: "people",
      tableId: peopleId,
    });
    const refused = await codeOf(
      store.applySchema(change(schema(v.string()), ids, { migration }))
    );

    expect({ refused, schema: await schemaHashOf(store) }).toStrictEqual({
      refused: "migration.failed",
      schema: before,
    });
  });

  it("refuses an output that takes over a kept field's name for a field referring to records", async () => {
    const { store, ids } = await storeWith({ title: "Launch" });
    const [note = ""] = ids;
    const linked = (link: ValueShape[string]) =>
      notesText({ title, category: v.string().optional(), link });
    const withLink = idsOf("notes", notesId, {
      title: "field:title",
      category: "field:category",
      link: "field:link",
    });
    await store.applySchema(change(linked(v.string().optional()), withLink));
    const kept = await store.applySchema(change(v1, v1Ids));
    await commit(store, kept.schemaHash, [
      {
        op: "patch",
        table: "notes",
        id: note,
        fields: { title: "Linked" },
      },
    ]);
    const before = await schemaHashOf(store);

    // A new field, under the kept one's name, now referring to notes.
    const migration = await staged(store, (fields) => ({
      ...fields,
      link: note,
    }));
    const refused = await store
      .applySchema(
        change(
          linked(v.id("notes").optional()),
          idsOf("notes", notesId, {
            title: "field:title",
            category: "field:category",
            link: "field:link2",
          }),
          { migration }
        )
      )
      .catch((error: unknown) => error);

    expect({ refused, schema: await schemaHashOf(store) }).toMatchObject({
      refused: {
        code: "migration.required",
        details: {
          refused: [{ table: "notes", field: "link", reason: "name_taken" }],
        },
      },
      schema: before,
    });
  });

  it("leaves a field renamed in the same change under its new name alone", async () => {
    const { store } = await storeWith({ title: "Launch", category: "news" });
    // Its output under the new names, with the old name core merges back
    // as a field the new schema doesn't declare.
    const migration = await staged(store, (fields) => ({
      ...fields,
      topic: fields.category ?? null,
      size: typeof fields.category === "string" ? fields.category.length : 0,
    }));

    await store.applySchema(
      change(
        notesText({ title, topic: v.string().optional(), size: v.number() }),
        idsOf("notes", notesId, {
          title: "field:title",
          topic: "field:category",
          size: "field:size",
        }),
        { migration }
      )
    );

    await expect(fieldsOf(store)).resolves.toStrictEqual([
      { title: "Launch", topic: "news", size: 4 },
    ]);
  });
});

describe("two publishes of one store at once", { timeout: 120_000 }, () => {
  it("applies a version's schema only over the version its publish was based on", async () => {
    const { store } = await storeWith({ title: "Launch" });
    await store.applySchema(
      change(v1, v1Ids, { version: { app: "notes", number: 1, basedOn: null } })
    );
    const asText = notesText({ title, colour: v.string().optional() });
    const asNumber = notesText({ title, colour: v.number().optional() });
    const ids = idsOf("notes", notesId, {
      title: "field:title",
      colour: "field:colour",
    });

    await store.applySchema(
      change(asText, ids, { version: { app: "notes", number: 2, basedOn: 1 } })
    );
    const second = await codeOf(
      store.applySchema(
        change(asNumber, ids, {
          version: { app: "notes", number: 3, basedOn: 1 },
        })
      )
    );
    // Another publish of the same version finds its schema there: core
    // makes one of the two current.
    const again = await store.applySchema(
      change(asText, ids, { version: { app: "notes", number: 2, basedOn: 1 } })
    );

    expect({
      second,
      again: again.changed,
      schema: await schemaHashOf(store),
    }).toStrictEqual({
      second: "migration.busy",
      again: false,
      schema: await manifestHash(asText),
    });
  });

  it("puts a schema back only while nothing applied it again since", async () => {
    const { store } = await storeWith({ title: "Launch" });
    await store.applySchema(
      change(v1, v1Ids, { version: { app: "notes", number: 1, basedOn: null } })
    );
    const v2 = notesText({ title, colour: v.string().optional() });
    const ids = idsOf("notes", notesId, {
      title: "field:title",
      colour: "field:colour",
    });
    const first = await store.applySchema(
      change(v2, ids, { version: { app: "notes", number: 2, basedOn: 1 } })
    );
    // The same version, published again at once: its publish answers now.
    await store.applySchema(
      change(v2, ids, { version: { app: "notes", number: 2, basedOn: 1 } })
    );

    // The first publish's batch failed: it would put version 1 back.
    const putBack = await codeOf(
      store.applySchema(
        change(v1, v1Ids, {
          version: { app: "notes", number: 1, basedOn: 2 },
          onlyIfAppliedAt: first.appliedAt,
        })
      )
    );

    expect({ putBack, schema: await schemaHashOf(store) }).toStrictEqual({
      putBack: "migration.busy",
      schema: await manifestHash(v2),
    });
  });

  it("refuses a change without a version to a store that holds one", async () => {
    const { store } = await storeWith({ title: "Launch" });
    await store.applySchema(
      change(v1, v1Ids, { version: { app: "notes", number: 1, basedOn: null } })
    );

    await expect(
      codeOf(
        store.applySchema(
          change(notesText({ title, colour: v.string().optional() }), {
            notes: {
              id: notesId,
              fields: { title: "field:title", colour: "field:colour" },
            },
          })
        )
      )
    ).resolves.toBe("migration.invalid");
  });
});

describe("a reset of a store's data", { timeout: 120_000 }, () => {
  it("is refused without a version current while one was just applied", async () => {
    const { store } = await storeWith({ title: "Launch" });
    // A first publish's schema, applied as the reset read no version current.
    await store.applySchema(
      change(v1, v1Ids, { version: { app: "notes", number: 1, basedOn: null } })
    );
    const before = await heldBy(store);

    const refused = await codeOf(
      env.DATA_STORES.getByName(store.id).resetData(store.id, {
        actor: { type: "person", userId: "ada" },
        app: "notes",
        everything: true,
      })
    );

    expect({ refused, held: await heldBy(store) }).toStrictEqual({
      refused: "migration.busy",
      held: before,
    });
  });

  it("is refused while another version's publish just applied its schema, changing nothing", async () => {
    const { store } = await storeWith({ title: "Launch" });
    await store.applySchema(
      change(v1, v1Ids, { version: { app: "notes", number: 1, basedOn: null } })
    );
    const v2 = notesText({ title, category: v.string().optional() });
    // Version 2 published as the reset was asked for over version 1.
    await store.applySchema(
      change(v2, v1Ids, { version: { app: "notes", number: 2, basedOn: 1 } })
    );
    const before = await heldBy(store);

    const refused = await codeOf(
      env.DATA_STORES.getByName(store.id).resetData(store.id, {
        actor: { type: "person", userId: "ada" },
        app: "notes",
        everything: true,
        apply: change(v1, v1Ids, {
          version: { app: "notes", number: 1, basedOn: 1 },
        }),
      })
    );

    expect({ refused, held: await heldBy(store) }).toStrictEqual({
      refused: "migration.busy",
      held: before,
    });
  });

  it("changes nothing when the schema it applies to the empty store is refused", async () => {
    const { store } = await storeWith({ title: "Launch", category: "news" });
    const before = await heldBy(store);

    // A migration from a schema the empty store won't hold: refused in
    // the reset's own transaction.
    const refused = await codeOf(
      env.DATA_STORES.getByName(store.id).resetData(store.id, {
        actor: { type: "person", userId: "ada" },
        app: "notes",
        everything: true,
        apply: change(v1, v1Ids, {
          migration: {
            id: crypto.randomUUID(),
            from: "0".repeat(64),
            tables: ["notes"],
          },
        }),
      })
    );

    expect({ refused, held: await heldBy(store) }).toStrictEqual({
      refused: "migration.invalid",
      held: before,
    });
  });
});
