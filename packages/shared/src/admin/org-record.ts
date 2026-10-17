import { interviewLocales } from "../onboarding.ts";
import type { InterviewLocale as Locale } from "../onboarding.ts";
import type { DocumentReading } from "./document-reading.ts";
import type { InterviewFact, InterviewLine } from "./interview-turn.ts";
import { isInterviewer } from "./interviewer.ts";
import type { Interviewer } from "./interviewer.ts";
import { PHASES, TAGS } from "./interviews.ts";
import type { PersonState, Phase } from "./interviews.ts";
import { present } from "./present.ts";

/**
 * An organization Grasp onboards for real, as the Worker keeps it and the pages read it: who it
 * is, what its admin did in their own onboarding, its teams and people, every person's link and
 * interview, and the work drawn from what they said. In the prototype one organization was one
 * Durable Object. Pure.
 *
 * Core's onboarding rules (apps/core/src/onboarding/rules.ts) are these rules adapted to Grasp OS's
 * own roster and plan, and count days with the helpers here.
 */

/** A language the interviews are held in: the ones Grasp OS holds interviews in. */
const isLocale = (value: unknown): value is Locale =>
  interviewLocales.some((locale) => locale === value);

/** Whether a value is an object to read fields from, as what comes in is read: an array counts as one without any. */
const isFields = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** A value's fields; none for what is not an object. */
const fieldsIn = (value: unknown): Record<string, unknown> =>
  isFields(value) ? value : {};

// ---------------------------------------------------------------------------------------------
// Links

/**
 * A link's code: the organization, a dot, and a secret. Whoever has it is who it was made for:
 * the company's admin, or one person. The secret is 128 random bits, so it cannot be guessed.
 */
const CODE =
  /^(?<org>[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])?)\.(?<secret>[A-Za-z0-9_-]{22})$/u;

export const codeOf = (org: string, secret: string): string =>
  `${org}.${secret}`;

/** The organization and the secret in a code; none when it is not one. */
export const splitCode = (
  code: unknown
): { org: string; secret: string } | null => {
  if (typeof code !== "string") {
    return null;
  }
  const groups = CODE.exec(code.trim())?.groups;
  return groups?.org !== undefined && groups.secret !== undefined
    ? { org: groups.org, secret: groups.secret }
    : null;
};

/** A new secret: 128 random bits, written in the letters a link can carry. */
export const newSecret = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

/** Words as an id: lower case, letters and digits, a dash between. */
export const slugOf = (words: string): string =>
  words
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 36)
    .replace(/-+$/u, "") || "org";

