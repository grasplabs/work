import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import type { Id } from "@grasp-os/sdk";
import { databaseReader, manifestText } from "@grasp-os/sdk/host";
import type { AccessMode } from "@grasp-os/sdk/host";
import { queryMaxScannedEntries } from "@grasp-os/shared/store-limits";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { QueryRequest, ReadRequest } from "@grasp-os/shared/store-reads";
import type { StoreFields } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { storeOfNewApp } from "./app-stores.ts";
import { tiledPage } from "./split-pages.ts";
import { accessedManifest, appliedTables } from "./store-schemas.ts";

// Grouped aggregates and related records of a business store
// (store-queries.ts `groupsOf` and `withRelated`), through core's way into
// a store and its Durable Object, asked as App code asks them (`ctx.db`).
// The cases follow their threat model: groups that add up to every record
// the query reads, values, null and absence kept apart, within a bound on
// groups; related records loaded under the access the caller has to their
// own tables, a table it can't read withheld, a record it may not see
// null; and both refused clearly past their bounds.

const builder: Acting = {
  userId: "ada",
  role: "builder",
  teams: [],
  staff: false,
};

const schema = defineSchema({
  customers: defineTable({ name: v.string() }),
  products: defineTable({ title: v.string() }),
  notes: defineTable({ text: v.string() }),
  orders: defineTable({
    status: v.string().nullable().optional(),
    region: v.string(),
    paid: v.boolean(),
    amount: v.number().optional(),
    customer: v.id("customers").optional(),
    items: v.array(v.id("products")).optional(),
    note: v.id("notes").optional(),
  }).index("by_region", ["region"]),
});

interface Fixture {
  store: OpenStore;
  schemaHash: string;
  tableIds: Readonly<Record<string, string>>;
}

/**
 * A store of `schema`: orders and customers read by the App's members,
 * products only by its builders, notes by their owner.
 */
const storeWith = async (
  access: Partial<Record<string, AccessMode>> = {}
): Promise<Fixture> => {
  const store = await openStore(env, await storeOfNewApp(env, builder));
  const mode = (table: string, fallback: AccessMode): AccessMode =>
    access[table] ?? fallback;
  const defined = await appliedTables(
    store,
    manifestText(
      accessedManifest(schema, {
        tables: {
          orders: {
            read: mode("orders", "appMembers"),
            write: mode("orders", "appMembers"),
          },
          customers: {
            read: mode("customers", "appMembers"),
            write: "appMembers",
          },
          products: {
            read: mode("products", "appBuilders"),
            write: "appBuilders",
          },
          notes: { read: mode("notes", "owner"), write: "owner" },
        },
      })
    )
  );
  return { store, schemaHash: defined.schemaHash, tableIds: defined.tables };
};

const scopeOf = (
  schemaHash: string,
  changes: Partial<ReadScope> = {}
): ReadScope => ({
  schemaHash,
  principal: "ada",
  appMember: true,
  appBuilder: false,
  consumer: { resourceId: "shop-app", resourceVersion: 1 },
  ...changes,
});

const dbOf = ({ store }: Fixture, scope: ReadScope) =>
  databaseReader(schema, async (request) => {
    const { value } = await store.read(scope, request);
    return value;
  });

/** A record to put straight into SQLite. */
interface Row {
  readonly id: string;
  readonly fields: StoreFields;
  readonly owner?: string;
}

/**
 * Puts `rows` into `table` straight through SQLite, in order of creation:
 * fixtures whose references a commit would check against the writer's own
 * access, which is beside the point of a read.
 */
const put = async (
  { store, tableIds }: Fixture,
  table: string,
  rows: readonly Row[]
): Promise<void> => {
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    (_instance, state) => {
      for (const [index, row] of rows.entries()) {
        state.storage.sql.exec(
          "INSERT INTO sdk_records (table_id, record_id, owner_id, revision, created_at, updated_at, value_json, schema_hash) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
          tableIds[table],
          row.id,
          row.owner ?? "ada",
          index,
          index,
          JSON.stringify(row.fields),
          "a".repeat(64)
        );
      }
    }
  );
};

/** What a read answered, or the code it was refused with. */
const outcome = async (read: () => Promise<unknown>): Promise<unknown> => {
  try {
    return await read();
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : error;
  }
};

