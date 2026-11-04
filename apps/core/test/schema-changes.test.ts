import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import type { ValueShape } from "@grasp-os/sdk";
import { databaseReader } from "@grasp-os/sdk/database";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import type { SchemaAccess, SchemaAnswer } from "@grasp-os/sdk/host";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { StoreFields } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import {
  codeOf,
  commit,
  consumer,
  contractHash,
  insertAll,
  newStore,
  notes,
  notesOf,
  objectOf,
} from "./pending-stores.ts";
import { newRecordId } from "./store-schemas.ts";

// A schema change the store checks every record for before its contract
// takes it (sdk schema-plan.ts `activates`; store-schema-changes.ts):
// planned as the release is sealed, with a dry run over every record, and
// applied as the release is made current (`activateReady`), all or
// nothing, with an undo. Through core's way into a store and its Durable
// Object. The cases follow the threat model: no data lost or guessed, no
// partial migration (a failure, a crash, a write between the dry run and
// the activation), no rule bypassed by an older version, no hidden row's
// value in a dry run's answer, and an undo that never overwrites a later
// edit.

const status = (values: [string, ...string[]], more: ValueShape = {}) =>
  notes({ title: v.string(), status: v.enum(values), ...more });

const todo = status(["todo", "done"]);
const open = status(["open", "done"]);

/** `open` for every note whose status the new enum doesn't take. */
const mapTodo: SchemaAnswer = {
  table: "notes",
  field: "status",
  value: "open",
};

/** The details of the error `call` was refused with. */
const refusalOf = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      return {
        code: error.code,
        details: "details" in error ? error.details : undefined,
      };
    }
    throw error;
  }
  throw new Error("Not refused");
};

/** The questions a refusal's details hold. */
const questionsOf = (refused: { details: unknown }) =>
  z
    .object({
      questions: z.array(
        z.object({ rows: z.number(), records: z.array(z.unknown()) })
      ),
    })
    .parse(refused.details).questions;

/** A sensitive notes table whose status is one of `values`. */
const sensitive = (values: [string, ...string[]]) =>
  manifestText(
    schemaManifest(
      defineSchema({
        notes: defineTable({
          title: v.string(),
          status: v.enum(values),
        }).sensitive(),
      }),
      { tables: { notes: { read: "appMembers", write: "appMembers" } } }
    )
  );
/** An undo refused over the status of `ids`, in that order. */
const blocked = (...ids: (string | undefined)[]) => ({
  code: "migration.undo_blocked",
  details: {
    questions: [
      {
        table: "notes",
        field: "status",
        rows: ids.length,
        records: ids.map((id) => ({ id, reason: "invalid" })),
        answers: ["migration"],
      },
    ],
  },
});

/** Notes whose `size` is `size`. */
const sizes = (
  size: ReturnType<typeof v.string> | ReturnType<typeof v.number>
) => notes({ title: v.string(), size });

/** A store whose notes, under `schema`, hold `rows`. */
const storeOf = async (schema: string, rows: StoreFields[]) => {
  const store = await newStore();
  const first = await store.defineTables(schema, consumer(1));
  const ids = await insertAll(store, first.schemaHash, rows);
  return { store, first: first.schemaHash, ids };
};

/** Makes version `version` of the notes App, on `schemaHash`, current. */
const activate = async (
  store: OpenStore,
  schemaHash: string,
  version: number
) => await store.activate(schemaHash, consumer(version));

/** Inserts one note under `schemaHash`; its ID. */
const insert = async (
  store: OpenStore,
  schemaHash: string,
  fields: StoreFields,
  by = "ada"
): Promise<string> => {
  const id = newRecordId();
  await commit(
    store,
    schemaHash,
    [{ op: "insert", table: "notes", id, fields }],
    by
  );
  return id;
};

/**
 * The store's own record of its schema changes, and how many changes of
 * records they recorded in the change history.
 */
