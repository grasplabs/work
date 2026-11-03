import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import { databaseReader } from "@grasp-os/sdk/database";
import type { PaginationResult } from "@grasp-os/sdk/database";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import type { AccessMode } from "@grasp-os/sdk/host";
import {
  queryMaxScannedEntries,
  searchMaxTerms,
  searchTextMaxLength,
} from "@grasp-os/shared/store-limits";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { ReadRequest } from "@grasp-os/shared/store-reads";
import type { Commit, StoreFields } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { memberRoles, newRecordId } from "./store-schemas.ts";

// Full-text search of a business store (store-search.ts, store-queries.ts
// `searchMatches`), through core's way into a store and its Durable
// Object, asked as App code asks it (`ctx.db.search`). The cases follow
// the search's threat model: what a search finds and in which order, that
// the index follows every write, that a version adding the index builds it
// over the records already there, that a caller finds only what it may
// read, and that its text is only ever words, within its bounds.

const builder: Acting = {
  userId: "ada",
  role: "builder",
  teams: [],
  staff: false,
};

const customerFields = {
  name: v.string(),
  notes: v.string().nullable().optional(),
  city: v.string().optional(),
  archived: v.boolean().default(false),
};

const searchable = defineSchema({
  customers: defineTable(customerFields)
    .index("by_city", ["city"])
    .searchIndex(["name", "notes"]),
});

const plain = defineSchema({
  customers: defineTable(customerFields).index("by_city", ["city"]),
});

/** A schema's manifest text, its table read and written in mode `mode`. */
const textOf = (
  schema: typeof searchable | typeof plain,
  mode: AccessMode
): string =>
  manifestText(
    schemaManifest(schema, {
      tables: { customers: { read: mode, write: mode } },
    })
  );

interface Fixture {
  store: OpenStore;
  schemaHash: string;
}

const storeWith = async (mode: AccessMode): Promise<Fixture> => {
  const store = await openStore(env, await createStore(env, builder));
  const { schemaHash } = await store.defineTables(textOf(searchable, mode));
  return { store, schemaHash };
};

const scopeOf = (
  schemaHash: string,
  changes: Partial<ReadScope> = {}
): ReadScope => ({
  schemaHash,
  principal: "ada",
  appMember: true,
  appBuilder: false,
  consumer: { resourceId: "crm-app", resourceVersion: 1 },
  ...changes,
});

/** `ctx.db` over the searchable schema, for `scope`. */
const dbOf = ({ store }: Fixture, scope: ReadScope) =>
  databaseReader(searchable, async (request) => {
    const { value } = await store.read(scope, request);
    return value;
  });

/** Commits `writes` as `principal`, answering the IDs it inserted. */
const commit = async (
  { store, schemaHash }: Fixture,
  principal: string,
  writes: Commit["writes"]
): Promise<string[]> => {
  const claimed = await store.claim({
    scope: {
      principal,
      resource: "crm-app",
      binding: null,
      contractId: "customers.write",
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
    roles: memberRoles,
    stagedAt: Date.now(),
    schemaHash,
    receipt: claimed.held,
    writes,
  });
  return inserted;
};

/** Inserts `customers` through a commit, answering their IDs in order. */
const insert = async (
  fixture: Fixture,
  principal: string,
  ...customers: StoreFields[]
): Promise<string[]> =>
  await commit(
    fixture,
    principal,
    customers.map((fields) => ({
      op: "insert" as const,
      id: newRecordId(),
      table: "customers",
      fields,
    }))
  );

/** Inserts `count` customers straight into SQLite, fast, as `owner`'s. */
const insertMany = async (
  { store }: Fixture,
  count: number,
  fieldsOf: (index: number) => StoreFields,
  owner = "ada"
): Promise<void> => {
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    (_instance, state) => {
      const [table] = state.storage.sql
        .exec<{ table_id: string }>(
          "SELECT table_id FROM sdk_tables WHERE name = 'customers'"
        )
        .toArray();
      for (let index = 0; index < count; index += 1) {
        state.storage.sql.exec(
          "INSERT INTO sdk_records (table_id, record_id, owner_id, revision, created_at, updated_at, value_json, schema_hash) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
          table?.table_id,
          `c-${owner}-${String(index).padStart(6, "0")}`,
          owner,
          index,
          index,
          JSON.stringify({ archived: false, ...fieldsOf(index) }),
          "a".repeat(64)
        );
      }
    }
  );
};

