import { defineSchema, defineTable, v } from "@grasp-os/runtime/app";
import {
  databaseReader,
  manifestText,
  schemaManifest,
} from "@grasp-os/runtime/host";
import type { AccessMode } from "@grasp-os/runtime/host";
import type { PaginationResult } from "@grasp-os/runtime/server";
import { fromBase64Url, toBase64Url } from "@grasp-os/shared/encoding";
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
import { z } from "zod";

import type { Acting } from "../src/auth/identity.ts";
import { openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { StoreHost } from "../src/store-host.ts";
import type { AnchorValue } from "../src/store-queries.ts";
import { storeOfNewApp } from "./app-stores.ts";
import { tiledPage } from "./split-pages.ts";
import { accessedManifest, appliedTables } from "./store-schemas.ts";

// Pages of a business store's records and their cursors (store-cursors.ts,
// store-queries.ts `readPage`), through core's way into a store and its
// Durable Object, built by `ctx.db` as App code builds them. The cases
// follow the cursor's threat model: pages that add up to the whole, along
// any index and order, whatever is left out or null; deep pages that cost
// what they read; cursors that hold only what the page answered, are
// refused for another query and expire with their generation; and forged
// or carried cursors that still read only what their reader may.

/** What a read answered, without the generations it depended on. */
const valueOf = async (
  store: OpenStore,
  scope: ReadScope,
  request: ReadRequest
): Promise<unknown> => {
  const { value } = await store.read(scope, request);
  return value;
};

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
    label: v.string().nullable().optional(),
  })
    .index("by_title", ["title"])
    .index("by_done_rank", ["done", "rank"])
    .index("by_label", ["label"]),
  people: defineTable({ name: v.string() }),
});

interface Fixture {
  store: OpenStore;
  schemaHash: string;
  tableId: string;
}

