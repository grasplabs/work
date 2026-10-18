import type { InterviewFact, InterviewLine } from "./interview-turn.ts";
import type { Interviewer } from "./interviewer.ts";
import {
  MISTAKES,
  needsSplit,
  PHASES,
  STARTING_RULES,
  VISION_FIELDS,
  workflowState,
} from "./interviews.ts";
import type {
  HypothesisState,
  PersonState,
  Phase,
  RecordField,
  VisionField,
  WorkflowEvidence,
  WorkflowRules,
  WorkflowState,
} from "./interviews.ts";
import { DEFAULT_THRESHOLD, LISTEN_DAYS, WEIGHTS } from "./onboarding.ts";
import type { DirectoryTeam } from "./onboarding.ts";
import { present } from "./present.ts";

/**
 * What a person may do in a client's workspace: the prototype's roles, and Grasp OS's own
 * (`roleSchema` in ../roles.ts), whose builders and users the prototype had no word for.
 */
export type MemberRole = "owner" | "admin" | "builder" | "user" | "viewer";

/**
 * Grasp's own side of an onboarding: every organization from its first conversation until Grasp
 * opens, as a model that can be played day by day. One organization is its teams, its people and
 * the work they do; from those and the day, everything else follows: who has a link, who talked,
 * what each interview brought, and how far each workflow is known under that organization's own
 * rules. Pure, and the same for the same organization and day, so the admin can step back and
 * forth. The sample organizations are made up, and only the tests read them.
 */

/** How a link reaches someone. Email unless Grasp picks another way for a team. */
export const CHANNELS = ["email", "teams", "calendar", "card"] as const;
export type Channel = (typeof CHANNELS)[number];

/** One team, as the sign-in reads it, with its lead by name and what it does. */
export interface OrgTeam extends DirectoryTeam {
  /** The lead's full name, as the HR platform has it. */
  leader: string;
  /** What the team does, in a few words. */
  does: string;
  /** How its people get their link, unless Grasp chooses another way. */
  channel?: Channel;
  /** People placed first in the team, by name. */
  named?: string[];
}

/**
 * A piece of recurring work a team does, as the people who do it describe it. Sentences are kept
 * as the record keeps them: a step is one instruction, the rest plain statements.
 */
export interface Work {
  id: string;
  team: string;
  name: string;
  /** What one of them is called, and several: "ticket", "tickets". */
  item: [one: string, many: string];
  /** How many of the team do it, as a weight against the team's other work. */
  share: number;
  /** What starts it. */
  starts: string;
  /** One action a step, as an instruction. */
  steps: string[];
  /** Steps a document or a log also describes, by position. */
  documented?: number[];
  /** Where it waits, and for what. */
  waits?: string[];
  /** When it goes differently: the condition, what is done then, and how many out of ten (none when nobody said). */
  differently?: [when: string, then: string, outOfTen: number | null][];
  /** What they look at to decide. */
  decides?: string;
  /** A list or tool of their own. */
  own?: string;
  /** An AI tool some of them use. */
  ai?: string;
  /** How many in a quiet and in a busy week, or month. */
  volume: [quiet: number, busy: number];
  per?: "month";
  /** How long the quickest, a normal and the longest one take, in minutes or hours. */
  takes: [least: number, normal: number, most: number];
  unit?: "hours";
  /** How many out of ten come in wrong. */
  wrong: number;
  /** What right looks like. */
  right: string;
  /** When to stop and ask, from "when". */
  ask?: string;
  /** Who gets it next. */
  next: string;
  /** A word of their own, and what it means. */
  term?: [word: string, meaning: string];
  /** A step some describe another way: depending on the case or the office, or without anyone able to say why. */
  differs?: {
    step: number;
    other: string;
    why: "condition" | "place" | "conflict";
    because?: string;
  };
  /** Not in the library: an interview found it. */
  found?: true;
  /** The law sets steps here. */
  regulated?: true;
}

/** Where the public research looks: the company, never its people. */
export const RESEARCH_SOURCES = [
  "register",
  "website",
  "news",
  "jobs",
  "regulator",
  "reviews",
] as const;
export type ResearchSource = (typeof RESEARCH_SOURCES)[number];

/** What one source gave. */
export interface Finding {
  source: ResearchSource;
  text: string;
  /** Where it disagrees with what the company itself said or connected. */
  conflict?: string;
}

/** What the first conversation with the sponsor brought, field by field. A field that is not here was not said. */
export interface VisionReading {
  /** How long it took, and who from the company was in it. */
  minutes?: number;
  who?: string;
  on?: string;
  /** What was said about each thing, with the words it rests on; `later` when the sponsor answered it afterwards. */
  fields: Partial<
    Record<VisionField, { text: string; quote?: string; later?: true }>
  >;
  /** For what was not said: the question to put to the sponsor. */
  ask: Partial<Record<VisionField, string>>;
  /** The teams the sponsor named, before any sign-in is connected. */
  teams: { name: string; does: string; people?: number }[];
}

/** What has to be in place before anyone is invited: two agreements, and the works council's yes where there is one. */
export interface Agreed {
  processing: boolean;
  assessment: boolean;
  council: "yes" | "waiting" | "none";
}

export const mayInvite = (agreed: Agreed): boolean =>
  agreed.processing && agreed.assessment && agreed.council !== "waiting";

/** How far the client's own admin is with their steps: nothing yet, the sign-in connected, the team leads named, the team told. */
export const CLIENT_STEPS = ["none", "directory", "leads", "told"] as const;
export type ClientStep = (typeof CLIENT_STEPS)[number];

/** Who settles a difference nobody can explain. */
export const SETTLERS = ["owner", "lead", "sponsor"] as const;
export type Settler = (typeof SETTLERS)[number];

/** When a workflow counts as known at one organization. */
export interface OrgRules extends WorkflowRules {
  /** How many of the last interviews are looked at for new facts. */
  run: number;
  settles: Settler;
}

export const STARTING_ORG_RULES: OrgRules = {
  ...STARTING_RULES,
  run: 2,
  settles: "owner",
};

/** The company as its own papers have it. */
export interface Company {
  /** Its name as it stands on the contract. */
  legalName: string;
  /** Its website, without the protocol: "noordkade.nl". */
  url: string;
  /** Its number in the company register. */
  register: string;
  vat: string;
  /** The address, a line each, as it goes on an invoice. */
  address: string[];
}

/** Who Grasp deals with at a company, by what they are there for: one person each. */
export const CONTACT_ROLES = [
  "sponsor",
  "admin",
  "billing",
  "privacy",
] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

export interface Contact {
  role: ContactRole;
  name: string;
  /** Their job: "COO". */
  title: string;
  email: string;
}

/** Where a contract stands: still being written, sent to the company, or signed. */
export const CONTRACT_STATES = ["draft", "sent", "signed"] as const;
export type ContractState = (typeof CONTRACT_STATES)[number];

/** The contract between a company and Grasp. Dates are ISO days. */
export interface Contract {
  status: ContractState;
  plan: string;
  /** What the company pays a month, in euros, before VAT. */
  fee: number;
  /** How many people may come into the platform. */
  seats: number;
  /** How much AI use a month the fee covers, in euros. */
  aiIncluded: number;
  sent?: string;
  signed?: string;
  /** Who signed for the company: their job. */
  signedBy?: string;
  from: string;
  until: string;
  /** It carries on for another year, unless someone gives notice in time. */
  renews: boolean;
  /** How many months before the end notice has to be given. */
  notice: number;
  /** The signed copy, by its file name. */
  file?: string;
}

/** A paper that goes with the contract, as it was signed. */
export interface Paper {
  signed: string;
  /** Who signed for the company: their job. */
  by: string;
  /** Which version of Grasp's own text it is. */
  version?: string;
  file: string;
}

/** Someone invited into a company's platform. Dates are ISO days. */
export interface Member {
  id: string;
  name: string;
  email: string;
  /** Their job: "COO". */
  title: string;
  role: MemberRole;
  /** The day their invitation went out. */
  invited: string;
  /** The day they made their account; none while the invitation waits. */
  joined?: string;
  /** The last day they were in, once the platform is open. */
  seen?: string;
  /** Someone at Grasp, who is in the company's workspace to help. */
  grasp?: true;
}

/** What a company connected: where its people sign in, its HR platform, where its documents live, Pulse on its laptops, and the apps its work runs in. */
export const INTEGRATION_KINDS = [
  "signIn",
  "hr",
  "documents",
  "pulse",
  "app",
] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export interface Integration {
  id: string;
  name: string;
  kind: IntegrationKind;
  /** A file in /logos, when the app has one. */
  logo?: string;
  /** What Grasp may do there, in plain words. */
  access: string;
  /** Who at the company connected it: their job, or their name. */
  by: string;
  /** The day it was connected. */
  since: string;
  /** It stopped working until someone at the company signs in again. */
  again?: true;
  /** Pulse only: on how many of the company's laptops it runs. */
  laptops?: [installed: number, all: number];
}

/** Where a piece of work stands in the platform once Grasp is open, in the five words the company itself sees. */
export const RUN_STAGES = [
  "check",
  "agreed",
  "redesign",
  "testing",
  "live",
] as const;
export type RunStage = (typeof RUN_STAGES)[number];

export interface WorkRun {
  stage: RunStage;
  /** The share of the work's hours its redesign frees, 0 to 1: expected for a design, measured once it is live. */
  frees?: number;
  /** The day it went live. */
  since?: string;
}