/** A number from words, always the same for the same words: for ids that stay put. */
/* oxlint-disable no-bitwise, unicorn/prefer-code-point -- a 32-bit string hash on UTF-16 units, as the prototype's: ids made with it stay put */
const hashOf = (words: string): string => {
  let hash = 2_166_136_261;
  for (let index = 0; index < words.length; index += 1) {
    hash ^= words.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
};
/* oxlint-enable no-bitwise, unicorn/prefer-code-point */

/** A person's id, from their email, or their name and team where there is no email: the same person keeps it when the list comes in again. */
export const personIdOf = (person: {
  email?: string;
  name: string;
  team?: string;
}): string => {
  const email = person.email?.trim().toLowerCase();
  return `p-${hashOf(present(email) ? email : `${person.name.trim().toLowerCase()}|${person.team ?? ""}`)}`;
};

/** A team's id, from its name. */
export const teamIdOf = (name: string): string => `t-${slugOf(name)}`;

// ---------------------------------------------------------------------------------------------
// The organization

export interface OrgContact {
  name: string;
  /** Their job: "COO". */
  title: string;
  email: string;
}

/** Who the organization is, as Grasp added it. */
export interface OrgProfile {
  id: string;
  name: string;
  /** What it does, in a few words: "an insurance and mortgage advice firm". */
  about: string;
  /** Its website, without the protocol. */
  website: string;
  place: string;
  /** The language its people speak, unless one of them chooses another. */
  language: Locale;
  /** Who decided on Grasp there. */
  sponsor: OrgContact;
  /** Who goes through the onboarding there. */
  admin: OrgContact;
  /** When Grasp added it, as an ISO time. */
  created: string;
  /** Made to try things out: its people are played, and it says so everywhere. */
  test: boolean;
}

/** A document the company's admin shared in their onboarding: what Stephen took from it, never the file. */
export interface KeptDocument {
  name: string;
  size: number;
  reading?: DocumentReading;
  /** Why it could not be read. */
  problem?: string;
  /** Their answer to the one question Stephen had about it. */
  answer?: string;
}

/** Where the company's own admin is in their onboarding, and what they shared. */
export interface ClientRecord {
  status: "off" | "active" | "done";
  step: string;
  reached: number;
  /** Where the people came from. */
  directory: "microsoft" | "google" | "list" | null;
  /** The places their documents live, by id: Grasp sets these up with them. */
  sources: string[];
  sourcesWanted: string[];
  documents: KeptDocument[];
  pulse: "downloaded" | "mdm" | "sent" | "skipped" | null;
  pulseTo: string | null;
  /** Their HR platform, when they use one: Grasp sets it up with them. */
  hr: string | null;
  hrWanted: string | null;
  /** The message to the team as they edited it; none keeps the one Grasp wrote. */
  message: string | null;
  /** What needed them, settled. */
  settled: string[];
  doneOn: string | null;
  /** Whose links they took to send, by person: copied, or in a list. A link out since is new to them. */
  handed: string[];
}

export const NEW_CLIENT: ClientRecord = {
  status: "off",
  step: "welcome",
  reached: 0,
  directory: null,
  sources: [],
  sourcesWanted: [],
  documents: [],
  pulse: null,
  pulseTo: null,
  hr: null,
  hrWanted: null,
  message: null,
  settled: [],
  doneOn: null,
  handed: [],
};

/** A team, as the staff list and its admin have it. */
export interface RosterTeam {
  id: string;
  name: string;
  /** Its lead, by person. */
  lead: string | null;
  /** What it does, once its lead said so. */
  does: string;
  /** Not taking part: nobody in it gets a link. */
  off: boolean;
  /** The day it was asked in, as an ISO day, when that was after the interviews had started: its lead gets the same days to talk first. */
  since?: string;
}

/** Someone who works there. */
export interface RosterPerson {
  id: string;
  name: string;
  email: string;
  team: string;
  /** Their job, as the list has it. */
  title: string;
  /** Away these weeks: they get no link, and nothing waits for them. */
  away: boolean;
  /** The piece of work Stephen asks them about, by id, once their lead named it. */
  work: string | null;
}

export interface Roster {
  teams: RosterTeam[];
  people: RosterPerson[];
}

/** When the interviews run: from the start day, for so many days. */
export interface Plan {
  /** The first day, as an ISO day: the leads get their link that morning. */
  start: string;
  days: number;
  /** When the admin said they told the team, as an ISO time. */
  told: string;
  /**
   * The moment the first links go out, as an ISO time, as whoever sends them set it: a day and an
   * hour of their own clock. None is the morning of the start day, as it was before there was a choice.
   */
  at?: string;
  /**
   * Teams that do not go with the first links, by team: the moment theirs go out, or null while
   * nobody has planned that yet. A team not named here goes with the first.
   */
  later?: Record<string, string | null>;
}

/** When a team's links start to go out under a plan, as an ISO time: none while its turn is not planned. */
export const sendsFrom = (plan: Plan, team: string): string | null => {
  const own = plan.later?.[team];
  if (own !== undefined) {
    return own;
  }
  return plan.at ?? `${plan.start}T00:00:00.000Z`;
};

/** The usual length of the interviews, in days. */
export const PLAN_DAYS = 14;
/** A team's links go out once its lead has talked; after this many working days without the lead they go out anyway. */
export const LEAD_WAIT = 3;

/** One person's link: its secret, and what happened to it. Times are ISO. */
export interface LinkRecord {
  person: string;
  secret: string;
  /** When it went out to them: none while it waits for its day, or for their lead. */
  sent: string | null;
  opened: string | null;
  reminded: string | null;
  /**
   * The mark of the key of the device that opened the link first (`keyMark`). From then on only
   * that device opens the interview on it: the link alone, which the company's admin handed out
   * and may still hold, opens nothing that was said. None before anyone opened it.
   */
  key?: string;
}

/** The mark of a device's key, as the store keeps it: the key itself is only ever on that device. */
export const keyMark = async (key: string): Promise<string> => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key)
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * Whose a link is, for one request: `mine` when it comes from the device that opened it first,
 * `new` when no device opened it yet, and `elsewhere` for anyone else who holds the link, the
 * company's admin among them. `mark` is the mark of the key the request came with, none when it
 * came with none. An interview that was agreed to before devices were told apart has no key and
 * never gets one: it is closed to the link alone.
 */
export const opensFor = (
  link: Pick<LinkRecord, "key">,
  mark: string | null,
  agreedBefore: boolean
): "mine" | "new" | "elsewhere" => {
  if (present(link.key)) {
    return mark !== null && mark === link.key ? "mine" : "elsewhere";
  }
  return agreedBefore ? "elsewhere" : "new";
};