/** An orders query as App code could send any, for the store to check. */
const ordersRequest = (changes: Record<string, unknown>): ReadRequest => ({
  kind: "query",
  query: {
    descriptorVersion: 1,
    table: "orders",
    index: null,
    range: [],
    filter: null,
    order: "asc",
    terminal: { kind: "collect" },
    ...changes,
  } satisfies Partial<QueryRequest> & Record<string, unknown>,
});

/** A group terminal of `by`, with nothing aggregated unless set. */
const groupBy = (by: string[], aggregates: Record<string, string[]> = {}) => ({
  kind: "group",
  by,
  sum: [],
  avg: [],
  min: [],
  max: [],
  ...aggregates,
});

const orders: Row[] = [
  {
    id: "o1",
    fields: { status: "open", region: "EU", paid: true, amount: 10 },
  },
  {
    id: "o2",
    fields: { status: "open", region: "EU", paid: false, amount: 30 },
  },
  {
    id: "o3",
    fields: { status: "won", region: "EU", paid: true, amount: 100 },
  },
  { id: "o4", fields: { status: "open", region: "US", paid: true } },
  { id: "o5", fields: { status: null, region: "US", paid: false, amount: 5 } },
  { id: "o6", fields: { region: "US", paid: true, amount: 7 } },
  { id: "o7", fields: { status: "won", region: "US", paid: true, amount: -4 } },
];

/** `index` as five digits, so records sort in its order. */
const numbered = (index: number): string => String(index).padStart(5, "0");

