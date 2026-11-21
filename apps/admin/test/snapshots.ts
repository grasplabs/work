/**
 * What clients' cores answer the admin, as plain data: the fake Cloudflare
 * API's cores answer these (test/cloudflare-api.ts), and the component
 * tests answer the page's server functions with them (src/test-app.tsx).
 * Nothing here reaches the Workers runtime, so both can import it.
 */
import type { AdminKickoffView } from "@grasp-os/shared/admin-kickoff";
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { STARTING_ORG_RULES } from "@grasp-os/shared/admin/onboarding-admin";
import type {
  AiStatusReport,
  PlatformSpendRow,
} from "@grasp-os/shared/ai-status-report";
import type { BrainReport } from "@grasp-os/shared/brain-report";

/** The moment `ago` days before now. */
export const daysAgo = (ago: number) =>
  new Date(Date.now() - ago * 86_400_000).toISOString();
/** The UTC month `monthsBack` before this one, such as `2026-09`. */
export const monthBack = (monthsBack: number): string => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1)
  )
    .toISOString()
    .slice(0, 7);
};

/**
 * A core's AI status report: `providers`, and what Grasp's own features
 * cost on its keys this month and last (none unless given), or no spend
 * at all (`unreported`), as a core on a release before it was reported
 * answers.
 */
export const aiStatusOf = (
  providers: AiStatusReport["providers"] = [],
  spend:
    | { thisMonth?: PlatformSpendRow[]; lastMonth?: PlatformSpendRow[] }
    | "unreported" = {}
): AiStatusReport =>
  spend === "unreported"
    ? { providers }
    : {
        providers,
        platformSpend: {
          thisMonth: { period: monthBack(0), rows: spend.thisMonth ?? [] },
          lastMonth: { period: monthBack(1), rows: spend.lastMonth ?? [] },
        },
      };

/** A company with nothing begun: what a core answers that has no onboarding. */
export const emptyAdminSnapshot = (name: string): AdminSnapshot => ({
  now: new Date().toISOString(),
  company: {
    name,
    timeZone: "Europe/Amsterdam",
    signInDomains: [],
    signIn: [],
    admins: [],
  },
  contacts: null,
  roster: null,
  plan: null,
  agreements: null,
  agreed: false,
  paused: false,
  told: false,
  mapped: [],
  links: [],
  interviews: [],
  works: { works: [], rules: STARTING_ORG_RULES, counted: [] },
  setup: {
    setup: { languages: [], limits: [], terms: [] },
    changed: false,
    suggested: { languages: [], limits: [], terms: [] },
  },
  kickoff: null,
  gate: {
    open: false,
    closedSince: null,
    threshold: 80,
    known: 0,
    ready: false,
    over: false,
    openedAt: null,
  },
  contract: null,
  members: [],
  integrations: null,
  asked: [],
  usage: [],
});

/** A kickoff with nothing brought in yet, as core answers it. */
export const emptyKickoff = (): AdminKickoffView => ({
  transcript: null,
  read: false,
  fields: [],
  teams: 0,
});

/**
 * A company whose first conversation Stephen read and of which 85% is
 * known, past the 80% it opens at, with nothing signed yet: as the model
 * has it, at the agreements, ready for Grasp's go, and with four things
 * that need Grasp (the go and both agreements; its contract core doesn't
 * hold, so nothing is known of it).
 */
export const readySnapshot = (name: string): AdminSnapshot => {
  const empty = emptyAdminSnapshot(name);
  return {
    ...empty,
    kickoff: { at: empty.now, known: 0.5 },
    gate: { ...empty.gate, known: 85, ready: true },
  };
};

/**
 * A company told `daysIn` days ago, on a plan of `days` days, with one
 * team: its lead Lisa and Tom, both sent their link; Lisa has talked
 * when `leadTalked`.
 */
export const toldSnapshot = (
  name: string,
  {
    days,
    daysIn,
    leadTalked,
  }: { days: number; daysIn: number; leadTalked: boolean }
): AdminSnapshot => {
  const empty = emptyAdminSnapshot(name);
  const at = (back: number, hour: number) =>
    new Date(
      Date.parse(empty.now) - back * 86_400_000 + hour * 3_600_000
    ).toISOString();
  const told = at(daysIn, 0);
  return {
    ...empty,
    roster: {
      teams: [
        { id: "sales", name: "Sales", lead: "lisa", does: "", off: false },
      ],
      people: [
        ["lisa", "Lisa"],
        ["tom", "Tom"],
      ].map(([id = "", person = ""]) => ({
        id,
        name: person,
        email: "",
        team: "sales",
        title: "",
        away: false,
      })),
    },
    plan: { start: told.slice(0, 10), days, at: told },
    agreements: { processing: true, assessment: true, council: "none" },
    agreed: true,
    told: true,
    links: ["lisa", "tom"].map((person) => ({
      person,
      sentAt: told,
      openedAt: null,
      remindedAt: null,
      deletedAt: null,
      failedMail: null,
      state: person === "lisa" && leadTalked ? "completed" : "waiting",
    })),
    interviews: leadTalked
      ? [
          {
            person: "lisa",
            kind: "lead",
            startedAt: at(daysIn, 1),
            completedAt: at(daysIn, 2),
            updatedAt: at(daysIn, 2),
            agreed: true,
            phase: "readback",
            stoppedAt: null,
            minutes: 40,
            facts: 4,
            out: 0,
            confirmed: 4,
            rating: 5,
            typed: false,
            interviewer: "stephen",
          },
        ]
      : [],
  };
};