/** Where someone's interview is: the same as the page keeps while they talk. */
export interface InterviewProgress {
  person: PersonState;
  told: boolean;
  mode: "talk" | "type" | null;
  lines: InterviewLine[];
  facts: InterviewFact[];
  phase: Phase;
  wants: "answer" | "file" | "readback" | "end";
  startedAt: number | null;
  confirmed: number;
  adding: boolean;
  addedAt: number;
  /** How they found talking to Stephen, from 1 to 5, when they said so at the end: it is theirs to give or not. */
  rating?: number;
  /** Who they chose to talk with, once they chose; Stephen while it does not say. */
  interviewer?: Interviewer;
}

export const NOTHING_SAID: InterviewProgress = {
  person: "invited",
  told: false,
  mode: null,
  lines: [],
  facts: [],
  phase: "open",
  wants: "answer",
  startedAt: null,
  confirmed: 0,
  adding: false,
  addedAt: 0,
};

/** The lowest and the highest someone can rate their interview. */
export const RATINGS = [1, 2, 3, 4, 5] as const;

/** The most lines and facts kept of one interview, and the longest of each. */
const MOST_LINES = 400;
const MOST_FACTS = 200;
const LONGEST_LINE = 4000;
const LONGEST_FACT = 300;

const cut = (value: unknown, most: number): string =>
  typeof value === "string" ? value.slice(0, most) : "";

/**
 * An interview as a page sends it to be kept, checked item by item: a line is someone's words
 * and nothing else, a fact is one of the kinds there are with a text of its own, and anything
 * that is not what it should be is left out. What is in it stays the person's own, so a page
 * that was tampered with can still say what it likes about its own interview; it cannot put
 * anything else than lines and facts in the store. None when it is not an interview at all.
 */
// oxlint-disable-next-line complexity -- ported as the prototype has it, one field after another; org-record.test.ts pins what it lets through
export const parseProgress = (value: unknown): InterviewProgress | null => {
  if (!isFields(value)) {
    return null;
  }
  const raw = value;
  if (!Array.isArray(raw.lines) || !Array.isArray(raw.facts)) {
    return null;
  }
  const states: PersonState[] = [
    "invited",
    "opened",
    "progress",
    "incomplete",
    "completed",
    "expired",
  ];
  const lines = raw.lines
    .slice(-MOST_LINES)
    .flatMap((each): InterviewLine[] => {
      const line = fieldsIn(each);
      if (
        (line.from !== "stephen" && line.from !== "person") ||
        typeof line.text !== "string"
      ) {
        return [];
      }
      const marks = Array.isArray(line.marks)
        ? line.marks.slice(0, 40).flatMap((mark) => {
            const one = fieldsIn(mark);
            const tag = TAGS.find((known) => known === one.tag);
            return tag && typeof one.quote === "string"
              ? [{ quote: one.quote.slice(0, LONGEST_FACT), tag }]
              : [];
          })
        : [];
      return [
        {
          from: line.from,
          text: line.text.slice(0, LONGEST_LINE),
          ...(line.typed === true ? { typed: true } : {}),
          ...(marks.length > 0 ? { marks } : {}),
          ...(typeof line.file === "string"
            ? { file: line.file.slice(0, 200) }
            : {}),
          ...(typeof line.tone === "string"
            ? {
                // SAFETY: a tone is only ever said, never matched on: one a page made up is kept as its words.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
                tone: line.tone.slice(0, 40) as InterviewLine["tone"],
              }
            : {}),
        },
      ];
    });
  const seen = new Set<string>();
  const facts = raw.facts
    .slice(0, MOST_FACTS)
    .flatMap((each): InterviewFact[] => {
      const fact = fieldsIn(each);
      const tag = TAGS.find((known) => known === fact.tag);
      const id = cut(fact.id, 12);
      const text = cut(fact.text, LONGEST_FACT);
      if (!tag || !/^[a-z]\d{1,4}$/u.test(id) || seen.has(id) || !text.trim()) {
        return [];
      }
      seen.add(id);
      return [
        {
          id,
          tag,
          text,
          record: cut(fact.record, LONGEST_FACT) || text,
          ...(fact.out === true ? { out: true } : {}),
          ...(typeof fact.pin === "number" &&
          Number.isInteger(fact.pin) &&
          fact.pin >= 0 &&
          fact.pin < MOST_FACTS
            ? { pin: fact.pin }
            : {}),
          ...(fact.agreed === true ? { agreed: true } : {}),
        },
      ];
    });
  return {
    ...NOTHING_SAID,
    person: states.find((state) => state === raw.person) ?? "opened",
    told: raw.told === true,
    mode: raw.mode === "talk" || raw.mode === "type" ? raw.mode : null,
    lines,
    facts,
    phase: PHASES.find((phase) => phase === raw.phase) ?? "open",
    wants:
      raw.wants === "file" || raw.wants === "readback" || raw.wants === "end"
        ? raw.wants
        : "answer",
    startedAt:
      typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt)
        ? raw.startedAt
        : null,
    confirmed:
      typeof raw.confirmed === "number" &&
      Number.isInteger(raw.confirmed) &&
      raw.confirmed >= 0
        ? Math.min(raw.confirmed, MOST_FACTS)
        : 0,
    adding: raw.adding === true,
    addedAt:
      typeof raw.addedAt === "number" && Number.isFinite(raw.addedAt)
        ? raw.addedAt
        : 0,
    ...(typeof raw.rating === "number" && raw.rating >= 1 && raw.rating <= 5
      ? { rating: Math.round(raw.rating) }
      : {}),
    ...(isInterviewer(raw.interviewer) ? { interviewer: raw.interviewer } : {}),
  };
};

