// Memories and entities in the store (memories.ts, entities.ts,
// remember.ts), through the store's own methods. The threat model is on
// GRA-1739; each test says what it holds. Every test has its own people,
// groups, sources and entities, so what earlier tests left in the shared
// store is hidden from it.
import type {
  Access,
  NewEntity,
  NewMemory,
  Reader,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { memoriesByWords } from "../src/memories.ts";
import type { BrainStore } from "../src/store.ts";
import { copyOf, kill, restore } from "./store-copy.ts";

/** A store, as its namespace gives it. */
type Store = DurableObjectStub<BrainStore>;

const shared = (): Store => env.BRAIN_STORE.getByName("brain");
const own = (person: string): Store =>
  env.BRAIN_STORE.getByName(`person:${person}`);

const unique = (name: string): string => `${name}-${crypto.randomUUID()}`;
const readerOf = (person: string, ...groups: string[]): Reader => ({
  person,
  groups,
});
const audience = (group: string): Access => ({ kind: "audience", group });

/** A source of its own in the shared store, readable as `access` says. */
const addSource = async (
  text: string,
  access: Access,
  source = unique("test")
): Promise<{ source: string; version: number }> =>
  await shared().addSource({
    source,
    change: crypto.randomUUID(),
    text,
    access,
  });

/** A customer entity of the add, under key `c`. */
const customer = (extra: Partial<NewEntity> = {}): NewEntity => ({
  key: "c",
  kind: "customer",
  names: ["Acme"],
  ...extra,
});

/** A memory about `c`, a system fact, resting on `basis`. */
const fact = (
  basis: NewMemory["basis"],
  extra: Partial<NewMemory> = {}
): NewMemory => ({
  about: "c",
  type: "fact",
  statement: "Acme renews on 1 March",
  speaker: { kind: "system" },
  basis,
  ...extra,
});

/** Adds `memories` about the entities to `store`, readable as `access` says. */
const remember = async (
  access: Access,
  entities: NewEntity[],
  memories: NewMemory[],
  store: Store = shared(),
  change = crypto.randomUUID(),
  reader?: Reader
) =>
  await store.addMemories({
    change,
    access,
    entities,
    memories,
    ...(reader === undefined ? {} : { reader }),
  });

/** What `reader` reads now about `entity`: statements, current first as the store orders them. */
const statementsAbout = async (
  entity: string,
  reader: Reader,
  extra: { asOf?: Date; history?: boolean } = {},
  store: Store = shared()
): Promise<string[]> => {
  const { memories } = await store.readMemories({ entity, reader, ...extra });
  return memories.map(({ statement }) => statement);
};

/**
 * An RPC call's answer as a plain promise, awaited: a refused call's
 * rejection is then the test's alone, never left unhandled.
 */
const called = async <T>(rpc: Promise<T>): Promise<T> => await rpc;

/** One tick of the store's clock, with no model. */
const tick = async (store: Store = shared()): Promise<void> => {
  await store.work(
    async () => {
      await Promise.resolve();
      return { kind: "answer", text: "" };
    },
    new Date(),
    {
      model: null,
      embed: async () => {
        await Promise.resolve();
        return { kind: "unavailable" };
      },
    }
  );
};

describe("a memory's lineage", () => {
  // Threat 7: never overwritten; as of an earlier moment the old fact returns.
  it("ends the fact a source's old version stated when its new version states another", async () => {
    const group = unique("group");
    const source = unique("contract");
    const first = await addSource("Renews 1 March", audience(group), source);
    const { entities } = await remember(
      audience(group),
      [customer()],
      [
        fact(
          { kind: "source", ...first, quote: "Renews 1 March" },
          { attribute: "renewal_date", value: "1 March" }
        ),
      ]
    );
    const entity = entities.c ?? "";
    const before = new Date();
    const second = await addSource("Renews 1 April", audience(group), source);
    await remember(
      audience(group),
      [customer({ id: entity })],
      [
        fact(
          { kind: "source", ...second, quote: "Renews 1 April" },
          {
            attribute: "renewal_date",
            value: "1 April",
            statement: "Acme renews on 1 April",
          }
        ),
      ]
    );
    const reader = readerOf(unique("reader"), group);

    await expect(statementsAbout(entity, reader)).resolves.toStrictEqual([
      "Acme renews on 1 April",
    ]);
    await expect(
      statementsAbout(entity, reader, { asOf: before })
    ).resolves.toStrictEqual(["Acme renews on 1 March"]);
    const history = await shared().readMemories({
      entity,
      reader,
      history: true,
    });
    expect(
      history.memories.map(({ statement, endedAt }) => [
        statement,
        endedAt === null,
      ])
    ).toStrictEqual([
      ["Acme renews on 1 April", true],
      ["Acme renews on 1 March", false],
    ]);
  });

  it("keeps an earlier version's memory that arrives late as history from the start", async () => {
    const group = unique("group");
    const source = unique("contract");
    const first = await addSource("Renews 1 March", audience(group), source);
    const second = await addSource("Renews 1 April", audience(group), source);
    const { entities } = await remember(
      audience(group),
      [customer()],
      [
        fact(
          { kind: "source", ...second, quote: "Renews 1 April" },
          {
            attribute: "renewal_date",
            value: "1 April",
            statement: "Acme renews on 1 April",
          }
        ),
      ]
    );
    const entity = entities.c ?? "";
    await remember(
      audience(group),
      [customer({ id: entity })],
      [
        fact(
          { kind: "source", ...first, quote: "Renews 1 March" },
          { attribute: "renewal_date", value: "1 March" }
        ),
      ]
    );

    await expect(
      statementsAbout(entity, readerOf(unique("reader"), group))
    ).resolves.toStrictEqual(["Acme renews on 1 April"]);
  });

  it("keeps both values of a many-value attribute, and a memory with no attribute never ends another", async () => {
    const group = unique("group");
    const writer = unique("writer");
    const basis = { kind: "writer", writer } as const;
    const { entities } = await remember(
      audience(group),
      [customer()],
      [
        fact(basis, {
          attribute: "requirement",
          value: "EU hosting",
          statement: "Acme needs EU hosting",
        }),
        fact(basis, { statement: "Acme likes short calls" }),
      ]
    );
    const entity = entities.c ?? "";
    await remember(
      audience(group),
      [customer({ id: entity })],
      [
        fact(basis, {
          attribute: "requirement",
          value: "SSO",
          statement: "Acme needs SSO",
        }),
        fact(basis, { statement: "Acme prefers mail" }),
        fact(basis, {
          attribute: "requirement",
          value: "eu  HOSTING",
          statement: "Acme still needs EU hosting",
        }),
      ]
    );

    await expect(
      statementsAbout(entity, readerOf(unique("reader"), group))
    ).resolves.toStrictEqual([
      "Acme still needs EU hosting",
      "Acme needs SSO",
      "Acme prefers mail",
      "Acme likes short calls",
    ]);
  });

  // Threat 8: two writers at once never both win or both lose.
  it("leaves exactly one current memory when one writer's adds race", async () => {
    const group = unique("group");
    const writer = unique("writer");
    const { entities } = await remember(
      audience(group),
      [customer()],
      [fact({ kind: "writer", writer }, { statement: "Acme is a customer" })]
    );
    const entity = entities.c ?? "";
    await Promise.all(
      ["Lead", "Active", "Paused", "Churned"].map(
        async (status) =>
          await remember(
            audience(group),
            [customer({ id: entity })],
            [
              fact(
                { kind: "writer", writer },
                { attribute: "status", value: status, statement: status }
              ),
            ]
          )
      )
    );

    const current = await shared().readMemories({
      entity,
      reader: readerOf(unique("reader"), group),
      attribute: "status",
    });
    expect(current.memories).toHaveLength(1);
  });

  // Threat 8: a retried add is one add.
  it("answers the same add again for the same change, and refuses it with other memories", async () => {
    const group = unique("group");
    const change = crypto.randomUUID();
    const memory = fact(
      { kind: "writer", writer: unique("writer") },
      { attribute: "status", value: "Active", statement: "Active" }
    );
    const added = await remember(
      audience(group),
      [customer()],
      [memory],
      shared(),
      change
    );

    await expect(
      remember(audience(group), [customer()], [memory], shared(), change)
    ).resolves.toStrictEqual(added);
    await expect(
      remember(
        audience(group),
        [customer()],
        [{ ...memory, statement: "Paused" }],
        shared(),
        change
      )
    ).rejects.toThrow("added before with other memories");
    await expect(
      statementsAbout(added.entities.c ?? "", readerOf(unique("r"), group))
    ).resolves.toStrictEqual(["Active"]);
  });
});

describe("contested facts", () => {
  /** Two sources, readable by `left` and `right`, that disagree on Acme's renewal date. */
  const disagree = async (left: string, right: string) => {
    const one = await addSource("Renews 1 March", audience(left));
    const other = await addSource("Renews 1 May", audience(right));
    const { entities, memories } = await remember(
      audience(left),
      [customer({ identifiers: [{ type: "ref", value: `crm:${left}` }] })],
      [
        fact(
          { kind: "source", ...one, quote: "Renews 1 March" },
          { attribute: "renewal_date", value: "1 March" }
        ),
      ]
    );
    const entity = entities.c ?? "";
    const right_ = await remember(
      audience(right),
      [customer({ id: entity })],
      [
        fact(
          { kind: "source", ...other, quote: "Renews 1 May" },
          {
            attribute: "renewal_date",
            value: "1 May",
            statement: "Acme renews on 1 May",
          }
        ),
      ],
      shared(),
      crypto.randomUUID(),
      readerOf(unique("adder"), left, right)
    );
    return {
      entity,
      march: memories[0] ?? "",
      may: right_.memories[0] ?? "",
    };
  };

  it("returns both sides with their sources, and confirming one reads it first", async () => {
    const group = unique("group");
    const { entity } = await disagree(group, group);
    const reader = readerOf(unique("reader"), group);

    const [contested] = await shared().listContested({ reader, entity });
    expect(contested?.memories.map(({ value }) => value)).toStrictEqual([
      "1 May",
      "1 March",
    ]);
    expect(
      contested?.memories.every(
        ({ contested: isContested, source }) => isContested && source !== null
      )
    ).toBeTruthy();

    await expect(
      shared().confirmMemory({
        memory: contested?.memories[1]?.id ?? "",
        reader,
      })
    ).resolves.toBe("done");
    const [after] = await shared().listContested({ reader, entity });
    expect(after?.memories.map(({ value }) => value)).toStrictEqual([
      "1 March",
      "1 May",
    ]);
    expect(after?.memories[0]?.confirmed?.by).toBe(reader.person);
  });

  // Threat 3: contest and confirmation counted only over what the reader may read.
  it("is no contest, and shows no confirmation, to a reader who can read one side only", async () => {
    const left = unique("left");
    const right = unique("right");
    const { entity, march } = await disagree(left, right);
    const both = readerOf(unique("both"), left, right);
    const leftOnly = readerOf(unique("left-only"), left);

    await expect(
      shared().confirmMemory({ memory: march, reader: both })
    ).resolves.toBe("done");

    const contested = await shared().listContested({
      reader: leftOnly,
      entity,
    });
    const seen = await shared().readMemories({ entity, reader: leftOnly });
    expect({
      contested,
      seen: seen.memories.map(
        ({ value, contested: isContested, confirmed }) => [
          value,
          isContested,
          confirmed,
        ]
      ),
    }).toStrictEqual({ contested: [], seen: [["1 March", false, null]] });
    const { may } = await disagree(left, right);
    await expect(
      shared().confirmMemory({ memory: may, reader: leftOnly })
    ).resolves.toBe("nothing");
  });
});

describe("who may read a memory", () => {
  // Threat 1 and 2: a memory never reads wider than the version it rests on.
  it("is read only by those in its own readers and the version's, and narrowing the source hides it", async () => {
    const group = unique("group");
    const owner = unique("owner");
    const source = unique("doc");
    const version = await addSource(
      "Acme is in Rotterdam",
      audience(group),
      source
    );
    const { entities } = await remember(
      { kind: "owner", person: owner },
      [customer()],
      [
        fact(
          { kind: "source", ...version, quote: "Acme is in Rotterdam" },
          {
            attribute: "location",
            value: "Rotterdam",
            statement: "Acme is in Rotterdam",
          }
        ),
      ]
    );
    const entity = entities.c ?? "";

    await expect(
      statementsAbout(entity, readerOf(owner))
    ).resolves.toStrictEqual([]);
    await expect(
      statementsAbout(entity, readerOf(unique("member"), group))
    ).resolves.toStrictEqual([]);
    await expect(
      statementsAbout(entity, readerOf(owner, group))
    ).resolves.toStrictEqual(["Acme is in Rotterdam"]);

    await addSource("Acme is in Rotterdam", audience(unique("other")), source);
    await expect(
      statementsAbout(entity, readerOf(owner, group), { history: true })
    ).resolves.toStrictEqual([]);
    await expect(
      shared().readEntity({ entity, reader: readerOf(owner, group) })
    ).resolves.toBeNull();
  });

  // Threat 3: a newer memory ends an older one only for those who may read it.
  it("stays current for a reader who can't read the memory that ended it", async () => {
    const left = unique("left");
    const right = unique("right");
    const writer = unique("writer");
    const { entities } = await remember(
      audience(left),
      [customer()],
      [
        fact(
          { kind: "writer", writer },
          { attribute: "status", value: "Active", statement: "Active" }
        ),
      ]
    );
    const entity = entities.c ?? "";
    await remember(
      audience(right),
      [customer({ id: entity })],
      [
        fact(
          { kind: "writer", writer },
          { attribute: "status", value: "Churned", statement: "Churned" }
        ),
      ],
      shared(),
      crypto.randomUUID(),
      readerOf(unique("adder"), left, right)
    );

    await expect(
      statementsAbout(entity, readerOf(unique("l"), left))
    ).resolves.toStrictEqual(["Active"]);
    await expect(
      statementsAbout(entity, readerOf(unique("b"), left, right))
    ).resolves.toStrictEqual(["Churned"]);
  });

  // Threat 4: names and entities seen only through readable memories.
  it("shows an entity's names and identifiers only through memories the reader may read", async () => {
    const left = unique("left");
    const right = unique("right");
    const email = `${unique("anna")}@example.test`;
    const secret = unique("Codename");
    const person = (names: string[]): NewEntity => ({
      key: "p",
      kind: "person",
      names,
      identifiers: [{ type: "email", value: email }],
    });
    const about = (statement: string): NewMemory => ({
      about: "p",
      type: "fact",
      statement,
      speaker: { kind: "system" },
      basis: { kind: "writer", writer: unique("w") },
    });
    const first = await remember(
      audience(left),
      [person(["Anna"])],
      [about("Anna works in sales")]
    );
    const second = await remember(
      audience(right),
      [person([secret])],
      [about("Anna leads the secret project")]
    );
    // Linked only through what every reader of the add may read: the
    // other group's memory makes an entity of its own.
    expect(second.entities.p).not.toBe(first.entities.p);
    const leftReader = readerOf(unique("l"), left);

    await expect(
      shared().findEntities({
        reader: leftReader,
        identifier: { type: "email", value: email.toUpperCase() },
      })
    ).resolves.toStrictEqual([
      {
        id: first.entities.p,
        kind: "person",
        names: ["Anna"],
        identifiers: [{ type: "email", value: email }],
      },
    ]);
    await expect(
      shared().findEntities({ reader: leftReader, name: secret })
    ).resolves.toStrictEqual([]);
    await expect(
      shared().findEntities({
        reader: readerOf(unique("x")),
        kind: "person",
        identifier: { type: "email", value: email },
      })
    ).resolves.toStrictEqual([]);
    await expect(
      shared().readEntity({
        entity: first.entities.p ?? "",
        reader: readerOf(unique("x")),
      })
    ).resolves.toBeNull();
  });

  // Threat 4: where an entity stands depends only on what the reader may read.
  it("lists entities in the order of the first memory the reader may read, whatever was linked before", async () => {
    const group = unique("group");
    const email = `${unique("old")}@example.test`;
    const linked = (key: string): NewEntity => ({
      key,
      kind: "supplier",
      identifiers: [{ type: "email", value: email }],
    });
    const say = (about: string, statement: string): NewMemory => ({
      about,
      type: "fact",
      statement,
      speaker: { kind: "system" },
      basis: { kind: "writer", writer: unique("w") },
    });
    await remember(
      audience(unique("hidden")),
      [linked("s")],
      [say("s", "Hidden")]
    );
    const first = await remember(
      audience(group),
      [{ key: "s", kind: "supplier", names: [unique("First")] }],
      [say("s", "First")]
    );
    const second = await remember(
      audience(group),
      [linked("s")],
      [say("s", "Second")]
    );

    const found = await shared().findEntities({
      reader: readerOf(unique("reader"), group),
      kind: "supplier",
    });
    expect(
      found
        .map(({ id }) => id)
        .filter((id) => id === first.entities.s || id === second.entities.s)
    ).toStrictEqual([first.entities.s, second.entities.s]);
  });
});

describe("what the store refuses", () => {
  const writer = { kind: "writer", writer: "w" } as const;

  // Threat 6: text from outside never becomes an instruction or preference.
  it("refuses an instruction or preference that is not an internal person's word", async () => {
    for (const speaker of [
      { kind: "outside" },
      { kind: "agent", agent: "a" },
      { kind: "system" },
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await expect(
        remember(
          audience(unique("g")),
          [customer()],
          [fact(writer, { type: "instruction", speaker })]
        )
      ).rejects.toThrow("only an internal person's word");
    }
  });

  it("refuses what doesn't fit its entity, an entity no memory mentions, and a version it doesn't hold", async () => {
    const group = audience(unique("g"));
    await expect(
      remember(
        group,
        [customer()],
        [fact(writer, { attribute: "role", value: "x" })]
      )
    ).rejects.toThrow("attribute its entity's kind hasn't");
    await expect(
      remember(
        group,
        [customer()],
        [fact(writer, { attribute: "account_owner", value: "x" })]
      )
    ).rejects.toThrow("related entity");
    await expect(
      remember(group, [customer()], [fact(writer, { attribute: "status" })])
    ).rejects.toThrow("needs a value");
    await expect(
      remember(group, [customer(), { key: "t", kind: "team" }], [fact(writer)])
    ).rejects.toThrow("no memory mentions");
    await expect(
      remember(
        group,
        [customer()],
        [
          fact({
            kind: "source",
            source: unique("none"),
            version: 1,
            quote: "x",
          }),
        ]
      )
    ).rejects.toThrow("version this store doesn't hold");
  });

  // Threat 11: a person's own store keeps only theirs, answers only them.
  it("keeps a person's own memories in their store, and refuses anyone else's there", async () => {
    const person = unique("person");
    const mine: Access = { kind: "owner", person };
    const { entities } = await remember(
      mine,
      [customer()],
      [fact({ kind: "writer", writer: person }, { statement: "Mine alone" })],
      own(person)
    );

    await expect(
      statementsAbout(entities.c ?? "", readerOf(person), {}, own(person))
    ).resolves.toStrictEqual(["Mine alone"]);
    await expect(
      remember(audience(unique("g")), [customer()], [fact(writer)], own(person))
    ).rejects.toThrow("keeps only what its person alone may read");
    await expect(
      called(
        own(person).readMemories({
          entity: entities.c ?? "",
          reader: readerOf(unique("other")),
        })
      )
    ).rejects.toThrow("answers only the person whose it is");
  });
});

describe("ending a memory", () => {
  it("lets a time-bound fact stop being current at its end", async () => {
    const group = unique("group");
    const until = new Date(Date.now() + 60 * 60_000);
    const { entities } = await remember(
      audience(group),
      [{ key: "c", kind: "person", names: ["Anna"] }],
      [
        fact(
          { kind: "writer", writer: unique("w") },
          {
            attribute: "availability",
            value: "on leave",
            statement: "Anna is on leave",
            validUntil: until,
          }
        ),
      ]
    );
    const entity = entities.c ?? "";
    const reader = readerOf(unique("reader"), group);
    const after = new Date(until.getTime() + 1);

    await expect(statementsAbout(entity, reader)).resolves.toStrictEqual([
      "Anna is on leave",
    ]);
    await expect(
      statementsAbout(entity, reader, { asOf: after })
    ).resolves.toStrictEqual([]);
    await expect(
      statementsAbout(entity, reader, { asOf: after, history: true })
    ).resolves.toStrictEqual(["Anna is on leave"]);
  });

  // Threat 9: only a writer's own, still believed, and answered alike otherwise.
  it("retires a writer's own memory as history, and answers nothing for anyone else's", async () => {
    const group = unique("group");
    const writer = unique("writer");
    const version = await addSource("Acme is active", audience(group));
    const { entities, memories } = await remember(
      audience(group),
      [customer()],
      [
        fact({ kind: "writer", writer }, { statement: "Mine" }),
        fact(
          { kind: "source", ...version, quote: "Acme is active" },
          { statement: "Sourced" }
        ),
      ]
    );
    const [mine = "", sourced = ""] = memories;

    const reader = readerOf(unique("reader"), group);
    const outsider = readerOf(unique("outsider"));
    const outcomes = [
      await shared().retireMemory({
        memory: mine,
        writer: unique("other"),
        reader,
      }),
      await shared().retireMemory({ memory: sourced, writer, reader }),
      await shared().retireMemory({ memory: mine, writer, reader: outsider }),
      await shared().retireMemory({ memory: mine, writer, reader }),
      await shared().retireMemory({ memory: mine, writer, reader }),
    ];

    expect(outcomes).toStrictEqual([
      "nothing",
      "nothing",
      "nothing",
      "done",
      "nothing",
    ]);
    await expect(
      statementsAbout(entities.c ?? "", reader)
    ).resolves.toStrictEqual(["Sourced"]);
    await expect(
      statementsAbout(entities.c ?? "", reader, { history: true })
    ).resolves.toStrictEqual(["Sourced", "Mine"]);
  });
});

describe("erasure", () => {
  // Threat 10: what rests on an erased source goes, names with it, also after a restore.
  it("hides a source's memories at once, deletes them with names no other memory gives, and keeps them gone after a restore", async () => {
    const group = unique("group");
    const secret = unique("Hidden");
    const version = await addSource("Acme is in Rotterdam", audience(group));
    const { entities } = await remember(
      audience(group),
      [customer({ names: [secret] })],
      [fact({ kind: "source", ...version, quote: "Acme is in Rotterdam" })]
    );
    const entity = entities.c ?? "";
    const reader = readerOf(unique("reader"), group);
    const backup = await copyOf(shared());

    await shared().eraseSource({ source: version.source, reason: "deleted" });
    await expect(
      statementsAbout(entity, reader, { history: true })
    ).resolves.toStrictEqual([]);
    await tick();
    const left = async () =>
      await runInDurableObject(
        shared(),
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              `SELECT (SELECT count(*) FROM entities WHERE id = ?1)
              + (SELECT count(*) FROM entity_names WHERE value = ?2) AS count`,
              entity,
              secret
            )
            .one().count
      );
    await expect(left()).resolves.toBe(0);

    await restore(shared(), backup);
    await expect(
      shared().findEntities({ reader, name: secret })
    ).resolves.toStrictEqual([]);
    await tick();
    await expect(left()).resolves.toBe(0);
  });

  it("deletes the memories only an erased person may read, and keeps them gone after a restore", async () => {
    const person = unique("person");
    const group = unique("group");
    const { entities } = await remember(
      { kind: "owner", person },
      [customer({ names: [unique("Private")] })],
      [fact({ kind: "writer", writer: person }, { statement: "Only mine" })]
    );
    const shared_ = await remember(
      audience(group),
      [customer({ id: entities.c ?? "" })],
      [fact({ kind: "writer", writer: person }, { statement: "The team's" })],
      shared(),
      crypto.randomUUID(),
      readerOf(person, group)
    );
    const backup = await copyOf(shared());

    await shared().erasePerson({ person, reason: "person_erased" });
    await expect(
      statementsAbout(entities.c ?? "", readerOf(person, group))
    ).resolves.toStrictEqual(["The team's"]);

    await restore(shared(), backup);
    await expect(
      statementsAbout(entities.c ?? "", readerOf(person, group))
    ).resolves.toStrictEqual(["The team's"]);
    expect(shared_.entities.c).toBe(entities.c);
    await kill(shared());
  });
});

describe("the words way over memories", () => {
  it("finds current memories the reader may read by their words in any form, and nothing hidden", async () => {
    const group = unique("group");
    const marker = unique("zebra").replaceAll("-", "");
    await remember(
      audience(group),
      [customer()],
      [
        fact(
          { kind: "writer", writer: unique("w") },
          { statement: `Acme renews its invoices ${marker}` }
        ),
      ]
    );
    const find = async (reader: Reader) =>
      await runInDurableObject(shared(), (_instance, state) =>
        memoriesByWords(state.storage.sql, {
          question: `invoice ${marker}`,
          reader,
          at: Date.now(),
        }).map(({ statement, words }) => [statement, words])
      );

    await expect(find(readerOf(unique("r"), group))).resolves.toStrictEqual([
      [`Acme renews its invoices ${marker}`, 2],
    ]);
    await expect(find(readerOf(unique("r")))).resolves.toStrictEqual([]);
  });
});

/** A memory about `c` by `writer`. */
const byWriter = (
  writer: string,
  extra: Partial<NewMemory> = {}
): NewMemory => ({
  about: "c",
  type: "fact",
  statement: `said by ${writer}`,
  speaker: { kind: "system" },
  basis: { kind: "writer", writer },
  ...extra,
});

/** An email identifier. */
const email = (value: string) => ({ type: "email", value }) as const;

// Review round 1 of #2202: each states what a store without the hidden
// memory, or with the fact as the world has it, would answer.
describe("what hidden memories never decide, and when a fact ends", () => {
  // Threat 4: an identifier links only through memories every reader of the add may read.
  it("never joins two identifiers that only a hidden memory joins", async () => {
    const seen = unique("seen");
    const a = `${unique("a")}@x.test`;
    const b = `${unique("b")}@x.test`;
    await remember(
      audience(unique("hidden")),
      [{ key: "c", kind: "customer", identifiers: [email(a), email(b)] }],
      [byWriter("w-hidden")]
    );
    const first = await remember(
      audience(seen),
      [{ key: "c", kind: "customer", identifiers: [email(b)] }],
      [byWriter("w1")]
    );
    const second = await remember(
      audience(seen),
      [{ key: "c", kind: "customer", identifiers: [email(a)] }],
      [byWriter("w2")]
    );
    const third = await remember(
      audience(seen),
      [{ key: "c", kind: "customer", identifiers: [email(b)] }],
      [byWriter("w3")]
    );

    expect([
      second.entities.c === first.entities.c,
      third.entities.c === first.entities.c,
    ]).toStrictEqual([false, true]);
  });

  // Threat 4: an id the add's reader may not see is an unknown id.
  it("refuses an entity id the add's reader may not see in the words of an unknown one", async () => {
    const hidden = await remember(
      audience(unique("hidden")),
      [customer()],
      [byWriter("w")]
    );
    const named = async (id: string) =>
      await remember(
        audience(unique("seen")),
        [customer({ id })],
        [byWriter("w")]
      ).then(() => "added", String);

    const [hiddenAnswer, unknownAnswer] = [
      await named(hidden.entities.c ?? ""),
      await named(crypto.randomUUID()),
    ];
    expect(hiddenAnswer).toBe(unknownAnswer);
  });

  // Threat 3: where a contested fact stands depends on nothing hidden.
  it("orders contested facts by their first memory the reader may read", async () => {
    const seen = unique("seen");
    const reader = readerOf(unique("p"), seen);
    const hidden = unique("hidden");
    const old = await remember(
      audience(hidden),
      [{ key: "c", kind: "customer", names: ["X"] }],
      [byWriter("w-hidden")]
    );
    // Added for someone who sees the hidden entity too, readable by `seen`.
    const contest = async (entity: NewEntity): Promise<string> => {
      const added = await shared().addMemories({
        change: crypto.randomUUID(),
        access: audience(seen),
        reader: readerOf(unique("adder"), hidden, seen),
        entities: [entity],
        memories: [
          byWriter(unique("w1"), { attribute: "status", value: "active" }),
          byWriter(unique("w2"), { attribute: "status", value: "lost" }),
        ],
      });
      return added.entities.c ?? "";
    };
    const y = await contest({ key: "c", kind: "customer", names: ["Y"] });
    const x = await contest({
      key: "c",
      kind: "customer",
      id: old.entities.c ?? "",
      names: ["X"],
    });

    const facts = await shared().listContested({ reader });
    expect(
      facts.map(({ about }) => about).filter((id) => id === x || id === y)
    ).toStrictEqual([y, x]);
  });

  // Threat 3: a confirmation made without seeing a rival never ranks first for one who sees it.
  it("counts a confirmation only for a reader whose every current rival it was made over", async () => {
    const left = unique("left");
    const right = unique("right");
    const made = await remember(
      audience(left),
      [{ key: "c", kind: "customer" }],
      [byWriter(unique("w1"), { attribute: "status", value: "active" })]
    );
    const entity = made.entities.c ?? "";
    // Added for someone who sees both sides, readable by the right only.
    await shared().addMemories({
      change: crypto.randomUUID(),
      access: audience(right),
      reader: readerOf(unique("adder"), left, right),
      entities: [{ key: "c", kind: "customer", id: entity }],
      memories: [
        byWriter(unique("w2"), { attribute: "status", value: "lost" }),
      ],
    });
    await expect(
      shared().confirmMemory({
        memory: made.memories[0] ?? "",
        reader: readerOf(unique("a"), left),
      })
    ).resolves.toBe("done");

    const { memories } = await shared().readMemories({
      entity,
      reader: readerOf(unique("b"), left, right),
    });
    const active = memories.find(({ value }) => value === "active");
    expect([active?.contested, active?.confirmed]).toStrictEqual([true, null]);
  });

  it("ends what a source's earlier version said once a later version is marked fully extracted", async () => {
    const group = unique("g");
    const source = unique("src");
    const first = await addSource(
      "Acme renews 1 March",
      audience(group),
      source
    );
    const made = await remember(
      audience(group),
      [customer()],
      [
        fact(
          { kind: "source", ...first, quote: "Acme renews 1 March" },
          {
            attribute: "renewal_date",
            value: "1 March",
            statement: "Renews 1 March",
          }
        ),
      ]
    );
    const entity = made.entities.c ?? "";
    const before = new Date();
    const second = await addSource(
      "Acme is in Rotterdam",
      audience(group),
      source
    );
    await shared().addMemories({
      change: crypto.randomUUID(),
      access: audience(group),
      entities: [customer({ id: entity })],
      memories: [
        fact(
          { kind: "source", ...second, quote: "Acme is in Rotterdam" },
          {
            attribute: "location",
            value: "Rotterdam",
            statement: "In Rotterdam",
          }
        ),
      ],
      extracted: second,
    });
    const reader = readerOf(unique("p"), group);

    await expect(statementsAbout(entity, reader)).resolves.toStrictEqual([
      "In Rotterdam",
    ]);
    await expect(
      statementsAbout(entity, reader, { asOf: before })
    ).resolves.toStrictEqual(["Renews 1 March"]);
  });

  it("leaves today's fact current while a newer one of its lineage starts only next year", async () => {
    const group = unique("g");
    const writer = unique("w");
    const made = await remember(
      audience(group),
      [{ key: "c", kind: "person" }],
      [
        byWriter(writer, {
          attribute: "role",
          value: "CTO",
          statement: "is CTO",
        }),
      ]
    );
    const entity = made.entities.c ?? "";
    const nextYear = new Date(Date.now() + 365 * 86_400_000);
    await remember(
      audience(group),
      [{ key: "c", kind: "person", id: entity }],
      [
        byWriter(writer, {
          attribute: "role",
          value: "CEO",
          statement: "is CEO from next year",
          validFrom: nextYear,
        }),
      ]
    );
    const reader = readerOf(unique("p"), group);

    await expect(statementsAbout(entity, reader)).resolves.toStrictEqual([
      "is CTO",
    ]);
    await expect(
      statementsAbout(entity, reader, {
        asOf: new Date(nextYear.getTime() + 1),
      })
    ).resolves.toStrictEqual(["is CEO from next year"]);
  });

  it("records a person's repeated confirmation once", async () => {
    const group = unique("g");
    const made = await remember(
      audience(group),
      [{ key: "c", kind: "customer" }],
      [byWriter(unique("w"), { attribute: "status", value: "active" })]
    );
    const reader = readerOf(unique("p"), group);
    const memory = made.memories[0] ?? "";
    const outcomes = [
      await shared().confirmMemory({ memory, reader }),
      await shared().confirmMemory({ memory, reader }),
    ];
    const confirmations = await runInDurableObject(
      shared(),
      (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT count(*) AS count FROM memory_confirmations
            WHERE memory = (SELECT row FROM memories WHERE id = ?)`,
            memory
          )
          .one().count
    );

    expect({ outcomes, confirmations }).toStrictEqual({
      outcomes: ["done", "done"],
      confirmations: 1,
    });
  });

  it("re-indexes memories' words when the word rules are rebuilt", async () => {
    const group = unique("group");
    const marker = unique("kiwi").replaceAll("-", "");
    await remember(
      audience(group),
      [customer()],
      [
        fact(
          { kind: "writer", writer: unique("w") },
          { statement: `Acme ${marker}` }
        ),
      ]
    );
    const found = async () =>
      await runInDurableObject(
        shared(),
        (_instance, state) =>
          memoriesByWords(state.storage.sql, {
            question: marker,
            reader: readerOf(unique("r"), group),
            at: Date.now(),
          }).length
      );
    // As an index by older rules would hold it: nothing of the memory.
    await runInDurableObject(shared(), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM memory_words");
      state.storage.sql.exec("DELETE FROM memory_stems");
    });
    const before = await found();
    await expect(shared().rebuildWords()).resolves.toBe("done");
    for (let ticks = 0; ticks < 50; ticks += 1) {
      // oxlint-disable-next-line no-await-in-loop -- a tick at a time
      await tick();
      // oxlint-disable-next-line no-await-in-loop -- read after each tick
      const overview = await shared().workOverview();
      if (overview.words === "current") {
        break;
      }
    }

    expect({ before, after: await found() }).toStrictEqual({
      before: 0,
      after: 1,
    });
  });
});
