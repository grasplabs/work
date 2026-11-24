import { describe, expect, it } from "vite-plus/test";

import {
  agreementsIn,
  assignWork,
  clientProgressOf,
  codeOf,
  dueLinks,
  sendsFrom,
  metered,
  keyMark,
  NOTHING_SAID,
  opensFor,
  OrgRecordError,
  parsePlan,
  parseProgress,
  parseRoster,
  personStateOf,
  splitCode,
  stateOfInterview,
} from "../../src/admin/org-record.ts";
import type {
  HeldInterview,
  InterviewState,
  LinkRecord,
  Plan,
  Roster,
  RosterPerson,
  WorkRecord,
} from "../../src/admin/org-record.ts";

const person = (
  id: string,
  team: string,
  more: Partial<RosterPerson> = {}
): RosterPerson => ({
  id,
  name: id,
  email: `${id}@example.com`,
  team,
  title: "",
  away: false,
  work: null,
  ...more,
});

/** Customer service with a lead and five others, sales with a lead and one other, and a back office without a lead. */
const roster: Roster = {
  teams: [
    {
      id: "t-service",
      name: "Customer service",
      lead: "daan",
      does: "",
      off: false,
    },
    { id: "t-sales", name: "Sales", lead: "mark", does: "", off: false },
    { id: "t-office", name: "Back office", lead: null, does: "", off: false },
  ],
  people: [
    person("daan", "t-service"),
    person("lisa", "t-service"),
    person("tim", "t-service"),
    person("bram", "t-service"),
    person("sophie", "t-service"),
    person("anna", "t-service"),
    person("mark", "t-sales"),
    person("emma", "t-sales"),
    person("noor", "t-office"),
  ],
};

// Monday 5 October 2026.
const plan: Plan = {
  start: "2026-10-05",
  days: 14,
  told: "2026-10-02T10:00:00Z",
};
const links: Record<string, LinkRecord> = Object.fromEntries(
  roster.people.map((each) => [
    each.id,
    { person: each.id, secret: "x", sent: null, opened: null, reminded: null },
  ])
);
const done = (completed: string | null): InterviewState => ({
  person: "",
  kind: "lead",
  version: 1,
  updated: completed ?? "2026-10-05T09:00:00Z",
  completed,
  stopped: null,
  progress: {
    startedAt: 1,
    person: completed === null ? "progress" : "completed",
    phase: "story",
  },
});

const talking = (
  updated: string,
  progressOf: InterviewState["progress"]["person"] = "progress"
): InterviewState => ({
  ...done(null),
  updated,
  progress: { startedAt: 1, person: progressOf, phase: "story" },
});
const work = (id: string, doers: string[], share: number): WorkRecord => ({
  id,
  team: "t-service",
  name: id,
  item: ["one", "ones"],
  doers,
  share,
  from: "lead",
  drawn: null,
  stale: false,
});

