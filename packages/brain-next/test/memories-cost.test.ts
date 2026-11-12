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
// added two steps out cost it nothing either.

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
 * what was added would read 1,000 or more here, the far step's read 60.
 */
const seekMargin = 8;

/** Whether `rows` is within `seekMargin` of `alone`, and never fewer. */
const flat = (alone: number, rows: number): boolean =>
  rows >= alone && rows - alone <= seekMargin;

/**
 * Adds `count` memories about entities of their own, with no name (so no
 * question names them), readable by `group`, a hundred an add.
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
      entities: keys.map((key) => ({ key, kind: "person", names: [] })),
      memories: keys.map((key) => fact(key, `unrelated ${start} ${key}`)),
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
  it("reads an entity's memories without reading other memories, readable or hidden", async () => {
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
    const read = async () =>
      await stub.readMemories({ entity: entities.c ?? "", reader });
    const alone = await rowsReadBy(read);
    await unrelated(stub, group, 1000);
    const besideReadable = await rowsReadBy(read);
    await unrelated(stub, `hidden-${crypto.randomUUID()}`, 1000);
    const besideHidden = await rowsReadBy(read);

    expect({
      besideReadable: flat(alone, besideReadable),
      besideHidden: flat(alone, besideHidden),
    }).toStrictEqual({ besideReadable: true, besideHidden: true });
  });

  it("walks from a named entity without reading other memories, readable or hidden", async () => {
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
    const ask = async () => await finding(stub, reader, name);
    const alone = await rowsReadBy(ask);
    await unrelated(stub, group, 1000);
    const besideReadable = await rowsReadBy(ask);
    await unrelated(stub, `hidden-${crypto.randomUUID()}`, 1000);
    const besideHidden = await rowsReadBy(ask);

    expect({
      besideReadable: flat(alone, besideReadable),
      besideHidden: flat(alone, besideHidden),
    }).toStrictEqual({ besideReadable: true, besideHidden: true });
  });

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
});
