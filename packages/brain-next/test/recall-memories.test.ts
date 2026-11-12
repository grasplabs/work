// Recall through memories (recall-memories.ts, pack.ts, across.ts),
// through the store's own methods: memories found by their words and
// along the relations of the entities a question names, packed as the
// plan's "Recall" says. Threat model on GRA-1740 (5, 6). Every test has its
// own people, groups and words.
//
// "Hidden versus absent": a reader's pack is taken, rows the reader may
// not read are added (memories, names, relations, contested values), and
// the pack is taken again: the pack of a store without them, then with
// them. They must be byte for byte the same.
import { packMemoryTokens, recallLimit } from "@grasp-os/brain-next/contract";
import type { Pack, Reader } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { hubRelationsMax, stepsMax } from "../src/recall-memories.ts";
import {
  audience,
  fact,
  readerOf,
  remember,
  shared,
  unique,
  word,
} from "./entity-helpers.ts";

/** A recall as `reader`, with the largest budget. */
const recallAs = async (
  reader: Reader,
  question: string,
  extra: { asOf?: Date; tokens?: number } = {}
): Promise<Pack> =>
  await shared().recall({
    question,
    reader,
    budget: { tokens: extra.tokens ?? 20_000 },
    ...(extra.asOf === undefined ? {} : { asOf: extra.asOf }),
  });

/** The statements the entities way found for `question`, in its order. */
const byEntitiesOf = async (
  reader: Reader,
  question: string
): Promise<string[]> => {
  const finding = await shared().find({
    question,
    reader,
    budget: { tokens: 20_000 },
  });
  return finding.memories.entities.map(({ statement }) => statement);
};

/** The statements of a pack's memories, in its order. */
const statementsOf = (pack: Pack): string[] =>
  pack.memories.map(({ statement }) => statement);