describe("groups", () => {
  it("count and aggregate every record the query reads, null and absence apart, in key order", async () => {
    const fixture = await storeWith();
    await put(fixture, "orders", orders);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    await expect(
      db.query("orders").group({
        by: ["status"],
        sum: ["amount"],
        avg: ["amount"],
        min: ["amount"],
        max: ["amount"],
      })
    ).resolves.toStrictEqual([
      // Left out first, then null, then values: SQLite's order.
      {
        key: {},
        count: 1,
        sum: { amount: 7 },
        avg: { amount: 7 },
        min: { amount: 7 },
        max: { amount: 7 },
      },
      {
        key: { status: null },
        count: 1,
        sum: { amount: 5 },
        avg: { amount: 5 },
        min: { amount: 5 },
        max: { amount: 5 },
      },
      {
        // o4 has no amount: counted, never averaged.
        key: { status: "open" },
        count: 3,
        sum: { amount: 40 },
        avg: { amount: 20 },
        min: { amount: 10 },
        max: { amount: 30 },
      },
      {
        key: { status: "won" },
        count: 2,
        sum: { amount: 96 },
        avg: { amount: 48 },
        min: { amount: -4 },
        max: { amount: 100 },
      },
    ]);
  });

  it("order text keys by code point, as SQLite orders text", async () => {
    const fixture = await storeWith();
    // U+1F600 is past U+FF5E, though its first UTF-16 unit (a surrogate,
    // U+D83D) comes before it.
    await put(fixture, "orders", [
      { id: "e1", fields: { status: "😀", region: "EU", paid: true } },
      { id: "e2", fields: { status: "～", region: "EU", paid: true } },
      { id: "e3", fields: { status: "a", region: "EU", paid: true } },
    ]);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const groups = await db.query("orders").group({ by: ["status"] });
    expect(groups.map(({ key }) => key.status)).toStrictEqual([
      "a",
      "～",
      "😀",
    ]);
  });

  it("group by two fields, booleans as booleans, within an index range and a filter", async () => {
    const fixture = await storeWith();
    await put(fixture, "orders", orders);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    expect({
      two: await db
        .query("orders")
        .withIndex("by_region", (range) => range.eq("region", "US"))
        .group({ by: ["paid", "region"], sum: ["amount"] }),
      filtered: await db
        .query("orders")
        .filter({ paid: true })
        .group({ by: ["region"], avg: ["amount"] }),
      none: await db
        .query("orders")
        .filter({ region: "APAC" })
        .group({ by: ["region"] }),
    }).toStrictEqual({
      two: [
        {
          key: { paid: false, region: "US" },
          count: 1,
          sum: { amount: 5 },
          avg: {},
          min: {},
          max: {},
        },
        {
          key: { paid: true, region: "US" },
          count: 3,
          sum: { amount: 3 },
          avg: {},
          min: {},
          max: {},
        },
      ],
      filtered: [
        {
          key: { region: "EU" },
          count: 2,
          sum: {},
          avg: { amount: 55 },
          min: {},
          max: {},
        },
        {
          key: { region: "US" },
          count: 3,
          sum: {},
          avg: { amount: 1.5 },
          min: {},
          max: {},
        },
      ],
      none: [],
    });
  });

  it("answer every group the read examines, and refuse what isn't one, clearly", async () => {
    // More groups than a page of records: a grouped read answers as many
    // as the records it examines make, bounded only by what it reads.
    const manyGroups = 150;
    const fixture = await storeWith();
    await put(
      fixture,
      "orders",
      Array.from({ length: manyGroups }, (_, index) => ({
        id: `g${index}`,
        fields: { status: `s${index}`, region: "EU", paid: true },
      }))
    );
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const scope = scopeOf(fixture.schemaHash);
    const byStatus = await db.query("orders").group({ by: ["status"] });
    const byThree = await db
      .query("orders")
      .group({ by: ["status", "region", "paid"] });
    expect({
      groups: byStatus.length,
      regions: await db.query("orders").group({ by: ["region"] }),
      threeFields: byThree.length,
      sdkText: await outcome(
        async () =>
          await db.query("orders").group({
            by: ["region"],
            // @ts-expect-error -- `status` isn't numeric
            sum: ["status"],
          })
      ),
      sdkWith: await outcome(
        async () =>
          await db
            .query("orders")
            .with("customer")
            .group({ by: ["region"] })
      ),
      storeTwice: await outcome(
        async () =>
          await fixture.store.read(
            scope,
            ordersRequest({ terminal: groupBy(["region", "region"]) })
          )
      ),
      storeText: await outcome(
        async () =>
          await fixture.store.read(
            scope,
            ordersRequest({
              terminal: groupBy(["region"], { avg: ["status"] }),
            })
          )
      ),
      storeManaged: await outcome(
        async () =>
          await fixture.store.read(
            scope,
            ordersRequest({ terminal: groupBy(["_ownerId"]) })
          )
      ),
      storeObject: await outcome(
        async () =>
          await fixture.store.read(
            scope,
            ordersRequest({ terminal: groupBy(["items"]) })
          )
      ),
    }).toStrictEqual({
      groups: manyGroups,
      regions: [
        {
          key: { region: "EU" },
          count: manyGroups,
          sum: {},
          avg: {},
          min: {},
          max: {},
        },
      ],
      threeFields: manyGroups,
      sdkText: "query.invalid_terminal",
      sdkWith: "query.invalid_terminal",
      storeTwice: "data.invalid_query",
      storeText: "data.invalid_query",
      storeManaged: "data.invalid_query",
      storeObject: "data.invalid_query",
    });
  });

  it(`read at most ${queryMaxScannedEntries} entries, failing rather than answering part`, async () => {
    const fixture = await storeWith();
    await put(
      fixture,
      "orders",
      Array.from({ length: queryMaxScannedEntries + 1 }, (_, index) => ({
        id: `b${String(index).padStart(6, "0")}`,
        fields: { region: "EU", paid: true, amount: 1 },
      }))
    );
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    await expect(
      outcome(async () => await db.query("orders").group({ by: ["region"] }))
    ).resolves.toBe("data.scan_limit");
  });
});

/** A record ID, as App code holds one. */
const idOf = <TableName extends string>(id: string): Id<TableName> =>
  // SAFETY: a test's ID; the store decides what, if anything, it names.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  id as Id<TableName>;

/** The titles of related products as `with` loaded them, nulls kept. */
const titlesOf = (items: unknown): unknown =>
  Array.isArray(items)
    ? items.map((item: unknown): unknown => {
        if (typeof item !== "object" || item === null) {
          return item;
        }
        const title: unknown = Reflect.get(item, "title");
        return title;
      })
    : items;