/** A lead talks about the team's work; everyone else about one piece of their own. */
export type InterviewKind = "lead" | "employee";

/** One person's interview as the Worker keeps it. */
export interface HeldInterview {
  person: string;
  kind: InterviewKind;
  progress: InterviewProgress;
  /** Goes up with every save, so a save from an older copy is refused. */
  version: number;
  /** When it last changed, as an ISO time. */
  updated: string;
  /** When they first agreed to what was read back; none before. It stays while they come back to add something. */
  completed: string | null;
  /** When they last left in the middle, and in which part. */
  stopped: { at: string; phase: Phase } | null;
}

/** Where one interview stands, without what was said in it: all the plan, the links and the numbers need, cheap to read on every change. */
export interface InterviewState {
  person: string;
  kind: InterviewKind;
  version: number;
  updated: string;
  completed: string | null;
  stopped: HeldInterview["stopped"];
  progress: Pick<InterviewProgress, "startedAt" | "person" | "phase">;
}

/** Where an interview stands, from the interview itself. */
export const stateOfInterview = (held: HeldInterview): InterviewState => {
  const { person, kind, version, updated, completed, stopped, progress } = held;
  return {
    person,
    kind,
    version,
    updated,
    completed,
    stopped,
    progress: {
      startedAt: progress.startedAt,
      person: progress.person,
      phase: progress.phase,
    },
  };
};

/** What one person said about a piece of work, as positions in the drawn work: what the admin's record counts. */
export interface Told {
  start: boolean;
  steps: number[];
  end: boolean;
  way: { step: number; other: boolean } | null;
  waits: number[];
  differently: number[];
  decides: boolean;
  own: boolean;
  ai: boolean;
  volume: [number, number] | null;
  takes: [number, number, number] | null;
  wrong: number | null;
  right: boolean;
  ask: boolean;
  next: boolean;
  example: string | null;
  term: boolean;
  out: string[];
}

/** A step as drawn: one instruction, who does it, where, and how long people said one takes. */
export interface DrawnStep {
  text: string;
  who: string;
  tool: string;
  /** Minutes for one: the quickest, a normal one and the longest anyone said; none when nobody said. */
  minutes: [number, number, number] | null;
  /** Also described in a document the admin shared. */
  documented: boolean;
}

/**
 * A piece of work as drawn from the agreed facts of everyone who does it: the same parts the
 * admin's record shows, and who told which. Numbers are never averaged: each person's are kept.
 */
export interface DrawnWork {
  /** When it was drawn, as an ISO time, and from whose interviews. */
  at: string;
  from: string[];
  starts: string;
  steps: DrawnStep[];
  waits: string[];
  /** A case off the normal path: when it happens, what is done then, how many out of ten (none when nobody said), and the step it follows. */
  differently: {
    when: string;
    does: string;
    outOfTen: number | null;
    after: number;
  }[];
  decides: string;
  own: string;
  ai: string;
  right: string;
  ask: string;
  next: string;
  term: { word: string; meaning: string } | null;
  /** A step some describe another way, and why. */
  differs: {
    step: number;
    other: string;
    why: "condition" | "place" | "conflict";
    because: string;
  } | null;
  per: "week" | "month";
  unit: "minutes" | "hours";
  /** What each person told, by person. */
  told: Record<string, Told>;
  /** What nobody could say yet: the next interviews ask it. */
  open: string[];
}

/** A piece of recurring work a team does. */
export interface WorkRecord {
  id: string;
  team: string;
  /** Grasp's own name for it, in English. */
  name: string;
  /** Its name in the language its people speak: what they and their company read. */
  local?: string;
  /** What one of them is called, and several. */
  item: [one: string, many: string];
  /** Who does it, by person. */
  doers: string[];
  /** How much of the team's time it takes, against its other work. */
  share: number;
  /** Named by the lead in their interview, or added by Grasp. */
  from: "lead" | "grasp";
  drawn: DrawnWork | null;
  /** Agreed facts came in since it was drawn. */
  stale: boolean;
}

