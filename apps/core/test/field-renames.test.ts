import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import type { ValueShape } from "@grasp-os/sdk";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import type { SchemaIds } from "@grasp-os/sdk/host";
import type { StoreFields } from "@grasp-os/shared/stores";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import type { OpenStore } from "../src/data-stores.ts";
import {
  codeOf,
  commit,
  consumer,
  insertAll,
  newStore,
  notes,
  notesOf,
} from "./pending-stores.ts";
import { newRecordId } from "./store-schemas.ts";

// A field renamed by its stable ID (an App definition's, GRA-1530): the
// store keeps every schema's IDs, and a field it holds under one name
// that a schema declares under another is the same field, its values
// moving to the new name as that schema's release is made current, the
// old name leaving every record and the contract (sdk schema-plan.ts,
// store-schema-changes.ts). Through core's way into a store and its
// Durable Object. What it must never do: hide a value under a name no
// version reads (a rename that doesn't carry), lose one (a rollback, a
// version skipped, a type change), let a version that still writes the
// old name write on, or read one field's values as another's (a name
// given to another field).

/** Notes with a title and `fields`. */
const notesWith = (fields: ValueShape) =>
  notes({ title: v.string(), ...fields });

/** The IDs of the notes table (`t1`) and of its title and `fields`. */
const idsOf = (fields: Record<string, string>): SchemaIds => ({
  notes: { id: "t1", fields: { title: "f-title", ...fields } },
});

/** Version 1: a nickname. */
const nicknamed = notesWith({ nickname: v.string().optional() });
const nicknameIds = idsOf({ nickname: "f-nick" });

/** Version 2: the nickname renamed, its ID kept. */
const displayNamed = notesWith({ displayName: v.string().optional() });
const displayNameIds = idsOf({ displayName: "f-nick" });

/** Applies `schema` with `ids` for version `version` of the notes App. */
const define = async (
  store: OpenStore,
  schema: string,
  version: number,
  ids: SchemaIds,
  answers: { table: string; field: string; value: string }[] = []
) => await store.defineTables(schema, consumer(version), [], answers, ids);

/** Makes version `version`, on `schemaHash`, current: its state after. */
const activate = async (
  store: OpenStore,
  schemaHash: string,
  version: number
) => {
  const status = await store.activate(schemaHash, consumer(version));
  return status.state;
};

/** Every note's fields, by its title. */
const byTitle = async (store: OpenStore) => {
  const held = await notesOf(store);
  return Object.fromEntries(
    [...held.values()].map(({ fields }) => [
      z.string().parse(fields.title),
      fields,
    ])
  );
};

/** Inserts `fields` under `schemaHash`. */
const insert = async (
  store: OpenStore,
  schemaHash: string,
  fields: StoreFields
) =>
  await commit(store, schemaHash, [
    { op: "insert", table: "notes", id: newRecordId(), fields },
  ]);

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
          questions: z.array(z.unknown()).optional(),
        }),
      })
      .parse(error).details;
  }
  throw new Error("Not refused");
};

/** A store whose notes, under version 1, hold `rows`. */
const nicknamedStore = async (rows: StoreFields[]) => {
  const store = await newStore();
  const first = await define(store, nicknamed, 1, nicknameIds);
  await insertAll(store, first.schemaHash, rows);
  return { store, first: first.schemaHash };
};

