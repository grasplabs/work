// A person's own store (store.ts, GRA-1762): what only one person may
// read, kept apart from everything else. Under the names the host uses:
// `brain` for the shared store, `person:<id>` for a person's own. Each
// test has a person, readers and texts of its own, so what earlier tests
// left in the shared store is hidden from it: emptying storage between
// tests (`reset`) crashed workerd here, beside the tests that swap a
// store's bucket. The threat model is on GRA-1762; each test names the
// threat it holds.
import type {
  Access,
  AskModel,
  Embedders,
  HandOvers,
  Reader,
} from "@grasp-os/brain-next/contract";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { DurableObject, env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { packAcross } from "../src/across.ts";
import {
  brainOf,
  personalBrainOf,
  recallBudgetMax,
  vectorModelNameOf,
} from "../src/contract.ts";
import { fileGraceMs } from "../src/files.ts";
import { BrainStore } from "../src/store.ts";

/** A store, as its namespace gives it. */
type Store = DurableObjectStub<BrainStore>;

/** This test's person, and their own store, named as `personalBrainOf` names it. */
let person = "";
const own = (): Store => env.BRAIN_STORE.getByName(`person:${person}`);

/** The shared store, as the host names it. */
const shared = (): Store => env.BRAIN_STORE.getByName("brain");

const whole = { tokens: recallBudgetMax };
const readerOf = (who: string): Reader => ({ person: who, groups: [] });
const theirs = (): Access => ({ kind: "owner", person });

/** Adds `text` to `store` as a source of its own. */
const add = async (
  store: Store,
  text: string,
  access: Access
): Promise<{ source: string; version: number }> =>
  await store.addSource({
    source: `test:${crypto.randomUUID()}`,
    change: "1",
    text,
    access,
  });

/** The SHA-256 of `text`, in hex. */
const sha256 = async (text: string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** The keys in the bucket under `prefix`. */
const keysUnder = async (prefix: string): Promise<string[]> => {
  const listed = await env.BRAIN_OBJECTS.list({ prefix });
  return listed.objects.map(({ key }) => key);
};

/** Where this test's person's store keeps its objects. */
const ownPrefix = async (): Promise<string> =>
  `people/${await sha256(person)}/`;

/** The store's own tables: none until it makes its schema. */
const tablesOf = async (store: Store): Promise<string[]> =>
  await runInDurableObject(store, (_instance, state) =>
    state.storage.sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`
      )
      .toArray()
      .map(({ name }) => name)
  );

/** Kills the store, as a crash, a restart or a restore would. */
const kill = async (store: Store): Promise<void> => {
  try {
    await runInDurableObject(store, (_instance, state) => {
      state.abort("Killed by the test");
    });
  } catch {
    // The kill ends the call it was made in.
  }
};

/** A row of a table. */
type Row = Record<string, SqlStorageValue>;

/** Every table's schema and rows, and every index's and trigger's schema: a backup. */
interface Copy {
  tables: { name: string; created: string; virtual: boolean; rows: Row[] }[];
  others: string[];
}

/** Tables a table of the store makes itself (the word indexes' pages). */
const madeByAnother = /^(?:sqlite_|chunk_(?:words|stems)_)/u;

/** A copy of all `store` holds, as a backup taken now. */
const copyOf = async (store: Store): Promise<Copy> =>
  await runInDurableObject(store, (_instance, state) => {
    const { sql } = state.storage;
    const tables = sql
      .exec<{ name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`
      )
      .toArray()
      .filter(({ name }) => !madeByAnother.test(name))
      .map(({ name, sql: created }) => {
        const virtual = created.startsWith("CREATE VIRTUAL TABLE");
        return {
          name,
          created,
          virtual,
          rows: sql
            .exec<Row>(
              virtual
                ? `SELECT rowid AS rowid, * FROM "${name}"`
                : `SELECT * FROM "${name}"`
            )
            .toArray(),
        };
      });
    const others = sql
      .exec<{ sql: string | null }>(
        "SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger') ORDER BY type"
      )
      .toArray()
      .flatMap(({ sql: created }) => (created === null ? [] : [created]));
    return { tables, others };
  });

/**
 * `copy` put back in place of all `store` holds, as a restore of its
 * storage would, the bucket untouched, and the store killed, as a restore
 * restarts it.
 */
const restore = async (store: Store, copy: Copy): Promise<void> => {
  await runInDurableObject(store, async (_instance, state) => {
    await state.storage.deleteAll();
    const { sql } = state.storage;
    state.storage.transactionSync(() => {
      // Rows go back table by table: their references hold at the end.
      sql.exec("PRAGMA defer_foreign_keys = ON");
      for (const { created } of copy.tables) {
        sql.exec(created);
      }
      for (const { name, rows } of copy.tables) {
        for (const row of rows) {
          const columns = Object.keys(row);
          sql.exec(
            `INSERT INTO "${name}" (${columns.map((column) => `"${column}"`).join(", ")})
            VALUES (${columns.map(() => "?").join(", ")})`,
            ...Object.values(row)
          );
        }
      }
      for (const created of copy.others) {
        sql.exec(created);
      }
    });
  });
  await kill(store);
};

/** R2's call `name` on the host's bucket, as the store would make it. */
const r2 = async (name: string, args: unknown[]): Promise<unknown> => {
  const bucket = env.BRAIN_OBJECTS;
  const method: unknown = Reflect.get(bucket, name);
  if (typeof method !== "function") {
    throw new TypeError(`R2 has no ${name}`);
  }
  const result: unknown = await Reflect.apply(method, bucket, args);
  return result;
};

/** R2's calls by name. */
const r2Calls = ["get", "head", "put", "delete", "list"] as const;

/** The store's bucket swapped for `to`. */
const swapBucket = async (store: Store, to: unknown): Promise<void> => {
  await runInDurableObject(store, (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The store has no env");
    }
    Reflect.set(instance, "env", { ...objectEnv, BRAIN_OBJECTS: to });
  });
};

/**
 * Makes the store's bucket fail `failing` (R2's calls by name) from now
 * on, until `heal` is called.
 */
const breakBucket = async (
  store: Store,
  failing: readonly string[]
): Promise<{ heal: () => Promise<void> }> => {
  await swapBucket(
    store,
    Object.fromEntries(
      r2Calls.map((name) => [
        name,
        failing.includes(name)
          ? async () => {
              await Promise.resolve();
              throw new Error("Broken by the test");
            }
          : async (...args: unknown[]) => await r2(name, args),
      ])
    )
  );
  return {
    heal: async () => {
      await swapBucket(store, env.BRAIN_OBJECTS);
    },
  };
};

