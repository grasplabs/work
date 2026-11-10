import { defineSchema, defineTable, v } from "@grasp-os/runtime";
import type { SchemaDefinition } from "@grasp-os/runtime";
import {
  databaseReader,
  manifestText,
  schemaManifest,
} from "@grasp-os/runtime/host";
import type { PaginationResult } from "@grasp-os/runtime/server";
import { fromBase64Url, toBase64Url } from "@grasp-os/shared/encoding";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { StoreFields } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { deleteStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { StoreHost } from "../src/store-host.ts";
import { builder, commit, newStore, objectOf } from "./notes-stores.ts";
import {
  accessedManifest,
  applied,
  namedIds,
  newRecordId,
} from "./store-schemas.ts";

// A search index through the life of its store (store-search.ts): a
// search's pages go on after a write to its table from their record's
// relevance as it is now, and expire when that record goes; a record's old text leaves the store's pages in
// the same write as its change or deletion; a cascade and a migration's
// rewrite reach the
// index as any write does; and a deleted store's purge drops the index
// with its records.

const dayMs = 24 * 60 * 60 * 1000;

/** The manifest text of a notes schema, read and written by members. */
const notesText = (schema: SchemaDefinition): string =>
  manifestText(
    accessedManifest(schema, {
      tables: { notes: { read: "appMembers", write: "appMembers" } },
    })
  );

const title = v.string().min(1).max(200);
const v1 = notesText(
  defineSchema({ notes: defineTable({ title }).searchIndex(["title"]) })
);
/** A longer title and a category without default: only a migration adds them. */
const v2 = notesText(
  defineSchema({
    notes: defineTable({
      title: v.string().min(1).max(500),
      category: v.enum(["launch", "general"]),
    }).searchIndex(["title"]),
  })
);

const scopeOf = (schemaHash: string, resourceVersion = 1): ReadScope => ({
  schemaHash,
  principal: "ada",
  appMember: true,
  appBuilder: false,
  consumer: { resourceId: "notes-app", resourceVersion },
});

/** The titles a search of `text` finds in `store`, read under `schemaHash`. */
const found = async (
  store: OpenStore,
  schemaHash: string,
  text: string,
  resourceVersion = 1
): Promise<string[]> => {
  const { value } = await store.read(scopeOf(schemaHash, resourceVersion), {
    kind: "query",
    query: {
      descriptorVersion: 1,
      table: "notes",
      index: null,
      range: [],
      filter: null,
      order: "asc",
      terminal: { kind: "collect" },
      search: text,
    },
  });
  return Array.isArray(value)
    ? value.map((note: unknown) =>
        String(
          typeof note === "object" && note !== null
            ? Reflect.get(note, "title")
            : note
        )
      )
    : [];
};

/** Inserts notes titled `titles` through commits, answering their IDs. */
const insert = async (
  store: OpenStore,
  schemaHash: string,
  ...titles: string[]
): Promise<string[]> => {
  const { inserted } = await commit(
    store,
    schemaHash,
    titles.map((text) => ({
      op: "insert" as const,
      table: "notes",
      id: newRecordId(),
      fields: { title: text },
    }))
  );
  return inserted;
};

/** Runs `work` on `store`'s host, inside its object. */
const inHost = async <T>(
  store: OpenStore,
  work: (host: StoreHost, storage: DurableObjectStorage) => T | Promise<T>
): Promise<T> =>
  await runInDurableObject(
    objectOf(store),
    async (_instance, state) =>
      await work(new StoreHost(state, env), state.storage)
  );

/** How many of the store's search index pages hold `word`'s bytes. */
const pagesHolding = async (store: OpenStore, word: string): Promise<number> =>
  await inHost(store, (_host, storage) => {
    const [index] = storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE sql LIKE 'CREATE VIRTUAL TABLE sdk_fts_%'"
      )
      .toArray();
    if (index === undefined) {
      throw new Error("The store holds no search index");
    }
    // Its segments, and its own copy of the text (one column: `title`).
    return Number(
      storage.sql
        .exec(
          `SELECT (SELECT count(*) FROM ${index.name}_data WHERE instr(block, CAST(?1 AS BLOB)) > 0) + (SELECT count(*) FROM ${index.name}_content WHERE instr(CAST(c0 AS BLOB), CAST(?1 AS BLOB)) > 0) AS n`,
          word
        )
        .one().n
    );
  });

/** What a read answered, or the code it was refused with. */
const outcome = async (read: Promise<unknown>): Promise<unknown> => {
  try {
    return await read;
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : error;
  }
};

