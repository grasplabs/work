import type { Plan, Roster } from "@grasp-os/shared/onboarding";
import { describe, expect, it } from "vite-plus/test";

import {
  addWorkingDays,
  agreementsIn,
  dueLinks,
  progressOf,
} from "../src/onboarding/rules.ts";
import type { InterviewState, LinkFacts } from "../src/onboarding/rules.ts";

// The onboarding's rules (src/onboarding/rules.ts): whose links are due,
// and what the company's admin may see. Pure logic, so tested on its own.
// How it can go wrong:
//
// - A link out too early: before its team's moment, before the lead had
//   their say, for someone away or in a team that doesn't take part.
// - A link that never goes: a lead who never talks holds the team forever.
// - Numbers that single someone out: a small team's, or numbers that move
//   the moment someone agrees.

const person = (id: string, team: string, away = false) => ({
  id,
  name: `Name of ${id}`,
  email: `${id}@acme.test`,
  team,
  title: "",
  away,
});

/** Sales, led by Lea, with five more; Ops, without a lead, with two. */
const roster: Roster = {
  teams: [
    { id: "sales", name: "Sales", lead: "lea", does: "", off: false },
    { id: "ops", name: "Ops", lead: null, does: "", off: false },
    { id: "legal", name: "Legal", lead: null, does: "", off: true },
  ],
  people: [
    person("lea", "sales"),
    person("sam", "sales"),
    person("sid", "sales"),
    person("sue", "sales"),
    person("sy", "sales"),
    person("sal", "sales", true),
    person("oli", "ops"),
    person("ona", "ops"),
    person("lou", "legal"),
  ],
};

/** Monday 12 October 2026. */
const plan: Plan = { start: "2026-10-12", days: 14 };

const nothing: LinkFacts = {
  sent: new Set(),
  interviews: new Map(),
  mapped: new Set(),
};

const at = (day: string, time = "09:00:00") => `${day}T${time}.000Z`;

const completed = (
  ...people: [string, string][]
): Map<string, InterviewState> =>
  new Map(
    people.map(([id, when]) => [
      id,
      { person: id, startedAt: when, completedAt: when },
    ])
  );

describe("whose links are due", () => {
  it("sends nothing without a plan, and nothing before its moment", () => {
    expect(dueLinks(roster, null, nothing, at("2026-10-12"))).toStrictEqual([]);
    expect(
      dueLinks(roster, plan, nothing, at("2026-10-11", "23:59:59"))
    ).toStrictEqual([]);
  });

  it("sends the lead's on the start day, and a team without a lead at once, never anyone away or off", () => {
    expect(dueLinks(roster, plan, nothing, at("2026-10-12"))).toStrictEqual([
      "lea",
      "oli",
      "ona",
    ]);
  });

  it("sends the team's once its lead agreed and the work is mapped", () => {
    const facts: LinkFacts = {
      sent: new Set(["lea", "oli", "ona"]),
      interviews: completed(["lea", at("2026-10-12")]),
      mapped: new Set(["sales"]),
    };
    expect(dueLinks(roster, plan, facts, at("2026-10-13"))).toStrictEqual([
      "sam",
      "sid",
      "sue",
      "sy",
    ]);
    // Agreed, but no map yet: they wait.
    expect(
      dueLinks(roster, plan, { ...facts, mapped: new Set() }, at("2026-10-13"))
    ).toStrictEqual([]);
  });

  it("sends the team's anyway three working days after the start, weekends not counted", () => {
    const facts: LinkFacts = {
      ...nothing,
      sent: new Set(["lea", "oli", "ona"]),
    };
    expect(addWorkingDays("2026-10-15", 3)).toBe("2026-10-20");
    expect(dueLinks(roster, plan, facts, at("2026-10-14"))).toStrictEqual([]);
    expect(dueLinks(roster, plan, facts, at("2026-10-15"))).toStrictEqual([
      "sam",
      "sid",
      "sue",
      "sy",
    ]);
  });

  it("holds a team planned later until its own moment, and a team not planned yet altogether", () => {
    const later: Plan = {
      ...plan,
      later: { ops: at("2026-10-19"), sales: null },
    };
    expect(dueLinks(roster, later, nothing, at("2026-10-12"))).toStrictEqual(
      []
    );
    expect(dueLinks(roster, later, nothing, at("2026-10-19"))).toStrictEqual([
      "oli",
      "ona",
    ]);
  });

  it("never sends a link twice", () => {
    const facts: LinkFacts = { ...nothing, sent: new Set(["lea"]) };
    expect(dueLinks(roster, plan, facts, at("2026-10-12"))).toStrictEqual([
      "oli",
      "ona",
    ]);
  });
});

describe("what the company's admin sees", () => {
  it("shows a team of five or more its numbers, and a smaller team none", () => {
    const progress = progressOf(
      roster,
      completed(["sam", at("2026-10-13")]),
      at("2026-10-14")
    );
    const [sales, ops] = progress.teams;
    expect(sales).toMatchObject({ people: 6, talked: 1, asked: 4 });
    expect(ops).toMatchObject({ people: 2, talked: null, asked: null });
    // Together, only the teams that are shown count.
    expect(progress).toMatchObject({ talked: 1, asked: 4 });
  });

  it("moves its numbers once a day, so two looks can't tell who just talked", () => {
    const interviews = completed(
      ["sam", at("2026-10-13")],
      ["sid", at("2026-10-14", "08:00:00")]
    );
    const morning = progressOf(
      roster,
      interviews,
      at("2026-10-14", "07:00:00")
    );
    const noon = progressOf(roster, interviews, at("2026-10-14", "12:00:00"));
    const tomorrow = progressOf(roster, interviews, at("2026-10-15"));
    expect(noon.talked).toBe(morning.talked);
    expect(noon.asOf).toBe("2026-10-14");
    expect(tomorrow.talked).toBe(morning.talked + 1);
  });

  it("says whether each lead talked, and counts the leads apart", () => {
    const progress = progressOf(
      roster,
      completed(["lea", at("2026-10-12")]),
      at("2026-10-13")
    );
    expect(progress.teams[0]?.leadTalked).toBeTruthy();
    expect(progress).toMatchObject({ leadsTalked: 1, leads: 1 });
  });
});

describe("the agreements", () => {
  it("are in only with both agreements and the works council agreed or not there", () => {
    expect(agreementsIn(null)).toBeFalsy();
    expect(
      agreementsIn({ processing: true, assessment: true, council: "agreed" })
    ).toBeTruthy();
    expect(
      agreementsIn({ processing: true, assessment: true, council: "none" })
    ).toBeTruthy();
    expect(
      agreementsIn({ processing: true, assessment: true, council: "waiting" })
    ).toBeFalsy();
    expect(
      agreementsIn({ processing: true, assessment: false, council: "none" })
    ).toBeFalsy();
  });
});
