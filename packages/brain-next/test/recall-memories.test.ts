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
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { readMoment } from "../src/memories.ts";
import { findMemories, hubRelationsMax } from "../src/recall-memories.ts";
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

describe("recall through memories, step by step", () => {
  // Nearer steps fill the list, so what lies two steps out is never
  // read: the statements the store executes show no read of that step,
  // and adding far entities' facts between two asks changes nothing.
  it("reads no entity two steps out once the nearer steps fill the list", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const seed = `${word()} ${word()}`;
    const mids = Array.from({ length: 3 }, () => word());
    const fars = mids.map(() => word());
    const { entities } = await remember(
      audience(group),
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
    // The reads of a step the store runs: the statements reading one
    // step's memories (recall-memories.ts, `here` of a step), each as the
    // store executes it. (The rows they read are no measure here: every
    // statement judging memories reads a share of the whole table.)
    const ask = async () =>
      await runInDurableObject(shared(), (_instance, state) => {
        let steps = 0;
        const counted = new Proxy(state.storage.sql, {
          get: (target, key): unknown => {
            if (key !== "exec") {
              const value: unknown = Reflect.get(target, key, target);
              return value;
            }
            return (...args: Parameters<SqlStorage["exec"]>) => {
              if (args[0].includes("'$.here'")) {
                steps += 1;
              }
              return target.exec(...args);
            };
          },
        });
        const found = findMemories(
          counted,
          {
            question: seed,
            reader,
            at: readMoment(state.storage.sql),
            words: [],
          },
          (_way, run) => run()
        );
        return {
          statements: found.entities.map(({ statement }) => statement),
          steps,
        };
      });
    const before = await ask();
    await remember(
      audience(group),
      fars.map((one, index) => ({
        key: `f${index}`,
        id: entities[`f${index}`] ?? "",
        kind: "person" as const,
        names: [],
      })),
      fars.flatMap((one, index) =>
        Array.from({ length: 20 }, (_, note) =>
          fact(`f${index}`, `${one} far note ${note}`)
        )
      )
    );
    const after = await ask();

    // Two steps read (the named entity, then one on), and the same
    // answer: the step holding the far facts was never read.
    expect(after).toStrictEqual(before);
    expect({
      found: before.statements.length,
      steps: before.steps,
    }).toStrictEqual({ found: recallLimit, steps: 2 });
  });
});
