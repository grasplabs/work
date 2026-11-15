// Merging what one lineage says twice (GRA-1752; the threat model is on
// the issue), through the store's own methods: a newer memory of a
// source or a writer that restates an earlier one, filed under no
// attribute, ends it, kept as history, only for readers of the newer one.
// Every test has its own people, groups, sources and names, and asserts
// by memory id, so what other tests left in the shared store is hidden
// from it.
import type {
  Access,
  Memory,
  NewEntity,
  NewMemory,
  PersonReader,
} from "@grasp-os/brain-next/contract";
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

  it("keys every restatement, so two writers adding the same fact at once leave one current and the other as history", async () => {
    const group = unique("g");
    const reader = readerOf(unique("p"), group);
    const name = unique("Globex");
    const writer = unique("w");
    const first = await add(
      audience(group),
      [customer(name)],
      [
        fact(
          `${name} works from Delft.`,
          { kind: "writer", writer },
          {
            speaker: { kind: "system" },
          }
        ),
      ]
    );
    const said = fact(
      `${name} works from Delft.`,
      { kind: "writer", writer },
      { speaker: { kind: "system" } }
    );
    const entity = {
      key: "c",
      id: first.entity,
      kind: "customer" as const,
      names: [],
    };
    // Two adds of the same restatement at once, each its own change.
    const [one, two] = await Promise.all([
      add(audience(group), [entity], [said], reader),
      add(audience(group), [entity], [said], reader),
    ]);
    const ids = [...first.memories, ...one.memories, ...two.memories];
    const states = statesOf(
      await read(first.entity, reader, { history: true }),
      ids
    );

    expect({
      current: states.filter((state) => state === "current").length,
      ended: states.filter((state) => state === "ended").length,
    }).toStrictEqual({ current: 1, ended: 2 });
  });

  it("recalls and shows on a card only the memory a reader reads as current, the earlier for a reader of it alone", async () => {
    const first = unique("g");
    const second = unique("g");
    const name = unique("Umbrella");
    const basis: NewMemory["basis"] = { kind: "writer", writer: unique("w") };
    const statement = fact(`${name} ships from Rotterdam.`, basis, {
      speaker: { kind: "system" },
    });
    const earlier = await add(audience(first), [customer(name)], [statement]);
    const later = await add(
      audience(second),
      [{ key: "c", id: earlier.entity, kind: "customer", names: [] }],
      [statement],
      readerOf(unique("host"), first, second)
    );
    const ids = [...earlier.memories, ...later.memories];
    const shownTo = async (reader: PersonReader) => {
      const pack = await shared().recall({
        question: `${name} ships from Rotterdam`,
        reader,
        budget: { tokens: 20_000 },
      });
      // What the card shows (its notes), not what it rests on: its name
      // came from the earlier memory.
      const card = await shared().readCard({ entity: earlier.entity, reader });
      const notes = new Set((card?.notes ?? []).map(({ id }) => id));
      return {
        recalled: ids.map((id) =>
          pack.memories.some(({ memory }) => memory === id)
        ),
        card: ids.map((id) => notes.has(id)),
      };
    };

    expect({
      onlyFirst: await shownTo(readerOf(unique("p"), first)),
      both: await shownTo(readerOf(unique("p"), first, second)),
    }).toStrictEqual({
      onlyFirst: { recalled: [true, false], card: [true, false] },
      both: { recalled: [false, true], card: [false, true] },
    });
  });
});
