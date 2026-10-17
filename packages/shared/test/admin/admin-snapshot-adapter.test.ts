import { describe, expect, it } from "vite-plus/test";

import { adminSnapshotSchema } from "../../src/admin-snapshot.ts";
import type { AdminSnapshot } from "../../src/admin-snapshot.ts";
import {
  adminOrgOf,
  staffSnapshotOf,
} from "../../src/admin/admin-snapshot-adapter.ts";
import { adminViewOf } from "../../src/admin/admin-view.ts";
import { orgOfSnapshot } from "../../src/admin/org-adapter.ts";

const client = {
  id: "bakkerij",
  name: "Bakkerij",
  created: "2026-09-20T09:00:00Z",
};

// A small company as core answers for it: two teams; Sales's lead finished
// and its links went out, one of them talking now and one not invited yet;
// Operations's lead has their link and opened it. The AI was used on two
// days. Written as core sends it, and read as the console reads it.
const answer = {
  now: "2026-10-14T10:05:00Z",
  company: {
    name: "Bakkerij Noord",
    timeZone: "Europe/Amsterdam",
    signInDomains: ["bakkerij.test"],
    signIn: ["microsoft"],
    admins: ["eva@bakkerij.test"],
  },
  contacts: null,
  roster: {
    teams: [
      {
        id: "sales",
        name: "Sales",
        lead: "lisa",
        does: "Sells bread to shops",
        off: false,
      },
      {
        id: "ops",
        name: "Operations",
        lead: "otto",
        does: "Bakes",
        off: false,
      },
    ],
    people: [
      {
        id: "lisa",
        name: "Lisa de Vries",
        email: "lisa@bakkerij.test",
        team: "sales",
        title: "Head of Sales",
        away: false,
      },
      {
        id: "tom",
        name: "Tom Jansen",
        email: "tom@bakkerij.test",
        team: "sales",
        title: "Account manager",
        away: false,
      },
      {
        id: "ann",
        name: "Ann Bos",
        email: "",
        team: "sales",
        title: "",
        away: false,
      },
      {
        id: "otto",
        name: "Otto Smit",
        email: "otto@bakkerij.test",
        team: "ops",
        title: "Head baker",
        away: false,
      },
    ],
  },
  plan: { start: "2026-10-05", days: 14, at: "2026-10-05T07:00:00.000Z" },
  agreements: {
    processing: true,
    assessment: true,
    council: "none",
    processingOn: "2026-09-25",
    assessmentOn: "2026-09-29",
  },
  agreed: true,
  paused: false,
  told: true,
  mapped: ["sales"],
  links: [
    {
      person: "lisa",
      sentAt: "2026-10-05T07:00:00.000Z",
      openedAt: "2026-10-05T07:30:00.000Z",
      remindedAt: null,
      deletedAt: null,
      state: "completed",
    },
    {
      person: "tom",
      sentAt: "2026-10-06T07:00:00.000Z",
      openedAt: "2026-10-14T09:40:00.000Z",
      remindedAt: "2026-10-09T07:00:00.000Z",
      deletedAt: null,
      state: "progress",
    },
    {
      person: "ann",
      sentAt: null,
      openedAt: null,
      remindedAt: null,
      deletedAt: null,
      state: "waiting",
    },
    {
      person: "otto",
      sentAt: "2026-10-05T07:00:00.000Z",
      openedAt: "2026-10-06T08:00:00.000Z",
      remindedAt: null,
      deletedAt: null,
      state: "opened",
    },
  ],
  interviews: [
    {
      person: "lisa",
      kind: "lead",
      startedAt: "2026-10-05T08:00:00.000Z",
      completedAt: "2026-10-05T08:40:00.000Z",
      updatedAt: "2026-10-05T08:40:00.000Z",
      agreed: true,
      phase: "readback",
      stoppedAt: null,
      minutes: 40,
      facts: 12,
      out: 2,
      confirmed: 12,
      rating: 5,
      typed: false,
      interviewer: "stephen",
    },
    {
      person: "tom",
      kind: "own",
      startedAt: "2026-10-14T09:45:00.000Z",
      completedAt: null,
      updatedAt: "2026-10-14T10:00:00.000Z",
      agreed: false,
      phase: "steps",
      stoppedAt: "steps",
      minutes: 15,
      facts: 3,
      out: 0,
      confirmed: 0,
      rating: null,
      typed: true,
      interviewer: "claire",
    },
  ],
  works: null,
  kickoff: { at: "2026-09-24T10:00:00.000Z", known: 0.6 },
  gate: {
    open: false,
    closedSince: "2026-09-21T08:00:00.000Z",
    threshold: 80,
    known: 62,
    ready: false,
    over: false,
    openedAt: null,
  },
  contract: null,
  members: [
    {
      userId: "u-eva",
      name: "Eva Mulder",
      email: "eva@bakkerij.test",
      role: "admin",
      joinedAt: "2026-09-22T10:00:00.000Z",
    },
    {
      userId: "u-bram",
      name: "Bram Visser",
      email: "bram@bakkerij.test",
      role: "builder",
      joinedAt: "2026-09-23T10:00:00.000Z",
    },
  ],
  integrations: null,
  usage: [
    {
      day: "2026-10-05",
      use: {
        interviews: {
          "claude-sonnet-4-5": {
            calls: 30,
            tokensIn: 200_000,
            kept: 800_000,
            tokensOut: 40_000,
            seconds: 0,
          },
          voice: {
            calls: 30,
            tokensIn: 0,
            kept: 0,
            tokensOut: 0,
            seconds: 1200,
          },
        },
      },
    },
    {
      day: "2026-10-14",
      use: {
        interviews: {
          "claude-sonnet-4-5": {
            calls: 10,
            tokensIn: 50_000,
            kept: 100_000,
            tokensOut: 10_000,
            seconds: 0,
          },
        },
        drawing: {
          "claude-opus-4-1": {
            calls: 1,
            tokensIn: 20_000,
            kept: 0,
            tokensOut: 5000,
            seconds: 0,
          },
        },
      },
    },
  ],
};