/** Anything that can go as JSON: what Grasp's staff keep per organization is kept as it comes. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/** Something that happened at the organization, and who did it. */
export interface OrgEvent {
  at: string;
  /** Grasp's staff by email, the company's admin, a person by id, or Grasp itself. */
  by: string;
  what: string;
  /** What it was about, by id or in a few words. */
  about?: string;
}

/** What the Worker counts AI use under: the company's own onboarding and what it shared, the interviews, and the work drawn from them. */
export const METER_PURPOSES = ["reading", "interviews", "drawing"] as const;
export type MeterPurpose = (typeof METER_PURPOSES)[number];

/**
 * What the calls to one model took: how many there were, the tokens it read new and the tokens it
 * read from what it had kept of an earlier call, the tokens it wrote, and for a voice the seconds
 * it spoke.
 */
export interface Metered {
  calls: number;
  tokensIn: number;
  kept: number;
  tokensOut: number;
  seconds: number;
}

/** What one call took, to count at the organization it was made for. `model` is the model as its maker names it, or `voice` for Stephen's. */
export interface Took extends Partial<Omit<Metered, "calls">> {
  purpose: MeterPurpose;
  model: string;
}

/** One day's AI use at an organization, as the Worker counted it: by what it was for, then by model. */
export interface MeterDay {
  day: string;
  use: Partial<Record<MeterPurpose, Record<string, Metered>>>;
}

/** A count as given, when it is one: a number from nothing up. */
const counted = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** A day's count with one more call in it. Pure. */
export const metered = (day: MeterDay["use"], took: Took): MeterDay["use"] => {
  const of = day[took.purpose] ?? {};
  const before = of[took.model] ?? {
    calls: 0,
    tokensIn: 0,
    kept: 0,
    tokensOut: 0,
    seconds: 0,
  };
  return {
    ...day,
    [took.purpose]: {
      ...of,
      [took.model]: {
        calls: before.calls + 1,
        tokensIn: before.tokensIn + counted(took.tokensIn),
        kept: before.kept + counted(took.kept),
        tokensOut: before.tokensOut + counted(took.tokensOut),
        seconds: before.seconds + counted(took.seconds),
      },
    },
  };
};

// ---------------------------------------------------------------------------------------------
// What each may see

/** One person's link as Grasp's staff sees it: the code to send, and where they stand. */
export interface StaffLink extends LinkRecord {
  code: string;
  state: PersonState | "waiting";
}

/** Everything about one organization, for Grasp's staff. */
export interface StaffSnapshot {
  profile: OrgProfile;
  clientCode: string;
  client: ClientRecord;
  roster: Roster | null;
  plan: Plan | null;
  /** What Grasp's staff did by hand, as the admin keeps it per organization. */
  grasp: Record<string, Json>;
  links: StaffLink[];
  interviews: HeldInterview[];
  works: WorkRecord[];
  /** Teams whose work is known from their lead. */
  mapped: string[];
  events: OrgEvent[];
  /** The AI used for this organization, day by day, as the Worker counted it. */
  usage: MeterDay[];
  now: string;
}

/** What the company's own admin sees: their onboarding, their people with the links to send, and numbers per team. Never anyone's words. */
export interface ClientSnapshot {
  profile: Pick<
    OrgProfile,
    "id" | "name" | "about" | "language" | "sponsor" | "admin" | "test"
  >;
  client: ClientRecord;
  roster: Roster | null;
  plan: Plan | null;
  /** Each person's link and whether it went out; whether they talked is not here. */
  links: { person: string; code: string; sent: string | null }[];
  progress: ClientProgress;
  /** What needs them: differences nobody could explain, by piece of work. */
  review: { work: string; name: string; team: string }[];
  /** The agreements and the works council are in place: until then no link goes out. */
  agreed: boolean;
  /** Grasp gave its go: they can come in. */
  opened: boolean;
  threshold: number;
  now: string;
}

/** What a person's own link opens: who they are to Grasp, the interview they are in, and nothing of anyone else. */
export interface PersonSession {
  org: string;
  company: string;
  about: string;
  language: Locale;
  /** Their first name, team and lead. */
  name: string;
  team: string;
  lead: string | null;
  kind: InterviewKind;
  /** The piece of work Stephen asks about; none when their lead did not name one. */
  work: string | null;
  /** Everything is agreed for interviews to happen: the agreements and the works council. */
  agreed: boolean;
  /** The last day the link works. */
  closes: string | null;
  progress: InterviewProgress;
  version: number;
  test: boolean;
  /** The key of this device, given once, when it is the first to open the link: it keeps it and sends it with every call (`x-grasp-device`). */
  key?: string;
}

/** What a link answers to anyone but the device its interview is on: nothing that was said. */
export interface PersonElsewhere {
  elsewhere: true;
}

