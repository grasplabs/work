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

import { eraseMemoriesPerBatch } from "../src/erasure.ts";
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
    const erased = await shared().eraseWriter({
      writer,
      reason: "deleted",
      change: "reset-1",
    });
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

  // GRA-1807: what a chat showed of a memory goes once its writer's
  // erasure covers it, by the ledger alone: hidden, deleted, or after an
  // older copy of the store comes back.
  it("answers the host each memory it covers as erased, hidden, deleted or replayed into an older copy, and another writer's or a later one as kept", async () => {
    const group = unique("g");
    const reader: Reader = { person: unique("p"), groups: [group] };
    const writer = app();
    const entity: NewEntity = {
      key: "c",
      kind: "customer",
      names: [`${word()} Co`],
    };
    const written = await remember(
      group,
      [entity],
      [
        said("c", `${word()} by the writer`, { kind: "writer", writer }),
        said("c", `${word()} by another`, { kind: "writer", writer: app() }),
      ]
    );
    const [mine = "", others = ""] = written.memories;
    const copy = await copyOf(shared());
    /** Each of `ids`, as a host pinned it when it was handed over. */
    const pinned = async (ids: readonly string[]) => {
      const { memories } = await shared().readMemories({
        entity: written.entities.c ?? "",
        reader,
      });
      return ids.flatMap((id) =>
        memories.flatMap((held) =>
          held.id === id
            ? [
                {
                  memory: id,
                  source: null,
                  writer: held.writer,
                  learnedAt: held.learnedAt.getTime(),
                },
              ]
            : []
        )
      );
    };
    const before = await pinned([mine, others]);
    await holdDeletes(true);
    await shared().eraseWriter({
      writer,
      reason: "deleted",
      change: "reset-1",
    });
    // The writer remembers anew after its erasure: not covered.
    const anew = await remember(
      group,
      [{ ...entity, id: written.entities.c ?? "" }],
      [said("c", `${word()} by the writer again`, { kind: "writer", writer })]
    );
    const asked = {
      sources: [],
      memories: [...before, ...(await pinned(anew.memories))],
    };
    const hidden = await shared().erasedOf(asked);
    await holdDeletes(false);
    await tick(shared());
    const deleted = await shared().erasedOf(asked);
    // An older copy, from before the erasure, comes back: replayed.
    await restore(shared(), copy);

    expect({
      asked: asked.memories.length,
      hidden,
      deleted,
      replayed: await shared().erasedOf(asked),
    }).toStrictEqual({
      asked: 3,
      hidden: { sources: [], memories: [mine] },
      deleted: { sources: [], memories: [mine] },
      replayed: { sources: [], memories: [mine] },
    });
  });

  it("answers its change again, also after a restart and an add in between, with the first erasure and nothing more erased; another change erases anew", async () => {
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
    const erase = async (change: string) =>
      await shared().eraseWriter({ writer, reason: "deleted", change });

    const erased = await erase("reset-1");
    // The answer lost, the writer remembers anew, and the call is made
    // again: it is the same erasure, and the new memory stays. Its name
    // links to nothing the erasure took.
    const again = await entityOf(`${name} after`);
    const anew = again.entities.c ?? "";
    const retried = await erase("reset-1");
    await kill(shared());
    const restarted = await erase("reset-1");
    const read = async () => {
      const { memories } = await shared().readMemories({
        entity: anew,
        reader,
        history: true,
      });
      return memories.map(({ statement }) => statement);
    };
    expect({
      covered: erased.memories,
      retried,
      restarted,
      linked: anew === entity,
      read: await read(),
    }).toStrictEqual({
      covered: 1,
      retried: erased,
      restarted: erased,
      linked: false,
      read: [`${name} after`],
    });

    const later = await erase("reset-2");
    expect({
      memories: later.memories,
      after: later.erasedAt.getTime() > erased.erasedAt.getTime(),
      read: await read(),
      first: await erase("reset-1"),
    }).toStrictEqual({ memories: 1, after: true, read: [], first: erased });
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
    // A second memory the copy from before doesn't hold: the erasure
    // covers two, and a recount in that copy would find one.
    await remember(
      group,
      [{ key: "c", id: entity, kind: "customer", names: [] }],
      [said("c", `${name} older`, { kind: "writer", writer })]
    );

    const erased = await shared().eraseWriter({
      writer,
      reason: "deleted",
      change: "reset-1",
    });
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
    const replayed = {
      old: await read(entity),
      fresh: await read(fresh),
      // The stored answer, as the ledger's entry keeps it: not a recount.
      retried: await shared().eraseWriter({
        writer,
        reason: "deleted",
        change: "reset-1",
      }),
    };
    await tick(shared());
    expect({
      ...replayed,
      held: await heldOf(writer, `${name} Group`),
    }).toStrictEqual({
      old: [],
      fresh: [],
      retried: { erasedAt: erased.erasedAt, memories: 2 },
      held: { memories: 0, names: 0 },
    });
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
      again: await shared().eraseWriter({
        writer,
        reason: "deleted",
        change: "reset-2",
      }),
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
      (async () =>
        await shared().eraseWriter({
          writer,
          reason: "deleted",
          change: "reset-1",
        }))()
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

    const erased = await shared().eraseWriter({
      writer,
      reason: "deleted",
      change: "reset-1",
    });
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

  it("deletes the rest of a batch when one memory keeps failing to delete, and that one once it can be", async () => {
    const group = unique("g");
    const writer = app();
    const name = word();
    const { memories } = await remember(
      group,
      [{ key: "c", kind: "customer", names: [`${name} Works`] }],
      ["one", "two", "three"].map((which) =>
        said("c", `${name} ${which}`, { kind: "writer", writer })
      )
    );
    const [stuck] = memories;
    await runInDurableObject(shared(), (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER test_stuck BEFORE DELETE ON memories
        WHEN old.id = '${stuck ?? ""}' BEGIN
          SELECT RAISE(ABORT, 'stuck by the test');
        END`
      );
    });
    const held = async () =>
      await runInDurableObject(shared(), (_instance, state) =>
        state.storage.sql
          .exec<{ id: string }>(
            "SELECT id FROM memories WHERE writer = ?",
            writer
          )
          .toArray()
          .map(({ id }) => id)
      );
    await shared().eraseWriter({ writer, reason: "deleted", change: "reset" });
    await tick(shared());
    const stuckOnly = await held();
    const failing = await shared().workOverview();
    await runInDurableObject(shared(), (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER test_stuck");
    });
    await tick(shared());
    expect({
      stuckOnly,
      failed: failing.stepsFailed.erase?.reason,
      after: await held(),
    }).toStrictEqual({ stuckOnly: [stuck], failed: "failed", after: [] });
  });

  it("puts memories that failed to delete behind the others, so more of them than a batch holds never keep a deletable one from going", async () => {
    const group = unique("g");
    const writer = app();
    const name = word();
    const stuck = eraseMemoriesPerBatch + 1;
    for (let start = 0; start < stuck; start += 100) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await remember(
        group,
        [{ key: "c", kind: "customer", names: [`${name} Stuck`] }],
        Array.from({ length: Math.min(100, stuck - start) }, (_, index) =>
          said("c", `stuck ${start + index}`, { kind: "writer", writer })
        )
      );
    }
    const { memories } = await remember(
      group,
      [{ key: "c", kind: "customer", names: [`${name} Free`] }],
      [said("c", `${name} free`, { kind: "writer", writer })]
    );
    const [free] = memories;
    await runInDurableObject(shared(), (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER test_stuck_many BEFORE DELETE ON memories
        WHEN old.statement LIKE 'stuck %' BEGIN
          SELECT RAISE(ABORT, 'stuck by the test');
        END`
      );
    });
    const held = async () =>
      await runInDurableObject(shared(), (_instance, state) =>
        state.storage.sql
          .exec<{ stuck: number; free: number }>(
            `SELECT count(*) - count(nullif(id, ?2)) AS free,
                count(nullif(id, ?2)) AS stuck
              FROM memories WHERE writer = ?1`,
            writer,
            free ?? ""
          )
          .one()
      );
    try {
      // The call's batch: the first 1,000 stuck ones, which fail and are
      // counted. The tick's: the one stuck one never tried and the free
      // one first, then the counted ones.
      await shared().eraseWriter({
        writer,
        reason: "deleted",
        change: "reset",
      });
      await tick(shared());
      await expect(held()).resolves.toStrictEqual({ stuck, free: 0 });
    } finally {
      await runInDurableObject(shared(), (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER test_stuck_many");
      });
      await tick(shared());
      await tick(shared());
    }
  });

  it("shows no failure for a tick in which every memory was deleted, though its batch had to be taken one at a time", async () => {
    const group = unique("g");
    const writer = app();
    const name = word();
    const { memories } = await remember(
      group,
      [{ key: "c", kind: "customer", names: [`${name} Pair`] }],
      ["first", "second"].map((which) =>
        said("c", `${name} ${which}`, { kind: "writer", writer })
      )
    );
    const [first, second] = memories;
    // The first can't be deleted once the second's names are gone, as they
    // are in a batch of both (names first, then memories); deleted alone,
    // the first goes before the second's names do.
    await holdDeletes(true);
    await shared().eraseWriter({ writer, reason: "deleted", change: "reset" });
    await runInDurableObject(shared(), (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER test_pair BEFORE DELETE ON memories
        WHEN old.id = '${first ?? ""}' AND NOT EXISTS (
          SELECT 1 FROM entity_names
          JOIN memories AS other ON other.row = entity_names.memory
          WHERE other.id = '${second ?? ""}'
        ) BEGIN
          SELECT RAISE(ABORT, 'held by the test');
        END`
      );
    });
    await holdDeletes(false);
    try {
      await tick(shared());
      const overview = await shared().workOverview();
      expect({
        failed: overview.stepsFailed.erase,
        held: await heldOf(writer, `${name} Pair`),
      }).toStrictEqual({ failed: null, held: { memories: 0, names: 0 } });
    } finally {
      await runInDurableObject(shared(), (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER IF EXISTS test_pair");
      });
    }
  });

  it("refuses a change asked again for another reason, and changes nothing", async () => {
    const writer = app();
    await remember(
      unique("g"),
      [{ key: "c", kind: "customer", names: [`${word()} Reason`] }],
      [said("c", "for a reason", { kind: "writer", writer })]
    );
    const erased = await shared().eraseWriter({
      writer,
      reason: "deleted",
      change: "reset",
    });
    await expect(
      (async () =>
        await shared().eraseWriter({
          writer,
          reason: "retention",
          change: "reset",
        }))()
    ).rejects.toThrow("that change erased this writer for another reason");
    await expect(
      shared().eraseWriter({ writer, reason: "deleted", change: "reset" })
    ).resolves.toStrictEqual(erased);
  });

  it("retries the memory that failed least often first, so one that can be deleted now goes though a batch's worth fail more often", async () => {
    const group = unique("g");
    const writer = app();
    const name = word();
    for (let start = 0; start < eraseMemoriesPerBatch; start += 100) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await remember(
        group,
        [{ key: "c", kind: "customer", names: [`${name} Stuck`] }],
        Array.from({ length: 100 }, (_, index) =>
          said("c", `stuck ${start + index}`, { kind: "writer", writer })
        )
      );
    }
    // Added last: the highest row, behind every stuck one by its key.
    await remember(
      group,
      [{ key: "c", kind: "customer", names: [`${name} Flaky`] }],
      [said("c", "flaky", { kind: "writer", writer })]
    );
    const trigger = (called: string, statement: string) =>
      `CREATE TRIGGER ${called} BEFORE DELETE ON memories
      WHEN old.writer = '${writer}' AND old.statement LIKE '${statement}'
      BEGIN SELECT RAISE(ABORT, 'held by the test'); END`;
    await runInDurableObject(shared(), (_instance, state) => {
      state.storage.sql.exec(trigger("test_order_stuck", "stuck %"));
      state.storage.sql.exec(trigger("test_order_flaky", "flaky"));
    });
    const flakyHeld = async () =>
      await runInDurableObject(
        shared(),
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM memories WHERE writer = ? AND statement = 'flaky'",
              writer
            )
            .one().count
      );
    try {
      // The call: the 1,000 stuck ones fail once. The tick: the flaky one,
      // never tried, fails once, and 999 stuck ones fail again.
      await shared().eraseWriter({
        writer,
        reason: "deleted",
        change: "reset",
      });
      await tick(shared());
      await runInDurableObject(shared(), (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER test_order_flaky");
      });
      // Now deletable, and among the two that failed once: in the next
      // batch, ahead of the 998 that failed twice.
      await tick(shared());
      await expect(flakyHeld()).resolves.toBe(0);
    } finally {
      await runInDurableObject(shared(), (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER IF EXISTS test_order_flaky");
        state.storage.sql.exec("DROP TRIGGER IF EXISTS test_order_stuck");
      });
      await tick(shared());
      await tick(shared());
    }
  });

  it("is the shared store's alone", async () => {
    const person = unique("p");
    const own = env.BRAIN_STORE.getByName(`person:${person}`);
    await expect(
      (async () =>
        await own.eraseWriter({
          writer: app(),
          reason: "deleted",
          change: "reset-1",
        }))()
    ).rejects.toThrow("only the shared store takes this");
  });

  describe("a store of the release before", () => {
    /** How many migrations the release before had run: 0000 to 0014. */
    const releaseBeforeMigrations = 15;

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
      // writer's kind, its count, its change or its sweep, memories without the writer's subject or
      // the retiring change, no removals (removal.ts, a later migration),
      // every migration after the release before's not yet run, and a row
      // that points at the erasure.
      const before: Copy = {
        // The table of memories that failed to delete is the release's own,
        // and so are the quotes' (migration 0022, quotes.ts), the days
        // chunks mention (migration 0024, dates.ts) and a person's
        // erasure's (migration 0025, people.ts).
        tables: now.tables
          .filter(
            ({ name }) =>
              ![
                "memory_erase_failures",
                "removed_sources",
                "memory_outs",
                "memory_ins",
                "memory_judging",
                "memory_judging_places",
                "chunk_days",
                "person_erasure_subjects",
                "person_erasure_memories",
              ].includes(name)
          )
          .map((table) => {
            switch (table.name) {
              case "erasures": {
                return {
                  ...table,
                  created: table.created
                    .replace(", 'writer'", "")
                    .replace(/,\s*`memories` integer/u, "")
                    .replace(/,\s*`change` text/u, "")
                    .replace(/,\s*`swept_learned_at` integer/u, "")
                    .replace(/,\s*`swept_row` integer/u, ""),
                  // Earlier tests' writers' erasures: the release before had none.
                  rows: table.rows
                    .filter(({ kind }) => kind !== "writer")
                    .map((row) =>
                      without(
                        row,
                        "memories",
                        "change",
                        "swept_learned_at",
                        "swept_row"
                      )
                    ),
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
              case "current_versions": {
                return {
                  ...table,
                  created: table.created.replace(
                    /,\s*`judged_row` integer/u,
                    ""
                  ),
                  rows: table.rows.map((row) => without(row, "judged_row")),
                };
              }
              case "source_subjects": {
                return {
                  ...table,
                  created: table.created.replace(
                    /,\s*`thread` integer DEFAULT false NOT NULL/u,
                    ""
                  ),
                  rows: table.rows.map((row) => without(row, "thread")),
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
                    // The release before ran migrations 0000 to 0014: every
                    // one after them runs again, not only this release's five.
                    .slice(0, releaseBeforeMigrations),
                };
              }
              default: {
                return table;
              }
            }
          }),
        others: now.others.filter(
          (made) =>
            !made.includes("memories_writer_idx") &&
            !made.includes("erasures_writer_idx") &&
            !made.includes("memory_erase_failures") &&
            !made.includes("removed_sources") &&
            // Made by a migration after the release before's, as those are.
            !made.includes("unembeddable_hash_idx") &&
            !made.includes("work_items_key_idx") &&
            !made.includes("memory_outs") &&
            !made.includes("memory_ins") &&
            !made.includes("current_versions_unjudged_idx") &&
            !made.includes("chunk_days_chunk_idx") &&
            !made.includes("person_erasure_subjects")
        ),
      };
      expect(
        before.tables.find(({ name }) => name === "erasures")?.created
      ).not.toContain("writer");

      await restore(shared(), before);
      await expect(shared().erasureStatus({ source })).resolves.toMatchObject({
        state: "erased",
      });
      await expect(
        shared().eraseWriter({
          writer: app(),
          reason: "deleted",
          change: "reset-1",
        })
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
      await shared().eraseWriter({
        writer,
        reason: "deleted",
        change: "reset-1",
      });
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

    /** A memory of `writer`'s, about an entity of its own, in an add of its own (its own stamp). */
    const rememberOne = async (
      group: string,
      writer: string,
      statement: string
    ): Promise<string> => {
      const { memories } = await remember(
        group,
        [{ key: "c", kind: "customer", names: [`${statement} Holdings`] }],
        [said("c", statement, { kind: "writer", writer })]
      );
      return memories[0] ?? "";
    };

    /** How many erasures still hide something the tick has to delete. */
    const erasing = async (): Promise<number> => {
      const overview = await shared().workOverview();
      return overview.erasing;
    };

    /** Ticks until the restore of `id` is no longer running, at most 40, each `ahead` past now: its state. */
    const restoredBy = async (id: string, ahead = 0): Promise<string> => {
      let state = "running";
      for (let ticks = 0; ticks < 40 && state === "running"; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await tick(shared(), new Date(Date.now() + ahead));
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        const status = await shared().restoreStatus(id);
        state = status?.state ?? "none";
      }
      return state;
    };

    it("writes nothing an erasure covers when the erasure lands while a restore runs, also once the restore goes on from the start of a part", async () => {
      const group = unique("g");
      const writer = app();
      const name = word();
      // Three adds, three stamps: the restore writes them in that order.
      const first = await rememberOne(group, writer, `${name} first`);
      await rememberOne(group, writer, `${name} second`);
      const third = await rememberOne(group, writer, `${name} third`);
      const { id } = await shared().startExport("test");
      await expect(exportSettled(shared, id)).resolves.toBe("done");

      // The store's storage lost, its bucket kept; the restore held between
      // the second line and the third, which its part writes again from the
      // first once it goes on.
      await restore(shared(), empty);
      await runInDurableObject(shared(), (_instance, state) => {
        state.storage.sql.exec(
          `CREATE TRIGGER test_hold_restore BEFORE INSERT ON memories
          WHEN NEW.id = '${third}' BEGIN
            SELECT RAISE(ABORT, 'held by the test');
          END`
        );
      });
      await shared().startRestore(id, "test");
      const has = async (memory: string) =>
        await runInDurableObject(
          shared(),
          (_instance, state) =>
            state.storage.sql
              .exec("SELECT 1 FROM memories WHERE id = ?", memory)
              .toArray().length > 0
        );
      let firstWritten = false;
      for (let ticks = 0; ticks < 20 && !firstWritten; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await tick(shared());
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        firstWritten = await has(first);
      }

      // The erasure deletes the two written, and its sweep passes them.
      await shared().eraseWriter({
        writer,
        reason: "deleted",
        change: "reset",
      });
      await runInDurableObject(shared(), (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER test_hold_restore");
      });
      // Past the part's backoff: it runs again from its first line.
      const state = await restoredBy(id, 60 * 60 * 1000);
      const held = await heldOf(writer, `${name} first Holdings`);
      expect({
        firstWritten,
        state,
        held: held.memories,
        erasing: await erasing(),
      }).toStrictEqual({
        firstWritten: true,
        state: "done",
        held: 0,
        erasing: 0,
      });
    });

    it("writes nothing an erasure covers when an older export is restored after the erasure", async () => {
      const group = unique("g");
      const writer = app();
      const name = word();
      await rememberOne(group, writer, `${name} older`);
      const { id } = await shared().startExport("test");
      await expect(exportSettled(shared, id)).resolves.toBe("done");
      await shared().eraseWriter({
        writer,
        reason: "deleted",
        change: "reset",
      });

      // Its record of the export lost with the storage: the restore checks
      // the export by its files and the ledger alone.
      await restore(shared(), empty);
      await shared().startRestore(id, "test");
      await restoredBy(id);
      const held = await heldOf(writer, `${name} older Holdings`);
      expect({
        held: held.memories,
        erasing: await erasing(),
      }).toStrictEqual({ held: 0, erasing: 0 });
    });
  });
});