const changeRows = async (store: OpenStore) =>
  await runInDurableObject(objectOf(store), (_instance, state) => ({
    changes: state.storage.sql
      .exec<{ undone: number | null; rewritten: number }>(
        "SELECT undone_at AS undone, rewritten FROM sdk_schema_changes ORDER BY change_id"
      )
      .toArray()
      .map(({ undone, rewritten }) => ({ undone: undone !== null, rewritten })),
    history: state.storage.sql
      .exec<{ n: number }>(
        "SELECT count(*) AS n FROM sdk_record_changes WHERE source = 'schema_change'"
      )
      .one().n,
  }));

describe("a narrowing every record fits", () => {
  it("waits for its release, then applies without rewriting anything", async () => {
    const { store, first, ids } = await storeOf(
      notes({ title: v.string().max(200) }),
      [{ title: "Short" }, { title: "Also short" }]
    );
    const before = await notesOf(store);
    const narrowed = await store.defineTables(
      notes({ title: v.string().max(20) }),
      consumer(2)
    );
    // Sealed, not in force: the version in force writes on, and so may
    // the new one, whose narrower titles fit the contract in force.
    const sealed = {
      pending: narrowed.contract.pending,
      contract: await contractHash(store),
      newWrites: await codeOf(
        insert(store, narrowed.schemaHash, { title: "Early" })
      ),
      oldWrites: await codeOf(insert(store, first, { title: "Still fine" })),
    };
    const contractBefore = sealed.contract;
    await activate(store, narrowed.schemaHash, 2);
    // Made current again (a retry after a lost answer): nothing more.
    await activate(store, narrowed.schemaHash, 2);
    const after = await notesOf(store);

    expect({
      sealed: { ...sealed, contract: sealed.contract === contractBefore },
      moved: (await contractHash(store)) !== contractBefore,
      untouched: ids.every(
        (id) => after.get(id)?.revision === before.get(id)?.revision
      ),
      newWrites: await codeOf(
        insert(store, narrowed.schemaHash, { title: "Now" })
      ),
      // Version 1 could write a title the narrowed field doesn't take.
      oldWrites: await codeOf(insert(store, first, { title: "Too late" })),
      changes: await changeRows(store),
    }).toStrictEqual({
      sealed: {
        pending: true,
        contract: true,
        newWrites: "ok",
        oldWrites: "ok",
      },
      moved: true,
      untouched: true,
      newWrites: "ok",
      oldWrites: "migration.incompatible_write",
      changes: { changes: [{ undone: false, rewritten: 0 }], history: 0 },
    });
  });
});

describe("a dry run", () => {
  it("refuses the seal with a question naming the records that don't fit, never their values", async () => {
    const secret = "Salary review for Grace: 120000";
    const { store, ids } = await storeOf(notes({ title: v.string() }), [
      { title: secret },
      { title: "ok" },
    ]);
    const before = await notesOf(store);
    const refused = await refusalOf(
      store.defineTables(notes({ title: v.string().max(10) }), consumer(2))
    );

    expect(refused).toStrictEqual({
      code: "migration.required",
      details: {
        changes: [],
        questions: [
          {
            table: "notes",
            field: "title",
            rows: 1,
            records: [{ id: ids[0], reason: "invalid" }],
            answers: ["value", "migration"],
          },
        ],
      },
    });
    expect(JSON.stringify(refused)).not.toContain("Grace");
    await expect(notesOf(store)).resolves.toStrictEqual(before);
  });

  it("tells nothing an owner's record holds to a builder who can't read it", async () => {
    const ownerOnly: SchemaAccess = {
      tables: { notes: { read: "owner", write: "owner" } },
    };
    const owned = (fields: ValueShape) =>
      manifestText(
        schemaManifest(defineSchema({ notes: defineTable(fields) }), ownerOnly)
      );
    const store = await newStore();
    const first = await store.defineTables(
      owned({ title: v.string() }),
      consumer(1)
    );
    const hidden = await insert(
      store,
      first.schemaHash,
      { title: "grace@example.com private" },
      "grace"
    );
    const refused = await refusalOf(
      store.defineTables(owned({ title: v.string().email() }), consumer(2))
    );
    expect(refused).toMatchObject({
      code: "migration.required",
      details: {
        questions: [
          {
            field: "title",
            rows: 1,
            records: [{ id: hidden, reason: "invalid" }],
          },
        ],
      },
    });
    expect(JSON.stringify(refused)).not.toMatch(/grace@|private/u);
  });

  it("counts every record that doesn't fit, and lists the first twenty", async () => {
    const { store } = await storeOf(
      notes({ title: v.string() }),
      Array.from({ length: 30 }, (_, index) => ({ title: `Note ${index}` }))
    );
    const refused = await refusalOf(
      store.defineTables(
        notes({ title: v.string(), size: v.number() }),
        consumer(2)
      )
    );
    expect(refused).toMatchObject({
      code: "migration.required",
      details: { questions: [{ field: "size", rows: 30 }] },
    });
    expect(questionsOf(refused)[0]?.records).toHaveLength(20);
  });
});

