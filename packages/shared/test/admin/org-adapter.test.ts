import { describe, expect, it } from "vite-plus/test";

import { healthOf } from "../../src/admin/admin-health.ts";
import { talkedByDay } from "../../src/admin/admin-interviews.ts";
import { logItemsOf } from "../../src/admin/admin-log.ts";
import { organizationOf } from "../../src/admin/admin-organization.ts";
import { todosAt } from "../../src/admin/admin-todo.ts";
import { PRICES, valueOf } from "../../src/admin/admin-usage.ts";
import { adminViewOf } from "../../src/admin/admin-view.ts";
import type { InterviewFact } from "../../src/admin/interview-turn.ts";
import {
  logOf,
  personLog,
  stephenOf,
} from "../../src/admin/onboarding-admin-record.ts";
import { meteredOf, orgOfSnapshot } from "../../src/admin/org-adapter.ts";
import { NEW_CLIENT, NOTHING_SAID } from "../../src/admin/org-record.ts";
import type {
  DrawnWork,
  HeldInterview,
  StaffSnapshot,
} from "../../src/admin/org-record.ts";

/** A fact Stephen wrote down, taken out in the read-back when `out`. */
const fact = (id: string, out = false): InterviewFact => ({
  id,
  tag: "step",
  text: `Fact ${id}`,
  record: "",
  ...(out ? { out: true } : {}),
});

const person = (
  id: string,
  name: string,
  team: string,
  work: string | null = null
) => ({
  id,
  name,
  email: `${id}@rivierdal.test`,
  team,
  title: "Medewerker",
  away: false,
  work,
});
const link = (
  id: string,
  state: StaffSnapshot["links"][number]["state"],
  sent: string | null = "2026-10-05T07:00:00Z"
) => ({
  person: id,
  secret: "s",
  code: `rivierdal.${id}`,
  sent,
  opened: sent,
  reminded: null,
  state,
});
const held = (
  id: string,
  kind: HeldInterview["kind"],
  completed: string | null,
  rating?: number
): HeldInterview => ({
  person: id,
  kind,
  progress: {
    ...NOTHING_SAID,
    person: completed === null ? "incomplete" : "completed",
    mode: "type",
    startedAt: Date.parse("2026-10-05T09:00:00Z"),
    phase: "story",
    ...(rating === undefined ? {} : { rating }),
  },
  version: 3,
  updated: completed ?? "2026-10-05T09:10:00Z",
  completed,
  stopped: null,
});
const drawn: DrawnWork = {
  at: "2026-10-05T10:00:00Z",
  from: ["lisa"],
  starts: "A customer writes.",
  steps: [
    {
      text: "Open the ticket.",
      who: "Agent",
      tool: "Zendesk",
      minutes: null,
      documented: false,
    },
    {
      text: "Look the customer up.",
      who: "Agent",
      tool: "Excel",
      minutes: null,
      documented: false,
    },
    {
      text: "Answer the customer.",
      who: "Agent",
      tool: "Zendesk",
      minutes: null,
      documented: false,
    },
  ],
  waits: [],
  differently: [],
  decides: "",
  own: "",
  ai: "",
  right: "",
  ask: "",
  next: "Hypotheekadvies takes over a claim.",
  term: null,
  differs: null,
  per: "week",
  unit: "minutes",
  told: {
    lisa: {
      start: true,
      steps: [0, 1, 2],
      end: true,
      way: null,
      waits: [],
      differently: [],
      decides: false,
      own: false,
      ai: false,
      volume: [20, 30],
      takes: [5, 8, 15],
      wrong: 1,
      right: false,
      ask: false,
      next: true,
      example: null,
      term: false,
      out: [],
    },
  },
  open: [],
};
const snapshot: StaffSnapshot = {
  profile: {
    id: "rivierdal",
    name: "Rivierdal",
    about: "advice",
    website: "rivierdal.test",
    place: "Arnhem",
    language: "nl",
    sponsor: { name: "Eva", title: "CEO", email: "" },
    admin: { name: "Ad", title: "", email: "" },
    created: "2026-10-01T08:00:00Z",
    test: true,
  },
  clientCode: "rivierdal.client",
  client: { ...NEW_CLIENT, directory: "list", reached: 7 },
  roster: {
    teams: [
      {
        id: "t-service",
        name: "Klantenservice",
        lead: "daan",
        does: "Answers customers",
        off: false,
      },
      {
        id: "t-mortgage",
        name: "Hypotheekadvies",
        lead: "mark",
        does: "Mortgages",
        off: false,
      },
      { id: "t-board", name: "Directie", lead: null, does: "", off: true },
    ],
    people: [
      person("daan", "Daan Bakker", "t-service"),
      person("lisa", "Lisa Jansen", "t-service", "w-tickets"),
      person("tim", "Tim de Groot", "t-service", "w-tickets"),
      person("mark", "Mark de Vries", "t-mortgage"),
      person("eva", "Eva Bos", "t-board"),
    ],
  },
  plan: { start: "2026-10-05", days: 14, told: "2026-10-02T10:00:00Z" },
  grasp: {},
  links: [
    link("daan", "completed"),
    link("lisa", "completed"),
    link("tim", "invited"),
    link("mark", "invited"),
  ],
  interviews: [
    held("daan", "lead", "2026-10-05T09:30:00Z"),
    held("lisa", "employee", "2026-10-05T11:00:00Z", 4),
  ],
  works: [
    {
      id: "w-tickets",
      team: "t-service",
      name: "handling new tickets",
      local: "nieuwe tickets afhandelen",
      item: ["ticket", "tickets"],
      doers: ["lisa", "tim"],
      share: 0.8,
      from: "lead",
      drawn,
      stale: false,
    },
  ],
  mapped: ["t-service"],
  events: [],
  usage: [
    {
      day: "2026-10-05",
      use: {
        interviews: {
          "claude-sonnet-5-5": {
            calls: 10,
            tokensIn: 100_000,
            kept: 400_000,
            tokensOut: 2000,
            seconds: 0,
          },
          voice: { calls: 4, tokensIn: 0, kept: 0, tokensOut: 0, seconds: 120 },
          "something-else": {
            calls: 1,
            tokensIn: 5,
            kept: 0,
            tokensOut: 5,
            seconds: 0,
          },
        },
        drawing: {
          "claude-opus-5-5": {
            calls: 1,
            tokensIn: 6000,
            kept: 0,
            tokensOut: 1500,
            seconds: 0,
          },
        },
      },
    },
  ],
  now: "2026-10-06T12:00:00Z",
};

