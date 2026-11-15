// A writer's erasure (erasure.ts `eraseWriter`): every memory one writer
// (an App's code, `app:<id>`) wrote, erased for good, through the store's
// own methods. The threat model is on GRA-1883 (the third pull request).
// Each test has its own writers, groups and entities, so what others left
// in the shared store is hidden from it; the export test, which restores
// the store from empty, comes last.
import type {
  NewEntity,
  NewMemory,
  Reader,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import type { BrainStore } from "../src/store.ts";
import { exportSettled, restoredAfterLoss, tick } from "./export-reads.ts";
import { copyOf, kill, restore } from "./store-copy.ts";
import type { Copy } from "./store-copy.ts";

type Store = DurableObjectStub<BrainStore>;

const shared = (): Store => env.BRAIN_STORE.getByName("brain");
const unique = (name: string): string => `${name}${crypto.randomUUID()}`;
/** A word of letters only, so a find by name takes it as one name. */
const word = (): string =>
  `w${crypto.randomUUID().replaceAll("-", "").replaceAll(/\d/gu, "")}`.slice(
    0,
    14
  );
const app = (): string => `app:${crypto.randomUUID()}`;

/** A memory about `about`, a system fact, resting on `basis`. */
const said = (
  about: string,
  statement: string,
  basis: NewMemory["basis"],
  extra: Partial<NewMemory> = {}
): NewMemory => ({
  about,
  type: "fact",
  statement,
  speaker: { kind: "system" },
  basis,
  ...extra,
});

/** Adds `memories` about `entities` to the shared store for `group`. */
const remember = async (
  group: string,
  entities: NewEntity[],
  memories: NewMemory[]
) =>
  await shared().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group },
    entities,
    memories,
  });

/**
 * Everything `reader` reads of `entities` and by `names`, as text: each
 * one's memories with history, its entity, names and card; a find by each
 * name; its contested facts; and a recall of the names. A marker of what
 * was erased must never be in it.
 */
const everything = async (
  reader: Reader,
  entities: readonly string[],
  names: readonly string[]
): Promise<string> => {
  const store = shared();
  const reads = await Promise.all([
    ...entities.flatMap((entity) => [
      store.readMemories({ entity, reader, history: true }),
      store.readEntity({ entity, reader }),
      store.readEntityNames({ entity, reader }),
      store.readCard({ entity, reader }),
      store.listContested({ reader, entity }),
    ]),
    ...names.map(async (name) => await store.findEntities({ reader, name })),
    // Its items: what was not found names the question's own words.
    (async () => {
      const pack = await store.recall({
        question: names.join(" "),
        reader,
        budget: { tokens: 4000 },
      });
      return pack.items;
    })(),
  ]);
  return JSON.stringify(reads);
};

/** How many of `writer`'s memories, and entities named `name`, the store still holds. */
const heldOf = async (writer: string, name: string) =>
  await runInDurableObject(shared(), (_instance, state) =>
    state.storage.sql
      .exec<{ memories: number; names: number }>(
        `SELECT (SELECT count(*) FROM memories WHERE writer = ?1) AS memories,
          (SELECT count(*) FROM entity_names WHERE value = ?2) AS names`,
        writer,
        name
      )
      .one()
  );

/** Holds every delete of memories back while `held`, as a deletion cut off would. */
const holdDeletes = async (held: boolean): Promise<void> => {
  await runInDurableObject(shared(), (_instance, state) => {
    state.storage.sql.exec(
      held
        ? `CREATE TRIGGER IF NOT EXISTS test_hold_deletes BEFORE DELETE ON memories BEGIN
            SELECT RAISE(ABORT, 'held by the test');
          END`
        : "DROP TRIGGER IF EXISTS test_hold_deletes"
    );
  });
};

/** `name` of `target`, as it has it. */
const readOf = (target: object, name: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, name, target);
  return value;
};

/** `row` without `columns`. */
const without = (
  row: Record<string, SqlStorageValue>,
  ...columns: string[]
): Record<string, SqlStorageValue> =>
  Object.fromEntries(
    Object.entries(row).filter(([column]) => !columns.includes(column))
  );