/** Where one organization's onboarding stands: what Grasp did, what the client did, and the day. */
export interface OrgState {
  /** The first conversation: not there, brought in, or read by Stephen. */
  conversation: "none" | "in" | "read";
  research: "none" | "done";
  agreed: Agreed;
  client: ClientStep;
  /** Days since the team was told, from 0 to how many days its interviews run (`listenDays`). */
  day: number;
  rules: OrgRules;
  /** How each team gets its links, by team; a team not here keeps its own way. */
  channels: Record<string, Channel>;
  /** Differences the owner explained, by piece of work. */
  settled: string[];
  /** Interviews a person at Grasp has read, by interview. */
  read: string[];
  /** The first conversation as brought in or changed here; none keeps the organization's own. */
  transcript: string | null;
  /** What Stephen read in a transcript brought in here; none keeps the organization's own. */
  reading: VisionReading | null;
  /** What the sponsor answered afterwards, for what the conversation left open. */
  answers: Partial<Record<VisionField, string>>;
  /** The one reminder, sent by hand before it went by itself: the person, and the day. */
  reminded: Record<string, number>;
  /** Interviews deleted because the person asked for it. */
  deleted: string[];
  /** What the research found that disagrees with the company's own account, passed on to its admin, by source. */
  passed: ResearchSource[];
  /** Grasp opens once this share of what it needs is known, in percent. */
  threshold: number;
  /** Grasp gave its go for the company to come in: the day it did. None while the platform is closed to them. */
  opened: number | null;
  /** Workflows Grasp counts as known by hand, before the rules say so. */
  counted: string[];
  /** People who are away for the interviews: they get no link, and nothing waits for them. */
  away: string[];
  /** Teams that do not take part: nobody in them gets a link, and nothing waits for them. One can be asked in later. */
  left: string[];
  /** How Stephen is set up at this organization, as changed here; none keeps the organization's own. */
  stephen: StephenSetup | null;
  /** The parts of the platform as switched here; a part not here is as it starts. */
  parts: Partial<Record<PlatformPart, boolean>>;
  /** Grasp's own notes on this organization, the newest first. */
  notes: Note[];
  /** What Grasp corrected in the company's own details, the contract and who it deals with. */
  company: Partial<Company>;
  contract: Partial<Contract>;
  contacts: Partial<Record<ContactRole, Contact>>;
  /** The day each agreement was put in place here, for the ones that came in by hand. */
  papers: Partial<Record<keyof Agreed, string>>;
  /** People Grasp invited into the platform itself, on the company's request. */
  invited: Member[];
  /** What members may do, where Grasp changed it. */
  roles: Record<string, MemberRole>;
  /** Members whose access Grasp took away. */
  removed: string[];
  /** Invitations sent again, and the day. */
  resent: Record<string, string>;
  /** Integrations Grasp asked the company's admin to sign in to again, and the day. */
  asked: Record<string, string>;
}

/** How Stephen is set up at one organization. */
export interface StephenSetup {
  /** The languages he interviews in there, by locale. */
  languages: string[];
  /** What he leaves alone: teams, topics or work he does not ask about. */
  limits: string[];
  /** The words he has to know to hear them right: tools, products and the company's own terms. */
  terms: string[];
}

/** The parts of the platform a company can have: the first six are on when it opens, the last three are parked. */
export const PLATFORM_PARTS = [
  "chat",
  "dashboard",
  "brain",
  "engines",
  "workflows",
  "integrations",
  "inbox",
  "policies",
  "landscape",
] as const;
export type PlatformPart = (typeof PLATFORM_PARTS)[number];
export const PARKED_PARTS: PlatformPart[] = ["inbox", "policies", "landscape"];

/** Where every organization starts with what only Grasp does by hand: nothing yet. */
/** One of Grasp's own notes on an organization: what was written, and when. */
export interface Note {
  id: string;
  /** When it was written, as epoch milliseconds. */
  at: number;
  text: string;
}

/** Notes as they were kept: one text from before notes were a list becomes the first of the list. */
export const notesOf = (value?: unknown): Note[] => {
  if (typeof value === "string") {
    return value.trim() ? [{ id: "note-0", at: 0, text: value.trim() }] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (each: unknown): each is Note =>
      typeof each === "object" &&
      each !== null &&
      "id" in each &&
      typeof each.id === "string" &&
      "text" in each &&
      typeof each.text === "string" &&
      "at" in each &&
      typeof each.at === "number"
  );
};

export const NOTHING_BY_HAND: Omit<
  OrgState,
  "conversation" | "research" | "agreed" | "client" | "day" | "rules"
> = {
  channels: {},
  settled: [],
  read: [],
  transcript: null,
  reading: null,
  answers: {},
  reminded: {},
  deleted: [],
  passed: [],
  threshold: DEFAULT_THRESHOLD,
  opened: null,
  counted: [],
  away: [],
  left: [],
  stephen: null,
  parts: {},
  notes: [],
  company: {},
  contract: {},
  contacts: {},
  papers: {},
  invited: [],
  roles: {},
  removed: [],
  resent: {},
  asked: {},
};

/** An organization Grasp is onboarding. */
export interface Org {
  id: string;
  name: string;
  /** What it is, in a few words. */
  about: string;
  place: string;
  /** Who Grasp talks to there: a role, never a name. */
  sponsor: string;
  /** The day the team is told, and the team leads get their link. */
  start: string;
  /**
   * How many days its interviews run, as its plan has it: from five days to six weeks. The samples
   * leave it out and run the fourteen days they were written for (`listenDays`).
   */
  days?: number;
  teams: OrgTeam[];
  works: Work[];
  /** What the library expects of a team that turns out not to be done there. */
  dropped: { team: string; name: string; regulated?: true }[];
  /** The first conversation with the sponsor, word for word. */
  transcript: string;
  /** What Stephen read in it. */
  vision: VisionReading | null;
  research: Finding[];
  /** What companies like this usually run, from the library. */
  library: string;
  /** What Stephen knows before he says hello, a sentence a line. */
  brief: string[];
  /** What the company's admin skipped in its own onboarding: where the documents live, documents of its own, or Pulse on the laptops. */
  skipped?: ("sources" | "documents" | "pulse")[];
  /** How Stephen is set up there to begin with. */
  stephen: StephenSetup;
  /** A language people there need that Stephen does not speak yet, as it was said. */
  wanted?: string;
  /** The company as its papers have it, who Grasp deals with there, and the contract. */
  company: Company;
  contacts: Contact[];
  contract: Contract;
  /** The agreements that are signed, as they were signed. */
  papers: { processing?: Paper; assessment?: Paper; council?: Paper };
  /** Everyone invited into its platform. */
  members: Member[];
  /** What it connected, in its own onboarding and after. */
  integrations: Integration[];
  /** What an hour of its people's work costs, in euros, as its own finance team estimates it. */
  hourly: number;
  /** Where each piece of work stands in the platform, once Grasp is open; work that is not here was only heard. */
  running?: Record<string, WorkRun>;
  /** Where it starts. */
  seed: OrgState;
  /** Made here, in this browser: it has no people to play the interviews with. */
  made?: true;
  /** Onboarded for real: what really happened there, in place of the sample's dice (`org-adapter.ts`). */
  real?: RealHappened;
}

/**
 * What really happened at an organization Grasp onboards for real: its people, what their links
 * and interviews did, in days since the interviews started, and what each told about their work.
 * Where it is there, nothing is played.
 */
export interface RealHappened {
  people: Person[];
  timelines: Map<string, Timeline>;
  /** What each person told about the work they were asked about, by `person/work`. */
  told: Map<string, Telling>;
  /** The interviews there are, as they really went. */
  interviews: Interview[];
  /** The day each team's own links went out, by team. */
  sent: Map<string, number>;
  /** The day each team's lead agreed to their interview, by team; a team with no lead to wait for, the day its links went out. */
  heard: Map<string, number>;
  /** Who is in their interview right now. */
  talking: Set<string>;
  /** What was said in each interview and what Stephen wrote down, by person. */
  transcripts: Map<string, { lines: InterviewLine[]; facts: InterviewFact[] }>;
  /** Each person's own link, to send them, by person. */
  links: Map<string, string>;
  /** The company's own admin's link, which opens their onboarding. */
  clientCode: string;
  /** Made to try things out: it can be removed all at once. */
  test: boolean;
  /** Who does each piece of work, by work: as its lead named them, whatever each was asked about. */
  doers: Map<string, string[]>;
  /** The apps each piece of work is done in, by work, as the people who do it named them. */
  tools: Map<string, string[]>;
  /** The AI the Worker counted as it was used there: by day, what it was for and which model did it. Empty while nothing was counted. */
  metered: {
    day: string;
    purpose: "reading" | "interviews" | "drawing";
    /** `other` for a model the admin has no price for: its spend counts as nothing. */
    model: "opus" | "sonnet" | "haiku" | "voice" | "ears" | "other";
    use: {
      tokensIn: number;
      tokensOut: number;
      spoken: number;
      heard: number;
      spend: number;
    };
  }[];
  /**
   * How much Grasp knows, in percent, as the organization counts it itself: Grasp OS's core counts
   * it for its gate, from parts of its own, and that is the number the company sees. None where
   * the admin counts it from its own sources.
   */
  known?: number;
  /**
   * Grasp's staff paused the interviews: until they resume them nobody can open their link or
   * save what they said, as Grasp OS's core holds them. None where nothing pauses them.
   */
  paused?: boolean;
}

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(Math.max(value, min), max);
const smooth = (edge0: number, edge1: number, value: number) => {
  const x = clamp((value - edge0) / (edge1 - edge0));
  return x * x * (3 - 2 * x);
};

/** A number from 0 up to 1 that is always the same for the same words: the sample's dice. */
/* oxlint-disable no-bitwise, unicorn/prefer-code-point, operator-assignment -- a 32-bit string hash on UTF-16 units, as the prototype's: every sample number comes from it */
export const unit = (key: string): number => {
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  hash += 0x6d_2b_79_f5;
  let mixed = Math.imul(hash ^ (hash >>> 15), 1 | hash);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
};
/* oxlint-enable no-bitwise, unicorn/prefer-code-point, operator-assignment */

/**
 * How many days an organization's interviews run: its own plan's length, or the samples' fourteen.
 * Everything that asks when the links close, or how far the weeks are, asks this and never
 * `LISTEN_DAYS` itself, so a six-week plan does not close after two.
 */
