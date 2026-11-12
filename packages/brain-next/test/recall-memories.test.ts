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
import { packMemoryTokens } from "@grasp-os/brain-next/contract";
import type {
  NewEntity,
  NewMemory,
  Pack,
  Reader,
} from "@grasp-os/brain-next/contract";
import { describe, expect, it } from "vite-plus/test";

import { hubRelationsMax } from "../src/recall-memories.ts";
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
  // Threat part 2, 6: a join is stepped through for its person alone.
  it("steps through two entities a person joined, for them alone", async () => {
    const group = unique("team");
    const [ann, bob] = [
      readerOf(unique("ann"), group),
      readerOf(unique("bob"), group),
    ];
    const name = word();
    await remember(
      audience(group),
      [{ key: "c", kind: "customer", names: [`${name} Holding`] }],
      [fact("c", `${name} Holding signed the contract`)]
    );
    const short = await remember(
      audience(group),
      [{ key: "c", kind: "customer", names: [name] }],
      [fact("c", `${name} called about delivery`, {}, "someone")]
    );
    const entity = short.entities.c ?? "";
    const bobBefore = await byEntitiesOf(bob, name);
    const [proposal] = await shared().listProposals({ reader: ann, entity });
    await shared().decideProposal({
      proposal: proposal?.id ?? "",
      reader: ann,
      accept: true,
    });
    const annFound = await byEntitiesOf(ann, name);
    const bobAfter = await byEntitiesOf(bob, name);

    expect({ annFound: annFound.toSorted(), bobAfter }).toStrictEqual({
      annFound: [
        `${name} Holding signed the contract`,
        `${name} called about delivery`,
      ].toSorted(),
      bobAfter: bobBefore,
    });
  });

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
  it("gives an instruction to its writer alone, as an instruction", async () => {
    const writer = unique("ann");
    const other = readerOf(unique("bob"));
    const name = word();
    await remember(
      { kind: "owner", person: writer },
      [{ key: "p", kind: "person", names: [name] }],
      [
        {
          about: "p",
          attribute: "instruction",
          value: "Answer in Dutch",
          type: "instruction",
          statement: `${name} wants answers in Dutch`,
          speaker: { kind: "internal", person: writer },
          basis: { kind: "writer", writer },
        },
      ]
    );
    const own = await recallAs(readerOf(writer), `${name} answers`);
    const others = await recallAs(other, `${name} answers`);

    expect({
      own: own.memories.map(({ type, writer: by }) => ({ type, by })),
      others: others.memories,
    }).toStrictEqual({
      own: [{ type: "instruction", by: writer }],
      others: [],
    });
  });

  // Contested facts carried in the pack, both sides.
  it("carries both sides of a contested fact the reader may read", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const name = word();
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

/** A seeded generator: the same draws for the same seed. */
const drawsOf = (seed: number) => {
  let state = seed;
  return (bound: number): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % bound;
  };
};

describe("recall through memories, at random", () => {
  // Threat 5: from a seed, a reader's entities, facts and relations; asked
  // a few questions; then hidden memories, names, relations and contested
  // values are added on the same entities and words. Every pack must stay
  // byte for byte what it was. And the entities way returns exactly the
  // current memories a brute-force walk of two steps finds, when they fit.
  it.each([1, 2, 3, 4, 5])(
    "gives a reader the pack of a store without what is hidden from them (seed %i)",
    async (seed) => {
      const draw = drawsOf(seed);
      const group = unique("team");
      const reader = readerOf(unique("ann"), group);
      const names = Array.from({ length: 5 }, () => word());
      const topic = word();
      const entities: NewEntity[] = names.map((name, index) => ({
        key: `e${index}`,
        kind: "person",
        names: [name],
      }));
      const relations: [number, number][] = [];
      const memories: NewMemory[] = names.map((name, index) =>
        fact(`e${index}`, `${name} talks about ${topic} ${draw(1000)}`)
      );
      for (let index = 0; index < 4; index += 1) {
        const [from, to] = [draw(names.length), draw(names.length)];
        if (from !== to) {
          relations.push([from, to]);
          memories.push(
            fact(
              `e${from}`,
              `${names[from]} works with ${names[to]}`,
              {
                attribute: "manager",
                object: `e${to}`,
              },
              `w${index}`
            )
          );
        }
      }
      const added = await remember(audience(group), entities, memories);
      const questions = [
        topic,
        names[0] ?? "",
        `${names[draw(names.length)]} and ${topic}`,
      ];
      const before = await Promise.all(
        questions.map(async (question) => await recallAs(reader, question))
      );

      // Brute force: the entities named by the first question's name, two
      // steps along the readable relations, every current memory about them.
      const reach = new Map<number, number>([[0, 0]]);
      for (let step = 1; step <= 2; step += 1) {
        for (const [from, to] of relations) {
          for (const [a, b] of [
            [from, to],
            [to, from],
          ] as const) {
            if (reach.get(a) === step - 1 && !reach.has(b)) {
              reach.set(b, step);
            }
          }
        }
      }
      const expected = memories
        .filter(
          ({ about, object }) =>
            reach.has(Number(about.slice(1))) ||
            (object !== undefined && reach.has(Number(object.slice(1))))
        )
        .map(({ statement }) => statement)
        .toSorted();
      const reached = await byEntitiesOf(reader, names[0] ?? "");
      expect(reached.toSorted()).toStrictEqual(expected);

      const hiddenGroup = unique("hidden");
      const hidden = audience(hiddenGroup);
      const others = Array.from({ length: 3 }, () => word());
      await remember(
        hidden,
        [
          ...names.map((name, index) => ({
            key: `e${index}`,
            id: added.entities[`e${index}`] ?? "",
            kind: "person" as const,
            names: [name, `${name} ${word()}`],
          })),
          ...others.map((name, index) => ({
            key: `o${index}`,
            kind: "person" as const,
            names: [name],
          })),
        ],
        [
          ...names.map((name, index) =>
            fact(`e${index}`, `${name} hides ${topic} ${draw(1000)}`, {
              attribute: "role",
              value: word(),
            })
          ),
          ...others.map((_, index) =>
            fact(
              `e${draw(names.length)}`,
              `${topic} hidden link ${index}`,
              {
                attribute: "manager",
                object: `o${index}`,
              },
              `h${index}`
            )
          ),
        ],
        readerOf(unique("maker"), group, hiddenGroup)
      );
      const after = await Promise.all(
        questions.map(async (question) => await recallAs(reader, question))
      );

      expect(after).toStrictEqual(before);
    }
  );
});