const storeWith = async (read: AccessMode): Promise<Fixture> => {
  const store = await openStore(env, await storeOfNewApp(env, builder));
  const defined = await appliedTables(
    store,
    manifestText(
      accessedManifest(schema, {
        tables: {
          notes: { read, write: read },
          people: { read, write: read },
        },
      })
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
    async (request) => await valueOf(fixture.store, scope, request)
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
  await valueOf(
    store,
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
        terminal: { kind: "paginate", pageSize: 2, cursor, endCursor: null },
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

  it("go through 1,200 records along an index, in its order, 100 at a time", async () => {
    const fixture = await storeWith("appMembers");
    const count = 1200;
    // Titles in no order of creation: the index, not insertion, orders them.
    const titles = Array.from(
      { length: count },
      (_, index) => `t${String((index * 7919) % count).padStart(5, "0")}`
    );
    await insertNotes(
      fixture,
      titles.map((title) => ({ title }))
    );
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    for (const order of ["asc", "desc"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one order at a time
      const { items, pages } = await allPages(
        async (cursor) =>
          await db
            .query("notes")
            .withIndex("by_title")
            .order(order)
            .paginate({ pageSize: 100, cursor })
      );
      const sorted = titles.toSorted();
      expect({
        titles: items.map(({ title }) => title),
        pages: pages.length,
      }).toStrictEqual({
        titles: order === "asc" ? sorted : sorted.toReversed(),
        pages: count / 100,
      });
    }
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

/** Field `field` of what a read answered, or undefined. */
const fieldOf = (answer: unknown, field: string): unknown =>
  typeof answer === "object" && answer !== null && !Array.isArray(answer)
    ? Object.getOwnPropertyDescriptor(answer, field)?.value
    : undefined;

/** The record IDs a page answered, or what it was refused with. */
const pageIds = (answer: unknown): unknown => {
  const items = fieldOf(answer, "items");
  return Array.isArray(items)
    ? items.map((item: unknown) => fieldOf(item, "_id"))
    : answer;
};

/** What `cursor` holds, as anyone holding it can read it. */
const decoded = (cursor: string): Record<string, unknown> =>
  z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(new TextDecoder().decode(fromBase64Url(cursor))));

/** `cursor` with `changes` to what it holds, as a caller could make it. */
const edited = (cursor: string, changes: Record<string, unknown>): string =>
  toBase64Url(
    new TextEncoder().encode(JSON.stringify({ ...decoded(cursor), ...changes }))
  );

/** A page request by `index` in `order`, as the store reads it. */
const pageQuery = (index: string | null, order: "asc" | "desc") => ({
  descriptorVersion: 1 as const,
  table: "notes",
  index,
  range: [],
  filter: null,
  order,
  terminal: {
    kind: "paginate" as const,
    pageSize: 2,
    cursor: null,
    endCursor: null,
  },
});

/** The length of the cursor an anchor of a `length`-character label makes. */
const cursorLength = (length: number): number => {
  const plain = JSON.stringify({
    query: "0".repeat(16),
    generation: "0".repeat(16),
    id: "n-ada-00000",
    values: [["x".repeat(length)]],
  }).length;
  // Unpadded base64url.
  return Math.ceil((4 * plain) / 3);
};

const shortHash = /^[0-9a-f]{16}$/u;

/** The record IDs of `notes`, sorted: for pages whose order ties. */
const sortedIds = (notes: readonly { _id: string }[]): string[] =>
  idsOf(notes).toSorted();

describe("cursors", () => {
  it("hold only the last record's ID and order values, which the page answered", async () => {
    const fixture = await storeWith("appMembers");
    await insertNotes(fixture, ranked);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const page = await db
      .query("notes")
      .withIndex("by_title")
      .paginate({ pageSize: 3, cursor: null });
    const last = page.items.at(-1);
    const { query, generation, ...anchor } = decoded(page.nextCursor ?? "");
    expect({
      anchor,
      hashes: [query, generation].every(
        (hash) => typeof hash === "string" && shortHash.test(hash)
      ),
    }).toStrictEqual({
      anchor: { id: last?._id, values: [[last?.title]] },
      hashes: true,
    });
  });

  it("are refused when malformed or carried to another query, and expire with their generation", async () => {
    const fixture = await storeWith("owner");
    await insertNotes(fixture, ranked);
    // Another schema of the same store, one optional field more: another
    // generation of its tables, applied last (below).
    const laterText = manifestText(
      schemaManifest(
        defineSchema({
          notes: defineTable({
            title: v.string(),
            rank: v.number().nullable().optional(),
            done: v.boolean().default(false),
            label: v.string().nullable().optional(),
            note: v.string().optional(),
          })
            .index("by_title", ["title"])
            .index("by_done_rank", ["done", "rank"])
            .index("by_label", ["label"])
            .access({ read: "owner", write: "owner" }),
          people: defineTable({ name: v.string() }).access({
            read: "owner",
            write: "owner",
          }),
        })
      )
    );
    const scope = scopeOf(fixture.schemaHash);
    const first = await dbOf(fixture, scope)
      .query("notes")
      .withIndex("by_title")
      .paginate({ pageSize: 2, cursor: null });
    const cursor = first.nextCursor ?? "";
    const after = async (
      changes: Record<string, unknown>,
      text: string,
      readScope = scope
    ): Promise<unknown> =>
      pageIds(await outcome(pageAfter(fixture, readScope, changes, text)));
    expect({
      same: await after({}, cursor),
      notBase64: await after({}, "not a cursor!"),
      notJson: await after({}, toBase64Url(new TextEncoder().encode("{"))),
      empty: await after({}, toBase64Url(new TextEncoder().encode("{}"))),
      extraKey: await after({}, edited(cursor, { owner: "grace" })),
      badValue: await after({}, edited(cursor, { values: [[{ a: 1 }]] })),
      editedQuery: await after({}, edited(cursor, { query: "0".repeat(16) })),
      editedGeneration: await after(
        {},
        edited(cursor, { generation: "0".repeat(16) })
      ),
      otherOrder: await after({ order: "desc" }, cursor),
      otherIndex: await after({ index: "by_done_rank" }, cursor),
      otherRange: await after(
        { range: [{ field: "title", op: "gt", value: "a" }] },
        cursor
      ),
      otherTable: await after({ table: "people", index: null }, cursor),
      otherFilter: await after(
        { filter: { field: "title", op: "neq", value: "x" } },
        cursor
      ),
      otherVersion: await after(
        {},
        cursor,
        scopeOf(fixture.schemaHash, {
          consumer: { resourceId: "notes-app", resourceVersion: 2 },
        })
      ),
      // Last: the store's schema moves on, and the cursor with it.
      otherSchema: await appliedTables(fixture.store, laterText).then(
        async ({ schemaHash }) => await after({}, cursor, scopeOf(schemaHash))
      ),
    }).toStrictEqual({
      same: ["n-ada-00002", "n-ada-00003"],
      notBase64: "data.invalid_cursor",
      notJson: "data.invalid_cursor",
      empty: "data.invalid_cursor",
      extraKey: "data.invalid_cursor",
      badValue: "data.invalid_cursor",
      editedQuery: "data.invalid_cursor",
      // Its holder only makes it expire sooner.
      editedGeneration: "data.cursor_expired",
      otherOrder: "data.invalid_cursor",
      otherIndex: "data.invalid_cursor",
      otherRange: "data.invalid_cursor",
      otherTable: "data.invalid_cursor",
      otherFilter: "data.invalid_cursor",
      otherVersion: "data.cursor_expired",
      otherSchema: "data.cursor_expired",
    });
  });

  it("forged or carried to another person, read only the reader's own records", async () => {
    const fixture = await storeWith("owner");
    await insertNotes(fixture, ranked);
    await insertNotes(fixture, ranked, "grace");
    const ada = scopeOf(fixture.schemaHash);
    const grace = scopeOf(fixture.schemaHash, { principal: "grace" });
    const first = await dbOf(fixture, ada)
      .query("notes")
      .withIndex("by_title")
      .paginate({ pageSize: 2, cursor: null });
    const cursor = first.nextCursor ?? "";
    const after = async (text: string, readScope = ada): Promise<unknown> =>
      pageIds(await outcome(pageAfter(fixture, readScope, {}, text)));
    expect({
      // Grace pages on from where Ada's page ended, through her own.
      carried: await after(cursor, grace),
      // An anchor of the caller's choosing seeks there, and no further
      // than an index range of their own would.
      fromStart: await after(edited(cursor, { values: [[""]] })),
      pastEnd: await after(edited(cursor, { values: [["z"]] })),
      // An ID alone is looked up under the caller's access: another
      // person's record is as missing as one that never was.
      othersRecord: await after(
        edited(cursor, { id: "n-grace-00001", values: undefined })
      ),
      missingRecord: await after(
        edited(cursor, { id: "n-ada-99999", values: undefined })
      ),
      ownRecord: await after(
        edited(cursor, { id: "n-ada-00001", values: undefined })
      ),
    }).toStrictEqual({
      // After Ada's "b": Grace's "b" sorts after it by ID.
      carried: ["n-grace-00001", "n-grace-00002"],
      fromStart: ["n-ada-00000", "n-ada-00001"],
      pastEnd: [],
      othersRecord: "data.cursor_expired",
      missingRecord: "data.cursor_expired",
      ownRecord: ["n-ada-00002", "n-ada-00003"],
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
      second: idsOf(second.items),
      gone: await outcome(byTitle().paginate({ pageSize: 1, cursor })),
    }).toStrictEqual({
      fits: true,
      second: ["n-ada-00001"],
      gone: "data.cursor_expired",
    });
  });
});

describe("pages ended at a cursor", () => {
  it("tile the query as records move in and out, along an index with left-out and null values, both ways", async () => {
    const fixture = await storeWith("appMembers");
    await insertNotes(fixture, ranked);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const along = (order: "asc" | "desc") =>
      db.query("notes").withIndex("by_done_rank").order(order);
    const loaded = {
      asc: await allPages(
        async (cursor) => await along("asc").paginate({ pageSize: 3, cursor })
      ),
      desc: await allPages(
        async (cursor) => await along("desc").paginate({ pageSize: 3, cursor })
      ),
    };
    // Records move in and out of the loaded pages: some inserted, with
    // every state of the field, and two deleted, one each page's anchor.
    await insertNotes(
      fixture,
      [
        { title: "k", done: false },
        { title: "l", done: false, rank: null },
        { title: "m", done: false, rank: 2 },
        { title: "n", done: true, rank: 0 },
      ],
      "ada",
      100
    );
    const anchors = loaded.asc.pages
      .slice(0, 2)
      .map((page) => page.items.at(-1)?._id ?? "");
    await runInDurableObject(
      env.DATA_STORES.getByName(fixture.store.id),
      (_instance, state) => {
        for (const id of anchors) {
          state.storage.sql.exec(
            "DELETE FROM sdk_records WHERE record_id = ?",
            id
          );
        }
      }
    );
    for (const order of ["asc", "desc"] as const) {
      const cursors = loaded[order].pages.map((page) => page.nextCursor);
      // Each page from where the one before ended to its own end, however
      // small its size; the last up to its size, as a live list's is.
      // oxlint-disable-next-line no-await-in-loop -- one order at a time
      const pages = await Promise.all(
        cursors.map(
          async (endCursor, page) =>
            await along(order).paginate({
              pageSize: 1,
              cursor: cursors[page - 1] ?? null,
              endCursor,
            })
        )
      );
      // oxlint-disable-next-line no-await-in-loop -- one order at a time
      const whole = await along(order).collect();
      expect({
        ids: idsOf(pages.flatMap((page) => page.items)),
        ends: pages.slice(0, -1).map((page) => page.nextCursor),
      }).toStrictEqual({
        ids: idsOf(whole).slice(0, pages.flatMap((page) => page.items).length),
        ends: cursors.slice(0, -1),
      });
    }
  });

  it("hold only the caller's own records of an owner-only table, another owner's interleaved", async () => {
    const fixture = await storeWith("owner");
    const notes = Array.from({ length: 9 }, (_, index) => ({
      title: `t${index}`,
      done: false,
      rank: index % 3,
    }));
    await insertNotes(fixture, notes, "ada");
    await insertNotes(fixture, notes, "grace", 1000);
    const ada = dbOf(fixture, scopeOf(fixture.schemaHash));
    const grace = dbOf(
      fixture,
      scopeOf(fixture.schemaHash, { principal: "grace" })
    );
    const first = await ada
      .query("notes")
      .withIndex("by_done_rank")
      .paginate({ pageSize: 4, cursor: null });
    const end = first.nextCursor ?? "";
    // Grace holding Ada's end cursor still reads only her own records.
    const theirs = await grace
      .query("notes")
      .withIndex("by_done_rank")
      .paginate({ pageSize: 1, endCursor: end });
    const mine = await ada
      .query("notes")
      .withIndex("by_done_rank")
      .paginate({ pageSize: 1, endCursor: end });
    expect({
      mine: idsOf(mine.items),
      theirs: [...new Set(theirs.items.map(({ _ownerId }) => _ownerId))],
    }).toStrictEqual({ mine: idsOf(first.items), theirs: ["grace"] });
  });

  it("expire with an end of its ID alone once that record went", async () => {
    const fixture = await storeWith("appMembers");
    await insertNotes(fixture, [
      { title: long("a") },
      { title: long("b") },
      { title: long("c") },
    ]);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const byTitle = () => db.query("notes").withIndex("by_title");
    const first = await byTitle().paginate({ pageSize: 2, cursor: null });
    const endCursor = first.nextCursor ?? "";
    const ended = await byTitle().paginate({ pageSize: 1, endCursor });
    await runInDurableObject(
      env.DATA_STORES.getByName(fixture.store.id),
      (_instance, state) => {
        state.storage.sql.exec(
          "DELETE FROM sdk_records WHERE record_id = ?",
          first.items.at(-1)?._id ?? ""
        );
      }
    );
    expect({
      values: Object.keys(decoded(endCursor)).includes("values"),
      ended: idsOf(ended.items),
      gone: await outcome(byTitle().paginate({ pageSize: 1, endCursor })),
    }).toStrictEqual({
      values: false,
      ended: idsOf(first.items),
      gone: "data.cursor_expired",
    });
  });

  it("say where to split them once past twice their size, after their first records", async () => {
    const fixture = await storeWith("appMembers");
    await insertNotes(
      fixture,
      Array.from({ length: 6 }, (_, index) => ({ title: `b${index}` }))
    );
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const byTitle = () => db.query("notes").withIndex("by_title");
    const first = await byTitle().paginate({ pageSize: 2 });
    const end = first.nextCursor ?? "";
    const within = await byTitle().paginate({ pageSize: 2, endCursor: end });
    // Records that sort first move into the page: it holds eight.
    await insertNotes(
      fixture,
      Array.from({ length: 6 }, (_, index) => ({ title: `a${index}` })),
      "ada",
      100
    );
    const grown = await byTitle().paginate({ pageSize: 2, endCursor: end });
    const fresh = await byTitle().paginate({ pageSize: 2 });
    expect({
      within: "splitCursor" in within,
      grown: grown.items.length,
      // Where a page of its size from its start ends now.
      split: grown.splitCursor,
    }).toStrictEqual({ within: false, grown: 8, split: fresh.nextCursor });
  });

  it("say where to split them once their records pass half an answer, however few", async () => {
    const fixture = await storeWith("appMembers");
    // Four records of 60 KB: within twice a page of three, but past half
    // of what one answer may carry.
    await insertNotes(fixture, [
      ...["a", "b", "c", "d"].map((letter) => ({
        title: letter.repeat(60_000),
      })),
      { title: "e" },
    ]);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const byTitle = () => db.query("notes").withIndex("by_title");
    const whole = await byTitle().paginate({ pageSize: 4 });
    const grown = await byTitle().paginate({
      pageSize: 3,
      endCursor: whole.nextCursor ?? "",
    });
    const half = await byTitle().paginate({ pageSize: 2 });
    expect({
      grown: grown.items.length,
      // After the records within the first half of their bytes.
      split: grown.splitCursor,
      // Answered whole while it fits one answer, and split where half of
      // its bytes end.
    }).toStrictEqual({ grown: 4, split: half.nextCursor });
  });

  it("stop at their end before any filter, never scanning on past it", async () => {
    const fixture = await storeWith("appMembers");
    await insertNotes(fixture, [
      { title: "a0", done: true },
      { title: "a1", done: true },
      { title: "a2", done: true },
    ]);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const doneByTitle = () =>
      db.query("notes").withIndex("by_title").filter({ done: true });
    const first = await doneByTitle().paginate({ pageSize: 2 });
    // Between its end and the next record it matches, more records than
    // one read may examine, none of them passing the filter.
    await insertNotes(
      fixture,
      Array.from({ length: queryMaxScannedEntries + 1 }, (_, index) => ({
        title: `a1-${String(index).padStart(6, "0")}`,
        done: false,
      })),
      "ada",
      100
    );
    const ended = await outcome(
      doneByTitle().paginate({
        pageSize: 1,
        endCursor: first.nextCursor ?? "",
      })
    );
    expect(pageIds(ended)).toStrictEqual(idsOf(first.items));
  });

  it("say where to split them once they grow past what one read may examine, never failing", async () => {
    const fixture = await storeWith("appMembers");
    await insertNotes(fixture, [
      { title: "a" },
      { title: "z" },
      { title: "zz" },
    ]);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const byTitle = () => db.query("notes").withIndex("by_title");
    const first = await byTitle().paginate({ pageSize: 2 });
    const end = first.nextCursor ?? "";
    // A bulk import lands inside the page: more records than one read may
    // examine between its start and its end.
    await insertNotes(
      fixture,
      Array.from({ length: queryMaxScannedEntries + 1 }, (_, index) => ({
        title: `m${String(index).padStart(6, "0")}`,
      })),
      "ada",
      100
    );
    // Split as a live list splits it, each half in turn. Large enough a
    // page that only the scan and answer bounds split it.
    const tiled = await tiledPage(
      async (from, until) =>
        await byTitle().paginate({
          pageSize: 5000,
          cursor: from,
          endCursor: until,
        }),
      null,
      end
    );
    const titles = tiled.items.map(({ title }) => title);
    expect({
      split: tiled.reads > 1,
      count: titles.length,
      first: titles[0],
      last: titles.at(-1),
      unique: new Set(titles).size,
    }).toStrictEqual({
      split: true,
      count: queryMaxScannedEntries + 3,
      first: "a",
      last: "z",
      unique: queryMaxScannedEntries + 3,
    });
  });

  it("say where to split them once a filter skips more than one read may examine, after the last record read", async () => {
    const fixture = await storeWith("appMembers");
    await insertNotes(fixture, [
      { title: "a", done: true },
      { title: "z", done: true },
      { title: "zz", done: true },
    ]);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const doneByTitle = () =>
      db.query("notes").withIndex("by_title").filter({ done: true });
    const first = await doneByTitle().paginate({ pageSize: 2 });
    // Inside the page, more records than one read may examine, all but
    // three of which the filter skips: a read stops at the scan bound
    // having matched few, if any.
    const stride = 5000;
    await insertNotes(
      fixture,
      Array.from({ length: queryMaxScannedEntries + 1 }, (_, index) => ({
        title: `m${String(index).padStart(6, "0")}`,
        done: index % stride === 0,
      })),
      "ada",
      100
    );
    const tiled = await tiledPage(
      async (from, until) =>
        await doneByTitle().paginate({
          pageSize: 5000,
          cursor: from,
          endCursor: until,
        }),
      null,
      first.nextCursor ?? ""
    );
    expect({
      split: tiled.reads > 1,
      titles: tiled.items.map(({ title }) => title),
    }).toStrictEqual({
      split: true,
      titles: ["a", "m000000", "m005000", "m010000", "z"],
    });
  });

  it("expire with an end of its ID alone whose record moved to or before their start", async () => {
    const fixture = await storeWith("appMembers");
    await insertNotes(fixture, [
      { title: long("a") },
      { title: long("b") },
      { title: long("c") },
    ]);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const byTitle = () => db.query("notes").withIndex("by_title");
    const first = await byTitle().paginate({ pageSize: 1, cursor: null });
    const start = first.nextCursor ?? "";
    const second = await byTitle().paginate({ pageSize: 1, cursor: start });
    const end = second.nextCursor ?? "";
    // The record the second page ends at is retitled to sort first.
    await runInDurableObject(
      env.DATA_STORES.getByName(fixture.store.id),
      (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE sdk_records SET value_json = json_set(value_json, '$.title', ?) WHERE record_id = ?",
          long("0"),
          second.items[0]?._id ?? ""
        );
      }
    );
    await expect(
      outcome(
        byTitle().paginate({ pageSize: 1, cursor: start, endCursor: end })
      )
    ).resolves.toBe("data.cursor_expired");
  });

  it("order text by its code points, as SQLite does, past the Basic Multilingual Plane", async () => {
    const fixture = await storeWith("appMembers");
    // UTF-16 puts a surrogate pair (U+1F600) before U+FF21; code points,
    // and SQLite's bytes, put it after. Accents and other scripts too.
    const titles = ["a", "é", "z", "Ａ", "😀", "日本", "ß", "Z"];
    await insertNotes(
      fixture,
      titles.map((title) => ({ title }))
    );
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const byTitle = () => db.query("notes").withIndex("by_title");
    for (const order of ["asc", "desc"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one order at a time
      const whole = await byTitle().order(order).collect();
      // oxlint-disable-next-line no-await-in-loop -- one order at a time
      const { pages } = await allPages(
        async (cursor) =>
          await byTitle().order(order).paginate({ pageSize: 1, cursor })
      );
      const cursors = pages.map((page) => page.nextCursor);
      // Each page ended where the next starts holds exactly its records.
      // oxlint-disable-next-line no-await-in-loop -- one order at a time
      const ended = await Promise.all(
        cursors.slice(0, -1).map(
          async (endCursor, page) =>
            await byTitle()
              .order(order)
              .paginate({
                pageSize: 1,
                cursor: cursors[page - 1] ?? null,
                endCursor,
              })
        )
      );
      expect({
        titles: whole.map(({ title }) => title),
        ended: ended.map((page) => page.items.map(({ title }) => title)),
      }).toStrictEqual({
        titles:
          order === "asc"
            ? ["Z", "a", "z", "ß", "é", "日本", "Ａ", "😀"]
            : ["😀", "Ａ", "日本", "é", "ß", "z", "a", "Z"],
        ended: pages
          .slice(0, -1)
          .map((page) => page.items.map(({ title }) => title)),
      });
    }
  });
});

describe("pages of owner-only tables", () => {
  it("add up to the caller's own records, another owner's interleaved, both ways", async () => {
    const fixture = await storeWith("owner");
    const notes = Array.from({ length: 9 }, (_, index) => ({
      title: `t${index}`,
      done: false,
      rank: index % 3,
    }));
    // Interleaved: each of Ada's notes beside one of Grace's, in one index.
    await insertNotes(fixture, notes, "ada");
    await insertNotes(fixture, notes, "grace", 1000);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const along = (order: "asc" | "desc") =>
      db.query("notes").withIndex("by_done_rank").order(order);
    for (const order of ["asc", "desc"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one order at a time
      const { items } = await allPages(
        async (cursor) => await along(order).paginate({ pageSize: 2, cursor })
      );
      // oxlint-disable-next-line no-await-in-loop -- one order at a time
      const whole = await along(order).collect();
      expect({
        ids: idsOf(items),
        owners: [...new Set(items.map(({ _ownerId }) => _ownerId))],
      }).toStrictEqual({ ids: idsOf(whole), owners: ["ada"] });
    }
  });

  it("page descending through long, null and left-out values, the long ones by ID", async () => {
    const fixture = await storeWith("owner");
    const labelled: StoreFields[] = [
      { title: "a", label: long("x") },
      { title: "b", label: long("y") },
      { title: "c", label: null },
      { title: "d" },
      { title: "e", label: long("z") },
      { title: "f", label: null },
      { title: "g" },
    ];
    await insertNotes(fixture, labelled, "ada");
    await insertNotes(fixture, labelled, "grace", 1000);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const byLabel = () => db.query("notes").withIndex("by_label").order("desc");
    const { items, pages } = await allPages(
      async (cursor) => await byLabel().paginate({ pageSize: 1, cursor })
    );
    expect({
      ids: idsOf(items),
      pages: pages.length,
    }).toStrictEqual({
      ids: idsOf(await byLabel().collect()),
      pages: 7,
    });
  });
});

describe("seeks", () => {
  it("each read an index range: never a scan, never a sort", async () => {
    const fixture = await storeWith("appMembers");
    const scope = scopeOf(fixture.schemaHash);
    const cases: {
      query: ReturnType<typeof pageQuery>;
      values: AnchorValue[];
    }[] = [
      { query: pageQuery("by_done_rank", "asc"), values: [[0], []] },
      { query: pageQuery("by_done_rank", "asc"), values: [[0], [null]] },
      { query: pageQuery("by_done_rank", "asc"), values: [[1], [3]] },
      { query: pageQuery("by_done_rank", "desc"), values: [[0], [3]] },
      { query: pageQuery("by_done_rank", "desc"), values: [[0], [null]] },
      { query: pageQuery("by_label", "asc"), values: [[]] },
      { query: pageQuery(null, "desc"), values: [[5]] },
    ];
    const plans = await runInDurableObject(
      env.DATA_STORES.getByName(fixture.store.id),
      async (_instance, state) => {
        const host = new StoreHost(state, env);
        const found: string[][] = [];
        for (const { query: request, values } of cases) {
          // oxlint-disable-next-line no-await-in-loop -- one case at a time
          const seekPlans = await host.explainPage(
            fixture.store.id,
            scope,
            request,
            {
              id: "n-ada-00001",
              values,
            }
          );
          found.push(seekPlans);
        }
        return found;
      }
    );
    for (const plan of plans.flat()) {
      expect(plan).toMatch(/SEARCH sdk_records USING (?:COVERING )?INDEX/u);
      expect(plan).not.toMatch(/TEMP B-TREE|\bSCAN sdk_records\b/u);
    }
    // After a left-out value, the seek past it is a range on that field,
    // a constraint of the index search: never a walk filtered after.
    expect({
      afterLeftOutRank: /\(<expr>=\? AND <expr>>\?\)/u.test(
        plans[0]?.[1] ?? ""
      ),
      afterLeftOutLabel: /\(<expr>>\?\)/u.test(plans[5]?.[1] ?? ""),
    }).toStrictEqual({ afterLeftOutRank: true, afterLeftOutLabel: true });
  });

  it("issue a cursor of exactly the longest length, and fall back to the ID one past it", async () => {
    let longest = 0;
    while (cursorLength(longest + 1) <= cursorMaxLength) {
      longest += 1;
    }
    const results: Record<string, { length?: number; next: string[] }> = {};
    for (const [name, length] of [
      ["longest", longest],
      ["past", longest + 1],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      const fixture = await storeWith("appMembers");
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      await insertNotes(fixture, [
        { title: "a", label: "x".repeat(length) },
        { title: "b", label: "y" },
      ]);
      const byLabel = () =>
        dbOf(fixture, scopeOf(fixture.schemaHash))
          .query("notes")
          .withIndex("by_label");
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      const first = await byLabel().paginate({ pageSize: 1, cursor: null });
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      const second = await byLabel().paginate({
        pageSize: 1,
        cursor: first.nextCursor,
      });
      results[name] = {
        length: first.nextCursor?.length,
        next: idsOf(second.items),
      };
    }
    // Past the longest, the cursor holds the ID alone: far shorter.
    expect({
      longest: results.longest,
      pastNext: results.past?.next,
      pastShort:
        (results.past?.length ?? cursorMaxLength) < cursorMaxLength - 2000,
    }).toStrictEqual({
      longest: { length: cursorMaxLength, next: ["n-ada-00001"] },
      pastNext: ["n-ada-00001"],
      pastShort: true,
    });
  });

  it("count against one scan bound across all of a page's seeks", async () => {
    const fixture = await storeWith("appMembers");
    const many = queryMaxScannedEntries / 2 + 500;
    // Two hits first; after them, past the bound across two seeks.
    await insertNotes(fixture, [
      { title: "hit", done: false, rank: 5 },
      { title: "hit", done: false, rank: 5 },
    ]);
    await insertNotes(
      fixture,
      Array.from({ length: many }, () => ({
        title: "miss",
        done: false,
        rank: 5,
      })),
      "ada",
      10
    );
    await insertNotes(
      fixture,
      Array.from({ length: many }, () => ({
        title: "miss",
        done: false,
        rank: 7,
      })),
      "ada",
      100_000
    );
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const hits = () =>
      db.query("notes").withIndex("by_done_rank").filter({ title: "hit" });
    const first = await hits().paginate({ pageSize: 1, cursor: null });
    expect({
      first: idsOf(first.items),
      next: await outcome(
        hits().paginate({ pageSize: 1, cursor: first.nextCursor })
      ),
    }).toStrictEqual({ first: ["n-ada-00000"], next: "data.scan_limit" });
  });

  it("carry on from a full anchor whose record changed or went between pages", async () => {
    const fixture = await storeWith("appMembers");
    await insertNotes(
      fixture,
      Array.from({ length: 6 }, (_, index) => ({
        title: `t${index}`,
        done: false,
        rank: index,
      }))
    );
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const byRank = () => db.query("notes").withIndex("by_done_rank");
    const first = await byRank().paginate({ pageSize: 2, cursor: null });
    const anchor = first.items.at(-1)?._id ?? "";
    // The anchor record moves to the end, and the next record goes.
    await runInDurableObject(
      env.DATA_STORES.getByName(fixture.store.id),
      (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE sdk_records SET value_json = ? WHERE record_id = ?",
          JSON.stringify({ title: "moved", done: false, rank: 99 }),
          anchor
        );
        state.storage.sql.exec(
          "DELETE FROM sdk_records WHERE record_id = 'n-ada-00002'"
        );
      }
    );
    const rest = await allPages(
      async (cursor) =>
        await byRank().paginate({
          pageSize: 2,
          cursor: cursor ?? first.nextCursor,
        })
    );
    expect(sortedIds(rest.items)).toStrictEqual([
      "n-ada-00001",
      "n-ada-00003",
      "n-ada-00004",
      "n-ada-00005",
    ]);
  });
});
