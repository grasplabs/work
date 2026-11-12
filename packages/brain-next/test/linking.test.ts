// Entities as readers see them (cards.ts, linking.ts, joins.ts), through
// the store's own methods. The threat model is on GRA-1740 (both parts);
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

    expect({
      sales: {
        names: salesCard?.entity.names,
        attributes: salesCard?.attributes.map(
          ({ attribute, contested, memories }) => ({
            attribute,
            contested,
            values: memories.map(({ value }) => value),
          })
        ),
        relations: salesCard?.relations.map(({ other, side }) => ({
          names: other.names,
          side,
        })),
      },
      both: {
        names: bothCard?.entity.names,
        contested: bothCard?.attributes[0]?.contested,
        values: bothCard?.attributes[0]?.memories
          .map(({ value }) => value)
          .toSorted(),
      },
    }).toStrictEqual({
      sales: {
        names: [name],
        attributes: [
          { attribute: "status", contested: false, values: ["Active"] },
        ],
        relations: [{ names: [`${name} Contact`], side: "about" }],
      },
      both: {
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
    const name = word();
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

    expect(again.entities.c).toBe(first.entities.c);
    expect(elsewhere.entities.c).not.toBe(first.entities.c);
    // Threat 3: seen only by a reader of both memories whose names matched.
    await expect(
      shared().listProposals({ reader: readerOf(unique("ann"), group) })
    ).resolves.toStrictEqual([]);
    const both = readerOf(unique("bob"), group, other);
    const proposals = await shared().listProposals({
      reader: both,
      entity: elsewhere.entities.c ?? "",
    });
    expect(
      proposals.map(({ entity, candidate, name: matched, candidateName }) => ({
        entity: entity.id,
        candidate: candidate.id,
        matched,
        candidateName,
      }))
    ).toStrictEqual([
      {
        entity: elsewhere.entities.c,
        candidate: first.entities.c,
        matched: name,
        candidateName: name,
      },
    ]);
  });

  // Threat 3: a fuzzy match is a proposal, decided only by one who sees it.
  it("proposes a name whose words are among another's, and lets only a reader of both decide it", async () => {
    const group = unique("team");
    const reader = readerOf(unique("ann"), group);
    const name = word();
    await remember(
      audience(group),
      [{ key: "c", kind: "customer", names: [`${name} Holding`] }],
      [fact("c", `${name} Holding signed`)]
    );
    const short = await remember(
      audience(group),
      [{ key: "c", kind: "customer", names: [name] }],
      [fact("c", `${name} called`, {}, "someone")]
    );
    const [proposal] = await shared().listProposals({
      reader,
      entity: short.entities.c ?? "",
    });
    if (proposal === undefined) {
      throw new Error("No proposal");
    }

    const byOutsider = await shared().decideProposal({
      proposal: proposal.id,
      reader: readerOf(unique("eve"), unique("other")),
      accept: true,
    });
    const declined = await shared().decideProposal({
      proposal: proposal.id,
      reader,
      accept: false,
    });
    const again = await shared().decideProposal({
      proposal: proposal.id,
      reader,
      accept: true,
    });
    const open = await shared().listProposals({
      reader,
      entity: short.entities.c ?? "",
    });

    expect({
      names: [proposal.entity.names, proposal.candidate.names],
      byOutsider,
      declined,
      again,
      open,
    }).toStrictEqual({
      names: [[name], [`${name} Holding`]],
      byOutsider: "nothing",
      declined: "done",
      again: "nothing",
      open: [],
    });
  });
});

describe("a join", () => {
  // Threat part 2, 1 and 2: a join is the accepting person's alone.
  it("reads two entities as one for the person who accepted, and as two for everyone else", async () => {
    const group = unique("team");
    const [ann, bob] = [
      readerOf(unique("ann"), group),
      readerOf(unique("bob"), group),
    ];
    const name = word();
    const holding = await remember(
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
    const bobBefore = {
      card: await shared().readCard({ entity, reader: bob }),
      proposals: await shared().listProposals({ reader: bob, entity }),
    };
    const [proposal] = bobBefore.proposals;
    const accepted = await shared().decideProposal({
      proposal: proposal?.id ?? "",
      reader: ann,
      accept: true,
    });
    const annCard = await shared().readCard({ entity, reader: ann });
    const bobAfter = {
      card: await shared().readCard({ entity, reader: bob }),
      proposals: await shared().listProposals({ reader: bob, entity }),
    };

    expect({
      accepted,
      annCard: {
        id: annCard?.entity.id,
        names: annCard?.entity.names,
        notes: annCard?.notes.map(({ statement }) => statement).toSorted(),
      },
      annProposals: await shared().listProposals({ reader: ann, entity }),
    }).toStrictEqual({
      accepted: "done",
      annCard: {
        id: holding.entities.c,
        names: [`${name} Holding`, name],
        notes: [
          `${name} Holding signed the contract`,
          `${name} called about delivery`,
        ].toSorted(),
      },
      annProposals: [],
    });
    expect(bobAfter).toStrictEqual(bobBefore);
  });
});

describe("the member link", () => {
  // Threat 4: a document naming a member's email never links them.
  it("is made only by a verified sign-in, and gone with the person's erasure", async () => {
    const group = unique("team");
    const member = unique("member");
    const reader = readerOf(member, group);
    const email = `${word()}@example.test`;
    const { entities } = await remember(
      audience(group),
      [
        {
          key: "p",
          kind: "person",
          names: ["Anna"],
          identifiers: [{ type: "email", value: email }],
        },
      ],
      [fact("p", "Anna leads purchasing", { attribute: "role", value: "Lead" })]
    );

    const beforeSignIn = await shared().memberEntity({ reader });
    await shared().linkMember({ member, email: email.toUpperCase() });
    const signedIn = await shared().memberEntity({ reader });
    // Once: a second sign-in keeps the link.
    await shared().linkMember({ member, email: `other-${email}` });
    const again = await shared().memberEntity({ reader });
    // Seen only by a member who may read a memory naming the entity.
    const withoutAccess = await shared().memberEntity({
      reader: readerOf(member),
    });
    await shared().erasePerson({ person: member, reason: "person_erased" });
    const erased = await shared().memberEntity({ reader });

    expect({
      beforeSignIn,
      signedIn,
      again,
      withoutAccess,
      erased,
    }).toStrictEqual({
      beforeSignIn: null,
      signedIn: entities.p,
      again: entities.p,
      withoutAccess: null,
      erased: null,
    });
  });
});