/** What a read answered, or the code it was refused with. */
const outcome = async (read: Promise<unknown>): Promise<unknown> => {
  try {
    return await read;
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : error;
  }
};

/** What `read` answered, or the code it was refused with, thrown or not. */
const attempt = async (read: () => unknown): Promise<unknown> => {
  try {
    return await read();
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : error;
  }
};

/**
 * Calls method `name` of `target` as App code could, whatever its type
 * says: hostile code isn't held to the SDK's types.
 */
const callAnyway = (
  target: object,
  name: string,
  ...args: unknown[]
): unknown => {
  const method: unknown = Reflect.get(target, name);
  if (typeof method !== "function") {
    throw new TypeError(`No method ${name}`);
  }
  const result: unknown = Reflect.apply(method, target, args);
  return result;
};

/** A search's request as App code could send any, for the store to check. */
const searchRequest = (search: unknown, changes = {}): ReadRequest =>
  // SAFETY: none, on purpose: the store must refuse what isn't valid.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately loose input
  ({
    kind: "query",
    query: {
      descriptorVersion: 1,
      table: "customers",
      index: null,
      range: [],
      filter: null,
      order: "asc",
      terminal: { kind: "collect" },
      search,
      ...changes,
    },
  }) as ReadRequest;

const namesOf = (customers: readonly { name: string }[]): string[] =>
  customers.map(({ name }) => name);

/** Every page of a search, from the first. */
const allPages = async <Item>(
  read: (cursor: string | null) => Promise<PaginationResult<Item>>
): Promise<Item[]> => {
  const items: Item[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    // One page after the other: each starts where the last ended.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const page: PaginationResult<Item> = await read(cursor);
    items.push(...page.items);
    ({ nextCursor: cursor } = page);
    pages += 1;
  } while (cursor !== null && pages < 100);
  return items;
};

