import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import { databaseReader } from "@grasp-os/sdk/database";
import type { PaginationResult } from "@grasp-os/sdk/database";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import type { AccessMode } from "@grasp-os/sdk/host";
import { fromBase64Url } from "@grasp-os/shared/encoding";
import {
  cursorMaxLength,
  queryMaxScannedEntries,
} from "@grasp-os/shared/store-limits";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { ReadRequest } from "@grasp-os/shared/store-reads";
import type { StoreFields } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";

// Pages of a business store's records and their cursors (store-cursors.ts,
// store-queries.ts `readPage`), through core's way into a store and its
// Durable Object, built by `ctx.db` as App code builds them. The cases
// follow the cursor's threat model: pages that add up to the whole, along
// any index and order, whatever is left out or null; deep pages that cost
// what they read; and cursors that no one can forge, edit, carry to
// another query, caller or store, or keep past their version.

const builder: Acting = {
  userId: "ada",
  role: "builder",
  teams: [],
  staff: false,
};

const schema = defineSchema({
  notes: defineTable({
    title: v.string(),
    rank: v.number().nullable().optional(),
    done: v.boolean().default(false),
  })
    .index("by_title", ["title"])
    .index("by_done_rank", ["done", "rank"]),
});

interface Fixture {
  store: OpenStore;
  schemaHash: string;
  tableId: string;
}

const storeWith = async (read: AccessMode): Promise<Fixture> => {
  const store = await openStore(env, await createStore(env, builder));
  const defined = await store.defineTables(
    manifestText(
      schemaManifest(schema, { tables: { notes: { read, write: read } } })
    )
  );
  return {
    store,
    schemaHash: defined.schemaHash,
    tableId: defined.tables.notes ?? "",
  };
};

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

const dbOf = (fixture: Fixture, scope: ReadScope) =>
  databaseReader(
    schema,
    async (request) => await fixture.store.read(scope, request)
  );

/**
 * Notes inserted straight into the store's SQLite, each created a
 * millisecond after the last, so their default order is known: record
 * IDs `n-0000`, `n-0001`, ….
 */
const insertNotes = async (
  { store, tableId }: Fixture,
  documents: readonly StoreFields[],
  owner = "ada",
  start = 0
): Promise<void> => {
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    (_instance, state) => {
      for (const [offset, document] of documents.entries()) {
        const index = start + offset;
        state.storage.sql.exec(
          "INSERT INTO sdk_records (table_id, record_id, owner_id, revision, created_at, updated_at, value_json, schema_hash) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
          tableId,
          `n-${owner}-${String(index).padStart(5, "0")}`,
          owner,
          index,
          index,
          JSON.stringify(document),
          "a".repeat(64)
        );
      }
    }
  );
};

/** A read as hostile code could send it: the store checks it whole. */
const untypedRead = (request: unknown): ReadRequest =>
  // SAFETY: none, on purpose: the store must refuse what isn't valid.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately loose input
  request as ReadRequest;

/**
 * A page of notes by title from `store` for `readScope` after `cursor`,
 * with `changes` to the query that made the cursor.
 */
const pageAfter = async (
  { store }: Fixture,
  readScope: ReadScope,
  changes: Record<string, unknown>,
  cursor: string
): Promise<unknown> =>
  await store.read(
    readScope,
    untypedRead({
      kind: "query",
      query: {
        descriptorVersion: 1,
        table: "notes",
        index: "by_title",
        range: [],
        filter: null,
        order: "asc",
        terminal: { kind: "paginate", pageSize: 2, cursor },
        ...changes,
      },
    })
  );

/** What a read answered, or the code it was refused with. */
const outcome = async (read: Promise<unknown>): Promise<unknown> => {
  try {
    return await read;
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : error;
  }
};

/** Every page of `next`, from the first, and the records in order. */
const allPages = async <Item>(
  read: (cursor: string | null) => Promise<PaginationResult<Item>>
): Promise<{ items: Item[]; pages: PaginationResult<Item>[] }> => {
  const pages: PaginationResult<Item>[] = [];
  let cursor: string | null = null;
  do {
    // One page after the other: each starts where the last ended.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const answered: PaginationResult<Item> = await read(cursor);
    pages.push(answered);
    ({ nextCursor: cursor } = answered);
  } while (cursor !== null && pages.length < 200);
  return { items: pages.flatMap((page) => page.items), pages };
};

const idsOf = (notes: readonly { _id: string }[]): string[] =>
  notes.map(({ _id }) => _id);

