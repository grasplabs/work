import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import type { Id, ValueShape } from "@grasp-os/sdk";
import { databaseReader } from "@grasp-os/sdk/database";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import type { AccessMode } from "@grasp-os/sdk/host";
import { queryMaxScannedEntries } from "@grasp-os/shared/store-limits";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { QueryRequest, ReadRequest } from "@grasp-os/shared/store-reads";
import type { StoreFields } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { StoreHost } from "../src/store-host.ts";

// Reads of a business store through core's way in and the store's Durable
// Object: what `ctx.db` (sdk/src/database.ts) asks, as the store answers
// it, under the access the caller's pinned schema declares. The cases
// follow the threat model in store-queries.ts: what a caller may see,
// through every terminal; what a descriptor can't name; what no query can
// scan past; and SQLite's own plan for the statements the store runs.

const builder: Acting = {
  userId: "ada",
  role: "builder",
  teams: [],
  staff: false,
};

const noteFields = {
  title: v.string(),
  rank: v.number().nullable().optional(),
  done: v.boolean().default(false),
};

/** The notes schema, its table read in mode `read`. */
const notesSchema = (read: AccessMode) => {
  const schema = defineSchema({
    notes: defineTable(noteFields)
      .index("by_title", ["title"])
      .index("by_done_rank", ["done", "rank"]),
    people: defineTable({ name: v.string() }),
  });
  return {
    schema,
    text: manifestText(
      schemaManifest(schema, {
        tables: {
          notes: { read, write: read },
          people: { read: "appMembers", write: "appMembers" },
        },
      })
    ),
  };
};

/** Whom a read is for: Ada, a member and not a builder, unless changed. */
const scopeOf = (
  schemaHash: string,
  changes: Partial<ReadScope> = {}
): ReadScope => ({
  schemaHash,
  principal: "ada",
  appMember: true,
  appBuilder: false,
  consumer: { resourceId: "notes-app", resourceVersion: 1 },
  ...changes,
});

interface Fixture {
  store: OpenStore;
  schemaHash: string;
  text: string;
  tableId: string;
}

/** A store with the notes schema, its table read in mode `read`. */
const storeWith = async (read: AccessMode): Promise<Fixture> => {
  const store = await openStore(env, await createStore(env, builder));
  const { text } = notesSchema(read);
  const defined = await store.defineTables(text);
  return {
    store,
    schemaHash: defined.schemaHash,
    text,
    tableId: defined.tables.notes ?? "",
  };
};

/** Commits `fields` as new notes of `principal`, answering their IDs. */
const insert = async (
  { store, schemaHash }: Fixture,
  principal: string,
  ...fields: StoreFields[]
): Promise<string[]> => {
  const claimed = await store.claim({
    scope: {
      principal,
      resource: "notes-app",
      binding: null,
      contractId: "notes.create",
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
    principal: { userId: principal },
    schemaHash,
    receipt: claimed.held,
    writes: fields.map((note) => ({
      op: "insert" as const,
      table: "notes",
      fields: note,
    })),
  });
  return inserted;
};

/** `ctx.db` for the notes schema, reading `fixture`'s store for `scope`. */
const dbOf = (fixture: Fixture, scope: ReadScope) =>
  databaseReader(
    notesSchema("owner").schema,
    async (request) => await fixture.store.read(scope, request)
  );

/** A record ID, as App code holds one. */
const idOf = (id: string | undefined): Id<"notes"> =>
  // SAFETY: a test's ID; the store decides what, if anything, it names.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  (id ?? "") as Id<"notes">;

/** A query request as App code could send any. */
const queryRequest = (changes: Partial<QueryRequest>): ReadRequest => ({
  kind: "query",
  query: {
    descriptorVersion: 1,
    table: "notes",
    index: null,
    range: [],
    filter: null,
    order: "asc",
    terminal: { kind: "collect" },
    ...changes,
  },
});

/** What a read answered, or the code it was refused with. */
const refusal = async (read: Promise<unknown>): Promise<unknown> => {
  try {
    return await read;
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : error;
  }
};

/** A read as hostile code could send it: the store checks it whole. */
const untypedRead = (request: unknown): ReadRequest =>
  // SAFETY: none, on purpose: the store must refuse what isn't a read.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately ill-typed input
  request as ReadRequest;

/** Field `field` of a record a read answered, or undefined. */
const fieldOf = (answer: unknown, field: string): unknown =>
  typeof answer === "object" && answer !== null && !Array.isArray(answer)
    ? Object.getOwnPropertyDescriptor(answer, field)?.value
    : undefined;

/** The titles of notes, in the order read. */
const titlesOf = (notes: readonly { title: string }[]): string[] =>
  notes.map(({ title }) => title);

/** Inserts `count` notes directly, as fast as SQLite can, for scan bounds. */
const insertMany = async (
  { store, tableId }: Fixture,
  count: number,
  document: StoreFields,
  owner = "ada"
): Promise<void> => {
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    (_instance, state) => {
      const text = JSON.stringify(document);
      for (let index = 0; index < count; index += 1) {
        state.storage.sql.exec(
          "INSERT INTO sdk_records (table_id, record_id, owner_id, revision, created_at, updated_at, value_json, schema_hash) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
          tableId,
          `bulk-${owner}-${String(index).padStart(6, "0")}`,
          owner,
          index,
          index,
          text,
          "a".repeat(64)
        );
      }
    }
  );
};