describe("recall through memories", () => {
  // GRA-1742's first criterion: the supplier, without the word.
  it("finds the supplier a named person relates to, without the word in it", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const [person, supplier] = [word(), word()];
    await remember(
      audience(group),
      [
        { key: "p", kind: "person", names: [person] },
        { key: "s", kind: "supplier", names: [`${supplier} Metals`] },
      ],
      [
        fact("p", `${person} looks after the steel orders`, {
          attribute: "owns",
          object: "s",
        }),
        fact("s", "Deliveries of steel bars arrive every Tuesday"),
      ]
    );
    const question = `the supplier ${person} mentioned`;

    await expect(byEntitiesOf(reader, question)).resolves.toStrictEqual([
      `${person} looks after the steel orders`,
      "Deliveries of steel bars arrive every Tuesday",
    ]);
    expect(statementsOf(await recallAs(reader, question))).toContain(
      "Deliveries of steel bars arrive every Tuesday"
    );
  });

  // Threat 5: relations the reader may not read are never followed.
  it("never steps along a relation the reader may not read", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const [person, hiddenName] = [word(), word()];
    const { entities } = await remember(
      audience(group),
      [{ key: "p", kind: "person", names: [person] }],
      [
        fact("p", `${person} works in purchasing`, {
          attribute: "role",
          value: "Buyer",
        }),
      ]
    );
    const before = await recallAs(reader, person);
    const hiddenGroup = unique("hidden");
    await remember(
      audience(hiddenGroup),
      [
        { key: "p", id: entities.p ?? "", kind: "person", names: [person] },
        { key: "s", kind: "supplier", names: [hiddenName] },
      ],
      [
        fact("p", `${person} secretly owns ${hiddenName}`, {
          attribute: "owns",
          object: "s",
        }),
        fact("s", `${hiddenName} is in trouble`),
      ],
      readerOf(unique("maker"), group, hiddenGroup)
    );

    await expect(recallAs(reader, person)).resolves.toStrictEqual(before);
    expect(statementsOf(before)).toStrictEqual([
      `${person} works in purchasing`,
    ]);
  });

  // GRA-1742's third criterion: a hub is not stepped through.
  it("finds a hub's own facts but never steps through it", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const hub = word();
    const spokes = Array.from({ length: hubRelationsMax + 1 }, () => word());
    await remember(
      audience(group),
      [
        { key: "h", kind: "tool", names: [hub] },
        ...spokes.map((spoke, index) => ({
          key: `s${index}`,
          kind: "person" as const,
          names: [spoke],
        })),
      ],
      [
        fact("h", `${hub} is the company's ledger`, {
          attribute: "purpose",
          value: "Ledger",
        }),
        ...spokes.map((spoke, index) =>
          fact(`s${index}`, `${spoke} uses ${hub}`, {
            attribute: "owns",
            object: "h",
          })
        ),
        ...spokes.map((spoke, index) =>
          fact(`s${index}`, `${spoke} sits in Rotterdam`)
        ),
      ]
    );
    await expect(
      byEntitiesOf(reader, `what is ${hub} for`)
    ).resolves.toStrictEqual([`${hub} is the company's ledger`]);
  });

  // A memory's statement first, then its quote, then the passage around it.
  it("packs a memory's statement, then its quote, then its passage, as the budget allows", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const name = word();
    const text = `Minutes. ${name} agreed to pay within thirty days of delivery. Other business followed.`;
    const version = await shared().addSource({
      source: unique("minutes"),
      change: crypto.randomUUID(),
      text,
      access: audience(group),
    });
    const quote = `${name} agreed to pay within thirty days of delivery.`;
    await remember(
      audience(group),
      [{ key: "c", kind: "customer", names: [name] }],
      [
        {
          about: "c",
          type: "decision",
          statement: `${name} pays in thirty days`,
          speaker: { kind: "outside" },
          basis: { kind: "source", ...version, quote },
        },
      ]
    );
    const whole = await recallAs(reader, `${name} payment`);
    const [memory] = whole.memories;

    // Room for the statement and its citation, not for the quote.
    const statementOnly =
      memory === undefined
        ? 1
        : packMemoryTokens({ ...memory, quote: null, context: null }) + 2;
    const tight = await recallAs(reader, `${name} payment`, {
      tokens: statementOnly,
    });

    expect({
      whole: {
        statement: memory?.statement,
        quote: memory?.quote,
        context: memory?.context,
        source: memory?.source,
      },
      tight: {
        quote: tight.memories[0]?.quote,
        truncated: tight.truncated,
      },
    }).toStrictEqual({
      whole: {
        statement: `${name} pays in thirty days`,
        quote,
        context: { position: 0, text },
        source: version,
      },
      tight: { quote: null, truncated: true },
    });
  });

  // Contract v4: an instruction is its writer's own item, said to be one.
  it("gives an instruction in its writer's own store, as an instruction", async () => {
    const writer = unique("ann");
    const name = word();
    // An instruction is its writer's alone: only their own store keeps it.
    const own = env.BRAIN_STORE.getByName(`person:${writer}`);
    await own.addMemories({
      change: crypto.randomUUID(),
      access: { kind: "owner", person: writer },
      entities: [{ key: "p", kind: "person", names: [name] }],
      memories: [
        {
          about: "p",
          attribute: "instruction",
          value: "Answer in Dutch",
          type: "instruction",
          statement: `${name} wants answers in Dutch`,
          speaker: { kind: "internal", person: writer },
          basis: { kind: "writer", writer },
        },
      ],
    });
    const pack = await own.recall({
      question: `${name} answers`,
      reader: readerOf(writer),
      budget: { tokens: 20_000 },
    });

    expect(
      pack.memories.map(({ type, writer: by }) => ({ type, by }))
    ).toStrictEqual([{ type: "instruction", by: writer }]);
  });

  // Contested facts carried in the pack, both sides.
  it("carries both sides of a contested fact the reader may read", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const name = `${word()} ${word()}`;
    await remember(
      audience(group),
      [{ key: "c", kind: "customer", names: [name] }],
      [
        fact(
          "c",
          `${name} renews in March`,
          { attribute: "renewal_date", value: "March" },
          "crm"
        ),
      ]
    );
    await remember(
      audience(group),
      [{ key: "c", kind: "customer", names: [name] }],
      [
        fact(
          "c",
          `The renewal is due in June`,
          { attribute: "renewal_date", value: "June" },
          "ledger"
        ),
      ]
    );
    const pack = await recallAs(reader, `${name} renews`);

    expect(pack.contested).toHaveLength(1);
    expect(pack.contested[0]?.memories).toHaveLength(2);
    expect(statementsOf(pack).toSorted()).toStrictEqual(
      [`${name} renews in March`, "The renewal is due in June"].toSorted()
    );
  });

  // A packed memory holding a word or a quoted part has it found.
  it("says a word or quoted part a packed memory holds was found", async () => {
    const group = unique("g");
    const [x, y, absent] = [word(), word(), word()];
    await remember(
      audience(group),
      [{ key: "c", kind: "customer", names: [word()] }],
      [fact("c", `The code is ${x} ${y} today`)]
    );
    const pack = await recallAs(
      readerOf(unique("ann"), group),
      `"${x} ${y}" ${absent}`
    );

    expect({
      memories: statementsOf(pack),
      notFound: pack.notFound,
    }).toStrictEqual({
      memories: [`The code is ${x} ${y} today`],
      notFound: [absent],
    });
  });

  // GRA-1742's third criterion: a hub counts current relations only.
  it("counts a hub by its current relations alone, not those ended", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const tool = word();
    const owners = Array.from({ length: hubRelationsMax }, () => word());
    const users = Array.from({ length: hubRelationsMax - 1 }, () => word());
    const people = [...owners, ...users];
    // One writer names each owner in turn: each new owner ends the one
    // before, so of the owners one is current; with the users, the tool has
    // exactly `hubRelationsMax` current relations.
    await remember(
      audience(group),
      [
        { key: "t", kind: "tool", names: [tool] },
        ...people.map((one, index) => ({
          key: `p${index}`,
          kind: "person" as const,
          names: [one],
        })),
      ],
      [
        ...owners.map((one, index) =>
          fact(
            "t",
            `${one} owns the tool`,
            {
              attribute: "owner",
              object: `p${index}`,
            },
            "registry"
          )
        ),
        ...users.map((one, index) =>
          fact(`p${owners.length + index}`, `${one} uses the tool`, {
            attribute: "owns",
            object: "t",
          })
        ),
      ]
    );
    // Not a hub: the list is filled with the tool's current relations
    // alone (a hub's relations are never found), none of an owner ended.
    const current = new Set([
      `${owners.at(-1) ?? ""} owns the tool`,
      ...users.map((one) => `${one} uses the tool`),
    ]);
    const found = await byEntitiesOf(reader, `who looks after ${tool}`);

    expect({
      count: found.length,
      unknown: found.filter((statement) => !current.has(statement)),
    }).toStrictEqual({ count: recallLimit, unknown: [] });
  });

  // "As of" reads the memories' two clocks.
  it("reads memories as they were believed and true as of a moment", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const name = word();
    const before = new Date();
    await remember(
      audience(group),
      [{ key: "c", kind: "customer", names: [name] }],
      [fact("c", `${name} opened an office`)]
    );

    expect(
      statementsOf(
        await recallAs(reader, name, { asOf: new Date(before.getTime() - 1) })
      )
    ).toStrictEqual([]);
    expect(statementsOf(await recallAs(reader, name))).toStrictEqual([
      `${name} opened an office`,
    ]);
  });
});

