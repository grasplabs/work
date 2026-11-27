import { describe, expect, it } from "vite-plus/test";

import {
  countsOf,
  found,
  takesPart,
  TooManyPeopleError,
  typedOf,
  unlisted,
  withAdded,
  withLead,
  withTaking,
} from "./people-picks.ts";
import type { Picks } from "./people-picks.ts";

const person = (id: string, team: string, name = id) => ({
  id,
  name,
  email: `${id}@acme.test`,
  team,
  title: "",
  away: false,
});

const picks: Picks = {
  teams: [
    { id: "sales", name: "Sales", lead: "ann", does: "", off: false },
    { id: "ops", name: "Operations", lead: null, does: "", off: false },
  ],
  people: [
    person("ann", "sales", "Ann Smit"),
    person("bob", "sales", "Bob de Jong"),
    person("cas", "ops", "Cas Öztürk"),
  ],
};

const taking = (of: Picks): string[] =>
  of.people.filter((each) => takesPart(of, each)).map(({ id }) => id);

describe("who takes part", () => {
  it("leaves someone out as core keeps it: away, while the rest of their team takes part", () => {
    const next = withTaking(picks, new Set(["bob"]), false);
    expect({
      taking: taking(next),
      bob: next.people.find(({ id }) => id === "bob")?.away,
      sales: next.teams.find(({ id }) => id === "sales")?.off,
    }).toStrictEqual({ taking: ["ann", "cas"], bob: true, sales: false });
  });

  it("switches a team off once nobody in it takes part, and its lead leads no more", () => {
    const next = withTaking(picks, new Set(["ann", "bob"]), false);
    expect(next.teams.find(({ id }) => id === "sales")).toMatchObject({
      off: true,
      lead: null,
    });
    expect(taking(next)).toStrictEqual(["cas"]);
  });

  it("brings one person of a team switched off back alone", () => {
    const off = withTaking(picks, new Set(["ann", "bob"]), false);
    expect(taking(withTaking(off, new Set(["bob"]), true))).toStrictEqual([
      "bob",
      "cas",
    ]);
  });
});

describe("the leads", () => {
  it("lets a team have several leads: marking another adds them, the first still first", () => {
    const next = withLead(picks, "bob", true);
    expect(next.teams.find(({ id }) => id === "sales")).toMatchObject({
      lead: "ann",
      coLeads: ["bob"],
    });
    expect(countsOf(next).leads).toBe(2);
  });

  it("lets the next lead lead first once the first is unmarked, or no longer takes part", () => {
    const two = withLead(picks, "bob", true);
    expect(
      withLead(two, "ann", false).teams.find(({ id }) => id === "sales")
    ).toMatchObject({ lead: "bob", coLeads: [] });
    expect(
      withTaking(two, new Set(["ann"]), false).teams.find(
        ({ id }) => id === "sales"
      )
    ).toMatchObject({ lead: "bob", coLeads: [] });
  });

  it("makes a lead take part", () => {
    const out = withTaking(picks, new Set(["cas"]), false);
    const next = withLead(out, "cas", true);
    expect({
      taking: taking(next),
      lead: next.teams.find(({ id }) => id === "ops")?.lead,
    }).toStrictEqual({ taking: ["ann", "bob", "cas"], lead: "cas" });
  });
});

describe("the search", () => {
  it("finds by name, team or address, whatever the case or accents", () => {
    expect(found(picks, "ozturk").map(({ id }) => id)).toStrictEqual(["cas"]);
    expect(found(picks, "SALES").map(({ id }) => id)).toStrictEqual([
      "ann",
      "bob",
    ]);
    expect(found(picks, "bob@").map(({ id }) => id)).toStrictEqual(["bob"]);
  });
});

describe("addresses pasted", () => {
  it("reads them as a mail program copies them, each once, and names what is no address", () => {
    expect(
      typedOf(
        "Anna de Vries <Anna@acme.nl>; tom.bakker@acme.nl\nanna@acme.nl, nope"
      )
    ).toStrictEqual({
      typed: [
        { name: "Anna de Vries", email: "anna@acme.nl" },
        { name: "Tom Bakker", email: "tom.bakker@acme.nl" },
      ],
      wrong: ["nope"],
    });
  });

  it("offers to add from the search only addresses not on the list, and only when it is all addresses", () => {
    expect(unlisted(picks, "dee@acme.test, BOB@acme.test")).toStrictEqual([
      { name: "Dee", email: "dee@acme.test" },
    ]);
    expect(unlisted(picks, "dee@acme.test bob")).toStrictEqual([]);
    expect(unlisted(picks, "ann")).toStrictEqual([]);
    expect(unlisted(picks, "dee@acme")).toStrictEqual([]);
  });

  it("adds new people to a new team, and ticks someone already in rather than adding them twice", () => {
    const out = withTaking(picks, new Set(["bob"]), false);
    const {
      picks: next,
      added,
      there,
    } = withAdded(
      out,
      [
        { name: "Dee", email: "dee@acme.test" },
        { name: "Bob", email: "bob@acme.test" },
      ],
      { newTeam: "Finance" }
    );
    const dee = next.people.find(({ email }) => email === "dee@acme.test");
    expect({
      added,
      there,
      team: next.teams.find(({ id }) => id === dee?.team)?.name,
      taking: taking(next).length,
    }).toStrictEqual({ added: 1, there: 1, team: "Finance", taking: 4 });
  });

  it("puts people in the team there is when a new one is named like it", () => {
    const { picks: next } = withAdded(
      picks,
      [{ name: "Dee", email: "dee@acme.test" }],
      { newTeam: " sales " }
    );
    expect(next.teams).toHaveLength(2);
    expect(next.people.at(-1)?.team).toBe("sales");
  });

  it("refuses more people than an onboarding takes", () => {
    const many = Array.from({ length: 2000 }, (_, at) => ({
      name: "",
      email: `p${at}@acme.test`,
    }));
    expect(() => withAdded(picks, many, { team: "ops" })).toThrow(
      TooManyPeopleError
    );
  });
});