/**
 * SQLite's plan for the statement the store runs for `query`, planned by
 * the store's own host, from its own records.
 */
const planOf = async (
  { store }: Fixture,
  scope: ReadScope,
  query: QueryRequest
): Promise<string> =>
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    async (_instance, state) =>
      await new StoreHost(state, env).explain(store.id, scope, query)
  );

describe("owner-only tables", () => {
  it("answer every terminal from the caller's own records only", async () => {
    const fixture = await storeWith("owner");
    const [adaFirst] = await insert(
      fixture,
      "ada",
      { title: "a", rank: 1 },
      { title: "b", rank: 2 }
    );
    const [graceNote] = await insert(
      fixture,
      "grace",
      { title: "a", rank: 100 },
      { title: "c", rank: 200 },
      { title: "d", rank: 300 }
    );
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const notes = () => db.query("notes");
    // One of Ada's matches, though Grace has another: unique, not refused.
    const titled = () =>
      notes().withIndex("by_title", (range) => range.eq("title", "a"));
    const unique = await titled().unique();
    const mine = await db.get("notes", idOf(adaFirst));
    const answers = {
      // One commit's records share a creation time: by title, then.
      collect: titlesOf(await notes().collect()).toSorted(),
      count: await notes().count(),
      countAggregate: await notes().aggregate({ operation: "count" }),
      sum: await notes().aggregate({ operation: "sum", field: "rank" }),
      max: await notes().aggregate({ operation: "max", field: "rank" }),
      unique: unique?._ownerId,
      rangeCount: await titled().count(),
      othersOnly: await notes()
        .filter({ rank: { gt: 50 } })
        .first(),
      // Grace's record by ID is no record at all to Ada.
      theirs: await db.get("notes", idOf(graceNote)),
      mine: mine === null ? null : { ...mine, _createdAt: 0, _updatedAt: 0 },
    };
    expect(answers).toStrictEqual({
      collect: ["a", "b"],
      count: 2,
      countAggregate: 2,
      sum: 3,
      max: 2,
      unique: "ada",
      rangeCount: 1,
      othersOnly: null,
      theirs: null,
      mine: {
        _id: adaFirst,
        _ownerId: "ada",
        _rev: 1,
        _createdAt: 0,
        _updatedAt: 0,
        title: "a",
        rank: 1,
        done: false,
      },
    });
  });

  it("assert a revision only on a record the caller may see", async () => {
    const fixture = await storeWith("owner");
    const [mine] = await insert(fixture, "ada", { title: "a" });
    const [theirs] = await insert(fixture, "grace", { title: "b" });
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const guarded = { expectedRevision: 2 };
    expect({
      mine: await refusal(db.get("notes", idOf(mine), guarded)),
      theirs: await db.get("notes", idOf(theirs), guarded),
      missing: await db.get("notes", idOf("missing"), guarded),
    }).toStrictEqual({ mine: "data.conflict", theirs: null, missing: null });
  });

  it("read through the owner's index, never scanning others' records", async () => {
    const fixture = await storeWith("owner");
    const scope = scopeOf(fixture.schemaHash);
    const declared = await planOf(fixture, scope, {
      descriptorVersion: 1,
      table: "notes",
      index: "by_done_rank",
      range: [
        { field: "done", op: "eq", value: false },
        { field: "rank", op: "lt", value: 5 },
      ],
      filter: { field: "title", op: "neq", value: "x" },
      order: "desc",
      terminal: { kind: "collect" },
    });
    const byDefault = await planOf(fixture, scope, {
      descriptorVersion: 1,
      table: "notes",
      index: null,
      range: [],
      filter: null,
      order: "asc",
      terminal: { kind: "count" },
    });
    expect(declared).toMatch(
      /SEARCH sdk_records USING INDEX sdk_ix_[0-9a-f]{32} \(owner_id=\? AND <expr>=\? AND <expr>>\? AND <expr><\?\)/u
    );
    expect(byDefault).toContain(
      "USING INDEX sdk_records_owner_created (table_id=? AND owner_id=?)"
    );
    expect(`${declared}\n${byDefault}`).not.toContain("TEMP B-TREE");
  });
});