describe("recall through memories, hidden versus absent", () => {
  // Threat 5: a reader's pack and finding, then hidden memories, names,
  // relations and contested values added on the same entities and words,
  // enough to make a hub of the named person if they counted; the second
  // answers must be byte for byte the first.
  it("gives a reader the pack of a store without what is hidden from them", async () => {
    const [seen, hiddenGroup] = [unique("seen"), unique("hidden")];
    const reader = readerOf(unique("ann"), seen);
    const [person, supplier, topic] = [word(), word(), word()];
    const { entities } = await remember(
      audience(seen),
      [
        { key: "p", kind: "person", names: [person] },
        { key: "s", kind: "supplier", names: [supplier] },
      ],
      [
        fact(
          "p",
          `${person} buys ${topic}`,
          { attribute: "role", value: "Buyer" },
          "crm"
        ),
        fact("p", `${person} orders from them`, {
          attribute: "owns",
          object: "s",
        }),
        fact("s", `Deliveries of ${topic} arrive on Tuesday`),
      ]
    );
    const question = `what does ${person} buy, ${topic}`;
    const ask = async () => ({
      pack: await recallAs(reader, question),
      found: await shared().find({
        question,
        reader,
        budget: { tokens: 20_000 },
      }),
    });
    const before = await ask();
    const others = Array.from({ length: hubRelationsMax + 1 }, () => word());
    await remember(
      audience(hiddenGroup),
      [
        {
          key: "p",
          id: entities.p ?? "",
          kind: "person",
          names: [`${person} Secret`],
        },
        { key: "s", id: entities.s ?? "", kind: "supplier", names: [supplier] },
        ...others.map((one, index) => ({
          key: `o${index}`,
          kind: "supplier" as const,
          names: [one],
        })),
      ],
      [
        fact(
          "p",
          `${person} buys ${topic} in secret`,
          { attribute: "role", value: "Spy" },
          "other"
        ),
        fact("s", `${topic} from ${supplier} is late`),
        ...others.map((one, index) =>
          fact("p", `${person} also buys ${topic} from ${one}`, {
            attribute: "owns",
            object: `o${index}`,
          })
        ),
      ],
      readerOf(unique("maker"), seen, hiddenGroup)
    );

    await expect(ask()).resolves.toStrictEqual(before);
    expect(statementsOf(before.pack).toSorted()).toStrictEqual(
      [
        `${person} buys ${topic}`,
        `${person} orders from them`,
        `Deliveries of ${topic} arrive on Tuesday`,
      ].toSorted()
    );
  });
});

