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

  // Hidden or not yet there is absent: as of a moment before the first
  // memory the reader may read mentions it, there is no card.
  it("is no card as of a moment before the first memory the reader may read", async () => {
    const [group, hiddenGroup] = [unique("team"), unique("hidden")];
    const reader = readerOf(unique("ann"), group);
    const name = word();
    const { entities } = await remember(
      audience(hiddenGroup),
      [{ key: "c", kind: "customer", names: [name] }],
      [fact("c", `${name} note nobody may see`)]
    );
    const entity = entities.c ?? "";
    await scheduler.wait(5);
    const between = new Date();
    await scheduler.wait(5);
    await remember(
      audience(group),
      [{ key: "c", id: entity, kind: "customer", names: [name] }],
      [fact("c", `${name} is a customer`)],
      readerOf(unique("maker"), group, hiddenGroup)
    );

    const before = await shared().readCard({ entity, reader, asOf: between });
    const now = await shared().readCard({ entity, reader });

    expect({
      before,
      now: now?.notes.map(({ statement }) => statement),
    }).toStrictEqual({ before: null, now: [`${name} is a customer`] });
  });

  // A card's pages are one snapshot: a name a related entity gains
  // between pages is not on the next page, even read as of a moment
  // ahead (when facts are judged true then, not what was learned since).
  it("names related entities on every page as of the first page's moment", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const name = word();
    const { entities } = await remember(
      audience(group),
      [
        { key: "c", kind: "customer", names: [name] },
        { key: "p", kind: "person", names: [] },
        { key: "q", kind: "person", names: [] },
      ],
      [
        fact("c", `${name} is reached through one contact`, {
          attribute: "contact",
          object: "p",
        }),
        fact("c", `${name} is reached through another contact`, {
          attribute: "contact",
          object: "q",
        }),
      ]
    );
    const entity = entities.c ?? "";
    const ahead = new Date(Date.now() + 86_400_000);
    const first = await shared().readCard({
      entity,
      reader,
      asOf: ahead,
      limit: 1,
    });
    await remember(
      audience(group),
      ["p", "q"].map((key) => ({
        key,
        id: entities[key] ?? "",
        kind: "person" as const,
        names: [`${word()} Named`],
      })),
      ["p", "q"].map((key) => fact(key, "A contact got a name"))
    );
    const second = await shared().readCard({
      entity,
      reader,
      asOf: ahead,
      limit: 1,
      ...(first?.next === undefined ? {} : { after: first.next }),
    });

    expect(
      [first, second].map((card) =>
        card?.relations.map(({ other }) => other.name)
      )
    ).toStrictEqual([[null], [null]]);
  });
});

describe("linking entities", () => {
  // Threat 2: an exact name links within the add's own set of readers only.
  it("links an entity by its exact name within the same readers, never across others", async () => {
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

    expect({
      linked: again.entities.c === first.entities.c,
      apart: elsewhere.entities.c !== first.entities.c,
    }).toStrictEqual({ linked: true, apart: true });
  });

  // A name of one word is no exact evidence: never a link.
  // The order of adds decides: an entity given an identifier links only
  // by its identifiers, one given none by its exact name. So a name and
  // an email, then the name alone, are one entity; the name alone first,
  // then the name and the email, are two.
  it("links by the name after an add with an identifier, never the other way round", async () => {
    const name = `${word()} ${word()}`;
    const email = `${word()}@example.test`;
    const named = { key: "e", kind: "person" as const, names: [name] };
    const withEmail = {
      ...named,
      identifiers: [{ type: "email" as const, value: email }],
    };
    const entityOf = async (group: string, entity: typeof named) => {
      const { entities } = await remember(
        audience(group),
        [entity],
        [fact("e", `${name} works here`)]
      );
      return entities.e;
    };
    const [first, second] = [unique("team"), unique("team")];
    const emailFirst = [
      await entityOf(first, withEmail),
      await entityOf(first, named),
    ];
    const nameFirst = [
      await entityOf(second, named),
      await entityOf(second, withEmail),
    ];

    expect({
      emailFirst: emailFirst[0] === emailFirst[1],
      nameFirst: nameFirst[0] === nameFirst[1],
    }).toStrictEqual({ emailFirst: true, nameFirst: false });
  });

  it("never links two entities by a name of one word", async () => {
    const group = unique("team");
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

    expect(first.entities.p).not.toBe(second.entities.p);
  });
});