describe("tables read by the App's members or builders", () => {
  it("are refused to whoever the mode doesn't admit, and whole to whoever it does", async () => {
    const members = await storeWith("appMembers");
    const builders = await storeWith("appBuilders");
    const nobody = await storeWith("none");
    await insert(members, "grace", { title: "a" });
    await insert(builders, "grace", { title: "a" });
    const [id] = await insert(nobody, "ada", { title: "a" });
    const count = async (fixture: Fixture, changes: Partial<ReadScope>) =>
      await refusal(
        dbOf(fixture, scopeOf(fixture.schemaHash, changes))
          .query("notes")
          .count()
      );
    expect({
      membersToOutsider: await count(members, { appMember: false }),
      membersToMember: await count(members, {}),
      membersToBuilder: await count(members, {
        appMember: false,
        appBuilder: true,
      }),
      buildersToMember: await count(builders, {}),
      buildersToBuilder: await count(builders, { appBuilder: true }),
      nobodyToBuilder: await count(nobody, { appBuilder: true }),
      nobodyByIdToBuilder: await refusal(
        dbOf(nobody, scopeOf(nobody.schemaHash, { appBuilder: true })).get(
          "notes",
          idOf(id)
        )
      ),
    }).toStrictEqual({
      membersToOutsider: "data.access_denied",
      membersToMember: 1,
      membersToBuilder: 1,
      buildersToMember: "data.access_denied",
      buildersToBuilder: 1,
      nobodyToBuilder: "data.access_denied",
      nobodyByIdToBuilder: "data.access_denied",
    });
  });
});

