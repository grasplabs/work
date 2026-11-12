// Entities as readers see them (cards.ts, linking.ts), through the
// store's own methods. The threat model is on GRA-1740;
// each test says what it holds. Every test has its own people, groups and
// words, so what earlier tests left in the shared store is hidden from it.
//
// "Hidden versus absent": a reader's answer is taken, rows the reader may
// not read are added, and the answer is taken again: the answer of a
// store without them, then with them. They must be the same.
import { describe, expect, it } from "vite-plus/test";

import {
  audience,
  fact,
  readerOf,
  remember,
  shared,
  unique,
  word,
} from "./entity-helpers.ts";

describe("an entity's card", () => {
  // Threat 1: a card per reader, from what they may read; two readers, two cards.
  it("shows each reader the values, contested sides and relations they may read", async () => {
    const [sales, finance] = [unique("sales"), unique("finance")];
    const name = word();
    const { entities } = await remember(
      audience(sales),
      [
        { key: "c", kind: "customer", names: [name] },
        { key: "p", kind: "person", names: [`${name} Contact`] },
      ],
      [
        fact(
          "c",
          `${name} is active`,
          { attribute: "status", value: "Active" },
          "crm"
        ),
        fact("c", `${name} is reached through its contact`, {
          attribute: "contact",
          object: "p",
        }),
      ]
    );
    const entity = entities.c ?? "";
    await remember(
      audience(finance),
      [{ key: "c", id: entity, kind: "customer", names: [`${name} B.V.`] }],
      [
        fact(
          "c",
          `${name} is on hold`,
          { attribute: "status", value: "On hold" },
          "ledger"
        ),
      ],
      readerOf(unique("maker"), sales, finance)
    );
    const salesCard = await shared().readCard({
      entity,
      reader: readerOf(unique("ann"), sales),
    });
    const bothCard = await shared().readCard({
      entity,
      reader: readerOf(unique("bob"), sales, finance),
    });

    const outsider = await shared().readCard({
      entity,
      reader: readerOf(unique("eve"), unique("other")),
    });
    const bothNames = await shared().readEntityNames({
      entity,
      reader: readerOf(unique("bob"), sales, finance),
    });

    expect({
      sales: {
        name: salesCard?.entity.name,
        attributes: salesCard?.attributes.map(
          ({ attribute, contested, memories }) => ({
            attribute,
            contested,
            values: memories.map(({ value }) => value),
          })
        ),
        relations: salesCard?.relations.map(({ other, side }) => ({
          name: other.name,
          side,
        })),
      },
      both: {
        name: bothCard?.entity.name,
        names: bothNames.names.map(({ value }) => value),
        contested: bothCard?.attributes[0]?.contested,
        values: bothCard?.attributes[0]?.memories
          .map(({ value }) => value)
          .toSorted(),
      },
    }).toStrictEqual({
      sales: {
        name,
        attributes: [
          { attribute: "status", contested: false, values: ["Active"] },
        ],
        relations: [{ name: `${name} Contact`, side: "about" }],
      },
      both: {
        name,
        names: [name, `${name} B.V.`],
        contested: true,
        values: ["Active", "On hold"],
      },
    });
    expect(outsider).toBeNull();
  });

  // Threat 1: hidden versus absent, for a card.
  it("is the same card whether or not hidden memories, names and relations exist", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const name = word();
    const { entities } = await remember(
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
    const entity = entities.c ?? "";
    const before = await shared().readCard({ entity, reader });
    const hiddenGroup = unique("hidden");
    const hidden = audience(hiddenGroup);
    await remember(
      hidden,
      [
        { key: "c", id: entity, kind: "customer", names: [`${name} Secret`] },
        { key: "p", kind: "person", names: [`${name} Insider`] },
      ],
      [
        fact(
          "c",
          `${name} renews in June`,
          { attribute: "renewal_date", value: "June" },
          "other"
        ),
        fact("c", `${name} has an insider`, {
          attribute: "contact",
          object: "p",
        }),
        fact("c", `${name} note nobody may see`),
      ],
      readerOf(unique("maker"), group, hiddenGroup)
    );

    await expect(shared().readCard({ entity, reader })).resolves.toStrictEqual(
      before
    );
  });
});