/** A relation from `from` to `to`, under `attribute`. */
const relation = (
  from: string,
  to: string,
  statement: string,
  attribute = "owns"
) => fact(from, statement, { attribute, object: to });

/** What the entities way found for `question`, as `step|statement`, by step then statement. */
const stepsOf = async (reader: Reader, question: string): Promise<string[]> => {
  const finding = await shared().find({
    question,
    reader,
    budget: { tokens: 20_000 },
  });
  return finding.memories.entities
    .map(({ step, statement }) => `${step}|${statement}`)
    .toSorted((a, b) => (a < b ? -1 : 1));
};

describe("recall through memories, the walk's rule", () => {
  // A relation whose two ends the walk reached is a memory about both:
  // at the nearer end's step, or the other end's when the nearer is a
  // hub. A relation leading to an entity not reached is not returned.
  it("gives a hub's relation to an entity reached at the other end's step", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const [n, h, x] = [word(), word(), word()];
    const spokes = Array.from({ length: hubRelationsMax + 1 }, () => word());
    await remember(
      audience(group),
      [
        { key: "n", kind: "customer", names: [n] },
        { key: "h", kind: "tool", names: [h] },
        { key: "x", kind: "person", names: [x] },
        ...spokes.map((one, index) => ({
          key: `s${index}`,
          kind: "person" as const,
          names: [one],
        })),
      ],
      [
        fact("h", "H own fact"),
        ...spokes.map((_, index) =>
          relation("h", `s${index}`, `spoke ${index} uses H`, "used_by")
        ),
        relation("n", "x", "N knows X", "contact"),
        relation("h", "x", "X uses H", "used_by"),
        fact("x", "X fact"),
      ]
    );

    await expect(stepsOf(reader, `${n} ${h}`)).resolves.toStrictEqual([
      "0|H own fact",
      "0|N knows X",
      "1|X fact",
      "1|X uses H",
    ]);
  });

  it("gives a relation between a hub and an entity two steps out, at the far step", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const [n, h, w, z] = [word(), word(), word(), word()];
    const spokes = Array.from({ length: hubRelationsMax + 1 }, () => word());
    await remember(
      audience(group),
      [
        { key: "n", kind: "person", names: [n] },
        { key: "h", kind: "tool", names: [h] },
        { key: "w", kind: "customer", names: [w] },
        { key: "z", kind: "person", names: [z] },
        ...spokes.map((one, index) => ({
          key: `s${index}`,
          kind: "person" as const,
          names: [one],
        })),
      ],
      [
        ...spokes.map((_, index) =>
          relation("h", `s${index}`, `spoke ${index} uses H`, "used_by")
        ),
        relation("n", "h", "N uses H"),
        relation("n", "w", "N knows W"),
        relation("w", "z", "W knows Z", "contact"),
        relation("h", "z", "Z uses H", "used_by"),
        fact("z", "Z fact"),
      ]
    );

    await expect(stepsOf(reader, n)).resolves.toStrictEqual([
      "0|N knows W",
      "0|N uses H",
      "1|W knows Z",
      "2|Z fact",
      "2|Z uses H",
    ]);
  });

  it("gives a relation between two entities two steps out, and none leading a third", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const [n, w, z, z2, q] = [word(), word(), word(), word(), word()];
    await remember(
      audience(group),
      [
        { key: "n", kind: "person", names: [n] },
        { key: "w", kind: "customer", names: [w] },
        { key: "z", kind: "person", names: [z] },
        { key: "z2", kind: "person", names: [z2] },
        { key: "q", kind: "customer", names: [q] },
      ],
      [
        relation("n", "w", "N knows W"),
        relation("w", "z", "W knows Z", "contact"),
        relation("w", "z2", "W knows Z2", "contact"),
        relation("z", "q", "Z knows Q, a third step out"),
        relation("z", "z2", "Z manages Z2", "manager"),
        fact("q", "Q fact, three out"),
      ]
    );

    await expect(stepsOf(reader, n)).resolves.toStrictEqual([
      "0|N knows W",
      "1|W knows Z",
      "1|W knows Z2",
      "2|Z manages Z2",
    ]);
  });
});

