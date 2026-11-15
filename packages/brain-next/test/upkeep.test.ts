// Upkeep of memories (GRA-1752; the threat model is on the issue),
// through the store's own methods: the same fact said again by one
// lineage merges into one current memory, the earlier kept as history,
// only for readers of the later one; and a memory whose quote a newer
// version of its source no longer holds is retired by the queue, in code,
// asking no model. Every test has its own people, groups, sources and
// names, and asserts by memory id, so what other tests left in the
// shared store is hidden from it.
import type {
  Access,
  Embedders,
  HandOvers,
  Memory,
  NewEntity,
  NewMemory,
  PersonReader,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { BrainStore } from "../src/store.ts";

type Store = DurableObjectStub<BrainStore>;

const shared = (): Store => env.BRAIN_STORE.getByName("brain");

const unique = (name: string): string =>
  `${name}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

const readerOf = (person: string, ...groups: string[]): PersonReader => ({
  person,
  groups,
});

const audience = (group: string): Access => ({ kind: "audience", group });

/**
 * A customer of the add, under key `c`, named `name` Group: a name of two
 * words, which a later add of the same readers links to by name.
 */
const customer = (name: string): NewEntity => ({
  key: "c",
  kind: "customer",
  names: [`${name} Group`],
});

/** A fact about `about`, resting on `basis`. */
const fact = (
  statement: string,
  basis: NewMemory["basis"],
  extra: Partial<NewMemory> = {}
): NewMemory => ({
  about: "c",
  type: "fact",
  statement,
  speaker: { kind: "outside" },
  basis,
  ...extra,
});

/** Adds `memories` about `entities`, readable as `access` says, as `reader` when given: their ids, `c`'s apart. */
const add = async (
  access: Access,
  entities: NewEntity[],
  memories: NewMemory[],
  reader?: PersonReader
): Promise<{
  memories: string[];
  entity: string;
  entities: Record<string, string>;
}> => {
  const added = await shared().addMemories({
    change: crypto.randomUUID(),
    access,
    entities,
    memories,
    ...(reader === undefined ? {} : { reader }),
  });
  return {
    memories: added.memories,
    entity: added.entities.c ?? "",
    entities: added.entities,
  };
};

/** The store's moment of a read now, as a page gives it: for `asOf` later. */
const moment = async (reader: PersonReader): Promise<Date> => {
  const page = await shared().listContested({ reader, limit: 1 });
  return page.at;
};

/** Every memory about `entity` `reader` reads, ended ones too with `history`, by id. */
const read = async (
  entity: string,
  reader: PersonReader,
  { history = false, asOf }: { history?: boolean; asOf?: Date } = {}
): Promise<Map<string, Memory>> => {
  const { memories } = await shared().readMemories({
    entity,
    reader,
    history,
    ...(asOf === undefined ? {} : { asOf }),
  });
  return new Map(memories.map((memory) => [memory.id, memory]));
};

/** Of `ids`, whether each is current (`current`), ended (`ended`) or not read at all, as `read` gave them. */
const statesOf = (memories: Map<string, Memory>, ids: readonly string[]) =>
  ids.map((id) => {
    const memory = memories.get(id);
    if (memory === undefined) {
      return "unread";
    }
    return memory.endedAt === null ? "current" : "ended";
  });

/** A source of its own, readable by `group`: its version. */
const addVersion = async (
  text: string,
  group: string,
  source: string
): Promise<{ source: string; version: number }> =>
  await shared().addSource({
    source,
    change: crypto.randomUUID(),
    text,
    access: audience(group),
  });

const noModel: Embedders = {
  model: null,
  embed: async () => {
    await Promise.resolve();
    return { kind: "unavailable" };
  },
};

const noHandOvers: HandOvers = {
  handOver: async () => {
    await Promise.resolve();
    return { kind: "nothing" };
  },
};

/** Every model call the queue made: upkeep makes none. */
const calls: string[] = [];

/** The queue's clock: a minute on per tick. */
let clock = Date.now();
const tick = async (): Promise<void> => {
  clock = Math.max(clock + 60_000, Date.now());
  await shared().work({
    ask: async ({ purpose }) => {
      await Promise.resolve();
      calls.push(purpose);
      return { kind: "refused" };
    },
    at: new Date(clock),
    embedders: noModel,
    handOvers: noHandOvers,
    contextTokens: null,
  });
};

/** How often, and how many times, `until` looks. */
const untilEveryMs = 10;
const untilLooks = 1000;

/** Waits until `open` holds, at most 10 s. */
const until = async (open: () => boolean, what: string): Promise<void> => {
  for (let look = 0; !open(); look += 1) {
    if (look === untilLooks) {
      throw new Error(`Waited 10 s for ${what}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- until released
    await scheduler.wait(untilEveryMs);
  }
};

