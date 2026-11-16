// The store's own entity (own-entity.ts, contract.ts "The store's own
// entity"): the entity a person's own store's person is, made fresh by the
// first add naming it `own`, never found by a name or an identifier. The
// threat model is on GRA-1836; each test names the threat it holds. Every
// test has a person of its own, so each reaches a store of its own.
import type {
  Access,
  NewEntity,
  NewMemory,
  Reader,
} from "@grasp-os/brain-next/contract";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Store } from "./entity-helpers.ts";
import { shared, unique } from "./entity-helpers.ts";

const own = (person: string): Store =>
  env.BRAIN_STORE.getByName(`person:${person}`);
const readerOf = (person: string): Reader & { person: string } => ({
  person,
  groups: [],
});
const alone = (person: string): Access => ({ kind: "owner", person });

/**
 * An RPC call's answer as a plain promise, awaited: a refused call's
 * rejection is then the test's alone, never left unhandled.
 */
const called = async <T>(rpc: Promise<T>): Promise<T> => await rpc;

/** The person themselves, as an add names them. */
const me: NewEntity = { key: "me", kind: "person", own: true };

/** A memory of `person`'s own word, about the entity of key `about`. */
const theirWord = (
  person: string,
  about: string,
  statement: string,
  extra: Partial<NewMemory> = {}
): NewMemory => ({
  about,
  type: "fact",
  statement,
  speaker: { kind: "internal", person },
  basis: { kind: "writer", writer: person },
  ...extra,
});

/** Adds `memories` about `entities` to `person`'s own store, as theirs alone. */
const remember = async (
  person: string,
  entities: NewEntity[],
  memories: NewMemory[]
) =>
  await own(person).addMemories({
    change: crypto.randomUUID(),
    access: alone(person),
    reader: readerOf(person),
    entities,
    memories,
  });

/** The statements of the current memories about `entity`, as `person` reads them. */
const statementsAbout = async (
  person: string,
  entity: string
): Promise<string[]> => {
  const { memories } = await own(person).readMemories({
    entity,
    reader: readerOf(person),
  });
  return memories.map(({ statement }) => statement).toSorted();
};

