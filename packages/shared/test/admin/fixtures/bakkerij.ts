import { adminSnapshotSchema } from "../../../src/admin-snapshot.ts";
import type { AdminSnapshot } from "../../../src/admin-snapshot.ts";
import { STARTING_ORG_RULES } from "../../../src/admin/onboarding-admin.ts";
import type { Told, WorkRecord } from "../../../src/admin/org-record.ts";

export const client = {
  id: "bakkerij",
  name: "Bakkerij",
  created: "2026-09-20T09:00:00Z",
};

// A small company as core answers for it: two teams; Sales's lead finished
// and its links went out, one of them talking now and one not invited yet;
// Operations's lead has their link and opened it. The AI was used on two
// days. Written as core sends it, and read as the admin reads it.
export const answer = {
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
      failedMail: null,
      state: "completed",
    },
    {
      person: "tom",
      sentAt: "2026-10-06T07:00:00.000Z",
      openedAt: "2026-10-14T09:40:00.000Z",
      remindedAt: "2026-10-09T07:00:00.000Z",
      deletedAt: null,
      failedMail: null,
      state: "progress",
    },
    {
      person: "ann",
      sentAt: null,
      openedAt: null,
      remindedAt: null,
      deletedAt: null,
      failedMail: null,
      state: "waiting",
    },
    {
      person: "otto",
      sentAt: "2026-10-05T07:00:00.000Z",
      openedAt: "2026-10-06T08:00:00.000Z",
      remindedAt: null,
      deletedAt: null,
      failedMail: null,
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
  works: { works: [], rules: STARTING_ORG_RULES, counted: [] },
  setup: {
    setup: { languages: [], limits: [], terms: [] },
    changed: false,
    suggested: { languages: [], limits: [], terms: [] },
  },
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

export const snapshot: AdminSnapshot = adminSnapshotSchema.parse(answer);

/** What someone told of a piece of work: both steps, and the numbers given. */
export const told = (numbers: Partial<Told>): Told => ({
  start: true,
  steps: [0, 1],
  end: true,
  way: null,
  waits: [],
  differently: [],
  decides: false,
  own: false,
  ai: false,
  volume: null,
  takes: null,
  wrong: null,
  right: false,
  ask: false,
  next: false,
  example: null,
  term: false,
  out: [],
  ...numbers,
});

/** Tom finished too, and both told about taking orders. */
export const bothTalked: AdminSnapshot = adminSnapshotSchema.parse({
  ...answer,
  links: answer.links.map((link) =>
    link.person === "tom" ? { ...link, state: "completed" } : link
  ),
  interviews: answer.interviews.map((interview) =>
    interview.person === "tom"
      ? {
          ...interview,
          completedAt: "2026-10-14T10:00:00.000Z",
          agreed: true,
          phase: "readback",
          stoppedAt: null,
        }
      : interview
  ),
});

/** Sales's work as staff drew it from Lisa's and Tom's interviews. */
export const orders: WorkRecord = {
  id: "orders",
  team: "sales",
  name: "Taking orders",
  item: ["order", "orders"],
  doers: ["lisa", "tom", "ann"],
  share: 0.6,
  from: "lead",
  stale: false,
  drawn: {
    at: "2026-10-14T10:01:00.000Z",
    from: ["lisa", "tom"],
    starts: "A shop calls.",
    steps: [
      {
        text: "Write the order down.",
        who: "Sales",
        tool: "Excel",
        minutes: null,
        documented: false,
      },
      {
        text: "Send it to the bakery.",
        who: "Sales",
        tool: "",
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
    next: "",
    term: null,
    differs: null,
    per: "week",
    unit: "minutes",
    told: {
      lisa: told({ volume: [20, 40], takes: [2, 5, 10] }),
      tom: told({ volume: [60, 80], wrong: 2 }),
    },
    open: ["Who takes an order when Sales is out?"],
  },
};