/** A seeded generator: the same draws for the same seed. */
const drawsOf = (seed: number) => {
  let state = seed;
  return (bound: number): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % bound;
  };
};

/** A memory of a scenario, as the plain walk below reads it. */
interface Planned {
  statement: string;
  about: string;
  object?: string;
  add: number;
  visible: boolean;
  id: string;
}

/**
 * The entities way written out plainly, over the memories `planned` the
 * reader may read: reach from `named` one or two steps through entities
 * that aren't hubs; every fact of an entity reached, and every relation
 * whose two ends were reached, at the step of its nearer end (of its
 * other end when the nearer is a hub); nearest step first, then the
 * newest add, then by id from the last; at most `recallLimit`.
 */
const plainWalk = (planned: readonly Planned[], named: readonly string[]) => {
  const seen = planned.filter(({ visible }) => visible);
  const relationsOf = (key: string) =>
    seen.filter(
      ({ about, object }) =>
        object !== undefined && (about === key || object === key)
    );
  const hub = (key: string) => relationsOf(key).length > hubRelationsMax;
  const steps = new Map(named.map((key) => [key, 0]));
  for (let step = 0; step < stepsMax; step += 1) {
    // A snapshot: what this step adds is the next step's.
    const atStart = [...steps.entries()];
    for (const [key, at] of atStart) {
      if (at === step && !hub(key)) {
        for (const { about, object } of relationsOf(key)) {
          for (const end of [about, object ?? about]) {
            if (!steps.has(end)) {
              steps.set(end, step + 1);
            }
          }
        }
      }
    }
  }
  const stepOf = ({ about, object }: Planned): number | undefined => {
    const here = steps.get(about);
    if (object === undefined) {
      return here;
    }
    const there = steps.get(object);
    if (here === undefined || there === undefined) {
      return undefined;
    }
    const [near, nearAt, farAt] =
      here <= there ? [about, here, there] : [object, there, here];
    return nearAt < farAt && hub(near) ? farAt : nearAt;
  };
  return seen
    .flatMap((memory) => {
      const step = stepOf(memory);
      return step === undefined ? [] : [{ memory, step }];
    })
    .toSorted(
      (a, b) =>
        a.step - b.step ||
        b.memory.add - a.memory.add ||
        (a.memory.id < b.memory.id ? 1 : -1)
    )
    .slice(0, recallLimit)
    .map(({ memory, step }) => `${step}|${memory.statement}`);
};

/** A scenario's entity's kind, by its key. */
const kindOf = (key: string) =>
  key.startsWith("c") ? ("customer" as const) : ("person" as const);

/** A planned memory as the add takes it. */
const toMemory = ({ about, object, statement }: Omit<Planned, "id">) =>
  object === undefined
    ? fact(about, statement)
    : fact(about, statement, {
        attribute: about.startsWith("c") ? "contact" : "owns",
        object,
      });

