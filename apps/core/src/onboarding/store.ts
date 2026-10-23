import { addWorkingDays, dayOf } from "@grasp-os/shared/admin/org-record";
import type { DrawnWork } from "@grasp-os/shared/admin/org-record";
import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditActor, AuditDetailValue } from "@grasp-os/shared/audit";
import { randomToken, sha256Hex } from "@grasp-os/shared/encoding";
import {
  interviewPagePath,
  interviewProgressSchema,
} from "@grasp-os/shared/interview-links";
import type {
  InterviewElsewhere,
  InterviewProgress,
  InterviewSaved,
  InterviewSession,
} from "@grasp-os/shared/interview-links";
import { agreedFacts, agreedKey } from "@grasp-os/shared/interview-story";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import { visionFields } from "@grasp-os/shared/kickoff";
import type {
  KickoffReading,
  KickoffView,
  VisionField,
} from "@grasp-os/shared/kickoff";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  agreementsSchema,
  firstInterviewer,
  planSchema,
  remindAfterWorkingDays,
} from "@grasp-os/shared/onboarding";
import type {
  Agreements,
  InterviewKind,
  InterviewLocale,
  OnboardingView,
  Plan,
  Roster,
} from "@grasp-os/shared/onboarding";
import {
  noChoices,
  setupChoicesSchema,
} from "@grasp-os/shared/onboarding-choices";
import type { SetupChoices } from "@grasp-os/shared/onboarding-choices";
import type {
  DocumentReading,
  OnboardingDocument,
} from "@grasp-os/shared/onboarding-documents";
import {
  logPageMax,
  stephenSetupSchema,
} from "@grasp-os/shared/onboarding-staff";
import type {
  LogActor,
  LogFilter,
  StaffAgreements,
  StaffLog,
  StaffLogEntry,
  StaffNote,
  StaffTranscript,
  StephenSetup,
  StephenSetupView,
} from "@grasp-os/shared/onboarding-staff";
import { DurableObject } from "cloudflare:workers";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  not,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import { drainObjectOutbox } from "../audit-outbox.ts";
import { signInConfig } from "../auth/config.ts";
import { keepOnboardingRecords } from "../brain-records.ts";
import { organizations } from "../db/core/schema.ts";
import { migrateOnWake } from "../db/migrate.ts";
import migrations from "../db/onboarding/migrations/migrations.js";
import {
  askedAbout,
  answerWaits,
  auditOutbox,
  brainSent,
  brainTeams,
  countedPeople,
  drawFailures,
  drawnWorks,
  events,
  interviewStates,
  interviewTexts,
  interviewSettings,
  interviews,
  linkCodes,
  documents,
  kickoff,
  links,
  notes,
  onboarding,
  people,
  teamCounts,
  teams,
  usage,
  voiceUse,
  works,
} from "../db/onboarding/schema.ts";
import { inJurisdiction } from "../durable-objects.ts";
import {
  deliverMail,
  dropMailAbout,
  mailAbout,
  mailState,
  queueAgain,
  queueMail,
} from "../mail-outbox.ts";
import type { MailState, MailToQueue } from "../mail-outbox.ts";
import { sendMail } from "../mail.ts";
import {
  brainFloor,
  intakeIds,
  intakeOf,
  rosterSource,
} from "./brain-intake.ts";
import type { TeamIntake } from "./brain-intake.ts";
import { storedDocumentReadingSchema } from "./document-reading.ts";
import {
  kickoffBrief,
  storedAnswersSchema,
  storedReadingSchema,
} from "./kickoff.ts";
import { linkSecretOf } from "./link-secret.ts";
import { linkMail, reminderMail, updateMail } from "./mail-text.ts";
import {
  agreementsIn,
  closesOn,
  dueLinks,
  leads,
  leadsTalked,
  progressOf,
  sendsFrom,
  takingPart,
} from "./rules.ts";
import type { InterviewState, TeamCount } from "./rules.ts";
import { interviewBrief, setupView } from "./stephen-setup.ts";
import { assignWork, companyName, drawTeamMap } from "./team-map.ts";
import { drawnWorkSchema, drawWork, knownOf } from "./work-drawing.ts";
import type { WorkBrief, WorkKnown } from "./work-drawing.ts";

// The onboarding's store: one Durable Object per deployment holds who works
// where, the plan, everyone's link and where each interview stands, the log
// and the AI used. It is the only place any of it is kept. Each side reads
// only what it may (rpc.ts): the company's admin numbers per team, never
// anyone's words; Grasp's staff more, as their issues come. What it can't
// let happen, from the threat model (GRA-307), and what stops it here:
//
// - A link going out before its moment, while the interviews are paused,
//   or before the agreements are in: the alarm releases links, and only
//   while `isOpen()`, by the plan's moments (`dueLinks`).
// - The admin's numbers singling someone out: `view()` returns numbers
//   only, none for a team until five were asked, moving once a day, from
//   tallies that editing the roster doesn't move (`progressOf`).
// - A roster past its limits: refused by `rosterSchema` before it reaches
//   here (rpc.ts).
// - A change without a trace: every change by the admin or staff is in the
//   audit log, with ids and counts, never names or words.
// - A link opening what isn't its own (GRA-287, links.ts): the store is
//   given only the hashes of a link's secret and a device's key, and opens
//   one person's interview for the one device that opened it first.
//   What each person does on their link is in the onboarding's own log,
//   which only staff read, never in the audit log, which the company's
//   admin reads: it would tell them who talked, and when.
// - A mail going twice, or a link's secret kept or logged: mail goes
//   through the outbox (mail-outbox.ts), once by its key, the link filled
//   in only as the mail is sent. Each link goes by email on its day, and
//   one reminder after `remindAfterWorkingDays`; the admin's update twice
//   a week holds the admin's own numbers, never a name (mail-text.ts).

/** The one store of a deployment, by the name it is reached under. */
const storeName = "onboarding";

/** The deployment's onboarding store. */
export const onboardingStore = (
  env: Pick<Env, "ONBOARDING" | "DURABLE_OBJECT_JURISDICTION">
) => inJurisdiction(env, env.ONBOARDING).getByName(storeName);

/** What the audit log names as acted on. */
const target = { type: "onboarding", id: storeName } as const;

/** Most calls one link makes in a minute: a person talks far slower. */
const linkCallsPerMinute = 60;

/** Why a link refused a request, as links.ts answers it. */
export type LinkRefusal =
  | "interview.link_invalid"
  | "interview.not_yet"
  | "interview.paused"
  | "interview.closed"
  | "interview.elsewhere"
  | "interview.deleted"
  | "interview.limited";

/** What a link's request gets from the store: an answer, or why not. */
export type LinkAnswer<T> =
  | { ok: true; value: T }
  | { ok: false; code: LinkRefusal };

const refused = (code: LinkRefusal) => ({ ok: false, code }) as const;
const answered = <T>(value: T) => ({ ok: true, value }) as const;

/** A person's first name, as Stephen calls them. */
const firstName = (name: string): string => name.trim().split(/\s+/u)[0] ?? "";

/** What a lead's interview knows of their team: its size, and who is in it by name and job. */
const teamKnown = (
  leadName: string,
  team: string,
  members: readonly Roster["people"][number][]
): string[] => [
  `${firstName(leadName)} leads ${team}, a team of ${members.length + 1}.`,
  ...(members.length === 0
    ? []
    : [
        `The people in the team, by name and job: ${members
          .map(({ name, title }) =>
            title === "" ? name : `${name} (${title})`
          )
          .join("; ")}.`,
      ]),
];

/**
 * Waits for `promise`, and logs it failing instead of throwing: for the
 * delivery of mail after it, which runs all the same.
 */
const quietly = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
  } catch (error) {
    log.error("mail.delivery_failed", errorFields(error));
  }
};

/** The days of the week the admin's update goes out: Monday and Thursday. */
const updateWeekdays: ReadonlySet<number> = new Set([1, 4]);

/** What every onboarding mail is written with (`#mailContext`). */
interface MailContext {
  company: string;
  locale: InterviewLocale;
  /** The company's onboarding admin, whom replies reach. */
  replyTo: string | undefined;
}

/** How long the alarm waits, at most, before it looks for due links again. */
const linkCheckMs = 60 * 60 * 1000;
/** How long after someone agrees before the alarm draws what they said. */
const drawAfterMs = 15_000;
/** How long a drawing that failed waits before it's tried again, each time; then it's given up. */
const drawRetryMs = [60_000, 5 * 60_000, 30 * 60_000] as const;
/** And how soon the alarm goes on drawing the next thing. */
const drawNextMs = 500;
/** And how long before it retries delivering audit events, first and at most. */
const auditRetryMs = { first: 5000, most: 15 * 60 * 1000 };

/** What one model call took, to count for the onboarding. */
export interface Took {
  purpose: "reading" | "interviews" | "drawing";
  /** The model, or `voice` for Stephen's. */
  model: string;
  tokensIn?: number;
  tokensCached?: number;
  tokensOut?: number;
  seconds?: number;
}

/** What one interview turn knows of who it is with, from the store (`turnContext`). */
/** What the drawing gets from one interview: only what its person agreed to. */
export interface DrawInput {
  person: string;
  kind: "own" | "lead";
  /** When they last agreed to something new: what `drawn` is told once it is drawn. */
  agreedAt: string;
  facts: { tag: FactTag; record: string }[];
}

/** One of a team's pieces of work, and who is asked about it. */
export interface TeamWork {
  id: string;
  name: string;
  local: string;
  one: string;
  many: string;
  doers: string[];
  share: number;
  asked: string[];
  /** As drawn from what its people agreed to; null before it is. */
  drawn: DrawnWork | null;
  /** How far it is known, under the organization's rules. */
  known: WorkKnown;
}

/** A piece of work due to be drawn, with when it may be and how often it failed so far. */
interface WorkToDraw {
  id: string;
  team: string;
  /** Whose agreements it is drawn from, and when each last agreed. */
  agreed: Record<string, string>;
  /** Whose agreement it is drawn for: who agreed last. */
  about: string;
  after: number;
  tries: number;
}

const agreedSchema = z.record(z.string(), z.string());

/** Whose agreements a piece of work was drawn from, as the store keeps it. */
const agreedOf = (stored: string): Record<string, string> =>
  agreedSchema.safeParse(JSON.parse(stored)).data ?? {};

/** A drawing as the store keeps it; null when there is none. */
const drawingOf = (stored: string | null): DrawnWork | null =>
  stored === null
    ? null
    : (drawnWorkSchema.safeParse(JSON.parse(stored)).data ?? null);

/** The questions earlier interviews left open, for Stephen to ask when they come up. */
const openKnown = (drawn: DrawnWork | null): string[] =>
  drawn === null || drawn.open.length === 0
    ? []
    : [
        `What earlier interviews left open, to ask when it comes up: ${drawn.open.slice(0, 4).join(" ")}`,
      ];

const doersSchema = z.array(z.string());

/** Who does a piece of work, as the store keeps it. */
const doersOf = (stored: string): string[] =>
  doersSchema.safeParse(JSON.parse(stored)).data ?? [];

export interface TurnContext {
  kind: InterviewKind;
  /** Their first name, their team, and their lead's first name. */
  name: string;
  team: string;
  lead: string | null;
  /** The piece of work Stephen learns about; empty until the team's map names it. */
  work: string;
  /**
   * What Stephen knows beforehand: a lead's team, what earlier interviews
   * about someone's work left open, his setup, the kickoff and the documents.
   */
  known: string;
  /** Names and words to listen for. */
  terms: string[];
}

/** One interview as Grasp's admin reads it from the store: no word of it. */
export interface AdminInterviewFacts {
  person: string;
  kind: "own" | "lead";
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  /** Where they stand, as their page last said; null before it saved. */
  state: NonNullable<InterviewProgress["person"]> | null;
  phase: NonNullable<InterviewProgress["phase"]> | null;
  facts: number;
  out: number;
  confirmed: number;
  rating: number | null;
  typed: boolean;
  interviewer: NonNullable<InterviewProgress["interviewer"]> | null;
}

/** `text` as JSON, or undefined when it isn't JSON, for a schema to refuse. */
const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Who did something, as the onboarding's log names them: never by name. */
const whoIs = (by: AuditActor): string => {
  if (by.type === "person" || by.type === "staff") {
    return `${by.type}:${by.userId}`;
  }
  return by.type === "system" ? "grasp" : by.type;
};

/** A shared document's row, as the admin reads it. */
const documentOf = (row: {
  id: string;
  name: string;
  at: string;
  reading: string;
  answer: string | null;
}): OnboardingDocument => ({
  id: row.id,
  name: row.name,
  at: row.at,
  reading: storedDocumentReadingSchema.parse(JSON.parse(row.reading)),
  answer: row.answer,
});

/** How the log names someone who did something on their own interview link. */
const interviewee = "interviewee";

/** Who did what the log holds, as the staff's log names them. */
const logActorOf = (by: string): LogActor => {
  if (by.startsWith("staff:")) {
    return "staff";
  }
  if (by.startsWith("person:")) {
    return "company";
  }
  return by === interviewee ? "person" : "grasp";
};

/** The log's rows `actor` did, as SQL: the inverse of `logActorOf`. */
const byActor = (actor: LogActor): SQL => {
  const staff = like(events.by, "staff:%");
  const company = like(events.by, "person:%");
  const person = eq(events.by, interviewee);
  if (actor === "staff") {
    return staff;
  }
  if (actor === "company") {
    return company;
  }
  return actor === "person" ? person : not(or(staff, company, person) ?? staff);
};

/**
 * The log's rows `filter` keeps, as SQL. `what` is a dotted name or its
 * start, compared by prefix rather than `LIKE`, where its `_` would match
 * any character. `about` holds the people of the team.
 */