describe("a search", () => {
  it("finds the records holding every word, the best match first, ignoring case and accents", async () => {
    const fixture = await storeWith("appMembers");
    await insert(
      fixture,
      "ada",
      { name: "Acme Holdings International Trading Group", notes: null },
      { name: "Acme", notes: "acme acme supplies" },
      { name: "Zeta", notes: "met someone from Acme at the fair last year" },
      { name: "Müller Bakery", notes: "bread" },
      { name: "Other", city: "acme" }
    );
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const acme = await db.search("customers", "acme").collect();
    expect({
      first: acme[0]?.name,
      all: namesOf(acme).toSorted(),
    }).toStrictEqual({
      first: "Acme",
      // Not `Other`: `city` isn't in the index.
      all: ["Acme", "Acme Holdings International Trading Group", "Zeta"],
    });
    expect({
      both: namesOf(await db.search("customers", "ACME supplies").collect()),
      accents: namesOf(await db.search("customers", "muller").collect()),
      prefix: namesOf(await db.search("customers", "bak").collect()),
      // Only the last word is a prefix.
      notPrefix: namesOf(await db.search("customers", "bak bread").collect()),
      none: await db.search("customers", "acme bread").collect(),
    }).toStrictEqual({
      both: ["Acme"],
      accents: ["Müller Bakery"],
      prefix: ["Müller Bakery"],
      notPrefix: [],
      none: [],
    });
  });

  it("is filtered, counted and paged, every match once", async () => {
    const fixture = await storeWith("appMembers");
    await insertMany(fixture, 250, (index) => ({
      name: `Widget maker ${index}`,
      notes: index % 3 === 0 ? "widget widget" : "parts",
      archived: index % 2 === 0,
    }));
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const live = () =>
      db.search("customers", "widget").filter({ archived: false });
    const paged = await allPages(
      async (cursor) => await live().paginate({ pageSize: 40, cursor })
    );
    const first = await live().take(10);
    expect({
      count: await live().count(),
      paged: paged.length,
      distinct: new Set(paged.map(({ _id }) => _id)).size,
      archived: paged.filter(({ archived }) => archived).length,
      // The same order whether paged or taken.
      firstTen: paged.slice(0, 10).map(({ _id }) => _id),
    }).toStrictEqual({
      count: 125,
      paged: 125,
      distinct: 125,
      archived: 0,
      firstTen: first.map(({ _id }) => _id),
    });
    // Those that say it twice rank above those that say it once.
    expect(paged[0]?.notes).toBe("widget widget");
    expect(paged.at(-1)?.notes).toBe("parts");
  });

  it("follows every write: an insert, a change, a replacement and a deletion", async () => {
    const fixture = await storeWith("appMembers");
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const [first = "", second = ""] = await insert(
      fixture,
      "ada",
      { name: "Northwind", notes: "tea" },
      { name: "Southwind", notes: "coffee" }
    );
    const find = async (text: string): Promise<string[]> =>
      namesOf(await db.search("customers", text).collect());
    await expect(find("tea")).resolves.toStrictEqual(["Northwind"]);
    await commit(fixture, "ada", [
      {
        op: "patch",
        table: "customers",
        id: first,
        fields: { notes: "juice" },
        expectedRevision: 1,
      },
      {
        op: "replace",
        table: "customers",
        id: second,
        fields: { name: "Eastwind", archived: false },
        expectedRevision: 1,
      },
    ]);
    expect({
      tea: await find("tea"),
      juice: await find("juice"),
      coffee: await find("coffee"),
      southwind: await find("southwind"),
      eastwind: await find("eastwind"),
    }).toStrictEqual({
      tea: [],
      juice: ["Northwind"],
      coffee: [],
      southwind: [],
      eastwind: ["Eastwind"],
    });
    await commit(fixture, "ada", [
      { op: "delete", table: "customers", id: first, expectedRevision: 2 },
    ]);
    expect({
      juice: await find("juice"),
      wind: await find("wind"),
      count: await db.search("customers", "northwind").count(),
    }).toStrictEqual({ juice: [], wind: [], count: 0 });
    await expect(find("eastw")).resolves.toStrictEqual(["Eastwind"]);
  });

  it("finds only the caller's own records of a table read by owner only", async () => {
    const fixture = await storeWith("owner");
    await insert(fixture, "ada", { name: "Ada's lead" });
    await insert(fixture, "bob", { name: "Bob's lead" }, { name: "Bob lead" });
    const ada = dbOf(fixture, scopeOf(fixture.schemaHash));
    const bob = dbOf(
      fixture,
      scopeOf(fixture.schemaHash, { principal: "bob" })
    );
    expect({
      ada: namesOf(await ada.search("customers", "lead").collect()),
      bob: namesOf(await bob.search("customers", "lead").collect()).toSorted(),
      adaCount: await ada.search("customers", "lead").count(),
      // Search syntax is only ever words: no column filter reaches the
      // owner column, and nothing else's records show.
      injected: await ada
        .search("customers", 'lead" OR owner : "bob')
        .collect(),
      operators: await ada.search("customers", "NEAR(lead bob) *").collect(),
    }).toStrictEqual({
      ada: ["Ada's lead"],
      bob: ["Bob lead", "Bob's lead"],
      adaCount: 1,
      injected: [],
      operators: [],
    });
  });

  it("is built over the records already there by a version that declares it", async () => {
    const store = await openStore(env, await createStore(env, builder));
    const before = await store.defineTables(textOf(plain, "appMembers"));
    await insert({ store, schemaHash: before.schemaHash }, "ada", {
      name: "Initech",
      notes: "staplers",
    });
    const after = await store.defineTables(textOf(searchable, "appMembers"));
    const fixture = { store, schemaHash: after.schemaHash };
    await insert(fixture, "ada", { name: "Initrode", notes: "staplers" });
    const db = dbOf(fixture, scopeOf(after.schemaHash));
    // Defining the same version again builds nothing twice.
    await store.defineTables(textOf(searchable, "appMembers"));
    expect({
      found: namesOf(
        await db.search("customers", "staplers").collect()
      ).toSorted(),
      // The older version declares no search index, so it searches none.
      older: await outcome(
        store.read(scopeOf(before.schemaHash), searchRequest("staplers"))
      ),
    }).toStrictEqual({
      found: ["Initech", "Initrode"],
      older: "data.invalid_query",
    });
    await expect(db.search("customers", "staplers").count()).resolves.toBe(2);
  });
});

