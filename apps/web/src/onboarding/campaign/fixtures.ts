// What the campaign page reads while the interviews run, as fixtures in
// five states (`?state=`) until core serves it. Core gives today only
// counts per team (`onboarding.view`); the talks by day, the findings, the
// pace, the asks and who declined are what core has to provide.

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
  /** False for a small company: one group, and the word "team" never shows. */
  grouped: boolean;
  /** ISO days. */
  start: string;
  closes: string;
  today: string;
  invited: number;
  talked: number;
  pace: Pace;
  /** By team; for a small company, one group holding everyone. */
  teams: TeamPicture[];
  asks: Ask[];
  /** Who declined the interview, by name (never why): Ruben's decision. */
  declined: string[];
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
      kind: "flow",
      text: "A job is planned twice. First on the whiteboard on Monday morning, then in the planning tool by Wednesday.",
    },
    {
      id: "p2",
      kind: "difference",
      text: "Two people said differently who decides on an urgent call-out. One said the duty planner, the other whoever answers the phone.",
    },
    {
      id: "p3",
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
      kind: "flow",
      text: "After a job, the work order is photographed and sent on WhatsApp. The office types it over.",
    },
    {
      id: "f2",
      kind: "flow",
      text: "Parts used on site are written down at the end of the day, from memory.",
    },
    {
      id: "f3",
      kind: "difference",
      text: "Two people said differently when a job is closed. One said when the engineer leaves, the other once the customer signs.",
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
      kind: "flow",
      text: "Most calls ask when the engineer arrives, and the answer is looked up in two places.",
    },
    {
      id: "s2",
      kind: "difference",
      text: "Two people said differently where a complaint is kept. One said the shared mailbox, the other the complaints spreadsheet.",
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
      kind: "flow",
      text: "Invoices go out once a week, after field service’s work orders are checked by hand.",
    },
    {
      id: "n2",
      kind: "difference",
      text: "Two people said differently when the credit check is done. One said before the quote, the other after the first order.",
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
      kind: "flow",
      text: "Stock is ordered when a shelf looks empty. No minimum is written down.",
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

const start = "2026-11-23";
const closes = "2026-11-30";

export const campaigns: Record<CampaignState, Campaign> = {
  day1: {
    grouped: true,
    start,
    closes,
    today: "2026-11-23",
    invited: 43,
    talked: 3,
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
  },
  day3: {
    grouped: true,
    start,
    closes,
    today: "2026-11-25",
    invited: 43,
    talked: 19,
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
  },
  day5: {
    grouped: true,
    start,
    closes,
    today: "2026-11-27",
    invited: 43,
    talked: 30,
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
  },
  close: {
    grouped: true,
    start,
    closes,
    today: "2026-11-30",
    invited: 43,
    talked: 39,
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
  },
  small: {
    grouped: false,
    start,
    closes,
    today: "2026-11-26",
    invited: 7,
    talked: 4,
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
            kind: "flow",
            text: "A project starts with a call and a site visit. The brief is written only after the second meeting.",
          },
          {
            id: "l2",
            kind: "flow",
            text: "Permit drawings are checked on paper before they go to the municipality.",
          },
          {
            id: "l3",
            kind: "difference",
            text: "Two people said differently how hours are logged. One said daily in the timesheet, the other at the end of each project.",
          },
        ],
      },
    ],
    asks: [],
    declined: [],
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
