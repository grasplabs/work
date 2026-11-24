// Concepts only (never merged): what the campaign page would read from
// core while the interviews run, as fixtures in five states. Core gives
// today only counts per team and the known percentage
// (`onboarding.view`, `onboardingGate.view`); the findings, the pace, the
// asks and the day Grasp expects to open are what core would have to
// provide (see the pull request's "Needs from core").

/** Which state of the campaign a fixture shows. */
export type CampaignState = "day1" | "day3" | "day5" | "close" | "small";

export const campaignStates: readonly CampaignState[] = [
  "day1",
  "day3",
  "day5",
  "close",
  "small",
];

export const isCampaignState = (value: unknown): value is CampaignState =>
  campaignStates.some((state) => state === value);

/**
 * One thing Grasp learned, in plain words: how a piece of work really
 * runs (`flow`), or a step two people described differently
 * (`difference`). Grasp's own words, never anyone's quote.
 */
export interface Finding {
  id: string;
  kind: "flow" | "difference";
  text: string;
  /** What piece of work it is about, in two or three words. */
  topic: string;
}

/** A team, as the admin may see it: counts only, and for a team under five only its lead. */
export interface TeamPicture {
  id: string;
  name: string;
  invited: number;
  /** How many talked; shown only for a team of five or more. */
  talked: number;
  /** Whether its lead talked: all that shows of a team under five. */
  leadTalked: boolean;
  findings: Finding[];
}

/** Something only the admin can do: at most two at once. */
export type Ask =
  | { id: string; kind: "bounce"; team: string; address: string }
  | { id: string; kind: "quiet"; team: string; waiting: number };

/** How it goes, in one word core would decide. */
export type Pace = "started" | "onPace" | "quiet" | "enough";

export interface Campaign {
  company: string;
  /** False for a small company: one group, and the word "team" never shows. */
  grouped: boolean;
  /** ISO days. */
  start: string;
  closes: string;
  today: string;
  /** When Grasp expects to give its go and open for everyone. */
  opensAround: string;
  /** The day reminders go out by themselves. */
  reminders: string[];
  invited: number;
  talked: number;
  /** How much of the company Grasp knows, 0 to 100: a quiet figure. */
  known: number;
  pace: Pace;
  /** By team; for a small company, one group holding everyone. */
  teams: TeamPicture[];
  asks: Ask[];
  /** Who declined the interview, by name (never why): Ruben's decision. */
  declined: string[];
  /** What happened on which day, for the week's timeline: Grasp's own words. */
  events: { day: string; text: string }[];
}

/** A team of fewer than this shows only whether its lead talked. */
export const smallTeam = 5;

const planning = {
  id: "planning",
  name: "Planning",
  invited: 9,
  findings: [
    {
      id: "p1",
      topic: "Weekly planning",
      kind: "flow",
      text: "A job is planned twice: on the whiteboard on Monday morning, then typed into the planning tool by Wednesday.",
    },
    {
      id: "p2",
      topic: "Urgent call-outs",
      kind: "difference",
      text: "Two people said differently who decides on an urgent call-out: the duty planner, or whoever answers the phone.",
    },
    {
      id: "p3",
      topic: "Changes to the week",
      kind: "flow",
      text: "Most changes to the week come in by phone after three in the afternoon.",
    },
  ],
} as const satisfies Omit<TeamPicture, "talked" | "leadTalked">;

const field = {
  id: "field",
  name: "Field service",
  invited: 16,
  findings: [
    {
      id: "f1",
      topic: "Work orders",
      kind: "flow",
      text: "After a job the work order is photographed and sent on WhatsApp; the office types it over.",
    },
    {
      id: "f2",
      topic: "Parts used",
      kind: "flow",
      text: "Parts used on site are written down at the end of the day, from memory.",
    },
    {
      id: "f3",
      topic: "Closing a job",
      kind: "difference",
      text: "Two people said differently when a job is closed: when the engineer leaves, or once the customer signs.",
    },
  ],
} as const satisfies Omit<TeamPicture, "talked" | "leadTalked">;