describe("what a descriptor names", () => {
  it("is only what the pinned schema has", async () => {
    const fixture = await storeWith("appMembers");
    const scope = scopeOf(fixture.schemaHash);
    const read = async (request: ReadRequest) =>
      await refusal(fixture.store.read(scope, request));
    // A table the store holds for another schema isn't this schema's.
    await fixture.store.defineTables(
      manifestText(
        schemaManifest(
          defineSchema({ secrets: defineTable({ value: v.string() }) }),
          { tables: { secrets: { read: "appMembers", write: "appMembers" } } }
        )
      )
    );
    expect({
      unknownSchema: await refusal(
        fixture.store.read(scopeOf("f".repeat(64)), queryRequest({}))
      ),
      unknownTable: await read(queryRequest({ table: "missing" })),
      otherSchemasTable: await read(queryRequest({ table: "secrets" })),
      unknownIndex: await read(queryRequest({ index: "by_body" })),
      unknownField: await read(
        queryRequest({ filter: { field: "body", op: "eq", value: "a" } })
      ),
      rangeOutOfOrder: await read(
        queryRequest({
          index: "by_done_rank",
          range: [{ field: "rank", op: "eq", value: 1 }],
        })
      ),
      rangeWithoutIndex: await read(
        queryRequest({ range: [{ field: "title", op: "eq", value: "a" }] })
      ),
      managedAggregate: await read(
        queryRequest({
          terminal: { kind: "aggregate", operation: "sum", field: "_rev" },
        })
      ),
    }).toStrictEqual({
      unknownSchema: "data.unknown_schema",
      unknownTable: "data.unknown_table",
      otherSchemasTable: "data.unknown_table",
      unknownIndex: "data.unknown_index",
      unknownField: "data.invalid_query",
      rangeOutOfOrder: "data.invalid_query",
      rangeWithoutIndex: "data.invalid_query",
      managedAggregate: "data.invalid_query",
    });
  });

  it("never reaches SQL as anything but a name or a bound value", async () => {
    const fixture = await storeWith("appMembers");
    await insert(fixture, "ada", { title: "it's' OR 1=1 --" }, { title: "b" });
    const scope = scopeOf(fixture.schemaHash);

    expect({
      quoted: await dbOf(fixture, scope)
        .query("notes")
        .filter({ title: "it's' OR 1=1 --" })
        .count(),
      fieldInjection: await refusal(
        fixture.store.read(
          scope,
          queryRequest({
            filter: { field: "title') OR 1=1 --", op: "eq", value: 1 },
          })
        )
      ),
      rawSql: await refusal(
        fixture.store.read(
          scope,
          untypedRead({ kind: "query", query: { sql: "SELECT 1" } })
        )
      ),
    }).toStrictEqual({
      quoted: 1,
      fieldInjection: "data.invalid_query",
      rawSql: "data.invalid_query",
    });
  });
});

describe("conditions and ranges through the store", () => {
  it("keep values, null and a field left out apart, in order", async () => {
    const fixture = await storeWith("appMembers");
    await insert(
      fixture,
      "ada",
      // The store keeps what it is handed: defaults are the operation's.
      { title: "value", rank: 2, done: false },
      { title: "null", rank: null, done: false },
      { title: "missing", done: false },
      { title: "high", rank: 9, done: false }
    );
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const notes = () => db.query("notes");
    // Records of one commit share their creation time: sorted by title.
    const sorted = (found: readonly { title: string }[]) =>
      titlesOf(found).toSorted();
    expect({
      upperBound: titlesOf(
        await notes()
          .withIndex("by_done_rank", (range) =>
            range.eq("done", false).lt("rank", 5)
          )
          .collect()
      ),
      indexOrder: titlesOf(
        await notes()
          .withIndex("by_done_rank", (range) => range.eq("done", false))
          .collect()
      ),
      not: sorted(
        await notes()
          .filter({ NOT: { rank: 2 } })
          .collect()
      ),
      neq: sorted(
        await notes()
          .filter({ rank: { neq: 2 } })
          .collect()
      ),
      leftOut: sorted(
        await notes()
          .filter({ rank: { exists: false } })
          .collect()
      ),
    }).toStrictEqual({
      upperBound: ["value"],
      indexOrder: ["missing", "null", "value", "high"],
      not: ["high", "missing", "null"],
      neq: ["high"],
      leftOut: ["missing"],
    });
  });
});

describe("bounds", () => {
  it("fail a collect past 100 records, and a unique past one, rather than truncate", async () => {
    const fixture = await storeWith("appMembers");
    await insertMany(fixture, 101, { title: "same" });
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const taken = await db.query("notes").take(100);
    expect({
      collect: await refusal(db.query("notes").collect()),
      unique: await refusal(db.query("notes").unique()),
      take: taken.length,
      none: await db.query("notes").take(0),
    }).toStrictEqual({
      collect: "data.result_limit",
      unique: "data.not_unique",
      take: 100,
      none: [],
    });
  });

  it(`scan at most ${queryMaxScannedEntries} entries, failing rather than answering part`, async () => {
    const fixture = await storeWith("appMembers");
    await insertMany(fixture, queryMaxScannedEntries + 1, { title: "same" });
    await insert(fixture, "ada", { title: "other" });
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const first = await db.query("notes").first();
    expect({
      count: await refusal(db.query("notes").count()),
      filtered: await refusal(
        db.query("notes").filter({ title: "missing" }).first()
      ),
      // What stops early reads no further; an index range narrows a scan.
      first: first?.title,
      ranged: await db
        .query("notes")
        .withIndex("by_title", (range) => range.eq("title", "other"))
        .count(),
    }).toStrictEqual({
      count: "data.scan_limit",
      filtered: "data.scan_limit",
      first: "same",
      ranged: 1,
    });
  });

  it("read at most 16 MiB of documents in one terminal", async () => {
    const fixture = await storeWith("appMembers");
    await insertMany(fixture, 140, { title: "x".repeat(120_000) });
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    expect({
      filtered: await refusal(
        db.query("notes").filter({ title: "other" }).first()
      ),
      // Counting without a filter reads no documents.
      count: await db.query("notes").count(),
    }).toStrictEqual({ filtered: "data.scan_limit", count: 140 });
  });
});

