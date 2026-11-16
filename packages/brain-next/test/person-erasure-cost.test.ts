// What a person's erasure in the shared store costs (erasure.ts
// `erasePersonShared`, people.ts `applyPerson`), held by cost as
// writer-erasure-cost.test.ts holds a writer's: the rows the store's SQL
// reads, through the store's public method. It finds what it covers by
// the person's identifiers, by entity, by the person whose word a memory
// is and by confirmer, each a seek: rows linear in what is theirs, never
// in what others said or confirmed. Every name and statement is fixed,
// and each case has a store of its own from empty storage.
import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { countRowsRead } from "./rows-read.ts";

const group = "team:cost";

/** The shared store, from empty storage, its SQL's reads counted. */
const countedStore = async () => {
  await reset();
  const stub = env.BRAIN_STORE.getByName("brain");
  return { stub, rowsReadBy: await countRowsRead(stub) };
};

type Store = Awaited<ReturnType<typeof countedStore>>["stub"];

/**
 * Adds `count` memories in `person`'s word, each about an entity of its
 * own, a hundred an add, and has `person` confirm the first of each add.
 */
const saidBy = async (
  stub: Store,
  person: string,
  count: number
): Promise<void> => {
  for (let start = 0; start < count; start += 100) {
    const keys = Array.from(
      { length: Math.min(100, count - start) },
      (_, index) => `e${index}`
    );
    // oxlint-disable-next-line no-await-in-loop -- one add at a time
    const { memories } = await stub.addMemories({
      change: `${person}-${start}`,
      access: { kind: "audience", group },
      entities: keys.map((key) => ({
        key,
        kind: "customer",
        names: [`${person} ${start} ${key}`],
      })),
      memories: keys.map((key) => ({
        about: key,
        type: "fact",
        statement: `${person} said ${start} ${key}`,
        speaker: { kind: "internal", person },
        basis: { kind: "writer", writer: "app:cost" },
      })),
    });
    // oxlint-disable-next-line no-await-in-loop -- one confirmation at a time
    await stub.confirmMemory({
      memory: memories[0] ?? "",
      reader: { person, groups: [group] },
    });
  }
};

/** The rows erasing `person` reads, with `others` memories of other people's in the store. */
const rowsOfErasure = async (others: number): Promise<number> => {
  const { stub, rowsReadBy } = await countedStore();
  await saidBy(stub, "anna", 200);
  for (let at = 0; at < others; at += 1000) {
    // oxlint-disable-next-line no-await-in-loop -- one person at a time
    await saidBy(stub, `other${at}`, Math.min(1000, others - at));
  }
  await stub.addMemories({
    change: "her-card",
    access: { kind: "audience", group },
    entities: [
      {
        key: "anna",
        kind: "person",
        names: ["Anna Smit"],
        identifiers: [{ type: "email", value: "anna@cost.test" }],
      },
    ],
    memories: [
      {
        about: "anna",
        type: "fact",
        statement: "Anna Smit leads finance",
        speaker: { kind: "system" },
        basis: { kind: "writer", writer: "app:cost" },
      },
    ],
  });
  return await rowsReadBy(async () => {
    await stub.erasePersonShared({
      person: "anna",
      identifiers: [{ type: "email", value: "anna@cost.test" }],
      reason: "person_erased",
    });
  });
};

describe("a person's erasure in the shared store", () => {
  it("reads rows linear in what is theirs, never in what others said or confirmed", async () => {
    const fewer = await rowsOfErasure(1000);
    const more = await rowsOfErasure(3000);
    expect({ grew: more - fewer }).toStrictEqual({ grew: 0 });
  }, 120_000);
});
