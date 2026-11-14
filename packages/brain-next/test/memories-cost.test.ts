import type {
  NewEntity,
  NewMemory,
  Reader,
} from "@grasp-os/brain-next/contract";
import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { recallLimit } from "../src/contract.ts";
import { audience, fact, readerOf, word } from "./entity-helpers.ts";

// What reading memories costs the store, against what the question is not
// about. Statements over memories (memories.ts `memoriesSql`) and the
// entities way (recall-memories.ts) read the memories they are asked
// about, through the indexes: never a scan of the whole table, so other
// memories, readable or hidden, cost a read nothing. Held by cost, as
// recall-cost.test.ts holds the search ways: the rows the store's SQL
// reads, as workerd counts them (each cursor's `rowsRead`), through the
// store's public methods, must stay flat as unrelated memories are added:
// within `seekMargin` rows, what an index seek touches more as the trees
// grow deeper (measured: 3 rows after 1,000 memories, 3 after 2,000),
// where a scan of them would read a row or more for each. And the entities
// way reads no further step once the nearer steps fill its list: facts
// added two steps out cost it nothing either. An add links its names by
// their exact names (linking.ts `linkedByName`): what it reads is the
// same however many names the store holds.

/** Rows the store's SQL read, counted at the store itself. */
interface Counter {
  rows: () => number;
  reset: () => void;
}

/** The counters of the stores of this file, by their object's id. */
const counters = new Map<string, Counter>();

/** The shared store, from empty storage, its SQL's reads counted. */
const countedStore = async () => {
  await reset();
  const stub = env.BRAIN_STORE.getByName("brain");
  // The store woken and its SQL wrapped once: every cursor its statements
  // open is kept, and their rows read summed when asked.
  await runInDurableObject(stub, (_instance, state) => {
    const { sql } = state.storage;
    const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
    const exec = sql.exec.bind(sql);
    Object.defineProperty(sql, "exec", {
      value: (...args: Parameters<typeof sql.exec>) => {
        const cursor = exec(...args);
        cursors.push(cursor);
        return cursor;
      },
    });
    counters.set(stub.id.toString(), {
      rows: () => cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      reset: () => {
        cursors.length = 0;
      },
    });
  });
  /** The rows `ask` has the store's SQL read. */
  const rowsReadBy = async (ask: () => Promise<unknown>): Promise<number> => {
    const counter = counters.get(stub.id.toString());
    counter?.reset();
    await ask();
    return counter?.rows() ?? Number.NaN;
  };
  return { stub, rowsReadBy };
};

type Store = Awaited<ReturnType<typeof countedStore>>["stub"];

/**
 * Rows an index seek may read more as the indexes grow deeper: a scan of
 * what was added would read 1,000 or more here, a hub's relations 4,900,
 * the far step's read 60.
 */
const seekMargin = 8;

/** How many names alike the named-entity tests add, in all. */
const namedSizes = [100, 5000, 20_000];

/** Whether `rows` is within `seekMargin` of `alone`, and never fewer. */
const flat = (alone: number, rows: number): boolean =>
  rows >= alone && rows - alone <= seekMargin;

/**
 * Adds `count` memories about entities of their own, each with a name of
 * its own (in the index of names, as any person's), readable by `group`,
 * a hundred an add.
 */
const unrelated = async (
  stub: Store,
  group: string,
  count: number
): Promise<void> => {
  for (let start = 0; start < count; start += 100) {
    const keys = Array.from({ length: 100 }, (_, index) => `u${index}`);
    // oxlint-disable-next-line no-await-in-loop -- one add at a time
    await stub.addMemories({
      change: crypto.randomUUID(),
      access: audience(group),
      entities: keys.map((key) => ({ key, kind: "person", names: [word()] })),
      memories: keys.map((key) => fact(key, `unrelated ${start} ${key}`)),
    });
  }
};

/**
 * The rows `ask` reads alone, then with `sizes` (in all) unrelated
 * memories, half readable by `group` and half hidden from the reader.
 */
const rowsAsUnrelatedGrow = async (
  stub: Store,
  rowsReadBy: (ask: () => Promise<unknown>) => Promise<number>,
  group: string,
  ask: () => Promise<unknown>
): Promise<number[]> => {
  const hidden = `hidden-${crypto.randomUUID()}`;
  const rows = [await rowsReadBy(ask)];
  let have = 0;
  for (const size of [1000, 5000, 20_000]) {
    // oxlint-disable-next-line no-await-in-loop -- one size at a time
    await unrelated(stub, group, (size - have) / 2);
    // oxlint-disable-next-line no-await-in-loop -- one size at a time
    await unrelated(stub, hidden, (size - have) / 2);
    have = size;
    // oxlint-disable-next-line no-await-in-loop -- one size at a time
    rows.push(await rowsReadBy(ask));
  }
  return rows;
};