const service = {
  id: "service",
  name: "Customer service",
  invited: 9,
  findings: [
    {
      id: "s1",
      topic: "Arrival times",
      kind: "flow",
      text: "Most calls ask when the engineer arrives, and the answer is looked up in two places.",
    },
    {
      id: "s2",
      topic: "Complaints",
      kind: "difference",
      text: "Two people said differently where a complaint is kept: the shared mailbox, or the complaints spreadsheet.",
    },
  ],
} as const satisfies Omit<TeamPicture, "talked" | "leadTalked">;

const finance = {
  id: "finance",
  name: "Finance",
  invited: 6,
  findings: [
    {
      id: "n1",
      topic: "Invoicing",
      kind: "flow",
      text: "Invoices go out once a week, after field service’s work orders are checked by hand.",
    },
    {
      id: "n2",
      topic: "Credit checks",
      kind: "difference",
      text: "Two people said differently when the credit check is done: before the quote, or after the first order.",
    },
  ],
} as const satisfies Omit<TeamPicture, "talked" | "leadTalked">;

const purchasing = {
  id: "purchasing",
  name: "Purchasing",
  invited: 3,
  findings: [
    {
      id: "u1",
      topic: "Ordering stock",
      kind: "flow",
      text: "Stock is ordered when a shelf looks empty; no minimum is written down.",
    },
  ],
} as const satisfies Omit<TeamPicture, "talked" | "leadTalked">;

type Base = Omit<TeamPicture, "talked" | "leadTalked">;

/** A team as it stands on a day: how many talked, whether its lead did, and its first `shown` findings. */
const teamOn = (
  base: Base,
  talked: number,
  leadTalked: boolean,
  shown: number
): TeamPicture => ({
  ...base,
  talked,
  leadTalked,
  findings: base.findings.slice(0, shown),
});

const company = "Veldhuis Installaties";
const start = "2026-11-23";
const closes = "2026-11-30";
const opensAround = "2026-12-02";
const reminders = ["2026-11-25", "2026-11-29"];