/** A notes schema of `fields`, read by the App's members. */
const memberNotes = (fields: Parameters<typeof defineTable>[0]): string =>
  manifestText(
    schemaManifest(defineSchema({ notes: defineTable(fields) }), {
      tables: { notes: { read: "appMembers", write: "appMembers" } },
    })
  );

describe("pinned schemas", () => {
  it("project records to the schema a consumer is pinned to", async () => {
    const store = await openStore(env, await createStore(env, builder));
    const older = await store.defineTables(memberNotes({ title: v.string() }));
    const newer = await store.defineTables(
      memberNotes({ title: v.string(), body: v.string().default("") })
    );
    const fixture: Fixture = {
      store,
      schemaHash: newer.schemaHash,
      text: "",
      tableId: newer.tables.notes ?? "",
    };
    await insert(fixture, "ada", { title: "old" });
    await insert(fixture, "ada", { title: "new", body: "text" });
    const read = async (schemaHash: string) => {
      const answer = await store.read(scopeOf(schemaHash), queryRequest({}));
      if (!Array.isArray(answer)) {
        throw new TypeError("A collect answers a list");
      }
      return answer
        .map(({ title, body }: Record<string, unknown>) =>
          body === undefined ? { title } : { title, body }
        )
        .toSorted((left, right) =>
          String(left.title).localeCompare(String(right.title))
        );
    };
    expect({
      older: await read(older.schemaHash),
      newer: await read(newer.schemaHash),
    }).toStrictEqual({
      older: [{ title: "new" }, { title: "old" }],
      newer: [
        { title: "new", body: "text" },
        { title: "old", body: "" },
      ],
    });
  });
});

