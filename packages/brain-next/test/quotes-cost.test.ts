import type { NewMemory } from "@grasp-os/brain-next/contract";
import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { audience, readerOf, word } from "./entity-helpers.ts";

// What a memory's quote against its source's current version costs
// (quotes.ts), as memories-cost.test.ts counts it: the rows the store's
// SQL reads, as workerd counts them (each cursor's `rowsRead`), through
// the store's public methods. A read of memories nothing put out reads
// exactly what it read before (an empty seek of `memory_outs`); an out
// memory costs its read a few rows more, the same for each; and a
// version's add reads its source's in set and the out memories its text
// may bring back, never the source's other out memories nor any other
// memory.

/** Rows the store's SQL read, counted at the store itself. */
interface Counter {
  rows: () => number;
  reset: () => void;
}

const counters = new Map<string, Counter>();

/** The shared store, from empty storage, its SQL's reads counted. */
const countedStore = async () => {
  await reset();
  const stub = env.BRAIN_STORE.getByName("brain");
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
  const rowsReadBy = async (ask: () => Promise<unknown>): Promise<number> => {
    const counter = counters.get(stub.id.toString());
    counter?.reset();
    await ask();
    return counter?.rows() ?? Number.NaN;
  };
  return { stub, rowsReadBy };
};

type Store = Awaited<ReturnType<typeof countedStore>>["stub"];

/** Rows an index seek may read more as the indexes grow deeper (memories-cost.test.ts). */
const seekMargin = 8;

/** Adds `text` as the next version of `source`, readable by `group`. */
const version = async (
  stub: Store,
  source: string,
  text: string,
  group: string
): Promise<number> => {
  const added = await stub.addSource({
    source,
    change: crypto.randomUUID(),
    text,
    access: audience(group),
  });
  return added.version;
};

/**
 * `count` memories about a customer named `name`, resting on `version` of
 * `source`, each quoting `quoteOf` its index, a hundred an add: the
 * customer's id.
 */
const drawn = async (
  stub: Store,
  {
    source,
    on,
    group,
    name,
    count,
    quoteOf,
  }: {
    source: string;
    on: number;
    group: string;
    name: string;
    count: number;
    quoteOf: (index: number) => string;
  }
): Promise<string> => {
  let entity: string | undefined;
  for (let start = 0; start < count; start += 100) {
    const memories: NewMemory[] = Array.from(
      { length: Math.min(100, count - start) },
      (_, offset) => ({
        about: "c",
        type: "fact",
        statement: `${name} fact ${start + offset}.`,
        speaker: { kind: "outside" },
        basis: {
          kind: "source",
          source,
          version: on,
          quote: quoteOf(start + offset),
        },
      })
    );
    // oxlint-disable-next-line no-await-in-loop -- one add at a time
    const added = await stub.addMemories({
      change: crypto.randomUUID(),
      access: audience(group),
      entities: [
        entity === undefined
          ? { key: "c", kind: "customer", names: [name] }
          : { key: "c", id: entity, kind: "customer" },
      ],
      memories,
    });
    entity ??= added.entities.c;
  }
  return entity ?? "";
};

/** A sentence of its own for each index: words no other holds. */
const sentenceOf = (tag: string, index: number): string =>
  `${tag} clause ${index} holds ${tag}x${index}`;