const metered = { calls: 0, tokensIn: 0, kept: 0, tokensOut: 0, seconds: 0 };

const snapshot: AdminSnapshot = adminSnapshotSchema.parse(answer);

/** Everything the admin shows of the company on core's day. */
const shown = () => {
  const { org, state } = adminOrgOf(snapshot, client);
  return { org, view: adminViewOf(org, state, "2026-10-14") };
};

/** A view as text, its maps and sets spelled out, to look for words in. */
const text = (value: unknown): string =>
  JSON.stringify(value, (_key: string, each: unknown): unknown => {
    if (each instanceof Map || each instanceof Set) {
      return [...each.entries()];
    }
    return each;
  });

describe("an organization from core's admin snapshot", () => {
  it("is told, nine days in, with the agreements in and its leads named", () => {
    const { view } = shown();

    expect(view.told).toBeTruthy();
    expect(view.day).toBe(9);
    expect(view.stages).toStrictEqual({
      conversation: "done",
      research: "later",
      agreed: "done",
      connected: "done",
      leads: "now",
      interviews: "now",
      open: "later",
    });
    expect(
      view.agreements.map(({ what, state, on }) => [what, state, on])
    ).toStrictEqual([
      ["processing", "signed", "2026-09-25"],
      ["assessment", "signed", "2026-09-29"],
      ["council", "none", null],
    ]);
  });

  it("shows where everyone stands, who is talking now, and who has no link yet", () => {
    const { view } = shown();
    const states = Object.fromEntries(
      view.people.map((each) => [each.person.id, each.state])
    );

    expect(states).toStrictEqual({
      lisa: "completed",
      tom: "progress",
      ann: "waiting",
      otto: "opened",
    });
    const tom = view.people.find((each) => each.person.id === "tom");
    expect(tom?.reminded).toBe(4);
    const sales = view.teams.find((team) => team.team.id === "sales");
    const ops = view.teams.find((team) => team.team.id === "ops");
    expect([sales?.sent, sales?.heard]).toStrictEqual([0, 0]);
    expect([ops?.sent, ops?.heard]).toStrictEqual([null, null]);
  });

  it("counts who talked from core's numbers, and keeps a length only as core measured it", () => {
    const { view } = shown();
    const talked = Object.fromEntries(
      view.interviews.map((each) => [
        each.id,
        {
          kind: each.kind,
          approved: each.approved,
          stoppedAt: each.stoppedAt,
          minutes: each.minutes,
          facts: each.facts,
          out: each.out,
          typed: each.typed,
          rating: each.rating,
        },
      ])
    );

    // Core counts the facts kept apart from those taken out; the admin, every one written.
    expect(talked).toStrictEqual({
      lisa: {
        kind: "lead",
        approved: true,
        stoppedAt: null,
        minutes: 40,
        facts: 14,
        out: 2,
        typed: false,
        rating: 5,
      },
      tom: {
        kind: "employee",
        approved: false,
        stoppedAt: "steps",
        minutes: 15,
        facts: 3,
        out: 0,
        typed: true,
        rating: null,
      },
    });
  });

  it("knows what core knows, against core's threshold, and stays closed without Grasp's go", () => {
    const { view } = shown();

    const { percent, threshold, ready, opened } = view.knowledge;
    expect({
      percent,
      threshold,
      ready,
      opened,
      open: view.open,
    }).toStrictEqual({
      percent: 62,
      threshold: 80,
      ready: false,
      opened: null,
      open: false,
    });
    expect(view.needs.map((need) => need.kind)).not.toContain("go");
    // Core sends its number without its parts: no breakdown that wouldn't add up to it.
    expect(view.knowledge.sources).toStrictEqual([]);
  });

  it("waits for the works council, and keeps an interview deleted as its person asked", () => {
    const waiting = adminOrgOf(
      {
        ...snapshot,
        agreements: {
          processing: true,
          assessment: true,
          council: "waiting",
        },
        // Core forgets a deleted interview at once, and keeps when it went.
        links: snapshot.links.map((link) =>
          link.person === "lisa"
            ? {
                ...link,
                deletedAt: "2026-10-07T12:00:00.000Z",
                state: "opened" as const,
              }
            : link
        ),
        interviews: snapshot.interviews.filter(
          (interview) => interview.person !== "lisa"
        ),
      },
      client
    );
    const view = adminViewOf(waiting.org, waiting.state, "2026-10-14");

    expect({
      council: view.agreements.find((each) => each.what === "council")?.state,
      stage: view.stages.agreed,
      need: view.needs.some(
        (need) => need.kind === "agreement" && need.what === "council"
      ),
      deleted: view.people.find((each) => each.person.id === "lisa")?.deleted,
    }).toStrictEqual({
      council: "waiting",
      stage: "waits",
      need: true,
      deleted: true,
    });
  });

  it("counts a fresh interview someone saved after deleting theirs", () => {
    // Lisa deleted hers on day 2, opened her link again and agreed to a new one on day 3.
    const again = adminOrgOf(
      {
        ...snapshot,
        links: snapshot.links.map((link) =>
          link.person === "lisa"
            ? { ...link, deletedAt: "2026-10-07T12:00:00.000Z" }
            : link
        ),
        interviews: snapshot.interviews.map((interview) =>
          interview.person === "lisa"
            ? {
                ...interview,
                startedAt: "2026-10-08T08:00:00.000Z",
                completedAt: "2026-10-08T08:30:00.000Z",
                updatedAt: "2026-10-08T08:30:00.000Z",
              }
            : interview
        ),
      },
      client
    );
    const view = adminViewOf(again.org, again.state, "2026-10-14");
    const lisa = view.people.find((each) => each.person.id === "lisa");

    expect({
      deleted: lisa?.deleted,
      state: lisa?.state,
      talked: view.interviews.some((each) => each.id === "lisa"),
      completed: view.counts.completed,
    }).toStrictEqual({
      deleted: false,
      state: "completed",
      talked: true,
      completed: 1,
    });
  });

  it("is open from the day of Grasp's go, and wants the go once enough is known", () => {
    const opened = adminOrgOf(
      {
        ...snapshot,
        gate: {
          ...snapshot.gate,
          open: true,
          closedSince: null,
          openedAt: "2026-10-12T15:00:00.000Z",
        },
      },
      client
    );
    const ready = adminOrgOf(
      { ...snapshot, gate: { ...snapshot.gate, known: 85, ready: true } },
      client
    );

    const view = adminViewOf(opened.org, opened.state, "2026-10-14");
    expect([view.knowledge.opened, view.open, view.stages.open]).toStrictEqual([
      7,
      true,
      "done",
    ]);
    expect(
      adminViewOf(ready.org, ready.state, "2026-10-14").needs[0]
    ).toStrictEqual({ kind: "go", percent: 85, threshold: 80 });
  });

  it("runs the interviews as long as core's plan, past the samples' fourteen days", () => {
    // Six weeks planned; day 27 now. Tom finished on day 23 and Grasp's go came on day 20.
    const long = adminOrgOf(
      {
        ...snapshot,
        now: "2026-11-01T10:00:00Z",
        plan: { ...snapshot.plan, start: "2026-10-05", days: 42 },
        gate: {
          ...snapshot.gate,
          open: true,
          closedSince: null,
          openedAt: "2026-10-25T15:00:00.000Z",
        },
        links: snapshot.links.map((link) =>
          link.person === "tom" ? { ...link, state: "completed" } : link
        ),
        interviews: snapshot.interviews.map((interview) =>
          interview.person === "tom"
            ? {
                ...interview,
                completedAt: "2026-10-28T10:00:00.000Z",
                updatedAt: "2026-10-28T10:00:00.000Z",
                agreed: true,
                phase: "readback" as const,
                stoppedAt: null,
              }
            : interview
        ),
      },
      client
    );
    const view = adminViewOf(long.org, long.state, "2026-11-01");

    expect({
      day: view.day,
      closed: view.closed,
      opened: view.knowledge.opened,
      talked: view.interviews.map((each) => each.id).toSorted(),
      tom: view.people.find((each) => each.person.id === "tom")?.state,
    }).toStrictEqual({
      day: 27,
      closed: false,
      opened: 20,
      talked: ["lisa", "tom"],
      tom: "completed",
    });
  });

  it("counts the AI core counted, by day and by what it was for", () => {
    const { view } = shown();

    const { counted, days, purposes, total } = view.usage;
    expect({
      counted,
      days: days.map((each) => each.day),
      interviews: [purposes.interviews.tokensIn, purposes.interviews.spoken],
      drawing: purposes.drawing.tokensOut,
    }).toStrictEqual({
      counted: true,
      days: ["2026-10-05", "2026-10-14"],
      // Tokens read, new and kept together; minutes of Stephen's voice.
      interviews: [1_150_000, 20],
      drawing: 5000,
    });
    expect(total.spend).toBeGreaterThan(0);
  });

  it("names its members as core does, ready for when it opens", () => {
    const { view } = shown();

    expect(
      view.members.map(({ id, name, role, state, joined }) => ({
        id,
        name,
        role,
        state,
        joined,
      }))
    ).toStrictEqual([
      {
        id: "u-eva",
        name: "Eva Mulder",
        role: "admin",
        state: "ready",
        joined: "2026-09-22",
      },
      {
        id: "u-bram",
        name: "Bram Visser",
        role: "builder",
        state: "ready",
        joined: "2026-09-23",
      },
    ]);
  });

  it("leaves unknown what core doesn't hold", () => {
    const { org, view } = shown();

    // No contract: nothing signed, no fee, no seats, no invoices.
    expect({
      status: view.contract.status,
      fee: view.contract.fee,
      seats: view.contract.seats,
      invoices: view.invoices,
    }).toStrictEqual({ status: "draft", fee: 0, seats: 0, invoices: [] });
    expect({
      contacts: view.contacts,
      integrations: view.integrations,
      // No work drawn: no hours claimed for any.
      works: view.works,
      hours: [view.value.hours, view.value.counted],
      languages: org.stephen.languages,
      transcripts: org.real?.transcripts.size,
    }).toStrictEqual({
      contacts: {},
      integrations: [],
      works: [],
      hours: [0, 0],
      languages: [],
      transcripts: 0,
    });
  });

  it("takes no words from core beyond the names of its company, teams and people", () => {
    const staff = staffSnapshotOf(snapshot, client);
    const { view } = shown();

    // Nothing anyone said, and no link: a link is a credential.
    expect({
      said: staff.interviews.map(({ progress }) => [
        progress.lines,
        progress.facts,
      ]),
      links: staff.links.map((each) => each.secret + each.code),
      client: staff.clientCode,
    }).toStrictEqual({
      said: [
        [[], []],
        [[], []],
      ],
      links: ["", "", "", ""],
      client: "",
    });
    // The only words in the admin's view, beyond its own codes, ids and times, are names and what a team does.
    const words = new Set(
      Array.from(
        text(view).matchAll(/"(?<word>[A-Z][^"]*|[^"]* [^"]*)"/gu),
        (match) => match.groups?.word
      )
    );
    expect(words).toStrictEqual(
      new Set([
        "Ann Bos",
        "Bakes",
        "Bakkerij Noord",
        "Bram Visser",
        "Eva Mulder",
        "Ann",
        "Lisa",
        "Otto",
        "Tom",
        "Lisa de Vries",
        "Operations",
        "Otto Smit",
        "Sales",
        "Sells bread to shops",
        "Tom Jansen",
      ])
    );
  });

  it("counts no days before the first link went out, whatever core planned", () => {
    const planned = adminOrgOf(
      {
        ...snapshot,
        told: false,
        links: snapshot.links.map((link) => ({
          ...link,
          sentAt: null,
          openedAt: null,
          remindedAt: null,
          state: "waiting" as const,
        })),
        interviews: [],
      },
      client
    );
    const view = adminViewOf(planned.org, planned.state, "2026-10-14");

    expect(view.told).toBeFalsy();
    expect(view.day).toBe(0);
    expect(view.stages.connected).toBe("done");
    expect(view.people.map((each) => each.state)).toStrictEqual([
      "waiting",
      "waiting",
      "waiting",
      "waiting",
    ]);
  });

  it("reads an answer from a newer core the same, and keeps out what it added", () => {
    const newer = adminSnapshotSchema.parse({
      ...answer,
      company: { ...answer.company, logo: "https://bakkerij.test/logo.png" },
      links: answer.links.map((link) => ({
        ...link,
        code: `bakkerij.${link.person}-secret`,
      })),
      interviews: answer.interviews.map((interview) => ({
        ...interview,
        summary: "The orders come in by phone and get lost",
      })),
      works: [{ name: "Taking orders", steps: ["Write it down"] }],
      contract: { plan: "Grasp", fee: 4000 },
      gate: { ...answer.gate, parts: [{ source: "kickoff", known: 0.6 }] },
      usage: answer.usage.map((day) => ({
        ...day,
        use: {
          ...day.use,
          chat: { "claude-haiku-4-5": { ...metered, calls: 1 } },
        },
      })),
    });

    const adapted = staffSnapshotOf(newer, client);
    expect(adapted).toStrictEqual(staffSnapshotOf(snapshot, client));
    expect(text(orgOfSnapshot(adapted))).not.toMatch(
      /secret|lost|Taking orders|"fee":4000|"plan":"Grasp"|logo/u
    );
  });
});