const logWhere = (filter: LogFilter, about: string[] | undefined) =>
  and(
    filter.actor === undefined ? undefined : byActor(filter.actor),
    filter.what === undefined
      ? undefined
      : or(
          eq(events.what, filter.what),
          eq(
            sql`substr(${events.what}, 1, ${filter.what.length + 1})`,
            `${filter.what}.`
          )
        ),
    about === undefined ? undefined : inArray(events.about, about),
    filter.day === undefined
      ? undefined
      : eq(sql`substr(${events.at}, 1, 10)`, filter.day)
  );

/** The waits for his voice are kept to the tenth of a second, rounded up. */
const waitStepMs = 100;

/** A count as given, when it is one: a number from nothing up. */
const counted = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** How many interviews a snapshot read parses at once. */
const adminFactsPage = 100;

/** What the admin reads of one interview's progress: its numbers alone. */
interface InterviewCounts {
  state: NonNullable<InterviewProgress["person"]> | null;
  phase: NonNullable<InterviewProgress["phase"]> | null;
  facts: number;
  out: number;
  confirmed: number;
  rating: number | null;
  typed: boolean;
  interviewer: NonNullable<InterviewProgress["interviewer"]> | null;
}

const noCounts: InterviewCounts = {
  state: null,
  phase: null,
  facts: 0,
  out: 0,
  confirmed: 0,
  rating: null,
  typed: false,
  interviewer: null,
};

const countsOf = (progress: InterviewProgress): InterviewCounts => ({
  state: progress.person,
  phase: progress.phase,
  facts: progress.facts.filter(({ out }) => out !== true).length,
  out: progress.facts.filter(({ out }) => out === true).length,
  confirmed: progress.confirmed,
  rating: progress.rating ?? null,
  typed: progress.mode === "type",
  interviewer: progress.interviewer ?? null,
});