describe("an answer", () => {
  it("rewrites only the records that don't fit, keeping what they held for an undo", async () => {
    const { store, ids } = await storeOf(todo, [
      { title: "A", status: "todo" },
      { title: "B", status: "done" },
    ]);
    const before = await notesOf(store);
    const second = await store.defineTables(open, consumer(2), [], [mapTodo]);
    await activate(store, second.schemaHash, 2);
    const after = await notesOf(store);

    expect({
      rewritten: after.get(ids[0] ?? ""),
      kept:
        after.get(ids[1] ?? "")?.revision ===
        before.get(ids[1] ?? "")?.revision,
      changes: await changeRows(store),
    }).toStrictEqual({
      rewritten: {
        fields: { title: "A", status: "open" },
        revision: (before.get(ids[0] ?? "")?.revision ?? 0) + 1,
      },
      kept: true,
      changes: { changes: [{ undone: false, rewritten: 1 }], history: 1 },
    });
  });

  it("that doesn't fit the field either is reported, and nothing is guessed", async () => {
    const { store, ids } = await storeOf(sizes(v.string()), [
      { title: "A", size: "12" },
    ]);
    // "12" isn't a number; the value given for it isn't one either.
    const refused = await refusalOf(
      store.defineTables(
        sizes(v.number()),
        consumer(2),
        [],
        [{ table: "notes", field: "size", value: "twelve" }]
      )
    );
    expect(refused).toStrictEqual({
      code: "migration.required",
      details: {
        changes: [],
        questions: [
          {
            table: "notes",
            field: "size",
            rows: 1,
            records: [{ id: ids[0], reason: "unfit" }],
            answers: ["value", "migration"],
          },
        ],
      },
    });
  });
});

