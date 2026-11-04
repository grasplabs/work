import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import type { SchemaDefinition, ValueShape } from "@grasp-os/sdk";
import { databaseReader } from "@grasp-os/sdk/database";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import type { SchemaAccess, SchemaAnswer } from "@grasp-os/sdk/host";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { StoreFields } from "@grasp-os/shared/stores";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { commitFiles, setCurrentVersion } from "../src/apps.ts";
import { openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { racingDb } from "./apps.ts";
import { v1Schema } from "./migrated-apps.ts";
import {
  codeOf,
  commit,
  consumer,
  contractHash,
  fillAll,
  insertAll,
  newStore,
  notes,
  notesOf,
  objectOf,
} from "./pending-stores.ts";
import { appWith, failure, seal } from "./sealed-apps.ts";
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
// by a backfill pending meanwhile, or by a version D1 never made current
// (rules follow D1's commit, by the store's alarm if core stops after
// it), no live query left showing rows a rule now hides, and no hidden
// row's value in a dry run's answer.

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

/** Notes and tags whose title and name are at most `max` long. */
const tagged = (max: number, extra: ValueShape = {}) =>
  manifestText(
    schemaManifest(
      defineSchema({
        notes: defineTable({ title: v.string().max(max), ...extra }),
        tags: defineTable({ name: v.string().max(max) }),
      }),
      {
        tables: {
          notes: { read: "appMembers", write: "appMembers" },
          tags: { read: "appMembers", write: "appMembers" },
        },
      }
    )
  );

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
            answers: ["migration"],
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

  it("counts every record that doesn't fit, lists the first twenty, and takes a value for those that lack the field", async () => {
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
      details: {
        questions: [
          { field: "size", rows: 30, answers: ["value", "migration"] },
        ],
      },
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
            answers: ["migration"],
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
    // Version 2 widens the title and the tags' name as it is sealed, drops
    // the required size (kept, optional), and adds a required priority to
    // notes alone, which leaves version 1 behind as it is made current:
    // the tags table the change never checked is narrowed back by the
    // rollback all the same.
    const { store, first } = await storeOf(tagged(20, { size: v.number() }), [
      { title: "Short", size: 1 },
    ]);
    const second = await store.defineTables(
      tagged(200, { priority: v.number() }),
      consumer(2),
      [],
      [zeroPriority]
    );
    await activate(store, second.schemaHash, 2);
    const long = await insert(store, second.schemaHash, {
      title: "A title past twenty characters",
      priority: 1,
    });
    const tag = newRecordId();
    await commit(store, second.schemaHash, [
      {
        op: "insert",
        table: "tags",
        id: tag,
        fields: { name: "A name past twenty characters" },
      },
    ]);
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
          // A rollback's answers are the old release's, sealed with it: a
          // migration answers each, even a record that lacks the field.
          questions: [
            {
              table: "notes",
              field: "size",
              rows: 1,
              records: [{ id: long, reason: "missing" }],
              answers: ["migration"],
            },
            {
              table: "notes",
              field: "title",
              rows: 1,
              records: [{ id: long, reason: "invalid" }],
              answers: ["migration"],
            },
            {
              table: "tags",
              field: "name",
              rows: 1,
              records: [{ id: tag, reason: "invalid" }],
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

const fields = { title: v.string() };
const titleOnly = defineSchema({ notes: defineTable(fields) });

/** Who reads and writes the notes. */
type NotesAccess = "owner" | "appMembers";

/** `of`'s notes, read and written as `read` says. */
const withAccess = (read: NotesAccess, of: SchemaDefinition = titleOnly) =>
  manifestText(
    schemaManifest(of, {
      tables: { notes: { read, write: read } },
    })
  );

/** How `principal`, a member of the App, reads under `schemaHash`. */
const scopeOf = (schemaHash: string, principal: string): ReadScope => ({
  schemaHash,
  principal,
  appMember: true,
  appBuilder: false,
  consumer: consumer(1),
});

/** The note titles `principal` reads under `schemaHash`. */
const titles = async (
  store: OpenStore,
  schemaHash: string,
  principal: string
) => {
  const db = databaseReader(titleOnly, async (request) => {
    const { value } = await store.read(scopeOf(schemaHash, principal), request);
    return value;
  });
  const read = await db.query("notes").collect();
  return read.map(({ title }) => title).toSorted();
};

/** A store whose notes, shared as `read` says, hold Ada's and Grace's. */
const twoOwners = async (
  read: NotesAccess,
  of: SchemaDefinition = titleOnly
) => {
  const store = await newStore();
  const first = await store.defineTables(withAccess(read, of), consumer(1));
  await insert(store, first.schemaHash, { title: "Ada's" }, "ada");
  await insert(store, first.schemaHash, { title: "Grace's" }, "grace");
  return { store, first: first.schemaHash };
};

/** The generation of the store's notes table. */
const notesGeneration = async (store: OpenStore): Promise<number> => {
  const { notes: generation } = await store.generations(["notes"]);
  return generation ?? 0;
};

describe("a changed access mode", () => {
  it("holds for every version pinned to the store once its release is current", async () => {
    const { store, first: shared } = await twoOwners("appMembers");
    const owned = await store.defineTables(withAccess("owner"), consumer(2));
    const sealed = await titles(store, shared, "ada");
    const before = await notesGeneration(store);
    await activate(store, owned.schemaHash, 2);

    expect({
      sealed,
      // Version 1 declared the table shared; it reads under the
      // contract's mode now, as version 2 does.
      oldVersion: await titles(store, shared, "ada"),
      newVersion: await titles(store, owned.schemaHash, "ada"),
      // No record was written, yet the table moved on: a live query of it
      // reads again, under the new mode, and drops Grace's note.
      moved: (await notesGeneration(store)) > before,
      // The data is the same: version 1 still writes.
      oldWrites: await codeOf(insert(store, shared, { title: "x" })),
    }).toStrictEqual({
      sealed: ["Ada's", "Grace's"],
      oldVersion: ["Ada's"],
      newVersion: ["Ada's"],
      moved: true,
      oldWrites: "ok",
    });
  });

  it("waits for a backfill pending as it is sealed, and holds once made current after it", async () => {
    const { store, first: shared } = await twoOwners("appMembers");
    // Version 2 adds a defaulted category the notes lack: the store's
    // pending target while its backfill runs.
    const filled = await store.defineTables(
      withAccess(
        "appMembers",
        defineSchema({
          notes: defineTable({
            ...fields,
            category: v.string().default("general"),
          }),
        })
      ),
      consumer(2)
    );
    // Version 3 makes the notes their owner's meanwhile: a change its
    // fields don't show, which the contract in force covers.
    const owned = await store.defineTables(withAccess("owner"), consumer(3));
    const { state } = await activate(store, owned.schemaHash, 3);
    const meanwhile = {
      awaits: owned.contract.awaits,
      status: state,
      read: await titles(store, shared, "ada"),
    };
    await fillAll(store, filled.contract.hash);
    const status = await activate(store, owned.schemaHash, 3);

    expect({
      meanwhile,
      status,
      oldVersion: await titles(store, shared, "ada"),
    }).toStrictEqual({
      // It waits to be made current, and can't be until the backfill is
      // done: never answered as in force while the old rules are.
      meanwhile: {
        awaits: true,
        status: "pending",
        read: ["Ada's", "Grace's"],
      },
      status: { state: "active" },
      oldVersion: ["Ada's"],
    });
  });

  it("loosened, lets an older version's search read past the owner its index was built for", async () => {
    const searchable = defineSchema({
      notes: defineTable(fields).searchIndex(["title"]),
    });
    const { store, first: owned } = await twoOwners("owner", searchable);
    const shared = await store.defineTables(
      withAccess("appMembers", searchable),
      consumer(2)
    );
    const found = async (schemaHash: string): Promise<unknown> => {
      const { value } = await store.read(scopeOf(schemaHash, "ada"), {
        kind: "query",
        query: {
          descriptorVersion: 1,
          table: "notes",
          index: null,
          range: [],
          filter: null,
          order: "asc",
          terminal: { kind: "collect" },
          search: "Grace",
        },
      });
      return z
        .array(z.object({ title: z.string() }))
        .parse(value)
        .map(({ title }) => title);
    };
    const sealed = await found(owned);
    await activate(store, shared.schemaHash, 2);

    expect({
      sealed,
      // Version 1's search index was built owner by owner; its owner
      // condition is the contract's now, which shares the notes.
      oldVersion: await found(owned),
      newVersion: await found(shared.schemaHash),
    }).toStrictEqual({
      sealed: [],
      oldVersion: ["Grace's"],
      newVersion: ["Grace's"],
    });
  });
});

/** The Notes App's schema with titles of at most 100. */
const shortTitles = `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(100) }),
});
`;

/** The Notes App's schema with a category that defaults to general. */
const categorised = `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({
    title: v.string().min(1).max(200),
    category: v.string().default("general"),
  }),
});
`;

/** The Notes App's registration, its notes shared as `read` says. */
const notesApp = (read: NotesAccess) => `import { app } from "@grasp-os/sdk";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "${read}", write: "${read}" } } },
  operations: {},
  screens: [],
  migrations: [],
});
`;

/**
 * The Notes App made current at version 1 with its notes the owner's,
 * Ada's and Grace's notes in its store, and version 2 sealed sharing them
 * with every member.
 */
const sharedNext = async () => {
  const fixture = await appWith({
    "schema.ts": v1Schema,
    "app.ts": notesApp("owner"),
  });
  const first = await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  const store = await openStore(env, fixture.store);
  const owned = first.manifest.schemaHash;
  await insert(store, owned, { title: "Ada's" }, "ada");
  await insert(store, owned, { title: "Grace's" }, "grace");
  await commitFiles(
    env,
    fixture.owner,
    fixture.app,
    { "app.ts": notesApp("appMembers") },
    "Shared notes"
  );
  const second = await seal(fixture, 2);
  return {
    fixture,
    store,
    owned,
    shared: second.manifest.schemaHash,
  };
};

/** The version of App `app` that D1 has current. */
const currentOf = async (app: string) => {
  const row = await env.DB.prepare(
    "SELECT current_version AS version FROM apps WHERE id = ?"
  )
    .bind(app)
    .first<{ version: number }>();
  return row?.version;
};

/**
 * D1 as core sees it when it stops right after the batch that `writes`
 * matches went through (a crash, a lost isolate): every call after it
 * fails.
 */
const stoppingAfter = (writes: RegExp): D1Database => {
  const real = env.DB;
  let writing = false;
  let stopped = false;
  const going = () => {
    if (stopped) {
      throw new Error("Core stopped");
    }
  };
  return {
    prepare: (query) => {
      going();
      writing ||= writes.test(query);
      return real.prepare(query);
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      going();
      const done = await real.batch<T>(statements);
      stopped = writing;
      return done;
    },
    exec: async (query) => {
      going();
      return await real.exec(query);
    },
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

/** Core's read of the version an App has current (store-backfill.ts). */
const currentRead = /^select "current_version" from "apps"/iu;

/**
 * D1 whose first read matching `reads` answers, then waits for
 * `meanwhile`; every later one fails, as a database gone away would.
 */
const readingThen = (
  reads: RegExp,
  meanwhile: () => Promise<void>
): D1Database => {
  const real = env.DB;
  let seen = 0;
  const executions = new Set(["all", "raw", "first", "run"]);
  const watched = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, key) => {
        const member: unknown = Reflect.get(target, key);
        if (key === "bind") {
          return (...values: unknown[]) => watched(target.bind(...values));
        }
        if (typeof member !== "function") {
          return member;
        }
        if (typeof key !== "string" || !executions.has(key)) {
          const bound: unknown = member.bind(target);
          return bound;
        }
        return async (...args: unknown[]) => {
          seen += 1;
          if (seen > 1) {
            throw new Error("D1 is unreachable");
          }
          const answered: unknown = await member.apply(target, args);
          await meanwhile();
          return answered;
        };
      },
    });
  return {
    prepare: (query) => {
      const statement = real.prepare(query);
      return reads.test(query) ? watched(statement) : statement;
    },
    batch: async <T>(statements: D1PreparedStatement[]) =>
      await real.batch<T>(statements),
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

/** The batch that makes a version current. */
const makingCurrent = /update "apps" set "current_version"/iu;

describe("making the release current", { timeout: 180_000 }, () => {
  it("never loosens a rule while D1 serves the version before, nor after its compare-and-set missed", async () => {
    const { fixture, store, owned, shared } = await sharedNext();
    // The App is archived just before the batch that would make version 2
    // current, after its store took what version 2 checks records for:
    // the batch matches nothing, and version 1 stays current.
    let beforeBatch: string[] = [];
    const racing = racingDb(async () => {
      beforeBatch = await titles(store, owned, "grace");
      await env.DB.prepare("UPDATE apps SET status = 'archived' WHERE id = ?")
        .bind(fixture.app)
        .run();
    }, makingCurrent);
    const refused = await failure(
      async () =>
        await setCurrentVersion(
          { ...env, DB: racing },
          fixture.owner,
          fixture.app,
          2
        )
    );

    expect({
      refused: refused === "ok",
      current: await currentOf(fixture.app),
      beforeBatch,
      // Neither version reads past the owner: version 2's shared notes
      // were never in force, D1 never having made it current.
      first: await titles(store, owned, "grace"),
      second: await titles(store, shared, "grace"),
      stillWrites: await codeOf(insert(store, owned, { title: "x" }, "grace")),
    }).toStrictEqual({
      refused: false,
      current: 1,
      beforeBatch: ["Grace's"],
      first: ["Grace's"],
      second: ["Grace's"],
      stillWrites: "ok",
    });
  });

  it("applies the rules of the version made current once D1 committed it, by the store's alarm when core stopped right after", async () => {
    const { fixture, store, owned, shared } = await sharedNext();
    const stopping = stoppingAfter(makingCurrent);
    await setCurrentVersion(
      { ...env, DB: stopping },
      fixture.owner,
      fixture.app,
      2
    ).catch(() => {});
    const stopped = {
      current: await currentOf(fixture.app),
      read: await titles(store, shared, "grace"),
    };
    // The store's alarm, once core is past due with them.
    const object = objectOf(store);
    await runInDurableObject(object, (_instance, state) => {
      state.storage.sql.exec("UPDATE sdk_rules_owed SET due_at = 0");
    });
    await runDurableObjectAlarm(object);

    expect({
      stopped,
      first: await titles(store, owned, "grace"),
      second: await titles(store, shared, "grace"),
      // Settled: the alarm has nothing left to apply.
      owed: await runInDurableObject(
        object,
        (_instance, state) =>
          state.storage.sql
            .exec<{ n: number }>("SELECT count(*) AS n FROM sdk_rules_owed")
            .one().n
      ),
    }).toStrictEqual({
      // Committed, its rules not yet applied: still the owner's notes.
      stopped: { current: 2, read: ["Grace's"] },
      first: ["Ada's", "Grace's"],
      second: ["Ada's", "Grace's"],
      owed: 0,
    });
  });

  it("refuses another version's activation while one is in flight, so the loser never leaves the winner behind", async () => {
    const { fixture, store, shared } = await sharedNext();
    // Version 3 narrows the titles to 100: once applied, version 2's longer
    // titles no longer fit, and version 2 is left behind.
    await commitFiles(
      env,
      fixture.owner,
      fixture.app,
      { "schema.ts": shortTitles },
      "Shorter titles"
    );
    await seal(fixture, 3);
    // Version 3 is made current while version 2's activation is in
    // flight: its store step done, its batch not yet sent.
    let loser = "";
    const racing = racingDb(async () => {
      loser = await failure(
        async () => await setCurrentVersion(env, fixture.owner, fixture.app, 3)
      );
    }, makingCurrent);
    await setCurrentVersion(
      { ...env, DB: racing },
      fixture.owner,
      fixture.app,
      2
    );
    const winner = {
      current: await currentOf(fixture.app),
      writes: await codeOf(
        insert(store, shared, { title: "x".repeat(150) }, "ada")
      ),
    };
    // Asked again after the winner's commit: it goes through. The long
    // title goes first, as version 3 never takes it.
    const long = [...(await notesOf(store))].find(
      ([, note]) =>
        typeof note.fields.title === "string" && note.fields.title.length > 100
    );
    await commit(
      store,
      shared,
      [
        {
          op: "delete",
          table: "notes",
          id: long?.[0] ?? "",
          expectedRevision: long?.[1].revision ?? 1,
        },
      ],
      "ada"
    );
    const retried = await failure(
      async () => await setCurrentVersion(env, fixture.owner, fixture.app, 3)
    );

    expect({
      loser,
      winner,
      retried,
      current: await currentOf(fixture.app),
    }).toStrictEqual({
      loser: "migration.busy",
      winner: { current: 2, writes: "ok" },
      retried: "ok",
      current: 3,
    });
  });

  it("holds other activations back no longer than the alarm takes, once one stopped before its commit", async () => {
    const { fixture, store, shared } = await sharedNext();
    await commitFiles(
      env,
      fixture.owner,
      fixture.app,
      { "schema.ts": shortTitles },
      "Shorter titles"
    );
    await seal(fixture, 3);
    // Version 2's make-current stopped after its store step, before its
    // batch: D1 never made it current.
    const object = objectOf(store);
    await object.activateReady(
      fixture.store,
      shared,
      { resourceId: fixture.app, resourceVersion: 2 },
      { id: crypto.randomUUID(), kind: "app" }
    );
    const held = await failure(
      async () => await setCurrentVersion(env, fixture.owner, fixture.app, 3)
    );
    // The store's alarm, once it is due: version 1 is current, not 2.
    await runInDurableObject(object, (_instance, state) => {
      state.storage.sql.exec("UPDATE sdk_rules_owed SET due_at = 0");
    });
    await runDurableObjectAlarm(object);
    const released = await failure(
      async () => await setCurrentVersion(env, fixture.owner, fixture.app, 3)
    );

    expect({
      held,
      released,
      current: await currentOf(fixture.app),
    }).toStrictEqual({ held: "migration.busy", released: "ok", current: 3 });
  });

  it("holds no other activation back once one is refused with its questions", async () => {
    const { fixture, store, owned } = await sharedNext();
    await commitFiles(
      env,
      fixture.owner,
      fixture.app,
      { "schema.ts": shortTitles },
      "Shorter titles"
    );
    await seal(fixture, 3);
    // Version 1, still current, writes a title version 3 doesn't take
    // after its dry run: making version 3 current is refused.
    await insert(store, owned, { title: "x".repeat(150) }, "ada");
    const refused = await failure(
      async () => await setCurrentVersion(env, fixture.owner, fixture.app, 3)
    );
    // Another version, made current at once.
    const other = await failure(
      async () => await setCurrentVersion(env, fixture.owner, fixture.app, 2)
    );

    expect({
      refused,
      other,
      current: await currentOf(fixture.app),
    }).toStrictEqual({
      refused: "migration.required",
      other: "ok",
      current: 2,
    });
  });

  it("refuses a backfill that would start while rules are owed, so none waits on it", async () => {
    const { fixture, store, owned } = await sharedNext();
    await commitFiles(
      env,
      fixture.owner,
      fixture.app,
      { "schema.ts": categorised, "app.ts": notesApp("owner") },
      "Categories"
    );
    // Version 3 adds a defaulted category the notes lack, under the rules
    // the contract holds, sealed while version 2's activation is in
    // flight: its backfill would hold the contract, and the rules version
    // 2 owes with it, for as long as it runs.
    let meanwhile = "";
    const racing = racingDb(async () => {
      meanwhile = await failure(async () => await seal(fixture, 3));
    }, makingCurrent);
    await setCurrentVersion(
      { ...env, DB: racing },
      fixture.owner,
      fixture.app,
      2
    );
    const applied = await titles(store, owned, "grace");
    // Sealed again once version 2's rules are in force.
    const sealedAgain = await failure(async () => await seal(fixture, 3));

    expect({ meanwhile, applied, sealedAgain }).toStrictEqual({
      meanwhile: "migration.busy",
      applied: ["Ada's", "Grace's"],
      sealedAgain: "ok",
    });
  });

  it("applies no rules for an activation refused as busy, so it never puts back the rules a winner tightened", async () => {
    // Version 1 shares the notes; version 2 makes them their owner's, and
    // version 3 narrows the titles.
    const fixture = await appWith({
      "schema.ts": v1Schema,
      "app.ts": notesApp("appMembers"),
    });
    const first = await seal(fixture);
    await setCurrentVersion(env, fixture.owner, fixture.app, 1);
    const store = await openStore(env, fixture.store);
    const shared = first.manifest.schemaHash;
    await insert(store, shared, { title: "Ada's" }, "ada");
    await insert(store, shared, { title: "Grace's" }, "grace");
    await commitFiles(
      env,
      fixture.owner,
      fixture.app,
      { "app.ts": notesApp("owner") },
      "Owner's notes"
    );
    await seal(fixture, 2);
    await commitFiles(
      env,
      fixture.owner,
      fixture.app,
      { "schema.ts": shortTitles },
      "Shorter titles"
    );
    await seal(fixture, 3);
    // Version 2's make-current waits just before its batch, its store
    // step done. Meanwhile version 3's is refused as busy; after its first
    // read of the version current (still 1), version 2 commits, applies
    // its rules and settles them, and D1 then fails version 3's next read.
    const { promise: winnerWaits, resolve: releaseWinner } =
      Promise.withResolvers<boolean>();
    let winner: Promise<unknown> = Promise.resolve();
    const loserDb = readingThen(currentRead, async () => {
      releaseWinner(true);
      await winner;
    });
    let loser: Promise<string> = Promise.resolve("");
    winner = setCurrentVersion(
      {
        ...env,
        DB: racingDb(async () => {
          loser = failure(
            async () =>
              await setCurrentVersion(
                { ...env, DB: loserDb },
                fixture.owner,
                fixture.app,
                3
              )
          );
          await winnerWaits;
        }, makingCurrent),
      },
      fixture.owner,
      fixture.app,
      2
    );
    await winner;

    expect({
      loser: await loser,
      current: await currentOf(fixture.app),
      // Version 2's owner-only notes, as D1 has it current.
      read: await titles(store, shared, "grace"),
    }).toStrictEqual({
      loser: "migration.busy",
      current: 2,
      read: ["Grace's"],
    });
  });

  it("applies the rules as the version is made current", async () => {
    const { fixture, store, owned, shared } = await sharedNext();
    const before = await notesGeneration(store);
    await setCurrentVersion(env, fixture.owner, fixture.app, 2);

    expect({
      first: await titles(store, owned, "grace"),
      second: await titles(store, shared, "grace"),
      moved: (await notesGeneration(store)) > before,
    }).toStrictEqual({
      first: ["Ada's", "Grace's"],
      second: ["Ada's", "Grace's"],
      moved: true,
    });
  });
});