export class Onboarding extends DurableObject<Env> {
  readonly #db = drizzle(this.ctx.storage);
  #auditRetryMs = auditRetryMs.first;
  /** Calls per link in the current minute: the store counts per link, never per address. */
  readonly #calls = new Map<string, { minute: string; count: number }>();
  /** The delivery of mail running now: the next waits for it. */
  #mailing: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateOnWake(ctx, migrations);
    // The one row everything else updates, there before anything asks.
    this.#db.insert(onboarding).values({ id: 1 }).onConflictDoNothing().run();
  }

  /** The onboarding as its admin sees it. */
  view(now: string = new Date().toISOString()): OnboardingView {
    const roster = this.#roster();
    const row = this.#row();
    return {
      roster,
      plan: row.plan,
      progress:
        roster === null
          ? null
          : progressOf(roster, this.#interviews(), this.#counts(), now),
      agreed: agreementsIn(row.agreements),
      paused: row.pausedAt !== null,
      sponsor: this.#sponsor(),
    };
  }

  /** The sponsor's first name, when the kickoff named them: read without its transcript. */
  #sponsor(): string | null {
    const [row] = this.#db
      .select({ reading: kickoff.reading })
      .from(kickoff)
      .all();
    return row === undefined
      ? null
      : (storedReadingSchema.parse(JSON.parse(row.reading)).sponsor ?? null);
  }

  /**
   * When who works where was last saved (ISO 8601), from the log; null
   * before it was. The brain dates the teams' sizes by it.
   */
  rosterSavedAt(): string | null {
    const [row] = this.#db
      .select({ at: events.at })
      .from(events)
      .where(eq(events.what, "onboarding.roster.saved"))
      .orderBy(desc(events.seq))
      .limit(1)
      .all();
    return row?.at ?? null;
  }

  /**
   * The day each team's lead finished their interview, for the teams the
   * admin's view already counts as talked (rules.ts, `leadsTalked`): the
   * brain's stakeholder interviews, without anything said in them.
   */
  leadsTalked(
    now: string = new Date().toISOString()
  ): { team: string; person: string; day: string }[] {
    const roster = this.#roster();
    return roster === null
      ? []
      : [...leadsTalked(roster, this.#interviews(), now)].map(
          ([team, { person, day }]) => ({ team, person, day })
        );
  }

  /** Whether interviews may happen now: not paused, and the agreements in. */
  isOpen(): boolean {
    const row = this.#row();
    return row.pausedAt === null && agreementsIn(row.agreements);
  }

  /**
   * Replaces who works where. People who are no longer in it keep nothing
   * here: their link, what they said and where their interview stood go
   * with them. Everyone new gets a link of their own.
   */
  async saveRoster(roster: Roster, by: AuditActor): Promise<OnboardingView> {
    const coded = new Set(
      this.#db
        .select({ person: linkCodes.person })
        .from(linkCodes)
        .all()
        .map(({ person }) => person)
    );
    const fresh = await Promise.all(
      roster.people
        .filter(({ id }) => !coded.has(id))
        .map(async ({ id }) => {
          const linkId = randomToken();
          const mark = await sha256Hex(await linkSecretOf(this.env, linkId));
          return { person: id, linkId, mark };
        })
    );
    this.ctx.storage.transactionSync(() => {
      const kept = new Set(roster.people.map((person) => person.id));
      const gone = this.#db
        .select({ id: people.id })
        .from(people)
        .all()
        .filter(({ id }) => !kept.has(id))
        .map(({ id }) => id);
      const mapped = new Map(
        this.#db
          .select({ id: teams.id, mappedAt: teams.mappedAt })
          .from(teams)
          .all()
          .map(({ id, mappedAt }) => [id, mappedAt])
      );
      this.#db.delete(teams).run();
      this.#db.delete(people).run();
      for (const [position, team] of roster.teams.entries()) {
        this.#db
          .insert(teams)
          .values({ ...team, position, mappedAt: mapped.get(team.id) ?? null })
          .run();
      }
      for (const [position, person] of roster.people.entries()) {
        this.#db
          .insert(people)
          .values({ ...person, position })
          .run();
      }
      for (const code of fresh) {
        this.#db.insert(linkCodes).values(code).onConflictDoNothing().run();
      }
      // Whoever left keeps nothing: no link, nothing said, no state.
      const stale = this.#db
        .select({ person: linkCodes.person })
        .from(linkCodes)
        .all()
        .map(({ person }) => person)
        .filter((person) => !kept.has(person));
      // A piece of work goes with its team, and who is asked about it goes
      // with them, or when they move to another team.
      const teamOf = new Map(roster.people.map(({ id, team }) => [id, team]));
      const teamIds = new Set(roster.teams.map(({ id }) => id));
      const workTeam = new Map(
        this.#db
          .select({ id: works.id, team: works.team })
          .from(works)
          .all()
          .map(({ id, team }) => [id, team])
      );
      for (const [id, team] of workTeam) {
        if (!teamIds.has(team)) {
          this.#db.delete(works).where(eq(works.id, id)).run();
        }
      }
      this.#dropOrphanDrawings();
      for (const { person, work } of this.#db.select().from(askedAbout).all()) {
        if (teamOf.get(person) !== workTeam.get(work)) {
          this.#db
            .delete(askedAbout)
            .where(eq(askedAbout.person, person))
            .run();
        }
      }
      for (const person of new Set([...gone, ...stale])) {
        this.#db.delete(linkCodes).where(eq(linkCodes.person, person)).run();
        this.#db.delete(links).where(eq(links.person, person)).run();
        this.#db.delete(interviews).where(eq(interviews.person, person)).run();
        this.#db
          .delete(interviewStates)
          .where(eq(interviewStates.person, person))
          .run();
        this.#db
          .delete(interviewTexts)
          .where(eq(interviewTexts.person, person))
          .run();
        this.#db
          .delete(interviewSettings)
          .where(eq(interviewSettings.person, person))
          .run();
        dropMailAbout(this.ctx.storage.sql, person);
      }
      this.#changed(by, "onboarding.roster.saved", {
        teams: roster.teams.length,
        people: roster.people.length,
        removed: gone.length,
      });
    });
    this.#deliverAudit();
    this.ctx.waitUntil(this.#armLinks());
    return this.view();
  }

  /** Sets when the interviews run. Links go out by it, once the interviews are open. */
  savePlan(plan: Plan, by: AuditActor): OnboardingView {
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(onboarding)
        .set({ plan: JSON.stringify(plan) })
        .where(eq(onboarding.id, 1))
        .run();
      this.#changed(by, "onboarding.plan.saved", {
        start: plan.start,
        days: plan.days,
      });
    });
    this.#deliverAudit();
    this.ctx.waitUntil(this.#armLinks());
    return this.view();
  }

  /** Pauses the interviews, or lets them run again. */
  setPaused(paused: boolean, by: AuditActor): OnboardingView {
    const was = this.#row().pausedAt !== null;
    if (was !== paused) {
      this.ctx.storage.transactionSync(() => {
        this.#db
          .update(onboarding)
          .set({ pausedAt: paused ? new Date().toISOString() : null })
          .where(eq(onboarding.id, 1))
          .run();
        this.#changed(
          by,
          paused ? "onboarding.paused" : "onboarding.resumed",
          {}
        );
      });
      this.#deliverAudit();
      this.ctx.waitUntil(this.#armLinks());
    }
    return this.view();
  }

  /** Records where the agreements stand. */
  setAgreements(agreements: Agreements, by: AuditActor): OnboardingView {
    const { processing, assessment, council } = agreements;
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(onboarding)
        .set({ agreements: JSON.stringify(agreements) })
        .where(eq(onboarding.id, 1))
        .run();
      this.#changed(by, "onboarding.agreements.set", {
        processing,
        assessment,
        council,
        processingOn: agreements.processingOn ?? null,
        assessmentOn: agreements.assessmentOn ?? null,
        councilOn: agreements.councilOn ?? null,
      });
    });
    this.#deliverAudit();
    this.ctx.waitUntil(this.#armLinks());
    return this.view();
  }

  /**
   * Records where someone's interview stands, without anything said in it:
   * the interviews (GRA-289, GRA-290) report each change here.
   */
  noteInterview(state: {
    person: string;
    kind: "own" | "lead";
    startedAt: string | null;
    completedAt: string | null;
  }): void {
    this.ctx.storage.transactionSync(() => {
      this.#noteState(state);
    });
  }

  /**
   * The path of someone's link, its secret after the `#`; none for anyone
   * not on the roster. Someone on it without a code yet (on the roster
   * before links were, or added by a save that raced another) gets one now.
   */
  async linkOf(person: string): Promise<string | null> {
    if (!this.#onRoster(person)) {
      return null;
    }
    const codeOf = () =>
      this.#db
        .select({ linkId: linkCodes.linkId })
        .from(linkCodes)
        .where(eq(linkCodes.person, person))
        .all()[0];
    let code = codeOf();
    if (code === undefined) {
      const linkId = randomToken();
      const mark = await sha256Hex(await linkSecretOf(this.env, linkId));
      // Unless someone made one meanwhile, or they left the roster.
      this.ctx.storage.transactionSync(() => {
        if (this.#onRoster(person)) {
          this.#db
            .insert(linkCodes)
            .values({ person, linkId, mark })
            .onConflictDoNothing()
            .run();
        }
      });
      code = codeOf();
    }
    return code === undefined
      ? null
      : `${interviewPagePath}#${await linkSecretOf(this.env, code.linkId)}`;
  }

  /**
   * What a link opens, for the device whose key's mark is `keyMark`. The
   * first device to open it is the one `issue` (a new key's mark) is
   * kept for, and the answer says so; anyone else gets `elsewhere`, with
   * nothing that was said.
   */
  openLink(
    secretMark: string,
    keyMark: string | null,
    issue: string,
    now: string = new Date().toISOString()
  ): LinkAnswer<
    (Omit<InterviewSession, "key"> & { issued: boolean }) | InterviewElsewhere
  > {
    const found = this.#onLink(secretMark, now, "open");
    if (!found.ok) {
      return found;
    }
    const { person, link, roster, plan } = found.value;
    const issued = link.keyMark === null;
    if (!issued && link.keyMark !== keyMark) {
      return answered({ state: "elsewhere" });
    }
    if (issued || link.openedAt === null) {
      this.ctx.storage.transactionSync(() => {
        this.#db
          .update(links)
          .set({
            openedAt: link.openedAt ?? now,
            keyMark: issued ? issue : link.keyMark,
          })
          .where(eq(links.person, person.id))
          .run();
        if (link.openedAt === null) {
          this.#noted(person.id, "interview.opened", now);
        }
      });
    }
    const team = roster.teams.find(({ id }) => id === person.team);
    const lead = roster.people.find(
      ({ id }) => id === team?.lead && id !== person.id
    );
    const closes = closesOn(plan);
    return answered({
      state: "open",
      issued,
      name: firstName(person.name),
      team: team?.name ?? "",
      lead: lead === undefined ? null : firstName(lead.name),
      kind: leads(roster, person.id) ? "lead" : "own",
      closes,
      closed: dayOf(now) > closes,
      progress: this.#held(person.id),
      version: link.version,
    });
  }

  /**
   * Keeps where someone's interview is, from the device it is on. A save
   * from an older copy than the one kept is refused with the one kept, so
   * two tabs never quietly overwrite each other. Deleting moves the version
   * on too: only a copy opened since the delete saves again.
   */
  saveInterview(
    secretMark: string,
    keyMark: string,
    version: number,
    progress: InterviewProgress,
    now: string = new Date().toISOString()
  ): LinkAnswer<InterviewSaved> {
    const found = this.#onLink(secretMark, now, "save");
    if (!found.ok) {
      return found;
    }
    const { person, link, roster } = found.value;
    if (link.keyMark === null || link.keyMark !== keyMark) {
      return refused("interview.elsewhere");
    }
    if (version !== link.version) {
      const held = this.#held(person.id);
      if (held === null && link.deletedAt !== null) {
        return refused("interview.deleted");
      }
      return answered({ saved: false, version: link.version, progress: held });
    }
    const next = link.version + 1;
    const [state] = this.#db
      .select()
      .from(interviewStates)
      .where(eq(interviewStates.person, person.id))
      .all();
    const startedAt =
      state?.startedAt ?? (progress.startedAt === null ? null : now);
    const completedAt =
      state?.completedAt ?? (progress.person === "completed" ? now : null);
    // Agreed to for the first time, or something added after and agreed to
    // as well: what it was about is drawn again. Only what they agreed to
    // counts (`agreedFacts`), so lines still being read back change nothing.
    const agreed = agreedKey(progress.facts);
    const newlyAgreed =
      progress.person === "completed" &&
      agreed !== "" &&
      agreed !== agreedKey(this.#held(person.id)?.facts ?? []);
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(links)
        .set({ version: next })
        .where(eq(links.person, person.id))
        .run();
      this.#db
        .insert(interviews)
        .values({
          person: person.id,
          progress: JSON.stringify(progress),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: interviews.person,
          set: { progress: JSON.stringify(progress), updatedAt: now },
        })
        .run();
      this.#noteState(
        {
          person: person.id,
          kind: leads(roster, person.id) ? "lead" : "own",
          startedAt,
          completedAt,
        },
        now
      );
      if (startedAt !== null && (state?.startedAt ?? null) === null) {
        this.#noted(person.id, "interview.started", now);
      }
      if (completedAt !== null && (state?.completedAt ?? null) === null) {
        this.#noted(person.id, "interview.completed", now);
      }
      if (newlyAgreed) {
        this.#db
          .update(interviewStates)
          .set({ agreedAt: now })
          .where(eq(interviewStates.person, person.id))
          .run();
        this.#brainDue(person.team, now);
      }
    });
    if (newlyAgreed) {
      this.ctx.waitUntil(this.#alarmBy(Date.parse(now) + drawAfterMs));
    }
    return answered({ saved: true, version: next });
  }

  /**
   * What one turn of someone's interview may know, from the device it is
   * on, while the interviews run: who they are, their team and lead, and
   * what Stephen knows of the company beforehand, and what earlier
   * interviews about their work left open. Never from the page,
   * which could say anything. `work` stays empty until the team's map
   * names their piece of work: Stephen then asks which one it is. With
   * `texts`, the marks of the interviewer's text for each kind, the one
   * this turn is held with is kept with the interview.
   */
  turnContext(
    secretMark: string,
    keyMark: string,
    now: string = new Date().toISOString(),
    texts?: Record<InterviewKind, string>
  ): LinkAnswer<TurnContext> {
    const found = this.#onLink(secretMark, now, "save");
    if (!found.ok) {
      return found;
    }
    const { person, link, roster } = found.value;
    if (link.keyMark === null || link.keyMark !== keyMark) {
      return refused("interview.elsewhere");
    }
    const team = roster.teams.find(({ id }) => id === person.team);
    const lead = roster.people.find(
      ({ id }) => id === team?.lead && id !== person.id
    );
    const kind = leads(roster, person.id) ? "lead" : "own";
    if (texts !== undefined) {
      // The text this turn is held with, kept by its mark: the first time
      // it spoke in this interview is when it came in.
      this.#db
        .insert(interviewTexts)
        .values({ person: person.id, mark: texts[kind], at: now })
        .onConflictDoNothing()
        .run();
    }
    const members =
      kind === "lead"
        ? roster.people.filter(
            (each) =>
              each.team === person.team && each.id !== person.id && !each.away
          )
        : [];
    const teamName = team?.name ?? "";
    const known = [
      ...(kind === "lead" ? teamKnown(person.name, teamName, members) : []),
      ...(kind === "lead" ? [] : openKnown(this.#drawingAskedOf(person.id))),
      this.interviewBrief(),
      this.documentsBrief(teamName),
    ].filter((part) => part !== "");
    const terms = [
      ...(lead === undefined ? [] : [firstName(lead.name)]),
      ...members.map((each) => firstName(each.name)),
      ...(this.#stephen()?.terms ?? []),
      ...this.documents().flatMap(({ reading }) => reading.tools),
    ];
    return answered({
      kind,
      name: firstName(person.name),
      team: teamName,
      lead: lead === undefined ? null : firstName(lead.name),
      work: kind === "lead" ? "" : this.#workOf(person.id),
      known: known.join("\n\n"),
      terms: [...new Set(terms)],
    });
  }

  /**
   * Whose interviews have something agreed to that wasn't drawn yet, the
   * longest waiting first: the drawing of what each was about (GRA-366)
   * takes them from here.
   */
  drawsDue(): string[] {
    return this.#db
      .select({ person: interviewStates.person })
      .from(interviewStates)
      .where(
        and(
          isNotNull(interviewStates.agreedAt),
          or(
            isNull(interviewStates.drawnAt),
            lt(interviewStates.drawnAt, interviewStates.agreedAt)
          )
        )
      )
      .orderBy(asc(interviewStates.agreedAt), asc(interviewStates.person))
      .all()
      .map(({ person }) => person);
  }

  /**
   * What the drawing gets from someone's interview: only the facts they
   * agreed to, as the record keeps them. Nothing before they agreed, and
   * nothing they added after until they agreed to that too.
   */
  drawInput(person: string): DrawInput | null {
    const [state] = this.#db
      .select()
      .from(interviewStates)
      .where(eq(interviewStates.person, person))
      .all();
    const facts = agreedFacts(this.#held(person)?.facts ?? []);
    if (state === undefined || state.agreedAt === null || facts.length === 0) {
      return null;
    }
    return {
      person,
      kind: state.kind,
      agreedAt: state.agreedAt,
      facts: facts.map(({ tag, record }) => ({ tag, record })),
    };
  }

  /**
   * Notes that what someone agreed to by `agreedAt` was drawn: what they
   * agree to after that is due again.
   */
  drawn(person: string, agreedAt: string): void {
    this.#db
      .update(interviewStates)
      .set({ drawnAt: agreedAt })
      .where(eq(interviewStates.person, person))
      .run();
  }

  /**
   * Draws the next thing due, one at a time, so a failure leaves the rest
   * for the next go: the map of a team whose lead agreed to something new,
   * then a piece of work someone agreed to more about, so it is drawn from
   * who does it. What fails is tried again after a minute, five and
   * thirty; then it's given up and logged until something new is agreed:
   * a team then gets its links as a team without a lead does, until staff
   * draw it again. Returns what it drew, or null.
   */
  async drawNext(now: number = Date.now()): Promise<string | null> {
    const due = this.#dueToDraw(now).find(({ after }) => after <= now);
    if (due === undefined) {
      return null;
    }
    const { item, about } = due;
    const at = new Date(now).toISOString();
    const what = due.work === undefined ? "map" : "work";
    try {
      await (due.work === undefined
        ? this.#mapTeam(due.id, at)
        : this.#drawWork(due.work, at));
      this.#db.delete(drawFailures).where(eq(drawFailures.item, item)).run();
    } catch (error) {
      const tries = due.tries + 1;
      log.error("onboarding.draw_failed", {
        item,
        tries,
        error: error instanceof Error ? error.name : "unknown",
      });
      const wait = drawRetryMs[tries - 1];
      if (wait === undefined) {
        if (due.work === undefined) {
          this.#giveUp(due.id, about, at);
        } else {
          this.#giveUpWork(due.work, at);
        }
      } else {
        const after = new Date(now + wait).toISOString();
        this.#db
          .insert(drawFailures)
          .values({ item, tries, after })
          .onConflictDoUpdate({
            target: drawFailures.item,
            set: { tries, after },
          })
          .run();
        this.#noted(about, `${what}.failed`, at, "grasp");
      }
    }
    return item;
  }

  /**
   * Draws a team's map again, as staff ask: after it was given up, or to
   * draw it from what its lead agreed to once more. False when its lead
   * hasn't agreed to anything yet.
   */
  async drawAgain(team: string, by: AuditActor): Promise<boolean> {
    const lead = this.#roster()?.teams.find(({ id }) => id === team)?.lead;
    if (lead === undefined || lead === null || this.drawInput(lead) === null) {
      return false;
    }
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.#db
        .delete(drawFailures)
        .where(eq(drawFailures.item, `team:${team}`))
        .run();
      this.#db
        .update(interviewStates)
        .set({ agreedAt: now })
        .where(eq(interviewStates.person, lead))
        .run();
      this.#noted(lead, "map.again", now, whoIs(by));
      this.#changed(by, "onboarding.team.redrawn", {});
    });
    this.#deliverAudit();
    await this.#alarmBy(Date.now() + drawAfterMs);
    return true;
  }

  /**
   * Gives the brain what the next team waiting for it learned (GRA-367):
   * one whose drawings are all done, so what its people agreed to goes in
   * together. What fails is tried again after a minute, five and thirty;
   * then it's given up and logged until something new is agreed. Returns
   * what it gave (`brain:<team>`), or null.
   */
  async intakeNext(now: number = Date.now()): Promise<string | null> {
    const drawing = new Set(
      this.#dueToDraw(now).map(({ id, work }) => work?.team ?? id)
    );
    const due = this.#brainDueAt(now).find(
      ({ team, after }) => after <= now && !drawing.has(team)
    );
    if (due === undefined) {
      return null;
    }
    const item = `brain:${due.team}`;
    try {
      await this.#intakeTeam(due.team, due.dueAt, new Date(now).toISOString());
      this.#db.delete(drawFailures).where(eq(drawFailures.item, item)).run();
    } catch (error) {
      const tries = due.tries + 1;
      log.error("onboarding.brain_failed", {
        item,
        tries,
        error: error instanceof Error ? error.name : "unknown",
      });
      const wait = drawRetryMs[tries - 1];
      this.ctx.storage.transactionSync(() => {
        if (wait === undefined) {
          this.#db
            .delete(drawFailures)
            .where(eq(drawFailures.item, item))
            .run();
          this.#brainSettled(due.team, due.dueAt);
          return;
        }
        const after = new Date(now + wait).toISOString();
        this.#db
          .insert(drawFailures)
          .values({ item, tries, after })
          .onConflictDoUpdate({
            target: drawFailures.item,
            set: { tries, after },
          })
          .run();
      });
    }
    return item;
  }

  /**
   * The records the onboarding gave the brain that rest on someone's
   * interview (brain-intake.ts): what deleting it has to take out of the
   * brain (GRA-368). For staff and the store alone; the brain never names
   * anyone.
   */
  sentFor(person: string): { record: string; type: string; team: string }[] {
    return this.#db
      .select({
        record: brainSent.record,
        type: brainSent.type,
        team: brainSent.team,
      })
      .from(brainSent)
      .where(eq(brainSent.person, person))
      .orderBy(asc(brainSent.type), asc(brainSent.record))
      .all();
  }

  /**
   * Each team the brain has interviews of: one source for all of them
   * (brain-intake.ts), with how many of its people agreed and the day the
   * first of them did, never who. A team that left the roster has none.
   */
  interviewSources(): {
    team: string;
    name: string;
    people: number;
    since: string;
  }[] {
    const roster = this.#roster();
    const states = this.#db
      .select({
        person: interviewStates.person,
        completedAt: interviewStates.completedAt,
      })
      .from(interviewStates)
      .where(isNotNull(interviewStates.agreedAt))
      .all();
    return this.#db
      .select({ team: brainTeams.team })
      .from(brainTeams)
      .where(isNotNull(brainTeams.sentAt))
      .orderBy(asc(brainTeams.sentAt), asc(brainTeams.team))
      .all()
      .flatMap(({ team: id }) => {
        const team = roster?.teams.find((each) => each.id === id);
        const members = new Set(
          roster?.people
            .filter((person) => person.team === id)
            .map((person) => person.id)
        );
        const agreed = states.filter(({ person }) => members.has(person));
        const [since] = agreed
          .flatMap(({ completedAt }) =>
            completedAt === null ? [] : [dayOf(completedAt)]
          )
          .toSorted();
        return team === undefined || since === undefined
          ? []
          : [{ team: id, name: team.name, people: agreed.length, since }];
      });
  }

  /**
   * A team's pieces of work, as its map holds them, who is asked about
   * each, each as drawn from what its people agreed to, and how far it is
   * known: for staff, and for the drawing of each piece.
   */
  teamWorks(team: string): TeamWork[] {
    const asked = this.#db.select().from(askedAbout).all();
    const roster = this.#roster();
    const lead = roster?.teams.find(({ id }) => id === team)?.lead ?? null;
    const away = new Set(
      roster?.people.filter((person) => person.away).map(({ id }) => id)
    );
    const drawings = new Map(
      this.#db
        .select()
        .from(drawnWorks)
        .all()
        .map((row) => [row.work, row])
    );
    return this.#db
      .select()
      .from(works)
      .where(eq(works.team, team))
      .orderBy(asc(works.position))
      .all()
      .map((row) => {
        const doers = doersOf(row.doers);
        const stored = drawings.get(row.id);
        const drawn = drawingOf(stored?.drawn ?? null);
        const agreed = agreedOf(stored?.agreed ?? "{}");
        // Who it was drawn from, in the order they agreed.
        const told = (drawn?.from ?? []).toSorted((a, b) =>
          (agreed[a] ?? "").localeCompare(agreed[b] ?? "")
        );
        return {
          id: row.id,
          name: row.name,
          local: row.local,
          one: row.one,
          many: row.many,
          doers,
          share: row.share,
          asked: asked
            .filter(({ work }) => work === row.id)
            .map(({ person }) => person),
          drawn,
          known: knownOf(drawn, {
            id: row.id,
            team,
            told,
            doers: doers.filter((id) => !away.has(id)),
            lead,
          }),
        };
      });
  }

  /**
   * Deletes someone's interview, from the device it is on, at any time
   * their link opens there: what they said is gone at once, and a copy
   * left open elsewhere can't save it back. What was drawn from it goes
   * with GRA-314.
   */
  deleteInterview(
    secretMark: string,
    keyMark: string,
    now: string = new Date().toISOString()
  ): LinkAnswer<{ deleted: true }> {
    const found = this.#onLink(secretMark, now, "delete");
    if (!found.ok) {
      return found;
    }
    const { person, link } = found.value;
    if (link.keyMark === null || link.keyMark !== keyMark) {
      return refused("interview.elsewhere");
    }
    this.ctx.storage.transactionSync(() => {
      this.#forget(person.id, now, "interview.deleted", interviewee);
      this.#db
        .update(links)
        .set({ deletedAt: now, version: link.version + 1 })
        .where(eq(links.person, person.id))
        .run();
    });
    return answered({ deleted: true });
  }

  /**
   * A new start for someone who lost the device their interview was on:
   * what they said goes, and the link opens again for the next device to
   * open it. Staff do it; the audit log has that they did, not for whom.
   */
  newStart(person: string, by: AuditActor): boolean {
    const [link] = this.#db
      .select()
      .from(links)
      .where(eq(links.person, person))
      .all();
    if (link === undefined) {
      return false;
    }
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.#forget(person, now, "interview.new_start", whoIs(by));
      this.#db
        .update(links)
        .set({ keyMark: null, deletedAt: null, version: link.version + 1 })
        .where(eq(links.person, person))
        .run();
      this.#changed(by, "onboarding.interview.restarted", {});
    });
    this.#deliverAudit();
    return true;
  }

  /**
   * Sends someone's latest mail that failed again, from its first try:
   * staff do it once what stopped it is put right. The audit log has that
   * they did, and which kind of mail, not for whom. False when none failed.
   */
  sendAgain(person: string, by: AuditActor): boolean {
    const failed = mailAbout(this.ctx.storage.sql, person).find(
      ({ state }) => state === "failed"
    );
    if (failed === undefined) {
      return false;
    }
    const now = new Date().toISOString();
    const [kind = "mail"] = failed.key.split("/");
    this.ctx.storage.transactionSync(() => {
      queueAgain(this.ctx.storage.sql, failed.key);
      this.#noted(person, `mail.${kind}.again`, now, whoIs(by));
      this.#changed(by, "onboarding.mail.resent", { kind });
    });
    this.#deliverAudit();
    this.#deliverMailSoon();
    return true;
  }

  /** People whose link went out, and when: for the links themselves (GRA-287) and the admin's list. */
  sentLinks(): { person: string; sentAt: string }[] {
    return this.#db
      .select({ person: links.person, sentAt: links.sentAt })
      .from(links)
      .orderBy(asc(links.sentAt), asc(links.person))
      .all();
  }

  /** Counts one model call for the day it ends on. */
  meter(took: Took, at: string = new Date().toISOString()): void {
    const day = at.slice(0, 10);
    const add = {
      calls: 1,
      tokensIn: counted(took.tokensIn),
      tokensCached: counted(took.tokensCached),
      tokensOut: counted(took.tokensOut),
      seconds: counted(took.seconds),
    };
    this.#db
      .insert(usage)
      .values({ day, purpose: took.purpose, model: took.model, ...add })
      .onConflictDoUpdate({
        target: [usage.day, usage.purpose, usage.model],
        set: {
          calls: sql`${usage.calls} + 1`,
          tokensIn: sql`${usage.tokensIn} + ${add.tokensIn}`,
          tokensCached: sql`${usage.tokensCached} + ${add.tokensCached}`,
          tokensOut: sql`${usage.tokensOut} + ${add.tokensOut}`,
          seconds: sql`${usage.seconds} + ${add.seconds}`,
        },
      })
      .run();
  }

  /**
   * Whom a line said on someone's link is for, from the device it is on,
   * while their interview may be saved: `link:<person>`, the key its
   * voice is counted under (`countVoice`), and the seconds said under it
   * today. Counted within the link's limit, as every call on it.
   */
  speechOnLink(
    secretMark: string,
    keyMark: string,
    now: string = new Date().toISOString()
  ): LinkAnswer<{ who: string; said: number }> {
    const found = this.#onLink(secretMark, now, "save");
    if (!found.ok) {
      return found;
    }
    const { person, link } = found.value;
    if (link.keyMark === null || link.keyMark !== keyMark) {
      return refused("interview.elsewhere");
    }
    const who = `link:${person.id}`;
    return answered({ who, said: this.voiceSaid(who, now) });
  }

  /** Seconds of voice said for `who` today. */
  voiceSaid(who: string, now: string = new Date().toISOString()): number {
    const [row] = this.#db
      .select({ seconds: voiceUse.seconds })
      .from(voiceUse)
      .where(and(eq(voiceUse.who, who), eq(voiceUse.day, now.slice(0, 10))))
      .all();
    return row?.seconds ?? 0;
  }

  /**
   * Counts a line said for `who`: its seconds today, which its budget
   * goes by, and the onboarding's use of voice by purpose (`meter`).
   * The days before today go.
   */
  countVoice(
    who: string,
    purpose: Took["purpose"],
    seconds: number,
    now: string = new Date().toISOString()
  ): void {
    const day = now.slice(0, 10);
    const add = counted(seconds);
    this.ctx.storage.transactionSync(() => {
      this.#db.delete(voiceUse).where(lt(voiceUse.day, day)).run();
      this.#db
        .insert(voiceUse)
        .values({ who, day, seconds: add })
        .onConflictDoUpdate({
          target: [voiceUse.who, voiceUse.day],
          set: { seconds: sql`${voiceUse.seconds} + ${add}` },
        })
        .run();
      this.meter({ purpose, model: "voice", seconds: add }, now);
    });
  }

  /** The AI used, by day, purpose and model. */
  usage(): (typeof usage.$inferSelect)[] {
    return this.#db
      .select()
      .from(usage)
      .orderBy(asc(usage.day), asc(usage.purpose), asc(usage.model))
      .all();
  }

  /**
   * Notes what one turn of an interview ran on, for the staff's numbers:
   * the text that spoke, kept with the interview of the link's person,
   * and how long they waited for his voice the answer before, when their
   * page measured it, kept by day alone. The turn checked the link and
   * the device first (`turnContext`).
   */
  turnRan(
    secretMark: string,
    ran: Omit<typeof interviewSettings.$inferInsert, "person">,
    waited?: number,
    at: string = new Date().toISOString()
  ): void {
    const [code] = this.#db
      .select({ person: linkCodes.person })
      .from(linkCodes)
      .where(eq(linkCodes.mark, secretMark))
      .all();
    this.ctx.storage.transactionSync(() => {
      if (code !== undefined) {
        this.#db
          .insert(interviewSettings)
          .values({ person: code.person, ...ran })
          .onConflictDoUpdate({ target: interviewSettings.person, set: ran })
          .run();
      }
      if (waited !== undefined) {
        this.#db
          .insert(answerWaits)
          .values({
            day: dayOf(at),
            upTo: Math.ceil(waited / waitStepMs) * waitStepMs,
            answers: 1,
          })
          .onConflictDoUpdate({
            target: [answerWaits.day, answerWaits.upTo],
            set: { answers: sql`${answerWaits.answers} + 1` },
          })
          .run();
      }
    });
  }

  /**
   * What the staff's numbers on Stephen and Claire are made from: each
   * interview as numbers (`adminFacts`), the text each ran on, and the
   * waits for his voice by day. Never anything that was said.
   */
  interviewerFacts(): {
    interviews: AdminInterviewFacts[];
    texts: (typeof interviewSettings.$inferSelect)[];
    waits: (typeof answerWaits.$inferSelect)[];
  } {
    return {
      interviews: this.adminFacts().interviews,
      texts: this.#db.select().from(interviewSettings).all(),
      waits: this.#db
        .select()
        .from(answerWaits)
        .orderBy(asc(answerWaits.day), asc(answerWaits.upTo))
        .all(),
    };
  }

  /** Where the agreements stand, as staff last said; none before they did. */
  agreements(): Agreements | null {
    return this.#row().agreements;
  }

  /**
   * Where the agreements stand for Grasp's staff: whether the team is
   * told (a link ever went out, even to someone since taken off the
   * roster), and how many links are out and wait.
   */
  staffAgreements(): StaffAgreements {
    const { agreements } = this.#row();
    const roster = this.#roster();
    const { sent } = this.#linkFacts();
    const [row] = this.#db
      .select({ toldAt: onboarding.toldAt })
      .from(onboarding)
      .where(eq(onboarding.id, 1))
      .all();
    const taking =
      roster?.people.filter((person) => takingPart(roster, person)) ?? [];
    return {
      agreements,
      agreed: agreementsIn(agreements),
      // Links sent before the store kept when the first went out count too.
      told: (row?.toldAt ?? null) !== null || sent.size > 0,
      out: sent.size,
      waiting: taking.filter(({ id }) => !sent.has(id)).length,
    };
  }

  /** How Stephen is set up, and what the kickoff suggests. */
  stephen(): StephenSetupView {
    return setupView(this.#stephen(), this.kickoff());
  }

  /**
   * Sets how Stephen is set up, from the next turn on; null takes him back
   * to what the kickoff suggests. In the log and the audit log by how
   * many lines, never their words.
   */
  saveStephen(setup: StephenSetup | null, by: AuditActor): StephenSetupView {
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(onboarding)
        .set({ stephen: setup === null ? null : JSON.stringify(setup) })
        .where(eq(onboarding.id, 1))
        .run();
      this.#changed(
        by,
        setup === null ? "onboarding.stephen.reset" : "onboarding.stephen.set",
        setup === null
          ? {}
          : {
              languages: setup.languages.join(" "),
              limits: setup.limits.length,
              terms: setup.terms.length,
            }
      );
    });
    this.#deliverAudit();
    return this.stephen();
  }

  /**
   * What every interview turn's context holds of the company: how Stephen
   * is set up, and what the kickoff brought (stephen-setup.ts).
   */
  interviewBrief(): string {
    return interviewBrief(this.#stephen(), this.kickoff());
  }

  /** What the admin chose about what Grasp may connect. */
  choices(): SetupChoices {
    const [row] = this.#db
      .select({ choices: onboarding.choices })
      .from(onboarding)
      .where(eq(onboarding.id, 1))
      .all();
    const stored = row?.choices ?? null;
    return stored === null
      ? noChoices
      : setupChoicesSchema.parse(JSON.parse(stored));
  }

  /**
   * Keeps what the admin chose. In the log and the audit log by which
   * places and what of Pulse and the HR platform, never what they typed.
   */
  saveChoices(choices: SetupChoices, by: AuditActor): SetupChoices {
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(onboarding)
        .set({ choices: JSON.stringify(choices) })
        .where(eq(onboarding.id, 1))
        .run();
      this.#changed(by, "onboarding.choices.saved", {
        sources: choices.sources.join(" "),
        asked: choices.sourcesWanted.length,
        pulse: choices.pulse ?? "",
        hr: choices.hr?.kind ?? "",
      });
    });
    this.#deliverAudit();
    return this.choices();
  }

  /** The documents the admin shared, the newest first. */
  documents(): OnboardingDocument[] {
    return this.#db
      .select()
      .from(documents)
      .orderBy(desc(documents.at))
      .all()
      .map(documentOf);
  }

  /** Keeps a shared document's reading; in the log and the audit log without its words. */
  addDocument(
    kept: { id: string; name: string; reading: DocumentReading },
    by: AuditActor
  ): OnboardingDocument {
    const row = {
      id: kept.id,
      name: kept.name,
      at: new Date().toISOString(),
      by: whoIs(by),
      reading: JSON.stringify(kept.reading),
      answer: null,
    };
    this.ctx.storage.transactionSync(() => {
      this.#db.insert(documents).values(row).run();
      this.#changed(by, "onboarding.document.read", {
        upload: kept.id,
        asks: kept.reading.ask !== null,
      });
    });
    this.#deliverAudit();
    return documentOf(row);
  }

  /** Keeps the admin's answer to a document's question; null for no such document. */
  answerDocument(
    id: string,
    answer: string,
    by: AuditActor
  ): OnboardingDocument | null {
    const [row] = this.#db
      .select()
      .from(documents)
      .where(eq(documents.id, id))
      .all();
    if (row === undefined) {
      return null;
    }
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(documents)
        .set({ answer })
        .where(eq(documents.id, id))
        .run();
      this.#changed(by, "onboarding.document.answered", { upload: id });
    });
    this.#deliverAudit();
    return documentOf({ ...row, answer });
  }

  /**
   * What the documents give Stephen's context for an interview with
   * `team` (by its name): each document about it, or about no team in
   * particular, with what it leaves open and the admin's answer.
   */
  documentsBrief(team: string): string {
    const about = this.documents().filter(
      ({ reading }) =>
        reading.teams.length === 0 ||
        reading.teams.some((each) => each.toLowerCase() === team.toLowerCase())
    );
    if (about.length === 0) {
      return "";
    }
    const parts = about.map(({ name, reading, answer }) =>
      [
        `## ${name}`,
        reading.about,
        ...(reading.tools.length === 0
          ? []
          : [`Tools it names: ${reading.tools.join(", ")}.`]),
        ...(reading.unclear.length === 0
          ? []
          : [
              "What it leaves open, to ask the people who do the work:",
              ...reading.unclear.map((each) => `- ${each}`),
            ]),
        ...(answer === null || reading.ask === null
          ? []
          : [`Asked "${reading.ask.question}", the admin said: ${answer}`]),
      ].join("\n")
    );
    return `# Documents the company shared\n\n${parts.join("\n\n")}`;
  }

  /** The kickoff as staff see it: when it came in, its reading, the answers. */
  kickoff(): KickoffView {
    const [row] = this.#db.select().from(kickoff).all();
    if (row === undefined) {
      return { transcript: null, reading: null, answers: {} };
    }
    return {
      transcript: {
        at: row.at,
        fileName: row.fileName,
        characters: row.transcript.length,
      },
      reading: storedReadingSchema.parse(JSON.parse(row.reading)),
      answers: storedAnswersSchema.parse(JSON.parse(row.answers)),
    };
  }

  /**
   * Keeps the kickoff's transcript and its reading, replacing any before
   * them; the sponsor's answers stay, for they answer the company, not one
   * transcript. In the log and the audit log without its words.
   */
  saveKickoff(
    kept: {
      transcript: string;
      fileName: string | null;
      reading: KickoffReading;
    },
    by: AuditActor
  ): KickoffView {
    const at = new Date().toISOString();
    const values = {
      at,
      by: whoIs(by),
      fileName: kept.fileName,
      transcript: kept.transcript,
      reading: JSON.stringify(kept.reading),
    };
    this.ctx.storage.transactionSync(() => {
      this.#db
        .insert(kickoff)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: kickoff.id, set: values })
        .run();
      this.#changed(by, "onboarding.kickoff.saved", {
        characters: kept.transcript.length,
        said: Object.keys(kept.reading.fields).length,
      });
    });
    this.#deliverAudit();
    return this.kickoff();
  }

  /**
   * Keeps the sponsor's answer to what the kickoff left open about
   * `field`; an empty one takes it back. False before the kickoff is in.
   */
  answerKickoff(field: VisionField, text: string, by: AuditActor): boolean {
    const [row] = this.#db.select().from(kickoff).all();
    if (row === undefined) {
      return false;
    }
    const trimmed = text.trim();
    const kept = storedAnswersSchema.parse(JSON.parse(row.answers));
    const answers: Partial<Record<VisionField, string>> = {};
    for (const each of visionFields) {
      const answer = each === field ? trimmed : (kept[each] ?? "");
      if (answer !== "") {
        answers[each] = answer;
      }
    }
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(kickoff)
        .set({ answers: JSON.stringify(answers) })
        .where(eq(kickoff.id, 1))
        .run();
      this.#changed(by, "onboarding.kickoff.answered", { field });
    });
    this.#deliverAudit();
    return true;
  }

  /**
   * How much of what Stephen needs from the kickoff is in, 0 to 1: the
   * fields it said, or the sponsor answered, of the ten.
   */
  kickoffKnown(): number {
    const { reading, answers } = this.kickoff();
    const known = visionFields.filter(
      (field) =>
        reading?.fields[field] !== undefined || answers[field] !== undefined
    );
    return known.length / visionFields.length;
  }

  /**
   * When the kickoff came in and how much of it is known, for Grasp's
   * admin (admin-snapshot.ts): null before it is in. No word of it, nor its
   * file's name, leaves the store.
   */
  kickoffFacts(): { at: string; known: number } | null {
    const [row] = this.#db.select({ at: kickoff.at }).from(kickoff).all();
    return row === undefined
      ? null
      : { at: row.at, known: this.kickoffKnown() };
  }

  /** What the kickoff gives Stephen's context: empty before it is in. */
  kickoffBrief(): string {
    const { reading, answers } = this.kickoff();
    return kickoffBrief(reading, answers);
  }

  /** Grasp's notes, the newest first. */
  notes(): StaffNote[] {
    return this.#db.select().from(notes).orderBy(desc(notes.id)).all();
  }

  /** Keeps a note of Grasp's staff, in the log too (without its words). */
  addNote(text: string, by: AuditActor): StaffNote {
    const at = new Date().toISOString();
    const byId = by.type === "staff" ? by.userId : whoIs(by);
    return this.ctx.storage.transactionSync(() => {
      const [note] = this.#db
        .insert(notes)
        .values({ at, by: byId, text })
        .returning()
        .all();
      this.#db
        .insert(events)
        .values({ at, by: whoIs(by), what: "onboarding.note.added" })
        .run();
      if (note === undefined) {
        throw new Error("A note was kept but not returned");
      }
      return note;
    });
  }

  /**
   * What happened, the newest first, at most `logPageMax`, narrowed in
   * the query: everything the onboarding's own log holds, with the person
   * it is about while they are on the roster; and the roster's teams to
   * narrow it by. For Grasp's staff only.
   */
  staffLog(filter: LogFilter = {}): StaffLog {
    const roster = this.#roster();
    const onRoster = roster?.people ?? [];
    const byId = new Map(onRoster.map((one) => [one.id, one] as const));
    const named = (roster?.teams ?? []).map(({ id, name }) => ({ id, name }));
    const about =
      filter.team === undefined
        ? undefined
        : onRoster
            .filter(({ team }) => team === filter.team)
            .map(({ id }) => id);
    if (about?.length === 0) {
      return { entries: [], teams: named };
    }
    const rows = this.#db
      .select()
      .from(events)
      .where(logWhere(filter, about))
      .orderBy(desc(events.seq))
      .limit(logPageMax)
      .all();
    const entries = rows.map((row): StaffLogEntry => {
      const person = row.about === null ? undefined : byId.get(row.about);
      return {
        seq: row.seq,
        at: row.at,
        actor: logActorOf(row.by),
        what: row.what,
        person:
          person === undefined ? null : { id: person.id, name: person.name },
        team: person?.team ?? null,
      };
    });
    return { entries, teams: named };
  }

  /**
   * Someone's interview for Grasp's staff, with who held it and the texts
   * it was held with, and the link's random id to audit its read by.
   */
  transcriptOf(
    person: string
  ): (StaffTranscript & { interviewId: string }) | null {
    const roster = this.#roster();
    const one = roster?.people.find(({ id }) => id === person);
    const [code] = this.#db
      .select({ linkId: linkCodes.linkId })
      .from(linkCodes)
      .where(eq(linkCodes.person, person))
      .all();
    if (one === undefined || code === undefined) {
      return null;
    }
    const state = this.#interviews().get(person);
    const progress = this.#held(person);
    const texts = this.#db
      .select({ mark: interviewTexts.mark })
      .from(interviewTexts)
      .where(eq(interviewTexts.person, person))
      .orderBy(asc(interviewTexts.at), asc(interviewTexts.mark))
      .all();
    return {
      person,
      name: one.name,
      team: roster?.teams.find(({ id }) => id === one.team)?.name ?? "",
      startedAt: state?.startedAt ?? null,
      completedAt: state?.completedAt ?? null,
      progress,
      interviewer:
        progress === null ? null : (progress.interviewer ?? firstInterviewer),
      texts: texts.map(({ mark }) => mark),
      interviewId: code.linkId,
    };
  }

  /**
   * Someone's link's random id, to audit a read of their link by: none
   * for anyone not on the roster.
   */
  linkIdOf(person: string): string | null {
    if (!this.#onRoster(person)) {
      return null;
    }
    const [code] = this.#db
      .select({ linkId: linkCodes.linkId })
      .from(linkCodes)
      .where(eq(linkCodes.person, person))
      .all();
    return code?.linkId ?? null;
  }

  /**
   * Notes the one reminder as sent by hand, by Grasp's staff, to each of
   * `whom` whose link is out, who hasn't agreed to their interview and
   * wasn't reminded before: once, ever. Returns who it was noted for. The
   * audit log has how many, never who.
   */
  remind(
    whom: readonly string[],
    by: AuditActor,
    now: string = new Date().toISOString()
  ): string[] {
    const wanted = new Set(whom);
    const talked = this.#interviews();
    const due = this.#db
      .select({ person: links.person })
      .from(links)
      .where(isNull(links.remindedAt))
      .all()
      .map(({ person }) => person)
      .filter(
        (person) =>
          wanted.has(person) &&
          (talked.get(person)?.completedAt ?? null) === null
      );
    if (due.length === 0) {
      return [];
    }
    this.ctx.storage.transactionSync(() => {
      for (const person of due) {
        this.#db
          .update(links)
          .set({ remindedAt: now })
          .where(eq(links.person, person))
          .run();
        this.#noted(person, "interview.reminded", now, whoIs(by));
      }
      this.#changed(by, "onboarding.reminded", { count: due.length });
    });
    this.#deliverAudit();
    return due;
  }

  /**
   * A team that didn't take part takes part from now on, as the company's
   * list then says: its lead's link goes out first, by the plan. False for
   * a team not on the list.
   */
  askIn(team: string, by: AuditActor): boolean {
    const [row] = this.#db
      .select({ off: teams.off })
      .from(teams)
      .where(eq(teams.id, team))
      .all();
    if (row === undefined) {
      return false;
    }
    if (row.off) {
      this.ctx.storage.transactionSync(() => {
        this.#db
          .update(teams)
          .set({ off: false })
          .where(eq(teams.id, team))
          .run();
        this.#changed(by, "onboarding.team.asked_in", {});
      });
      this.#deliverAudit();
    }
    return true;
  }

  /**
   * Deletes someone's interview because they asked Grasp to: what they
   * said is gone at once, a copy left open can't save it back, and their
   * link opens a new one on the device it is on. False when no link of
   * theirs went out. The audit log has that staff did, not for whom.
   */
  deleteOnRequest(
    person: string,
    by: AuditActor,
    now: string = new Date().toISOString()
  ): boolean {
    const [link] = this.#db
      .select()
      .from(links)
      .where(eq(links.person, person))
      .all();
    if (link === undefined) {
      return false;
    }
    this.ctx.storage.transactionSync(() => {
      this.#forget(person, now, "interview.deleted", whoIs(by));
      this.#db
        .update(links)
        .set({ deletedAt: now, version: link.version + 1 })
        .where(eq(links.person, person))
        .run();
      this.#changed(by, "onboarding.interview.deleted", {});
    });
    this.#deliverAudit();
    return true;
  }

  /** What Grasp's staff see of where the interviews stand: exact, by person. */
  staffFacts(): {
    sent: { person: string; sentAt: string }[];
    interviews: InterviewState[];
  } {
    return {
      sent: this.#db
        .select({ person: links.person, sentAt: links.sentAt })
        .from(links)
        .all(),
      interviews: [...this.#interviews().values()],
    };
  }

  /**
   * What Grasp's admin reads of the links and interviews (admin-snapshot.ts),
   * by person: each link's times, and each interview as numbers. What was
   * said is read here, inside the store, and only its counts leave it.
   */
  adminFacts(): {
    told: boolean;
    mapped: string[];
    links: Omit<typeof links.$inferSelect, "keyMark" | "version" | "ledTeam">[];
    interviews: AdminInterviewFacts[];
  } {
    // Only the counts are kept, read a page of interviews at a time, so a
    // read of a large roster never holds every conversation at once. One
    // interview's progress this core can't read leaves that interview with
    // no counts, not the whole read failing; the log names the person by
    // id alone, never what was kept.
    const countsBy = new Map<string, InterviewCounts>();
    let after = "";
    for (;;) {
      const page = this.#db
        .select({ person: interviews.person, progress: interviews.progress })
        .from(interviews)
        .where(gt(interviews.person, after))
        .orderBy(asc(interviews.person))
        .limit(adminFactsPage)
        .all();
      for (const row of page) {
        const progress = interviewProgressSchema.safeParse(
          parsedJson(row.progress)
        );
        if (progress.success) {
          countsBy.set(row.person, countsOf(progress.data));
        } else {
          log.warn("onboarding.admin_facts.unreadable", { person: row.person });
        }
      }
      const last = page.at(-1);
      if (last === undefined || page.length < adminFactsPage) {
        break;
      }
      after = last.person;
    }
    const [row] = this.#db
      .select({ toldAt: onboarding.toldAt })
      .from(onboarding)
      .where(eq(onboarding.id, 1))
      .all();
    const sent = this.#db
      .select({
        person: links.person,
        sentAt: links.sentAt,
        openedAt: links.openedAt,
        remindedAt: links.remindedAt,
        deletedAt: links.deletedAt,
      })
      .from(links)
      .all();
    return {
      told: (row?.toldAt ?? null) !== null || sent.length > 0,
      mapped: this.#db
        .select({ id: teams.id })
        .from(teams)
        .where(isNotNull(teams.mappedAt))
        .all()
        .map(({ id }) => id),
      links: sent,
      interviews: this.#db
        .select()
        .from(interviewStates)
        .all()
        .map((state) => ({
          ...state,
          ...(countsBy.get(state.person) ?? noCounts),
        })),
    };
  }

  /**
   * Delivers audit events the log didn't take yet, and releases every link
   * that is due while the interviews are open; then sets itself again for
   * the next.
   */
  override async alarm(): Promise<void> {
    await this.#drainAudit();
    await this.releaseDue();
    // A team's map opens its links.
    if ((await this.drawNext()) !== null) {
      await this.releaseDue();
    }
    await this.intakeNext();
    await this.remindDue();
    await this.sendUpdate();
    await this.deliverMail();
    await this.#armLinks();
    await this.#armDrawing();
  }

  /**
   * Queues a mail (mail-outbox.ts) and sends it in the background: once
   * by its key, which starts with its kind (`link/…`), so queuing it again
   * sends nothing. False when its key was queued already.
   */
  sendMail(mail: MailToQueue): boolean {
    const queued = this.ctx.storage.transactionSync(() =>
      queueMail(this.ctx.storage.sql, mail)
    );
    this.#deliverMailSoon();
    return queued;
  }

  /** What became of the mail `key`; null for none queued. */
  mailOf(key: string): MailState | null {
    return mailState(this.ctx.storage.sql, key);
  }

  /**
   * Sends the mail due by `now`, after any delivery already running, and
   * sets the alarm for the next mail due. Returns when that is, or null.
   */
  async deliverMail(now: number = Date.now()): Promise<number | null> {
    const before = this.#mailing;
    const run = (async () => {
      await before;
      return await deliverMail(this.ctx.storage.sql, {
        send: async (mail) => await sendMail(this.env, mail),
        fill: async (person) => await this.#linkFill(person),
        settled: (state) => {
          this.#mailSettled(state, now);
        },
        now,
      });
    })();
    this.#mailing = quietly(run);
    const next = await run;
    if (next !== null) {
      await this.#alarmBy(next);
    }
    return next;
  }

  /**
   * Releases every link due by `now`, while the interviews are open, and
   * emails each to whoever has an address (the others' are handed to them).
   * Returns whose.
   */
  async releaseDue(now: string = new Date().toISOString()): Promise<string[]> {
    // First: no other call comes in between what is read below and the
    // transaction that sends.
    const said = await this.#mailContext();
    const roster = this.#roster();
    const { plan } = this.#row();
    if (roster === null || plan === null || !this.isOpen()) {
      return [];
    }
    const due = dueLinks(roster, plan, this.#linkFacts(), now);
    if (due.length === 0) {
      return [];
    }
    this.ctx.storage.transactionSync(() => {
      // The first link out tells the team, for good.
      this.#db
        .update(onboarding)
        .set({ toldAt: sql`coalesce(${onboarding.toldAt}, ${now})` })
        .where(eq(onboarding.id, 1))
        .run();
      for (const person of due) {
        // Whether they lead a team is kept as it is now, when their link
        // goes out: a lead named later never makes theirs a lead's interview.
        const ledTeam =
          roster.teams.find(({ lead: led }) => led === person)?.id ?? null;
        this.#db.insert(links).values({ person, sentAt: now, ledTeam }).run();
        this.#queuePersonMail(
          { roster, plan, said, person, sentAt: now },
          "link"
        );
        const team = roster.people.find(({ id }) => id === person)?.team;
        if (team !== undefined && ledTeam === null) {
          // Asked once ever: a person taken off and on again isn't asked twice.
          const added = this.#db
            .insert(countedPeople)
            .values({ person, team, talked: false })
            .onConflictDoNothing()
            .returning()
            .all();
          if (added.length > 0) {
            this.#count(team, now, { asked: 1 });
          }
        }
      }
      this.#changed({ type: "system" }, "onboarding.links.sent", {
        count: due.length,
      });
    });
    this.#deliverAudit();
    this.#deliverMailSoon();
    return due;
  }

  /**
   * Sends the one reminder to everyone who hasn't finished
   * `remindAfterWorkingDays` after their link went out, while the
   * interviews run: never to someone who deleted their interview, and
   * never twice. Returns whom.
   */
  async remindDue(now: string = new Date().toISOString()): Promise<string[]> {
    const said = await this.#mailContext();
    const roster = this.#roster();
    const { plan } = this.#row();
    if (
      roster === null ||
      plan === null ||
      !this.isOpen() ||
      dayOf(now) > closesOn(plan)
    ) {
      return [];
    }
    const due = this.#remindable(roster, now);
    if (due.length === 0) {
      return [];
    }
    this.ctx.storage.transactionSync(() => {
      for (const { person, sentAt } of due) {
        this.#db
          .update(links)
          .set({ remindedAt: now })
          .where(eq(links.person, person))
          .run();
        this.#queuePersonMail(
          { roster, plan, said, person, sentAt },
          "reminder",
          now
        );
      }
    });
    this.#deliverMailSoon();
    return due.map(({ person }) => person);
  }

  /**
   * Sends the company's onboarding admin their update, on a Monday or a
   * Thursday after the interviews started and until they close, once a
   * day: the numbers they see themselves (`view()`), nothing more. False
   * when none goes, or it went already.
   */
  async sendUpdate(now: string = new Date().toISOString()): Promise<boolean> {
    const { replyTo: to, ...said } = await this.#mailContext();
    const { plan } = this.#row();
    const day = dayOf(now);
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (
      plan === null ||
      !this.isOpen() ||
      !updateWeekdays.has(weekday) ||
      day <= plan.start ||
      day > closesOn(plan)
    ) {
      return false;
    }
    const { progress } = this.view(now);
    if (progress === null || to === undefined) {
      return false;
    }
    const queued = this.ctx.storage.transactionSync(() =>
      queueMail(
        this.ctx.storage.sql,
        {
          key: `update/${day}`,
          to,
          about: null,
          fill: null,
          mail: updateMail({
            ...said,
            closes: closesOn(plan),
            numbers: progress,
          }),
        },
        Date.parse(now)
      )
    );
    this.#deliverMailSoon();
    return queued;
  }

  /**
   * What every onboarding mail is written with: the company's name (its
   * sign-in domain while it has none), the language Stephen interviews in
   * first, and the company's onboarding admin, the first admin its
   * sign-in names. The roster has no language of each person's own: they
   * choose theirs once their link opens.
   */
  async #mailContext(): Promise<MailContext> {
    const config = signInConfig(this.env);
    // The deployment's one organization (organization.ts), read here
    // without it: its module reaches sign-in, which reaches this store.
    const [row] = await drizzleD1(this.env.DB)
      .select({ name: organizations.name })
      .from(organizations)
      .limit(1);
    const name = row?.name ?? "";
    return {
      company: name === "" ? (config?.domains[0] ?? "") : name,
      locale: this.stephen().setup.languages[0] ?? "en",
      replyTo: config?.admins[0],
    };
  }

  /**
   * Whose reminder is due by `now`: their link out by email, and not
   * finished. A link handed over on paper is the admin's to remind about.
   */
  #remindable(
    roster: Roster,
    now: string
  ): { person: string; sentAt: string }[] {
    const states = this.#interviews();
    const taking = new Set(
      roster.people
        .filter((person) => takingPart(roster, person) && person.email !== "")
        .map(({ id }) => id)
    );
    return this.#db
      .select()
      .from(links)
      .orderBy(asc(links.sentAt), asc(links.person))
      .all()
      .filter(
        (link) =>
          link.remindedAt === null &&
          link.deletedAt === null &&
          (states.get(link.person)?.completedAt ?? null) === null &&
          taking.has(link.person) &&
          dayOf(now) >=
            addWorkingDays(dayOf(link.sentAt), remindAfterWorkingDays)
      )
      .map(({ person, sentAt }) => ({ person, sentAt }));
  }

  /**
   * Queues someone's link mail or reminder, keyed by when their link went
   * out, in the transaction that sends it; none for someone without an
   * address. Their link fills in as it is sent.
   */
  #queuePersonMail(
    {
      roster,
      plan,
      said,
      person: id,
      sentAt,
    }: {
      roster: Roster;
      plan: Plan;
      said: MailContext;
      person: string;
      sentAt: string;
    },
    kind: "link" | "reminder",
    now: string = sentAt
  ): void {
    const person = roster.people.find((each) => each.id === id);
    if (person === undefined || person.email === "") {
      return;
    }
    const words = {
      ...said,
      name: firstName(person.name),
      closes: closesOn(plan),
    };
    queueMail(
      this.ctx.storage.sql,
      {
        key: `${kind}/${person.id}/${sentAt}`,
        to: person.email,
        about: person.id,
        fill: person.id,
        mail:
          kind === "link"
            ? linkMail({
                ...words,
                kind: leads(roster, person.id) ? "lead" : "own",
              })
            : reminderMail(words),
      },
      Date.parse(now)
    );
  }

  /** Sends the mail due now in the background; the alarm retries what is left. */
  #deliverMailSoon(): void {
    this.ctx.waitUntil(this.deliverMail());
  }

  /**
   * What fills the `{{link}}` slot of a mail with someone's link: the
   * link, made as the mail goes. Null once it can't be: they are off the
   * roster, or their link isn't out; or the deployment has no address.
   */
  async #linkFill(person: string): Promise<Record<string, string> | null> {
    const origin = signInConfig(this.env)?.origin;
    const [sent] = this.#db
      .select({ person: links.person })
      .from(links)
      .where(eq(links.person, person))
      .all();
    if (origin === undefined || sent === undefined) {
      return null;
    }
    const path = await this.linkOf(person);
    return path === null ? null : { link: `${origin}${path}` };
  }

  /**
   * Records in the log that a mail was sent or ended failed, and why, by
   * its kind: `mail.link.sent`, `mail.link.failed.recipient_suppressed`.
   * Never its words or its address.
   */
  #mailSettled(state: MailState, now: number): void {
    const [kind = "mail"] = state.key.split("/");
    const reason = (state.reason ?? "unknown")
      .replace(/^E_|^mail\./u, "")
      .toLowerCase();
    const what =
      state.state === "sent"
        ? `mail.${kind}.sent`
        : `mail.${kind}.failed.${reason}`;
    this.#db
      .insert(events)
      .values({
        at: new Date(now).toISOString(),
        by: whoIs({ type: "system" }),
        what,
        about: state.about,
      })
      .run();
  }

  #linkFacts() {
    return {
      sent: new Set(
        this.#db
          .select({ person: links.person })
          .from(links)
          .all()
          .map(({ person }) => person)
      ),
      interviews: this.#interviews(),
      mapped: new Set(
        this.#db
          .select({ id: teams.id })
          .from(teams)
          .where(isNotNull(teams.mappedAt))
          .all()
          .map(({ id }) => id)
      ),
    };
  }

  /**
   * Sets the alarm for the next team moment still to come, and at most an
   * hour out while anyone's link is still to go, or the interviews run: a
   * lead's map can make a team's links due at any time, and reminders and
   * the admin's update fall due by the day.
   */
  async #armLinks(): Promise<void> {
    const roster = this.#roster();
    const { plan } = this.#row();
    if (roster === null || plan === null || !this.isOpen()) {
      return;
    }
    const { sent } = this.#linkFacts();
    const waiting = roster.people.filter(
      (person) => takingPart(roster, person) && !sent.has(person.id)
    );
    // While the interviews run, reminders and the admin's update fall due.
    const running = dayOf(new Date().toISOString()) <= closesOn(plan);
    if (waiting.length === 0 && !running) {
      return;
    }
    const now = Date.now();
    const moments = waiting
      .map((person) => sendsFrom(plan, person.team))
      .filter((moment) => moment !== null)
      .map((moment) => Date.parse(moment))
      .filter((moment) => moment > now);
    await this.#alarmBy(Math.min(now + linkCheckMs, ...moments));
  }

  /**
   * The teams whose map is due: a lead who agreed to something not drawn
   * yet. With when each may be drawn, and how often it failed so far.
   */
  #teamsToMap(
    now: number
  ): { id: string; lead: string; after: number; tries: number }[] {
    const roster = this.#roster();
    if (roster === null) {
      return [];
    }
    const due = new Set(this.drawsDue());
    const failures = new Map(
      this.#db
        .select()
        .from(drawFailures)
        .all()
        .map((row) => [row.item, row])
    );
    return roster.teams.flatMap(({ id, lead, off }) => {
      if (off || lead === null || !due.has(lead)) {
        return [];
      }
      const failed = failures.get(`team:${id}`);
      return [
        {
          id,
          lead,
          after: failed === undefined ? now : Date.parse(failed.after),
          tries: failed?.tries ?? 0,
        },
      ];
    });
  }

  /**
   * Everything due to be drawn, in the order it's drawn in: the teams'
   * maps first, so a piece of work is drawn from who does it.
   */
  #dueToDraw(now: number): {
    item: string;
    id: string;
    about: string;
    after: number;
    tries: number;
    work?: WorkToDraw;
  }[] {
    return [
      ...this.#teamsToMap(now).map((team) => ({
        ...team,
        item: `team:${team.id}`,
        about: team.lead,
      })),
      ...this.#worksToDraw(now).map((work) => ({
        item: `work:${work.id}`,
        id: work.id,
        about: work.about,
        after: work.after,
        tries: work.tries,
        work,
      })),
    ];
  }

  /**
   * The pieces of work due to be drawn: someone who does one, or who is
   * asked about it, agreed to something since it was last drawn. Not
   * before someone other than the lead agreed: the lead's interview was
   * about the whole team, so it tells a piece of work alone only when it
   * is the lead's own. The longest waiting first.
   */
  #worksToDraw(now: number): WorkToDraw[] {
    const roster = this.#roster();
    if (roster === null) {
      return [];
    }
    const agreedAt = new Map(
      this.#db
        .select({
          person: interviewStates.person,
          agreedAt: interviewStates.agreedAt,
        })
        .from(interviewStates)
        .where(isNotNull(interviewStates.agreedAt))
        .all()
        .map(({ person, agreedAt: at }) => [person, at ?? ""])
    );
    const asked = this.#db.select().from(askedAbout).all();
    const drawnFrom = new Map(
      this.#db
        .select({ work: drawnWorks.work, agreed: drawnWorks.agreed })
        .from(drawnWorks)
        .all()
        .map(({ work, agreed }) => [work, agreedOf(agreed)])
    );
    const failures = new Map(
      this.#db
        .select()
        .from(drawFailures)
        .all()
        .map((row) => [row.item, row])
    );
    const teamsOn = new Map(
      roster.teams.filter(({ off }) => !off).map((team) => [team.id, team])
    );
    const onRoster = new Set(roster.people.map(({ id }) => id));
    const due = this.#db
      .select()
      .from(works)
      .all()
      .flatMap((row): (WorkToDraw & { since: string })[] => {
        const team = teamsOn.get(row.team);
        if (team === undefined) {
          return [];
        }
        const doers = doersOf(row.doers);
        const tellers = [
          ...new Set([
            ...doers,
            ...asked
              .filter(({ work }) => work === row.id)
              .map(({ person }) => person),
          ]),
        ].filter((id) => onRoster.has(id) && agreedAt.has(id));
        const agreed = Object.fromEntries(
          tellers.map((id) => [id, agreedAt.get(id) ?? ""])
        );
        const leadsOwn =
          doers.length > 0 && doers.every((id) => id === team.lead);
        const before = drawnFrom.get(row.id) ?? {};
        const since = tellers
          .filter((id) => before[id] !== agreed[id])
          .map((id) => agreed[id] ?? "")
          .toSorted();
        const [first] = since;
        const last = since.at(-1);
        if (
          first === undefined ||
          (!leadsOwn && tellers.every((id) => id === team.lead))
        ) {
          return [];
        }
        const failed = failures.get(`work:${row.id}`);
        return [
          {
            id: row.id,
            team: row.team,
            agreed,
            about:
              tellers.find((id) => agreed[id] === last) ?? tellers[0] ?? "",
            after: failed === undefined ? now : Date.parse(failed.after),
            tries: failed?.tries ?? 0,
            since: first,
          },
        ];
      });
    return due
      .toSorted((a, b) => a.since.localeCompare(b.since))
      .map(({ since: _since, ...work }) => work);
  }

  /**
   * Draws one piece of work from the agreed facts of everyone who does it
   * or is asked about it. The lead's interview was about the whole team,
   * so it tells a piece of work only when nobody else who does it has
   * talked: their own work, say. Otherwise what the lead agreed to is
   * there for context. Drawn, unless someone agreed to more meanwhile:
   * then it's drawn once more. Someone it rests on whose interview went
   * while it was drawn takes the drawing with them.
   */
  async #drawWork(due: WorkToDraw, at: string): Promise<void> {
    const roster = this.#roster();
    const team = roster?.teams.find(({ id }) => id === due.team);
    const work = this.teamWorks(due.team).find(({ id }) => id === due.id);
    if (roster === null || team === undefined || work === undefined) {
      return;
    }
    const inputs = Object.keys(due.agreed).flatMap((person) => {
      const input = this.drawInput(person);
      return input === null ? [] : [input];
    });
    const others = inputs.filter(({ person }) => person !== team.lead);
    const telling = others.length > 0 ? others : inputs;
    const leadInput =
      team.lead !== null && telling.every(({ person }) => person !== team.lead)
        ? this.drawInput(team.lead)
        : null;
    if (telling.length === 0) {
      // Nothing agreed to draw from: noted as drawn as it is, so it isn't due again and again.
      this.#keepDrawing(due, null, at);
      return;
    }
    const asked = new Map(
      this.#db
        .select()
        .from(askedAbout)
        .all()
        .map(({ person, work: of }) => [person, of])
    );
    const names = new Map(
      this.#db
        .select({ id: works.id, name: works.name })
        .from(works)
        .all()
        .map(({ id, name }) => [id, name])
    );
    const tellers = telling.map(({ person, facts }) => {
      const who = roster.people.find(({ id }) => id === person);
      const of = asked.get(person);
      let about;
      if (person === team.lead) {
        about = "the work of the whole team";
      } else if (of !== undefined && of !== work.id) {
        about = names.get(of);
      }
      return {
        person,
        title: who?.title ?? "",
        facts,
        example:
          this.#held(person)?.lines.find(({ file }) => file !== undefined)
            ?.file ?? null,
        ...(about === undefined ? {} : { about }),
      };
    });
    const brief: WorkBrief = {
      company: await companyName(this.env),
      team: team.name,
      teams: roster.teams
        .filter(({ id }) => id !== team.id)
        .map(({ name }) => name),
      work: { name: work.name, local: work.local, one: work.one },
      lead: leadInput?.facts.map(({ record }) => record) ?? [],
      tellers,
      documents: this.documentsBrief(team.name),
    };
    const drawn = await drawWork(this.env, brief, (took) => {
      this.meter(took, at);
    });
    this.ctx.storage.transactionSync(() => {
      const gone = [
        ...drawn.from,
        ...(leadInput === null ? [] : [leadInput.person]),
      ].some((person) => this.#agreedAt(person) === null);
      if (gone) {
        return;
      }
      this.#keepDrawing(due, drawn, at);
    });
  }

  /**
   * Keeps a piece of work as drawn, from whose agreements, or as it was
   * when `drawn` is null; and notes as drawn whoever it was drawn for
   * that has nothing else waiting to be drawn.
   */
  #keepDrawing(due: WorkToDraw, drawn: DrawnWork | null, at: string): void {
    const exists = this.#db
      .select({ id: works.id })
      .from(works)
      .where(eq(works.id, due.id))
      .all();
    if (exists.length === 0) {
      return;
    }
    const agreed = JSON.stringify(due.agreed);
    this.#db
      .insert(drawnWorks)
      .values({
        work: due.id,
        drawn: drawn === null ? null : JSON.stringify(drawn),
        agreed,
        at,
      })
      .onConflictDoUpdate({
        target: drawnWorks.work,
        set: {
          ...(drawn === null ? {} : { drawn: JSON.stringify(drawn) }),
          agreed,
          at,
        },
      })
      .run();
    const lead = this.#roster()?.teams.find(({ id }) => id === due.team)?.lead;
    const waiting = this.#worksToDraw(Date.now());
    for (const [person, agreedAt] of Object.entries(due.agreed)) {
      // A lead's own drawing is the team's map.
      if (
        person !== lead &&
        !waiting.some((work) => person in work.agreed) &&
        this.#agreedAt(person) === agreedAt
      ) {
        this.drawn(person, agreedAt);
      }
    }
    if (drawn !== null) {
      this.#noted(due.about, "work.drawn", at, "grasp");
      this.#brainDue(due.team, at);
    }
  }

  /** Notes that something new of a team waits to be given to the brain. */
  #brainDue(team: string, at: string): void {
    this.#db
      .insert(brainTeams)
      .values({ team, dueAt: at })
      .onConflictDoUpdate({ target: brainTeams.team, set: { dueAt: at } })
      .run();
  }

  /** Notes a team given to the brain as it was at `dueAt`: unless something new came since. */
  #brainSettled(team: string, dueAt: string): void {
    this.#db
      .update(brainTeams)
      .set({ dueAt: null })
      .where(and(eq(brainTeams.team, team), eq(brainTeams.dueAt, dueAt)))
      .run();
  }

  /** The teams waiting to be given to the brain, the longest first, with when each may be and how often it failed. */
  #brainDueAt(
    now: number
  ): { team: string; dueAt: string; after: number; tries: number }[] {
    const failures = new Map(
      this.#db
        .select()
        .from(drawFailures)
        .where(like(drawFailures.item, "brain:%"))
        .all()
        .map((row) => [row.item, row])
    );
    return this.#db
      .select({ team: brainTeams.team, dueAt: brainTeams.dueAt })
      .from(brainTeams)
      .where(isNotNull(brainTeams.dueAt))
      .orderBy(asc(brainTeams.dueAt), asc(brainTeams.team))
      .all()
      .flatMap(({ team, dueAt }) => {
        if (dueAt === null) {
          return [];
        }
        const failed = failures.get(`brain:${team}`);
        return [
          {
            team,
            dueAt,
            after: failed === undefined ? now : Date.parse(failed.after),
            tries: failed?.tries ?? 0,
          },
        ];
      });
  }

  /**
   * What a team gives the brain, from the store: its name, everyone's
   * names (for none to reach it), the facts each person who told their
   * own work agreed to, and its pieces of work as drawn. Never the lead's
   * facts, whose role alone says who they are, nor a piece of work drawn
   * from the lead alone. None while fewer than `brainFloor` of its people
   * agreed: it waits.
   */
  #teamIntake(teamId: string): TeamIntake | null {
    const roster = this.#roster();
    const team = roster?.teams.find(({ id }) => id === teamId);
    if (roster === null || team === undefined || team.off) {
      return null;
    }
    const members = roster.people.filter((person) => person.team === teamId);
    const agreed = members.filter(({ id }) => this.#agreedAt(id) !== null);
    if (agreed.length < brainFloor) {
      return null;
    }
    const { lead } = team;
    const leadAgreed =
      lead !== null && this.#agreedAt(lead) !== null ? [lead] : [];
    return {
      team: { id: team.id, name: team.name },
      names: roster.people.map(({ name }) => name),
      tellers: agreed.flatMap(({ id }) => {
        const input = this.drawInput(id);
        return input === null || input.kind !== "own" || id === lead
          ? []
          : [{ person: id, facts: input.facts }];
      }),
      works: this.teamWorks(teamId).flatMap((work) => {
        const { drawn } = work;
        if (
          drawn === null ||
          drawn.from.length === 0 ||
          drawn.from.every((person) => person === lead)
        ) {
          return [];
        }
        return [
          {
            id: work.id,
            name: work.name,
            local: work.local,
            one: work.one,
            drawn,
            state: work.known.state,
            namedBy: leadAgreed,
            context: leadAgreed.filter((id) => !drawn.from.includes(id)),
          },
        ];
      }),
    };
  }

  /**
   * Gives the brain what a team learned, as it was due at `dueAt`
   * (brain-intake.ts), as the onboarding, which owns those records: kept
   * once each, so giving it again adds only what is new. Then notes who
   * each rests on, here alone.
   */
  async #intakeTeam(teamId: string, dueAt: string, at: string): Promise<void> {
    const intake = this.#teamIntake(teamId);
    if (intake === null || this.rosterSavedAt() === null) {
      this.#brainSettled(teamId, dueAt);
      return;
    }
    const { records, rests } = await intakeOf(intake);
    await keepOnboardingRecords(this.env, records, {
      sources: new Set([rosterSource, await intakeIds.interviews(teamId)]),
      teams: new Set([intakeIds.team(teamId)]),
    });
    this.ctx.storage.transactionSync(() => {
      // One row a statement: within SQLite's bound parameters.
      for (const rest of rests) {
        this.#db
          .insert(brainSent)
          .values({ ...rest, team: teamId })
          .onConflictDoNothing()
          .run();
      }
      this.#db
        .update(brainTeams)
        .set({ sentAt: sql`coalesce(${brainTeams.sentAt}, ${at})` })
        .where(eq(brainTeams.team, teamId))
        .run();
      this.#brainSettled(teamId, dueAt);
    });
  }

  /**
   * Stops drawing a piece of work that keeps failing, until someone agrees
   * to something new about it: what was drawn of it before stays.
   */
  #giveUpWork(due: WorkToDraw, at: string): void {
    this.ctx.storage.transactionSync(() => {
      this.#db
        .delete(drawFailures)
        .where(eq(drawFailures.item, `work:${due.id}`))
        .run();
      this.#keepDrawing(due, null, at);
      this.#noted(due.about, "work.gave_up", at, "grasp");
    });
  }

  /** The drawing of the piece of work someone is asked about; null before it is drawn. */
  #drawingAskedOf(person: string): DrawnWork | null {
    const [row] = this.#db
      .select({ drawn: drawnWorks.drawn })
      .from(askedAbout)
      .innerJoin(drawnWorks, eq(drawnWorks.work, askedAbout.work))
      .where(eq(askedAbout.person, person))
      .all();
    return drawingOf(row?.drawn ?? null);
  }

  /** Forgets the drawings of pieces of work that are gone. */
  #dropOrphanDrawings(): void {
    this.#db
      .delete(drawnWorks)
      .where(sql`${drawnWorks.work} not in (select ${works.id} from ${works})`)
      .run();
  }

  /** Sets the alarm for the next thing to draw, when there is one. */
  async #armDrawing(): Promise<void> {
    const now = Date.now();
    const drawing = this.#dueToDraw(now);
    const drawn = new Set(drawing.map(({ id, work }) => work?.team ?? id));
    // A team still being drawn goes to the brain once it is drawn.
    const afters = [
      ...drawing.map(({ after }) => after),
      ...this.#brainDueAt(now).flatMap(({ team, after }) =>
        drawn.has(team) ? [] : [after]
      ),
    ];
    if (afters.length > 0) {
      await this.#alarmBy(Math.max(Math.min(...afters), now + drawNextMs));
    }
  }

  /**
   * Draws a team's map from what its lead agreed to, then asks everyone in
   * it about a piece of work. Drawn again, a piece keeps its id while its
   * name stays, and one someone was asked about stays; whoever was asked
   * about one keeps it, and only who has none gets one. What changed while
   * it was drawn stands: the store is read again after, and only this
   * team's part changes. Mapped, unless the lead agreed to more meanwhile:
   * then it's drawn once more.
   */
  async #mapTeam(teamId: string, at: string): Promise<void> {
    const roster = this.#roster();
    const team = roster?.teams.find(({ id }) => id === teamId);
    const input =
      team?.lead === null || team?.lead === undefined
        ? null
        : this.drawInput(team.lead);
    if (roster === null || team === undefined) {
      return;
    }
    if (input === null) {
      // Due with nothing agreed to draw from (agreed before facts were
      // marked agreed): drawn as it is, so it isn't due again and again.
      const agreedAt = team.lead === null ? null : this.#agreedAt(team.lead);
      if (team.lead !== null && agreedAt !== null) {
        this.drawn(team.lead, agreedAt);
      }
      return;
    }
    const company = await companyName(this.env);
    const map = await drawTeamMap(
      this.env,
      {
        company,
        team: team.name,
        locale: this.#teamLocale(),
        people: roster.people
          .filter(
            (person) =>
              person.team === team.id &&
              (person.id === team.lead || !person.away)
          )
          .map(({ id, name, title }) => ({
            id,
            name,
            title,
            lead: id === team.lead,
          })),
        facts: input.facts,
        documents: this.documentsBrief(team.name),
      },
      (took) => {
        this.meter(took, at);
      }
    );
    this.ctx.storage.transactionSync(() => {
      const now = this.#roster();
      const still = now?.teams.find(({ id }) => id === teamId);
      if (now === null || still === undefined) {
        return;
      }
      const members = now.people.filter(({ team: of }) => of === teamId);
      const before = this.teamWorks(teamId);
      const asked = new Map(
        this.#db
          .select()
          .from(askedAbout)
          .all()
          .map(({ person, work }) => [person, work])
      );
      const drawn = map.works.map((work) => ({
        ...work,
        id:
          before.find(({ name }) => name.toLowerCase() === work.name)?.id ??
          `w-${crypto.randomUUID().slice(0, 8)}`,
        doers: [...work.doers],
      }));
      // A piece someone was asked about, or one drawn already, stays,
      // though the map no longer names it.
      for (const old of before) {
        if (
          !drawn.some(({ id }) => id === old.id) &&
          (old.drawn !== null ||
            members.some(({ id }) => asked.get(id) === old.id))
        ) {
          drawn.push({ ...old, doers: [...old.doers] });
        }
      }
      const open = members.filter(
        ({ id, away }) =>
          id !== still.lead &&
          !away &&
          !drawn.some((work) => work.id === asked.get(id))
      );
      const assigned = assignWork(open, drawn, members);
      // Whoever is asked about a piece of work also does it, as far as the record goes.
      for (const work of drawn) {
        for (const { id } of members) {
          const theirs = assigned.has(id) ? assigned.get(id) : asked.get(id);
          if (theirs === work.id && !work.doers.includes(id)) {
            work.doers.push(id);
          }
        }
      }
      this.#db.delete(works).where(eq(works.team, teamId)).run();
      for (const [position, work] of drawn.entries()) {
        this.#db
          .insert(works)
          .values({
            id: work.id,
            team: teamId,
            position,
            name: work.name,
            local: work.local,
            one: work.one,
            many: work.many,
            doers: JSON.stringify(work.doers),
            share: work.share,
          })
          .run();
      }
      for (const [person, work] of assigned) {
        if (work !== null) {
          this.#db
            .insert(askedAbout)
            .values({ person, work })
            .onConflictDoUpdate({ target: askedAbout.person, set: { work } })
            .run();
        }
      }
      const agreedAt = this.#agreedAt(input.person);
      this.drawn(input.person, input.agreedAt);
      this.#db
        .update(teams)
        .set({
          does: map.does === "" ? still.does : map.does,
          ...(agreedAt === input.agreedAt
            ? { mappedAt: sql`coalesce(${teams.mappedAt}, ${at})` }
            : {}),
        })
        .where(eq(teams.id, teamId))
        .run();
      this.#dropOrphanDrawings();
      this.#noted(input.person, "map.drawn", at, "grasp");
    });
  }

  /**
   * Stops drawing a team's map that keeps failing, until its lead agrees to
   * something new or staff draw it again: its people get their links all
   * the same, and Stephen asks each what work they do.
   */
  #giveUp(teamId: string, lead: string, at: string): void {
    this.ctx.storage.transactionSync(() => {
      this.#db
        .delete(drawFailures)
        .where(eq(drawFailures.item, `team:${teamId}`))
        .run();
      const agreedAt = this.#agreedAt(lead);
      if (agreedAt !== null) {
        this.drawn(lead, agreedAt);
      }
      this.#db
        .update(teams)
        .set({ mappedAt: sql`coalesce(${teams.mappedAt}, ${at})` })
        .where(eq(teams.id, teamId))
        .run();
      this.#noted(lead, "map.gave_up", at, "grasp");
    });
  }

  #agreedAt(person: string): string | null {
    const [state] = this.#db
      .select({ agreedAt: interviewStates.agreedAt })
      .from(interviewStates)
      .where(eq(interviewStates.person, person))
      .all();
    return state?.agreedAt ?? null;
  }

  /** The piece of work someone is asked about, in their team's language; empty before the map. */
  #workOf(person: string): string {
    const [row] = this.#db
      .select({ local: works.local })
      .from(askedAbout)
      .innerJoin(works, eq(works.id, askedAbout.work))
      .where(eq(askedAbout.person, person))
      .all();
    return row?.local ?? "";
  }

  /** The language the teams speak: the first Stephen interviews in. */
  #teamLocale(): InterviewLocale {
    return (
      setupView(this.#stephen(), this.kickoff()).setup.languages[0] ?? "en"
    );
  }

  /** Sets the alarm to go at `time` at the latest, never later than it was. */
  async #alarmBy(time: number): Promise<void> {
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > time) {
      await this.ctx.storage.setAlarm(time);
    }
  }

  /**
   * The person a link's secret is theirs, when the link may be used for
   * `use` now: on the roster, sent, counted within its limit; to open or
   * save, also while the interviews run; to save, also before they close.
   * An unknown link and a removed person's answer the same.
   */
  #onLink(
    secretMark: string,
    now: string,
    use: "open" | "save" | "delete"
  ): LinkAnswer<{
    person: Roster["people"][number];
    link: typeof links.$inferSelect;
    roster: Roster;
    plan: Plan;
  }> {
    const [code] = this.#db
      .select({ person: linkCodes.person })
      .from(linkCodes)
      .where(eq(linkCodes.mark, secretMark))
      .all();
    const roster = this.#roster();
    const person = roster?.people.find(({ id }) => id === code?.person);
    if (roster === null || person === undefined) {
      return refused("interview.link_invalid");
    }
    if (!this.#withinLimit(person.id, now)) {
      return refused("interview.limited");
    }
    const [link] = this.#db
      .select()
      .from(links)
      .where(eq(links.person, person.id))
      .all();
    const row = this.#row();
    if (link === undefined || row.plan === null) {
      return refused("interview.not_yet");
    }
    if (use !== "delete") {
      if (row.pausedAt !== null) {
        return refused("interview.paused");
      }
      if (!agreementsIn(row.agreements)) {
        return refused("interview.not_yet");
      }
    }
    if (use === "save" && dayOf(now) > closesOn(row.plan)) {
      return refused("interview.closed");
    }
    return answered({ person, link, roster, plan: row.plan });
  }

  /** Counts a call on someone's link; false past `linkCallsPerMinute`. */
  #withinLimit(person: string, now: string): boolean {
    const minute = now.slice(0, 16);
    const calls = this.#calls.get(person);
    const count = calls?.minute === minute ? calls.count + 1 : 1;
    this.#calls.set(person, { minute, count });
    return count <= linkCallsPerMinute;
  }

  /** What someone's interview holds now; none before a save. */
  #held(person: string): InterviewProgress | null {
    const [row] = this.#db
      .select({ progress: interviews.progress })
      .from(interviews)
      .where(eq(interviews.person, person))
      .all();
    return row === undefined
      ? null
      : interviewProgressSchema.parse(JSON.parse(row.progress));
  }

  #onRoster(person: string): boolean {
    return this.#db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.id, person))
      .all()
      .some(({ id }) => id === person);
  }

  /** Removes what someone said and where their interview stood, and notes why. */
  #forget(person: string, now: string, what: string, by: string): void {
    this.#db.delete(interviews).where(eq(interviews.person, person)).run();
    this.#db
      .delete(interviewTexts)
      .where(eq(interviewTexts.person, person))
      .run();
    this.#db
      .delete(interviewStates)
      .where(eq(interviewStates.person, person))
      .run();
    this.#db
      .delete(interviewSettings)
      .where(eq(interviewSettings.person, person))
      .run();
    this.#noted(person, what, now, by);
  }

  /**
   * Records what happened to someone's interview in the onboarding's own
   * log, which only Grasp's staff read: never in the audit log. `by` is
   * who did it, as the log names them: the interviewee themselves, unless
   * said otherwise.
   */
  #noted(
    person: string,
    what: string,
    at: string,
    by: string = interviewee
  ): void {
    this.#db.insert(events).values({ at, by, what, about: person }).run();
  }

  #noteState(
    state: {
      person: string;
      kind: "own" | "lead";
      startedAt: string | null;
      completedAt: string | null;
    },
    updatedAt: string = new Date().toISOString()
  ): void {
    const [held] = this.#db
      .select({
        kind: interviewStates.kind,
        leadOf: interviewStates.leadOf,
        completedAt: interviewStates.completedAt,
      })
      .from(interviewStates)
      .where(eq(interviewStates.person, state.person))
      .all();
    // Once they agreed, whose interview it was, and of which team, is
    // settled: a lead named, moved or replaced afterwards changes nothing.
    // Before that, a lead's interview is of the team they lead now.
    const settled =
      held === undefined || held.completedAt === null
        ? {
            kind: state.kind,
            leadOf:
              state.kind === "lead"
                ? (this.#roster()?.teams.find(
                    ({ lead }) => lead === state.person
                  )?.id ?? null)
                : null,
          }
        : { kind: held.kind, leadOf: held.leadOf };
    this.#db
      .insert(interviewStates)
      .values({ ...state, ...settled, updatedAt })
      .onConflictDoUpdate({
        target: interviewStates.person,
        set: {
          ...settled,
          startedAt: state.startedAt,
          completedAt: state.completedAt,
          updatedAt,
        },
      })
      .run();
    // Their agreement counts once ever, in the team they were asked in.
    const [asked] = this.#db
      .select()
      .from(countedPeople)
      .where(eq(countedPeople.person, state.person))
      .all();
    const { completedAt } = state;
    if (asked !== undefined && !asked.talked && completedAt !== null) {
      this.#db
        .update(countedPeople)
        .set({ talked: true })
        .where(eq(countedPeople.person, state.person))
        .run();
      this.#count(asked.team, completedAt, { talked: 1 });
    }
  }

  #row(): {
    plan: Plan | null;
    agreements: Agreements | null;
    pausedAt: string | null;
  } {
    const [row] = this.#db
      .select()
      .from(onboarding)
      .where(eq(onboarding.id, 1))
      .all();
    const plan = row?.plan ?? null;
    const agreements = row?.agreements ?? null;
    return {
      plan: plan === null ? null : planSchema.parse(JSON.parse(plan)),
      agreements:
        agreements === null
          ? null
          : agreementsSchema.parse(JSON.parse(agreements)),
      pausedAt: row?.pausedAt ?? null,
    };
  }

  #stephen(): StephenSetup | null {
    const [row] = this.#db
      .select({ stephen: onboarding.stephen })
      .from(onboarding)
      .where(eq(onboarding.id, 1))
      .all();
    const stored = row?.stephen ?? null;
    return stored === null
      ? null
      : stephenSetupSchema.parse(JSON.parse(stored));
  }

  #roster(): Roster | null {
    const teamRows = this.#db
      .select()
      .from(teams)
      .orderBy(asc(teams.position))
      .all();
    if (teamRows.length === 0) {
      return null;
    }
    return {
      teams: teamRows.map(({ id, name, lead, does, off }) => ({
        id,
        name,
        lead,
        does,
        off,
      })),
      people: this.#db
        .select()
        .from(people)
        .orderBy(asc(people.position))
        .all()
        .map(({ id, name, email, team, title, away }) => ({
          id,
          name,
          email,
          team,
          title,
          away,
        })),
    };
  }

  /** Adds to a team's tally for the day `at` falls on. */
  #count(
    team: string,
    at: string,
    add: { asked?: number; talked?: number }
  ): void {
    const asked = add.asked ?? 0;
    const talked = add.talked ?? 0;
    this.#db
      .insert(teamCounts)
      .values({ team, day: at.slice(0, 10), asked, talked })
      .onConflictDoUpdate({
        target: [teamCounts.team, teamCounts.day],
        set: {
          asked: sql`${teamCounts.asked} + ${asked}`,
          talked: sql`${teamCounts.talked} + ${talked}`,
        },
      })
      .run();
  }

  #counts(): TeamCount[] {
    return this.#db.select().from(teamCounts).all();
  }

  #interviews(): Map<string, InterviewState> {
    return new Map(
      this.#db
        .select({
          person: interviewStates.person,
          leadOf: interviewStates.leadOf,
          startedAt: interviewStates.startedAt,
          completedAt: interviewStates.completedAt,
          ledTeam: links.ledTeam,
        })
        .from(interviewStates)
        .leftJoin(links, eq(links.person, interviewStates.person))
        .all()
        .map(({ person, leadOf, startedAt, completedAt, ledTeam }) => [
          person,
          {
            person,
            startedAt,
            completedAt,
            // A lead's interview only if they led the team when their link
            // went out and talked as the lead of that same team: a lead
            // replaced or moved before they talked counts as nobody's lead.
            ...(ledTeam !== null && ledTeam === leadOf ? { ledTeam } : {}),
          },
        ])
    );
  }

  /**
   * Records a change in the log and stores its audit event in the outbox:
   * call it in the change's transaction, so both are kept or neither, then
   * `#deliverAudit`.
   */
  #changed(
    by: AuditActor,
    action: string,
    detail: Record<string, AuditDetailValue>
  ): void {
    const at = new Date().toISOString();
    this.#db
      .insert(events)
      .values({ at, by: whoIs(by), what: action })
      .run();
    const event = createAuditEvent(
      { actor: by, action, target, detail },
      "core"
    );
    this.#db
      .insert(auditOutbox)
      .values({
        id: event.id,
        event: JSON.stringify(event),
        createdAt: new Date(),
      })
      .run();
  }

  /** Delivers the outbox's events now, in the background; the alarm retries what is left. */
  #deliverAudit(): void {
    this.ctx.waitUntil(this.#drainAudit());
  }

  async #drainAudit(): Promise<void> {
    const left = await drainObjectOutbox(this.env, this.ctx.storage.sql);
    if (left === 0) {
      this.#auditRetryMs = auditRetryMs.first;
      return;
    }
    const retryMs = this.#auditRetryMs;
    this.#auditRetryMs = Math.min(retryMs * 2, auditRetryMs.most);
    await this.#alarmBy(Date.now() + retryMs);
  }
}
