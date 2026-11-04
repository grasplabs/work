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
// nothing; a rollback is making the release before current again, every
// record checked against it. Through core's way into a store and its
// Durable Object. The cases follow the threat model: no value overwritten
// or guessed, no partial migration (a failure, a crash, a write between
// the dry run and the activation), no rule bypassed by an older version,
// and no hidden row's value in a dry run's answer.

/** Notes with a title and, as `priority` declares it, a priority. */
const prioritised = (priority: ValueShape[string]) =>
  notes({ title: v.string(), priority });

/** A priority of 0 for every note that lacks one. */
const zeroPriority: SchemaAnswer = {
  table: "notes",
  field: "priority",
  value: 0,
};

/** Notes whose detail's tone has a default, or doesn't. */
const detail = (withDefault: boolean) =>
  notes({
    title: v.string(),
    detail: v.object({
      note: v.string().optional(),
      tone: withDefault ? v.string().default("plain") : v.string().optional(),
    }),
  });
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

/** Notes whose `size` is `size`. */
const sizes = (size: ValueShape[string]) => notes({ title: v.string(), size });

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

/** How many changes of records schema changes recorded in the history. */
const historyOf = async (store: OpenStore) =>
  await runInDurableObject(
    objectOf(store),
    (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM sdk_record_changes WHERE source = 'schema_change'"
        )
        .one().n
  );

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
      history: await historyOf(store),
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
      history: 0,
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
  it("fills in only what records lack, and never writes over a value they hold", async () => {
    const { store, ids } = await storeOf(prioritised(v.number().optional()), [
      { title: "A", priority: 5 },
      { title: "B" },
    ]);
    const before = await notesOf(store);
    const second = await store.defineTables(
      prioritised(v.number().min(0)),
      consumer(2),
      [],
      [zeroPriority]
    );
    await activate(store, second.schemaHash, 2);
    const after = await notesOf(store);

    expect({
      kept: after.get(ids[0] ?? ""),
      filled: after.get(ids[1] ?? ""),
      history: await historyOf(store),
    }).toStrictEqual({
      kept: before.get(ids[0] ?? ""),
      filled: {
        fields: { title: "B", priority: 0 },
        revision: (before.get(ids[1] ?? "")?.revision ?? 0) + 1,
      },
      history: 1,
    });
  });

  it("leaves a value a record holds that doesn't fit to a migration", async () => {
    const { store, ids } = await storeOf(prioritised(v.number().optional()), [
      { title: "A", priority: -1 },
      { title: "B" },
    ]);
    const refused = await refusalOf(
      store.defineTables(
        prioritised(v.number().min(0)),
        consumer(2),
        [],
        [zeroPriority]
      )
    );
    expect(refused).toStrictEqual({
      code: "migration.required",
      details: {
        changes: [],
        questions: [
          {
            table: "notes",
            field: "priority",
            rows: 1,
            records: [{ id: ids[0], reason: "invalid" }],
            answers: ["value", "migration"],
          },
        ],
      },
    });
  });

  it("that doesn't fit the field either is reported, and nothing is guessed", async () => {
    const { store, ids } = await storeOf(sizes(v.string().optional()), [
      { title: "A" },
    ]);
    // The value given for what the record lacks isn't a number.
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
      history: await historyOf(store),
      records2: await notesOf(store),
      stillWrites: await codeOf(insert(store, first, { title: "Another" })),
    }).toStrictEqual({
      code: "migration.required",
      records: [{ id: late, reason: "invalid" }],
      contract: true,
      history: 0,
      records2: before,
      stillWrites: "ok",
    });
  });

  it("a crash halfway through leaves the change unapplied, and it applies whole once run again", async () => {
    const { store, ids } = await storeOf(
      prioritised(v.number().optional()),
      Array.from({ length: 1200 }, (_, index) => ({ title: `Note ${index}` }))
    );
    const before = await notesOf(store);
    const contract = await contractHash(store);
    const second = await store.defineTables(
      prioritised(v.number()),
      consumer(2),
      [],
      [zeroPriority]
    );
    // The store fails as it fills in a record past the first pages of the
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
      history: await historyOf(store),
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
      applied: [...after.values()].every(({ fields }) => fields.priority === 0),
      history: await historyOf(restarted),
    }).toStrictEqual({
      crashed: true,
      halfway: { contract: true, history: 0, records: 1200 },
      unchanged: true,
      applied: true,
      history: 1200,
    });
  });
});

describe("a rollback", () => {
  it("makes the version before current again once every record fits it", async () => {
    const { store, first } = await storeOf(
      notes({ title: v.string().max(200) }),
      [{ title: "Short" }]
    );
    const narrowed = await store.defineTables(
      notes({ title: v.string().max(20) }),
      consumer(2)
    );
    await activate(store, narrowed.schemaHash, 2);
    const left = await codeOf(insert(store, first, { title: "Left behind" }));

    const status = await activate(store, first, 1);
    expect({
      left,
      status,
      oldWrites: await codeOf(
        insert(store, first, { title: "A title past twenty characters" })
      ),
      // Its titles are shorter still: version 2 fits the wider contract.
      newWrites: await codeOf(
        insert(store, narrowed.schemaHash, { title: "x" })
      ),
    }).toStrictEqual({
      left: "migration.incompatible_write",
      status: { state: "active" },
      oldWrites: "ok",
      newWrites: "ok",
    });
  });

  it("checks every table it narrows, not only those the change checked, and is refused while a record doesn't fit", async () => {
    // Version 2 widens the title as it is sealed, and adds a required
    // priority, which leaves version 1 behind as it is made current.
    const { store, first } = await storeOf(
      notes({ title: v.string().max(20) }),
      [{ title: "Short" }]
    );
    const second = await store.defineTables(
      notes({ title: v.string().max(200), priority: v.number() }),
      consumer(2),
      [],
      [zeroPriority]
    );
    await activate(store, second.schemaHash, 2);
    const long = await insert(store, second.schemaHash, {
      title: "A title past twenty characters",
      priority: 1,
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
        code: "migration.required",
        details: {
          changes: [],
          questions: [
            {
              table: "notes",
              field: "title",
              rows: 1,
              records: [{ id: long, reason: "invalid" }],
              answers: ["value", "migration"],
            },
          ],
        },
      },
      records: before,
      contract: true,
    });
  });
});

describe("a nested default", () => {
  it("is filled in where records lack it, as it is made current", async () => {
    const { store, ids } = await storeOf(detail(false), [
      { title: "A", detail: {} },
      { title: "B", detail: { tone: "warm" } },
    ]);
    const second = await store.defineTables(detail(true), consumer(2));
    await activate(store, second.schemaHash, 2);
    const after = await notesOf(store);
    expect({
      pending: second.contract.awaits,
      filled: after.get(ids[0] ?? "")?.fields,
      kept: after.get(ids[1] ?? "")?.fields,
    }).toStrictEqual({
      pending: true,
      filled: { title: "A", detail: { tone: "plain" } },
      kept: { title: "B", detail: { tone: "warm" } },
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