describe("a link’s code", () => {
  it("is the organization and a secret, and nothing else counts as one", () => {
    expect(
      splitCode(codeOf("rivierdal-1a2b", "AAAAAAAAAAAAAAAAAAAAAA"))
    ).toStrictEqual({
      org: "rivierdal-1a2b",
      secret: "AAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(splitCode("rivierdal-1a2b.short")).toBeNull();
    expect(splitCode("Rivierdal.AAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
    expect(splitCode(42)).toBeNull();
  });
});

describe("the agreements", () => {
  it("are in place once both are signed and the works council is not still deciding", () => {
    expect(agreementsIn({ test: false }, {})).toBeFalsy();
    expect(
      agreementsIn(
        { test: false },
        { agreed: { processing: true, assessment: false, council: "none" } }
      )
    ).toBeFalsy();
    expect(
      agreementsIn(
        { test: false },
        { agreed: { processing: true, assessment: true, council: "waiting" } }
      )
    ).toBeFalsy();
    expect(
      agreementsIn(
        { test: false },
        { agreed: { processing: true, assessment: true, council: "none" } }
      )
    ).toBeTruthy();
    expect(
      agreementsIn(
        { test: false },
        { agreed: { processing: true, assessment: true, council: "yes" } }
      )
    ).toBeTruthy();
  });

  it("are taken as in place for an organization made to try things out", () => {
    expect(agreementsIn({ test: true }, {})).toBeTruthy();
  });
});

describe("whose links are due", () => {
  it("is nobody’s before the start day", () => {
    expect(
      dueLinks(roster, plan, links, {}, new Set(), "2026-10-04T12:00:00Z")
    ).toStrictEqual([]);
  });

  it("is the leads’ on the start day, and everyone’s in a team without a lead", () => {
    expect(
      dueLinks(
        roster,
        plan,
        links,
        {},
        new Set(),
        "2026-10-05T07:00:00Z"
      ).toSorted()
    ).toStrictEqual(["daan", "mark", "noor"]);
  });

  it("is a team’s once its lead agreed to their interview and its work is drawn, not before", () => {
    const lead = { daan: done("2026-10-05T11:00:00Z") };
    expect(
      dueLinks(roster, plan, links, lead, new Set(), "2026-10-05T12:00:00Z")
    ).not.toContain("lisa");
    expect(
      dueLinks(
        roster,
        plan,
        links,
        lead,
        new Set(["t-service"]),
        "2026-10-05T12:00:00Z"
      )
    ).toStrictEqual(
      expect.arrayContaining(["lisa", "tim", "bram", "sophie", "anna"])
    );
    expect(
      dueLinks(
        roster,
        plan,
        links,
        lead,
        new Set(["t-service"]),
        "2026-10-05T12:00:00Z"
      )
    ).not.toContain("emma");
  });

  it("is a team’s anyway after three working days without its lead", () => {
    // Friday is the fourth working day, Thursday the third after Monday.
    expect(
      dueLinks(roster, plan, links, {}, new Set(), "2026-10-07T12:00:00Z")
    ).not.toContain("emma");
    expect(
      dueLinks(roster, plan, links, {}, new Set(), "2026-10-08T12:00:00Z")
    ).toContain("emma");
  });

  it("is nobody’s who is away, in a team that does not take part, or whose link is out already; a team whose lead is away does not wait for them", () => {
    const away: Roster = {
      teams: roster.teams.map((team) =>
        team.id === "t-office" ? { ...team, off: true } : team
      ),
      people: roster.people.map((each) =>
        each.id === "mark" ? { ...each, away: true } : each
      ),
    };
    expect(
      dueLinks(away, plan, links, {}, new Set(), "2026-10-05T07:00:00Z")
    ).toStrictEqual(["daan", "emma"]);
    expect(
      dueLinks(
        roster,
        plan,
        {
          ...links,
          daan: {
            person: "daan",
            secret: "x",
            sent: "2026-10-05T07:00:00Z",
            opened: null,
            reminded: null,
          },
        },
        {},
        new Set(),
        "2026-10-05T08:00:00Z"
      )
    ).not.toContain("daan");
  });

  it("is nobody’s without a plan", () => {
    expect(
      dueLinks(roster, null, links, {}, new Set(), "2026-10-05T07:00:00Z")
    ).toStrictEqual([]);
  });

  it("waits for the lead of a team asked in later from the day it was asked in", () => {
    // Asked in on the second Monday: its lead gets a link that day, and the team three working days later, not at once.
    const late: Roster = {
      ...roster,
      teams: roster.teams.map((team) =>
        team.id === "t-sales" ? { ...team, since: "2026-10-12" } : team
      ),
    };
    expect(
      dueLinks(late, plan, links, {}, new Set(), "2026-10-12T08:00:00Z")
    ).toContain("mark");
    expect(
      dueLinks(late, plan, links, {}, new Set(), "2026-10-12T08:00:00Z")
    ).not.toContain("emma");
    expect(
      dueLinks(late, plan, links, {}, new Set(), "2026-10-14T08:00:00Z")
    ).not.toContain("emma");
    expect(
      dueLinks(late, plan, links, {}, new Set(), "2026-10-15T08:00:00Z")
    ).toContain("emma");
    // Without that day it would have gone out at once: the three days from the start are long over.
    expect(
      dueLinks(roster, plan, links, {}, new Set(), "2026-10-12T08:00:00Z")
    ).toContain("emma");
  });

  it("keeps the day a team was asked in when the list comes in again", () => {
    const kept = parseRoster({
      teams: [
        { id: "t-a", name: "A", since: "2026-10-12" },
        { id: "t-b", name: "B", since: "soon" },
      ],
      people: [{ name: "Ann", team: "t-a" }],
    });
    expect(kept.teams.map((team) => team.since)).toStrictEqual([
      "2026-10-12",
      undefined,
    ]);
  });
});

describe("where someone stands", () => {
  const out: LinkRecord = {
    person: "lisa",
    secret: "x",
    sent: "2026-10-05T07:00:00Z",
    opened: null,
    reminded: null,
  };

  it("follows the link and the interview", () => {
    expect([
      personStateOf(undefined, undefined, plan, "2026-10-05T08:00:00Z"),
      personStateOf(
        { ...out, sent: null },
        undefined,
        plan,
        "2026-10-05T08:00:00Z"
      ),
      personStateOf(out, undefined, plan, "2026-10-05T08:00:00Z"),
      personStateOf(
        { ...out, opened: "2026-10-05T09:00:00Z" },
        undefined,
        plan,
        "2026-10-05T10:00:00Z"
      ),
      personStateOf(
        out,
        talking("2026-10-05T10:00:00Z"),
        plan,
        "2026-10-05T10:05:00Z"
      ),
      personStateOf(
        out,
        done("2026-10-05T10:00:00Z"),
        plan,
        "2026-10-05T10:05:00Z"
      ),
    ]).toStrictEqual([
      "waiting",
      "waiting",
      "invited",
      "opened",
      "progress",
      "completed",
    ]);
  });

  it("counts someone quiet for a quarter of an hour as stopped, and the link closed as closed", () => {
    expect(
      personStateOf(
        out,
        talking("2026-10-05T10:00:00Z"),
        plan,
        "2026-10-05T10:20:00Z"
      )
    ).toBe("incomplete");
    expect(personStateOf(out, undefined, plan, "2026-10-19T08:00:00Z")).toBe(
      "expired"
    );
    expect(
      personStateOf(
        out,
        talking("2026-10-06T10:00:00Z"),
        plan,
        "2026-10-19T08:00:00Z"
      )
    ).toBe("incomplete");
  });
});

describe("what the company’s own admin sees", () => {
  it("shows how many talked only for teams of five or more, and whether each lead talked", () => {
    const progress = clientProgressOf(
      roster,
      {
        daan: done("2026-10-05T11:00:00Z"),
        lisa: done("2026-10-06T11:00:00Z"),
        emma: done("2026-10-06T11:00:00Z"),
      },
      []
    );
    const service = progress.teams.find((team) => team.id === "t-service");
    const sales = progress.teams.find((team) => team.id === "t-sales");
    expect(service).toMatchObject({ leadTalked: true, talked: 1, asked: 5 });
    expect(sales).toMatchObject({
      leadTalked: false,
      talked: null,
      asked: null,
    });
    expect(progress).toMatchObject({
      talked: 2,
      asked: 7,
      leadsTalked: 1,
      leads: 2,
    });
  });
});

describe("who is asked about what", () => {
  it("asks whoever the lead named about their own work, and spreads the rest by how much time each takes", () => {
    const works = [
      work("tickets", ["lisa", "tim"], 0.7),
      work("complaints", ["sophie"], 0.2),
      work("report", [], 0.1),
    ];
    const people = ["lisa", "tim", "bram", "sophie", "anna"].map((id) =>
      person(id, "t-service")
    );
    const assigned = assignWork(people, works);
    expect(assigned).toMatchObject({
      lisa: "tickets",
      tim: "tickets",
      sophie: "complaints",
    });
    expect(
      Object.values(assigned).filter((each) => each === "tickets").length
    ).toBeGreaterThanOrEqual(3);
  });

  it("asks nobody about anything when the lead named no work", () => {
    expect(assignWork([person("lisa", "t-service")], [])).toStrictEqual({
      lisa: null,
    });
  });
});

describe("what comes in, checked", () => {
  it("keeps a lead only in their own team, and each person once", () => {
    const parsed = parseRoster({
      teams: [
        { id: "t-a", name: "A", lead: "p-2" },
        { id: "t-b", name: "B", lead: "p-1" },
      ],
      people: [
        { id: "p-1", name: "One", team: "t-a" },
        { id: "p-1", name: "One again", team: "t-a" },
        { id: "p-2", name: "Two", team: "t-a" },
        { id: "p-3", name: "Nowhere", team: "t-c" },
      ],
    });
    expect(parsed.people.map((each) => each.id)).toStrictEqual(["p-1", "p-2"]);
    expect(parsed.teams.map((each) => each.lead)).toStrictEqual(["p-2", null]);
  });

  it("refuses a list with nobody in it, and a start in the past", () => {
    expect(() => parseRoster({ teams: [{ name: "A" }], people: [] })).toThrow(
      OrgRecordError
    );
    expect(() =>
      parsePlan({ start: "2026-10-01" }, "2026-10-03T10:00:00Z")
    ).toThrow(OrgRecordError);
    expect(
      parsePlan({ start: "2026-10-05", days: 400 }, "2026-10-03T10:00:00Z")
    ).toStrictEqual({ start: "2026-10-05", days: 42 });
  });
});

describe("where an interview stands", () => {
  it("leaves out what was said", () => {
    const held: HeldInterview = {
      person: "lisa",
      kind: "employee",
      progress: {
        ...NOTHING_SAID,
        lines: [{ from: "person", text: "Hello" }],
        startedAt: 5,
        person: "progress",
        phase: "steps",
      },
      version: 3,
      updated: "2026-10-05T10:00:00Z",
      completed: null,
      stopped: null,
    };
    const state = stateOfInterview(held);
    expect(state.progress).toStrictEqual({
      startedAt: 5,
      person: "progress",
      phase: "steps",
    });
    expect(JSON.stringify(state)).not.toContain("Hello");
  });
});

describe("counting what a call took", () => {
  it("adds each call to its day, by what it was for and which model did it", () => {
    let day = metered(
      {},
      {
        purpose: "interviews",
        model: "claude-sonnet-5-5",
        tokensIn: 1000,
        kept: 4000,
        tokensOut: 80,
      }
    );
    day = metered(day, {
      purpose: "interviews",
      model: "claude-sonnet-5-5",
      tokensIn: 500,
      tokensOut: 20,
    });
    day = metered(day, { purpose: "interviews", model: "voice", seconds: 3.5 });
    day = metered(day, {
      purpose: "drawing",
      model: "claude-opus-5-5",
      tokensIn: 6000,
      tokensOut: 1500,
    });
    expect(day.interviews?.["claude-sonnet-5-5"]).toStrictEqual({
      calls: 2,
      tokensIn: 1500,
      kept: 4000,
      tokensOut: 100,
      seconds: 0,
    });
    expect(day.interviews?.voice).toStrictEqual({
      calls: 1,
      tokensIn: 0,
      kept: 0,
      tokensOut: 0,
      seconds: 3.5,
    });
    expect(day.drawing?.["claude-opus-5-5"]?.calls).toBe(1);
    expect(day.reading).toBeUndefined();
  });

  it("takes nothing that is not a count", () => {
    const day = metered(
      {},
      {
        purpose: "reading",
        model: "claude-opus-5-5",
        tokensIn: Number.NaN,
        tokensOut: -5,
        seconds: Number.POSITIVE_INFINITY,
      }
    );
    expect(day.reading?.["claude-opus-5-5"]).toStrictEqual({
      calls: 1,
      tokensIn: 0,
      kept: 0,
      tokensOut: 0,
      seconds: 0,
    });
  });
});

describe("a plan with an hour and teams of its own", () => {
  const timed = { ...plan, at: "2026-10-05T07:00:00.000Z" };

  it("sends nothing before the hour that was set, and the leads from then on", () => {
    expect(
      dueLinks(roster, timed, links, {}, new Set(), "2026-10-05T06:59:00.000Z")
    ).toStrictEqual([]);
    expect(
      dueLinks(
        roster,
        timed,
        links,
        {},
        new Set(),
        "2026-10-05T07:00:00.000Z"
      ).toSorted()
    ).toStrictEqual(["daan", "mark", "noor"]);
  });

  it("keeps a team that goes later until its own moment", () => {
    const later = {
      ...timed,
      later: { "t-service": "2026-10-12T07:00:00.000Z" },
    };
    expect(sendsFrom(later, "t-service")).toBe("2026-10-12T07:00:00.000Z");
    expect(
      dueLinks(roster, later, links, {}, new Set(), "2026-10-06T12:00:00.000Z")
    ).not.toContain("daan");
    expect(
      dueLinks(roster, later, links, {}, new Set(), "2026-10-12T07:00:00.000Z")
    ).toContain("daan");
    // Its people wait for their lead from the day the team's own links went out, not from the first day.
    expect(
      dueLinks(roster, later, links, {}, new Set(), "2026-10-13T12:00:00.000Z")
    ).not.toContain("lisa");
    expect(
      dueLinks(roster, later, links, {}, new Set(), "2026-10-15T12:00:00.000Z")
    ).toContain("lisa");
  });

  it("sends nothing to a team whose turn nobody planned yet", () => {
    const open = { ...timed, later: { "t-service": null } };
    expect(sendsFrom(open, "t-service")).toBeNull();
    const due = dueLinks(
      roster,
      open,
      links,
      {},
      new Set(),
      "2026-11-20T12:00:00.000Z"
    );
    expect(due).not.toContain("daan");
    expect(due).not.toContain("lisa");
    expect(due).toContain("emma");
  });

  it("is read back as it was sent, and refused when it cannot be", () => {
    const now = "2026-10-04T10:00:00.000Z";
    expect(
      parsePlan(
        {
          start: "2026-10-05",
          days: 14,
          at: "2026-10-05T09:00:00+02:00",
          later: {
            "t-service": "2026-10-12T09:00:00+02:00",
            "t-finance": null,
          },
        },
        now
      )
    ).toStrictEqual({
      start: "2026-10-05",
      days: 14,
      at: "2026-10-05T07:00:00.000Z",
      later: { "t-service": "2026-10-12T07:00:00.000Z", "t-finance": null },
    });
    expect(parsePlan({ start: "2026-10-05", days: 14 }, now)).toStrictEqual({
      start: "2026-10-05",
      days: 14,
    });
    expect(() => parsePlan({ start: "2026-10-05", at: "nine" }, now)).toThrow(
      "Pick the time the links go out."
    );
    expect(() =>
      parsePlan({ start: "2026-10-05", at: "2026-10-09T09:00:00Z" }, now)
    ).toThrow("Pick the time the links go out.");
    expect(() =>
      parsePlan(
        {
          start: "2026-10-05",
          at: "2026-10-05T09:00:00Z",
          later: { "t-service": "2026-10-01T09:00:00Z" },
        },
        now
      )
    ).toThrow("A team that goes later cannot go before the first links.");
  });
});

describe("whose a link is", () => {
  it("is the device that opened it first, and nobody else who holds the link", async () => {
    const mine = await keyMark("the-key-of-my-phone");
    const link = { key: mine };
    expect(opensFor(link, mine, false)).toBe("mine");
    // The company's admin handed the link out and still has it: with the link alone, or with another key, nothing opens.
    expect(opensFor(link, null, false)).toBe("elsewhere");
    expect(opensFor(link, await keyMark("another-device"), false)).toBe(
      "elsewhere"
    );
    expect(opensFor(link, await keyMark("the-key-of-my-phone"), true)).toBe(
      "mine"
    );
  });

  it("is whoever opens it first while no device has, but never once the interview was agreed to", () => {
    expect(opensFor({}, null, false)).toBe("new");
    expect(opensFor({}, null, true)).toBe("elsewhere");
  });

  it("keeps a mark of the key, not the key", async () => {
    const mark = await keyMark("abc");
    expect(mark).toMatch(/^[0-9a-f]{64}$/u);
    expect(mark).not.toContain("abc");
    await expect(keyMark("abc")).resolves.toBe(mark);
    await expect(keyMark("abd")).resolves.not.toBe(mark);
  });
});

describe("an interview as a page sends it", () => {
  const line = { from: "person", text: "I open the ticket.", typed: true };
  const fact = {
    id: "f1",
    tag: "step",
    text: "You open the ticket.",
    record: "Open the ticket.",
  };

  it("is kept as lines and facts, and nothing else that was put in them", () => {
    const kept = parseProgress({
      person: "progress",
      lines: [{ ...line, evil: "<script>" }],
      facts: [{ ...fact, approvedBy: "the boss" }],
      phase: "steps",
    });
    expect(kept?.lines).toStrictEqual([line]);
    expect(kept?.facts).toStrictEqual([fact]);
    expect(kept?.phase).toBe("steps");
  });

  it("leaves out what is no line and no fact", () => {
    const kept = parseProgress({
      lines: [
        line,
        { from: "boss", text: "x" },
        { from: "person" },
        "words",
        null,
      ],
      facts: [
        fact,
        { ...fact, id: "f2", tag: "salary" },
        { ...fact, id: "not an id" },
        { ...fact, id: "f3", text: "   " },
        { ...fact },
        7,
      ],
    });
    expect(kept?.lines).toStrictEqual([line]);
    expect(kept?.facts.map((each) => each.id)).toStrictEqual(["f1"]);
  });

  it("takes no part and no state there is not, and cuts what is too long", () => {
    const kept = parseProgress({
      person: "boss",
      phase: "party",
      confirmed: -3,
      lines: [{ from: "person", text: "a".repeat(9000) }],
      facts: [{ ...fact, text: "b".repeat(900) }],
    });
    expect(kept?.person).toBe("opened");
    expect(kept?.phase).toBe("open");
    expect(kept?.confirmed).toBe(0);
    expect(kept?.lines[0]?.text).toHaveLength(4000);
    expect(kept?.facts[0]?.text).toHaveLength(300);
  });

  it("is nothing when it is no interview", () => {
    expect(parseProgress(null)).toBeNull();
    expect(parseProgress({ lines: "none", facts: [] })).toBeNull();
  });
});