describe("linking entities", () => {
  // Threat 2: an exact name links within the add's own set of readers only.
  it("links an entity by its exact name within the same readers, and proposes it across others", async () => {
    const [group, other] = [unique("team"), unique("other")];
    const name = `${word()} ${word()}`;
    const first = await remember(
      audience(group),
      [{ key: "c", kind: "supplier", names: [name] }],
      [fact("c", `${name} delivers steel`)]
    );
    const again = await remember(
      audience(group),
      [{ key: "c", kind: "supplier", names: [name.toUpperCase()] }],
      [fact("c", `${name} delivers weekly`)]
    );
    const elsewhere = await remember(
      audience(other),
      [{ key: "c", kind: "supplier", names: [name] }],
      [fact("c", `${name} sends invoices`)]
    );
    // Threat 3: seen only by a reader of both names that matched.
    const forGroup = await shared().listProposals({
      entity: first.entities.c ?? "",
      reader: readerOf(unique("ann"), group),
    });
    const forBoth = await shared().listProposals({
      entity: elsewhere.entities.c ?? "",
      reader: readerOf(unique("bob"), group, other),
    });

    expect({
      linked: again.entities.c === first.entities.c,
      apart: elsewhere.entities.c !== first.entities.c,
      forGroup,
      forBoth: forBoth.proposals.map(
        ({ entity, candidate, name: matched, candidateName }) => ({
          entity: entity.id,
          candidate: candidate.id,
          matched,
          candidateName,
        })
      ),
      more: forBoth.more,
    }).toStrictEqual({
      linked: true,
      apart: true,
      forGroup: { proposals: [], more: false },
      forBoth: [
        {
          entity: elsewhere.entities.c,
          candidate: first.entities.c,
          matched: name,
          // The first of the candidate's spellings the reader may read.
          candidateName: name.toUpperCase(),
        },
      ],
      more: false,
    });
  });

  // A name of one word is no exact evidence: a proposal, never a link.
  it("never links two entities by a name of one word, and proposes them", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const name = word();
    const first = await remember(
      audience(group),
      [{ key: "p", kind: "person", names: [name] }],
      [fact("p", `${name} joined in March`)]
    );
    const second = await remember(
      audience(group),
      [{ key: "p", kind: "person", names: [name] }],
      [fact("p", `${name} works in sales`)]
    );
    const proposals = await shared().listProposals({
      entity: second.entities.p ?? "",
      reader,
    });

    expect({
      apart: first.entities.p !== second.entities.p,
      candidates: proposals.proposals.map(({ candidate }) => candidate.id),
    }).toStrictEqual({ apart: true, candidates: [first.entities.p] });
  });

  // A repeated word counts once, on either side: "X X" and "X" match.
  it("matches a name with a repeated word both ways", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const name = word();
    const { entities } = await remember(
      audience(group),
      [
        { key: "a", kind: "customer", names: [`${name} ${name}`] },
        { key: "b", kind: "customer", names: [name] },
      ],
      [fact("a", `${name} twice`), fact("b", `${name} once`)]
    );
    const fromRepeated = await shared().listProposals({
      entity: entities.a ?? "",
      reader,
    });
    const fromSingle = await shared().listProposals({
      entity: entities.b ?? "",
      reader,
    });

    expect({
      fromRepeated: fromRepeated.proposals.map(({ candidate }) => candidate.id),
      fromSingle: fromSingle.proposals.map(({ candidate }) => candidate.id),
    }).toStrictEqual({
      fromRepeated: [entities.b],
      fromSingle: [entities.a],
    });
  });

  // Threat 3: a likely match is whole words, one name's all among the other's.
  it("proposes the names whose words are all among another's, a page at a time", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const name = word();
    const add = async (names: string[]) =>
      await remember(
        audience(group),
        names.map((one, index) => ({
          key: `c${index}`,
          kind: "customer" as const,
          names: [one],
        })),
        names.map((one, index) => fact(`c${index}`, `${one} is a customer`))
      );
    const { entities } = await add([name]);
    const likely = await add([
      `${name} Holding`,
      `The ${name} Group`,
      `${name}s Holding`,
    ]);
    const entity = entities.c0 ?? "";
    const first = await shared().listProposals({ entity, reader, limit: 1 });
    const rest = await shared().listProposals({
      entity,
      reader,
      after: first.proposals.at(-1)?.candidate.id,
    });
    // By id, as the store compares them: byte by byte (ids are ASCII).
    const expected = [
      likely.entities.c0 ?? "",
      likely.entities.c1 ?? "",
    ].toSorted((a, b) => (a < b ? -1 : 1));

    expect({
      pages: [first, rest].map(({ proposals, more }) => ({
        candidates: proposals.map(({ candidate }) => candidate.id),
        more,
      })),
    }).toStrictEqual({
      pages: [
        { candidates: [expected[0]], more: true },
        { candidates: [expected[1]], more: false },
      ],
    });
  });

  // Threat 3: hidden versus absent. Names a reader may not read, matching
  // or sharing a word, neither add, remove nor move a proposal of theirs.
  it("gives a reader the proposals of a store without the names hidden from them", async () => {
    const [seen, hidden] = [unique("seen"), unique("hidden")];
    const reader = readerOf(unique("ann"), seen);
    const [a, common, b] = [word(), word(), word()];
    const name = `${a} ${common} ${b}`;
    const { entities } = await remember(
      audience(seen),
      [
        { key: "n", kind: "customer", names: [name] },
        { key: "v", kind: "customer", names: [`${name} Holding`] },
      ],
      [fact("n", `${name} is new`), fact("v", `${name} Holding is known`)]
    );
    const entity = entities.n ?? "";
    const before = await shared().listProposals({ entity, reader });
    // More hidden names than any page holds: sharing one word and not
    // matching, and matching likely.
    for (const names of [
      Array.from({ length: 100 }, () => `${word()} ${common}`),
      Array.from({ length: 100 }, () => `${name} ${word()}`),
      Array.from({ length: 100 }, () => common),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await remember(
        audience(hidden),
        names.map((one, index) => ({
          key: `h${index}`,
          kind: "customer" as const,
          names: [one],
        })),
        names.map((one, index) => fact(`h${index}`, `${one} is hidden`))
      );
    }
    const after = await shared().listProposals({ entity, reader });

    expect(after).toStrictEqual(before);
    expect(before.proposals.map(({ candidate }) => candidate.id)).toStrictEqual(
      [entities.v]
    );
  });
});