describe("merging what one lineage says twice", () => {
  it("keeps one current memory when a source says the same fact twice, under an attribute or none, the earlier as history", async () => {
    const group = unique("g");
    const reader = readerOf(unique("p"), group);
    const name = unique("Acme");
    const ref = await addVersion(
      `${name} renews in March. ${name} has a warehouse in Rotterdam. ${name} pays late.`,
      group,
      unique("doc")
    );
    const basis = (quote: string): NewMemory["basis"] => ({
      kind: "source",
      ...ref,
      quote,
    });
    const first = await add(
      audience(group),
      [customer(name)],
      [
        fact(`${name} renews in March.`, basis(`${name} renews in March`), {
          attribute: "renewal_date",
          value: "March",
        }),
        fact(
          `${name} has a warehouse in Rotterdam.`,
          basis(`${name} has a warehouse in Rotterdam`)
        ),
        fact(`${name} pays late.`, basis(`${name} pays late`)),
      ]
    );
    const between = await moment(reader);
    // A second piece says two of them again, one in other case and
    // punctuation, and says the third otherwise.
    const second = await add(
      audience(group),
      [customer(name)],
      [
        fact(`${name} renews in March.`, basis(`${name} renews in March`), {
          attribute: "renewal_date",
          value: "march",
        }),
        fact(
          `${name.toUpperCase()} has a warehouse in Rotterdam!`,
          basis(`${name} has a warehouse in Rotterdam`)
        ),
        fact(`${name} is a late payer.`, basis(`${name} pays late`)),
      ]
    );
    const ids = [...first.memories, ...second.memories];
    const now = await read(first.entity, reader, { history: true });
    const then = await read(first.entity, reader, { asOf: between });

    expect({
      entity: second.entity,
      now: statesOf(now, ids),
      asOfBetween: statesOf(then, ids),
      readable: await shared().readableMemories({ memories: ids, reader }),
    }).toStrictEqual({
      entity: first.entity,
      // The earlier renewal and warehouse ended by their restatements; the
      // late payment, worded otherwise, stays beside its rewording.
      now: ["ended", "ended", "current", "current", "current", "current"],
      asOfBetween: [
        "current",
        "current",
        "current",
        "unread",
        "unread",
        "unread",
      ],
      // Ended, not retired: each stays readable, as a source's older
      // version does.
      readable: ids,
    });
  });

  it("merges a restatement only for readers of the later one", async () => {
    const first = unique("g");
    const second = unique("g");
    const name = unique("Hooli");
    const basis: NewMemory["basis"] = { kind: "writer", writer: unique("w") };
    const statement = fact(`${name} moved to Utrecht.`, basis, {
      speaker: { kind: "system" },
    });
    const earlier = await add(audience(first), [customer(name)], [statement]);
    // Said again for the second group, by a host that may see the entity.
    const later = await add(
      audience(second),
      [{ key: "c", id: earlier.entity, kind: "customer", names: [] }],
      [statement],
      readerOf(unique("host"), first, second)
    );
    const ids = [...earlier.memories, ...later.memories];
    const states = async (reader: PersonReader) =>
      statesOf(await read(earlier.entity, reader, { history: true }), ids);

    expect({
      entity: later.entity,
      onlyFirst: await states(readerOf(unique("p"), first)),
      onlySecond: await states(readerOf(unique("p"), second)),
      both: await states(readerOf(unique("p"), first, second)),
    }).toStrictEqual({
      entity: earlier.entity,
      // A reader of the earlier alone reads it current, as if the later
      // didn't exist; a reader of both reads one current.
      onlyFirst: ["current", "unread"],
      onlySecond: ["unread", "current"],
      both: ["ended", "current"],
    });
  });
});