/**
 * Adds `count` relations of the hub `hub` (an existing person's or
 * customer's id) to entities of their own: from it (`out`, a person who
 * owns customers) or to it (`in`, people who own the customer), 99 an
 * add.
 */
const hubRelations = async (
  stub: Store,
  group: string,
  maker: Reader,
  hub: { id: string; kind: "person" | "customer" },
  count: number,
  direction: "out" | "in"
): Promise<void> => {
  for (let start = 0; start < count; start += 99) {
    const keys = Array.from(
      { length: Math.min(99, count - start) },
      (_, index) => `o${index}`
    );
    // oxlint-disable-next-line no-await-in-loop -- one add at a time
    await stub.addMemories({
      change: crypto.randomUUID(),
      access: audience(group),
      reader: maker,
      entities: [
        { key: "h", id: hub.id, kind: hub.kind, names: [] },
        ...keys.map((key) => ({
          key,
          kind:
            direction === "out" ? ("customer" as const) : ("person" as const),
          names: [],
        })),
      ],
      memories: keys.map((key, index) =>
        direction === "out"
          ? fact("h", `the hub owns ${start + index}`, {
              attribute: "owns",
              object: key,
            })
          : fact(key, `${start + index} owns the hub`, {
              attribute: "owns",
              object: "h",
            })
      ),
    });
  }
};

/** Adds `memories` about `entities` to `stub`, readable by `group`. */
const add = async (
  stub: Store,
  group: string,
  entities: NewEntity[],
  memories: NewMemory[]
) =>
  await stub.addMemories({
    change: crypto.randomUUID(),
    access: audience(group),
    entities,
    memories,
  });

/** A find of `question` as `reader`. */
const finding = async (stub: Store, reader: Reader, question: string) =>
  await stub.find({ question, reader, budget: { tokens: 20_000 } });