describe("a search's pages", () => {
  it("go on after a write to the table, and expire when the record they end at goes", async () => {
    const store = await newStore();
    const { schemaHash } = await store.applySchema(applied(v1));
    await insert(store, schemaHash, "alpha one", "alpha two", "alpha three");
    await insert(store, schemaHash, "alpha four", "alpha five");
    const db = databaseReader(
      defineSchema({ notes: defineTable({ title }).searchIndex(["title"]) }),
      async (request) => {
        const { value } = await store.read(scopeOf(schemaHash), request);
        return value;
      }
    );
    const first = await db
      .search("notes", "alpha")
      .paginate({ pageSize: 2, cursor: null });
    // A write that matches nothing still moves every record's relevance:
    // the next page starts after the last record's relevance as it is now.
    // These titles are alike in length, so their order holds.
    await insert(store, schemaHash, "beta");
    const titles = first.items.map((note) => note.title);
    let cursor = first.nextCursor;
    while (cursor !== null) {
      // One page after the other.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const page: PaginationResult<{ _id: string; title: string }> = await db
        .search("notes", "alpha")
        .paginate({ pageSize: 2, cursor });
      titles.push(...page.items.map((note) => note.title));
      ({ nextCursor: cursor } = page);
    }
    // The record a cursor ends at goes: it no longer applies.
    const again = await db
      .search("notes", "alpha")
      .paginate({ pageSize: 2, cursor: null });
    const last = again.items.at(-1);
    await commit(store, schemaHash, [
      {
        op: "delete",
        table: "notes",
        id: last?._id ?? "",
      },
    ]);
    expect({
      titles: titles.toSorted(),
      gone: await outcome(
        db
          .search("notes", "alpha")
          .paginate({ pageSize: 2, cursor: again.nextCursor })
      ),
    }).toStrictEqual({
      titles: [
        "alpha five",
        "alpha four",
        "alpha one",
        "alpha three",
        "alpha two",
      ],
      gone: "data.cursor_expired",
    });
  });

  it("hold no relevance, and start after their record's, read again under the reader's access", async () => {
    const store = await newStore();
    const notes = defineSchema({
      notes: defineTable({ title }).searchIndex(["title"]),
    });
    const { schemaHash } = await store.applySchema(
      applied(
        manifestText(
          accessedManifest(notes, {
            tables: { notes: { read: "owner", write: "owner" } },
          })
        )
      )
    );
    await insert(store, schemaHash, "alpha one", "alpha two", "alpha three");
    const {
      inserted: [graces = ""],
    } = await commit(
      store,
      schemaHash,
      [
        {
          op: "insert",
          table: "notes",
          id: newRecordId(),
          fields: { title: "alpha grace" },
        },
      ],
      "grace"
    );
    const db = databaseReader(notes, async (request) => {
      const { value } = await store.read(scopeOf(schemaHash), request);
      return value;
    });
    const search = async (cursor: string | null) =>
      await db.search("notes", "alpha").paginate({ pageSize: 2, cursor });
    const first = await search(null);
    const cursor = first.nextCursor ?? "";
    const held: unknown = JSON.parse(
      new TextDecoder().decode(fromBase64Url(cursor))
    );
    /** The cursor at record `id`, as a caller could make it. */
    const at = (id: string): string =>
      toBase64Url(
        new TextEncoder().encode(
          JSON.stringify({
            ...(typeof held === "object" ? held : {}),
            id,
          })
        )
      );
    const second = await search(cursor);
    expect({
      // The last record's ID and the hashes: nothing ranked it.
      held: Object.keys(held ?? {}).toSorted(),
      pages: [...first.items, ...second.items]
        .map((note) => note.title)
        .toSorted(),
      // Another person's record is as missing as one that never was.
      othersRecord: await outcome(search(at(graces))),
      missingRecord: await outcome(search(at(newRecordId()))),
    }).toStrictEqual({
      held: ["generation", "id", "query"],
      pages: ["alpha one", "alpha three", "alpha two"],
      othersRecord: "data.cursor_expired",
      missingRecord: "data.cursor_expired",
    });
  });
});