/** Ranks with every state a field has: left out, null and values. */
const ranked: StoreFields[] = [
  { title: "a", done: false },
  { title: "b", done: false, rank: null },
  { title: "c", done: false, rank: 3 },
  { title: "d", done: false },
  { title: "e", done: false, rank: 1 },
  { title: "f", done: false, rank: null },
  { title: "g", done: false, rank: 3 },
  { title: "h", done: false, rank: 2 },
  { title: "i", done: true, rank: 1 },
  { title: "j", done: false },
];

/** A title too long for a cursor to carry. */
const long = (letter: string): string => letter.repeat(3500);

describe("pages", () => {
  it("add up to every record, in order, the last one without a cursor", async () => {
    const fixture = await storeWith("appMembers");
    await insertNotes(
      fixture,
      Array.from({ length: 25 }, (_, index) => ({ title: `t${index}` }))
    );
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    for (const order of ["asc", "desc"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one order at a time
      const { items, pages } = await allPages(
        async (cursor) =>
          await db
            .query("notes")
            .order(order)
            .paginate({ pageSize: 10, cursor })
      );
      // oxlint-disable-next-line no-await-in-loop -- one order at a time
      const whole = await db.query("notes").order(order).collect();
      expect({
        ids: idsOf(items),
        sizes: pages.map((page) => page.items.length),
        last: {
          nextCursor: pages.at(-1)?.nextCursor,
          hasMore: pages.at(-1)?.hasMore,
        },
      }).toStrictEqual({
        ids: idsOf(whole),
        sizes: [10, 10, 5],
        last: { nextCursor: null, hasMore: false },
      });
    }
  });

  it("add up along an index, through left-out and null values, both ways", async () => {
    const fixture = await storeWith("appMembers");
    await insertNotes(fixture, ranked);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const along = (order: "asc" | "desc") =>
      db
        .query("notes")
        .withIndex("by_done_rank", (range) => range.eq("done", false))
        .order(order);
    for (const order of ["asc", "desc"] as const) {
      for (const pageSize of [1, 2, 3]) {
        // oxlint-disable-next-line no-await-in-loop -- one case at a time
        const { items } = await allPages(
          async (cursor) => await along(order).paginate({ pageSize, cursor })
        );
        // oxlint-disable-next-line no-await-in-loop -- one case at a time
        expect(idsOf(items)).toStrictEqual(idsOf(await along(order).collect()));
      }
    }
    // The whole index too, its first field unbounded, with a filter.
    const { items } = await allPages(
      async (cursor) =>
        await db
          .query("notes")
          .withIndex("by_done_rank")
          .filter({ title: { neq: "c" } })
          .order("desc")
          .paginate({ pageSize: 2, cursor })
    );
    expect(idsOf(items)).toStrictEqual(
      idsOf(
        await db
          .query("notes")
          .withIndex("by_done_rank")
          .filter({ title: { neq: "c" } })
          .order("desc")
          .collect()
      )
    );
  });

  it(`go on past ${queryMaxScannedEntries} records, each page costing what it reads`, async () => {
    const fixture = await storeWith("appMembers");
    const count = queryMaxScannedEntries + 50;
    await insertNotes(
      fixture,
      Array.from({ length: count }, (_, index) => ({ title: `t${index}` }))
    );
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const { items, pages } = await allPages(
      async (cursor) =>
        await db.query("notes").paginate({ pageSize: 100, cursor })
    );
    expect({ count: items.length, pages: pages.length }).toStrictEqual({
      count,
      pages: 101,
    });
  });

  it("carry on after a record inserted between them, without repeating any", async () => {
    const fixture = await storeWith("appMembers");
    await insertNotes(
      fixture,
      Array.from({ length: 6 }, (_, index) => ({ title: `t${index}` }))
    );
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const first = await db
      .query("notes")
      .paginate({ pageSize: 3, cursor: null });
    await insertNotes(fixture, [{ title: "late" }], "ada", 100);
    const second = await db
      .query("notes")
      .paginate({ pageSize: 10, cursor: first.nextCursor });
    expect([...idsOf(first.items), ...idsOf(second.items)]).toStrictEqual([
      "n-ada-00000",
      "n-ada-00001",
      "n-ada-00002",
      "n-ada-00003",
      "n-ada-00004",
      "n-ada-00005",
      "n-ada-00100",
    ]);
  });
});

describe("cursors", () => {
  it("hold no more than the last record's ID and order values, within 4 KiB", async () => {
    const fixture = await storeWith("appMembers");
    await insertNotes(fixture, ranked);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const page = await db
      .query("notes")
      .withIndex("by_done_rank", (range) => range.eq("done", false))
      .paginate({ pageSize: 2, cursor: null });
    const [, payload = ""] = (page.nextCursor ?? "").split(".");
    const content: unknown = JSON.parse(
      new TextDecoder().decode(fromBase64Url(payload))
    );
    expect({
      content,
      fits: (page.nextCursor ?? "").length <= cursorMaxLength,
    }).toStrictEqual({
      content: { id: page.items.at(-1)?._id, values: [[]] },
      fits: true,
    });
  });

  it("are refused when forged, edited, or carried to another query, caller or store", async () => {
    const fixture = await storeWith("owner");
    const other = await storeWith("owner");
    await insertNotes(fixture, ranked);
    await insertNotes(fixture, ranked, "grace");
    const scope = scopeOf(fixture.schemaHash);
    const first = await dbOf(fixture, scope)
      .query("notes")
      .withIndex("by_title")
      .paginate({ pageSize: 2, cursor: null });
    const cursor = first.nextCursor ?? "";
    const [version, payload = "", mac = ""] = cursor.split(".");
    const edited = `${version}.${payload.slice(0, -2)}AA.${mac}`;
    expect({
      same: await outcome(
        pageAfter(fixture, scope, {}, cursor).then(() => "read")
      ),
      forged: await outcome(
        pageAfter(fixture, scope, {}, `1.e30.${"A".repeat(43)}`)
      ),
      edited: await outcome(pageAfter(fixture, scope, {}, edited)),
      otherOrder: await outcome(
        pageAfter(fixture, scope, { order: "desc" }, cursor)
      ),
      otherIndex: await outcome(
        pageAfter(fixture, scope, { index: "by_done_rank" }, cursor)
      ),
      otherFilter: await outcome(
        pageAfter(
          fixture,
          scope,
          { filter: { field: "title", op: "neq", value: "x" } },
          cursor
        )
      ),
      otherPerson: await outcome(
        pageAfter(
          fixture,
          scopeOf(fixture.schemaHash, { principal: "grace" }),
          {},
          cursor
        )
      ),
      otherRole: await outcome(
        pageAfter(
          fixture,
          scopeOf(fixture.schemaHash, { appBuilder: true }),
          {},
          cursor
        )
      ),
      otherVersion: await outcome(
        pageAfter(
          fixture,
          scopeOf(fixture.schemaHash, {
            consumer: { resourceId: "notes-app", resourceVersion: 2 },
          }),
          {},
          cursor
        )
      ),
      otherStore: await outcome(
        pageAfter(other, scopeOf(other.schemaHash), {}, cursor)
      ),
      laterFormat: await outcome(
        pageAfter(fixture, scope, {}, `2.${payload}.${mac}`)
      ),
    }).toStrictEqual({
      same: "read",
      forged: "data.invalid_cursor",
      edited: "data.invalid_cursor",
      otherOrder: "data.invalid_cursor",
      otherIndex: "data.invalid_cursor",
      otherFilter: "data.invalid_cursor",
      otherPerson: "data.invalid_cursor",
      otherRole: "data.invalid_cursor",
      otherVersion: "data.invalid_cursor",
      otherStore: "data.invalid_cursor",
      laterFormat: "data.cursor_expired",
    });
  });

  it("carry only the ID when the values wouldn't fit, and expire with that record", async () => {
    const fixture = await storeWith("appMembers");
    await insertNotes(fixture, [
      { title: long("a") },
      { title: long("b") },
      { title: long("c") },
    ]);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const byTitle = () => db.query("notes").withIndex("by_title");
    const first = await byTitle().paginate({ pageSize: 1, cursor: null });
    const cursor = first.nextCursor ?? "";
    const [, payload = ""] = cursor.split(".");
    const content: unknown = JSON.parse(
      new TextDecoder().decode(fromBase64Url(payload))
    );
    const second = await byTitle().paginate({ pageSize: 1, cursor });
    // The anchor record goes: a cursor of its ID alone no longer applies.
    await runInDurableObject(
      env.DATA_STORES.getByName(fixture.store.id),
      (_instance, state) => {
        state.storage.sql.exec(
          "DELETE FROM sdk_records WHERE record_id = ?",
          first.items[0]?._id ?? ""
        );
      }
    );
    expect({
      fits: cursor.length <= cursorMaxLength,
      content,
      second: idsOf(second.items),
      gone: await outcome(byTitle().paginate({ pageSize: 1, cursor })),
    }).toStrictEqual({
      fits: true,
      content: { id: first.items[0]?._id },
      second: ["n-ada-00001"],
      gone: "data.cursor_expired",
    });
  });
});