describe("a real organization as the admin reads it", () => {
  const org = orgOfSnapshot(snapshot);
  const view = adminViewOf(org, org.seed, "2026-10-06");

  it("carries which teams take part, and counts nobody in a team that does not", () => {
    expect(org.seed.left).toStrictEqual(["t-board"]);
    expect(view.teams.map((team) => [team.team.id, team.off])).toStrictEqual([
      ["t-service", false],
      ["t-mortgage", false],
      ["t-board", true],
    ]);
    expect(view.people.find((each) => each.person.id === "eva")).toMatchObject({
      state: "away",
      out: true,
    });
    // Four are asked: the director's team is left out. The leads stage waits for Mark only.
    expect([view.asked, view.stages.leads]).toStrictEqual([4, "now"]);
    expect(organizationOf(view)).toMatchObject({
      taking: 2,
      leadsNamed: 2,
      leadsTalked: 1,
      people: 5,
      asked: 4,
      talked: 2,
    });
  });

  it("waits for a lead who has not talked, though their team's links went out without them", () => {
    // Mark has not talked; after waiting for him, his team's links went out anyway.
    const without = orgOfSnapshot({
      ...snapshot,
      roster: {
        teams: snapshot.roster?.teams ?? [],
        people: [
          ...(snapshot.roster?.people ?? []),
          person("sanne", "Sanne Smit", "t-mortgage"),
        ],
      },
      links: [...snapshot.links, link("sanne", "invited")],
    });
    const seen = adminViewOf(without, without.seed, "2026-10-06");
    const mortgage = seen.teams.find((team) => team.team.id === "t-mortgage");
    expect({
      out: mortgage?.sent,
      heard: mortgage?.heard,
      stage: seen.stages.leads,
      talked: todosAt(seen, "leads").find(
        (todo) => todo.kind === "leadTalked" && todo.person === "mark"
      )?.done,
      leadsHeard: seen.knowledge.sources.find(
        (each) => each.source === "leadsHeard"
      )?.known,
    }).toStrictEqual({
      out: 0,
      heard: null,
      stage: "now",
      talked: false,
      leadsHeard: 0.5,
    });
  });

  it("logs a reminder that went by itself, and one sent by hand once", () => {
    const reminded = orgOfSnapshot({
      ...snapshot,
      links: snapshot.links.map((each) =>
        each.person === "tim"
          ? { ...each, reminded: "2026-10-06T07:00:00Z" }
          : each
      ),
    });
    const reminders = (byHand: boolean) =>
      logItemsOf(
        adminViewOf(
          reminded,
          byHand ? { ...reminded.seed, reminded: { tim: 1 } } : reminded.seed,
          "2026-10-06"
        ),
        byHand
          ? [{ what: "reminded", count: 1, at: Date.parse(snapshot.now) }]
          : []
      ).flatMap((item) => {
        if (item.source.from === "company") {
          return item.source.event.kind === "reminded" ? [item.actor] : [];
        }
        return item.source.from === "hand" ? [item.actor] : [];
      });
    expect([reminders(false), reminders(true)]).toStrictEqual([
      ["itself"],
      ["grasp"],
    ]);
  });

  it("knows how long an interview took only when it went in one go", () => {
    // Lisa talked from nine, left at ten past, and came back the next morning to finish.
    const lisa = held("lisa", "employee", "2026-10-06T08:20:00Z");
    const back = orgOfSnapshot({
      ...snapshot,
      interviews: [
        held("daan", "lead", "2026-10-05T09:30:00Z"),
        {
          ...lisa,
          progress: { ...lisa.progress, mode: "talk" },
          stopped: { at: "2026-10-05T09:10:00Z", phase: "story" },
        },
      ],
    });
    const seen = adminViewOf(back, back.seed, "2026-10-06");
    const stephen = stephenOf(seen);
    expect({
      lisa: seen.interviews.find((each) => each.id === "lisa")?.minutes,
      daan: seen.interviews.find((each) => each.id === "daan")?.minutes,
      lengths: stephen.lengths.reduce((sum, each) => sum + each.count, 0),
      employee: stephen.length.employee,
      heard: seen.usage.matrix.interviews.ears.heard,
    }).toStrictEqual({
      lisa: null,
      daan: 30,
      lengths: 1,
      employee: 0,
      heard: 0,
    });
  });

  it("names the work as a title, with who does it, the apps it is done in and the team it goes to", () => {
    const chart = organizationOf(view);
    const service = chart.teams.find(
      (team) => team.view.team.id === "t-service"
    );
    expect(service?.works.map((work) => work.evidence.work.name)).toStrictEqual(
      ["Handling new tickets"]
    );
    expect(
      service?.works[0]?.doers.map((each) => each.person.id)
    ).toStrictEqual(["lisa", "tim"]);
    expect(service?.tools).toStrictEqual([
      { name: "Excel", works: 1 },
      { name: "Zendesk", works: 1 },
    ]);
    expect(service?.to.map((each) => each.to)).toStrictEqual(["t-mortgage"]);
    expect(
      chart.teams.find((team) => team.view.team.id === "t-mortgage")?.from
    ).toHaveLength(1);
  });

  it("asks Grasp for the first conversation until Stephen has read it, without holding up its steps", () => {
    expect(view.stage).toBe("leads");
    expect(view.needs).toContainEqual({ kind: "transcript" });
    expect(
      adminViewOf(org, { ...org.seed, conversation: "in" }, "2026-10-06").needs
    ).toContainEqual({ kind: "transcript" });
    const read = adminViewOf(
      org,
      { ...org.seed, conversation: "read" },
      "2026-10-06"
    );
    expect(read.needs).not.toContainEqual({ kind: "transcript" });
    expect(read.stage).toBe("leads");
  });

  it("counts every fact Stephen wrote down, and the ones the person took out once", () => {
    const lisa = held("lisa", "employee", "2026-10-05T11:00:00Z", 4);
    const told = orgOfSnapshot({
      ...snapshot,
      interviews: [
        held("daan", "lead", "2026-10-05T09:30:00Z"),
        {
          ...lisa,
          progress: {
            ...lisa.progress,
            facts: [
              fact("a"),
              fact("b"),
              fact("c"),
              fact("d"),
              fact("e", true),
            ],
          },
        },
      ],
    });
    const seen = adminViewOf(told, told.seed, "2026-10-06");
    const interview = seen.interviews.find((each) => each.id === "lisa");
    expect({
      facts: interview?.facts,
      out: interview?.out,
      approved: stephenOf(seen).approved,
    }).toStrictEqual({ facts: 5, out: 1, approved: 0.8 });
  });

  it("counts the hours of a piece of work from everyone who told about it, whatever they were asked about", () => {
    const people = snapshot.roster?.people ?? [];
    // Lisa was asked about no work of her own, and told about handling tickets.
    const elsewhere = orgOfSnapshot({
      ...snapshot,
      roster: {
        teams: snapshot.roster?.teams ?? [],
        people: people.map((each) =>
          each.id === "lisa" ? { ...each, work: null } : each
        ),
      },
    });
    const seen = adminViewOf(elsewhere, elsewhere.seed, "2026-10-06");
    const tickets = valueOf(seen, "2026-10-06").works.find(
      (each) => each.evidence.work.id === "w-tickets"
    );
    expect({
      said: tickets?.said,
      known: tickets?.hours !== null,
    }).toStrictEqual({ said: 1, known: true });
  });

  it("keeps the links of a six-week plan open past two weeks, and counts who finishes later", () => {
    const long = orgOfSnapshot({
      ...snapshot,
      plan: { start: "2026-10-05", days: 42, told: "2026-10-02T10:00:00Z" },
      links: [
        link("daan", "completed"),
        link("lisa", "completed"),
        link("tim", "completed"),
        link("mark", "invited"),
      ],
      interviews: [
        held("daan", "lead", "2026-10-05T09:30:00Z"),
        held("lisa", "employee", "2026-10-05T11:00:00Z", 4),
        // Tim finishes on day 30 of the 42.
        held("tim", "employee", "2026-11-04T10:00:00Z"),
      ],
      now: "2026-11-04T12:00:00Z",
    });
    const fortnight = adminViewOf(
      long,
      { ...long.seed, day: 14 },
      "2026-10-19"
    );
    expect(fortnight.closed).toBeFalsy();
    const seen = adminViewOf(long, long.seed, "2026-11-04");
    const mark = seen.people.find((each) => each.person.id === "mark");
    expect({
      day: seen.day,
      closed: seen.closed,
      // Tim's interview, after the samples' fourteen days, is listed.
      tim: seen.interviews.find((each) => each.id === "tim")?.day,
      talked: seen.counts.completed,
      mark: mark?.state,
      // Mark can still be reminded: twelve days are left.
      remind: mark?.mayRemind,
      days: talkedByDay(seen).length,
    }).toStrictEqual({
      day: 30,
      closed: false,
      tim: 30,
      talked: 3,
      mark: "opened",
      remind: true,
      days: 43,
    });
  });

  it("counts nobody who has not finished on a long plan's later days", () => {
    // Tim never finishes; on day 20 of 42 only Lisa has told about handling tickets.
    const long = orgOfSnapshot({
      ...snapshot,
      plan: { start: "2026-10-05", days: 42, told: "2026-10-02T10:00:00Z" },
      now: "2026-10-25T12:00:00Z",
    });
    const seen = adminViewOf(long, long.seed, "2026-10-25");
    const tickets = seen.works.find((each) => each.work.id === "w-tickets");
    expect({
      day: seen.day,
      state: tickets?.state,
      approved: tickets?.approved,
      evidenced: tickets?.evidenced,
      everyone: tickets?.everyone,
    }).toStrictEqual({
      day: 20,
      state: "mapping",
      approved: 1,
      evidenced: 0,
      everyone: false,
    });
  });

  it("finds a long plan behind only from its own halfway", () => {
    // Only Daan has talked, one of the four asked.
    const long = orgOfSnapshot({
      ...snapshot,
      plan: { start: "2026-10-05", days: 42, told: "2026-10-02T10:00:00Z" },
      links: [
        link("daan", "completed"),
        link("lisa", "invited"),
        link("tim", "invited"),
        link("mark", "invited"),
      ],
      interviews: [held("daan", "lead", "2026-10-05T09:30:00Z")],
      now: "2026-10-26T12:00:00Z",
    });
    const levelOn = (day: number) =>
      healthOf(adminViewOf(long, { ...long.seed, day }, "2026-10-26")).find(
        (signal) => signal.area === "interviews"
      )?.level;
    expect({ fortnight: levelOn(10), halfway: levelOn(21) }).toStrictEqual({
      fortnight: "good",
      halfway: "watch",
    });
  });

  it("closes the links of a short plan on its own last day", () => {
    const short = orgOfSnapshot({
      ...snapshot,
      plan: { start: "2026-10-05", days: 7, told: "2026-10-02T10:00:00Z" },
      now: "2026-10-12T12:00:00Z",
    });
    const before = adminViewOf(short, { ...short.seed, day: 6 }, "2026-10-11");
    const seen = adminViewOf(short, short.seed, "2026-10-12");
    expect({
      before: before.closed,
      day: seen.day,
      closed: seen.closed,
      mark: seen.people.find((each) => each.person.id === "mark")?.state,
      expired: personLog(seen, "mark").find((each) => each.what === "expired")
        ?.day,
      on: logOf(seen).find((each) => each.kind === "closed")?.on,
      // AI use is counted up to the day it closed, not a week past it.
      asOf: seen.asOf,
    }).toStrictEqual({
      before: false,
      day: 7,
      closed: true,
      mark: "expired",
      expired: 7,
      on: "2026-10-12",
      asOf: "2026-10-12",
    });
  });

  it("finds a team of a five-day plan quiet only near its end", () => {
    // Every link went out on the first day, and nobody has talked.
    const five = orgOfSnapshot({
      ...snapshot,
      plan: { start: "2026-10-05", days: 5, told: "2026-10-02T10:00:00Z" },
      links: [
        link("daan", "invited"),
        link("lisa", "invited"),
        link("tim", "invited"),
        link("mark", "invited"),
      ],
      interviews: [],
      now: "2026-10-09T12:00:00Z",
    });
    const quietOn = (day: number) =>
      adminViewOf(five, { ...five.seed, day }, "2026-10-09").needs.flatMap(
        (need) => (need.kind === "quiet" ? [[need.team.id, need.left]] : [])
      );
    expect({ first: quietOn(1), last: quietOn(4) }).toStrictEqual({
      first: [],
      last: [["t-service", 1]],
    });
  });

  it("carries what someone said of their interview", () => {
    expect(view.interviews.find((each) => each.id === "lisa")?.rating).toBe(4);
    expect(
      view.interviews.find((each) => each.id === "daan")?.rating
    ).toBeNull();
  });

  it("works out no reading of the first conversation once the Worker counts, so it is not counted twice", () => {
    // The Worker counted from 2026-10-05, and Stephen read the
    // conversation after that: whatever he read, the Worker counted.
    const read = adminViewOf(
      org,
      { ...org.seed, conversation: "read", research: "done" },
      "2026-10-06"
    );
    expect(read.usage.matrix.reading.opus.tokensIn).toBe(
      view.usage.matrix.reading.opus.tokensIn
    );
  });

  it("counts AI use as the Worker counted it, at the admin’s prices, with what a model had kept at a tenth", () => {
    const counted = meteredOf(snapshot.usage);
    expect(
      counted.map((each) => `${each.purpose}/${each.model}`).toSorted()
    ).toStrictEqual(["drawing/opus", "interviews/sonnet", "interviews/voice"]);
    const sonnet = counted.find((each) => each.model === "sonnet");
    expect({
      tokensIn: sonnet?.use.tokensIn,
      counted: view.usage.counted,
      drawn: view.usage.matrix.drawing.opus.tokensOut,
      // A snapshot from before the Worker counted reads as nothing counted.
      before: orgOfSnapshot({ ...snapshot, usage: [] }).real?.metered,
    }).toStrictEqual({
      tokensIn: 500_000,
      counted: true,
      drawn: 1500,
      before: [],
    });
    expect(sonnet?.use.spend).toBeCloseTo(
      0.1 * PRICES.sonnet.tokensIn +
        0.4 * PRICES.sonnet.tokensIn * 0.1 +
        0.002 * PRICES.sonnet.tokensOut,
      6
    );
    const voice = counted.find((each) => each.model === "voice");
    expect(voice?.use).toMatchObject({
      spoken: 2,
      spend: 2 * PRICES.voice.minute,
    });
    expect(view.usage.total.spend).toBeCloseTo(
      counted.reduce((sum, each) => sum + each.use.spend, 0),
      6
    );
  });
});