/** One organization in Grasp's list. */
export interface OrgSummary {
  id: string;
  name: string;
  about: string;
  created: string;
  test: boolean;
  people: number;
  teams: number;
  /** The step its own admin is at. */
  step: string;
  /** When its team was told, and the day of the interviews it is on. */
  told: string | null;
  day: number | null;
  talked: number;
  works: number;
  drawn: number;
  updated: string;
}

// ---------------------------------------------------------------------------------------------
// What follows from it

/** The day an ISO time falls on, as an ISO day. */
export const dayOf = (time: string): string => time.slice(0, 10);

/** Whole days from one ISO day to another. */
export const daysBetween = (from: string, to: string): number =>
  Math.round(
    (Date.parse(`${to.slice(0, 10)}T12:00:00Z`) -
      Date.parse(`${from.slice(0, 10)}T12:00:00Z`)) /
      86_400_000
  );

/** The ISO day `count` days after `day`. */
export const addDays = (day: string, count: number): string => {
  const date = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};

/** The ISO day `count` working days after `day`: weekends do not count. */
export const addWorkingDays = (day: string, count: number): string => {
  let at = day.slice(0, 10);
  let left = count;
  while (left > 0) {
    at = addDays(at, 1);
    const weekday = new Date(`${at}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      left -= 1;
    }
  }
  return at;
};

/** The last day of the interviews. */
export const closesOn = (plan: Plan): string =>
  addDays(plan.start, plan.days - 1);

/** Whether a team takes part, and the people in it who do. */
export const takingPart = (roster: Roster, person: RosterPerson): boolean => {
  const team = roster.teams.find((each) => each.id === person.team);
  return team !== undefined && !team.off && !person.away;
};

/** A piece of work by the name its people use; Grasp's English one where the map gave none. */
export const localName = (work: Pick<WorkRecord, "name" | "local">): string =>
  present(work.local) ? work.local : work.name;

/** Whether someone leads their team. */
export const leads = (roster: Roster, person: string): boolean =>
  roster.teams.some((team) => team.lead === person);

/** Whether interviews may happen: the agreements signed and the works council's yes where there is one, as Grasp's staff keep it; or it is a test. */
export const agreementsIn = (
  profile: Pick<OrgProfile, "test">,
  grasp: Record<string, Json>
): boolean => {
  const given = grasp.agreed;
  const agreed =
    typeof given === "object" && given !== null && !Array.isArray(given)
      ? given
      : {};
  return (
    profile.test ||
    (agreed.processing === true &&
      agreed.assessment === true &&
      agreed.council !== "waiting")
  );
};

/**
 * Whose links are due by `now` and not out yet. A lead's on the start day. Everyone else's once
 * their lead has agreed to their interview and the team's work is known; or, when the lead has
 * not talked after `LEAD_WAIT` working days, then anyway, and Stephen asks them what work they do.
 * A team without a lead gets its links on the start day.
 */
export const dueLinks = (
  roster: Roster,
  plan: Plan | null,
  links: Record<string, LinkRecord>,
  interviews: Record<string, InterviewState>,
  mapped: Set<string>,
  now: string
): string[] => {
  if (!plan) {
    return [];
  }
  const today = dayOf(now);
  return roster.people.flatMap((person) => {
    if (!takingPart(roster, person) || present(links[person.id]?.sent)) {
      return [];
    }
    // Nothing of a team goes out before its own moment, and nothing at all while that is not planned.
    const from = sendsFrom(plan, person.team);
    if (from === null || now < from) {
      return [];
    }
    const team = roster.teams.find((each) => each.id === person.team);
    if (
      !present(team?.lead) ||
      team.lead === person.id ||
      !roster.people.some((each) => each.id === team.lead && !each.away)
    ) {
      return [person.id];
    }
    const leadDone = interviews[team.lead]?.completed;
    if (present(leadDone) && mapped.has(team.id)) {
      return [person.id];
    }
    // A team asked in later waits for its lead from that day on, and one sent later from the day its links went out.
    const first = dayOf(from) > plan.start ? dayOf(from) : plan.start;
    const since =
      present(team.since) && team.since > first ? team.since : first;
    return today >= addWorkingDays(since, LEAD_WAIT) ? [person.id] : [];
  });
};

/** Where someone stands now: the company's six states, and before those no link yet. */
export const personStateOf = (
  link: LinkRecord | undefined,
  held: InterviewState | undefined,
  plan: Plan | null,
  now: string
): PersonState | "waiting" => {
  if (!present(link?.sent)) {
    return "waiting";
  }
  if (present(held?.completed)) {
    return "completed";
  }
  const over = plan !== null && dayOf(now) > closesOn(plan);
  const talked = held !== undefined && held.progress.startedAt !== null;
  if (over) {
    return talked ? "incomplete" : "expired";
  }
  if (talked) {
    // Talking within the last quarter of an hour counts as talking now; longer ago, they stopped.
    const recent = Date.parse(now) - Date.parse(held.updated) < 15 * 60_000;
    return held.progress.person === "progress" && recent
      ? "progress"
      : "incomplete";
  }
  return present(link.opened) ? "opened" : "invited";
};

/** Groups smaller than this are never shown to the company apart. */
export const MIN_SHOWN = 5;

/** One team as the company's own admin sees it: how many talked, never who. Numbers only for teams of five or more. */
export interface TeamProgress {
  id: string;
  name: string;
  /** The lead's name: the company knows its own leads. */
  lead: string | null;
  people: number;
  /** Whether the lead has talked: the company knows its own leads, and the team's links wait for them. */
  leadTalked: boolean;
  /** How many talked, and how many were asked: none for a team under five. */
  talked: number | null;
  asked: number | null;
  off: boolean;
}

/** Where the interviews stand, as the company's own admin may see it. */
export interface ClientProgress {
  teams: TeamProgress[];
  /** All teams together, and the leads apart. */
  talked: number;
  asked: number;
  leadsTalked: number;
  leads: number;
  /** Pieces of work drawn so far, and how many of those count as known. */
  works: number;
  drawn: number;
}

export const clientProgressOf = (
  roster: Roster,
  interviews: Record<string, InterviewState>,
  works: WorkRecord[]
): ClientProgress => {
  const done = (person: string) => Boolean(interviews[person]?.completed);
  const teams = roster.teams.map((team): TeamProgress => {
    const people = roster.people.filter((person) => person.team === team.id);
    const asked = people.filter(
      (person) => !person.away && person.id !== team.lead
    );
    const shown = people.length >= MIN_SHOWN;
    return {
      id: team.id,
      name: team.name,
      lead:
        roster.people.find((person) => person.id === team.lead)?.name ?? null,
      people: people.length,
      leadTalked: team.lead !== null && done(team.lead),
      talked:
        shown && !team.off
          ? asked.filter((person) => done(person.id)).length
          : null,
      asked: shown && !team.off ? asked.length : null,
      off: team.off,
    };
  });
  const taking = roster.teams.filter((team) => !team.off);
  const askedAll = roster.people.filter(
    (person) => takingPart(roster, person) && !leads(roster, person.id)
  );
  return {
    teams,
    talked: askedAll.filter((person) => done(person.id)).length,
    asked: askedAll.length,
    leadsTalked: taking.filter((team) => team.lead !== null && done(team.lead))
      .length,
    leads: taking.filter((team) => team.lead !== null).length,
    works: works.length,
    drawn: works.filter((work) => work.drawn !== null).length,
  };
};

/**
 * Who in a team is asked about which piece of work: whoever the lead named for a work, then the
 * rest by each work's share, so every piece of work is heard from several people. A person who
 * does more than one is asked about the one fewest others are asked about.
 */
export const assignWork = (
  people: RosterPerson[],
  works: WorkRecord[]
): Record<string, string | null> => {
  const count = new Map(works.map((work) => [work.id, 0]));
  const assigned: Record<string, string | null> = {};
  const named = (person: RosterPerson) =>
    works.filter((work) => work.doers.includes(person.id));
  // Whoever does only one piece of work is asked about that one; those who do more fill the gaps.
  const order = people.toSorted(
    (a, b) => named(a).length - named(b).length || a.name.localeCompare(b.name)
  );
  for (const person of order) {
    const theirs = named(person);
    const pool = theirs.length > 0 ? theirs : works;
    if (pool.length === 0) {
      assigned[person.id] = null;
      continue;
    }
    // The least heard so far, weighed by how much of the team's time it takes.
    const [pick] = pool.toSorted(
      (a, b) =>
        (count.get(a.id) ?? 0) / Math.max(a.share, 0.05) -
          (count.get(b.id) ?? 0) / Math.max(b.share, 0.05) || b.share - a.share
    );
    if (pick === undefined) {
      continue;
    }
    assigned[person.id] = pick.id;
    count.set(pick.id, (count.get(pick.id) ?? 0) + 1);
  }
  return assigned;
};

// ---------------------------------------------------------------------------------------------
// Checks on what comes in

export class OrgRecordError extends Error {
  override name = "OrgRecordError";
}

const text = (value: unknown, most: number): string =>
  typeof value === "string"
    ? value.replaceAll(/\s+/gu, " ").trim().slice(0, most)
    : "";

const contact = (value: unknown): OrgContact => {
  const raw = fieldsIn(value);
  return {
    name: text(raw.name, 80),
    title: text(raw.title, 80),
    email: text(raw.email, 120).toLowerCase(),
  };
};

/** What Grasp fills in to add an organization, checked. */
export const parseNewOrg = (
  value: unknown
): Omit<OrgProfile, "id" | "created"> => {
  const raw = fieldsIn(value);
  const name = text(raw.name, 80);
  if (!name) {
    throw new OrgRecordError("Give the organization a name.");
  }
  return {
    name,
    about: text(raw.about, 200),
    website: text(raw.website, 120)
      .replace(/^https?:\/\//u, "")
      .replace(/\/$/u, ""),
    place: text(raw.place, 80),
    language: isLocale(raw.language) ? raw.language : "en",
    sponsor: contact(raw.sponsor),
    admin: contact(raw.admin),
    test: raw.test === true,
  };
};

/** The most people one organization can have here. */
export const MAX_PEOPLE = 2000;
export const MAX_TEAMS = 120;

/** A roster as the company's admin confirmed it, checked: every person in a team that exists, every lead in their own team. */
export const parseRoster = (value: unknown): Roster => {
  const raw = fieldsIn(value);
  if (!Array.isArray(raw.teams) || !Array.isArray(raw.people)) {
    throw new OrgRecordError("Send the teams and the people.");
  }
  const teams: RosterTeam[] = [];
  for (const each of raw.teams.slice(0, MAX_TEAMS)) {
    const team = fieldsIn(each);
    const name = text(team.name, 80);
    if (!name) {
      continue;
    }
    const id = text(team.id, 60) || teamIdOf(name);
    if (teams.some((known) => known.id === id)) {
      continue;
    }
    const since = text(team.since, 10);
    teams.push({
      id,
      name,
      lead: text(team.lead, 40) || null,
      does: text(team.does, 200),
      off: team.off === true,
      ...(/^\d{4}-\d{2}-\d{2}$/u.test(since) ? { since } : {}),
    });
  }
  const people: RosterPerson[] = [];
  for (const each of raw.people.slice(0, MAX_PEOPLE)) {
    const person = fieldsIn(each);
    const name = text(person.name, 80);
    const team = text(person.team, 60);
    if (!name || !teams.some((known) => known.id === team)) {
      continue;
    }
    const email = text(person.email, 120).toLowerCase();
    const id = text(person.id, 40) || personIdOf({ email, name, team });
    if (people.some((known) => known.id === id)) {
      continue;
    }
    people.push({
      id,
      name,
      email,
      team,
      title: text(person.title, 80),
      away: person.away === true,
      work: text(person.work, 60) || null,
    });
  }
  for (const team of teams) {
    if (
      present(team.lead) &&
      !people.some(
        (person) => person.id === team.lead && person.team === team.id
      )
    ) {
      team.lead = null;
    }
  }
  if (people.length === 0) {
    throw new OrgRecordError("There is nobody in the list.");
  }
  return { teams, people };
};

/** A moment as an ISO time, when it is one. */
const instant = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 40) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};

/** A plan, checked: a start day from today on, for one to six weeks. */
export const parsePlan = (value: unknown, now: string): Omit<Plan, "told"> => {
  const raw = fieldsIn(value);
  const start = text(raw.start, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(start) || Number.isNaN(Date.parse(start))) {
    throw new OrgRecordError("Pick the day the interviews start.");
  }
  if (start < dayOf(now)) {
    throw new OrgRecordError("The interviews cannot start in the past.");
  }
  const days =
    typeof raw.days === "number" && Number.isFinite(raw.days)
      ? Math.min(Math.max(Math.round(raw.days), 5), 42)
      : PLAN_DAYS;
  const plan: Omit<Plan, "told"> = { start, days };
  // The moment of the first links: a real time, within a day of the start day whatever their clock is.
  const at = instant(raw.at);
  if (raw.at !== undefined && raw.at !== null) {
    if (
      !present(at) ||
      Math.abs(Date.parse(at) - Date.parse(`${start}T12:00:00Z`)) >
        36 * 3_600_000
    ) {
      throw new OrgRecordError("Pick the time the links go out.");
    }
    plan.at = at;
  }
  if (isFields(raw.later) && !Array.isArray(raw.later)) {
    const later: Record<string, string | null> = {};
    for (const [team, when] of Object.entries(raw.later).slice(0, 200)) {
      if (!/^[A-Za-z0-9_-]{1,60}$/u.test(team)) {
        continue;
      }
      const own = instant(when);
      if (
        when !== null &&
        (!present(own) || own < (plan.at ?? `${start}T00:00:00.000Z`))
      ) {
        throw new OrgRecordError(
          "A team that goes later cannot go before the first links."
        );
      }
      later[team] = own;
    }
    if (Object.keys(later).length > 0) {
      plan.later = later;
    }
  }
  return plan;
};