export const listenDays = (org: Org): number => org.days ?? LISTEN_DAYS;

/** The date `day` days after the team was told. */
export const dateOn = (org: Org, day: number): string => {
  const date = new Date(`${org.start}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + day);
  return date.toISOString().slice(0, 10);
};

/** The day that is `count` working days after `day`: weekends do not count. */
export const workingDaysAfter = (
  org: Org,
  day: number,
  count: number
): number => {
  let at = day;
  let left = count;
  while (left > 0) {
    at += 1;
    const weekday = new Date(`${dateOn(org, at)}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      left -= 1;
    }
  }
  return at;
};

/** After this many working days, whoever has not finished gets one reminder. Then nothing. */
export const REMIND_AFTER = 3;

/** When in the weeks a team's lead talks, 0 to 1: one after another, the quiet team last. The same curve as `listeningAt`. */
const leadAt = (team: DirectoryTeam, index: number): number =>
  0.05 + index * 0.025 + (team.pace < 0.4 ? 0.28 : 0);

/**
 * The day a team's lead talks: their team's links go out the same day, to everyone on the lead's
 * list. Played for the samples only, over their fourteen days; a real organization's days come
 * from what really happened (`RealHappened`).
 */
export const leadDay = (team: DirectoryTeam, index: number): number =>
  Math.max(1, Math.ceil(leadAt(team, index) * LISTEN_DAYS - 1e-9));

/** How many of a team, the lead aside, have finished their interview by `day`. Played for the samples only, like `leadDay`. */
export const membersTalked = (
  team: DirectoryTeam,
  index: number,
  day: number
): number =>
  Math.round(
    (team.people - 1) *
      team.pace *
      smooth(leadAt(team, index) + 0.04, 1, clamp(day / LISTEN_DAYS))
  );

/** The first conversation as it stands: the one brought in here, or the organization's own. */
export const transcriptOf = (org: Org, state: OrgState): string =>
  state.transcript ?? org.transcript;

/**
 * What the first conversation brought, once Stephen has read it: his reading of the transcript
 * as it stands, with what the sponsor answered afterwards filled in. None before it is read.
 */
export const visionOf = (org: Org, state: OrgState): VisionReading | null => {
  if (state.conversation !== "read") {
    return null;
  }
  const read = state.reading ?? (state.transcript === null ? org.vision : null);
  if (!read) {
    return null;
  }
  const fields = { ...read.fields };
  const ask = { ...read.ask };
  for (const field of VISION_FIELDS) {
    const answer = state.answers[field]?.trim();
    if (present(answer) && fields[field] === undefined) {
      fields[field] = { text: answer, later: true };
      Reflect.deleteProperty(ask, field);
    }
  }
  return { ...read, fields, ask };
};

/** One thing said in a conversation that was written out: when, by whom, and the words. */
export interface SaidTurn {
  at: string;
  speaker: string;
  text: string;
}

/**
 * A transcript as its turns. A line that starts with a time, a name and a colon is a new turn; a
 * line without a name carries on the turn before it. Whatever shape it was written out in, no
 * word is left out.
 */
export const turnsOf = (transcript: string): SaidTurn[] => {
  const turns: SaidTurn[] = [];
  for (const line of transcript.split(/\r?\n/u)) {
    const said = line.trim();
    if (said === "") {
      continue;
    }
    const match =
      /^(?:[[(]?(?<at>\d{1,2}:\d{2}(?::\d{2})?)[\])]?\s*[-–]?\s*)?(?:(?<speaker>[^:]{1,48}):\s+)?(?<text>.*)$/u.exec(
        said
      );
    const at = match?.groups?.at ?? "";
    const speaker = match?.groups?.speaker?.trim() ?? "";
    const text = match?.groups?.text ?? said;
    const last = turns.at(-1);
    if (speaker === "" && at === "" && last) {
      last.text = `${last.text} ${text}`;
    } else {
      turns.push({ at, speaker, text });
    }
  }
  return turns;
};

const FIRST_NAMES = [
  "Lisa",
  "Tim",
  "Sanne",
  "Bram",
  "Emma",
  "Lars",
  "Sophie",
  "Jeroen",
  "Fleur",
  "Niels",
  "Anouk",
  "Rens",
  "Iris",
  "Stijn",
  "Lotte",
  "Koen",
  "Maud",
  "Thijs",
  "Eline",
  "Wouter",
  "Femke",
  "Sander",
  "Marit",
  "Jasper",
  "Noor",
  "Pieter",
  "Esmee",
  "Bas",
  "Julia",
  "Martijn",
  "Roos",
  "Dennis",
  "Laura",
  "Rik",
  "Mila",
  "Joris",
  "Tessa",
  "Maarten",
  "Vera",
  "Luuk",
  "Kim",
  "Hugo",
  "Britt",
  "Olaf",
  "Jet",
  "Daniël",
  "Carlijn",
  "Floris",
  "Hanna",
  "Wessel",
  "Yara",
  "Gijs",
  "Marieke",
];
const LAST_NAMES = [
  "de Vries",
  "Jansen",
  "van den Berg",
  "Bakker",
  "Visser",
  "Smit",
  "Meijer",
  "de Boer",
  "Mulder",
  "de Groot",
  "Bos",
  "Vos",
  "Peters",
  "Hendriks",
  "van Leeuwen",
  "Dekker",
  "Brouwer",
  "de Wit",
  "Dijkstra",
  "Smits",
  "de Graaf",
  "van der Meer",
  "van der Linden",
  "Kok",
  "Jacobs",
  "de Haan",
  "Vermeulen",
  "van den Heuvel",
  "van der Veen",
  "van den Broek",
  "de Bruijn",
  "Schouten",
  "van Beek",
  "Willems",
  "van Vliet",
  "Hoekstra",
  "Maas",
  "Verhoeven",
  "Koster",
  "van Dam",
  "Prins",
  "Blom",
  "Huisman",
  "Peeters",
  "de Jong",
  "Kuipers",
  "van Dijk",
];

/** Someone who works at the organization, as the sign-in and the HR platform have them. */
export interface Person {
  id: string;
  name: string;
  first: string;
  team: string;
  lead: boolean;
  /** The one piece of work Stephen asks them about, as their lead named it. A lead is asked about the whole team. */
  work: string | null;
}

const rosters = new WeakMap<Org, Person[]>();

const personOf = (
  team: OrgTeam,
  index: number,
  name: string,
  work: string | null
): Person => ({
  id: `${team.id}-${index}`,
  name,
  first: name.split(" ")[0] ?? name,
  team: team.id,
  lead: index === 0,
  work,
});