/** `bucket`, its `head` failing: a store can't read whether it was erased. */
const failingHeads = (bucket: R2Bucket): unknown =>
  Object.fromEntries(
    r2Calls.map((name) => [
      name,
      name === "head"
        ? async () => {
            await Promise.resolve();
            throw new Error("Broken by the test");
          }
        : async (...args: unknown[]) => {
            const method: unknown = Reflect.get(bucket, name);
            if (typeof method !== "function") {
              throw new TypeError(`R2 has no ${name}`);
            }
            const result: unknown = await Reflect.apply(method, bucket, args);
            return result;
          },
    ])
  );

/**
 * Holds the store's writes of versions' files from now on: `reached`
 * once one waits, which writes when `release` is called.
 */
const holdFileWrites = async (
  store: Store
): Promise<{ reached: Promise<"reached">; release: () => void }> => {
  const reached = Promise.withResolvers<"reached">();
  const released = Promise.withResolvers<"released">();
  await swapBucket(
    store,
    Object.fromEntries(
      r2Calls.map((name) => [
        name,
        async (...args: unknown[]) => {
          if (name === "put" && String(args[0]).includes("/sources/")) {
            reached.resolve("reached");
            await released.promise;
          }
          return await r2(name, args);
        },
      ])
    )
  );
  return {
    reached: reached.promise,
    release: () => {
      released.resolve("released");
    },
  };
};

/**
 * `rpc`'s outcome as a plain promise: an assertion reading an RPC call's
 * own promise would call the store again through it.
 */
const called = async <T>(rpc: Promise<T>): Promise<T> => await rpc;

/** The record of a store's erasure, as the store writes it. */
const erasureRecordSchema = z.object({ reason: z.string(), at: z.number() });

/**
 * The record of this test's person's erasure moved back past the grace an
 * add has to write its file (files.ts `fileGraceMs`), as time passing
 * would.
 */
const ageErasure = async (): Promise<void> => {
  const key = `${await ownPrefix()}erased`;
  const record = await env.BRAIN_OBJECTS.get(key);
  if (record === null) {
    throw new Error("The store has no record of its erasure");
  }
  const { reason, at } = erasureRecordSchema.parse(
    JSON.parse(await record.text())
  );
  await env.BRAIN_OBJECTS.put(
    key,
    JSON.stringify({ reason, at: at - fileGraceMs - 1 })
  );
};

/**
 * This test's person's store erased whole, as its caller erases it:
 * called again, once the grace is over, until it answers done.
 */
const eraseWhole = async (): Promise<void> => {
  await Promise.allSettled([
    called(own().erasePerson({ person, reason: "person_erased" })),
  ]);
  await ageErasure();
  await own().erasePerson({ person, reason: "person_erased" });
};

/** The reader that is this test's person. */
const me = (): Reader => readerOf(person);

/** What a store holding nothing finds: nothing, by every way. */
const nothingFound = {
  words: [],
  stopWords: [],
  terms: [],
  exact: [],
  capped: [],
  meaning: [],
};

/** When `store`'s alarm is set for, if it is. */
const alarmOf = async (store: Store): Promise<number | null> =>
  await runInDurableObject(
    store,
    async (_instance, state) => await state.storage.getAlarm()
  );

/** How many sources the split-pack test's corpus holds. */
const splitSources = 28;

/** The split-pack test's model, and its vectors' dimensions and centre. */
const splitModel = { name: "split-test", build: "1" };
const splitModelName = vectorModelNameOf(splitModel);
const splitDimensions = 8;
const splitCentre = Array.from({ length: splitDimensions }, () => 0);

/**
 * Words in more than one form, and stop words, so passages tie on what
 * they hold and part on how they hold it.
 */
const splitWords = [
  "invoice",
  "invoices",
  "budget",
  "budgets",
  "travel",
  "travelling",
  "contract",
  "contracts",
  "meeting",
  "salary",
  "laptop",
  "office",
  "the",
  "and",
];

/**
 * The split-pack test's questions: words in their forms, IDs found and
 * not, an ID only many passages hold in other forms, and a rare word with
 * stop words, which the stop words fill out.
 */
const splitQuestions = [
  "invoice budget",
  "the invoices and budgets",
  "travel salary PO-10000",
  "PO-10007 and PO-99999",
  "laptop office meeting contract",
  "Where is PO-55555?",
  "the zebra and the",
];

/**
 * Source `index`'s text: its words, an ID now and then, a rare word in
 * two, padded to a length of its own (spaced so a second version, longer
 * by 8, never takes another's), so passages never tie on what follows.
 */
const splitTextOf = (index: number, random: (n: number) => number): string => {
  const words = [
    ...Array.from(
      { length: 3 + (index % 7) },
      () => splitWords[random(splitWords.length)] ?? ""
    ),
    index % 7 === 0 ? `PO-${10_000 + index}` : "",
    index === 4 || index === 19 ? "zebra" : "",
  ]
    .filter((word) => word !== "")
    .join(" ");
  return `${words} ${"x".repeat(200 + 10 * index - words.length - 1)}`;
};

/**
 * A text of 105 passages, each holding the words of PO-55555 but not in a
 * row, so none holds it as written: candidates of the exact way, which
 * only its cap keeps from saying it isn't found. Each of a length of its
 * own: `side` 0 and 1 never share one.
 */
const longTextOf = (side: number): string =>
  Array.from({ length: 105 }, (_, index) => {
    const opening = `55555 ${side === 0 ? "quartz" : "lattice"} PO`;
    return `${opening} ${"q".repeat(700 + 2 * index + side - opening.length - 1)}`;
  }).join("\n\n");

/** A moment passed: the store's next time is later than its last. */
const moment = async (): Promise<void> => {
  await scheduler.wait(5);
};

/** The sources the split-pack test adds a second version of. */
const revised = (index: number): boolean => index % 7 === 3;

/** Numbers below `n` from `seed`, the same each run (a linear congruential generator). */
const seeded = (seed: number): ((n: number) => number) => {
  let state = seed;
  return (n) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % n;
  };
};