/** Totals of people's own stores while none holds anything. */
export const noOwnStores = {
  stores: 0,
  waiting: 0,
  oldestWaitingAt: null,
  parked: 0,
  failing: 0,
  notRebuilt: 0,
  nearLimit: 0,
};

/** The Brain as a core reports it: a parked item, a store of `bytes`, a ledger through. */
export const brainReport = (bytes: number): BrainReport => ({
  now: "2026-11-12T10:00:00.000Z",
  queue: {
    waiting: [
      {
        kind: "brain.embed",
        count: 12,
        oldestAddedAt: "2026-11-12T09:00:00.000Z",
      },
    ],
    running: 2,
    overdue: 0,
    paused: null,
    parked: [
      {
        item: 41,
        kind: "brain.extract",
        attempts: 5,
        parks: 1,
        final: false,
        error: "unreadable",
        message: "What it works on can't be read.",
        parkedAt: "2026-11-12T08:00:00.000Z",
      },
    ],
    parkedCount: 1,
  },
  store: { bytes, limitBytes: 10_000_000_000 },
  words: "current",
  embedding: {
    model: "test-model@0a1b",
    chunks: 40,
    embedded: 38,
    passedOver: 2,
    rebuilding: false,
  },
  ledger: {
    replay: "through",
    erasing: 0,
    sourcesWithoutCurrent: 0,
    source: { written: 4, unwritten: 0 },
    byReason: { deleted: 3, retention: 0, person_erased: 0, withdrawn: 1 },
  },
  stepsFailed: {
    ledger: null,
    erase: null,
    sweep: null,
    repack: null,
    reindex: null,
    quotes: null,
    embedding: null,
  },
  recall: {
    since: "2026-11-12T08:00:00.000Z",
    ways: {
      words: { recalls: 40, failed: 0 },
      exact: { recalls: 8, failed: 0 },
      entities: { recalls: 0, failed: 0 },
      meaning: { recalls: 0, failed: 0 },
    },
    withoutMeaning: { timed_out: 0, failed: 0, refused: 0, unusable: 0 },
  },
  ownStores: noOwnStores,
  modelSpend: { month: "2026-11", purposes: [] },
});

/** An interview `person` agreed to, with `facts` kept and none taken out. */
const agreedInterview = (
  person: string,
  kind: "own" | "lead",
  facts: number,
  at: string
): AdminSnapshot["interviews"][number] => ({
  person,
  kind,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
  agreed: true,
  phase: "readback",
  stoppedAt: null,
  minutes: 30,
  facts,
  out: 0,
  confirmed: facts,
  rating: null,
  typed: false,
  interviewer: null,
});

/** When the interviews started, and every link went out. */
const started = "2026-10-05T07:00:00.000Z";

/** Someone in `team`. */
const person = (id: string, team: string) => ({
  id,
  name: `Person ${id}`,
  email: `${id}@acme.test`,
  team,
  title: "",
  away: false,
});

/** The link `id` was sent at the interviews' start, and where they stand. */
const link = (id: string, state: "completed" | "opened") => ({
  person: id,
  sentAt: started,
  openedAt: started,
  remindedAt: null,
  deletedAt: null,
  failedMail: null,
  state,
});

/**
 * A company told about its interviews, with two teams taking part and one
 * that doesn't: in Sales two people agreed to theirs (6 and 4 facts), in
 * Operations nobody has yet.
 */
export const heardSnapshot = (name: string): AdminSnapshot => {
  const empty = emptyAdminSnapshot(name);
  const at = "2026-10-06T09:00:00.000Z";
  return {
    ...empty,
    roster: {
      teams: [
        { id: "sales", name: "Sales", lead: "lisa", does: "", off: false },
        { id: "ops", name: "Operations", lead: "otto", does: "", off: false },
        { id: "legal", name: "Legal", lead: null, does: "", off: true },
      ],
      people: [
        person("lisa", "sales"),
        person("tom", "sales"),
        person("otto", "ops"),
        person("lena", "legal"),
      ],
    },
    plan: { start: "2026-10-05", days: 14, at: started },
    agreed: true,
    told: true,
    mapped: ["sales", "ops"],
    links: [
      link("lisa", "completed"),
      link("tom", "completed"),
      link("otto", "opened"),
    ],
    interviews: [
      agreedInterview("lisa", "lead", 6, at),
      agreedInterview("tom", "own", 4, at),
    ],
    gate: { ...empty.gate, known: 42 },
  };
};