export const campaigns: Record<CampaignState, Campaign> = {
  day1: {
    company,
    grouped: true,
    start,
    closes,
    today: "2026-11-23",
    opensAround,
    reminders,
    invited: 43,
    talked: 3,
    known: 18,
    pace: "started",
    teams: [
      teamOn(planning, 2, true, 0),
      teamOn(field, 0, false, 0),
      teamOn(service, 0, false, 0),
      teamOn(finance, 1, false, 0),
      teamOn(purchasing, 0, false, 0),
    ],
    asks: [],
    declined: [],
    events: [
      { day: "2026-11-23", text: "Your message and the invitations went out." },
    ],
  },
  day3: {
    company,
    grouped: true,
    start,
    closes,
    today: "2026-11-25",
    opensAround,
    reminders,
    invited: 43,
    talked: 19,
    known: 46,
    pace: "onPace",
    teams: [
      teamOn(planning, 5, true, 3),
      teamOn(field, 7, true, 2),
      teamOn(service, 2, false, 0),
      teamOn(finance, 3, true, 2),
      teamOn(purchasing, 2, true, 1),
    ],
    asks: [],
    declined: [],
    events: [
      { day: "2026-11-23", text: "Your message and the invitations went out." },
      { day: "2026-11-24", text: "The first findings came in, from Planning." },
      { day: "2026-11-25", text: "A reminder went to everyone still to talk." },
    ],
  },
  day5: {
    company,
    grouped: true,
    start,
    closes,
    today: "2026-11-27",
    opensAround,
    reminders,
    invited: 43,
    talked: 30,
    known: 64,
    pace: "quiet",
    teams: [
      teamOn(planning, 8, true, 3),
      teamOn(field, 12, true, 3),
      teamOn(service, 2, false, 0),
      teamOn(finance, 5, true, 2),
      teamOn(purchasing, 3, true, 1),
    ],
    asks: [
      {
        id: "bounce",
        kind: "bounce",
        team: "Field service",
        address: "m.bakker@veldhuis-installatie.nl",
      },
      { id: "quiet", kind: "quiet", team: "Customer service", waiting: 7 },
    ],
    declined: ["Pieter de Groot"],
    events: [
      { day: "2026-11-23", text: "Your message and the invitations went out." },
      { day: "2026-11-24", text: "The first findings came in, from Planning." },
      { day: "2026-11-25", text: "A reminder went to everyone still to talk." },
      { day: "2026-11-27", text: "Field service: three findings so far." },
    ],
  },
  close: {
    company,
    grouped: true,
    start,
    closes,
    today: "2026-11-30",
    opensAround,
    reminders,
    invited: 43,
    talked: 39,
    known: 83,
    pace: "enough",
    teams: [
      teamOn(planning, 9, true, 3),
      teamOn(field, 14, true, 3),
      teamOn(service, 7, true, 2),
      teamOn(finance, 6, true, 2),
      teamOn(purchasing, 3, true, 1),
    ],
    asks: [],
    declined: ["Pieter de Groot"],
    events: [
      { day: "2026-11-23", text: "Your message and the invitations went out." },
      { day: "2026-11-24", text: "The first findings came in, from Planning." },
      { day: "2026-11-25", text: "A reminder went to everyone still to talk." },
      {
        day: "2026-11-28",
        text: "Customer service picked up after your nudge.",
      },
      {
        day: "2026-11-30",
        text: "Enough is known. The interviews close tonight.",
      },
    ],
  },
  small: {
    company: "Studio Lindeboom",
    grouped: false,
    start,
    closes,
    today: "2026-11-26",
    opensAround,
    reminders,
    invited: 7,
    talked: 4,
    known: 52,
    pace: "onPace",
    teams: [
      {
        id: "everyone",
        name: "Studio Lindeboom",
        invited: 7,
        talked: 4,
        leadTalked: true,
        findings: [
          {
            id: "l1",
            topic: "Starting a project",
            kind: "flow",
            text: "A project starts with a call and a site visit; the brief is written only after the second meeting.",
          },
          {
            id: "l2",
            topic: "Permit drawings",
            kind: "flow",
            text: "Permit drawings are checked on paper before they go to the municipality.",
          },
          {
            id: "l3",
            topic: "Logging hours",
            kind: "difference",
            text: "Two people said differently how hours are logged: daily in the timesheet, or at the end of each project.",
          },
        ],
      },
    ],
    asks: [],
    declined: [],
    events: [
      {
        day: "2026-11-23",
        text: "The first interview, with the person you said knows the work best.",
      },
      { day: "2026-11-24", text: "Everyone else got their invitation." },
      { day: "2026-11-25", text: "The first findings came in." },
    ],
  },
};

/** Whole days from `from` to `to`, ISO days both. */
export const daysBetween = (from: string, to: string): number =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000
  );

/** All findings, in team order. */
export const findingsOf = (campaign: Campaign): Finding[] =>
  campaign.teams.flatMap((each) => each.findings);

/**
 * How many of a team talked on each day of the campaign so far, as core
 * would count them: more at the start, fewer as it goes. A team under five
 * shows only its lead, on the day they talked.
 */
export const talkedByDay = (
  team: TeamPicture,
  campaign: Campaign
): number[] => {
  const days = daysBetween(campaign.start, campaign.closes) + 1;
  const elapsed = daysBetween(campaign.start, campaign.today) + 1;
  const counts = Array.from({ length: days }, () => 0);
  if (team.invited < smallTeam) {
    if (team.leadTalked) {
      counts[Math.min(1, elapsed - 1)] = 1;
    }
    return counts;
  }
  const weights = Array.from(
    { length: elapsed },
    (_, day) => elapsed - day + 1
  );
  const sum = weights.reduce((total, weight) => total + weight, 0);
  const exact = weights.map((weight) => (team.talked * weight) / sum);
  const floors = exact.map((value) => Math.floor(value));
  let left = team.talked - floors.reduce((total, value) => total + value, 0);
  const order = exact
    .map((value, day) => ({ day, rest: value - Math.floor(value) }))
    .toSorted((a, b) => b.rest - a.rest);
  for (const { day } of order) {
    if (left === 0) {
      break;
    }
    floors[day] = (floors[day] ?? 0) + 1;
    left -= 1;
  }
  for (const [day, value] of floors.entries()) {
    counts[day] = value;
  }
  return counts;
};