describe("what reading memories costs", () => {
  it("reads an entity's memories without reading other memories or names, readable or hidden", async () => {
    const { stub, rowsReadBy } = await countedStore();
    const group = `seen-${crypto.randomUUID()}`;
    const reader = readerOf("reader", group);
    const name = word();
    const { entities } = await add(
      stub,
      group,
      [{ key: "c", kind: "customer", names: [name] }],
      [
        fact("c", `${name} is a customer`),
        fact("c", `${name} renews in March`, {
          attribute: "renewal_date",
          value: "March",
        }),
      ]
    );
    const [alone, ...grown] = await rowsAsUnrelatedGrow(
      stub,
      rowsReadBy,
      group,
      async () => await stub.readMemories({ entity: entities.c ?? "", reader })
    );

    expect(grown.map((rows) => flat(alone ?? 0, rows))).toStrictEqual([
      true,
      true,
      true,
    ]);
    // Adding 20,000 memories, a hundred an add, takes its time.
  }, 120_000);

  it("walks from a named entity without reading other memories or names, readable or hidden", async () => {
    const { stub, rowsReadBy } = await countedStore();
    const group = `seen-${crypto.randomUUID()}`;
    const reader = readerOf("reader", group);
    const [name, other] = [word(), word()];
    await add(
      stub,
      group,
      [
        { key: "p", kind: "person", names: [name] },
        { key: "c", kind: "customer", names: [other] },
      ],
      [
        fact("p", `${name} buys steel`),
        fact("p", `${name} looks after the account`, {
          attribute: "owns",
          object: "c",
        }),
        fact("c", `${other} pays on time`),
      ]
    );
    const [alone, ...grown] = await rowsAsUnrelatedGrow(
      stub,
      rowsReadBy,
      group,
      async () => await finding(stub, reader, name)
    );

    expect(grown.map((rows) => flat(alone ?? 0, rows))).toStrictEqual([
      true,
      true,
      true,
    ]);
    // Adding 20,000 memories, a hundred an add, takes its time.
  }, 120_000);

  // A hub the walk reaches: its relations pointing at it (`in`) or from it
  // (`out`, one writer's, each a value of one attribute), a step on (where
  // its relations are counted) and, out, two steps on (where they are
  // not), read a page of, never whole: the rows a walk reads with 100 of
  // them and with 5,000 are the same.
  it.each([
    ["in", 1],
    ["out", 1],
    ["out", 2],
  ] as const)(
    "reads a hub's relations (%s, step %i) by seek, never whole",
    async (direction, step) => {
      const { stub, rowsReadBy } = await countedStore();
      const group = `seen-${crypto.randomUUID()}`;
      const reader = readerOf("reader", group);
      const name = word();
      const hubKind = direction === "in" ? "customer" : "person";
      const { entities } = await add(
        stub,
        group,
        [
          { key: "a", kind: "person", names: [name] },
          // B leads to the hub only when the hub is two steps out.
          ...(step === 1
            ? []
            : [{ key: "b", kind: "customer" as const, names: [word()] }]),
          { key: "h", kind: hubKind, names: [word()] },
        ],
        step === 1
          ? [
              fact("a", `${name} uses the hub`, {
                // A person's relation to a person (the out hub) is `manager`.
                attribute: direction === "in" ? "owns" : "manager",
                object: "h",
              }),
              fact("h", "The hub is big"),
            ]
          : [
              fact("a", `${name} looks after B`, {
                attribute: "owns",
                object: "b",
              }),
              fact("b", "B is reached through the hub", {
                attribute: "contact",
                object: "h",
              }),
              fact("h", "The hub is big"),
            ]
      );
      const hub = { id: entities.h ?? "", kind: hubKind } as const;
      const ask = async () => await finding(stub, reader, name);
      await hubRelations(stub, group, reader, hub, 100, direction);
      const few = await rowsReadBy(ask);
      await hubRelations(stub, group, reader, hub, 4900, direction);
      const many = await rowsReadBy(ask);

      expect(flat(few, many)).toBeTruthy();
    }
  );

  // What finding the entities a question names reads: a seek of each run
  // of the question's words that some name begins with, and of the next
  // run only while one does. Names that begin with the question's first
  // word, two or three of its words cost nothing: as a common first name,
  // or first and last name, shared by many, readable or hidden.
  it.each([
    ["the question's first word", 1],
    ["the question's first two words", 2],
    ["the question's first three words", 3],
  ] as const)(
    "finds the named entities among names beginning with %s",
    async (_shape, shared) => {
      const { stub, rowsReadBy } = await countedStore();
      const group = `seen-${crypto.randomUUID()}`;
      const hidden = `hidden-${crypto.randomUUID()}`;
      const reader = readerOf("reader", group);
      const [first, second, third, own] = [word(), word(), word(), word()];
      const name = `${first} ${second} ${third} ${own}`;
      await add(
        stub,
        group,
        [{ key: "a", kind: "person", names: [name] }],
        [fact("a", `${name} keeps a note`)]
      );
      const alike = () =>
        [...[first, second, third].slice(0, shared), word()].join(" ");
      const ask = async () => await finding(stub, reader, name);
      const rows = [await rowsReadBy(ask)];
      let have = 0;
      for (const size of namedSizes) {
        for (let start = have; start < size; start += 100) {
          const keys = Array.from({ length: 100 }, (_, index) => `n${index}`);
          // oxlint-disable-next-line no-await-in-loop -- one add at a time
          await add(
            stub,
            (start / 100) % 2 === 0 ? group : hidden,
            keys.map((key) => ({
              key,
              kind: "person" as const,
              names: [alike()],
            })),
            keys.map((key) => fact(key, `alike ${start} ${key}`))
          );
        }
        have = size;
        // oxlint-disable-next-line no-await-in-loop -- one size at a time
        rows.push(await rowsReadBy(ask));
      }
      const [alone = 0, ...grown] = rows;

      expect(grown.map((read) => flat(alone, read))).toStrictEqual([
        true,
        true,
        true,
      ]);
    },
    300_000
  );

  it("reads no entity two steps out once the nearer steps fill the list", async () => {
    const { stub, rowsReadBy } = await countedStore();
    const group = `seen-${crypto.randomUUID()}`;
    const reader = readerOf("reader", group);
    const seed = `${word()} ${word()}`;
    const mids = Array.from({ length: 3 }, () => word());
    const fars = mids.map(() => word());
    const { entities } = await add(
      stub,
      group,
      [
        { key: "s", kind: "person", names: [seed] },
        ...mids.map((one, index) => ({
          key: `m${index}`,
          kind: "customer" as const,
          names: [one],
        })),
        ...fars.map((one, index) => ({
          key: `f${index}`,
          kind: "person" as const,
          names: [one],
        })),
      ],
      [
        ...mids.map((one, index) =>
          fact("s", `${seed} looks after ${one}`, {
            attribute: "owns",
            object: `m${index}`,
          })
        ),
        ...mids.flatMap((one, index) => [
          ...[1, 2, 3].map((note) => fact(`m${index}`, `${one} note ${note}`)),
          fact(`m${index}`, `${one} is reached through ${fars[index]}`, {
            attribute: "contact",
            object: `f${index}`,
          }),
        ]),
      ]
    );
    const statements = async () => {
      const found = await finding(stub, reader, seed);
      return found.memories.entities.map(({ statement }) => statement);
    };
    const before = await statements();
    const rowsBefore = await rowsReadBy(statements);
    // Facts two steps out, by the far entities' ids, giving no new name.
    await stub.addMemories({
      change: crypto.randomUUID(),
      access: audience(group),
      reader,
      entities: fars.map((_, index) => ({
        key: `f${index}`,
        id: entities[`f${index}`] ?? "",
        kind: "person" as const,
        names: [],
      })),
      memories: fars.flatMap((one, index) =>
        Array.from({ length: 20 }, (_, note) =>
          fact(`f${index}`, `${one} far note ${note}`)
        )
      ),
    });
    const after = await statements();
    const rowsAfter = await rowsReadBy(statements);

    expect({
      after,
      flat: flat(rowsBefore, rowsAfter),
      found: before.length,
    }).toStrictEqual({ after: before, flat: true, found: recallLimit });
  });

  it("links an add's names without reading other names or memories, readable or hidden", async () => {
    const { stub, rowsReadBy } = await countedStore();
    const group = `seen-${crypto.randomUUID()}`;
    const hidden = `hidden-${crypto.randomUUID()}`;
    /** An add of 100 entities, each with a new name of two words. */
    const named = async (readers: string) =>
      await add(
        stub,
        readers,
        Array.from({ length: 100 }, (_, index) => ({
          key: `n${index}`,
          kind: "person" as const,
          names: [`${word()} ${word()}`],
        })),
        Array.from({ length: 100 }, (_, index) =>
          fact(`n${index}`, `named ${index}`)
        )
      );
    const rows: number[] = [];
    let have = 0;
    for (const size of [100, 2000, 20_000]) {
      for (let start = have; start < size; start += 100) {
        // oxlint-disable-next-line no-await-in-loop -- one add at a time
        await named((start / 100) % 2 === 0 ? group : hidden);
      }
      have = size;
      // oxlint-disable-next-line no-await-in-loop -- one size at a time
      rows.push(await rowsReadBy(async () => await named(group)));
    }
    const [alone = 0, ...grown] = rows;

    expect(grown.map((read) => flat(alone, read))).toStrictEqual([true, true]);
    // Adding 20,000 names, a hundred an add, takes its time.
  }, 120_000);

  // An entity named and found as a reader sees it (entities.ts `asSeen`,
  // its earliest name, read through the entity's own names), and the card
  // naming the entities it relates to: never every name in the store.
  it.each([
    ["reads an entity", "entity"],
    ["finds an entity by name", "name"],
    ["finds an entity by identifier", "identifier"],
    ["names a card's entities", "card"],
  ] as const)(
    "%s without reading other names, readable or hidden",
    async (_read, asked) => {
      const { stub, rowsReadBy } = await countedStore();
      const group = `seen-${crypto.randomUUID()}`;
      const hidden = `hidden-${crypto.randomUUID()}`;
      const reader = readerOf("reader", group);
      const name = `${word()} ${word()}`;
      const identifier = { type: "ref" as const, value: `crm:${word()}` };
      const { entities } = await add(
        stub,
        group,
        [
          {
            key: "c",
            kind: "customer",
            names: [name],
            identifiers: [identifier],
          },
          { key: "o", kind: "person", names: [`${word()} ${word()}`] },
        ],
        [
          fact("c", `${name} is a customer`),
          fact("o", `The owner looks after ${name}`, {
            attribute: "owns",
            object: "c",
          }),
        ]
      );
      const entity = entities.c ?? "";
      const reads = {
        entity: async () => await stub.readEntity({ entity, reader }),
        name: async () => await stub.findEntities({ name, reader }),
        identifier: async () => await stub.findEntities({ identifier, reader }),
        card: async () => await stub.readCard({ entity, reader }),
      };
      const rows: number[] = [];
      let have = 0;
      for (const size of [100, 5000, 20_000]) {
        for (let start = have; start < size; start += 100) {
          const keys = Array.from({ length: 100 }, (_, index) => `n${index}`);
          // oxlint-disable-next-line no-await-in-loop -- one add at a time
          await add(
            stub,
            (start / 100) % 2 === 0 ? group : hidden,
            keys.map((key) => ({
              key,
              kind: "customer" as const,
              names: [`${word()} ${word()}`, word()],
              identifiers: [{ type: "ref" as const, value: `crm:${word()}` }],
            })),
            keys.map((key) => fact(key, `named ${start} ${key}`))
          );
        }
        have = size;
        // oxlint-disable-next-line no-await-in-loop -- one size at a time
        rows.push(await rowsReadBy(reads[asked]));
      }
      const [alone = 0, ...grown] = rows;

      expect(grown.map((read) => flat(alone, read))).toStrictEqual([
        true,
        true,
      ]);
    },
    120_000
  );
});