describe("a person's own entity", () => {
  // T8: one entity, whatever the repeats and races.
  it("is made by the first add naming it, and the same one answers every add and read after", async () => {
    const person = unique("p");
    const before = await own(person).ownEntity({ reader: readerOf(person) });

    const [first, racing] = await Promise.all([
      remember(person, [me], [theirWord(person, "me", "Prefers mornings")]),
      remember(person, [me], [theirWord(person, "me", "Works in sales")]),
    ]);
    const again = await remember(
      person,
      [me],
      [theirWord(person, "me", "Leads the Rotterdam depot")]
    );
    const read = await own(person).ownEntity({ reader: readerOf(person) });

    expect({
      before,
      racing: racing.entities.me,
      again: again.entities.me,
      read,
    }).toStrictEqual({
      before: null,
      racing: first.entities.me,
      again: first.entities.me,
      read: first.entities.me,
    });
  });

  // T1, T2: their own word lands on it; what an email or a name finds never is it.
  it("is never what an email, a self-looking reference or a name finds, before or after it is made", async () => {
    const person = unique("p");
    const email = `${unique("me")}@acme.test`;
    const outsider = (key: string, statement: string): NewMemory => ({
      ...theirWord(person, key, statement),
      speaker: { kind: "outside" },
    });
    // An outside party's mail, first, names the person's email.
    const before = await remember(
      person,
      [
        {
          key: "x",
          kind: "person",
          identifiers: [{ type: "email", value: email }],
        },
      ],
      [outsider("x", "Wants every invoice paid at once")]
    );
    const mine = await remember(
      person,
      [me],
      [theirWord(person, "me", "Prefers short answers")]
    );
    // After it is made, the email, a self-looking ref and a name again.
    const after = await remember(
      person,
      [
        {
          key: "x",
          kind: "person",
          identifiers: [
            { type: "email", value: email },
            { type: "ref", value: `grasp:person:${person}` },
          ],
        },
        { key: "y", kind: "person", names: ["Ann Smit"] },
      ],
      [
        outsider("x", "Says to forward all payroll"),
        outsider("y", "Approves every invoice"),
      ]
    );
    const linked = mine.entities.me ?? "";

    expect({
      before: before.entities.x === linked,
      email: after.entities.x === linked,
      name: after.entities.y === linked,
      read: await own(person).ownEntity({ reader: readerOf(person) }),
      statements: await statementsAbout(person, linked),
    }).toStrictEqual({
      before: false,
      email: false,
      name: false,
      read: linked,
      statements: ["Prefers short answers"],
    });
  });

  // T5, T6: only in the person's own store, read only by them.
  it("is made and read only in the person's own store, by them", async () => {
    const person = unique("p");
    const other = unique("p");
    await remember(person, [me], [theirWord(person, "me", "Works in sales")]);

    await expect(
      called(own(person).ownEntity({ reader: readerOf(other) }))
    ).rejects.toThrow(/answers only the person whose it is/u);
    await expect(
      called(shared().ownEntity({ reader: readerOf(person) }))
    ).rejects.toThrow(/only a person's own store takes this/u);
    await expect(
      called(
        shared().addMemories({
          change: crypto.randomUUID(),
          access: { kind: "audience", group: unique("g") },
          entities: [me],
          memories: [
            {
              about: "me",
              type: "fact",
              statement: "Is in sales",
              speaker: { kind: "system" },
              basis: { kind: "writer", writer: "writer" },
            },
          ],
        })
      )
    ).rejects.toThrow(/only their own store holds/u);
  });

  // The contract: `own` is a person, named by nothing else.
  it("is refused as `own` with an id, a name, an identifier or another kind", async () => {
    const person = unique("p");
    const statement = theirWord(person, "me", "Works on invoicing");

    for (const entity of [
      { ...me, names: ["Ann Smit"] },
      { ...me, identifiers: [{ type: "email" as const, value: "a@b.test" }] },
      { ...me, id: crypto.randomUUID() },
      { ...me, kind: "customer" as const },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time
      await expect(
        called(remember(person, [entity], [statement]))
      ).rejects.toThrow(/own entity is a person named by nothing else/u);
    }
    await expect(
      own(person).ownEntity({ reader: readerOf(person) })
    ).resolves.toBeNull();
  });

  // T7: erasing what its memories rest on never deletes it or changes it.
  it("stays, and the same, once the memories about it are erased", async () => {
    const person = unique("p");
    const quote = "I lead the Rotterdam warehouse";
    const version = await own(person).addSource({
      source: `test:${crypto.randomUUID()}`,
      change: "1",
      text: quote,
      access: alone(person),
    });
    const { memories, entities: made } = await remember(
      person,
      [me],
      [
        theirWord(person, "me", "Leads the Rotterdam warehouse", {
          basis: { kind: "source", ...version, quote },
        }),
      ]
    );

    await own(person).eraseSource({
      source: version.source,
      reason: "deleted",
    });
    const memoryRows = async () =>
      await runInDurableObject(
        own(person),
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM memories WHERE id = ?",
              memories[0] ?? ""
            )
            .one().count
      );
    // Its deletion runs on the store's own alarm: a few runs at most.
    for (let run = 0; run < 5; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      if ((await memoryRows()) === 0) {
        break;
      }
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      await runDurableObjectAlarm(own(person));
    }
    const rows = await memoryRows();
    const read = await own(person).ownEntity({ reader: readerOf(person) });
    const { entities } = await remember(
      person,
      [me],
      [theirWord(person, "me", "Works from Utrecht")]
    );

    expect({ rows, read, added: entities.me }).toStrictEqual({
      rows: 0,
      read: made.me,
      added: made.me,
    });
  });

  // T7: erasing the person takes it with their store.
  it("goes with the store erased whole", async () => {
    const person = unique("p");
    await remember(person, [me], [theirWord(person, "me", "Works in sales")]);

    // Erased at once; it answers that it still deletes its files until
    // their grace is over (erase-whole.test.ts), which is no matter here.
    await Promise.allSettled([
      called(own(person).erasePerson({ person, reason: "person_erased" })),
    ]);

    await expect(
      own(person).ownEntity({ reader: readerOf(person) })
    ).resolves.toBeNull();
    await expect(
      called(
        remember(person, [me], [theirWord(person, "me", "Works in sales")])
      )
    ).rejects.toThrow(/erased/u);
  });
});