/** Which piece of work each of `members` people is asked about: by each work's share, spread so the first few do not all do the same. */
const routed = (members: number, works: Work[]): string[] => {
  if (works.length === 0) {
    return [];
  }
  const total = works.reduce((sum, work) => sum + work.share, 0);
  const exact = works.map((work) => (members * work.share) / total);
  const counts = exact.map((value) => Math.floor(value));
  let left = members - counts.reduce((sum, count) => sum + count, 0);
  const byRest = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .toSorted((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of byRest) {
    if (left <= 0) {
      break;
    }
    counts[index] = (counts[index] ?? 0) + 1;
    left -= 1;
  }
  return works
    .flatMap((work, index) =>
      Array.from({ length: counts[index] ?? 0 }, (_, place) => ({
        id: work.id,
        at: (place + 0.5) / (counts[index] ?? 0),
        index,
      }))
    )
    .toSorted((a, b) => a.at - b.at || a.index - b.index)
    .map((each) => each.id);
};

/** Everyone at the organization, team by team with the lead first. The same every time. */
export const peopleOf = (org: Org): Person[] => {
  if (org.real) {
    return org.real.people;
  }
  const kept = rosters.get(org);
  if (kept) {
    return kept;
  }
  const used = new Set(
    org.teams.flatMap((team) => [team.leader, ...(team.named ?? [])])
  );
  let drawn = 0;
  const draw = () => {
    for (;;) {
      const name = `${FIRST_NAMES[(drawn * 7 + 2) % FIRST_NAMES.length]} ${LAST_NAMES[(drawn * 5 + 1) % LAST_NAMES.length]}`;
      drawn += 1;
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
  };
  const roster = org.teams.flatMap((team) => {
    const works = routed(
      team.people - 1,
      org.works.filter((work) => work.team === team.id)
    );
    const members = Array.from({ length: team.people - 1 }, (_, index) =>
      personOf(
        team,
        index + 1,
        team.named?.[index] ?? draw(),
        works[index] ?? null
      )
    );
    return [personOf(team, 0, team.leader, null), ...members];
  });
  rosters.set(org, roster);
  return roster;
};

/** What happens to one person's link over the interviews, in days since the team was told. */
export interface Timeline {
  sent: number;
  opened: number | null;
  /** They stopped halfway: the day, and the part of the interview. */
  stopped: { day: number; phase: Phase } | null;
  /** The day they agreed to what was read back. */
  completed: number | null;
  reminded: number | null;
  /** Where they come in their team's order of talking. */
  order: number;
}

/** Where interviews that stop halfway stop, by part: most where the numbers are asked. */
const STOPS: [Phase, number][] = [
  ["anchor", 0.05],
  ["story", 0.15],
  ["steps", 0.2],
  ["exceptions", 0.2],
  ["numbers", 0.28],
  ["result", 0.12],
];

const stopPhase = (key: string): Phase => {
  let left = unit(`${key}/phase`);
  for (const [phase, share] of STOPS) {
    left -= share;
    if (left < 0) {
      return phase;
    }
  }
  return "numbers";
};

const timelines = new WeakMap<Org, Map<string, Timeline>>();

/**
 * Every person's two weeks. A lead talks on their team's day; the same day everyone on the
 * lead's list gets a link. As many of a team finish as its pace says, in an order of their own;
 * of the rest a few stop halfway, some open the link and leave it, and some never open it.
 * Whoever has not finished after three working days gets one reminder.
 */
export const timelinesOf = (org: Org): Map<string, Timeline> => {
  if (org.real) {
    return org.real.timelines;
  }
  const kept = timelines.get(org);
  if (kept) {
    return kept;
  }
  const all = new Map<string, Timeline>();
  const roster = peopleOf(org);
  // Only the samples are played, and they run the fourteen days their curve was written for.
  const last = LISTEN_DAYS - 1;
  const reminded = (sent: number, completed: number | null) => {
    const on = workingDaysAfter(org, sent, REMIND_AFTER);
    return on <= last && (completed === null || completed > on) ? on : null;
  };
  const key = (person: Person) => `${org.id}/${person.id}`;
  for (const [index, team] of org.teams.entries()) {
    const day = leadDay(team, index);
    const lead = roster.find(
      (person) => person.team === team.id && person.lead
    );
    if (lead) {
      // A quiet team's lead opens the link late, after the reminder.
      const opened = Math.max(
        0,
        day -
          (team.pace < 0.4 ? 1 : Math.floor(unit(`${key(lead)}/opened`) * 2))
      );
      all.set(lead.id, {
        sent: 0,
        opened,
        stopped: null,
        completed: day,
        reminded: reminded(0, day),
        order: 0,
      });
    }
    // Whoever is named in the sample talks first; the rest in an order of their own.
    const turn = (person: Person) =>
      team.named?.includes(person.name) === true
        ? team.named.indexOf(person.name) - team.named.length
        : unit(`${key(person)}/order`);
    const members = roster
      .filter((person) => person.team === team.id && !person.lead)
      .toSorted((a, b) => turn(a) - turn(b));
    const talks = membersTalked(team, index, LISTEN_DAYS);
    const stoppers = Math.round((team.people - 1 - talks) * 0.18);
    for (const [place, person] of members.entries()) {
      const own = key(person);
      if (place < talks) {
        let completed = LISTEN_DAYS;
        for (let at = 1; at <= LISTEN_DAYS; at += 1) {
          if (membersTalked(team, index, at) >= place + 1) {
            completed = at;
            break;
          }
        }
        completed = Math.max(completed, day);
        const opened = Math.max(
          day,
          completed - Math.floor(unit(`${own}/opened`) * 3)
        );
        // Some stop once and come back to finish: the link carries on where they were.
        const paused = unit(`${own}/paused`) < 0.15 && completed > opened;
        const stopped = paused
          ? {
              day: Math.max(
                opened,
                completed - 1 - Math.floor(unit(`${own}/pause`) * 2)
              ),
              phase: stopPhase(own),
            }
          : null;
        all.set(person.id, {
          sent: day,
          opened,
          stopped,
          completed,
          reminded: reminded(day, completed),
          order: place + 1,
        });
      } else if (place < talks + stoppers) {
        const opened = Math.min(
          last,
          day + Math.floor(unit(`${own}/opened`) * 7)
        );
        const stopped = {
          day: Math.min(last, opened + Math.floor(unit(`${own}/stopped`) * 2)),
          phase: stopPhase(own),
        };
        all.set(person.id, {
          sent: day,
          opened,
          stopped,
          completed: null,
          reminded: reminded(day, null),
          order: place + 1,
        });
      } else {
        const opened =
          unit(`${own}/opens`) < 0.55
            ? Math.min(last, day + Math.floor(unit(`${own}/opened`) * 9))
            : null;
        all.set(person.id, {
          sent: day,
          opened,
          stopped: null,
          completed: null,
          reminded: reminded(day, null),
          order: place + 1,
        });
      }
    }
  }
  timelines.set(org, all);
  return all;
};

/** Where someone stands, as Grasp sees it: the company's six states; before those, no link yet; and away, for whom nothing waits. */
export type LinkState = PersonState | "waiting" | "away";
export const LINK_STATES: LinkState[] = [
  "waiting",
  "invited",
  "opened",
  "progress",
  "incomplete",
  "completed",
  "expired",
  "away",
];

/** One person on one day. */
export interface PersonView {
  person: Person;
  state: LinkState;
  channel: Channel;
  /** The days things happened, as far as they have by now. */
  sent: number | null;
  opened: number | null;
  reminded: number | null;
  /** The reminder was sent by hand, before it went by itself. */
  byHand: boolean;
  /** Still without a reminder, and not finished: the one reminder can go now. */
  mayRemind: boolean;
  completed: number | null;
  /** They asked for their interview to be deleted: its words and what only they said are gone. */
  deleted: boolean;
  /** Their team does not take part: they get no link. What one of them said before that stays said. */
  out: boolean;
  /** The part they stopped in, while they are stopped. */
  stoppedAt: Phase | null;
  /** The last thing that happened, and when. */
  last: {
    what: "sent" | "opened" | "reminded" | "stopped" | "completed";
    day: number;
  } | null;
}

const stateOn = (
  timeline: Timeline,
  day: number,
  talking: boolean,
  days: number
): LinkState => {
  if (day < timeline.sent) {
    return "waiting";
  }
  if (timeline.completed !== null && timeline.completed <= day) {
    return "completed";
  }
  if (day >= days) {
    return timeline.stopped ? "incomplete" : "expired";
  }
  if (talking) {
    return "progress";
  }
  if (timeline.stopped && timeline.stopped.day <= day) {
    return "incomplete";
  }
  if (timeline.opened !== null && timeline.opened <= day) {
    return "opened";
  }
  return "invited";
};

/** At most this many of a team are in their interview at the same moment. */
const TALKING = 2;

/** What each interview fills in, by what was said: the record's fifteen fields. */
const FIELDS: [RecordField, (telling: Telling) => boolean][] = [
  ["trigger", (telling) => telling.start],
  ["done", (telling) => telling.end],
  ["steps", (telling) => telling.steps.length > 0],
  ["handoffs", (telling) => telling.next],
  ["waits", (telling) => telling.waits.length > 0],
  ["exceptions", (telling) => telling.differently.length > 0],
  ["decisions", (telling) => telling.decides],
  ["workarounds", (telling) => telling.own || telling.ai],
  ["volume", (telling) => telling.volume !== null],
  ["time", (telling) => telling.takes !== null],
  ["rework", (telling) => telling.wrong !== null],
  ["result", (telling) => telling.right || telling.ask],
  ["cases", (telling) => telling.example !== null],
  ["terms", (telling) => telling.term],
  ["next", (telling) => telling.next],
];

/** What one person said about their work: which parts of it, in their own numbers. */
export interface Telling {
  start: boolean;
  /** The steps they described, by position. */
  steps: number[];
  /** They described the last step: what counts as finished. */
  end: boolean;
  /** The step people describe two ways, when they described it: as most do, or the other way. */
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
  /** The file they shared as an example, by name. */
  example: string | null;
  term: boolean;
  /** What they took out again when it was read back, by fact. */
  out: string[];
}

/** The parts of an interview in which each thing is said: an interview that stopped has only what came before. */
const SAID_IN: Record<string, Phase> = {
  start: "story",
  step: "story",
  term: "story",
  wait: "steps",
  next: "steps",
  differently: "exceptions",
  decides: "exceptions",
  own: "exceptions",
  ai: "exceptions",
  volume: "numbers",
  takes: "numbers",
  wrong: "numbers",
  right: "result",
  ask: "result",
  example: "result",
};

/** Whether what is said in `part` was said before an interview stopped in `stoppedAt`. */
export const saidBefore = (part: string, stoppedAt: Phase | null): boolean => {
  if (stoppedAt === null) {
    return true;
  }
  const [kind = ""] = part.split(":");
  return PHASES.indexOf(SAID_IN[kind] ?? "story") < PHASES.indexOf(stoppedAt);
};

/** What someone told about a piece of work they did not talk about: nothing. */
export const NOTHING_TOLD: Telling = {
  start: false,
  steps: [],
  end: false,
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
};

/**
 * What was written down from what someone said, fact by fact, in the order of the interview; with
 * `stoppedAt`, only what came before they stopped. A fact is named by what it is about, so the
 * same step from two people is the same fact.
 */
export const factsSaid = (
  telling: Telling,
  stoppedAt: Phase | null
): string[] => {
  const all = [
    ...(telling.start ? ["start"] : []),
    // The other way of doing a step is a fact of its own, new the first time someone tells it.
    ...telling.steps.map((index) =>
      telling.way?.other === true && telling.way.step === index
        ? `step:${index}/other`
        : `step:${index}`
    ),
    ...(telling.term ? ["term"] : []),
    ...telling.waits.map((index) => `wait:${index}`),
    ...(telling.next ? ["next"] : []),
    ...telling.differently.map((index) => `differently:${index}`),
    ...(telling.decides ? ["decides"] : []),
    ...(telling.own ? ["own"] : []),
    ...(telling.ai ? ["ai"] : []),
    ...(telling.volume ? ["volume"] : []),
    ...(telling.takes ? ["takes"] : []),
    ...(telling.wrong === null ? [] : ["wrong"]),
    ...(telling.right ? ["right"] : []),
    ...(telling.ask ? ["ask"] : []),
    ...(present(telling.example) ? ["example"] : []),
  ];
  return all.filter((fact) => saidBefore(fact, stoppedAt));
};

const jitter = (value: number, key: string, spread = 0.2) =>
  Math.max(1, Math.round(value * (1 - spread + unit(key) * spread * 2)));

/** What `person` says about `work`: most of it, never all, and their own version of the numbers. */
// oxlint-disable-next-line complexity -- ported as the prototype has it, one part of a telling after another; the sample's numbers come from it
export const tellingOf = (org: Org, person: Person, work: Work): Telling => {
  if (org.real) {
    return org.real.told.get(`${person.id}/${work.id}`) ?? NOTHING_TOLD;
  }
  const key = `${org.id}/${person.id}/${work.id}`;
  const says = (what: string, chance: number) =>
    unit(`${key}/${what}`) < chance;
  const steps = work.steps.flatMap((_, index) =>
    says(`step:${index}`, index === 0 ? 0.96 : 0.86) ? [index] : []
  );
  const { differs } = work;
  // Of the people who do it, every third tells the step that goes two ways the other way.
  const other =
    peopleOf(org)
      .filter((each) => each.work === work.id)
      .indexOf(person) %
      3 ===
    1;
  const telling: Telling = {
    start: says("start", 0.95),
    steps,
    end: steps.includes(work.steps.length - 1),
    way:
      differs && steps.includes(differs.step)
        ? { step: differs.step, other }
        : null,
    waits: (work.waits ?? []).flatMap((_, index) =>
      says(`wait:${index}`, 0.7) ? [index] : []
    ),
    differently: (work.differently ?? []).flatMap((_, index) =>
      says(`differently:${index}`, 0.55) ? [index] : []
    ),
    decides: work.decides !== undefined && says("decides", 0.6),
    own: work.own !== undefined && says("own", 0.55),
    ai: work.ai !== undefined && says("ai", 0.3),
    volume: says("volume", 0.95)
      ? [
          jitter(work.volume[0], `${key}/quiet`),
          jitter(work.volume[1], `${key}/busy`),
        ]
      : null,
    takes: says("takes", 0.9)
      ? [
          jitter(work.takes[0], `${key}/least`),
          jitter(work.takes[1], `${key}/normal`),
          jitter(work.takes[2], `${key}/most`),
        ]
      : null,
    wrong: says("wrong", 0.7)
      ? Math.min(
          9,
          Math.max(0, work.wrong + Math.round(unit(`${key}/wrongs`) * 2 - 1))
        )
      : null,
    right: says("right", 0.86),
    ask: work.ask !== undefined && says("ask", 0.7),
    next: says("next", 0.9),
    example: says("example", 0.3)
      ? `${work.item[0].replaceAll(" ", "-")}-${100 + Math.floor(unit(`${key}/file`) * 900)}.${says("pdf", 0.5) ? "pdf" : "png"}`
      : null,
    term: work.term !== undefined && says("term", 0.35),
    out: [],
  };
  // A busy week is never quieter than a quiet one, and the longest never shorter than a normal one.
  if (telling.volume) {
    telling.volume[1] = Math.max(telling.volume[1], telling.volume[0]);
  }
  if (telling.takes) {
    // SAFETY: three numbers sorted are three numbers.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    telling.takes = telling.takes.toSorted((a, b) => a - b) as [
      number,
      number,
      number,
    ];
  }
  // Now and then someone takes a line out again when it is read back.
  const said = factsSaid(telling, null);
  const taken = said[Math.floor(unit(`${key}/outs`) * said.length)];
  if (says("out", 0.12) && said.length > 3 && taken !== undefined) {
    telling.out = [taken];
  }
  return telling;
};

/** The fields of the record what someone told fills in. */
export const filledBy = (telling: Telling): RecordField[] =>
  FIELDS.filter(([, has]) => has(telling)).map(([field]) => field);

/** One interview: finished and agreed to, or stopped halfway. */
export interface Interview {
  /** The person's own: one link, one interview. */
  id: string;
  person: Person;
  kind: "lead" | "employee";
  work: Work | null;
  /** The day it was agreed to, or the day it stopped. */
  day: number;
  /** Read back and agreed to: only then its facts count. */
  approved: boolean;
  stoppedAt: Phase | null;
  /** How long it took; unknown where they came back after leaving, since the time away was not talking. */
  minutes: number | null;
  typed: boolean;
  telling: Telling | null;
  /** The review afterwards: the fields it filled, the facts written down, how many the person took out, and Stephen's own mistakes. */
  filled: RecordField[];
  facts: number;
  out: number;
  mistakes: number;
  /** What kind each of those mistakes was. */
  kinds: MistakeKind[];
  /** What they could not say when asked: each becomes a question for the next person. */
  followUps: number;
  /** One in five is read by a person at Grasp. */
  toRead: boolean;
  /** How the person found talking to Stephen, from 1 to 5; none when they did not say. */
  rating: number | null;
  /** Who held it: whoever the person chose on the way in, and Stephen where there was no choice yet. */
  interviewer: Interviewer;
}

/** The kinds of mistake an interviewer makes, as the review scores them. */
export type MistakeKind = keyof typeof MISTAKES;
// SAFETY: the keys of `MISTAKES`, which `MistakeKind` is.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const MISTAKE_KINDS = Object.keys(MISTAKES) as MistakeKind[];
const ALL_MISTAKES = MISTAKE_KINDS.reduce(
  (sum, kind) => sum + MISTAKES[kind],
  0
);

/** A kind of mistake, as often as that kind has ways to go wrong. */
const mistakeKind = (key: string): MistakeKind => {
  let left = unit(key) * ALL_MISTAKES;
  for (const kind of MISTAKE_KINDS) {
    left -= MISTAKES[kind];
    if (left < 0) {
      return kind;
    }
  }
  return "formulation";
};

/** What Grasp did by hand that changes who talks and what counts: nothing, unless given. */
export type ByHand = Partial<
  Pick<OrgState, "rules" | "settled" | "deleted" | "away" | "counted">
>;

/** One in this many reviews is read by a person at Grasp. */
export const READ_ONE_IN = 5;

/** For this many days after an interview, the person can ask for it to be deleted. */
export const DELETE_DAYS = 7;

/** How the people of a sample rate their interview: two in three say so, most of them well. */
const RATED: [rating: number, share: number][] = [
  [5, 0.42],
  [4, 0.36],
  [3, 0.14],
  [2, 0.06],
  [1, 0.02],
];

const ratingOf = (key: string): number | null => {
  if (unit(`${key}/rates`) >= 0.66) {
    return null;
  }
  let left = unit(`${key}/rating`);
  for (const [rating, share] of RATED) {
    left -= share;
    if (left < 0) {
      return rating;
    }
  }
  return 4;
};

/** A lead's interview brings the team's work, with how much of it there is and who to ask first. */
const leadFacts = (org: Org, person: Person): number =>
  org.works.filter((work) => work.team === person.team).length * 2;

/** Which fields of the record a fact fills in. */
const fieldsOf = (fact: string): RecordField[] => {
  const [what = ""] = fact.split(":");
  const fields: Record<string, RecordField[]> = {
    start: ["trigger"],
    step: ["steps", "done"],
    term: ["terms"],
    wait: ["waits"],
    next: ["handoffs", "next"],
    differently: ["exceptions"],
    decides: ["decisions"],
    own: ["workarounds"],
    ai: ["workarounds"],
    volume: ["volume"],
    takes: ["time"],
    wrong: ["rework"],
    right: ["result"],
    ask: ["result"],
    example: ["cases"],
  };
  return fields[what] ?? [];
};

/** How many mistakes an interview has, as the dice fall: most none, a few several. */
const mistakesOf = (dice: number): number => {
  if (dice < 0.55) {
    return 0;
  }
  if (dice < 0.86) {
    return 1;
  }
  return dice < 0.97 ? 2 : 3;
};

/** How long an interview took: a lead's longer, one that stopped by how far it got. */
const minutesOf = (
  key: string,
  person: Person,
  approved: boolean,
  stoppedAt: Phase | null
): number => {
  if (!approved) {
    return 2 + PHASES.indexOf(stoppedAt ?? "story") * 2;
  }
  return person.lead
    ? 26 + Math.floor(unit(`${key}/minutes`) * 9)
    : 9 + Math.floor(unit(`${key}/minutes`) * 8);
};

/** The interviews there are by `day`, newest first: the ones agreed to, and the ones that stopped and were not picked up again yet. */
export const interviewsAt = (
  org: Org,
  day: number,
  { deleted = [], away = [] }: ByHand = {}
): Interview[] => {
  if (org.real) {
    return org.real.interviews.filter(
      (interview) =>
        interview.day <= day &&
        !deleted.includes(interview.id) &&
        !away.includes(interview.id)
    );
  }
  const lines = timelinesOf(org);
  const teamOf = new Map(org.teams.map((team, index) => [team.id, index]));
  // oxlint-disable-next-line complexity -- ported as the prototype has it, one interview with everything it brought; the sample's numbers come from it
  const found = peopleOf(org).flatMap((person): Interview[] => {
    const timeline = lines.get(person.id);
    if (!timeline || deleted.includes(person.id) || away.includes(person.id)) {
      return [];
    }
    const approved = timeline.completed !== null && timeline.completed <= day;
    const stopped =
      !approved && timeline.stopped !== null && timeline.stopped.day <= day;
    if (!approved && !stopped) {
      return [];
    }
    const key = `${org.id}/${person.id}`;
    const work = org.works.find((each) => each.id === person.work) ?? null;
    const stoppedAt = approved ? null : (timeline.stopped?.phase ?? null);
    const telling = work ? tellingOf(org, person, work) : null;
    const said = telling ? factsSaid(telling, stoppedAt) : [];
    const dice = unit(`${key}/mistakes`);
    const mistakes = mistakesOf(dice);
    // What they were asked and could not say: how many, how long, how often it comes in wrong, who gets it next.
    const unsaid = telling
      ? (
          [
            ["volume", telling.volume === null],
            ["takes", telling.takes === null],
            ["wrong", telling.wrong === null],
            ["next", !telling.next],
          ] as const
        ).filter(([part, open]) => open && saidBefore(part, stoppedAt)).length
      : 0;
    return [
      {
        id: person.id,
        person,
        kind: person.lead ? "lead" : "employee",
        work,
        day: approved
          ? (timeline.completed ?? day)
          : (timeline.stopped?.day ?? day),
        approved,
        stoppedAt,
        minutes: minutesOf(key, person, approved, stoppedAt),
        typed: unit(`${key}/typed`) < 0.3,
        telling,
        filled: telling
          ? FIELDS.filter(
              ([field, has]) =>
                has(telling) &&
                said.some((fact) => fieldsOf(fact).includes(field))
            ).map(([field]) => field)
          : [],
        facts: person.lead ? leadFacts(org, person) : said.length,
        out: approved && telling ? telling.out.length : 0,
        mistakes,
        kinds: Array.from({ length: mistakes }, (_, at) =>
          mistakeKind(`${key}/mistake:${at}`)
        ),
        followUps: approved ? unsaid : 0,
        toRead: false,
        rating: approved ? ratingOf(key) : null,
        // A sample's people choose as its dice fall: a little under half of them Claire.
        interviewer: unit(`${key}/interviewer`) < 0.46 ? "claire" : "stephen",
      },
    ];
  });
  // One in five of the finished ones is read by a person, in the order they came in.
  const finished = found
    .filter((interview) => interview.approved)
    .toSorted(
      (a, b) =>
        a.day - b.day ||
        (teamOf.get(a.person.team) ?? 0) - (teamOf.get(b.person.team) ?? 0)
    );
  for (const [index, interview] of finished.entries()) {
    interview.toRead = index % READ_ONE_IN === 0;
  }
  return found.toSorted(
    (a, b) =>
      b.day - a.day ||
      (teamOf.get(a.person.team) ?? 0) - (teamOf.get(b.person.team) ?? 0)
  );
};

/** How far one piece of work is known, under the organization's own rules. */
export interface WorkEvidence extends WorkflowEvidence {
  work: Work;
  /** How many people do this work. */
  doers: number;
  /** Fewer people do it than the rules ask interviews for: then all of them count. */
  small: boolean;
  /** Everyone who does it has talked: nobody is left to ask. */
  everyone: boolean;
  state: WorkflowState;
  /** So many interviews without settling that it is better split in two. */
  split: boolean;
  /** People describe a step two ways, and both were heard. */
  differs: boolean;
  /** Grasp counts it as known by hand, before the rules say so. */
  byHand: boolean;
}

/** The rules as they hold for one piece of work: where fewer people do it than the rules ask for, all of them count. */
export const rulesFor = (rules: OrgRules, doers: number): OrgRules => ({
  ...rules,
  people: Math.max(1, Math.min(rules.people, doers)),
  minInterviews: Math.max(1, Math.min(rules.minInterviews, doers)),
});

/**
 * How far each piece of work is known by `day`: every team whose lead has talked, with what its
 * agreed interviews add up to. A step counts once enough people who do the work described it, or
 * one fewer and a document. The share of new facts is taken over the last few interviews.
 */
export const evidenceAt = (
  org: Org,
  day: number,
  {
    rules = org.seed.rules,
    settled = [],
    deleted = [],
    away = [],
    counted = [],
  }: ByHand = {}
): WorkEvidence[] => {
  const lines = timelinesOf(org);
  const roster = peopleOf(org);
  // oxlint-disable-next-line complexity -- ported as the prototype has it, one piece of work under the organization's rules; the sample's numbers come from it
  return org.works.flatMap((work): WorkEvidence[] => {
    const index = org.teams.findIndex((team) => team.id === work.team);
    const team = org.teams[index];
    // A real team's work is there once its lead talked; a sample's once its lead's day has come.
    if (team === undefined || (!org.real && leadDay(team, index) > day)) {
      return [];
    }
    // Whoever is away these weeks is not waited for: the work is known from the others.
    const doing = org.real?.doers.get(work.id);
    const doers = roster.filter(
      (person) =>
        (doing ? doing.includes(person.id) : person.work === work.id) &&
        !away.includes(person.id)
    );
    // An interview deleted on request counts for nothing: what only that person said is gone with it.
    const talked = doers
      .filter(
        (person) =>
          // Someone who has not finished never counts, however long the interviews run.
          (lines.get(person.id)?.completed ?? Number.POSITIVE_INFINITY) <=
            day && !deleted.includes(person.id)
      )
      .toSorted(
        (a, b) =>
          (lines.get(a.id)?.completed ?? 0) -
            (lines.get(b.id)?.completed ?? 0) ||
          (lines.get(a.id)?.order ?? 0) - (lines.get(b.id)?.order ?? 0)
      );
    const own = rulesFor(rules, doers.length);
    const known = new Set<string>();
    const described = work.steps.map(() => 0);
    const ways = new Set<number>();
    const added: { fresh: number; all: number }[] = [];
    for (const person of talked) {
      const telling = tellingOf(org, person, work);
      const facts = factsSaid(telling, null).filter(
        (fact) => !telling.out.includes(fact)
      );
      added.push({
        fresh: facts.filter((fact) => !known.has(fact)).length,
        all: facts.length,
      });
      for (const fact of facts) {
        known.add(fact);
        if (fact.startsWith("step:")) {
          // "step:2", or "step:2/other" for the other way of doing it.
          const [number = ""] = fact.slice(5).split("/");
          const step = Number(number);
          described[step] = (described[step] ?? 0) + 1;
        }
      }
      // Which way they told the step that goes two ways, unless they took it out again.
      if (
        telling.way &&
        facts.includes(
          telling.way.other
            ? `step:${telling.way.step}/other`
            : `step:${telling.way.step}`
        )
      ) {
        ways.add(telling.way.other ? 1 : 0);
      }
    }
    const recent = added.slice(-own.run);
    const said = recent.reduce((sum, each) => sum + each.all, 0);
    const differs = ways.size === 2;
    const explained =
      work.differs?.why !== "conflict" || settled.includes(work.id);
    // Once everyone who does the work has talked, nobody is left to ask: what one of them described counts. Not when only the
    // lead told it, in their interview about the whole team: that is an overview, and Grasp counts it as known by hand.
    const everyone =
      doers.length > 0 &&
      talked.length >= doers.length &&
      !talked.every((person) => person.lead);
    const needed = everyone ? 1 : own.people;
    const evidence: WorkflowEvidence = {
      id: work.id,
      team: work.team,
      approved: talked.length,
      lastNew:
        said === 0
          ? 1
          : recent.reduce((sum, each) => sum + each.fresh, 0) / said,
      steps: work.steps.length,
      evidenced: described.filter(
        (count, step) =>
          count >= needed ||
          (count >= 1 &&
            count >= needed - 1 &&
            (work.documented ?? []).includes(step))
      ).length,
      variants: differs && explained ? 1 : 0,
      unexplained: differs && !explained ? 1 : 0,
    };
    // With nobody left to ask, more interviews cannot add facts: the workflow is as known as it gets. Without a step drawn it is not known at all.
    let byRules: WorkflowState = "mapping";
    if (work.steps.length > 0) {
      byRules = everyone
        ? workflowState({ ...evidence, lastNew: 0 }, own)
        : workflowState(evidence, own);
    }
    // Counted as known by hand: that holds, unless people differ and nobody can say why.
    const byHand =
      counted.includes(work.id) &&
      byRules !== "complete" &&
      byRules !== "variants" &&
      byRules !== "blocked";
    let state = byRules;
    if (byHand) {
      state = evidence.variants > 0 ? "variants" : "complete";
    }
    return [
      {
        ...evidence,
        work,
        doers: doers.length,
        small: doers.length < rules.minInterviews,
        everyone,
        state,
        split: !byHand && !everyone && needsSplit(evidence, own),
        differs,
        byHand,
      },
    ];
  });
};

/** What a team probably does, until an interview confirms it or shows it is not so. */
export interface TeamHypothesis {
  name: string;
  state: HypothesisState;
  regulated: boolean;
  /** Not in the library: the lead or an interview brought it. */
  found: boolean;
}

/** A team's hypotheses on `day`: what the library expects, confirmed by the first agreed interview or dropped when the lead does not name it; and what the lead named that the library did not expect. */
export const hypothesesOf = (
  org: Org,
  team: OrgTeam,
  day: number,
  told: boolean
): TeamHypothesis[] => {
  const index = org.teams.indexOf(team);
  const leadTalked =
    told &&
    (org.real ? org.real.heard.has(team.id) : leadDay(team, index) <= day);
  const known = told ? evidenceAt(org, day) : [];
  const works = org.works
    .filter((work) => work.team === team.id)
    .flatMap((work): TeamHypothesis[] => {
      if (work.found && !leadTalked) {
        return [];
      }
      const approved = known.find((each) => each.id === work.id)?.approved ?? 0;
      return [
        {
          name: work.name,
          state: approved > 0 ? "confirmed" : "hypothesis",
          regulated: work.regulated === true,
          found: work.found === true,
        },
      ];
    });
  const dropped = org.dropped
    .filter((each) => each.team === team.id)
    .map((each): TeamHypothesis => ({
      name: each.name,
      state: leadTalked ? "dropped" : "hypothesis",
      regulated: each.regulated === true,
      found: false,
    }));
  return [...works, ...dropped];
};

/** What still has to happen for a team before anything else. */
export type TeamNext =
  /** The team does not take part. */
  | { kind: "off" }
  | { kind: "lead-unknown" }
  | { kind: "not-told" }
  /** The lead has not talked yet, so the team has no links. */
  | { kind: "lead"; reminded: boolean }
  | { kind: "talking"; left: number }
  | { kind: "closed"; missed: number }
  | { kind: "done" };

/** One team on one day. */
export interface TeamView {
  team: OrgTeam;
  /** It does not take part: nobody in it gets a link, and nothing counts on it. */
  off: boolean;
  /** The lead, once the HR platform names them. */
  lead: PersonView | null;
  /** Everyone in it, the lead first. */
  people: PersonView[];
  counts: Record<LinkState, number>;
  /** How many of them are asked to talk: everyone but who is away, and nobody when the team does not take part. */
  asked: number;
  /** The day the team's own links went out. */
  sent: number | null;
  /** The day the team's lead was heard: at a real organization their links can go out without them. */
  heard: number | null;
  works: WorkEvidence[];
  next: TeamNext;
}

/** The steps an organization goes through, from the first conversation until Grasp opens. */
export const STAGES = [
  "conversation",
  "research",
  "agreed",
  "connected",
  "leads",
  "interviews",
  "open",
] as const;
export type Stage = (typeof STAGES)[number];
/** Done; in Grasp's hands now; waiting on someone else; or not yet. */
export type StageStatus = "done" | "now" | "waits" | "later";

/** Something that needs a person at Grasp. */
export type Need =
  /** Grasp's staff paused the interviews: nobody can open or finish theirs until Grasp resumes them. */
  | { kind: "paused" }
  | { kind: "transcript" }
  | { kind: "ask"; fields: VisionField[] }
  | { kind: "research" }
  | { kind: "conflict"; source: ResearchSource; text: string }
  | { kind: "agreement"; what: keyof Agreed }
  | { kind: "lead"; team: OrgTeam; lead: string }
  | { kind: "quiet"; team: OrgTeam; talked: number; left: number }
  | { kind: "blocked"; work: Work }
  | { kind: "split"; work: Work; lead: string }
  | { kind: "few"; works: WorkEvidence[] }
  | { kind: "read"; count: number }
  /** Enough is known: the company can come in once Grasp gives its go. */
  | { kind: "go"; percent: number; threshold: number }
  /** The interviews are over and too little is known: Grasp decides whether to open anyway. */
  | { kind: "short"; percent: number; threshold: number }
  /** The contract is not signed yet: still being written, or sent on that day. */
  | { kind: "contract"; sent: string | null }
  /** The contract ends soon and nothing is agreed for after. */
  | { kind: "ending"; until: string; days: number }
  /** An integration stopped until someone at the company signs in again. */
  | { kind: "signin"; integration: Integration }
  /** More AI was used in a month than the contract covers, in euros. */
  | { kind: "budget"; month: string; spend: number; included: number };

/** Where what Grasp knows about an organization comes from: the same sources, with the same weights, as the company's own onboarding counts. */
export const KNOWLEDGE_SOURCES = [
  "vision",
  "directory",
  "sources",
  "documents",
  "pulse",
  "leadsKnown",
  "leadsHeard",
  "everyoneHeard",
  "review",
] as const;
export type KnowledgeSource = (typeof KNOWLEDGE_SOURCES)[number];

/**
 * How much of what it needs Grasp knows about an organization, and whether that is enough to
 * open. The company sees the same percentage in its own onboarding, and its platform stays
 * closed until Grasp gives its go.
 */
export interface OrgKnowledge {
  /** Each source: how much it can add, in percent, how much of that is in, 0 to 1, and the whole points that makes. */
  sources: {
    source: KnowledgeSource;
    weight: number;
    known: number;
    points: number;
  }[];
  /**
   * The points of every source together: a point counts only once it is wholly in. Where the
   * organization counts it itself (`RealHappened.known`), its number, and no sources.
   */
  percent: number;
  threshold: number;
  /** Enough is known: it waits only for Grasp's go. */
  ready: boolean;
  /** The day Grasp gave its go; none while it is closed. */
  opened: number | null;
}

/** One organization on one day: everything the admin shows. */
export interface OrgView {
  org: Org;
  state: OrgState;
  /** The team was told, so links are out and the days count. */
  told: boolean;
  day: number;
  /** The interviews are over: the link has closed. */
  closed: boolean;
  /** The first conversation, word for word, as it stands. */
  transcript: string;
  /** What it brought, once Stephen has read it. */
  vision: VisionReading | null;
  /** Everyone, once the sign-in is connected. */
  people: PersonView[];
  teams: TeamView[];
  counts: Record<LinkState, number>;
  /** How many people are asked to talk: everyone but who is away or in a team that does not take part. */
  asked: number;
  interviews: Interview[];
  works: WorkEvidence[];
  knowledge: OrgKnowledge;
  stages: Record<Stage, StageStatus>;
  /** The first step that is not done. */
  stage: Stage;
  needs: Need[];
}

/** Something is in or it is not. */
const whether = (is: boolean) => (is ? 1 : 0);
/** So many of so many, 0 to 1; nothing of nothing is nothing. */
const share = (count: number, of: number) => (of === 0 ? 0 : count / of);

const noCounts = (): Record<LinkState, number> => ({
  waiting: 0,
  invited: 0,
  opened: 0,
  progress: 0,
  incomplete: 0,
  completed: 0,
  expired: 0,
  away: 0,
});

/**
 * A team counts as quiet when the link closes within this many days of the samples' fourteen and
 * fewer than this share has talked. A shorter plan has a window as much shorter (`quietDays`).
 */
const QUIET_DAYS = 4;
const QUIET_SHARE = 0.3;

/** How many pieces of work count as known: complete, in one way or in more. */
export const knownWorks = (works: WorkEvidence[]): number =>
  works.filter((work) => work.state === "complete" || work.state === "variants")
    .length;

/** What a team waits for next. */
const nextOf = ({
  off,
  leadsKnown,
  told,
  closed,
  sent,
  waiting,
  lead,
}: {
  off: boolean;
  leadsKnown: boolean;
  told: boolean;
  closed: boolean;
  sent: number | null;
  waiting: number;
  lead: PersonView | null;
}): TeamNext => {
  if (off) {
    return { kind: "off" };
  }
  if (!leadsKnown) {
    return { kind: "lead-unknown" };
  }
  if (!told) {
    return { kind: "not-told" };
  }
  if (sent === null) {
    return {
      kind: "lead",
      reminded: lead?.reminded !== null && lead?.reminded !== undefined,
    };
  }
  if (waiting === 0) {
    return { kind: "done" };
  }
  return closed
    ? { kind: "closed", missed: waiting }
    : { kind: "talking", left: waiting };
};

/** For an organization made here the research is not run: it never stands in the way. */
const researchStage = (
  org: Org,
  state: OrgState,
  read: boolean
): StageStatus => {
  if (state.research === "done") {
    return "done";
  }
  return read && !org.made && !org.real ? "now" : "later";
};

/** A real organization's links do not open before everything is agreed, first conversation or not. */
const agreedStage = (
  org: Org,
  state: OrgState,
  read: boolean,
  invited: boolean
): StageStatus => {
  if (invited) {
    return "done";
  }
  if (!read && !org.real) {
    return "later";
  }
  return state.agreed.processing && state.agreed.assessment ? "waits" : "now";
};

/** Where each stage stands. */
const stagesOf = ({
  org,
  state,
  read,
  invited,
  leadsKnown,
  leadsTalked,
  told,
  closed,
  talking,
  open,
  ready,
}: {
  org: Org;
  state: OrgState;
  read: boolean;
  invited: boolean;
  leadsKnown: boolean;
  leadsTalked: boolean;
  told: boolean;
  closed: boolean;
  /** Some team's links are out. */
  talking: boolean;
  open: boolean;
  ready: boolean;
}): Record<Stage, StageStatus> => {
  let connected: StageStatus = "later";
  if (leadsKnown) {
    connected = "done";
  } else if (read || org.real) {
    connected = "waits";
  }
  let leads: StageStatus = "later";
  if (leadsTalked) {
    leads = "done";
  } else if (told) {
    leads = "now";
  } else if (leadsKnown && invited) {
    leads = "waits";
  }
  let interviews: StageStatus = "later";
  if (closed) {
    interviews = "done";
  } else if (talking) {
    interviews = "now";
  }
  // Opening is Grasp's own go: it is in Grasp's hands from the moment enough is known.
  let opening: StageStatus = "later";
  if (open) {
    opening = "done";
  } else if (ready || closed) {
    opening = "now";
  }
  return {
    conversation: read ? "done" : "now",
    research: researchStage(org, state, read),
    agreed: agreedStage(org, state, read, invited),
    connected,
    leads,
    interviews,
    open: opening,
  };
};

// oxlint-disable-next-line complexity -- ported as the prototype has it: the whole organization on one day, worked out in one place; every admin test pins it
export const viewOf = (org: Org, state: OrgState): OrgView => {
  const told = state.client === "told" && !org.made;
  // The links close when the organization's own plan ends, not after the samples' two weeks.
  const days = listenDays(org);
  const day = told ? Math.min(Math.max(Math.round(state.day), 0), days) : 0;
  const closed = told && day >= days;
  const known = state.client !== "none" && !org.made;
  const leadsKnown = state.client === "leads" || state.client === "told";
  const lines = timelinesOf(org);
  const roster = known ? peopleOf(org) : [];
  // A team that does not take part is not waited for, like someone away. What one of its people agreed to before stays said.
  const left = new Set(state.left);
  const talkedBy = (person: Person) =>
    told &&
    (lines.get(person.id)?.completed ?? Number.POSITIVE_INFINITY) <= day;
  const out = new Set(
    roster
      .filter((person) => left.has(person.team) && !talkedBy(person))
      .map((person) => person.id)
  );
  const notWaitedFor = { ...state, away: [...state.away, ...out] };
  // Work of a team that does not take part counts only once someone there told about it.
  const takes = (work: { team: string; approved: number }) =>
    !left.has(work.team) || work.approved > 0;
  const works = told ? evidenceAt(org, day, notWaitedFor).filter(takes) : [];
  const vision = visionOf(org, state);

  const teams = (known ? org.teams : []).map((team, index): TeamView => {
    const off = left.has(team.id);
    const channel = state.channels[team.id] ?? team.channel ?? "email";
    const mine = roster.filter((person) => person.team === team.id);
    // Who is in their interview right now: the next few to finish.
    let talkingNow: string[] = [];
    if (org.real) {
      talkingNow = mine
        .filter((person) => org.real?.talking.has(person.id) === true)
        .map((person) => person.id);
    } else if (told && day < days) {
      talkingNow = mine
        .filter((person) => lines.get(person.id)?.completed === day + 1)
        .toSorted(
          (a, b) =>
            (lines.get(a.id)?.order ?? 0) - (lines.get(b.id)?.order ?? 0)
        )
        .slice(0, TALKING)
        .map((person) => person.id);
    }
    const talking = new Set(talkingNow);
    // oxlint-disable-next-line complexity -- ported as the prototype has it: one person on one day, every way their link can stand
    const people = mine.map((person): PersonView => {
      const timeline = lines.get(person.id);
      const away = state.away.includes(person.id) || out.has(person.id);
      if (!told || !timeline) {
        return {
          person,
          state: away ? "away" : "waiting",
          channel,
          sent: null,
          opened: null,
          reminded: null,
          byHand: false,
          mayRemind: false,
          completed: null,
          deleted: false,
          out: off,
          stoppedAt: null,
          last: null,
        };
      }
      const on = (at: number | null) => (at !== null && at <= day ? at : null);
      // Whoever is away is not waited for, whatever their link would have done.
      const current = away
        ? "away"
        : stateOn(timeline, day, talking.has(person.id), days);
      // One reminder a person: sent by hand first, it does not go again by itself.
      const hand = state.reminded[person.id];
      const first =
        hand !== undefined &&
        (timeline.reminded === null || hand <= timeline.reminded)
          ? hand
          : timeline.reminded;
      const reminded = on(first);
      const byHand = reminded !== null && reminded === hand;
      const stopped =
        timeline.stopped && timeline.stopped.day <= day
          ? timeline.stopped
          : null;
      // Of what happened on the same day, the furthest along is the last.
      let last: PersonView["last"] = null;
      const happened = (
        what: NonNullable<PersonView["last"]>["what"],
        at: number | null
      ) => {
        if (at !== null && at <= day && (last === null || at >= last.day)) {
          last = { what, day: at };
        }
      };
      happened("sent", timeline.sent);
      happened("opened", timeline.opened);
      happened("reminded", reminded);
      happened("stopped", stopped?.day ?? null);
      happened("completed", timeline.completed);
      return {
        person,
        state: current,
        channel,
        sent: on(timeline.sent),
        opened: on(timeline.opened),
        reminded,
        byHand,
        mayRemind:
          day < days &&
          reminded === null &&
          (current === "invited" ||
            current === "opened" ||
            current === "incomplete"),
        completed: current === "away" ? null : on(timeline.completed),
        deleted: state.deleted.includes(person.id),
        out: off,
        stoppedAt: current === "incomplete" ? (stopped?.phase ?? null) : null,
        last,
      };
    });
    const counts = noCounts();
    for (const each of people) {
      counts[each.state] += 1;
    }
    const lead = people.find((each) => each.person.lead) ?? null;
    let sent: number | null = null;
    let heard: number | null = null;
    if (org.real) {
      sent = org.real.sent.get(team.id) ?? null;
      heard = org.real.heard.get(team.id) ?? null;
    } else if (told && leadDay(team, index) <= day) {
      sent = leadDay(team, index);
      heard = sent;
    }
    const waiting = people.length - counts.completed - counts.away;
    const next = nextOf({ off, leadsKnown, told, closed, sent, waiting, lead });
    return {
      team,
      off,
      lead: leadsKnown ? lead : null,
      people,
      counts,
      asked: people.length - counts.away,
      sent,
      heard,
      works: works.filter((work) => work.team === team.id),
      next,
    };
  });

  const people = teams.flatMap((team) => team.people);
  const counts = noCounts();
  for (const each of people) {
    counts[each.state] += 1;
  }
  const interviews = told ? interviewsAt(org, day, notWaitedFor) : [];
  // Only the teams that take part are waited for and counted.
  const taking = teams.filter((team) => !team.off);

  const read = state.conversation === "read";
  const invited = mayInvite(state.agreed);
  const leadsTalked = told && taking.every((team) => team.heard !== null);

  // What Grasp knows, source by source, as the company's own onboarding counts it.
  const skipped = org.skipped ?? [];
  const said = vision
    ? VISION_FIELDS.filter((field) => vision.fields[field]).length /
      VISION_FIELDS.length
    : 0;
  const leads = taking.filter((team) => team.heard !== null).length;
  const members = people.filter(
    (each) => !each.person.lead && each.state !== "away"
  );
  const counted = org.works.filter(
    (work) => !left.has(work.team) || works.some((each) => each.id === work.id)
  ).length;
  const has: Record<KnowledgeSource, number> = {
    // The first conversation, and the research into the company that follows it.
    vision: 0.75 * said + (state.research === "done" ? 0.25 : 0),
    directory: whether(known),
    sources: whether(leadsKnown && !skipped.includes("sources")),
    documents: whether(leadsKnown && !skipped.includes("documents")),
    pulse: whether(leadsKnown && !skipped.includes("pulse")),
    leadsKnown: whether(leadsKnown),
    leadsHeard: share(leads, taking.length),
    everyoneHeard: share(
      members.filter((each) => each.state === "completed" && !each.deleted)
        .length,
      members.length
    ),
    // How far the work itself is known: the share of workflows that count as known.
    review: share(knownWorks(works), counted),
  };
  // A point counts once it is wholly in, so the sources always add up to the percentage.
  const sources = KNOWLEDGE_SOURCES.map((source) => ({
    source,
    weight: WEIGHTS[source],
    known: has[source],
    points: Math.floor(WEIGHTS[source] * has[source] + 1e-9),
  }));
  // Where the organization counts it itself, its own number stands: the company sees that one.
  const percent =
    org.real?.known ?? sources.reduce((sum, each) => sum + each.points, 0);
  const knowledge: OrgKnowledge = {
    // Core's number comes without its parts: the admin's own would not add up to it, so none.
    sources: org.real?.known === undefined ? sources : [],
    percent,
    threshold: state.threshold,
    ready: percent >= state.threshold,
    opened: state.opened,
  };
  const open = state.opened !== null;
  const stages = stagesOf({
    org,
    state,
    read,
    invited,
    leadsKnown,
    leadsTalked,
    told,
    closed,
    talking: told && taking.some((team) => team.sent !== null),
    open,
    ready: knowledge.ready,
  });
  // At a real organization the first conversation is Grasp's own to bring in: nothing waits for it,
  // but it is what Stephen starts from, so until he has read it Grasp is asked for it all the same.
  const optional = (each: Stage) =>
    ((org.made === true || org.real !== undefined) && each === "research") ||
    (org.real !== undefined && each === "conversation");
  const stage =
    STAGES.find((each) => stages[each] !== "done" && !optional(each)) ?? "open";

  const needs: Need[] = [];
  if (told && org.real?.paused === true) {
    needs.push({ kind: "paused" });
  }
  if (!read) {
    needs.push({ kind: "transcript" });
  }
  const missing = vision
    ? VISION_FIELDS.filter((field) => !vision.fields[field])
    : [];
  if (missing.length > 0) {
    needs.push({ kind: "ask", fields: missing });
  }
  if (read && state.research === "none" && !org.made && !org.real) {
    needs.push({ kind: "research" });
  }
  if (state.research === "done") {
    for (const finding of org.research) {
      if (present(finding.conflict) && !state.passed.includes(finding.source)) {
        needs.push({
          kind: "conflict",
          source: finding.source,
          text: finding.conflict,
        });
      }
    }
  }
  if (org.real ? !invited : read && !told) {
    for (const what of ["processing", "assessment"] as const) {
      if (!state.agreed[what]) {
        needs.push({ kind: "agreement", what });
      }
    }
    if (state.agreed.council === "waiting") {
      needs.push({ kind: "agreement", what: "council" });
    }
  }
  if (told && !closed) {
    // The quiet window shrinks with a shorter plan, so a five-day plan's team is not quiet on its
    // first day; fourteen days and more keep the samples' four.
    const quietDays = Math.min(
      QUIET_DAYS,
      Math.ceil((days * QUIET_DAYS) / LISTEN_DAYS)
    );
    for (const team of taking) {
      // A lead who is late holds up their whole team: from the reminder on, that needs a word.
      if (
        team.sent === null &&
        team.lead?.reminded !== null &&
        team.lead?.reminded !== undefined
      ) {
        needs.push({
          kind: "lead",
          team: team.team,
          lead: team.lead.person.first,
        });
      }
      const talked = team.counts.completed;
      const asked = team.people.length - team.counts.away;
      if (
        team.sent !== null &&
        days - day <= quietDays &&
        asked > 0 &&
        talked / asked < QUIET_SHARE
      ) {
        needs.push({
          kind: "quiet",
          team: team.team,
          talked,
          left: days - day,
        });
      }
    }
  }
  for (const work of works) {
    const lead =
      teams.find((team) => team.team.id === work.team)?.lead?.person.first ??
      "";
    if (work.state === "blocked") {
      needs.push({ kind: "blocked", work: work.work });
    } else if (work.split) {
      needs.push({ kind: "split", work: work.work, lead });
    }
  }
  // Once the link has closed, what was heard from too few people stays open.
  const few = closed ? works.filter((work) => work.state === "mapping") : [];
  if (few.length > 0) {
    needs.push({ kind: "few", works: few });
  }
  const unread = interviews.filter(
    (interview) => interview.toRead && !state.read.includes(interview.id)
  ).length;
  if (unread > 0) {
    needs.push({ kind: "read", count: unread });
  }
  if (!open && knowledge.ready) {
    needs.unshift({ kind: "go", percent, threshold: state.threshold });
  } else if (!open && closed) {
    needs.unshift({ kind: "short", percent, threshold: state.threshold });
  }

  return {
    org,
    state,
    told,
    day,
    closed,
    transcript: transcriptOf(org, state),
    vision,
    people,
    teams,
    counts,
    asked: people.length - counts.away,
    interviews,
    works,
    knowledge,
    stages,
    stage,
    needs,
  };
};