describe("a person's own store", () => {
  beforeEach(() => {
    person = `person-${crypto.randomUUID()}`;
  });

  // Threat 1: a caller asks someone's store as someone else.
  it("answers its person by the name the host gives it, and refuses to recall or find for anyone else", async () => {
    const kept = await add(own(), "Marker of their own", theirs());
    const other = readerOf(`other-${crypto.randomUUID()}`);
    const refused = /answers only the person whose it is/u;

    await expect(
      called(own().recall({ question: "Marker", reader: other, budget: whole }))
    ).rejects.toThrow(refused);
    await expect(
      called(own().find({ question: "Marker", reader: other, budget: whole }))
    ).rejects.toThrow(refused);
    const { items } = await personalBrainOf(env.BRAIN_STORE, person).recall({
      question: "Marker",
      reader: readerOf(person),
      budget: whole,
    });
    expect(items.map(({ source }) => source)).toStrictEqual([kept.source]);
  });

  // Threat 1: every other read, and an erasure, for someone else.
  // Threat 1: the listings are reads like the others.
  it("lists nothing for anyone else, and nothing while it holds nothing, before its first write or once erased whole", async () => {
    const other = readerOf(`other-${crypto.randomUUID()}`);
    const refused = /answers only the person whose it is/u;
    const listed = async () => ({
      sources: await own().listSources({ reader: me(), prefixes: ["test:"] }),
      versions: await own().listVersions({
        source: "test:listed",
        reader: me(),
      }),
    });
    const empty = {
      sources: { sources: [], more: false },
      versions: { versions: [], more: false },
    };
    const before = await listed();
    const kept = await add(own(), "Listed for its person", theirs());

    await expect(
      called(own().listSources({ reader: other, prefixes: ["test:"] }))
    ).rejects.toThrow(refused);
    await expect(
      called(own().listVersions({ source: kept.source, reader: other }))
    ).rejects.toThrow(refused);
    const theirsListed = await own().listSources({
      reader: me(),
      prefixes: ["test:"],
    });
    await eraseWhole();
    expect({
      before,
      listed: theirsListed.sources.map(({ source }) => source),
      after: await listed(),
    }).toStrictEqual({ before: empty, listed: [kept.source], after: empty });
  });

  it("refuses to read a version, current versions or vectors for anyone else, or to erase anyone else", async () => {
    const kept = await add(own(), "Marker of their own", theirs());
    const other = readerOf(`other-${crypto.randomUUID()}`);
    const refused = /answers only the person whose it is/u;

    await expect(
      called(own().readVersion({ ...kept, reader: other }))
    ).rejects.toThrow(refused);
    await expect(
      called(own().readCurrent({ sources: [kept.source], reader: other }))
    ).rejects.toThrow(refused);
    await expect(
      called(
        own().searchVectors({
          model: "any@1",
          vector: [1, 0],
          reader: other,
          limit: 1,
        })
      )
    ).rejects.toThrow(refused);
    await expect(
      called(
        own().erasePerson({ person: other.person, reason: "person_erased" })
      )
    ).rejects.toThrow(refused);
    await expect(
      own().readVersion({ ...kept, reader: readerOf(person) })
    ).resolves.toMatchObject({ text: "Marker of their own" });
  });

  // Threat 1: content anyone else may read never goes in.
  // A key lives in one store: the host asks the shared one before it
  // keeps a source in a person's own.
  it("says, for the host, whether it was given a key, an erased one included, and nothing more", async () => {
    const group: Access = {
      kind: "audience",
      group: `team:${crypto.randomUUID()}`,
    };
    const kept = await add(shared(), "Kept for a team", group);
    const erased = await add(shared(), "Erased for a team", group);
    await shared().eraseSource({ source: erased.source, reason: "deleted" });

    expect({
      kept: await called(shared().holdsSource(kept.source)),
      erased: await called(shared().holdsSource(erased.source)),
      never: await called(shared().holdsSource(`test:${crypto.randomUUID()}`)),
    }).toStrictEqual({ kept: true, erased: true, never: false });
  });

  it("keeps nothing anyone but its person may read", async () => {
    const refused = /keeps only what its person alone may read/u;
    const others: Access[] = [
      { kind: "owner", person: `other-${crypto.randomUUID()}` },
      { kind: "audience", group: "company" },
      { kind: "none" },
    ];
    const outcomes = await Promise.allSettled(
      others.flatMap((access) => [
        add(own(), "Not theirs alone", access),
        called(
          own().addInstructions({
            source: "instructions:test",
            change: "1",
            text: "Not theirs alone",
            access,
          })
        ),
      ])
    );
    expect(
      outcomes.map(
        (outcome) =>
          outcome.status === "rejected" && refused.test(String(outcome.reason))
      )
    ).toStrictEqual(others.flatMap(() => [true, true]));
    // Refused before anything was made.
    await expect(tablesOf(own())).resolves.toStrictEqual([]);
  });

  // Threat 1: an id not made from a name says no one's store.
  it("refuses every call when its id has no name", async () => {
    const unnamed = env.BRAIN_STORE.get(env.BRAIN_STORE.newUniqueId());
    const refused = /name doesn't say whose it is/u;
    await expect(
      called(
        unnamed.recall({
          question: "x",
          reader: readerOf(person),
          budget: whole,
        })
      )
    ).rejects.toThrow(refused);
    await expect(add(unnamed, "x", theirs())).rejects.toThrow(refused);
    await expect(called(unnamed.workOverview())).rejects.toThrow(refused);
  });

  // Threat 1: a name that is neither the shared store's nor a person's is
  // no one's, never a second shared store at the bucket's root.
  it("refuses every call to a store whose name is neither `brain` nor `person:` and an id", async () => {
    const privately = `Kept where no one guards it ${person}`;
    const forEveryone = `Kept for everyone ${person}`;
    const names = [
      `Person:${person}`,
      `person-${person}`,
      ` person:${person}`,
      "person:",
      "Brain",
      "brain ",
      `shared-${person}`,
    ];
    const outcomes = await Promise.allSettled(
      names.map(async (name) => {
        const store = env.BRAIN_STORE.getByName(name);
        await add(store, privately, theirs());
        await add(store, forEveryone, {
          kind: "audience",
          group: "company",
        });
      })
    );
    expect(
      outcomes.map(
        (outcome) =>
          outcome.status === "rejected" &&
          String(outcome.reason).includes("name doesn't say whose it is")
      )
    ).toStrictEqual(names.map(() => true));
    // Nothing reached the bucket, the shared store's part included.
    const hashes = await Promise.all([sha256(privately), sha256(forEveryone)]);
    const keys = await keysUnder("");
    expect(
      keys.filter((key) => hashes.some((hash) => key.endsWith(hash)))
    ).toStrictEqual([]);
  });

  it("answers by its name once a call without it was refused", async () => {
    const named = env.BRAIN_STORE.idFromName(`person:${person}`);
    const unnamed = env.BRAIN_STORE.get(
      env.BRAIN_STORE.idFromString(named.toString())
    );
    await expect(
      called(unnamed.recall({ question: "x", reader: me(), budget: whole }))
    ).rejects.toThrow(/name doesn't say whose it is/u);

    const kept = await add(own(), "Theirs, by name", theirs());
    await expect(
      own().readVersion({ ...kept, reader: me() })
    ).resolves.toMatchObject({ text: "Theirs, by name" });
  });

  it("answers its person, before its first write, as a store holding nothing does", async () => {
    const reader = me();
    const asked = { question: "Where is the invoice PO-12345?", budget: whole };
    // The shared store, holding nothing this reader may read.
    const expected = await brainOf(env.BRAIN_STORE).recall({
      ...asked,
      reader,
    });

    await expect(own().recall({ ...asked, reader })).resolves.toStrictEqual(
      expected
    );
    await expect(own().find({ ...asked, reader })).resolves.toStrictEqual(
      nothingFound
    );
    await expect(
      own().readVersion({ source: "x", version: 1, reader })
    ).resolves.toBeNull();
    await expect(
      own().readCurrent({ sources: ["x"], reader })
    ).resolves.toStrictEqual([]);
  });

  it("keeps nothing, in its storage or the bucket, until its first write", async () => {
    await own().recall({ question: "Anything", reader: me(), budget: whole });
    const overview = await own().workOverview();
    expect(overview.storeBytes).toBe(0);
    await expect(own().requeueWork(1)).resolves.toBe("nothing");
    await expect(tablesOf(own())).resolves.toStrictEqual([]);
    await expect(keysUnder(await ownPrefix())).resolves.toStrictEqual([]);

    await add(own(), "Their first", theirs());
    await expect(tablesOf(own())).resolves.toContain("source_versions");
  });

  // Threat 8: recall across two stores leaks nothing and loses nothing.
  // The same content twice in the shared store: once for one reader, all
  // of it there (one store); once for another, split between the shared
  // store and that reader's own (two stores). Each reader's half of the
  // shared store is hidden from the other, with more no one reads. Their
  // packs must be the same, source names aside.
  it("packs what it and the shared store find as one store holding both would", async () => {
    const random = seeded(1762);
    const one = {
      reader: { person: `one-${person}`, groups: [`one-${person}`] },
      prefix: "a",
    };
    const two = { reader: { person, groups: [`two-${person}`] }, prefix: "b" };
    const nobody: Access = { kind: "audience", group: `nobody-${person}` };
    const vectors = new Map<string, number[]>();
    const vectorOf = (key: string): number[] => {
      const kept = vectors.get(key);
      if (kept !== undefined) {
        return kept;
      }
      const made = Array.from(
        { length: splitDimensions },
        () => random(2001) / 1000 - 1
      );
      vectors.set(key, made);
      return made;
    };
    const texts = Array.from({ length: splitSources }, (_, index) =>
      splitTextOf(index, random)
    );
    /** Adds the corpus for `setup`, its private half to `privately`. */
    const addAll = async (
      setup: typeof one,
      privately: Store,
      change: string,
      only: (index: number) => boolean
    ) => {
      for (const [index, text] of texts.entries()) {
        if (only(index)) {
          const ownedHere = index % 2 === 0;
          const access: Access = ownedHere
            ? { kind: "owner", person: setup.reader.person }
            : { kind: "audience", group: setup.reader.groups[0] ?? "" };
          const store = ownedHere ? privately : shared();
          const source = `${setup.prefix}:${String(index).padStart(2, "0")}`;
          const body = change === "1" ? text : `${text} revised`;
          // oxlint-disable-next-line no-await-in-loop -- in order, as one store would take them
          const { version } = await store.addSource({
            source,
            change,
            text: body,
            access,
          });
          // oxlint-disable-next-line no-await-in-loop -- its vector as the queue would put it
          await store.putVectors({
            model: { name: splitModelName, centre: splitCentre },
            vectors: [
              {
                chunk: { source, version, position: 0 },
                // Some share one vector: passages tied by meaning, in
                // both stores.
                vector: vectorOf(
                  index % 4 <= 1 ? "tied" : `${index}:${change}`
                ),
              },
            ],
          });
        }
      }
      // An ID many passages hold, but not as written: more than
      // `exactCandidatesMax` of them only once both halves are counted.
      await Promise.all(
        [true, false].map(async (ownedHere) => {
          const store = ownedHere ? privately : shared();
          await store.addSource({
            source: `${setup.prefix}:long-${ownedHere ? "own" : "all"}`,
            change,
            text: longTextOf(ownedHere ? 0 : 1),
            access: ownedHere
              ? { kind: "owner", person: setup.reader.person }
              : { kind: "audience", group: setup.reader.groups[0] ?? "" },
          });
        })
      );
    };
    // What no reader here may read: the same words, IDs and nearness.
    for (const [index, text] of texts.slice(0, 6).entries()) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await shared().addSource({
        source: `hidden:${index}`,
        change: "1",
        text,
        access: nobody,
      });
      // oxlint-disable-next-line no-await-in-loop -- in order
      await shared().putVectors({
        model: { name: splitModelName, centre: splitCentre },
        vectors: [
          {
            chunk: { source: `hidden:${index}`, version: 1, position: 0 },
            vector: vectorOf(`hidden:${index}`),
          },
        ],
      });
    }
    // One store; then two; then, past a moment, second versions of some.
    await addAll(one, shared(), "1", () => true);
    await addAll(two, own(), "1", () => true);
    await moment();
    const between = new Date();
    await moment();
    await addAll(one, shared(), "2", revised);
    await addAll(two, own(), "2", revised);

    const requests = splitQuestions.flatMap((question) =>
      [whole, { tokens: 150 }].flatMap((budget) => [
        {
          question,
          budget,
          meaning: { model: splitModel, vector: vectorOf(question) },
        },
        { question, budget, asOf: between },
      ])
    );
    const packs = await Promise.all(
      requests.map(async (asking) => {
        const [single, mine, everyone] = await Promise.all([
          called(shared().recall({ ...asking, reader: one.reader })),
          called(own().find({ ...asking, reader: two.reader })),
          called(shared().find({ ...asking, reader: two.reader })),
        ]);
        const split = packAcross(asking.question, asking.budget.tokens, [
          everyone,
          mine,
        ]);
        return {
          single,
          split: {
            ...split,
            items: split.items.map((item) => ({
              ...item,
              source: item.source.replace(/^b:/u, "a:"),
            })),
          },
        };
      })
    );
    expect(packs.map(({ split }) => split)).toStrictEqual(
      packs.map(({ single }) => single)
    );
    // What each way had to merge was there to merge.
    const found = new Set(
      packs.flatMap(({ single }) => single.items.map((item) => item.found))
    );
    expect([...found].toSorted()).toStrictEqual([
      "exact",
      "meaning",
      "stop words",
      "words",
    ]);
  });

  // Threat 7: no file, count or sweep shared between a person's store and another.
  it("keeps its files under a prefix of its own, so the same text kept twice is two files", async () => {
    const text = `The same text, kept twice ${crypto.randomUUID()}`;
    await add(own(), text, theirs());
    await add(shared(), text, { kind: "audience", group: "company" });
    const hash = await sha256(text);

    await expect(
      keysUnder(`${await ownPrefix()}sources/`)
    ).resolves.toStrictEqual([`${await ownPrefix()}sources/${hash}`]);
    await expect(keysUnder(`sources/${hash}`)).resolves.toStrictEqual([
      `sources/${hash}`,
    ]);
  });

  it("erased whole, leaves the shared store's copy of the same text readable", async () => {
    const text = `The same text, kept twice ${crypto.randomUUID()}`;
    await add(own(), text, theirs());
    const everyone = await add(shared(), text, {
      kind: "audience",
      group: "company",
    });

    await eraseWhole();

    await expect(
      keysUnder(`${await ownPrefix()}sources/`)
    ).resolves.toStrictEqual([]);
    await expect(
      shared().readVersion({
        ...everyone,
        reader: { person: "anyone", groups: ["company"] },
      })
    ).resolves.toMatchObject({ text });
  });

  // Threat 6: an erased store comes back by a late add.
  it("once erased whole, answers its person as a store holding nothing does, refuses every add, a late add after a restart included, and makes nothing", async () => {
    const kept = await add(own(), "Before the erasure", theirs());
    await eraseWhole();
    const erased = /this store was erased/u;
    const reader = me();

    expect({
      found: await called(
        own().find({ question: "Before", reader, budget: whole })
      ),
      version: await called(
        own().readVersion({ source: kept.source, version: 1, reader })
      ),
      current: await called(
        own().readCurrent({ sources: [kept.source], reader })
      ),
      // It holds nothing, the key it once held included.
      holds: await called(own().holdsSource(kept.source)),
      // Erasing one of its sources after it: nothing is left to erase.
      sourceErased: await called(
        own().eraseSource({ source: kept.source, reason: "deleted" })
      ).then(() => "erased"),
    }).toStrictEqual({
      found: nothingFound,
      version: null,
      current: [],
      holds: false,
      sourceErased: "erased",
    });
    await expect(add(own(), "A late add", theirs())).rejects.toThrow(erased);
    await kill(own());
    await expect(add(own(), "A later add", theirs())).rejects.toThrow(erased);
    await expect(tablesOf(own())).resolves.toStrictEqual([]);
  });

  // Threat 5: a restore of its storage from before the erasure.
  it("once erased whole, deletes what a restore brings back before it answers", async () => {
    await add(own(), "Before the erasure", theirs());
    const backup = await copyOf(own());
    await eraseWhole();

    await restore(own(), backup);
    await expect(
      called(own().find({ question: "Before", reader: me(), budget: whole }))
    ).resolves.toStrictEqual(nothingFound);
    await expect(tablesOf(own())).resolves.toStrictEqual([]);

    // Erasing again is safe, and keeps only the record of it.
    await eraseWhole();
    await expect(keysUnder(await ownPrefix())).resolves.toStrictEqual([
      `${await ownPrefix()}erased`,
    ]);
  });

  it("deletes its vectors too, and nothing outside its prefix", async () => {
    await add(own(), "Theirs", theirs());
    const vector = `${await ownPrefix()}vectors/${encodeURIComponent(vectorModelNameOf({ name: "m", build: "1" }))}/abc`;
    await env.BRAIN_OBJECTS.put(vector, new Uint8Array([1]));
    const elsewhere = `people/${await sha256(`other-${person}`)}/sources/abc`;
    await env.BRAIN_OBJECTS.put(elsewhere, "someone else's");

    await eraseWhole();

    await expect(
      keysUnder(`${await ownPrefix()}vectors/`)
    ).resolves.toStrictEqual([]);
    await expect(keysUnder(elsewhere)).resolves.toStrictEqual([elsewhere]);
  });

  // Partial failure: nothing reads as done that wasn't.
  it("deletes nothing when the record of its erasure can't be written, and says so", async () => {
    const kept = await add(own(), "Still theirs", theirs());
    const { heal } = await breakBucket(own(), ["put"]);

    await expect(
      called(own().erasePerson({ person, reason: "person_erased" }))
    ).rejects.toThrow(/could not record the erasure/u);
    await heal();

    await expect(
      own().readVersion({ ...kept, reader: me() })
    ).resolves.toMatchObject({ text: "Still theirs" });
  });

  it("answers that it is still deleting until its files are gone, and only then that it is erased", async () => {
    await add(own(), "Theirs", theirs());
    const { heal } = await breakBucket(own(), ["delete"]);

    await expect(
      called(own().erasePerson({ person, reason: "person_erased" }))
    ).rejects.toThrow(/still deleting its files/u);
    await expect(
      keysUnder(`${await ownPrefix()}sources/`)
    ).resolves.toHaveLength(1);
    // Erased already: it finds nothing meanwhile.
    await expect(
      called(own().find({ question: "Theirs", reader: me(), budget: whole }))
    ).resolves.toStrictEqual(nothingFound);
    await heal();

    await eraseWhole();
    await expect(
      keysUnder(`${await ownPrefix()}sources/`)
    ).resolves.toStrictEqual([]);
  });

  // Partial failure: an add under way as the erasure runs writes after it.
  it("is not erased while an add under way may still write a file, and is once it has ended", async () => {
    const { reached, release } = await holdFileWrites(own());
    const adding = Promise.allSettled([add(own(), "Late file", theirs())]);
    await reached;

    await expect(
      called(own().erasePerson({ person, reason: "person_erased" }))
    ).rejects.toThrow(/still deleting its files/u);
    release();
    const [outcome] = await adding;
    // Refused as an erased store refuses, never in the database's words.
    expect(
      outcome?.status === "rejected" ? String(outcome.reason) : "added"
    ).toBe("Error: The Brain refused it: this store was erased");

    await eraseWhole();
    await expect(keysUnder(await ownPrefix())).resolves.toStrictEqual([
      `${await ownPrefix()}erased`,
    ]);
  });

  it("wakes itself while it has work, and sleeps once it has none", async () => {
    await add(own(), "Work for its queue", theirs());
    await expect(alarmOf(own())).resolves.not.toBeNull();

    await expect(runDurableObjectAlarm(own())).resolves.toBeTruthy();
    const overview = await own().workOverview();
    expect(overview.waiting).toStrictEqual([]);
    await expect(alarmOf(own())).resolves.toBeNull();
  });

  it("sets no alarm once erased whole", async () => {
    await add(own(), "Work for its queue", theirs());
    await eraseWhole();

    await expect(alarmOf(own())).resolves.toBeNull();
  });

  // Partial failure: a tick that can't run still wakes the store again.
  it("wakes itself again when its alarm's tick couldn't read its ledger", async () => {
    await add(own(), "Work for its queue", theirs());
    // An entry of the ledger this release can't read: the store refuses
    // every call until it can (erasure.ts `replayStep`).
    await env.BRAIN_OBJECTS.put(`${await ownPrefix()}erasures/unreadable`, "");
    await kill(own());

    await expect(runDurableObjectAlarm(own())).resolves.toBeTruthy();
    await expect(alarmOf(own())).resolves.not.toBeNull();
    await expect(
      called(own().recall({ question: "Work", reader: me(), budget: whole }))
    ).rejects.toThrow(/can't read its erasure ledger/u);
  });

  it("wakes itself for its queue once the queue's pause is over, not before", async () => {
    await add(own(), "Before the pause", theirs());
    const until = Date.now() + 20 * 60_000;
    // The queue's model said to wait (work.ts rule 1), as its bucket keeps it.
    await runInDurableObject(own(), async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO work_model_bucket (id, tokens, at, paused_until)
        VALUES (1, 0, ?1, ?2)
        ON CONFLICT (id) DO UPDATE SET paused_until = ?2`,
        Date.now(),
        until
      );
      const removed = state.storage.deleteAlarm();
      await removed;
    });

    await add(own(), "During the pause", theirs());
    await expect(alarmOf(own())).resolves.toBeGreaterThanOrEqual(until);
  });

  // The ledger of what it erased goes with it: only the record stays.
  it("erased whole after one of its sources was, keeps nothing but the record of it", async () => {
    const kept = await add(own(), "Erased first", theirs());
    await add(own(), "Erased with the store", theirs());
    await own().eraseSource({ source: kept.source, reason: "deleted" });
    await expect(
      keysUnder(`${await ownPrefix()}erasures/`)
    ).resolves.not.toStrictEqual([]);

    await eraseWhole();

    await expect(keysUnder(await ownPrefix())).resolves.toStrictEqual([
      `${await ownPrefix()}erased`,
    ]);
    await expect(
      called(own().find({ question: "Erased", reader: me(), budget: whole }))
    ).resolves.toStrictEqual(nothingFound);
  });

  // Threat 6: a first add reads the ledger before anything is made.
  it("makes nothing at its first add while it can't read its ledger", async () => {
    const { heal } = await breakBucket(own(), ["list"]);

    await expect(add(own(), "Their first", theirs())).rejects.toThrow(
      /can't read its erasure ledger/u
    );
    await expect(tablesOf(own())).resolves.toStrictEqual([]);
    await heal();
  });

  // Partial failure: an add of an instance reset meanwhile, no longer
  // seen as under way, writes its file after the erasure listed the prefix.
  it("is not erased until an add of an earlier instance can no longer write a file", async () => {
    await add(own(), "Theirs", theirs());
    const stillDeleting = /still deleting its files/u;
    await expect(
      called(own().erasePerson({ person, reason: "person_erased" }))
    ).rejects.toThrow(stillDeleting);
    await kill(own());
    const late = `${await ownPrefix()}sources/late`;
    await env.BRAIN_OBJECTS.put(late, "written late");

    await expect(
      called(own().erasePerson({ person, reason: "person_erased" }))
    ).rejects.toThrow(stillDeleting);
    await ageErasure();
    await own().erasePerson({ person, reason: "person_erased" });
    await expect(keysUnder(await ownPrefix())).resolves.toStrictEqual([
      `${await ownPrefix()}erased`,
    ]);
  });

  // Threat 5: a restored copy shows staff nothing of what it holds
  // before it has read whether it was erased.
  it("shows nothing of what a restore brought back while it can't read whether it was erased", async () => {
    await add(own(), "Queued before the erasure", theirs());
    const backup = await copyOf(own());
    await eraseWhole();
    const bucket = env.BRAIN_OBJECTS;
    Reflect.set(env, "BRAIN_OBJECTS", failingHeads(bucket));
    try {
      await restore(own(), backup);
      const overview = await own().workOverview();
      expect({
        waiting: overview.waiting,
        bytes: overview.storeBytes,
        ledger: overview.ledgerReplay,
      }).toStrictEqual({ waiting: [], bytes: 0, ledger: "unreadable" });
    } finally {
      Reflect.set(env, "BRAIN_OBJECTS", bucket);
    }
  });

  // Threat 1: an alarm on an instance reached without its name.
  it("ends an instance without its name when its alarm runs, so a call by name is answered", async () => {
    const named = env.BRAIN_STORE.idFromName(`person:${person}`);
    const unnamed = env.BRAIN_STORE.get(
      env.BRAIN_STORE.idFromString(named.toString())
    );
    await runInDurableObject(unnamed, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await Promise.allSettled([called(runDurableObjectAlarm(unnamed))]);

    const kept = await add(own(), "Theirs, by name", theirs());
    await expect(
      own().readVersion({ ...kept, reader: me() })
    ).resolves.toMatchObject({ text: "Theirs, by name" });
  });
});

/** A model that answers nothing: no work here asks one. */
const quietAsk: AskModel = async () => {
  await Promise.resolve();
  return { kind: "answer", text: "" };
};

/** The host's embedders while no model ships. */
const noModel: Embedders = {
  model: null,
  embed: async () => {
    await Promise.resolve();
    return { kind: "unavailable" };
  },
};

/**
 * No side of hand-overs: a person's own store never queues one, so a tick
 * of it is given one that hands nothing over.
 */
const noHandOvers: HandOvers = {
  handOver: async () => {
    await Promise.resolve();
    return { kind: "nothing" };
  },
};

/** A tick of this test's person's store, as its alarm runs one with no model. */
const tick = async (): Promise<void> => {
  await own().work({
    ask: quietAsk,
    at: new Date(),
    embedders: noModel,
    handOvers: noHandOvers,
  });
};

/** Runs `change` in this test's person's store, in its own storage. */
const inStore = async (change: (sql: SqlStorage) => void): Promise<void> => {
  await runInDurableObject(own(), (_instance, state) => {
    change(state.storage.sql);
  });
};

/** The store's alarm taken away, as once it has fired. */
const noAlarm = async (): Promise<void> => {
  await runInDurableObject(own(), async (_instance, state) => {
    await state.storage.deleteAlarm();
  });
};

/**
 * A person's store with a source kept and all its work done, as a host
 * with no model leaves it, and no alarm: the source's ref.
 */
const settled = async (): Promise<{ source: string; version: number }> => {
  const kept = await add(own(), "Settled and done", theirs());
  await tick();
  await noAlarm();
  return kept;
};

/** The model the store last saw is `name`, its walk over, as a tick with it leaves it. */
const sawModel = async (name: string): Promise<void> => {
  await inStore((sql) => {
    sql.exec(
      `INSERT INTO embedding_state (id, model, walked_to, walked, rebuilt)
      VALUES (1, ?1, 0, 1, 1)
      ON CONFLICT (id) DO UPDATE SET model = ?1, walked = 1, rebuilt = 1`,
      name
    );
  });
};

/** Each public method of the store, its own and any it inherits, but the runtime's handlers. */
const storeMethods = (): string[] => {
  const names = new Set<string>();
  for (
    let prototype: unknown = BrainStore.prototype;
    prototype !== DurableObject.prototype &&
    typeof prototype === "object" &&
    prototype !== null;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      names.add(name);
    }
  }
  names.delete("constructor");
  names.delete("alarm");
  return [...names].toSorted();
};

/**
 * For each method that can leave a person's store work for a tick: a
 * settled store with no alarm made to have work by it.
 */
const leavingWork: Record<string, () => Promise<void>> = {
  addSource: async () => {
    await add(own(), "A source to embed", theirs());
  },
  // Failed: its file is noted before it is written, and nothing holds it.
  addInstructions: async () => {
    const { heal } = await breakBucket(own(), ["put"]);
    await Promise.allSettled([
      called(
        own().addInstructions({
          source: "instructions:failed",
          change: "1",
          text: "Never written",
          access: theirs(),
        })
      ),
    ]);
    await heal();
  },
  eraseSource: async () => {
    const kept = await add(own(), "To erase", theirs());
    await tick();
    await noAlarm();
    await own().eraseSource({ source: kept.source, reason: "deleted" });
  },
  // A tick that deletes an erased version lets its file go to the sweep.
  work: async () => {
    const kept = await add(own(), "Erased, then swept", theirs());
    await own().eraseSource({ source: kept.source, reason: "deleted" });
    await noAlarm();
    await tick();
  },
  reembed: async () => {
    await sawModel("m@1");
    await own().reembed();
  },
  requeueWork: async () => {
    await add(own(), "Parked for good", theirs());
    let parked = 0;
    await inStore((sql) => {
      parked = sql
        .exec<{ id: number }>(
          `UPDATE work_items SET parked_at = ?1, parks = 3
          RETURNING id`,
          Date.now()
        )
        .one().id;
    });
    await noAlarm();
    await own().requeueWork(parked);
  },
  rebuildWords: async () => {
    await own().rebuildWords();
  },
  // Vectors of a build other than the one the store saw: to remove.
  putVectors: async () => {
    const kept = await add(own(), "With a vector", theirs());
    await tick();
    await sawModel("m@1");
    await noAlarm();
    await own().putVectors({
      model: { name: "other@1", centre: [0, 0] },
      vectors: [{ chunk: { ...kept, position: 0 }, vector: [1, 0] }],
    });
  },
};

/**
 * The methods that only read, or take work away (`erasePerson` erases it
 * all), or that a person's own store refuses (`handOver`: the shared
 * store's alone).
 */
const leavingNone = [
  "erasePerson",
  "find",
  "handOver",
  "holdsSource",
  "listSources",
  "listVersions",
  "readCurrent",
  "readVersion",
  "recall",
  "repackVectors",
  "searchVectors",
  "workOverview",
];

describe("a person's own store's alarm", () => {
  beforeEach(() => {
    person = `person-${crypto.randomUUID()}`;
  });

  it("knows of every public method whether it can leave work", () => {
    expect(storeMethods()).toStrictEqual(
      [...Object.keys(leavingWork), ...leavingNone].toSorted()
    );
  });

  it("is armed after every method that leaves work, though the store had none", async () => {
    const armed: Record<string, boolean> = {};
    for (const [method, leave] of Object.entries(leavingWork)) {
      person = `person-${crypto.randomUUID()}`;
      // oxlint-disable-next-line no-await-in-loop -- one store at a time
      await settled();
      // oxlint-disable-next-line no-await-in-loop -- one store at a time
      await leave();
      // oxlint-disable-next-line no-await-in-loop -- one store at a time
      armed[method] = (await alarmOf(own())) !== null;
    }
    expect(armed).toStrictEqual(
      Object.fromEntries(Object.keys(leavingWork).map((name) => [name, true]))
    );
  });

  it("is not armed while the store has nothing to do: no model shipped, a model seen and done, or a paused queue with nothing in it", async () => {
    const asleep: Record<string, number | null> = {};
    await settled();
    await own().repackVectors();
    asleep.noModel = await alarmOf(own());

    await sawModel("m@1");
    await own().repackVectors();
    asleep.modelDone = await alarmOf(own());

    await inStore((sql) => {
      sql.exec(
        `INSERT INTO work_model_bucket (id, tokens, at, paused_until)
        VALUES (1, 0, ?1, ?2)
        ON CONFLICT (id) DO UPDATE SET paused_until = ?2`,
        Date.now(),
        Date.now() + 20 * 60_000
      );
    });
    await tick();
    asleep.paused = await alarmOf(own());
    expect(asleep).toStrictEqual({
      noModel: null,
      modelDone: null,
      paused: null,
    });
  });

  // A store that can't read whether it was erased answers as it would,
  // never with what its database says.
  it("answers each call as it would while it can't read whether it was erased, never with a database error", async () => {
    const bucket = env.BRAIN_OBJECTS;
    Reflect.set(env, "BRAIN_OBJECTS", failingHeads(bucket));
    try {
      const calls: (() => Promise<unknown>)[] = [
        async () => await own().rebuildWords(),
        async () => await own().reembed(),
        async () => await own().requeueWork(1),
        async () =>
          await own().addSource({
            source: "test:refused",
            change: "1",
            text: "Not yet",
            access: theirs(),
          }),
        async () =>
          await own().recall({
            question: "Not yet",
            reader: me(),
            budget: whole,
          }),
      ];
      const outcomes: string[] = [];
      for (const call of calls) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one call at a time
          outcomes.push(JSON.stringify(await call()));
        } catch (error) {
          outcomes.push(String(error));
        }
      }
      expect(
        outcomes.map((outcome) => outcome.replace(/^Error: /u, ""))
      ).toStrictEqual([
        '"unavailable"',
        '"unavailable"',
        '"unavailable"',
        expect.stringContaining("can't read its erasure ledger"),
        expect.stringContaining("can't read its erasure ledger"),
      ]);
    } finally {
      Reflect.set(env, "BRAIN_OBJECTS", bucket);
    }
  });

  // An add whose instance was reset after its file was noted (`refs = 0`,
  // the write not yet answered): the next instance wakes for the file
  // nothing holds, at its start.
  it("is armed when an instance starts after an add was cut off mid-write", async () => {
    await settled();
    await inStore((sql) => {
      sql.exec(
        "INSERT INTO files (hash, refs, written_at) VALUES ('cut-off', 0, ?)",
        Date.now()
      );
    });
    await kill(own());

    await own().find({ question: "Cut off", reader: me(), budget: whole });
    await expect(alarmOf(own())).resolves.not.toBeNull();
  });

  // A restore from before an erasure: the start replays it, and wakes for
  // the versions it hid.
  it("is armed when an instance starts and replays an erasure its storage lacks", async () => {
    const kept = await settled();
    const backup = await copyOf(own());
    await own().eraseSource({ source: kept.source, reason: "deleted" });
    await tick();
    await noAlarm();

    await restore(own(), backup);
    await own().find({ question: "Settled", reader: me(), budget: whole });
    await expect(alarmOf(own())).resolves.not.toBeNull();
  });

  it("is not armed when an instance starts with nothing left to do", async () => {
    await settled();
    await kill(own());

    await own().find({ question: "Settled", reader: me(), budget: whole });
    await expect(alarmOf(own())).resolves.toBeNull();
  });

  // The walk's last step: once its items are all settled, a tick marks the
  // rebuild done. Not while one it put there is parked for good.
  it("is armed to mark a walk's rebuild done, but not while a rebuild item is parked for good", async () => {
    await settled();
    await sawModel("m@1");
    await inStore((sql) => {
      sql.exec("UPDATE embedding_state SET rebuilt = 0");
    });
    await own().repackVectors();
    const marking = await alarmOf(own());

    person = `person-${crypto.randomUUID()}`;
    await add(own(), "Rebuilt, then parked for good", theirs());
    await inStore((sql) => {
      sql.exec(
        `UPDATE work_items SET payload = json_set(payload, '$.rebuild', json('true')),
          parked_at = ?, parks = 3`,
        Date.now()
      );
    });
    await sawModel("m@1");
    await inStore((sql) => {
      sql.exec("UPDATE embedding_state SET rebuilt = 0");
    });
    await noAlarm();
    await own().repackVectors();
    expect({
      marking: marking !== null,
      parked: await alarmOf(own()),
    }).toStrictEqual({
      marking: true,
      parked: null,
    });
  });

  // An old model's drop is over and its vectors are let go: the sweep's.
  it("is armed for vectors a dropped model let go", async () => {
    await settled();
    await sawModel("m@1");
    await inStore((sql) => {
      sql.exec(
        `INSERT INTO vector_files (model, hash, written_at, in_doubt_until, unheld)
        VALUES ('old@1', 'let-go', ?, NULL, 1)`,
        Date.now()
      );
    });
    await own().repackVectors();
    await expect(alarmOf(own())).resolves.not.toBeNull();
  });

  // A call that did what it was asked but couldn't set the alarm says so in
  // its own words, never the storage's; repeating it is safe.
  it("answers that it did it but couldn't schedule what is left, and a repeat answers the same version", async () => {
    await runInDurableObject(own(), (_instance, state) => {
      Reflect.set(state.storage, "setAlarm", async () => {
        await Promise.resolve();
        throw new Error("Broken by the test: SQLITE_ERROR in the bucket");
      });
    });
    const adding = {
      source: "test:unscheduled",
      change: "1",
      text: "Left to embed",
      access: theirs(),
    };
    let answer = "";
    try {
      await own().addSource(adding);
      answer = "added";
    } catch (error) {
      answer = String(error).replace(/^Error: /u, "");
    }
    await kill(own());

    expect({ answer, again: await own().addSource(adding) }).toStrictEqual({
      answer:
        "The Brain did it but couldn't schedule what it left to finish: try again",
      again: { source: adding.source, version: 1 },
    });
  });
});

/** Puts the same `vector` for the first chunk of each of `sources`' first versions. */
const putTied = async (
  store: Store,
  sources: readonly string[],
  vector: number[]
): Promise<void> => {
  await store.putVectors({
    model: { name: splitModelName, centre: splitCentre },
    vectors: sources.map((source) => ({
      chunk: { source, version: 1, position: 0 },
      vector,
    })),
  });
};

/**
 * Every version of `sources` in `store` added at `at`, as within one
 * millisecond: no two adds can be made to land in one here. Versions are
 * never updated (a trigger refuses it), so the trigger is lifted for this
 * one statement and put back as it was.
 */
const addedAtOnce = async (
  store: Store,
  sources: readonly string[],
  at: number
): Promise<void> => {
  await runInDurableObject(store, (_instance, state) => {
    const { sql } = state.storage;
    state.storage.transactionSync(() => {
      const triggers = sql
        .exec<{ name: string; sql: string }>(
          `SELECT name, sql FROM sqlite_master
          WHERE type = 'trigger' AND tbl_name = 'source_versions'
            AND sql LIKE '%BEFORE UPDATE%'`
        )
        .toArray();
      for (const { name } of triggers) {
        sql.exec(`DROP TRIGGER "${name}"`);
      }
      sql.exec(
        `UPDATE source_versions SET added_at = ?1
        WHERE source IN (SELECT value FROM json_each(?2))`,
        at,
        JSON.stringify(sources)
      );
      for (const { sql: created } of triggers) {
        sql.exec(created);
      }
    });
  });
};

describe("recall by meaning across stores", () => {
  beforeEach(() => {
    person = `person-${crypto.randomUUID()}`;
  });

  // More passages tied by meaning than recall keeps, added within one
  // millisecond in the reverse of their sources' order: which are kept
  // is decided by the tie order alone, in one store as across two.
  it("keeps the same tied passages in one store as across two", async () => {
    const count = 14;
    const names = Array.from(
      { length: count },
      (_, index) => `z${String(count - 1 - index).padStart(2, "0")}`
    );
    const one = { person: `one-${person}`, groups: [`one-${person}`] };
    const two = { person, groups: [`two-${person}`] };
    const vector = [1, 0, 0, 0, 0, 0, 0, 0];
    for (const [index, name] of names.entries()) {
      const text = `Passage ${name} of the tied set`;
      // oxlint-disable-next-line no-await-in-loop -- in order: rows follow it
      await shared().addSource({
        source: `a:${name}`,
        change: "1",
        text,
        access: { kind: "audience", group: one.groups[0] ?? "" },
      });
      // oxlint-disable-next-line no-await-in-loop -- in order: rows follow it
      await (index % 2 === 0 ? own() : shared()).addSource({
        source: `b:${name}`,
        change: "1",
        text,
        access:
          index % 2 === 0
            ? theirs()
            : { kind: "audience", group: two.groups[0] ?? "" },
      });
    }
    const ofOne = names.map((name) => `a:${name}`);
    const ofTwo = names.map((name) => `b:${name}`);
    const ownSources = ofTwo.filter((_, index) => index % 2 === 0);
    const sharedSources = ofTwo.filter((_, index) => index % 2 === 1);
    const at = Date.now();
    await putTied(shared(), [...ofOne, ...sharedSources], vector);
    await putTied(own(), ownSources, vector);
    await addedAtOnce(shared(), [...ofOne, ...sharedSources], at);
    await addedAtOnce(own(), ownSources, at);

    const asking = {
      question: "elephant",
      budget: whole,
      meaning: { model: splitModel, vector },
    };
    const single = await called(shared().recall({ ...asking, reader: one }));
    const split = packAcross(asking.question, asking.budget.tokens, [
      await called(shared().find({ ...asking, reader: two })),
      await called(own().find({ ...asking, reader: two })),
    ]);
    expect({
      ...split,
      items: split.items.map((item) => ({
        ...item,
        source: item.source.replace(/^b:/u, "a:"),
      })),
    }).toStrictEqual(single);
    // The first by their sources, not the first added.
    expect(single.items.map(({ source }) => source)).toStrictEqual(
      ofOne.toSorted().slice(0, single.items.length)
    );
  });
});