describe("more owners, more tables", () => {
  it("never count another owner's records against the caller's bounds", async () => {
    const fixture = await storeWith("owner");
    await insertMany(
      fixture,
      queryMaxScannedEntries + 5,
      { title: "theirs" },
      "grace"
    );
    await insert(
      fixture,
      "ada",
      { title: "a", rank: 1 },
      { title: "b", rank: 2 }
    );
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const found = await db.query("notes").collect();
    expect({
      collect: titlesOf(found).toSorted(),
      count: await db.query("notes").count(),
      filtered: await db.query("notes").filter({ title: "theirs" }).first(),
      ranged: await db
        .query("notes")
        .withIndex("by_title", (range) => range.eq("title", "theirs"))
        .count(),
    }).toStrictEqual({
      collect: ["a", "b"],
      count: 2,
      filtered: null,
      ranged: 0,
    });
  });

  it("find no record by an ID of another table", async () => {
    const fixture = await storeWith("appMembers");
    const claimed = await fixture.store.claim({
      scope: {
        principal: "ada",
        resource: "notes-app",
        binding: null,
        contractId: "people.create",
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
    const {
      inserted: [person],
    } = await fixture.store.commit({
      principal: { userId: "ada" },
      schemaHash: fixture.schemaHash,
      receipt: claimed.held,
      writes: [{ op: "insert", table: "people", fields: { name: "Ada" } }],
    });
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    expect({
      asNote: await db.get("notes", idOf(person)),
      asPerson: fieldOf(
        await fixture.store.read(scopeOf(fixture.schemaHash), {
          kind: "get",
          table: "people",
          id: person ?? "",
          expectedRevision: null,
        }),
        "name"
      ),
    }).toStrictEqual({ asNote: null, asPerson: "Ada" });
  });
});

describe("scan and aggregate edges", () => {
  it(`answer at exactly ${queryMaxScannedEntries} entries`, async () => {
    const fixture = await storeWith("appMembers");
    await insertMany(fixture, queryMaxScannedEntries, { title: "same" });
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    await expect(db.query("notes").count()).resolves.toBe(
      queryMaxScannedEntries
    );
  });

  it("answer null for the least or greatest of nothing, and refuse what isn't finite or numeric", async () => {
    const fixture = await storeWith("appMembers");
    await insert(
      fixture,
      "ada",
      { title: "a", rank: 1e308 },
      { title: "b", rank: 1e308 }
    );
    const scope = scopeOf(fixture.schemaHash);
    const db = dbOf(fixture, scope);
    const none = db.query("notes").filter({ title: "missing" });
    expect({
      min: await none.aggregate({ operation: "min", field: "rank" }),
      max: await none.aggregate({ operation: "max", field: "rank" }),
      sumOfNone: await none.aggregate({ operation: "sum", field: "rank" }),
      overflow: await refusal(
        db.query("notes").aggregate({ operation: "sum", field: "rank" })
      ),
      text: await refusal(
        fixture.store.read(
          scope,
          queryRequest({
            terminal: { kind: "aggregate", operation: "sum", field: "title" },
          })
        )
      ),
    }).toStrictEqual({
      min: null,
      max: null,
      sumOfNone: 0,
      overflow: "data.aggregate_overflow",
      text: "data.invalid_query",
    });
  });
});

describe("what a read changes", () => {
  it("creates nothing in a store no schema was handed", async () => {
    const store = await openStore(env, await createStore(env, builder));
    const refused = await refusal(
      store.read(scopeOf("a".repeat(64)), queryRequest({}))
    );
    const rows = await runInDurableObject(
      env.DATA_STORES.getByName(store.id),
      (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM sdk_store")
          .one().count
    );
    expect({ refused, rows }).toStrictEqual({
      refused: "data.unknown_schema",
      rows: 0,
    });
  });

  it("asks for an index the store doesn't hold, never scanning instead", async () => {
    const fixture = await storeWith("appMembers");
    await runInDurableObject(
      env.DATA_STORES.getByName(fixture.store.id),
      (_instance, state) => {
        for (const { name } of state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'sdk\\_ix\\_%' ESCAPE '\\'"
          )
          .toArray()) {
          state.storage.sql.exec(`DROP INDEX ${name}`);
        }
      }
    );
    await expect(
      refusal(
        fixture.store.read(
          scopeOf(fixture.schemaHash),
          queryRequest({ index: "by_title" })
        )
      )
    ).resolves.toBe("data.index_required");
  });
});

describe("projection, at every depth", () => {
  it("leaves out nested keys the pinned schema doesn't declare", async () => {
    const store = await openStore(env, await createStore(env, builder));
    const pinned = await store.defineTables(
      memberNotes({
        title: v.string(),
        meta: v.object({ source: v.string() }),
        parts: v.array(v.object({ label: v.string() })),
        tags: v.record(v.object({ color: v.string() })),
      })
    );
    const fixture: Fixture = {
      store,
      schemaHash: pinned.schemaHash,
      text: "",
      tableId: pinned.tables.notes ?? "",
    };
    // What a later schema could have stored beside the pinned fields.
    await insertMany(fixture, 1, {
      title: "a",
      meta: { source: "mail", secret: "s" },
      parts: [{ label: "x", hidden: true }],
      tags: { red: { color: "red", internal: 1 } },
    });
    const answer = await store.read(
      scopeOf(pinned.schemaHash),
      queryRequest({})
    );
    const note = Array.isArray(answer) ? answer[0] : undefined;
    expect({
      meta: fieldOf(note, "meta"),
      parts: fieldOf(note, "parts"),
      tags: fieldOf(note, "tags"),
    }).toStrictEqual({
      meta: { source: "mail" },
      parts: [{ label: "x" }],
      tags: { red: { color: "red" } },
    });
  });
});

describe("projection of unions", () => {
  it("projects a union to the member the stored value fits, never a smaller one", async () => {
    const store = await openStore(env, await createStore(env, builder));
    const pinned = await store.defineTables(
      memberNotes({
        title: v.string(),
        shape: v.union(
          v.object({ a: v.string(), b: v.string().optional() }),
          v.object({ a: v.string(), c: v.string() })
        ),
      })
    );
    const fixture: Fixture = {
      store,
      schemaHash: pinned.schemaHash,
      text: "",
      tableId: pinned.tables.notes ?? "",
    };
    await insertMany(fixture, 1, {
      title: "fits second",
      shape: { a: "x", c: "y" },
    });
    await insertMany(
      fixture,
      1,
      { title: "fits first", shape: { a: "x", b: "z" } },
      "grace"
    );
    // A later schema's key beside the second member's: none validates as
    // stored, so the first whose projection validates.
    await insertMany(
      fixture,
      1,
      { title: "later key", shape: { a: "x", c: "y", d: "later" } },
      "lin"
    );
    const answer = await store.read(
      scopeOf(pinned.schemaHash),
      queryRequest({})
    );
    const shapes = Object.fromEntries(
      (Array.isArray(answer) ? answer : []).map((note) => [
        String(fieldOf(note, "title")),
        fieldOf(note, "shape"),
      ])
    );
    expect(shapes).toStrictEqual({
      "fits second": { a: "x", c: "y" },
      "fits first": { a: "x", b: "z" },
      "later key": { a: "x" },
    });
  });

  it("aggregate numbers only, never a boolean stored where a number belongs", async () => {
    const fixture = await storeWith("appMembers");
    await insertMany(fixture, 1, { title: "a", rank: 2 });
    await insertMany(fixture, 1, { title: "b", rank: true }, "grace");
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    await expect(
      db.query("notes").aggregate({ operation: "sum", field: "rank" })
    ).resolves.toBe(2);
  });
});

describe("projection of unions of every kind", () => {
  /** A store of notes whose `shape` is `shape`, holding `stored` shapes. */
  const shapesRead = async (
    shape: ValueShape[string],
    ...stored: StoreFields[string][]
  ): Promise<unknown> => {
    const store = await openStore(env, await createStore(env, builder));
    const pinned = await store.defineTables(
      memberNotes({ title: v.string(), shape })
    );
    const fixture: Fixture = {
      store,
      schemaHash: pinned.schemaHash,
      text: "",
      tableId: pinned.tables.notes ?? "",
    };
    for (const [position, value] of stored.entries()) {
      // One record each, by owners of their own.
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await insertMany(
        fixture,
        1,
        { title: String(position), shape: value },
        `owner${position}`
      );
    }
    const answer = await refusal(
      store.read(scopeOf(pinned.schemaHash), queryRequest({}))
    );
    return Array.isArray(answer)
      ? answer
          .map((note: unknown) => [
            fieldOf(note, "title"),
            fieldOf(note, "shape"),
          ])
          .toSorted(([left], [right]) =>
            String(left).localeCompare(String(right))
          )
          .map(([, value]) => value)
      : answer;
  };

  it("keeps money, files and schedules whole, and drops what their kinds don't hold", async () => {
    expect({
      money: await shapesRead(
        v.union(v.money(), v.object({ label: v.string() })),
        { minorUnits: 125, currency: "EUR" },
        { label: "free" }
      ),
      file: await shapesRead(
        v.union(v.file(), v.schedule()),
        { id: "f1", hidden: "secret" },
        { cron: "0 9 * * 1", timeZone: "Europe/Amsterdam" }
      ),
    }).toStrictEqual({
      money: [{ minorUnits: 125, currency: "EUR" }, { label: "free" }],
      file: [{ id: "f1" }, { cron: "0 9 * * 1", timeZone: "Europe/Amsterdam" }],
    });
  });

  it("projects through nested unions to the member the value fits", async () => {
    await expect(
      shapesRead(
        v.union(
          v.union(v.object({ a: v.string() }), v.object({ b: v.string() })),
          v.string()
        ),
        { b: "x" },
        "plain"
      )
    ).resolves.toStrictEqual([{ b: "x" }, "plain"]);
  });

  it("refuses a value no member can be shown as, leaking nothing", async () => {
    await expect(
      shapesRead(v.union(v.object({ a: v.string() }), v.number()), {
        secret: "undeclared",
      })
    ).resolves.toBe("data.incompatible_record");
  });
});