describe("a field renamed by its stable ID", () => {
  it("moves its values as the version that renames it is made current, the old version serving until then and writing no more after", async () => {
    const { store, first } = await nicknamedStore([
      { title: "A", nickname: "Ace" },
      { title: "B" },
    ]);

    const second = await define(store, displayNamed, 2, displayNameIds);
    // Sealed, it waits: version 1 still serves, and writes the nickname.
    expect(second.contract.awaits).toBeTruthy();
    await insert(store, first, { title: "C", nickname: "Cy" });
    await expect(byTitle(store)).resolves.toMatchObject({
      A: { title: "A", nickname: "Ace" },
    });

    const state = await activate(store, second.schemaHash, 2);

    expect(state).toBe("active");
    await expect(byTitle(store)).resolves.toStrictEqual({
      A: { title: "A", displayName: "Ace" },
      B: { title: "B" },
      C: { title: "C", displayName: "Cy" },
    });
    // Version 1 writes a nickname no version reads: refused.
    await expect(
      codeOf(insert(store, first, { title: "D", nickname: "Dee" }))
    ).resolves.toBe("migration.incompatible_write");
  });

  it("moves them back with a rollback, and on again with the version that renames them, whatever the version before wrote", async () => {
    const { store, first } = await nicknamedStore([
      { title: "A", nickname: "Ace" },
    ]);
    const second = await define(store, displayNamed, 2, displayNameIds);
    await activate(store, second.schemaHash, 2);
    await insert(store, second.schemaHash, { title: "B", displayName: "Bee" });

    // The rollback: version 1 made current again.
    await expect(activate(store, first, 1)).resolves.toBe("active");
    await expect(byTitle(store)).resolves.toStrictEqual({
      A: { title: "A", nickname: "Ace" },
      B: { title: "B", nickname: "Bee" },
    });
    await expect(
      codeOf(insert(store, second.schemaHash, { title: "X" }))
    ).resolves.toBe("migration.incompatible_write");
    await insert(store, first, { title: "C", nickname: "Cy" });

    await expect(activate(store, second.schemaHash, 2)).resolves.toBe("active");
    await expect(byTitle(store)).resolves.toStrictEqual({
      A: { title: "A", displayName: "Ace" },
      B: { title: "B", displayName: "Bee" },
      C: { title: "C", displayName: "Cy" },
    });
  });

  it("checks the moved values against a new type, gives the answer to the records that lack one, and asks for a migration for a value that doesn't fit", async () => {
    const required = notesWith({ displayName: v.string().max(3) });
    const answer = [{ table: "notes", field: "displayName", value: "n/a" }];
    const { store } = await nicknamedStore([
      { title: "A", nickname: "Ace" },
      { title: "B" },
    ]);

    const second = await define(store, required, 2, displayNameIds, answer);
    await activate(store, second.schemaHash, 2);

    await expect(byTitle(store)).resolves.toStrictEqual({
      A: { title: "A", displayName: "Ace" },
      B: { title: "B", displayName: "n/a" },
    });
    // A nickname longer than the new type takes: the record's own value,
    // which only a migration reshapes, answer or not.
    const { store: long } = await nicknamedStore([
      { title: "A", nickname: "Longer" },
    ]);
    const refused = await requiredOf(
      define(long, required, 2, displayNameIds, answer)
    );
    expect(refused.questions).toMatchObject([
      {
        table: "notes",
        field: "displayName",
        rows: 1,
        records: [{ reason: "invalid" }],
        answers: ["migration"],
      },
    ]);
  });

  it("follows the ID past a name a later version gave another field", async () => {
    const { store, first } = await nicknamedStore([
      { title: "A", nickname: "Ace" },
    ]);
    const second = await define(store, displayNamed, 2, displayNameIds);
    await activate(store, second.schemaHash, 2);
    // Version 3 gives the free name `nickname` to a new field.
    const third = await define(
      store,
      notesWith({
        displayName: v.string().optional(),
        nickname: v.string().optional(),
      }),
      3,
      idsOf({ displayName: "f-nick", nickname: "f-new" })
    );
    await activate(store, third.schemaHash, 3);
    await insert(store, third.schemaHash, {
      title: "B",
      displayName: "Bee",
      nickname: "New",
    });

    // Version 4 renames the first field again: its values follow its ID,
    // never the name it once had.
    const fourth = await define(
      store,
      notesWith({
        alias: v.string().optional(),
        nickname: v.string().optional(),
      }),
      4,
      idsOf({ alias: "f-nick", nickname: "f-new" })
    );
    await activate(store, fourth.schemaHash, 4);

    await expect(byTitle(store)).resolves.toStrictEqual({
      A: { title: "A", alias: "Ace" },
      B: { title: "B", alias: "Bee", nickname: "New" },
    });
    // Back to version 1, whose nickname is another field's now: it no
    // longer fits the store's records.
    await expect(activate(store, first, 1)).resolves.toBe("incompatible");
  });

  it("refuses a name the store holds for another field, a schema applied again with other IDs, and a table renamed", async () => {
    const { store } = await nicknamedStore([{ title: "A", nickname: "Ace" }]);

    // The nickname renamed, and its name given to a new field at once.
    const reused = await requiredOf(
      define(
        store,
        notesWith({
          displayName: v.string().optional(),
          nickname: v.string().optional(),
        }),
        2,
        idsOf({ displayName: "f-nick", nickname: "f-new" })
      )
    );
    const again = await requiredOf(
      define(store, nicknamed, 3, idsOf({ nickname: "f-other" }))
    );
    const tableRenamed = await requiredOf(
      store.defineTables(
        manifestText(
          schemaManifest(
            defineSchema({
              memos: defineTable({ title: v.string() }).access({
                read: "appMembers",
                write: "appMembers",
              }),
            })
          )
        ),
        consumer(4),
        [],
        [],
        { memos: { id: "t1", fields: { title: "f-title" } } }
      )
    );

    expect(reused.changes).toStrictEqual([
      { table: "notes", field: "nickname", reason: "id_changed" },
    ]);
    expect(again.changes).toStrictEqual([{ table: "", reason: "id_changed" }]);
    expect(tableRenamed.changes).toStrictEqual([
      { table: "memos", reason: "table_renamed" },
    ]);
    await expect(byTitle(store)).resolves.toStrictEqual({
      A: { title: "A", nickname: "Ace" },
    });
  });
});