describe("a search index's text", () => {
  it("is gone from the store's pages as soon as a change or deletion commits", async () => {
    const store = await newStore();
    const { schemaHash } = await store.applySchema(applied(v1));
    const [id = ""] = await insert(store, schemaHash, "zyzzyva");
    const stored = await pagesHolding(store, "zyzzyva");
    await commit(store, schemaHash, [
      {
        op: "patch",
        table: "notes",
        id,
        fields: { title: "quokka" },
      },
    ]);
    const changed = {
      old: await pagesHolding(store, "zyzzyva"),
      found: await found(store, schemaHash, "quokka"),
    };
    await commit(store, schemaHash, [{ op: "delete", table: "notes", id }]);
    expect({
      stored,
      changed,
      deleted: {
        found: await found(store, schemaHash, "quokka"),
        pages: await pagesHolding(store, "quokka"),
      },
    }).toStrictEqual({
      // In the index's segments and in its copy of the text.
      stored: 2,
      changed: { old: 0, found: ["quokka"] },
      deleted: { found: [], pages: 0 },
    });
  });

  it("goes with a deleted store's purge, its index and triggers dropped", async () => {
    const store = await newStore();
    const { schemaHash } = await store.applySchema(applied(v1));
    await insert(store, schemaHash, "secret plans");
    await inHost(store, async (host) => {
      await host.sweepReceipts(new Date(Date.now() + 31 * dayMs));
    });
    await deleteStore(env, builder, store.id);
    await inHost(store, async (host) => {
      await host.runAlarm({});
    });
    const left = await inHost(store, (_host, storage) => ({
      search: storage.sql
        .exec(
          "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sdk\\_fts\\_%' ESCAPE '\\'"
        )
        .one().n,
      docs: storage.sql.exec("SELECT count(*) AS n FROM sdk_search_docs").one()
        .n,
      records: storage.sql.exec("SELECT count(*) AS n FROM sdk_records").one()
        .n,
    }));
    expect(left).toStrictEqual({ search: 0, docs: 0, records: 0 });
  });
});

/** A note as the migration's transform rewrites it: "Note" becomes "Memo". */
const rewritten = (fields: StoreFields): StoreFields => ({
  ...fields,
  title:
    typeof fields.title === "string"
      ? fields.title.replace("Note", "Memo")
      : "",
  category: "general",
});

describe("a search index", () => {
  it("follows a cascade's deletions", async () => {
    const store = await newStore();
    const { schemaHash } = await store.applySchema(
      applied(
        manifestText(
          schemaManifest(
            defineSchema({
              accounts: defineTable({ name: v.string() }).access({
                read: "appMembers",
                write: "appMembers",
              }),
              contacts: defineTable({
                name: v.string(),
                account: v.id("accounts", { onDelete: "cascade" }),
              })
                .searchIndex(["name"])
                .access({ read: "appMembers", write: "appMembers" }),
            })
          )
        )
      )
    );
    const account = newRecordId();
    await commit(store, schemaHash, [
      { op: "insert", table: "accounts", id: account, fields: { name: "A" } },
      {
        op: "insert",
        table: "contacts",
        id: newRecordId(),
        fields: { name: "Grace Hopper", account },
      },
    ]);
    const search = async (): Promise<unknown> => {
      const { value } = await store.read(scopeOf(schemaHash), {
        kind: "query",
        query: {
          descriptorVersion: 1,
          table: "contacts",
          index: null,
          range: [],
          filter: null,
          order: "asc",
          terminal: { kind: "count" },
          search: "hopper",
        },
      });
      return value;
    };
    const before = await search();
    const { cascaded } = await commit(store, schemaHash, [
      { op: "delete", table: "accounts", id: account },
    ]);
    expect({
      before,
      cascaded: cascaded?.length,
      after: await search(),
    }).toStrictEqual({ before: 1, cascaded: 1, after: 0 });
  });

  it("follows a migration's rewrite of a searched field", async () => {
    const store = await newStore();
    const first = await store.applySchema(applied(v1));
    await insert(store, first.schemaHash, "Note one", "Note two");
    const { migrationId } = await store.beginMigration();
    const table = namedIds(v2).notes?.id ?? "";
    const rows = await store.migrationRows(table, null);
    await store.stageMigration({
      migrationId,
      table,
      rows: rows.map(({ id, revision, fields }) => ({
        id,
        revision,
        fields: rewritten(fields),
      })),
    });
    const second = await store.applySchema(
      applied(v2, {
        migration: {
          id: migrationId,
          from: first.schemaHash,
          tables: ["notes"],
        },
      })
    );
    const memo = await found(store, second.schemaHash, "memo", 2);
    expect({
      memo: memo.toSorted(),
      note: await found(store, second.schemaHash, "note", 2),
    }).toStrictEqual({ memo: ["Memo one", "Memo two"], note: [] });
  });
});