describe("re-checking memories when their source changes", () => {
  it("retires a memory whose quote a newer version no longer holds, keeping it as history and asking no model", async () => {
    const group = unique("g");
    const reader = readerOf(unique("p"), group);
    const name = unique("Initech");
    const contact = unique("Lumbergh");
    const source = unique("doc");
    const ref = await addVersion(
      `${name} renews in March. ${contact} is ${name}'s buyer.`,
      group,
      source
    );
    const added = await add(
      audience(group),
      [customer(name), { key: "b", kind: "person", names: [contact] }],
      [
        fact(`${name} renews in March.`, {
          kind: "source",
          ...ref,
          quote: `${name} renews in March`,
        }),
        fact(
          `${contact} buys for ${name}.`,
          { kind: "source", ...ref, quote: `${contact} is ${name}'s buyer` },
          { about: "b" }
        ),
      ]
    );
    const [kept = "", gone = ""] = added.memories;
    const buyer = added.entities.b ?? "";
    // A newer version, not drawn from, that no longer names the buyer.
    await addVersion(`${name} renews in March. Nothing else.`, group, source);
    const before = await moment(reader);
    const called = calls.length;
    await tick();
    const found = await shared().findEntities({ reader, name: contact });

    expect({
      readable: await shared().readableMemories({
        memories: [kept, gone],
        reader,
      }),
      kept: statesOf(await read(added.entity, reader), [kept]),
      // Only the retired memory named the buyer: no find gives it now.
      found: found.entities,
      // As of before it was retired, it was current; now it is history.
      before: statesOf(await read(buyer, reader, { asOf: before }), [gone]),
      after: statesOf(await read(buyer, reader, { history: true }), [gone]),
      calls: calls.length - called,
    }).toStrictEqual({
      readable: [kept],
      kept: ["current"],
      found: [],
      before: ["current"],
      after: ["ended"],
      calls: 0,
    });
  });

  it("retires nothing against a version a newer one replaced while its text was read, and checks the newer one", async () => {
    const group = unique("g");
    const reader = readerOf(unique("p"), group);
    const name = unique("Globex");
    const source = unique("doc");
    const said = `${name} renews in March. ${name} pays by card.`;
    const ref = await addVersion(said, group, source);
    const added = await add(
      audience(group),
      [customer(name)],
      [
        fact(`${name} renews in March.`, {
          kind: "source",
          ...ref,
          quote: `${name} renews in March`,
        }),
        fact(`${name} pays by card.`, {
          kind: "source",
          ...ref,
          quote: `${name} pays by card`,
        }),
      ]
    );
    // The version that drops the card is read slowly: meanwhile a newer
    // one says it again.
    const dropped = `${name} renews in March. ${unique("x")}`;
    await addVersion(dropped, group, source);
    const hold = { reached: false, released: false };
    const real = env.BRAIN_OBJECTS;
    const bucket = {
      head: async (key: string) => await real.head(key),
      list: async (options?: R2ListOptions) => await real.list(options),
      put: async (
        key: string,
        value: ArrayBuffer | ArrayBufferView | string,
        options?: R2PutOptions
      ) => await real.put(key, value, options),
      delete: async (keys: string | string[]) => {
        await real.delete(keys);
      },
      get: async (key: string) => {
        const object = await real.get(key);
        const text = object === null ? null : await object.text();
        if (text === dropped && !hold.reached) {
          hold.reached = true;
          await until(() => hold.released, "the test to release the read");
        }
        return text === null
          ? null
          : { text: async () => await Promise.resolve(text) };
      },
    };
    await runInDurableObject(shared(), (instance) => {
      Reflect.set(instance, "env", { ...env, BRAIN_OBJECTS: bucket });
    });
    try {
      const ticking = tick();
      await until(() => hold.reached, "the re-check to read the version");
      await addVersion(said, group, source);
      hold.released = true;
      await ticking;
    } finally {
      await runInDurableObject(shared(), (instance) => {
        Reflect.set(instance, "env", env);
      });
    }
    // The newest version's own re-check: both quotes stand.
    await tick();
    const now = await read(added.entity, reader, { history: true });

    expect(statesOf(now, added.memories)).toStrictEqual(["current", "current"]);
  });
});