describe("recall through memories, against a plain walk", () => {
  // Seeded scenarios: people and customers, a hub, random relations and
  // facts in two readable adds, and hidden ones between them (relations,
  // facts, and more than a hub's worth on one person). The entities way,
  // through the store's `find`, must give exactly what the plain walk
  // above gives over what the reader may read.
  it.each([1, 2, 3, 4, 5, 6])(
    "matches the plain walk (seed %i)",
    async (seed) => {
      const draw = drawsOf(seed);
      const [seenGroup, hiddenGroup] = [unique("seen"), unique("hidden")];
      const reader = readerOf(unique("ann"), seenGroup);
      const maker = readerOf(unique("maker"), seenGroup, hiddenGroup);
      const people = Array.from({ length: 6 }, (_, index) => `p${index}`);
      const customers = Array.from({ length: 6 }, (_, index) => `c${index}`);
      const spokes = Array.from(
        { length: hubRelationsMax + 1 },
        (_, index) => `s${index}`
      );
      const names = new Map(
        [...people, ...customers, ...spokes].map((key) => [key, word()])
      );
      const planned: Planned[] = [];
      const known = new Map<string, string>();
      const pairs = new Set<string>();
      const randomRelations = (
        count: number,
        add: number,
        visible: boolean
      ) => {
        const made: Omit<Planned, "id">[] = [];
        for (let index = 0; index < count; index += 1) {
          const person = people[draw(people.length)] ?? "p0";
          const customer = customers[draw(customers.length)] ?? "c0";
          const owns = draw(2) === 0;
          const [about, object] = owns
            ? [person, customer]
            : [customer, person];
          if (!pairs.has(`${about} ${object}`)) {
            pairs.add(`${about} ${object}`);
            made.push({
              statement: `${names.get(about)} ${owns ? "owns" : "contacts"} ${names.get(object)} ${add}`,
              about,
              object,
              add,
              visible,
            });
          }
        }
        return made;
      };
      const randomFacts = (add: number, visible: boolean) =>
        [...people, ...customers]
          .filter(() => draw(3) === 0)
          .map((about) => ({
            statement: `${names.get(about)} note ${add} ${draw(1000)}`,
            about,
            add,
            visible,
          }));
      const add = async (
        memories: Omit<Planned, "id">[],
        group: string,
        first: boolean
      ) => {
        const keys = [
          ...new Set(
            memories.flatMap(({ about, object }) => [about, object ?? about])
          ),
        ];
        const { memories: ids, entities } = await remember(
          audience(group),
          keys.map((key) => ({
            key,
            ...(known.has(key) ? { id: known.get(key) ?? "" } : {}),
            kind: kindOf(key),
            names: [names.get(key) ?? ""],
          })),
          memories.map(toMemory),
          first ? undefined : maker
        );
        for (const [key, id] of Object.entries(entities)) {
          known.set(key, id);
        }
        for (const [index, memory] of memories.entries()) {
          planned.push({ ...memory, id: ids[index] ?? "" });
        }
      };
      // The first add makes every entity, the hub's spokes among them.
      await add(
        [
          ...[...people, ...customers].map((about) => ({
            statement: `${names.get(about)} exists`,
            about,
            add: 1,
            visible: true,
          })),
          ...spokes.map((spoke, index) => ({
            statement: `${names.get("c0")} contacts spoke ${index}`,
            about: "c0",
            object: spoke,
            add: 1,
            visible: true,
          })),
          ...randomRelations(10, 1, true),
          ...randomFacts(1, true),
        ],
        seenGroup,
        true
      );
      const hiddenCustomers = Array.from(
        { length: hubRelationsMax + 1 },
        (_, index) => `ch${index}`
      );
      for (const key of hiddenCustomers) {
        names.set(key, word());
      }
      await add(
        [
          ...randomRelations(6, 2, false),
          ...randomFacts(2, false),
          ...hiddenCustomers.map((customer) => ({
            statement: `${names.get("p1")} hidden owns ${names.get(customer)}`,
            about: "p1",
            object: customer,
            add: 2,
            visible: false,
          })),
        ].map((memory) => ({ ...memory, visible: false })),
        hiddenGroup,
        false
      );
      await add(
        [...randomRelations(5, 3, true), ...randomFacts(3, true)],
        seenGroup,
        false
      );
      const asked = [
        ...new Set([
          [...people, ...customers][draw(12)] ?? "p0",
          ...(draw(2) === 0
            ? [[...people, ...customers][draw(12)] ?? "c0"]
            : []),
        ]),
      ];
      const finding = await shared().find({
        question: asked.map((key) => names.get(key)).join(" and "),
        reader,
        budget: { tokens: 20_000 },
      });

      expect(
        finding.memories.entities.map(
          ({ step, statement }) => `${step}|${statement}`
        )
      ).toStrictEqual(plainWalk(planned, asked));
    }
  );
});