describe("what judging quotes costs", () => {
  it("reads memories nothing put out as it reads those of a source never changed, row for row", async () => {
    const { stub, rowsReadBy } = await countedStore();
    const group = `g-${crypto.randomUUID()}`;
    const reader = readerOf("reader", group);
    const made = async (changed: boolean) => {
      const source = `doc-${crypto.randomUUID()}`;
      const tag = word();
      const text = Array.from({ length: 20 }, (_, index) =>
        sentenceOf(tag, index)
      ).join(". ");
      const on = await version(stub, source, text, group);
      const name = `${word()} Group`;
      const entity = await drawn(stub, {
        source,
        on,
        group,
        name,
        count: 20,
        quoteOf: (index) => sentenceOf(tag, index),
      });
      if (changed) {
        // Every quote still held: each memory judged in, none out.
        await version(stub, source, `${text}. More.`, group);
      }
      return { name, entity };
    };
    // Both made before either is read, so both read the same trees.
    const changed = await made(true);
    const unchanged = await made(false);
    const rowsOf = async ({
      name,
      entity,
    }: {
      name: string;
      entity: string;
    }) => ({
      memories: await rowsReadBy(
        async () => await stub.readMemories({ entity, reader, history: true })
      ),
      found: await rowsReadBy(
        async () => await stub.findEntities({ reader, name })
      ),
      card: await rowsReadBy(
        async () => await stub.readCard({ entity, reader })
      ),
    });
    const ofChanged = await rowsOf(changed);
    const ofUnchanged = await rowsOf(unchanged);

    expect(ofChanged).toStrictEqual(ofUnchanged);
  }, 60_000);

  it("reads the same few rows more for each out memory, however many and however many others the store holds", async () => {
    const { stub, rowsReadBy } = await countedStore();
    const group = `g-${crypto.randomUUID()}`;
    const reader = readerOf("reader", group);
    const extra = async (count: number) => {
      const read = async (out: boolean) => {
        const source = `doc-${crypto.randomUUID()}`;
        const tag = word();
        const text = Array.from({ length: count }, (_, index) =>
          sentenceOf(tag, index)
        ).join(". ");
        const on = await version(stub, source, text, group);
        const entity = await drawn(stub, {
          source,
          on,
          group,
          name: `${word()} Group`,
          count,
          quoteOf: (index) => sentenceOf(tag, index),
        });
        await version(stub, source, out ? "Nothing of it." : `${text}.`, group);
        return await rowsReadBy(
          async () => await stub.readMemories({ entity, reader, history: true })
        );
      };
      return (await read(true)) - (await read(false));
    };
    const twenty = await extra(20);
    const forty = await extra(40);
    // Others in the store, unrelated.
    const unrelated = `doc-${crypto.randomUUID()}`;
    const tag = word();
    const on = await version(
      stub,
      unrelated,
      Array.from({ length: 50 }, (_, index) => sentenceOf(tag, index)).join(
        ". "
      ),
      group
    );
    await drawn(stub, {
      source: unrelated,
      on,
      group,
      name: `${word()} Group`,
      count: 2000,
      quoteOf: (index) => sentenceOf(tag, index % 50),
    });
    await version(stub, unrelated, "Nothing of those.", group);
    const afterOthers = await extra(20);

    expect({
      perMemory: twenty / 20,
      linear: forty === 2 * twenty,
      flat: Math.abs(afterOthers - twenty) <= seekMargin,
    }).toStrictEqual({ perMemory: 2, linear: true, flat: true });
  }, 120_000);

  it("adds a version reading neither the source's out memories nor any other memory", async () => {
    const { stub, rowsReadBy } = await countedStore();
    const group = `g-${crypto.randomUUID()}`;
    const rowsOfAdd = async (outs: number): Promise<number> => {
      const source = `doc-${crypto.randomUUID()}`;
      const tag = word();
      const on = await version(
        stub,
        source,
        Array.from({ length: 10 }, (_, index) => sentenceOf(tag, index)).join(
          ". "
        ),
        group
      );
      await drawn(stub, {
        source,
        on,
        group,
        name: `${word()} Group`,
        count: outs,
        quoteOf: (index) => sentenceOf(tag, index % 10),
      });
      // Every memory out, then a version of other words again.
      await version(stub, source, "Nothing of it.", group);
      return await rowsReadBy(
        async () => await version(stub, source, "Still nothing.", group)
      );
    };
    const few = await rowsOfAdd(10);
    const many = await rowsOfAdd(1000);
    const after = await rowsOfAdd(10);

    expect({
      flatInOuts: Math.abs(many - few) <= seekMargin,
      flatInOthers: Math.abs(after - few) <= seekMargin,
    }).toStrictEqual({ flatInOuts: true, flatInOthers: true });
  }, 120_000);
});