describe("related records", () => {
  it("come with each record, loaded under the caller's access to their own tables", async () => {
    const fixture = await storeWith();
    await put(fixture, "customers", [
      { id: "c1", fields: { name: "Acme" } },
      { id: "c2", fields: { name: "Globex" } },
    ]);
    await put(fixture, "products", [{ id: "p1", fields: { title: "Anvil" } }]);
    await put(fixture, "notes", [
      { id: "n1", fields: { text: "Ada's" } },
      { id: "n2", fields: { text: "Bob's" }, owner: "bob" },
    ]);
    await put(fixture, "orders", [
      {
        id: "o1",
        fields: {
          region: "EU",
          paid: true,
          customer: "c1",
          items: ["p1"],
          note: "n1",
        },
      },
      {
        id: "o2",
        fields: {
          region: "EU",
          paid: true,
          customer: "gone",
          items: ["p1", "p1"],
          note: "n2",
        },
      },
      { id: "o3", fields: { region: "EU", paid: true, customer: "c1" } },
    ]);
    const member = dbOf(fixture, scopeOf(fixture.schemaHash));
    const read = await member
      .query("orders")
      .with("customer", "items", "note")
      .take(3);
    const shown = read.map(({ _id, _with }) => ({
      id: _id,
      customer:
        _with.customer === null || "_withheld" in _with.customer
          ? _with.customer
          : _with.customer.name,
      items: _with.items,
      note:
        _with.note === null || "_withheld" in _with.note
          ? _with.note
          : _with.note.text,
    }));
    expect(shown).toStrictEqual([
      // Products are read by builders only: withheld, whatever the IDs.
      { id: "o1", customer: "Acme", items: { _withheld: true }, note: "Ada's" },
      // A customer gone, and a note of another owner's: null, alike.
      { id: "o2", customer: null, items: { _withheld: true }, note: null },
      { id: "o3", customer: "Acme", items: { _withheld: true }, note: null },
    ]);
    // A builder reads products: a list for a list, a record for each ID.
    const builderDb = dbOf(
      fixture,
      scopeOf(fixture.schemaHash, { appBuilder: true })
    );
    const page = await builderDb
      .query("orders")
      .filter({ customer: idOf<"customers">("gone") })
      .with("items")
      .paginate({ pageSize: 10, cursor: null });
    const unique = await builderDb
      .query("orders")
      .filter({ customer: idOf<"customers">("gone") })
      .with("items")
      .unique();
    const first = await builderDb.query("orders").with("items").first();
    expect({
      page: page.items.map(({ _with }) => titlesOf(_with.items)),
      unique: titlesOf(unique?._with.items),
      first: titlesOf(first?._with.items),
    }).toStrictEqual({
      page: [["Anvil", "Anvil"]],
      unique: ["Anvil", "Anvil"],
      first: ["Anvil"],
    });
  });

  it("make the read depend on the tables the caller may read, so a live query follows them", async () => {
    const fixture = await storeWith();
    await put(fixture, "customers", [{ id: "c1", fields: { name: "Acme" } }]);
    await put(fixture, "orders", [
      { id: "o1", fields: { region: "EU", paid: true, customer: "c1" } },
    ]);
    const { generations } = await fixture.store.read(
      scopeOf(fixture.schemaHash),
      ordersRequest({ with: ["customer", "items"] })
    );
    const builders = await fixture.store.read(
      scopeOf(fixture.schemaHash, { appBuilder: true }),
      ordersRequest({ with: ["customer", "items"] })
    );
    expect({
      // Products are withheld from a member, and so is their activity.
      member: Object.keys(generations).toSorted(),
      builder: Object.keys(builders.generations).toSorted(),
    }).toStrictEqual({
      member: ["customers", "orders"],
      builder: ["customers", "orders", "products"],
    });
  });

  it("count toward splitting a page with an end, so a page loading them splits before it passes an answer", async () => {
    const fixture = await storeWith();
    // Small orders, each naming a customer of 60 KB: only what `with`
    // loads makes the page large.
    await put(
      fixture,
      "customers",
      Array.from({ length: 4 }, (_, index) => ({
        id: `big${index}`,
        fields: { name: String(index).repeat(60_000) },
      }))
    );
    await put(
      fixture,
      "orders",
      Array.from({ length: 5 }, (_, index) => ({
        id: `w${index}`,
        fields: { region: "EU", paid: true, customer: `big${index % 4}` },
      }))
    );
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const withCustomers = () => db.query("orders").with("customer");
    const whole = await withCustomers().paginate({ pageSize: 4 });
    const grown = await withCustomers().paginate({
      pageSize: 3,
      endCursor: whole.nextCursor ?? "",
    });
    const half = await withCustomers().paginate({ pageSize: 2 });
    expect({
      grown: grown.items.length,
      split: grown.splitCursor,
      // Answered whole while it fits one answer, and split where half of
      // its bytes end.
    }).toStrictEqual({ grown: 4, split: half.nextCursor });
  });

  it("count toward what a page with an end may examine, so one loading them past it splits instead of failing", async () => {
    const fixture = await storeWith();
    await put(fixture, "orders", [
      { id: "m", fields: { region: "M", paid: true } },
      { id: "z", fields: { region: "Z", paid: true } },
    ]);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const byRegion = () =>
      db.query("orders").withIndex("by_region").with("customer");
    const first = await byRegion().paginate({ pageSize: 1 });
    // An import lands inside the page: 6,000 orders, each naming its own
    // customer. Their records and the customers loaded with them are
    // more than one read may examine.
    const imported = 6000;
    await put(
      fixture,
      "customers",
      Array.from({ length: imported }, (_, index) => ({
        id: `c${numbered(index)}`,
        fields: { name: `c${numbered(index)}` },
      }))
    );
    await put(
      fixture,
      "orders",
      Array.from({ length: imported }, (_, index) => ({
        id: `i${numbered(index)}`,
        fields: {
          region: `A${numbered(index)}`,
          paid: true,
          customer: `c${numbered(index)}`,
        },
      }))
    );
    const tiled = await tiledPage(
      async (from, until) =>
        await byRegion().paginate({
          pageSize: 10_000,
          cursor: from,
          endCursor: until,
        }),
      null,
      first.nextCursor ?? ""
    );
    // Each order with the customer it names.
    const loaded = tiled.items.filter(
      ({ customer, _with }) =>
        _with.customer !== null &&
        !("_withheld" in _with.customer) &&
        _with.customer.name === customer
    );
    expect({
      split: tiled.reads > 1,
      orders: tiled.items.length,
      unique: new Set(tiled.items.map(({ _id }) => _id)).size,
      last: tiled.items.at(-1)?._id,
      loaded: loaded.length,
    }).toStrictEqual({
      split: true,
      orders: imported + 1,
      unique: imported + 1,
      last: "m",
      loaded: imported,
    });
  });

  it("are refused past their bounds, clearly", async () => {
    const fixture = await storeWith();
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const scope = scopeOf(fixture.schemaHash);
    expect({
      sdkField: await outcome(
        async () =>
          // @ts-expect-error -- `region` holds no record ID
          await db.query("orders").with("region").take(1)
      ),
      sdkCount: await outcome(
        async () => await db.query("orders").with("customer").count()
      ),
      storeField: await outcome(
        async () =>
          await fixture.store.read(scope, ordersRequest({ with: ["region"] }))
      ),
      storeCount: await outcome(
        async () =>
          await fixture.store.read(
            scope,
            ordersRequest({ with: ["customer"], terminal: { kind: "count" } })
          )
      ),
    }).toStrictEqual({
      sdkField: "query.invalid_terminal",
      sdkCount: "query.invalid_terminal",
      storeField: "data.invalid_query",
      storeCount: "data.invalid_query",
    });
  });
});

describe("a grouped read past SQLite's own limits", () => {
  it("is refused as an invalid query, never a raw SQLite error", async () => {
    // Very many numeric fields, each aggregated four ways: a statement
    // longer, and wider, than SQLite takes.
    const fields = Array.from({ length: 600 }, (_, index) => `m${index}`);
    const wide = defineSchema({
      metrics: defineTable(
        Object.fromEntries(
          fields.map((field) => [field, v.number().optional()])
        )
      ),
    });
    const store = await openStore(env, await storeOfNewApp(env, builder));
    const { schemaHash } = await appliedTables(
      store,
      manifestText(
        accessedManifest(wide, {
          tables: { metrics: { read: "appMembers", write: "appMembers" } },
        })
      )
    );
    await expect(
      outcome(
        async () =>
          await store.read(scopeOf(schemaHash), {
            kind: "query",
            query: {
              descriptorVersion: 1,
              table: "metrics",
              index: null,
              range: [],
              filter: null,
              order: "asc",
              terminal: {
                kind: "group",
                by: ["m0"],
                sum: fields,
                avg: fields,
                min: fields,
                max: fields,
              },
            },
          })
      )
    ).resolves.toBe("data.invalid_query");
  });
});