/** The store's bucket failing puts while `broken`, as R2 down would. */
const breakPuts = async (broken: boolean): Promise<void> => {
  const bucket = env.BRAIN_OBJECTS;
  const failing = new Proxy(bucket, {
    get: (target, name) =>
      name === "put"
        ? async () => {
            await Promise.resolve();
            throw new Error("Broken by the test");
          }
        : readOf(target, name),
  });
  await runInDurableObject(shared(), (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The store has no env");
    }
    Reflect.set(instance, "env", {
      ...objectEnv,
      BRAIN_OBJECTS: broken ? failing : bucket,
    });
  });
};

/** The times the store recorded erasures of writers at, in order. */
const writerErasuresRecorded = async (): Promise<number[]> =>
  await runInDurableObject(shared(), (_instance, state) =>
    state.storage.sql
      .exec<{ at: number }>(
        "SELECT erased_at AS at FROM erasures WHERE kind = 'writer' ORDER BY key"
      )
      .toArray()
      .map(({ at }) => at)
  );

describe("a writer's erasure", () => {
  /** The shared store before any test of this file added to it: empty. */
  let empty: Copy = { tables: [], others: [] };
  beforeAll(async () => {
    empty = await copyOf(shared());
  });
  // A test that fails while it holds deletes back leaves none held.
  afterEach(async () => {
    await holdDeletes(false);
  });

  it("hides all a writer wrote at once, keeps it hidden through a cut-off deletion and a restart, and deletes it with what rests on it alone", async () => {
    const group = unique("g");
    const reader: Reader = { person: unique("p"), groups: [group] };
    const writer = app();
    const other = app();
    const secret = word();
    const contact = word();
    const kept = word();
    const version = await shared().addSource({
      source: unique("test:"),
      change: crypto.randomUUID(),
      text: `${kept} drawn from a source`,
      access: { kind: "audience", group },
    });
    // The writer's: a fact (retired below), a fact, and a link to a
    // contact only it mentions, on an entity a name and an identifier of
    // its own give.
    const written = await remember(
      group,
      [
        {
          key: "c",
          kind: "customer",
          names: [`${secret} Holdings`],
          identifiers: [{ type: "ref", value: `ref:${secret}` }],
        },
        { key: "p", kind: "person", names: [`${contact} Person`] },
      ],
      [
        said("c", `${secret} retired`, { kind: "writer", writer }),
        said("c", `${secret} current`, { kind: "writer", writer }),
        said(
          "c",
          `${secret} contact`,
          { kind: "writer", writer },
          {
            attribute: "contact",
            object: "p",
          }
        ),
      ]
    );
    const entity = written.entities.c ?? "";
    const person = written.entities.p ?? "";
    // Another writer's and a source's, on the same entity.
    await remember(
      group,
      [{ key: "c", id: entity, kind: "customer", names: [`${kept} Co`] }],
      [
        said("c", `${kept} by another writer`, {
          kind: "writer",
          writer: other,
        }),
        said("c", `${kept} from the source`, {
          kind: "source",
          ...version,
          quote: `${kept} drawn from a source`,
        }),
      ]
    );
    const [first] = written.memories;
    await expect(
      shared().retireMemory({
        memory: first ?? "",
        reader,
        writer,
        change: "forget-1",
      })
    ).resolves.toMatchObject({ change: "forget-1" });

    // Cut off: the call's own batch of deletes fails, as a store stopping
    // mid-deletion would leave it.
    await holdDeletes(true);
    const erased = await shared().eraseWriter({ writer, reason: "deleted" });
    /** What the reader reads now, and what the store still holds. */
    const seen = async () => {
      const read = await everything(
        reader,
        [entity, person],
        [secret, contact]
      );
      return {
        erased: read.includes(secret) || read.includes(contact),
        others: [`${kept} by another writer`, `${kept} from the source`].map(
          (marker) => read.includes(marker)
        ),
        held: await heldOf(writer, `${secret} Holdings`),
      };
    };
    // Each memory keeps the names it gave its entity: all still held,
    // none read.
    const hiddenNow = {
      erased: false,
      others: [true, true],
      held: { memories: 3, names: 3 },
    };
    expect({ covered: erased.memories, seen: await seen() }).toStrictEqual({
      covered: 3,
      seen: hiddenNow,
    });

    await kill(shared());
    // Nothing links by a name only an erased memory still gives: an add
    // with exactly the same readers and name makes an entity of its own.
    const named = await remember(
      group,
      [{ key: "c", kind: "customer", names: [`${secret} Holdings`] }],
      [said("c", "named alike", { kind: "writer", writer: other })]
    );
    expect({
      seen: await seen(),
      linked: named.entities.c === entity,
    }).toStrictEqual({
      // The later add gave the name once more.
      seen: { ...hiddenNow, held: { memories: 3, names: 4 } },
      linked: false,
    });

    await holdDeletes(false);
    await tick(shared());
    // The contact only the writer mentioned is gone; the entity others
    // still mention stays, with what they said of it; the name left is the
    // later add's own.
    const after = await shared().readMemories({
      entity,
      reader,
      history: true,
    });
    expect({
      held: await heldOf(writer, `${secret} Holdings`),
      contact: await shared().readEntity({ entity: person, reader }),
      statements: after.memories.map(({ statement }) => statement).toSorted(),
    }).toStrictEqual({
      held: { memories: 0, names: 1 },
      contact: null,
      statements: [
        `${kept} by another writer`,
        `${kept} from the source`,
      ].toSorted(),
    });
  });

  it("answers a retry, also after a restart, with the first erasure, and erases what the writer adds afterwards only when asked again", async () => {
    const group = unique("g");
    const reader: Reader = { person: unique("p"), groups: [group] };
    const writer = app();
    const name = word();
    const entityOf = async (statement: string) =>
      await remember(
        group,
        [{ key: "c", kind: "customer", names: [`${name} Ltd`] }],
        [said("c", statement, { kind: "writer", writer })]
      );
    const { entities } = await entityOf(`${name} before`);
    const entity = entities.c ?? "";

    const erased = await shared().eraseWriter({ writer, reason: "deleted" });
    const retried = await shared().eraseWriter({ writer, reason: "deleted" });
    await kill(shared());
    const restarted = await shared().eraseWriter({ writer, reason: "deleted" });
    expect({ covered: erased.memories, retried, restarted }).toStrictEqual({
      covered: 1,
      retried: erased,
      restarted: erased,
    });

    // The writer may remember anew: kept, readable, and the retry above
    // never reaches it. Its name links to nothing the erasure took.
    const again = await entityOf(`${name} after`);
    const anew = again.entities.c ?? "";
    const read = async () => {
      const { memories } = await shared().readMemories({
        entity: anew,
        reader,
        history: true,
      });
      return memories.map(({ statement }) => statement);
    };
    expect({ linked: anew === entity, read: await read() }).toStrictEqual({
      linked: false,
      read: [`${name} after`],
    });

    const later = await shared().eraseWriter({ writer, reason: "deleted" });
    expect({
      memories: later.memories,
      after: later.erasedAt.getTime() > erased.erasedAt.getTime(),
      read: await read(),
    }).toStrictEqual({ memories: 1, after: true, read: [] });
  });

  it("replays after an older copy of the store comes back: what it erased stays gone, what the writer added since is the copy's to hold, and a later add is kept", async () => {
    const group = unique("g");
    const reader: Reader = { person: unique("p"), groups: [group] };
    const writer = app();
    const name = word();
    const { entities } = await remember(
      group,
      [{ key: "c", kind: "customer", names: [`${name} Group`] }],
      [said("c", `${name} old`, { kind: "writer", writer })]
    );
    const entity = entities.c ?? "";
    const read = async (about: string) => {
      const { memories } = await shared().readMemories({
        entity: about,
        reader,
        history: true,
      });
      return memories.map(({ statement }) => statement);
    };
    const before = await copyOf(shared());

    const erased = await shared().eraseWriter({ writer, reason: "deleted" });
    const added = await remember(
      group,
      [{ key: "c", kind: "customer", names: [`${name} Fresh`] }],
      [said("c", `${name} new`, { kind: "writer", writer })]
    );
    const fresh = added.entities.c ?? "";
    const after = await copyOf(shared());

    // The copy from before: the old memory comes back with it, and the
    // replay hides it before anything is answered; the new one it never
    // held. Its tick deletes the old one.
    await restore(shared(), before);
    const replayed = { old: await read(entity), fresh: await read(fresh) };
    await tick(shared());
    expect({
      ...replayed,
      held: await heldOf(writer, `${name} Group`),
    }).toStrictEqual({ old: [], fresh: [], held: { memories: 0, names: 0 } });
    // An add now is kept, even with the clock behind the erasure: the
    // replay raised the store's stamp past it.
    vi.useFakeTimers({
      toFake: ["Date"],
      now: erased.erasedAt.getTime() - 60 * 60 * 1000,
    });
    try {
      const { entities: anew } = await remember(
        group,
        [{ key: "c", kind: "customer", names: [`${name} Anew`] }],
        [said("c", `${name} anew`, { kind: "writer", writer })]
      );
      await expect(
        shared().readMemories({ entity: anew.c ?? "", reader })
      ).resolves.toMatchObject({ memories: [{ statement: `${name} anew` }] });
    } finally {
      vi.useRealTimers();
    }

    // The copy from after: it holds the new memory, kept.
    await restore(shared(), after);
    expect({
      fresh: await read(fresh),
      old: await read(entity),
      again: await shared().eraseWriter({ writer, reason: "deleted" }),
    }).toMatchObject({
      fresh: [`${name} new`],
      old: [],
      again: { memories: 1 },
    });
  });

  // Partial failure: nothing reads as done that wasn't, and the retry is
  // the same erasure.
  it("fails while its ledger entry can't be written, hiding the memories meanwhile, and the retry writes that same erasure", async () => {
    const group = unique("g");
    const reader: Reader = { person: unique("p"), groups: [group] };
    const writer = app();
    const name = word();
    const { entities } = await remember(
      group,
      [{ key: "c", kind: "customer", names: [`${name} Trust`] }],
      [said("c", `${name} said`, { kind: "writer", writer })]
    );
    const entity = entities.c ?? "";
    const recordedBefore = await writerErasuresRecorded();

    await breakPuts(true);
    await expect(
      (async () => await shared().eraseWriter({ writer, reason: "deleted" }))()
    ).rejects.toThrow(/could not record the erasure/u);
    await breakPuts(false);
    const hidden = await shared().readMemories({
      entity,
      reader,
      history: true,
    });
    const recordedNow = await writerErasuresRecorded();
    const recorded = recordedNow.slice(recordedBefore.length);
    expect({ read: hidden.memories, recorded: recorded.length }).toStrictEqual({
      read: [],
      recorded: 1,
    });

    const erased = await shared().eraseWriter({ writer, reason: "deleted" });
    const listed = await env.BRAIN_OBJECTS.list({ prefix: "erasures/" });
    const entry = `erasures/${String(erased.erasedAt.getTime()).padStart(15, "0")}-writer-`;
    expect({
      erased,
      entries: listed.objects.filter(({ key }) => key.startsWith(entry)).length,
    }).toStrictEqual({
      erased: { erasedAt: new Date(recorded[0] ?? 0), memories: 1 },
      entries: 1,
    });
  });

  it("is the shared store's alone", async () => {
    const person = unique("p");
    const own = env.BRAIN_STORE.getByName(`person:${person}`);
    await expect(
      (async () =>
        await own.eraseWriter({ writer: app(), reason: "deleted" }))()
    ).rejects.toThrow("only the shared store takes this");
  });

  describe("a store of the release before", () => {
    // Migration 0016 makes `erasures` anew, which rows of `erased_versions`
    // point at: it must keep every erasure, and the store must start.
    it("keeps every erasure through the upgrade, also one rows point at, and takes a writer's erasure after it", async () => {
      const source = unique("test:");
      await shared().addSource({
        source,
        change: crypto.randomUUID(),
        text: "erased before the upgrade",
        access: { kind: "audience", group: unique("g") },
      });
      await shared().eraseSource({ source, reason: "deleted" });
      const now = await copyOf(shared());
      const key = now.tables
        .find(({ name }) => name === "erasures")
        ?.rows.find(({ kind }) => kind === "source")?.key;
      const erasure = typeof key === "string" ? key : "";
      // The store as the release before left it: `erasures` without a
      // writer's kind or its count, memories without the writer's subject or
      // the retiring change, the last two migrations not yet run, and a row
      // that points at the erasure.
      const before: Copy = {
        tables: now.tables.map((table) => {
          switch (table.name) {
            case "erasures": {
              return {
                ...table,
                created: table.created
                  .replace(", 'writer'", "")
                  .replace(/,\s*`memories` integer/u, ""),
                // Earlier tests' writers' erasures: the release before had none.
                rows: table.rows
                  .filter(({ kind }) => kind !== "writer")
                  .map((row) => without(row, "memories")),
              };
            }
            case "memories": {
              return {
                ...table,
                created: table.created
                  .replace(/,\s*`writer_subject` text/u, "")
                  .replace(/,\s*`retired_change` text/u, ""),
                rows: table.rows.map((row) =>
                  without(row, "writer_subject", "retired_change")
                ),
              };
            }
            case "erased_versions": {
              return {
                ...table,
                rows: [
                  ...table.rows,
                  { erasure, subject: "a".repeat(64), version: 1 },
                ],
              };
            }
            case "__drizzle_migrations": {
              return {
                ...table,
                rows: table.rows
                  .toSorted(
                    (a, b) => Number(a.created_at) - Number(b.created_at)
                  )
                  .slice(0, -2),
              };
            }
            default: {
              return table;
            }
          }
        }),
        others: now.others.filter(
          (made) => !made.includes("memories_writer_idx")
        ),
      };
      expect(
        before.tables.find(({ name }) => name === "erasures")?.created
      ).not.toContain("writer");

      await restore(shared(), before);
      await expect(
        shared().erasureStatus({ kind: "source", source })
      ).resolves.toMatchObject({ state: "erased" });
      await expect(
        shared().eraseWriter({ writer: app(), reason: "deleted" })
      ).resolves.toMatchObject({ memories: 0 });
      // Its triggers are back: an erasure is never deleted.
      await expect(
        runInDurableObject(shared(), (_instance, state) => {
          state.storage.sql.exec("DELETE FROM erasures WHERE key = ?", erasure);
        })
      ).rejects.toThrow(/never deleted/u);
    });
  });

  describe("and the company's exports", () => {
    it("makes stale an export holding the writer's memories, and restores one taken after it with only what the writer added since", async () => {
      const group = unique("g");
      const reader: Reader = { person: unique("p"), groups: [group] };
      const writer = app();
      const other = app();
      const name = word();
      const { entities } = await remember(
        group,
        [{ key: "c", kind: "customer", names: [`${name} Partners`] }],
        [
          said("c", `${name} old`, { kind: "writer", writer }),
          said("c", `${name} other`, { kind: "writer", writer: other }),
        ]
      );
      const entity = entities.c ?? "";
      const { id: older } = await shared().startExport("test");
      await expect(exportSettled(shared, older)).resolves.toBe("done");

      // Its memories hidden and not yet deleted, while the next export is
      // written: it holds none of them.
      await holdDeletes(true);
      await shared().eraseWriter({ writer, reason: "deleted" });
      await tick(shared());
      await expect(shared().exportStatus({ id: older })).resolves.toMatchObject(
        {
          state: "erased",
        }
      );

      await remember(
        group,
        [{ key: "c", id: entity, kind: "customer", names: [] }],
        [said("c", `${name} new`, { kind: "writer", writer })]
      );
      const { id: newer } = await shared().startExport("test");
      await expect(exportSettled(shared, newer)).resolves.toBe("done");
      await tick(shared());
      await expect(shared().exportStatus({ id: newer })).resolves.toMatchObject(
        {
          state: "done",
        }
      );
      await holdDeletes(false);

      const state = await restoredAfterLoss(shared, newer, empty);
      const held = await heldOf(writer, `${name} Partners`);
      const restored = await shared().readMemories({
        entity,
        reader,
        history: true,
      });
      expect({
        state,
        statements: restored.memories
          .map(({ statement }) => statement)
          .toSorted(),
        held: held.memories,
      }).toStrictEqual({
        state: "done",
        statements: [`${name} new`, `${name} other`].toSorted(),
        held: 1,
      });
    });
  });
});
