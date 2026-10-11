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
import { createStore, deleteStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { StoreHost } from "../src/store-host.ts";
import type { AnchorValue } from "../src/store-queries.ts";

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
  const store = await openStore(env, await createStore(env, builder));
  const defined = await store.defineTables(
    manifestText(
      schemaManifest(schema, {
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

/** Field `field` of what a read answered, or undefined. */
const fieldOf = (answer: unknown, field: string): unknown =>
  typeof answer === "object" && answer !== null && !Array.isArray(answer)
    ? Object.getOwnPropertyDescriptor(answer, field)?.value
    : undefined;

/** `part` with its last character changed. */
const flip = (part: string): string =>
  `${part.slice(0, -1)}${part.endsWith("A") ? "B" : "A"}`;

/** A page request by `index` in `order`, as the store reads it. */
const pageQuery = (index: string | null, order: "asc" | "desc") => ({
  descriptorVersion: 1 as const,
  table: "notes",
  index,
  range: [],
  filter: null,
  order,
  terminal: { kind: "paginate" as const, pageSize: 2, cursor: null },
});

/** The length of the cursor an anchor of a `length`-character label seals to. */
const cursorLength = (length: number): number => {
  const plain = JSON.stringify({
    id: "n-ada-00000",
    values: [["x".repeat(length)]],
  }).length;
  // IV, ciphertext and GCM tag, unpadded base64url, and 90 around them.
  return 90 + Math.ceil((4 * (12 + plain + 16)) / 3);
};

/** The record IDs of `notes`, sorted: for pages whose order ties. */
const sortedIds = (notes: readonly { _id: string }[]): string[] =>
  idsOf(notes).toSorted();

/** The text of every part of `cursor`, decoded, as anyone holding it could. */
const readable = (cursor: string): string =>
  cursor
    .split(".")
    .map((part) => {
      try {
        return new TextDecoder().decode(fromBase64Url(part));
      } catch {
        return part;
      }
    })
    .join(" ");

describe("cursors", () => {
  it("are opaque: neither record IDs nor values can be read from them", async () => {
    const fixture = await storeWith("appMembers");
    await insertNotes(fixture, ranked);
    const db = dbOf(fixture, scopeOf(fixture.schemaHash));
    const page = await db
      .query("notes")
      .withIndex("by_title")
      .paginate({ pageSize: 3, cursor: null });
    const cursor = page.nextCursor ?? "";
    const text = `${cursor} ${readable(cursor)}`;
    expect({
      fits: cursor.length <= cursorMaxLength,
      leaks: page.items.some(
        ({ _id, title }) => text.includes(_id) || text.includes(`"${title}"`)
      ),
      prefix: text.includes("n-ada"),
    }).toStrictEqual({ fits: true, leaks: false, prefix: false });
  });

  it("are refused when forged, edited, or carried to another query or caller, and expire with their generation", async () => {
    const fixture = await storeWith("owner");
    const other = await storeWith("owner");
    await insertNotes(fixture, ranked);
    await insertNotes(fixture, ranked, "grace");
    // Another schema of the same store: another generation of its tables.
    const later = await fixture.store.defineTables(
      manifestText(
        schemaManifest(schema, {
          tables: {
            notes: { read: "owner", write: "appMembers" },
            people: { read: "owner", write: "owner" },
          },
        })
      )
    );
    const scope = scopeOf(fixture.schemaHash);
    const first = await dbOf(fixture, scope)
      .query("notes")
      .withIndex("by_title")
      .paginate({ pageSize: 2, cursor: null });
    const cursor = first.nextCursor ?? "";
    const [version, sealed = "", tag = "", stable = ""] = cursor.split(".");
    const same = await pageAfter(fixture, scope, {}, cursor);
    expect({
      same: (() => {
        const items = fieldOf(same, "items");
        return Array.isArray(items)
          ? items.map((item: unknown) => fieldOf(item, "_id"))
          : same;
      })(),
      forged: await outcome(
        pageAfter(
          fixture,
          scope,
          {},
          `1.e30.${"A".repeat(43)}.${"A".repeat(43)}`
        )
      ),
      editedSeal: await outcome(
        pageAfter(
          fixture,
          scope,
          {},
          `${version}.${flip(sealed)}.${tag}.${stable}`
        )
      ),
      editedTag: await outcome(
        pageAfter(
          fixture,
          scope,
          {},
          `${version}.${sealed}.${flip(tag)}.${stable}`
        )
      ),
      editedTags: await outcome(
        pageAfter(
          fixture,
          scope,
          {},
          `${version}.${sealed}.${flip(tag)}.${flip(stable)}`
        )
      ),
      otherSpelling: await outcome(
        pageAfter(fixture, scope, {}, `0${version}.${sealed}.${tag}.${stable}`)
      ),
      laterFormat: await outcome(
        pageAfter(fixture, scope, {}, `2.${sealed}.${tag}.${stable}`)
      ),
      otherOrder: await outcome(
        pageAfter(fixture, scope, { order: "desc" }, cursor)
      ),
      otherIndex: await outcome(
        pageAfter(fixture, scope, { index: "by_done_rank" }, cursor)
      ),
      otherRange: await outcome(
        pageAfter(
          fixture,
          scope,
          { range: [{ field: "title", op: "gt", value: "a" }] },
          cursor
        )
      ),
      otherTable: await outcome(
        pageAfter(fixture, scope, { table: "people", index: null }, cursor)
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
      otherApp: await outcome(
        pageAfter(
          fixture,
          scopeOf(fixture.schemaHash, {
            consumer: { resourceId: "other-app", resourceVersion: 1 },
          }),
          {},
          cursor
        )
      ),
      otherStore: await outcome(
        pageAfter(other, scopeOf(other.schemaHash), {}, cursor)
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
      otherSchema: await outcome(
        pageAfter(fixture, scopeOf(later.schemaHash), {}, cursor)
      ),
    }).toStrictEqual({
      same: ["n-ada-00002", "n-ada-00003"],
      forged: "data.invalid_cursor",
      editedSeal: "data.invalid_cursor",
      // Its stable tag still verifies: its holder learns nothing new.
      editedTag: "data.cursor_expired",
      editedTags: "data.invalid_cursor",
      otherSpelling: "data.invalid_cursor",
      // Another format version can't be told apart from a forgery: no tag
      // of this store covers it.
      laterFormat: "data.invalid_cursor",
      otherOrder: "data.invalid_cursor",
      otherIndex: "data.invalid_cursor",
      otherRange: "data.invalid_cursor",
      otherTable: "data.invalid_cursor",
      otherFilter: "data.invalid_cursor",
      otherPerson: "data.invalid_cursor",
      otherRole: "data.invalid_cursor",
      otherApp: "data.invalid_cursor",
      otherStore: "data.invalid_cursor",
      otherVersion: "data.cursor_expired",
      otherSchema: "data.cursor_expired",
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
    // Past the longest, the cursor seals the ID alone: far shorter.
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

describe("a deleted store's cursor key", () => {
  it("goes with the store's purge, so nothing it sealed can be opened again", async () => {
    const fixture = await storeWith("appMembers");
    await insertNotes(fixture, ranked);
    const page = await dbOf(fixture, scopeOf(fixture.schemaHash))
      .query("notes")
      .paginate({ pageSize: 2, cursor: null });
    const keyOf = async (): Promise<unknown> =>
      await runInDurableObject(
        env.DATA_STORES.getByName(fixture.store.id),
        (_instance, state) =>
          state.storage.sql
            .exec<{ key: string | null }>(
              "SELECT cursor_key AS key FROM sdk_store"
            )
            .one().key
      );
    const minted = await keyOf();
    await deleteStore(env, builder, fixture.store.id);
    // Its alarm, run here rather than waited for (its own may have run).
    await runInDurableObject(
      env.DATA_STORES.getByName(fixture.store.id),
      async (_instance, state) => {
        await new StoreHost(state, env).runAlarm({});
      }
    );
    expect({
      cursor: typeof page.nextCursor,
      minted: typeof minted,
      afterPurge: await keyOf(),
    }).toStrictEqual({ cursor: "string", minted: "string", afterPurge: null });
  });
});
