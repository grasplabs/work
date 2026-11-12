// A person's own store (store.ts, GRA-1762): what only one person may
// read, kept apart from everything else. Under the names the host uses:
// `brain` for the shared store, `person:<id>` for a person's own. Each
// test has a person, readers and texts of its own, so what earlier tests
// left in the shared store is hidden from it: emptying storage between
// tests (`reset`) crashed workerd here, beside the tests that swap a
// store's bucket. The threat model is on GRA-1762; each test names the
// threat it holds.
import type { Access, Reader } from "@grasp-os/brain-next/contract";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
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
import type { BrainStore } from "../src/store.ts";

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
 * `copy` put back as all `store` holds, as a restore of its storage
 * would, the bucket untouched, and the store killed, as a restore
 * restarts it.
 */
const restore = async (store: Store, copy: Copy): Promise<void> => {
  await runInDurableObject(store, (_instance, state) => {
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
                vector: vectorOf(`${index}:${change}`),
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
      // Erasing one of its sources after it: nothing is left to erase.
      sourceErased: await called(
        own().eraseSource({ source: kept.source, reason: "deleted" })
      ).then(() => "erased"),
    }).toStrictEqual({
      found: nothingFound,
      version: null,
      current: [],
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
    expect(outcome?.status).toBe("rejected");

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