describe("all or nothing", () => {
  it("a record the version in force wrote since the dry run blocks the activation, writing nothing", async () => {
    const { store, first } = await storeOf(notes({ title: v.string() }), [
      { title: "Short" },
    ]);
    // Passed the dry run: every title fits.
    const second = await store.defineTables(
      notes({ title: v.string().max(10) }),
      consumer(2)
    );
    // Then version 1, still current, writes one that doesn't.
    const late = await insert(store, first, { title: "Far too long a title" });
    const before = await notesOf(store);
    const contract = await contractHash(store);

    const refused = await refusalOf(activate(store, second.schemaHash, 2));
    expect({
      code: refused.code,
      records: questionsOf(refused)[0]?.records,
      contract: (await contractHash(store)) === contract,
      changes: await changeRows(store),
      records2: await notesOf(store),
      stillWrites: await codeOf(insert(store, first, { title: "Another" })),
    }).toStrictEqual({
      code: "migration.required",
      records: [{ id: late, reason: "invalid" }],
      contract: true,
      changes: { changes: [], history: 0 },
      records2: before,
      stillWrites: "ok",
    });
  });

  it("a crash halfway through leaves the change unapplied, and it applies whole once run again", async () => {
    const { store, ids } = await storeOf(
      todo,
      Array.from({ length: 1200 }, (_, index) => ({
        title: `Note ${index}`,
        status: "todo",
      }))
    );
    const before = await notesOf(store);
    const contract = await contractHash(store);
    const second = await store.defineTables(open, consumer(2), [], [mapTodo]);
    // The store fails as it rewrites a record past the first pages of the
    // scan, as a crash or a lost isolate would stop it there.
    const last = ids.toSorted().at(-1) ?? "";
    await runInDurableObject(objectOf(store), (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER crash BEFORE UPDATE OF value_json ON sdk_records WHEN old.record_id = '${last}' BEGIN SELECT RAISE(ABORT, 'crash'); END`
      );
    });
    const crashed = await codeOf(activate(store, second.schemaHash, 2));
    const halfway = {
      contract: (await contractHash(store)) === contract,
      changes: await changeRows(store),
      records: await notesOf(store),
    };
    await runInDurableObject(objectOf(store), (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER crash");
    });
    // The store's object starts again, as after a restart, and the
    // release is made current again.
    await runInDurableObject(objectOf(store), (_instance, state) => {
      state.abort();
    }).catch(() => {});
    const restarted = await openStore(env, store.id);
    await activate(restarted, second.schemaHash, 2);
    const after = await notesOf(restarted);

    expect({
      crashed: crashed !== "ok",
      halfway: { ...halfway, records: halfway.records.size },
      unchanged: [...before].every(
        ([id, note]) => halfway.records.get(id)?.revision === note.revision
      ),
      applied: [...after.values()].every(
        ({ fields }) => fields.status === "open"
      ),
      changes: await changeRows(restarted),
    }).toStrictEqual({
      crashed: true,
      halfway: {
        contract: true,
        changes: { changes: [], history: 0 },
        records: 1200,
      },
      unchanged: true,
      applied: true,
      changes: { changes: [{ undone: false, rewritten: 1200 }], history: 1200 },
    });
  });
});

describe("an undo", () => {
  it("making the version before current puts back what records held, and the change waits again", async () => {
    const { store, first, ids } = await storeOf(todo, [
      { title: "A", status: "todo" },
      { title: "B", status: "todo" },
      { title: "C", status: "done" },
    ]);
    const original = await notesOf(store);
    const contract = await contractHash(store);
    const second = await store.defineTables(open, consumer(2), [], [mapTodo]);
    await activate(store, second.schemaHash, 2);
    // Version 2 edits one rewritten record, and adds one, both fitting
    // version 1 too.
    await commit(store, second.schemaHash, [
      {
        op: "patch",
        table: "notes",
        id: ids[1] ?? "",
        expectedRevision: 2,
        fields: { status: "done" },
      },
    ]);
    const added = await insert(store, second.schemaHash, {
      title: "D",
      status: "done",
    });

    await activate(store, first, 1);
    const after = await notesOf(store);

    expect({
      restored: after.get(ids[0] ?? "")?.fields,
      revision:
        (after.get(ids[0] ?? "")?.revision ?? 0) >
        (original.get(ids[0] ?? "")?.revision ?? 0),
      edited: after.get(ids[1] ?? "")?.fields,
      added: after.get(added)?.fields,
      contract: (await contractHash(store)) === contract,
      changes: await changeRows(store),
      oldWrites: await codeOf(
        insert(store, first, { title: "E", status: "todo" })
      ),
      newWrites: await codeOf(
        insert(store, second.schemaHash, { title: "F", status: "open" })
      ),
    }).toStrictEqual({
      restored: { title: "A", status: "todo" },
      revision: true,
      // Edited since: kept as edited, and it fits version 1.
      edited: { title: "B", status: "done" },
      added: { title: "D", status: "done" },
      contract: true,
      // The change's two rows go with it; the undo's own one is held.
      changes: { changes: [{ undone: true, rewritten: 2 }], history: 1 },
      oldWrites: "ok",
      newWrites: "migration.not_current",
    });
    // And made current again, it applies once more.
    await activate(store, second.schemaHash, 2);
    const again = await notesOf(store);
    expect(again.get(ids[0] ?? "")?.fields).toStrictEqual({
      title: "A",
      status: "open",
    });
  });

  it("puts back nothing a person wrote once they are erased, owner or not, and checks those records as they are", async () => {
    // Ada's two notes; Grace, a member too, edits the second.
    const undoAfterErasing = async (person: string) => {
      const { store, first, ids } = await storeOf(todo, [
        { title: "A", status: "todo" },
        { title: "B", status: "done" },
      ]);
      await commit(
        store,
        first,
        [
          {
            op: "patch",
            table: "notes",
            id: ids[1] ?? "",
            expectedRevision: 1,
            fields: { status: "todo" },
          },
        ],
        "grace"
      );
      const second = await store.defineTables(open, consumer(2), [], [mapTodo]);
      await activate(store, second.schemaHash, 2);
      await objectOf(store).forgetPerson(store.id, person);
      const refused = await refusalOf(activate(store, first, 1));
      return { ids, refused };
    };
    // Grace wrote what Ada's second note held, but doesn't own it.
    const grace = await undoAfterErasing("grace");
    // Ada owns both: the change's own history of them is hers, and so is
    // what her first note held.
    const ada = await undoAfterErasing("ada");

    expect({ grace: grace.refused, ada: ada.refused }).toStrictEqual({
      grace: blocked(grace.ids[1]),
      ada: blocked(...ada.ids.toSorted()),
    });
  });

  it("of a sensitive table checks its records as they are: its history keeps no values", async () => {
    const { store, first, ids } = await storeOf(sensitive(["todo", "done"]), [
      { title: "A", status: "todo" },
      { title: "B", status: "done" },
    ]);
    const second = await store.defineTables(
      sensitive(["open", "done"]),
      consumer(2),
      [],
      [mapTodo]
    );
    await activate(store, second.schemaHash, 2);
    const kept = await runInDurableObject(objectOf(store), (_instance, state) =>
      state.storage.sql
        .exec<{ fields: string; before: string | null; leftOut: string }>(
          "SELECT fields, before_json AS before, values_left_out AS leftOut FROM sdk_record_changes WHERE source = 'schema_change'"
        )
        .toArray()
    );

    expect({
      kept,
      refused: await refusalOf(activate(store, first, 1)),
    }).toStrictEqual({
      kept: [{ fields: '["status"]', before: null, leftOut: "sensitive" }],
      refused: {
        code: "migration.undo_blocked",
        details: {
          questions: [
            {
              table: "notes",
              field: "status",
              rows: 1,
              records: [{ id: ids[0], reason: "invalid" }],
              answers: ["migration"],
            },
          ],
        },
      },
    });
  });

  it("never overwrites what a fill or a transform wrote since, which keeps no history", async () => {
    const { store, first, ids } = await storeOf(todo, [
      { title: "A", status: "todo" },
      { title: "B", status: "todo" },
    ]);
    const second = await store.defineTables(open, consumer(2), [], [mapTodo]);
    await activate(store, second.schemaHash, 2);
    // As a pending target's fill or transform writes a record: in place,
    // its revision moved on, and nothing in the change history.
    await runInDurableObject(objectOf(store), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sdk_records SET value_json = ?, revision = revision + 1 WHERE record_id = ?",
        JSON.stringify({ status: "done", title: "A" }),
        ids[0] ?? ""
      );
    });

    await activate(store, first, 1);
    const after = await notesOf(store);
    expect({
      transformed: after.get(ids[0] ?? "")?.fields,
      restored: after.get(ids[1] ?? "")?.fields,
    }).toStrictEqual({
      // Checked as it is, and it fits version 1: kept.
      transformed: { status: "done", title: "A" },
      restored: { title: "B", status: "todo" },
    });
  });

  it("holds its history outside the store's bounds while it can be undone, and lets it go once the contract moves on", async () => {
    const { store, first } = await storeOf(
      todo,
      Array.from({ length: 50 }, (_, index) => ({
        title: `Note ${index}`,
        status: "todo",
      }))
    );
    const counts = async () =>
      await runInDurableObject(objectOf(store), (_instance, state) =>
        state.storage.sql
          .exec<{ bytes: number; held: number; rows: number }>(
            "SELECT history_bytes AS bytes, history_held AS held, (SELECT count(*) FROM sdk_record_changes WHERE source = 'schema_change') AS rows FROM sdk_store"
          )
          .one()
      );
    const before = await counts();
    const second = await store.defineTables(open, consumer(2), [], [mapTodo]);
    await activate(store, second.schemaHash, 2);
    const held = await counts();
    // A later version adds an optional field: the contract moves on.
    await store.defineTables(
      status(["open", "done"], { due: v.string().optional() }),
      consumer(3)
    );
    const released = await counts();

    expect({
      held: { ...held, bytes: held.bytes === before.bytes },
      released: { ...released, bytes: released.bytes === before.bytes },
      undo: await activate(store, first, 1),
    }).toStrictEqual({
      held: { bytes: true, held: 50, rows: 50 },
      released: { bytes: true, held: 0, rows: 0 },
      // No undo reaches it any more.
      undo: { state: "incompatible" },
    });
  });

  it("is refused, writing nothing, while a record written since doesn't fit the version before", async () => {
    const { store, first } = await storeOf(todo, [
      { title: "A", status: "todo" },
    ]);
    const second = await store.defineTables(open, consumer(2), [], [mapTodo]);
    await activate(store, second.schemaHash, 2);
    const later = await insert(store, second.schemaHash, {
      title: "B",
      status: "open",
    });
    const before = await notesOf(store);
    const contract = await contractHash(store);

    const refused = await refusalOf(activate(store, first, 1));
    expect({
      refused,
      records: await notesOf(store),
      contract: (await contractHash(store)) === contract,
    }).toStrictEqual({
      refused: {
        code: "migration.undo_blocked",
        details: {
          questions: [
            {
              table: "notes",
              field: "status",
              rows: 1,
              records: [{ id: later, reason: "invalid" }],
              answers: ["migration"],
            },
          ],
        },
      },
      records: before,
      contract: true,
    });
  });
});

describe("a changed access mode", () => {
  const fields = { title: v.string() };
  const schema = defineSchema({ notes: defineTable(fields) });
  const withAccess = (read: "owner" | "appMembers") =>
    manifestText(
      schemaManifest(schema, {
        tables: { notes: { read, write: read } },
      })
    );
  const titles = async (
    store: OpenStore,
    schemaHash: string,
    principal: string
  ) => {
    const scope: ReadScope = {
      schemaHash,
      principal,
      appMember: true,
      appBuilder: false,
      consumer: consumer(1),
    };
    const db = databaseReader(schema, async (request) => {
      const { value } = await store.read(scope, request);
      return value;
    });
    const read = await db.query("notes").collect();
    return read.map(({ title }) => title).toSorted();
  };

  it("holds for every version pinned to the store once its release is current", async () => {
    const store = await newStore();
    const shared = await store.defineTables(
      withAccess("appMembers"),
      consumer(1)
    );
    await insert(store, shared.schemaHash, { title: "Ada's" }, "ada");
    await insert(store, shared.schemaHash, { title: "Grace's" }, "grace");
    const owned = await store.defineTables(withAccess("owner"), consumer(2));
    const sealed = await titles(store, shared.schemaHash, "ada");
    await activate(store, owned.schemaHash, 2);

    expect({
      sealed,
      // Version 1 declared the table shared; it reads under the
      // contract's mode now, as version 2 does.
      oldVersion: await titles(store, shared.schemaHash, "ada"),
      newVersion: await titles(store, owned.schemaHash, "ada"),
      // The data is the same: version 1 still writes.
      oldWrites: await codeOf(insert(store, shared.schemaHash, { title: "x" })),
    }).toStrictEqual({
      sealed: ["Ada's", "Grace's"],
      oldVersion: ["Ada's"],
      newVersion: ["Ada's"],
      oldWrites: "ok",
    });
  });
});