describe("a search's bounds", () => {
  it("are refused clearly, by the SDK and again by the store", async () => {
    const fixture = await storeWith("appMembers");
    await insert(fixture, "ada", { name: "Globex" });
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const scope = scopeOf(fixture.schemaHash);
    const long = "a".repeat(searchTextMaxLength + 1);
    const many = Array.from(
      { length: searchMaxTerms + 1 },
      (_, index) => `w${index}`
    ).join(" ");
    expect({
      sdkLong: await attempt(
        async () => await db.search("customers", long).collect()
      ),
      sdkMany: await attempt(
        async () => await db.search("customers", many).collect()
      ),
      // A search has no order; App code could call one anyway.
      sdkOrder: await attempt(() =>
        callAnyway(db.search("customers", "globex"), "order", "desc")
      ),
      storeLong: await outcome(fixture.store.read(scope, searchRequest(long))),
      storeMany: await outcome(fixture.store.read(scope, searchRequest(many))),
      storeIndex: await outcome(
        fixture.store.read(scope, searchRequest("globex", { index: "by_city" }))
      ),
      storeGroup: await outcome(
        fixture.store.read(
          scope,
          searchRequest("globex", {
            terminal: {
              kind: "group",
              by: ["city"],
              sum: [],
              avg: [],
              min: [],
              max: [],
            },
          })
        )
      ),
      storeUnique: await outcome(
        fixture.store.read(
          scope,
          searchRequest("globex", { terminal: { kind: "unique" } })
        )
      ),
    }).toStrictEqual({
      sdkLong: "query.invalid_terminal",
      sdkMany: "query.invalid_terminal",
      sdkOrder: "query.invalid_terminal",
      storeLong: "data.invalid_query",
      storeMany: "data.invalid_query",
      storeIndex: "data.invalid_query",
      storeGroup: "data.invalid_query",
      storeUnique: "data.invalid_query",
    });
    // Text with no word in it finds nothing, and reads nothing.
    expect({
      blank: await db.search("customers", "  ").collect(),
      punctuation: await db.search("customers", '" * : ( )').count(),
      page: await db.search("customers", "").paginate({ cursor: null }),
    }).toStrictEqual({
      blank: [],
      punctuation: 0,
      page: { items: [], nextCursor: null, hasMore: false },
    });
  });

  it("refuses a table without a search index", async () => {
    const store = await openStore(env, await createStore(env, builder));
    const { schemaHash } = await store.defineTables(
      textOf(plain, "appMembers")
    );
    const db = databaseReader(plain, async (request) => {
      const { value } = await store.read(scopeOf(schemaHash), request);
      return value;
    });
    expect({
      // The table's type says it has no search index; App code could ask
      // anyway.
      sdk: await attempt(() => callAnyway(db, "search", "customers", "x")),
      store: await outcome(store.read(scopeOf(schemaHash), searchRequest("x"))),
    }).toStrictEqual({
      sdk: "query.unknown_index",
      store: "data.invalid_query",
    });
  });

  it(`ranks at most ${queryMaxScannedEntries} matches, refusing a search that matches more`, async () => {
    const fixture = await storeWith("appMembers");
    await insertMany(fixture, queryMaxScannedEntries + 1, (index) => ({
      name: `common ${index % 7 === 0 ? "rare" : "word"}`,
    }));
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const rare = await db.search("customers", "rare").take(5);
    expect({
      common: await outcome(db.search("customers", "common").take(5)),
      rare: rare.length,
    }).toStrictEqual({ common: "data.scan_limit", rare: 5 });
  });
});
