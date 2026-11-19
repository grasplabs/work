import type { Access, Reader } from "@grasp-os/brain-next/contract";
import { recallBudgetMax } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

// Readers within a group (contract.ts `readersWithin`, GRA-2145): a list
// copied from where a source lives, read only by those of its readers who
// also hold one more group, as a host's audience narrows what a source
// lets people read. Through the shared store's own calls. These start from
// the ways it can fail: someone in the group who isn't a reader, or a
// reader outside the group, reading it; two lists alike but for their
// group read as one; a memory drawn from it read more widely; the release
// before this one, after a rollback, reading it as any of its readers'; and
// its readers left behind once nothing uses it.

const store = () => env.BRAIN_STORE.getByName("brain");

const unique = (): string => crypto.randomUUID();

/** A word nothing else holds, for a search to find. */
const word = (): string => `w${unique().replaceAll("-", "").slice(0, 12)}`;

/** Someone in `groups`. */
const readerIn = (...groups: string[]): Reader => ({
  person: unique(),
  groups,
});

/** A source added for `access` holding `text`: its key. */
const added = async (access: Access, text: string): Promise<string> => {
  const source = `test:${unique()}`;
  await store().addSource({ source, change: unique(), text, access });
  return source;
};

/** What `reader` gets of `source`: its current text, its first version's, and whether a recall of `marker` finds it. */
const readsOf = async (source: string, marker: string, reader: Reader) => {
  const [current] = await store().readCurrent({ sources: [source], reader });
  const first = await store().readVersion({ source, version: 1, reader });
  const pack = await store().recall({
    question: marker,
    reader,
    budget: { tokens: recallBudgetMax },
  });
  return {
    current: current?.text ?? null,
    first: first?.text ?? null,
    found: pack.items.some(({ text }) => text.includes(marker)),
  };
};

const nothing = { current: null, first: null, found: false };

describe("readers within a group", () => {
  it("lets in only those who hold the group and one of its readers", async () => {
    const [place, reader, other] = [
      `group:${unique()}`,
      `group:${unique()}`,
      `group:${unique()}`,
    ];
    const marker = word();
    const text = `Site plan ${marker}`;
    const source = await added(
      { kind: "readersWithin", within: place, groups: [reader, other] },
      text
    );

    expect({
      both: await readsOf(source, marker, readerIn(place, reader)),
      bothOther: await readsOf(source, marker, readerIn(other, place)),
      groupAlone: await readsOf(source, marker, readerIn(place)),
      readerAlone: await readsOf(source, marker, readerIn(reader)),
      neither: await readsOf(source, marker, readerIn(unique())),
    }).toStrictEqual({
      both: { current: text, first: text, found: true },
      bothOther: { current: text, first: text, found: true },
      groupAlone: nothing,
      readerAlone: nothing,
      neither: nothing,
    });
  });

  it("keeps two lists alike but for their group apart", async () => {
    const [one, two, reader] = [
      `group:${unique()}`,
      `group:${unique()}`,
      `group:${unique()}`,
    ];
    const [first, second] = [word(), word()];
    const [inOne, inTwo] = [
      await added(
        { kind: "readersWithin", within: one, groups: [reader] },
        `Plan ${first}`
      ),
      await added(
        { kind: "readersWithin", within: two, groups: [reader] },
        `Plan ${second}`
      ),
    ];

    const finds = async (
      source: string,
      marker: string,
      who: Reader
    ): Promise<boolean> => {
      const reads = await readsOf(source, marker, who);
      return reads.found;
    };

    expect({
      one: [
        await finds(inOne, first, readerIn(one, reader)),
        await finds(inTwo, second, readerIn(one, reader)),
      ],
      two: [
        await finds(inOne, first, readerIn(two, reader)),
        await finds(inTwo, second, readerIn(two, reader)),
      ],
    }).toStrictEqual({ one: [true, false], two: [false, true] });
  });

  it("gives a memory drawn from it only to those who may read it", async () => {
    const [place, reader] = [`group:${unique()}`, `group:${unique()}`];
    const name = word();
    await store().addMemories({
      change: unique(),
      access: { kind: "readersWithin", within: place, groups: [reader] },
      entities: [{ key: "c", kind: "customer", names: [name] }],
      memories: [
        {
          about: "c",
          type: "fact",
          statement: `${name} renews in March`,
          speaker: { kind: "system" },
          basis: { kind: "writer", writer: unique() },
        },
      ],
    });
    const memoriesOf = async (who: Reader): Promise<string[]> => {
      const pack = await store().recall({
        question: `${name} renews`,
        reader: who,
        budget: { tokens: recallBudgetMax },
      });
      return pack.memories.map(({ statement }) => statement);
    };

    expect({
      both: await memoriesOf(readerIn(place, reader)),
      groupAlone: await memoriesOf(readerIn(place)),
      readerAlone: await memoriesOf(readerIn(reader)),
    }).toStrictEqual({
      both: [`${name} renews in March`],
      groupAlone: [],
      readerAlone: [],
    });
  });

  it("is nobody's to the release before this one, which knows no group to hold besides", async () => {
    const [place, reader] = [`group:${unique()}`, `group:${unique()}`];
    const source = await added(
      { kind: "readersWithin", within: place, groups: [reader] },
      `Plan ${word()}`
    );
    // The sets of readers someone is in, as the release before this one
    // asks the store (its `readableSql`, reader-sets.ts), after an admin
    // rolled the client back: by the members of a set alone.
    const readableBefore = await runInDurableObject(
      store(),
      (_instance, state) =>
        state.storage.sql
          .exec<{ source: string }>(
            `WITH readable AS (
              SELECT reader_set FROM reader_set_members
              WHERE kind = 'person' AND principal = ?2
              UNION
              SELECT reader_set_members.reader_set FROM json_each(?3) AS asked
              CROSS JOIN reader_set_members
                ON reader_set_members.kind = 'group'
                AND reader_set_members.principal = asked.value
            )
            SELECT source FROM source_versions
            WHERE source = ?1 AND reader_set IN (SELECT reader_set FROM readable)`,
            source,
            unique(),
            JSON.stringify([place, reader])
          )
          .toArray()
    );

    expect(readableBefore).toStrictEqual([]);
  });

  it("forgets its readers once nothing reads by them", async () => {
    const [place, reader] = [`group:${unique()}`, `group:${unique()}`];
    const source = await added(
      { kind: "readersWithin", within: place, groups: [reader] },
      `Plan ${word()}`
    );
    const readersOf = async (): Promise<number> =>
      await runInDurableObject(
        store(),
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM reader_set_readers WHERE principal = ?",
              reader
            )
            .one().count
      );
    const before = await readersOf();
    await store().eraseSource({ source, reason: "deleted" });

    expect({ before, after: await readersOf() }).toStrictEqual({
      before: 1,
      after: 0,
    });
  });
});
