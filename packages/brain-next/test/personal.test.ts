// A person's own store (store.ts, GRA-1762): what only one person may
// read, kept apart from everything else. Each test in stores of its own
// names. The threat model is on GRA-1762; each test names the threat it
// holds.
import type { Access, Reader } from "@grasp-os/brain-next/contract";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { packAcross } from "../src/across.ts";
import {
  personalBrainOf,
  recallBudgetMax,
  vectorModelNameOf,
} from "../src/contract.ts";
import type { BrainStore } from "../src/store.ts";

/** A store, as its namespace gives it. */
type Store = DurableObjectStub<BrainStore>;

/** This test's person, and their own store, named as `personalBrainOf` names it. */
let person = "";
const own = (): Store => env.BRAIN_STORE.getByName(`person:${person}`);

/** A store shared by this test alone. */
let sharedName = "";
const shared = () => env.BRAIN_STORE.getByName(sharedName);

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
    sharedName = `shared-${crypto.randomUUID()}`;
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

  it("answers its person, before its first write, as a store holding nothing does", async () => {
    const reader = me();
    const asked = { question: "Where is the invoice PO-12345?", budget: whole };
    const expected = await env.BRAIN_STORE.getByName(
      `empty-${crypto.randomUUID()}`
    ).recall({ ...asked, reader });

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
  it("packs what it and a shared store find as one store holding both would", async () => {
    const random = seeded(1762);
    // Each word in more than one form, and stop words, so passages tie on
    // what they hold and part on how they hold it.
    const words = [
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
    const single = env.BRAIN_STORE.getByName(`single-${crypto.randomUUID()}`);
    const reader = { person, groups: ["company"] };
    for (let index = 0; index < 40; index += 1) {
      // A length of its own, so passages never tie on what follows it.
      const text = [
        ...Array.from({ length: 3 + index }, () => words[random(words.length)]),
        index % 5 === 0 ? `PO-${10_000 + index}` : "",
      ]
        .join(" ")
        .trim();
      const source = `test:${index}`;
      const access: Access =
        random(2) === 0 ? theirs() : { kind: "audience", group: "company" };
      // oxlint-disable-next-line no-await-in-loop -- in order, as one store would take them
      await single.addSource({ source, change: "1", text, access });
      // oxlint-disable-next-line no-await-in-loop -- in order, as one store would take them
      await (access.kind === "owner" ? own() : shared()).addSource({
        source,
        change: "1",
        text,
        access,
      });
    }
    const questions = [
      "invoice budget",
      "the invoices and budgets",
      "travel salary PO-10000",
      "PO-10005 and PO-99999",
      "laptop office meeting contract",
      "nothing here",
    ];
    const packs = await Promise.all(
      questions.flatMap((question) =>
        [whole, { tokens: 120 }].map(async (budget) => {
          const request = { question, reader, budget };
          const [one, mine, everyone] = await Promise.all([
            single.recall(request),
            own().find(request),
            shared().find(request),
          ]);
          return {
            one,
            split: packAcross(question, budget.tokens, [everyone, mine]),
          };
        })
      )
    );
    expect(packs.map(({ split }) => split)).toStrictEqual(
      packs.map(({ one }) => one)
    );
    expect(packs.some(({ one }) => one.items.length > 3)).toBeTruthy();
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

    await own().erasePerson({ person, reason: "person_erased" });

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
    await own().erasePerson({ person, reason: "person_erased" });
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
    await own().erasePerson({ person, reason: "person_erased" });

    await restore(own(), backup);
    await expect(
      called(own().find({ question: "Before", reader: me(), budget: whole }))
    ).resolves.toStrictEqual(nothingFound);
    await expect(tablesOf(own())).resolves.toStrictEqual([]);

    // Erasing again is safe, and keeps only the record of it.
    await own().erasePerson({ person, reason: "person_erased" });
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

    await own().erasePerson({ person, reason: "person_erased" });

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

    await own().erasePerson({ person, reason: "person_erased" });
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

    await own().erasePerson({ person, reason: "person_erased" });
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
    await own().erasePerson({ person, reason: "person_erased" });

    await expect(alarmOf(own())).resolves.toBeNull();
  });
});
