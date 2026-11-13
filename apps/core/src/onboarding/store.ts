import { STARTING_ORG_RULES } from "@grasp-os/shared/admin/onboarding-admin";
import type { OrgRules } from "@grasp-os/shared/admin/onboarding-admin";
import { addWorkingDays, dayOf } from "@grasp-os/shared/admin/org-record";
import type {
  DrawnWork,
  Told,
  WorkRecord,
} from "@grasp-os/shared/admin/org-record";
import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditActor, AuditDetailValue } from "@grasp-os/shared/audit";
import { randomToken, sha256Hex } from "@grasp-os/shared/encoding";
import {
  factRevision,
  interviewPagePath,
  interviewProgressSchema,
  participationNotice,
} from "@grasp-os/shared/interview-links";
import type {
  ApprovedFact,
  InterviewApproval,
  InterviewElsewhere,
  InterviewFact,
  InterviewParticipation,
  InterviewProgress,
  InterviewSaved,
  InterviewSession,
  InterviewWithdrawal,
} from "@grasp-os/shared/interview-links";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import { canonicalJson } from "@grasp-os/shared/json";
import { kickoffErrors, visionFields } from "@grasp-os/shared/kickoff";
import type {
  KickoffReading,
  KickoffView,
  VisionField,
} from "@grasp-os/shared/kickoff";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  agreementsSchema,
  minTeamShown,
  planSchema,
  remindAfterWorkingDays,
} from "@grasp-os/shared/onboarding";
import type {
  Agreements,
  Difference,
  InterviewKind,
  InterviewLocale,
  FailedMail,
  LinkToSend,
  OnboardingReview,
  OnboardingView,
  Plan,
  Roster,
  SettleChoice,
} from "@grasp-os/shared/onboarding";
import {
  noChoices,
  setupChoicesSchema,
} from "@grasp-os/shared/onboarding-choices";
import type { SetupChoices } from "@grasp-os/shared/onboarding-choices";
import type { OnboardingContext } from "@grasp-os/shared/onboarding-context";
import type {
  DocumentReading,
  OnboardingDocument,
} from "@grasp-os/shared/onboarding-documents";
import {
  defaultFlow,
  flowAgreements,
  flowAgreementsOf,
  flowInterviews,
  setupPlaceSchema,
  startingFlowOf,
  storedFlowOf,
  withDone,
} from "@grasp-os/shared/onboarding-flow";
import type {
  OnboardingFlow,
  SetupPlace,
  SetupStepId,
} from "@grasp-os/shared/onboarding-flow";
import {
  drawnWorkSchema,
  orgRulesSchema,
  stephenSetupSchema,
} from "@grasp-os/shared/onboarding-staff";
import type {
  StaffWorks,
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
  gte,
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
import { handOverProducers } from "../brain-hand-overs.ts";
import {
  keepOnboardingRecords,
  purgeOnboardingDrawings,
  onboardingDrawingsOf,
  onboardingStatementsOf,
  purgeOnboardingRecords,
} from "../brain-records.ts";
import { organizations } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { migrateOnWake } from "../db/migrate.ts";
import migrations from "../db/onboarding/migrations/migrations.js";
import {
  approvals,
  askedAbout,
  moreVoices,
  auditOutbox,
  brainClaims,
  brainInterviews,
  brainSent,
  brainTeams,
  countedPeople,
  countedWorks,
  drawFailures,
  referrals,
  drawnWorks,
  events,
  interviewStates,
  interviewSettings,
  interviews,
  linesToForget,
  linkAddresses,
  linkCodes,
  documents,
  kickoff,
  links,
  onboarding,
  participations,
  people,
  readbacks,
  teamCounts,
  teams,
  checkedDifferences,
  settledWorks,
  usage,
  voiceUse,
  works,
} from "../db/onboarding/schema.ts";
import { inJurisdiction } from "../durable-objects.ts";
import {
  erasedEmailsAmong,
  isErasedEmail,
  normalizedEmail,
} from "../erased-people.ts";
import {
  deliverMail,
  dropMailAbout,
  mailAbout,
  mailState,
  queueAgain,
  queueMail,
} from "../mail-outbox.ts";
import type { MailState, MailToQueue } from "../mail-outbox.ts";
import { mailDomain, mailSends, sendMail } from "../mail.ts";
import { forgetStored } from "../speech-cache.ts";
import {
  intakeIds,
  intakeOf,
  rosterSource,
  withoutNames,
} from "./brain-intake.ts";
import type { TeamIntake } from "./brain-intake.ts";
import { storedDocumentReadingSchema } from "./document-reading.ts";
import { checkedSupport } from "./drawing-support.ts";
import type { Support } from "./drawing-support.ts";
import { keepKickoffRecords } from "./kickoff-records.ts";
import {
  contextOf,
  kickoffBrief,
  storedAnswersSchema,
  storedReadingSchema,
} from "./kickoff.ts";
import { linkSecretOf } from "./link-secret.ts";
import { linkMail, reminderMail, updateMail } from "./mail-text.ts";
import { referralOf, referred } from "./referral.ts";
import {
  agreementsIn,
  closesOn,
  dueLinks,
  leads,
  leadsTalked,
  mondayOf,
  progressOf,
  sendsFrom,
  takingPart,
} from "./rules.ts";
import type { InterviewState, TeamCount } from "./rules.ts";
import { anyLanguage, spokenKeysOf } from "./spoken-lines.ts";
import type { SaidIn } from "./spoken-lines.ts";
import { interviewBrief, setupView } from "./stephen-setup.ts";
import { onboardingStoreName } from "./store-name.ts";
import {
  checksFor,
  claimChecksMax,
  teamClaims,
  teamMayClaim,
  TooManyClaimChecksError,
} from "./team-claims.ts";
import { assignWork, companyName, drawTeamMap } from "./team-map.ts";
import { drawWork, knownOf } from "./work-drawing.ts";
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
//   admin reads: it would tell them who talked, and when. A delete from
//   the link too: the admin sees each lead's status, so its moment alone
//   would tell them which lead it was (GRA-368).
// - A deleted interview left anywhere (GRA-368): deleting one, from its
//   link, by staff, with a new start or by taking someone off the roster,
//   takes out at once what they said, where it stood, every drawing it
//   was in (drawn again from who is left, or emptied), the brain's
//   records that rest on it (`purgeBrain`), and Stephen's lines kept
//   from it (spoken-lines.ts). A drawing or a brain intake under way
//   when it goes is thrown away or taken out again as it ends.
// - A mail going twice, or a link's secret kept or logged: mail goes
//   through the outbox (mail-outbox.ts), once by its key, the link filled
//   in only as the mail is sent. Each link goes by email on its day, and
//   one reminder after `remindAfterWorkingDays`; the admin's update twice
//   a week holds the admin's own numbers, never a name (mail-text.ts).
// - A purged document living on in its reading (GRA-970): a Knowledge
//   purge that reaches a shared document forgets its reading here, every
//   drawing that may have had it for context, and those drawings in the
//   brain (`forgetDocuments`). A drawing under way when it goes is thrown
//   away as it ends, and drawn again.

/** The one store of a deployment, by the name it is reached under. */
const storeName = onboardingStoreName;

/** The deployment's onboarding store. */
/**
 * The KV key of how often a Knowledge content purge reached the onboarding
 * (`notePurge`) or rewrote what it holds (`rewriteInterview`,
 * `forgetDrawings`): what anything reading the kickoff or the interviews
 * to write from them later checks it still finds, or keeps nothing.
 */
const purgesKey = "purges";

/**
 * The brain's records of the kickoff still owed (kickoff-records.ts):
 * `replaced` when a new kickoff's records must also retire the last
 * one's, `answered` when only an answer changed it. Set with the kickoff
 * in one transaction, cleared once the records are kept; the alarm keeps
 * them until then.
 */
const kickoffOwedKey = "kickoff_records_owed";

/**
 * When the kickoff a purge forgot came in: its source stays, by title and
 * day alone, so the records the purge rewrote still name it.
 */
const kickoffSourceKey = "kickoff_source_at";

/** A piece of work's names, as a content purge reads and rewrites them. */
export interface WorkNames {
  name: string;
  local: string;
  one: string;
  many: string;
}

export const onboardingStore = (
  env: Pick<Env, "ONBOARDING" | "DURABLE_OBJECT_JURISDICTION">
) => inJurisdiction(env, env.ONBOARDING).getByName(storeName);

/** What the audit log names as acted on. */
const target = { type: "onboarding", id: storeName } as const;

/** The teams and people new on a list saved while a plan was set, by id, until the admin confirms it. */
const unconfirmedSchema = z.object({
  teams: z.array(z.string()),
  people: z.array(z.string()),
});

/** Whether a team or person waits for the admin to confirm: new on the list, or waiting already. */
const waits = (id: string, known: Set<string>, waited: Set<string>) =>
  !known.has(id) || waited.has(id);

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
  | "interview.limited"
  | "interview.not_participating"
  | "interview.notice_changed"
  | "interview.withdrawn";

/** What a link's request gets from the store: an answer, or why not. */
export type LinkAnswer<T> =
  | { ok: true; value: T }
  | { ok: false; code: LinkRefusal };

const refused = (code: LinkRefusal) => ({ ok: false, code }) as const;

/** Each fact's revision as saved, by its id (`interviews.revisions`). */
const revisionsSchema = z.record(z.string(), z.string());

/** A fact at a revision, as approvals are looked up by. */
const revisionKey = (fact: string, revision: string): string =>
  `${fact}\u0000${revision}`;

/** What counts of an interview, as it stands for comparing: the same facts at the same revisions. */
const admissionKey = (keys: readonly string[]): string =>
  keys.toSorted().join("\u0001");

/**
 * The receipt of a read-back: from exactly the revisions approved, so the
 * same approval asked again, a lost answer retried, finds the same one.
 */
const receiptOf = async (facts: readonly ApprovedFact[]): Promise<string> => {
  const hash = await sha256Hex(
    admissionKey(facts.map(({ id, revision }) => revisionKey(id, revision)))
  );
  return `rb-${hash.slice(0, 32)}`;
};
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

/**
 * Waits for `promise`, whatever became of it: for the brain's work after
 * it, which runs all the same. Whoever started it heard how it went.
 */
const whatever = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
  } catch {
    // Its caller was told.
  }
};

/**
 * Who a brain record rests on (`brain_sent`) when their interview went
 * while it was given to the brain: nobody who agrees, so it is taken out.
 */
const gonePrefix = "gone:";

/** How long after a purge of the brain failed it is tried again. */
const purgeRetryMs = 60 * 1000;

/** What the reminder rule (`owesReminder`) reads of one person. */
interface ReminderFacts {
  /** Their team isn't off and they aren't away (`takingPart`). */
  takingPart: boolean;
  email: string;
  /** Their link, once out. */
  link: { deletedAt: string | null } | undefined;
  /** Their interview is finished. */
  completed: boolean;
  /** They withdrew from it, for good. */
  withdrawn: boolean;
}

/**
 * The one rule for whether someone is owed their reminder: taking part
 * with an address, their link out and not deleted, their interview not
 * finished, and not withdrawn. The scheduled reminder (`#remindable`),
 * a failed one sent again and one about to go (`#reminderOwed`) all ask
 * it, each reading the facts as suits it.
 */
const owesReminder = ({
  takingPart: taking,
  email,
  link,
  completed,
  withdrawn,
}: ReminderFacts): boolean =>
  taking &&
  email !== "" &&
  link !== undefined &&
  link.deletedAt === null &&
  !completed &&
  !withdrawn;

/** The days of the week the admin's update goes out: Monday and Thursday. */
const updateWeekdays: ReadonlySet<number> = new Set([1, 4]);

/** What every onboarding mail is written with (`#mailContext`). */
interface MailContext {
  company: string;
  locale: InterviewLocale;
  /** The company's onboarding admin, whom replies reach. */
  replyTo: string | undefined;
}

/** The agreements' fields in one order, to tell the same agreements apart from changed ones. */
const agreementsKey = (agreements: Agreements | null): string =>
  agreements === null
    ? ""
    : JSON.stringify([
        agreements.processing,
        agreements.processingOn ?? null,
        agreements.assessment,
        agreements.assessmentOn ?? null,
        agreements.council,
        agreements.councilOn ?? null,
      ]);

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

/** The most words transcription is asked to listen out for. */
export const listeningTermsMax = 30;

/**
 * Words to listen out for, as transcription takes them: each once,
 * whatever its case, longer than two characters and shorter than forty,
 * the first `listeningTermsMax` of them, in the order given.
 */
const listenFor = (terms: readonly string[]): string[] => {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const term of terms) {
    const word = term.replaceAll(/\s+/gu, " ").trim();
    const key = word.toLowerCase();
    if (word.length > 2 && word.length < 40 && !seen.has(key)) {
      seen.add(key);
      kept.push(word);
    }
  }
  return kept.slice(0, listeningTermsMax);
};

/**
 * A live transcription, as the onboarding notes it: its ID, who it is
 * for, and the person whose link it is on, if it is on one.
 */
export interface TranscriptionSessionNote {
  id: string;
  by: AuditActor;
  person?: string;
}

/** How a line said on someone's link is counted: `link:<person>`. */
const linkWho = "link:";

/**
 * The key what is heard for `who` is counted under, beside what is said
 * for them, in the same daily table.
 */
const heardKey = (who: string): string => `${who}:heard`;

/** What one interview turn knows of who it is with, from the store (`turnContext`). */
/** What the drawing gets from one interview: only what its person agreed to. */
export interface DrawInput {
  person: string;
  kind: "own" | "lead";
  /** When they last agreed to something new. */
  agreedAt: string;
  /**
   * Their agreement's generation as it was drawn from (`agreedAt` and how
   * often something they approved stopped counting, `#drawGeneration`):
   * what `drawn` is told once it is drawn, so two take-backs in one
   * millisecond still differ.
   */
  generation: string;
  /**
   * Their admission's generation as it was drawn from (`#interviewsOf`:
   * when this interview began, and how often something they approved
   * stopped counting): what a map keeps as `mappedFrom`. It changes with
   * every take-back and with every interview begun anew, never with more
   * approved, so it never repeats for another interview's content.
   */
  admission: string;
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

/**
 * Someone's admission as SQL, as `#interviewsOf` reads it: their
 * interview's start and how often anything they approved stopped counting,
 * or NULL while nothing they agreed to counts. For a statement that writes
 * only while it is what an intake read.
 */
const admissionSql = (person: string): SQL =>
  sql`(SELECT CASE WHEN agreed_at IS NULL THEN NULL ELSE coalesce(started_at, '') || '|' || revocations END FROM interview_states WHERE person = ${person})`;

/** An address as `link_addresses` keeps it, and a sign-in's is compared. */
const foldedAddress = (email: string): string => email.trim().toLowerCase();

/**
 * An erasure the onboarding still owes the new Brain (`owedErasures`), for
 * core to do with `eraseSource` (onboarding/new-brain.ts): a source it
 * gave that no longer stands.
 */
export type OwedErasure =
  | {
      kind: "interview";
      source: string;
      account: string;
      reason: "deleted" | "withdrawn";
    }
  | { kind: "claim"; source: string; team: string };

/**
 * What someone's interview in the new Brain is settled from, as SQL over
 * their link `l` (`links.brain_mark`): the account linked to them, their
 * link's version (every save, delete, new start and purge rewrite moves
 * it), their withdrawal, and their approvals. NULL, for nothing to hold,
 * without an account or once core erased them.
 */
const interviewMarkSql = `CASE WHEN l.account IS NULL OR l.erased_at IS NOT NULL THEN NULL ELSE
  l.account || '|' || l.version
  || '|' || coalesce((SELECT p.withdrawn_at FROM participations p WHERE p.person = l.person), '-')
  || '|' || (SELECT count(*) || ':' || coalesce(max(a.at), '') FROM approvals a WHERE a.person = l.person)
  END`;

/** A drawing as the store keeps it; null when there is none. */
const drawingOf = (stored: string | null): DrawnWork | null =>
  stored === null
    ? null
    : (drawnWorkSchema.safeParse(JSON.parse(stored)).data ?? null);

/**
 * What nobody who told a piece of work has said yet, each as a kind of
 * answer in words of the store's own (GRA-330): the next interview asks
 * about these when they come up. Never the drawing's own open questions,
 * which the model writes from what as few as one colleague said, so they
 * could carry that colleague's words, paraphrased, into someone else's
 * interview; what fewer than five people said reaches nobody but them.
 * Only that an answer is missing is told, never what anyone answered.
 */
const unknownAnswers: readonly {
  missing: (told: Told[]) => boolean;
  ask: string;
}[] = [
  {
    missing: (told) => told.every(({ volume }) => volume === null),
    ask: "how many come in, in a week or a month",
  },
  {
    missing: (told) =>
      told.every(
        ({ takes, stepMinutes }) =>
          takes === null && (stepMinutes ?? []).length === 0
      ),
    ask: "how long one takes",
  },
  {
    missing: (told) => told.every(({ wrong }) => wrong === null),
    ask: "how many come in wrong or incomplete",
  },
  {
    missing: (told) => told.every((said) => said.waits.length === 0),
    ask: "where it waits, and for what",
  },
  {
    missing: (told) =>
      told.every(({ differently }) => differently.length === 0),
    ask: "what is done when a case is off the normal path",
  },
  {
    missing: (told) => told.every(({ decides }) => !decides),
    ask: "what they look at to decide",
  },
  {
    missing: (told) => told.every(({ next }) => !next),
    ask: "who gets it after them",
  },
  {
    missing: (told) => told.every(({ right }) => !right),
    ask: "what done right looks like",
  },
];

/** What nobody has said yet of a piece of work, for Stephen to ask when it comes up. */
const stillUnknown = (drawn: DrawnWork | null): string[] => {
  const told = Object.values(drawn?.told ?? {});
  if (told.length === 0) {
    return [];
  }
  const asks = unknownAnswers
    .filter(({ missing }) => missing(told))
    .map(({ ask }) => ask)
    .slice(0, 4);
  return asks.length === 0
    ? []
    : [`Nobody has said yet, so ask when it comes up: ${asks.join("; ")}.`];
};

const doersSchema = z.array(z.string());

/** Who does a piece of work, as the store keeps it. */
const doersOf = (stored: string): string[] =>
  doersSchema.safeParse(JSON.parse(stored)).data ?? [];

/**
 * Who a piece of work is drawn from, and when each last agreed: who does
 * it and who was asked about it, as far as they agreed to something.
 * `agreedAt` says when someone did; undefined when they didn't, or aren't
 * on the roster.
 */
const agreedAbout = (
  work: string,
  doers: readonly string[],
  asked: readonly { person: string; work: string }[],
  agreedAt: (person: string) => string | undefined
): [person: string, at: string][] =>
  [
    ...new Set([
      ...doers,
      ...asked.filter((each) => each.work === work).map(({ person }) => person),
    ]),
  ].flatMap((person): [string, string][] => {
    const at = agreedAt(person);
    return at === undefined ? [] : [[person, at]];
  });

/** What the lab's drawings took: not the onboarding's to count. */
const noMeter = (): void => undefined;

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
  /** Which Stephen held its last turn (`stephenVersion`); null before that was kept. */
  version: string | null;
  /** The language its last turn was held in; null before a turn ran. */
  locale: string | null;
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

/** A count as given, when it is one: a number from nothing up. */
const counted = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** How many people's links one query marks as taken. */
const takenPage = 90;

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
  /**
   * What the store is doing with the brain now, giving it a team or
   * taking records or drawings out of it: the next waits for it, so none loses
   * track of what the other wrote.
   */
  #braining: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateOnWake(ctx, migrations);
    // The one row everything else updates, there before anything asks. As
    // it is first made it takes the flow staff chose when they added the
    // company (`ONBOARDING_START`), so that is in place before anyone
    // signs in; from then on the flow is only what staff set (`setFlow`).
    const start = startingFlowOf(env.ONBOARDING_START);
    this.#db
      .insert(onboarding)
      .values({ id: 1, flow: start === null ? null : JSON.stringify(start) })
      .onConflictDoNothing()
      .run();
    // Woken with work due and no alarm set (a migration made a team due,
    // say, on an onboarding long finished): the alarm is set for it.
    void ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) {
        await this.#armDrawing();
      }
    });
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
      agreed: agreementsIn(row.agreements, flowAgreementsOf(row.flow)),
      paused: row.pausedAt !== null,
      sponsor: this.#sponsor(),
      context: this.#context(),
      waiting: roster === null ? 0 : this.#waiting(roster),
      mailSends: mailSends(this.env),
      mailDomain: mailDomain(this.env),
    };
  }

  /** How many who take part have no link out and wait for the admin to confirm the organization. */
  #waiting(roster: Roster): number {
    const { sent, unconfirmed } = this.#linkFacts();
    return roster.people.filter(
      (person) =>
        takingPart(roster, person) &&
        !sent.has(person.id) &&
        (unconfirmed.people.has(person.id) ||
          unconfirmed.teams.has(person.team))
    ).length;
  }

  /** What the admin's onboarding knows of the company from the kickoff: read without its transcript. */
  #context(): OnboardingContext {
    const [row] = this.#db
      .select({ reading: kickoff.reading, answers: kickoff.answers })
      .from(kickoff)
      .all();
    return row === undefined
      ? contextOf(null, {})
      : contextOf(
          storedReadingSchema.parse(JSON.parse(row.reading)),
          storedAnswersSchema.parse(JSON.parse(row.answers))
        );
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
    return (
      row.pausedAt === null &&
      agreementsIn(row.agreements, flowAgreementsOf(row.flow))
    );
  }

  /**
   * Replaces who works where. People who are no longer in it keep nothing
   * here: their link, what they said and where their interview stood go
   * with them. Everyone new gets a link of their own. A list the admin
   * saves on its own (`confirmed: false`, rpc.ts) sends no link to the
   * teams and people new on it while a plan is set: they wait until the
   * admin confirms the organization.
   */
  async saveRoster(
    roster: Roster,
    by: AuditActor,
    { confirmed = true }: { confirmed?: boolean } = {}
  ): Promise<OnboardingView> {
    const fresh = await this.#freshCodes(roster);
    const lines = await this.#lineKeysOf(this.#leaving(roster));
    const said = this.ctx.storage.transactionSync(() => {
      const before = this.#roster();
      const { removed, erased } = this.#writeRoster(roster, fresh, {
        late: false,
        lines,
      });
      if (confirmed) {
        this.#confirmed(before, roster);
      } else {
        this.#holdNew(before, roster);
      }
      this.#changed(by, "onboarding.roster.saved", {
        teams: roster.teams.length,
        people: roster.people.length,
        removed,
        confirmed,
      });
      return erased;
    });
    this.#deliverAudit();
    this.ctx.waitUntil(this.#armLinks());
    if (said.length > 0) {
      await this.#afterForget(said);
    }
    return this.view();
  }

  /**
   * Keeps the teams and people new on `roster`, while a plan is set, as
   * waiting for the admin to confirm the organization, with those that
   * waited already and are still on it. Details of everyone else change
   * at once; their ids and links stay.
   */
  #holdNew(before: Roster | null, roster: Roster): void {
    if (this.#row().plan === null) {
      return;
    }
    const was = this.#unconfirmed();
    const teamsBefore = new Set(before?.teams.map(({ id }) => id));
    const peopleBefore = new Set(before?.people.map(({ id }) => id));
    this.#keepUnconfirmed({
      teams: roster.teams
        .map(({ id }) => id)
        .filter((id) => waits(id, teamsBefore, was.teams)),
      people: roster.people
        .map(({ id }) => id)
        .filter((id) => waits(id, peopleBefore, was.people)),
    });
  }

  /**
   * The admin confirmed the organization: nothing waits for it any more,
   * and a team that takes part only now, the ones that waited or were
   * switched on, starts as a late one, its lead first (`#lateTeams`).
   */
  #confirmed(before: Roster | null, roster: Roster): void {
    const { teams: waited } = this.#unconfirmed();
    this.#lateTeams(
      before === null
        ? roster
        : {
            ...before,
            teams: before.teams.filter(({ id }) => !waited.has(id)),
          },
      roster,
      new Date().toISOString()
    );
    this.#keepUnconfirmed({ teams: [], people: [] });
  }

  /** The teams and people waiting for the admin to confirm the organization. */
  #unconfirmed(): { teams: Set<string>; people: Set<string> } {
    const [row] = this.#db
      .select({ unconfirmed: onboarding.unconfirmed })
      .from(onboarding)
      .where(eq(onboarding.id, 1))
      .all();
    const stored = row?.unconfirmed ?? null;
    const { teams: waitingTeams, people: waitingPeople } =
      stored === null
        ? { teams: [], people: [] }
        : unconfirmedSchema.parse(JSON.parse(stored));
    return { teams: new Set(waitingTeams), people: new Set(waitingPeople) };
  }

  #keepUnconfirmed(unconfirmed: z.infer<typeof unconfirmedSchema>): void {
    const none =
      unconfirmed.teams.length === 0 && unconfirmed.people.length === 0;
    this.#db
      .update(onboarding)
      .set({ unconfirmed: none ? null : JSON.stringify(unconfirmed) })
      .where(eq(onboarding.id, 1))
      .run();
  }

  /** A link code for everyone on `roster` who has none yet and wasn't erased. */
  async #freshCodes(
    roster: Roster
  ): Promise<{ person: string; linkId: string; mark: string }[]> {
    const coded = new Set(
      this.#db
        .select({ person: linkCodes.person })
        .from(linkCodes)
        .all()
        .map(({ person }) => person)
    );
    const erased = this.#erasedPeople();
    return await Promise.all(
      roster.people
        .filter(({ id }) => !coded.has(id) && !erased.has(id))
        .map(async ({ id }) => {
          const linkId = randomToken();
          const mark = await sha256Hex(await linkSecretOf(this.env, linkId));
          return { person: id, linkId, mark };
        })
    );
  }

  /**
   * Writes who works where, in the caller's transaction. Whoever left the
   * list keeps nothing; with `late`, as staff put the list right, a team
   * that takes part only now, once the team is told and its moment has
   * passed, starts now, its lead first (`#lateTeams`). The company's admin
   * replaces the whole list, so for them no team is new that way;
   * whoever moved, or is new, in a team with a map is asked about its work
   * (`#askNewcomers`). Returns how many left, and what was said in the
   * interviews of whoever left (`#erase`), for `#afterForget`.
   */
  /** Who has an interview here and isn't on `roster`: whose `#writeRoster` erases. */
  #leaving(roster: Roster): string[] {
    const kept = new Set(roster.people.map(({ id }) => id));
    return this.#db
      .select({ person: interviews.person })
      .from(interviews)
      .all()
      .map(({ person }) => person)
      .filter((person) => !kept.has(person));
  }

  #writeRoster(
    roster: Roster,
    fresh: readonly { person: string; linkId: string; mark: string }[],
    { late, lines }: { late: boolean; lines: ReadonlyMap<string, string[]> },
    now: string = new Date().toISOString()
  ): { removed: number; erased: (SaidIn | null)[] } {
    const kept = new Set(roster.people.map((person) => person.id));
    const before = this.#roster();
    const gone = this.#db
      .select({ id: people.id })
      .from(people)
      .all()
      .filter(({ id }) => !kept.has(id))
      .map(({ id }) => id);
    const mapped = new Map(
      this.#db
        .select({
          id: teams.id,
          lead: teams.lead,
          mappedAt: teams.mappedAt,
          mappedFrom: teams.mappedFrom,
        })
        .from(teams)
        .all()
        .map((row) => [row.id, row])
    );
    this.#db.delete(teams).run();
    this.#db.delete(people).run();
    for (const [position, team] of roster.teams.entries()) {
      const was = mapped.get(team.id);
      this.#db
        .insert(teams)
        .values({
          ...team,
          position,
          mappedAt: was?.mappedAt ?? null,
          // A map stands on the lead it was drawn from, and no other.
          mappedFrom:
            was?.lead === team.lead ? (was?.mappedFrom ?? null) : null,
        })
        .run();
    }
    for (const [position, person] of roster.people.entries()) {
      this.#db
        .insert(people)
        .values({ ...person, position })
        .run();
    }
    // Checked again here: someone erased since their code was made
    // (`#freshCodes` waits) gets none.
    const closed = this.#erasedPeople();
    for (const code of fresh.filter(({ person }) => !closed.has(person))) {
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
        this.#db.delete(moreVoices).where(eq(moreVoices.work, id)).run();
      }
    }
    this.#dropOrphanDrawings();
    for (const { person, work } of this.#db.select().from(askedAbout).all()) {
      if (teamOf.get(person) !== workTeam.get(work)) {
        this.#db.delete(askedAbout).where(eq(askedAbout.person, person)).run();
      }
    }
    const erased: (SaidIn | null)[] = [];
    for (const person of new Set([...gone, ...stale])) {
      this.#queueLines(lines.get(person) ?? []);
      erased.push(this.#erase(person));
      // Off the list, they take part in nothing: no mark of theirs stays,
      // their withdrawal's neither.
      this.#db
        .delete(participations)
        .where(eq(participations.person, person))
        .run();
      this.#db.delete(linkCodes).where(eq(linkCodes.person, person)).run();
      this.#db.delete(links).where(eq(links.person, person)).run();
      this.#db
        .delete(linkAddresses)
        .where(eq(linkAddresses.person, person))
        .run();
      dropMailAbout(this.ctx.storage.sql, person);
    }
    this.#lateTeams(late ? before : roster, roster, now);
    this.#askNewcomers(before, roster);
    // Someone moved out, made a lead or taken off may leave a team too
    // small to have claims shown (`teamMayClaim`), or a claim under five of
    // its team's people now (`#toPurge`, the one recount): those claims are
    // owed an erasure at once, which core's clock does within a minute.
    this.#eraseClaimsOfSmallTeams();
    this.#eraseClaims(this.#toPurge().records);
    return { removed: gone.length, erased };
  }

  /**
   * A team that takes part only now (added, or asked in again) once the
   * team is told and its moment has passed starts now, as a team of its
   * own in the plan: its lead's link goes out first, and everyone else's
   * waits for the lead, `leadWaitWorkingDays` at most from today. A team
   * no longer on the list leaves the plan's moments with it.
   */
  #lateTeams(before: Roster | null, roster: Roster, now: string): void {
    const [row] = this.#db
      .select({ toldAt: onboarding.toldAt })
      .from(onboarding)
      .where(eq(onboarding.id, 1))
      .all();
    const { plan } = this.#row();
    if (plan === null) {
      return;
    }
    // A team no longer on the list has no moment of its own any more.
    const listed = new Set(roster.teams.map(({ id }) => id));
    const later = Object.fromEntries(
      Object.entries(plan.later ?? {}).filter(([team]) => listed.has(team))
    );
    const took = new Set(
      (before?.teams ?? []).filter(({ off }) => !off).map(({ id }) => id)
    );
    const told = (row?.toldAt ?? null) !== null;
    for (const { id, off } of roster.teams) {
      const from = sendsFrom(plan, id);
      if (told && !off && !took.has(id) && from !== null && from <= now) {
        later[id] = now;
      }
    }
    const kept = Object.keys(plan.later ?? {});
    const same =
      kept.length === Object.keys(later).length &&
      kept.every((team) => later[team] === plan.later?.[team]);
    if (!same) {
      this.#db
        .update(onboarding)
        .set({ plan: JSON.stringify({ ...plan, later }) })
        .where(eq(onboarding.id, 1))
        .run();
    }
  }

  /**
   * Whoever moved to another team, or is new on the list, in a team whose
   * map is drawn, is asked about a piece of its work, weighed by who is
   * asked about each already. Whoever is asked about a piece also does it;
   * whoever left a team no longer does its work, unless they talked: what
   * they agreed to stays with the work it was about.
   */
  #askNewcomers(before: Roster | null, roster: Roster): void {
    const wasIn = new Map(
      (before?.people ?? []).map(({ id, team }) => [id, team])
    );
    const teamOf = new Map(roster.people.map(({ id, team }) => [id, team]));
    const talked = new Set(
      [...this.#interviews().values()]
        .filter(({ completedAt }) => completedAt !== null)
        .map(({ person }) => person)
    );
    const asked = new Map(
      this.#db
        .select()
        .from(askedAbout)
        .all()
        .map(({ person, work }) => [person, work])
    );
    for (const team of roster.teams) {
      const mine = this.teamWorks(team.id);
      if (mine.length === 0) {
        continue;
      }
      const members = roster.people.filter((person) => person.team === team.id);
      const newcomers = members.filter(
        (person) =>
          person.id !== team.lead &&
          !person.away &&
          wasIn.get(person.id) !== team.id &&
          !asked.has(person.id)
      );
      const wanted = this.#moreVoicesWanted();
      // A piece of work the company asked to hear more people about is
      // asked about first, ahead of any other.
      const heard = new Map(
        mine.map(({ id, asked: of }) => [id, wanted.has(id) ? -1 : of.length])
      );
      for (const [person, work] of assignWork(
        newcomers,
        mine,
        members,
        heard
      )) {
        if (work !== null) {
          asked.set(person, work);
          this.#db.insert(askedAbout).values({ person, work }).run();
        }
      }
      for (const work of mine) {
        const doers = work.doers.filter(
          (person) => teamOf.get(person) === team.id || talked.has(person)
        );
        for (const { id } of members) {
          if (asked.get(id) === work.id && !doers.includes(id)) {
            doers.push(id);
          }
        }
        if (doers.join(",") !== work.doers.join(",")) {
          this.#db
            .update(works)
            .set({ doers: JSON.stringify(doers) })
            .where(eq(works.id, work.id))
            .run();
        }
      }
    }
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

  /**
   * Records where the agreements stand; false, changing nothing, once the
   * team is told and they differ from what was agreed. They are the record
   * of what was agreed before the first interview: checked and saved in
   * one transaction, so no link can go out between the two. Saving them
   * again unchanged still applies.
   */
  setAgreements(agreements: Agreements, by: AuditActor): boolean {
    const { processing, assessment, council } = agreements;
    const saved = this.ctx.storage.transactionSync(() => {
      if (
        this.#told() &&
        agreementsKey(this.#row().agreements) !== agreementsKey(agreements)
      ) {
        return false;
      }
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
      return true;
    });
    if (saved) {
      this.#deliverAudit();
      this.ctx.waitUntil(this.#armLinks());
    }
    return saved;
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

  /** Whoever core erased whose entry is still on the list (`closeLinkOf`). */
  #erasedPeople(): Set<string> {
    return new Set(
      this.#db
        .select({ person: links.person })
        .from(links)
        .where(isNotNull(links.erasedAt))
        .all()
        .map(({ person }) => person)
    );
  }

  /** Whether core erased `person`, and their link is closed for good. */
  #erased(person: string): boolean {
    return (
      this.#db
        .select({ person: links.person })
        .from(links)
        .where(and(eq(links.person, person), isNotNull(links.erasedAt)))
        .all().length > 0
    );
  }

  /**
   * The path of someone's link, its secret after the `#`; none for anyone
   * not on the roster, or erased. Someone on it without a code yet (on the
   * roster before links were, or added by a save that raced another) gets
   * one now.
   */
  async linkOf(person: string): Promise<string | null> {
    if (!this.#onRoster(person) || this.#erased(person)) {
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
      // Unless someone made one meanwhile, they left the roster, or they
      // were erased.
      this.ctx.storage.transactionSync(() => {
        if (this.#onRoster(person) && !this.#erased(person)) {
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
      progress: this.#forSpeaker(person.id, this.#held(person.id)),
      version: link.version,
      withdrawn: this.#withdrawnAt(person.id) !== null,
    });
  }

  /**
   * Whose interviews are kept: what a Knowledge content purge reads one at
   * a time (interview-erasure.ts), so no one call carries them all.
   */
  interviewPeople(): string[] {
    return this.#db
      .select({ person: interviews.person })
      .from(interviews)
      .all()
      .map(({ person }) => person);
  }

  /**
   * `person`'s interview as kept, for a Knowledge content purge
   * (interview-erasure.ts): read as an interview, or, one that no longer
   * reads as one, as stored (its words are still in it); null when none
   * is kept. Never served otherwise.
   */
  interviewStored(
    person: string
  ): { progress: InterviewProgress } | { unreadable: string } | null {
    const [row] = this.#db
      .select({ progress: interviews.progress })
      .from(interviews)
      .where(eq(interviews.person, person))
      .all();
    if (row === undefined) {
      return null;
    }
    const parsed = interviewProgressSchema.safeParse(parsedJson(row.progress));
    return parsed.success
      ? { progress: parsed.data }
      : { unreadable: row.progress };
  }

  /**
   * Keeps `person`'s interview that no longer reads as one as a Knowledge
   * content purge rewrote it (`after`, its stored text), only if it is
   * still as the purge read it (`before`): one saved since is left to the
   * purge to read again. As `rewriteInterview`: under the brain lock, the
   * link's version moved on, a drawing under way keeps nothing, and in the
   * audit log without its words. Whether it was rewritten.
   */
  async rewriteUnreadableInterview(
    person: string,
    before: string,
    after: string,
    by: AuditActor
  ): Promise<boolean> {
    const rewritten = await this.#withBrain(async () => {
      await Promise.resolve();
      const [row] = this.#db
        .select({ progress: interviews.progress })
        .from(interviews)
        .where(eq(interviews.person, person))
        .all();
      if (row?.progress !== before) {
        return false;
      }
      this.ctx.storage.transactionSync(() => {
        this.#db
          .update(interviews)
          .set({ progress: after })
          .where(eq(interviews.person, person))
          .run();
        this.#db
          .update(links)
          .set({ version: sql`${links.version} + 1` })
          .where(eq(links.person, person))
          .run();
        this.#purged();
        this.#eraseClaims(this.#backedRecords(person));
        // Unlike `rewriteInterview`, no line of the voice's is queued to go
        // from the speech cache: it can't be read out of what doesn't parse.
        // Those lines expire from the cache within a month, the residual
        // #1206 states for the cache.
        this.#changed(by, "onboarding.interview.purged", { unreadable: 1 });
      });
      return true;
    });
    if (rewritten) {
      this.#deliverAudit();
      await this.#armDrawing();
      this.#decideInterviews();
    }
    return rewritten;
  }

  /**
   * Keeps `person`'s interview as a Knowledge content purge rewrote it
   * (`after`), only if it is still as the purge read it (`before`): one
   * saved since is left to the purge run again. The link's version moves
   * on, as a delete moves it, so a device's older copy, with the purged
   * words, is refused and given this one. What they approved stays
   * approved: the purge took words out, nobody changed what they said. So
   * each rewritten fact is kept at its new revision, and an approval of
   * it carries over to that revision, the old one's dropped: their next
   * save counts the same facts, redacted. In the audit log without its
   * words, or whose it was. Whether it was rewritten.
   */
  async rewriteInterview(
    person: string,
    before: InterviewProgress,
    after: InterviewProgress,
    by: AuditActor
  ): Promise<boolean> {
    const checked = interviewProgressSchema.parse(after);
    // The voice's lines the purge changed, as the cache may keep them,
    // with their sound: hashed now, queued by the rewrite itself.
    const said = this.#saidIn(person, before);
    const kept = new Set(this.#saidIn(person, checked)?.texts);
    const gone =
      said === null
        ? []
        : await spokenKeysOf({
            ...said,
            texts: said.texts.filter((text) => !kept.has(text)),
          });
    // Each fact's revision as rewritten, as a save would compute it.
    const revisions = new Map(
      await Promise.all(
        checked.facts.map(
          async (fact) => [fact.id, await factRevision(fact)] as const
        )
      )
    );
    // Under the brain lock: an intake reading what they said ends first,
    // or reads it rewritten.
    const rewritten = await this.#withBrain(async () => {
      await Promise.resolve();
      return this.#rewriteInterview(
        person,
        before,
        { progress: checked, revisions, lines: gone },
        by
      );
    });
    if (rewritten) {
      // Whatever the cache doesn't take now waits for the alarm.
      await this.forgetLinesNow();
      await this.#armDrawing();
      this.#decideInterviews();
    }
    return rewritten;
  }

  /** `rewriteInterview`, under the brain lock. */
  #rewriteInterview(
    person: string,
    before: InterviewProgress,
    after: {
      progress: InterviewProgress;
      revisions: ReadonlyMap<string, string>;
      /** The stored keys of the voice's lines it took out of the cache. */
      lines: readonly string[];
    },
    by: AuditActor
  ): boolean {
    const [row] = this.#db
      .select({ progress: interviews.progress })
      .from(interviews)
      .where(eq(interviews.person, person))
      .all();
    if (
      row === undefined ||
      canonicalJson(interviewProgressSchema.parse(JSON.parse(row.progress))) !==
        canonicalJson(before)
    ) {
      return false;
    }
    const kept = this.#revisionsOf(person);
    // The facts the purge changed, and each one's approval at the revision
    // kept, to carry over to its revision as rewritten. Approvals of older
    // revisions never count again, and are digests of words the purge may
    // have taken out: they go.
    const changed = [...after.revisions].flatMap(([fact, revision]) =>
      kept.get(fact) === revision ? [] : [fact]
    );
    const carried = this.#db
      .select()
      .from(approvals)
      .where(eq(approvals.person, person))
      .all()
      .flatMap((approval) => {
        const revision = after.revisions.get(approval.fact);
        return revision !== undefined &&
          changed.includes(approval.fact) &&
          approval.revision === kept.get(approval.fact)
          ? [{ ...approval, revision }]
          : [];
      });
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(interviews)
        .set({
          progress: JSON.stringify(after.progress),
          revisions: JSON.stringify(Object.fromEntries(after.revisions)),
        })
        .where(eq(interviews.person, person))
        .run();
      if (changed.length > 0) {
        this.#db
          .delete(approvals)
          .where(
            and(eq(approvals.person, person), inList(approvals.fact, changed))
          )
          .run();
      }
      for (const approval of carried) {
        this.#db.insert(approvals).values(approval).run();
      }
      this.#db
        .update(links)
        .set({ version: sql`${links.version} + 1` })
        .where(eq(links.person, person))
        .run();
      // The lines said with the purged words go from the cache too, from
      // the alarm until done (`forgetLinesNow`).
      this.#queueLines(after.lines);
      // A drawing read what they said before: it keeps nothing.
      this.#purged();
      // Nor does a claim put together from it: every claim they back is
      // owed an erasure, hidden from its team until it lands (rule (i),
      // `interviewTeamOf`), and comes back only from the team's next
      // intake, from what the purge left, under a new key.
      this.#eraseClaims(this.#backedRecords(person));
      this.#changed(by, "onboarding.interview.purged", {
        lines: after.lines.length,
      });
    });
    this.#deliverAudit();
    return true;
  }

  /**
   * Every drawing, piece of work and team's map as kept, as text: what a
   * Knowledge content purge looks in (interview-erasure.ts); never served
   * otherwise. A team's `does` is drawn from its lead's interview
   * (`#mapTeam`).
   */
  drawingsSaid(): {
    drawings: { work: string; drawn: string }[];
    differences: { work: string; way: string; other: string }[];
    teams: { id: string; does: string }[];
    works: {
      id: string;
      name: string;
      local: string;
      one: string;
      many: string;
    }[];
  } {
    return {
      drawings: this.#db
        .select({ work: drawnWorks.work, drawn: drawnWorks.drawn })
        .from(drawnWorks)
        .all()
        .flatMap(({ work, drawn }) =>
          drawn === null ? [] : [{ work, drawn }]
        ),
      differences: this.#db
        .select({
          work: checkedDifferences.work,
          way: checkedDifferences.way,
          other: checkedDifferences.other,
        })
        .from(checkedDifferences)
        .all(),
      teams: this.#db
        .select({ id: teams.id, does: teams.does })
        .from(teams)
        .all(),
      works: this.#db
        .select({
          id: works.id,
          name: works.name,
          local: works.local,
          one: works.one,
          many: works.many,
        })
        .from(works)
        .all(),
    };
  }

  /**
   * Forgets the drawings a Knowledge content purge reached (`drawings`, as
   * it read them) for good, to be drawn again from what their people
   * agreed to as the purge left it; and keeps the works' names, and what
   * teams do, as the purge rewrote them (`renamed`, `described`). Each
   * write takes only where the row still holds what the purge read: one
   * drawn again since, from words the purge already left clean, stays as
   * it is. The brain's own records of them were rewritten by the same
   * purge; each drawing drawn again is given as a new version. A checked
   * difference holding a purged word goes on its own (`differences`, as
   * read), its drawing kept. In the audit log by counts alone.
   */
  async forgetDrawings(
    drawings: readonly { work: string; drawn: string }[],
    renamed: readonly { id: string; from: WorkNames; to: WorkNames }[],
    described: readonly { id: string; from: string; to: string }[],
    differences: readonly { work: string; way: string; other: string }[],
    by: AuditActor
  ): Promise<void> {
    if (
      drawings.length === 0 &&
      renamed.length === 0 &&
      described.length === 0 &&
      differences.length === 0
    ) {
      return;
    }
    // Under the brain lock, as forgetting a document's readings is: no
    // intake lands between.
    await this.#withBrain(async () => {
      await Promise.resolve();
      this.ctx.storage.transactionSync(() => {
        const forgotten = drawings.flatMap(({ work, drawn }) =>
          this.#db
            .delete(drawnWorks)
            .where(and(eq(drawnWorks.work, work), eq(drawnWorks.drawn, drawn)))
            .returning({ work: drawnWorks.work })
            .all()
            .map((row) => row.work)
        );
        if (forgotten.length > 0) {
          this.#db
            .delete(checkedDifferences)
            .where(inList(checkedDifferences.work, forgotten))
            .run();
          this.#db
            .delete(drawFailures)
            .where(
              inList(
                drawFailures.item,
                forgotten.map((work) => `work:${work}`)
              )
            )
            .run();
        }
        // A checked difference holding a purged word goes on its own, if
        // still as read: the review shows one again only once a drawing is
        // checked anew.
        const unchecked = differences.flatMap(({ work, way, other }) =>
          this.#db
            .delete(checkedDifferences)
            .where(
              and(
                eq(checkedDifferences.work, work),
                eq(checkedDifferences.way, way),
                eq(checkedDifferences.other, other)
              )
            )
            .returning({ work: checkedDifferences.work })
            .all()
        ).length;
        let named = 0;
        for (const { id, from, to } of renamed) {
          named += this.#db
            .update(works)
            .set(to)
            .where(
              and(
                eq(works.id, id),
                eq(works.name, from.name),
                eq(works.local, from.local),
                eq(works.one, from.one),
                eq(works.many, from.many)
              )
            )
            .returning({ id: works.id })
            .all().length;
        }
        let rewritten = 0;
        for (const { id, from, to } of described) {
          rewritten += this.#db
            .update(teams)
            .set({ does: to })
            .where(and(eq(teams.id, id), eq(teams.does, from)))
            .returning({ id: teams.id })
            .all().length;
        }
        this.#purged();
        this.#changed(by, "onboarding.drawings.purged", {
          drawings: forgotten.length,
          differences: unchecked,
          works: named,
          teams: rewritten,
        });
      });
    });
    this.#deliverAudit();
    await this.#armDrawing();
  }

  /**
   * Grasp's staff's own text, as a Knowledge term purge reaches it
   * (staff-text-erasure.ts): how Stephen is set up (JSON, as stored).
   * Never served otherwise.
   */
  staffTextsSaid(): { setup: string | null } {
    const [row] = this.#db
      .select({ stephen: onboarding.stephen })
      .from(onboarding)
      .all();
    return { setup: row?.stephen ?? null };
  }

  /**
   * Keeps Stephen's setup as a Knowledge term purge rewrote it (`after`),
   * only if it is still as the purge read it (`before`): one saved since
   * is left to the purge to read again. In the audit log without its
   * words. Whether it was rewritten.
   */
  rewriteStaffTexts(
    before: { setup: string | null },
    after: { setup: string | null },
    by: AuditActor
  ): boolean {
    if (after.setup === before.setup) {
      return true;
    }
    let landed = false;
    this.ctx.storage.transactionSync(() => {
      if (this.staffTextsSaid().setup !== before.setup) {
        return;
      }
      this.#db.update(onboarding).set({ stephen: after.setup }).run();
      this.#changed(by, "onboarding.staff_text.purged", { setup: 1 });
      landed = true;
    });
    if (landed) {
      this.#deliverAudit();
    }
    return landed;
  }

  /**
   * Keeps where someone's interview is, from the device it is on. A save
   * from an older copy than the one kept is refused with the one kept, so
   * two tabs never quietly overwrite each other. Deleting moves the version
   * on too: only a copy opened since the delete saves again.
   */
  async saveInterview(
    secretMark: string,
    keyMark: string,
    version: number,
    progress: InterviewProgress,
    now: string = new Date().toISOString()
  ): Promise<LinkAnswer<InterviewSaved>> {
    // Each fact's revision, from the save alone, before anything here is
    // read: what an approval must name for the fact to count.
    const revisions = new Map(
      await Promise.all(
        progress.facts.map(
          async (fact) => [fact.id, await factRevision(fact)] as const
        )
      )
    );
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
      return answered({
        saved: false,
        version: link.version,
        progress: this.#forSpeaker(person.id, held),
      });
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
    // What counts is what they approved, at the revision they approved
    // (GRA-329), never what the page says it agreed to: an edit, or a fact
    // taken out, stops counting until it is approved as it is now.
    const before = this.#admittedKeys(person.id);
    const after = this.#admittedKeys(person.id, progress, revisions);
    const lost = before.some((key) => !after.includes(key));
    const changed = admissionKey(before) !== admissionKey(after);
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(links)
        .set({ version: next })
        .where(eq(links.person, person.id))
        .run();
      const kept = {
        progress: JSON.stringify(progress),
        updatedAt: now,
        revisions: JSON.stringify(Object.fromEntries(revisions)),
      };
      this.#db
        .insert(interviews)
        .values({ person: person.id, ...kept })
        .onConflictDoUpdate({ target: interviews.person, set: kept })
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
      if (changed) {
        this.#admissionChanged(person, after.length > 0, lost, now);
      }
    });
    if (lost) {
      // What rested on a revision that no longer counts leaves the brain
      // now, or from the alarm until it does.
      this.ctx.waitUntil(this.#afterForget([]));
    } else if (changed) {
      this.ctx.waitUntil(this.#alarmBy(Date.parse(now) + drawAfterMs));
    }
    return answered({ saved: true, version: next });
  }

  /**
   * They read what the interview is for (`participationNotice`) and agree
   * to take part: nothing they say is recorded or read by a model before
   * (GRA-329). The same notice agreed to again answers as the first time;
   * someone who withdrew can't take part again in this interview.
   */
  participate(
    secretMark: string,
    keyMark: string,
    notice: number,
    now: string = new Date().toISOString()
  ): LinkAnswer<InterviewParticipation> {
    const found = this.#onLink(secretMark, now, "save");
    if (!found.ok) {
      return found;
    }
    const { person, link } = found.value;
    if (link.keyMark === null || link.keyMark !== keyMark) {
      return refused("interview.elsewhere");
    }
    const [held] = this.#db
      .select()
      .from(participations)
      .where(eq(participations.person, person.id))
      .all();
    if (held !== undefined && held.withdrawnAt !== null) {
      return refused("interview.withdrawn");
    }
    if (notice !== participationNotice.version) {
      return refused("interview.notice_changed");
    }
    if (held?.notice === notice) {
      return answered({ notice, at: held.at });
    }
    const agreed = {
      notice,
      purpose: participationNotice.purpose,
      audience: participationNotice.audience,
      at: now,
    };
    this.ctx.storage.transactionSync(() => {
      this.#db
        .insert(participations)
        .values({ person: person.id, ...agreed })
        .onConflictDoUpdate({ target: participations.person, set: agreed })
        .run();
      this.#noted(person.id, "interview.participated", now);
    });
    return answered({ notice, at: now });
  }

  /**
   * They approve the facts read back to them, each at the revision they
   * saw: from now on those, exactly as they are, count (GRA-329). A
   * revision that isn't the one kept, read back from an older copy or
   * changed since, is refused with the copy kept, so they read it again.
   * The same approval asked again answers its first receipt.
   */
  async approve(
    secretMark: string,
    keyMark: string,
    facts: readonly ApprovedFact[],
    now: string = new Date().toISOString()
  ): Promise<LinkAnswer<InterviewApproval>> {
    // From the request alone, before anything here is read.
    const receipt = await receiptOf(facts);
    const found = this.#onLink(secretMark, now, "save");
    if (!found.ok) {
      return found;
    }
    const { person, link } = found.value;
    if (link.keyMark === null || link.keyMark !== keyMark) {
      return refused("interview.elsewhere");
    }
    const taking = this.#participating(person.id);
    if (taking !== null) {
      return refused(taking);
    }
    const progress = this.#held(person.id);
    const revisions = this.#revisionsOf(person.id);
    const standing = new Set(
      (progress?.facts ?? [])
        .filter(({ out }) => out !== true)
        .map(({ id }) => id)
    );
    const stale = facts.some(
      ({ id, revision }) => !standing.has(id) || revisions.get(id) !== revision
    );
    if (progress === null || stale) {
      return answered({
        approved: false,
        version: link.version,
        progress: this.#forSpeaker(person.id, progress),
      });
    }
    const [kept] = this.#db
      .select({ at: readbacks.at })
      .from(readbacks)
      .where(
        and(eq(readbacks.person, person.id), eq(readbacks.receipt, receipt))
      )
      .all();
    if (kept !== undefined) {
      return answered({ approved: true, receipt, at: kept.at });
    }
    const changed = this.ctx.storage.transactionSync(() => {
      const before = admissionKey(this.#admittedKeys(person.id));
      this.#db
        .insert(readbacks)
        .values({ person: person.id, receipt, at: now })
        .run();
      for (const { id, revision } of facts) {
        this.#db
          .insert(approvals)
          .values({ person: person.id, fact: id, revision, receipt, at: now })
          .onConflictDoNothing()
          .run();
      }
      this.#noted(person.id, "interview.approved", now);
      this.#queueReferral(person.id, now);
      const moved = admissionKey(this.#admittedKeys(person.id)) !== before;
      if (moved) {
        this.#admissionChanged(person, true, false, now);
      }
      return moved;
    });
    if (changed) {
      await this.#alarmBy(Date.parse(now) + drawAfterMs);
      this.#decideInterviews();
    }
    return answered({ approved: true, receipt, at: now });
  }

  /**
   * They withdraw (GRA-329), for good: from now on nothing they said is
   * recorded, read by a model, drawn or given to the brain; what the brain
   * has that rests on them is taken out now, or from the alarm until it
   * is, every drawing they were in is drawn again without them, and the
   * interviewer's lines that read it back are forgotten. What they said
   * stays theirs to read and delete. Works whenever deleting does;
   * withdrawing again answers as the first time.
   */
  async withdraw(
    secretMark: string,
    keyMark: string,
    now: string = new Date().toISOString()
  ): Promise<LinkAnswer<InterviewWithdrawal>> {
    const found = this.#onLink(secretMark, now, "delete");
    if (!found.ok) {
      return found;
    }
    const { person, link } = found.value;
    if (link.keyMark === null || link.keyMark !== keyMark) {
      return refused("interview.elsewhere");
    }
    const [held] = this.#db
      .select({ withdrawnAt: participations.withdrawnAt })
      .from(participations)
      .where(eq(participations.person, person.id))
      .all();
    if (held === undefined) {
      return refused("interview.not_participating");
    }
    if (held.withdrawnAt !== null) {
      return answered({ withdrawn: true, at: held.withdrawnAt });
    }
    const lines = await this.#lineKeysOf([person.id]);
    const said = this.ctx.storage.transactionSync(() => {
      this.#queueLines(lines.get(person.id) ?? []);
      this.#db
        .update(participations)
        .set({ withdrawnAt: now })
        .where(eq(participations.person, person.id))
        .run();
      this.#admissionChanged(person, false, true, now);
      this.#noted(person.id, "interview.withdrawn", now);
      return this.#saidIn(person.id);
    });
    // Final, with no undo (GRA-329): every output it was in is erased, the
    // brain's records now or from the alarm until they are, and the lines
    // of the interviewer's voice that read it back.
    await this.#afterForget([said]);
    return answered({ withdrawn: true, at: now });
  }

  /**
   * What one turn of someone's interview may know, from the device it is
   * on, while the interviews run: who they are, their team and lead, and
   * what Stephen knows of the company beforehand, and what earlier
   * interviews about their work left open. Never from the page,
   * which could say anything. `work` stays empty until the team's map
   * names their piece of work: Stephen then asks which one it is.
   */
  turnContext(
    secretMark: string,
    keyMark: string,
    now: string = new Date().toISOString()
  ): LinkAnswer<TurnContext> {
    const found = this.#onLink(secretMark, now, "save");
    if (!found.ok) {
      return found;
    }
    const { person, link, roster } = found.value;
    if (link.keyMark === null || link.keyMark !== keyMark) {
      return refused("interview.elsewhere");
    }
    // Nothing they said goes to a model before they agreed to take part.
    const taking = this.#participating(person.id);
    if (taking !== null) {
      return refused(taking);
    }
    return answered(this.#contextOf(person, roster));
  }

  /**
   * What a turn of someone's interview would know, by their roster ID,
   * whether their link is out or not: the Stephen Lab (lab.ts) keeps it
   * with an interview it plays back. Null for someone not on the roster.
   */
  contextOf(id: string): TurnContext | null {
    const roster = this.#roster();
    const person = roster?.people.find((each) => each.id === id);
    return roster === null || person === undefined
      ? null
      : this.#contextOf(person, roster);
  }

  #contextOf(person: Roster["people"][number], roster: Roster): TurnContext {
    const team = roster.teams.find(({ id }) => id === person.team);
    const lead = roster.people.find(
      ({ id }) => id === team?.lead && id !== person.id
    );
    const kind = leads(roster, person.id) ? "lead" : "own";
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
      ...(kind === "lead" ? [] : stillUnknown(this.#drawingAskedOf(person.id))),
      ...(kind === "lead" ? [] : this.#insteadKnown(person)),
      this.interviewBrief(),
      this.documentsBrief(teamName),
    ].filter((part) => part !== "");
    const terms = [
      ...(lead === undefined ? [] : [firstName(lead.name)]),
      ...members.map((each) => firstName(each.name)),
      ...(this.#stephen()?.terms ?? []),
      ...this.documents().flatMap(({ reading }) => reading.tools),
    ];
    return {
      kind,
      name: firstName(person.name),
      team: teamName,
      lead: lead === undefined ? null : firstName(lead.name),
      work: kind === "lead" ? "" : this.#workOf(person.id),
      known: known.join("\n\n"),
      terms: [...new Set(terms)],
    };
  }

  /**
   * The words to listen out for when someone talks (`listenFor`): the
   * company's name, the names of `person`'s team and its lead, the
   * company's own words from Stephen's setup, and the tools the shared
   * documents name. Without `person`, as for an admin, the team's names
   * are left out.
   */
  async listeningTerms(person?: string): Promise<string[]> {
    const roster = this.#roster();
    const own = roster?.people.find(({ id }) => id === person);
    const team = roster?.teams.find(({ id }) => id === own?.team);
    const names = (roster?.people ?? [])
      .filter(
        (each) =>
          own !== undefined &&
          (each.team === own.team || each.id === team?.lead) &&
          !each.away
      )
      .map(({ name }) => firstName(name));
    return listenFor([
      await companyName(this.env),
      ...(own === undefined ? [] : [firstName(own.name)]),
      ...(team === undefined ? [] : [team.name]),
      ...names,
      ...this.stephen().setup.terms,
      ...this.documents().flatMap(({ reading }) => reading.tools),
    ]);
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
          // Drawn from another generation than theirs now: a later
          // agreement, or a take-back, however close in time.
          or(
            isNull(interviewStates.drawnAt),
            sql`${interviewStates.drawnAt} IS NOT ${interviewStates.agreedAt} || '|' || ${interviewStates.revocations}`
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
    const facts = this.#admitted(person);
    if (state === undefined || state.agreedAt === null || facts.length === 0) {
      return null;
    }
    return {
      person,
      kind: state.kind,
      agreedAt: state.agreedAt,
      generation: `${state.agreedAt}|${state.revocations}`,
      admission: `${state.startedAt ?? ""}|${state.revocations}`,
      // Who does the work they were asked about names a colleague: it is
      // for putting right who is asked what (`#referOne`), never drawn.
      facts: facts
        .filter(({ tag }) => tag !== "who")
        .map(({ tag, record }) => ({ tag, record })),
    };
  }

  /**
   * Notes that what someone agreed to, as of their agreement's generation
   * `generation` (`DrawInput.generation`), was drawn: what they agree to
   * or take back after that is due again.
   */
  drawn(person: string, generation: string): void {
    this.#db
      .update(interviewStates)
      .set({ drawnAt: generation })
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
    let what = due.work === undefined ? "map" : "work";
    if (due.referral === true) {
      what = "referral";
    }
    try {
      if (due.referral === true) {
        await this.#referOne(due.id, at);
      } else if (due.work === undefined) {
        await this.#mapTeam(due.id, at);
      } else {
        await this.#drawWork(due.work, at);
      }
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
        if (due.referral === true) {
          // Who does what stays as it was: the work is drawn all the same.
          this.#db.delete(referrals).where(eq(referrals.person, due.id)).run();
          this.#db
            .delete(drawFailures)
            .where(eq(drawFailures.item, item))
            .run();
          this.#noted(about, "referral.gave_up", at, "grasp");
        } else if (due.work === undefined) {
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
   * Gives the brain what the next team waiting for it learned (GRA-367):
   * one whose drawings are all done, so what its people agreed to goes in
   * together. What fails is tried again after a minute, five and thirty;
   * then it's given up and logged until something new is agreed. Returns
   * what it gave (`brain:<team>`), or null.
   */
  async intakeNext(now: number = Date.now()): Promise<string | null> {
    return await this.#withBrain(async () => await this.#intakeDue(now));
  }

  async #intakeDue(now: number): Promise<string | null> {
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
      // Too many checks to put its claims together: nothing was written,
      // and the audit log says so (GRA-1084).
      if (error instanceof TooManyClaimChecksError) {
        this.#changed({ type: "system" }, "onboarding.claims.capped", {
          checks: claimChecksMax,
        });
        this.#deliverAudit();
      }
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
   * Takes out of the brain, for good, what rests on interviews that are
   * gone (`#toPurge`): after a delete, and from the alarm until it
   * succeeds. Returns how many records it took out.
   */
  async purgeBrain(): Promise<number> {
    return await this.#withBrain(async () => await this.#purgeNow());
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
   * The interviews of the people who agreed to what was read back and
   * still take part: someone who withdrew is never counted again
   * (GRA-329), in a source's people or in a week's interviews.
   */
  #agreedInterviews(): { person: string; completedAt: string | null }[] {
    return this.#db
      .select({
        person: interviewStates.person,
        completedAt: interviewStates.completedAt,
      })
      .from(interviewStates)
      .leftJoin(
        participations,
        eq(participations.person, interviewStates.person)
      )
      .where(
        and(
          isNotNull(interviewStates.agreedAt),
          isNull(participations.withdrawnAt)
        )
      )
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
    const states = this.#agreedInterviews();
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
   * How many interviews the brain learned from, week by week, never who
   * gave them or on which day (GRA-1278): the interviews of the people who
   * agreed and still take part, in teams whose interviews the brain holds,
   * by the Monday of the week each finished in. A week of fewer than
   * `minTeamShown` is left out, never added to another week: no line
   * stands for fewer people than a team's claim needs, and a week a
   * withdrawal takes below it goes without its rest showing up elsewhere,
   * where the difference would tell how many were left.
   */
  interviewWeeks(): { week: string; interviews: number }[] {
    const roster = this.#roster();
    const sent = new Set(
      this.#db
        .select({ team: brainTeams.team })
        .from(brainTeams)
        .where(isNotNull(brainTeams.sentAt))
        .all()
        .map(({ team }) => team)
    );
    const inSent = new Set(
      (roster?.people ?? [])
        .filter((person) => sent.has(person.team))
        .map(({ id }) => id)
    );
    const byWeek = new Map<string, number>();
    for (const { person, completedAt } of this.#agreedInterviews()) {
      if (completedAt !== null && inSent.has(person)) {
        const week = mondayOf(dayOf(completedAt));
        byWeek.set(week, (byWeek.get(week) ?? 0) + 1);
      }
    }
    return [...byWeek]
      .filter(([, count]) => count >= minTeamShown)
      .map(([week, count]) => ({ week, interviews: count }))
      .toSorted((a, b) => a.week.localeCompare(b.week));
  }

  /**
   * A team's pieces of work, as its map holds them, who is asked about
   * each, each as drawn from what its people agreed to, and how far it is
   * known: for staff, and for the drawing of each piece.
   */
  /** The pieces of work asked for more voices, by their onboarding ids. */
  #moreVoicesWanted(): Set<string> {
    return new Set(
      this.#db
        .select({ work: moreVoices.work })
        .from(moreVoices)
        .all()
        .map(({ work }) => work)
    );
  }

  /** The brain's id (`intakeIds.workflow`) of each piece of work, by its own id. */
  async #brainIdsOfWorks(): Promise<Map<string, string>> {
    const rows = this.#db
      .select({ id: works.id, team: works.team })
      .from(works)
      .all();
    return new Map(
      await Promise.all(
        rows.map(
          async ({ id, team }) =>
            [id, await intakeIds.workflow(team, id)] as const
        )
      )
    );
  }

  /**
   * Asks to hear more people about the piece of work the brain knows as
   * `brainWork`: whoever is asked about one of its team's work next is
   * asked about it first (`#askNewcomers`, a team's map drawn again).
   * The piece of work's own id, or null for one the onboarding has no
   * longer. Asking twice changes nothing.
   */
  async askMoreVoices(brainWork: string): Promise<string | null> {
    const ids = await this.#brainIdsOfWorks();
    const work = [...ids].find(([, brainId]) => brainId === brainWork)?.[0];
    if (work === undefined) {
      return null;
    }
    this.#db
      .insert(moreVoices)
      .values({ work, at: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
    return work;
  }

  /** The brain's ids of the pieces of work asked for more voices. */
  async moreVoicesAsked(): Promise<string[]> {
    const wanted = this.#moreVoicesWanted();
    const ids = await this.#brainIdsOfWorks();
    return [...ids].flatMap(([work, brainId]) =>
      wanted.has(work) ? [brainId] : []
    );
  }

  teamWorks(team: string): TeamWork[] {
    const asked = this.#db.select().from(askedAbout).all();
    const rules = this.#rules();
    const byHand = this.#countedWorks();
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
    const settled = this.#settled();
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
          known: knownOf(
            drawn,
            {
              id: row.id,
              team,
              told,
              doers: doers.filter((id) => !away.has(id)),
              lead,
              holds: settled.get(row.id) ?? null,
              counted: byHand.has(row.id),
            },
            rules
          ),
        };
      });
  }

  /** How the admin settled each piece of work told two ways, by its id. */
  #settled(): Map<string, SettleChoice> {
    return new Map(
      this.#db
        .select()
        .from(settledWorks)
        .all()
        .map(({ work, holds }) => [work, holds])
    );
  }

  /**
   * The pieces of work of the teams that take part, as drawn, with the
   * differences nobody could explain among them: what the review, and how
   * much of it is known, are read from.
   */
  #reviewed(): {
    differences: Difference[];
    mapped: number;
    works: number;
    known: number;
  } {
    const settled = this.#settled();
    const checked = new Map(
      this.#db
        .select()
        .from(checkedDifferences)
        .all()
        .map((row) => [row.work, row])
    );
    const differences: Difference[] = [];
    let mapped = 0;
    let all = 0;
    let known = 0;
    for (const team of this.#roster()?.teams ?? []) {
      if (team.off) {
        continue;
      }
      // A team whose interviews the brain doesn't hold shows no
      // difference: too few told their own work (GRA-1084).
      const heard = this.#tellers(team.id).length >= minTeamShown;
      for (const work of this.teamWorks(team.id)) {
        all += 1;
        if (
          work.known.state === "complete" ||
          work.known.state === "variants"
        ) {
          known += 1;
        }
        const { drawn } = work;
        if (drawn === null || drawn.steps.length === 0) {
          continue;
        }
        mapped += 1;
        const { differs } = drawn;
        // Shown only when the brain's intake checked five or more people
        // behind each way, in this drawing, and without a name in either
        // (GRA-1084): never one person's way of doing it.
        const check = checked.get(work.id);
        if (
          differs?.why === "conflict" &&
          heard &&
          check?.drawnAt === drawn.at
        ) {
          differences.push({
            work: work.id,
            name: work.local === "" ? work.name : work.local,
            team: team.name,
            way: check.way,
            other: check.other,
            holds: settled.get(work.id) ?? null,
          });
        }
      }
    }
    return { differences, mapped, works: all, known };
  }

  /**
   * What needs the company's admin at the end: the steps people told two
   * ways and nobody could say why, settled or not, and how many pieces of
   * work are mapped. Never who told which way.
   */
  review(): OnboardingReview {
    const { differences, mapped } = this.#reviewed();
    return { differences, mapped };
  }

  /**
   * How much of the review is in, 0 to 1, for what Grasp knows: half how
   * much of what needs the admin is settled, half how much of the work is
   * known. Nothing counts before any piece of work is drawn.
   */
  reviewKnown(): number {
    const { differences, mapped, works: all, known } = this.#reviewed();
    if (mapped === 0) {
      return 0;
    }
    const settled = differences.filter(({ holds }) => holds !== null).length;
    return (
      0.5 * (differences.length === 0 ? 1 : settled / differences.length) +
      0.5 * (known / all)
    );
  }

  /**
   * Settles a piece of work told two ways that nobody could explain: both
   * ways kept, or which way holds. It can be settled again another way.
   * Null when nothing about it needs settling.
   */
  settle(
    work: string,
    holds: SettleChoice,
    by: AuditActor
  ): OnboardingReview | null {
    const open = this.#reviewed().differences.some(
      (difference) => difference.work === work
    );
    if (!open) {
      return null;
    }
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.#db
        .insert(settledWorks)
        .values({ work, holds, at })
        .onConflictDoUpdate({ target: settledWorks.work, set: { holds, at } })
        .run();
      this.#changed(by, "onboarding.work.settled", { holds });
    });
    this.#deliverAudit();
    return this.review();
  }

  /** The list after `change`, held to the roster's rules; or why it can't be. */

  /**
   * Every piece of work, team by team in the roster's order, as staff see
   * it (GRA-377): as its team's map holds it, with its drawing, whether
   * someone agreed to more since, this organization's rules and the
   * pieces Grasp counts as known by hand.
   */
  staffWorks(): StaffWorks {
    const roster = this.#roster();
    const order = new Map(roster?.teams.map(({ id }, index) => [id, index]));
    const due = new Set(this.#worksToDraw(Date.now()).map(({ id }) => id));
    const drawings = new Map(
      this.#db
        .select({ work: drawnWorks.work, drawn: drawnWorks.drawn })
        .from(drawnWorks)
        .all()
        .map(({ work, drawn }) => [work, drawingOf(drawn)])
    );
    const all = this.#db
      .select()
      .from(works)
      .all()
      .filter(({ team }) => order.has(team))
      .toSorted(
        (a, b) =>
          (order.get(a.team) ?? 0) - (order.get(b.team) ?? 0) ||
          a.position - b.position
      )
      .map((row): WorkRecord => ({
        id: row.id,
        team: row.team,
        name: row.name,
        local: row.local,
        item: [row.one, row.many],
        doers: doersOf(row.doers),
        share: row.share,
        from: "lead",
        drawn: drawings.get(row.id) ?? null,
        stale: due.has(row.id),
      }));
    const ids = new Set(all.map(({ id }) => id));
    return {
      works: all,
      rules: this.#rules(),
      counted: [...this.#countedWorks()].filter((id) => ids.has(id)),
    };
  }

  /**
   * Sets when a piece of work counts as known here; null takes the
   * starting values back. In the log and the audit log with the values.
   */
  setRules(rules: OrgRules | null, by: AuditActor): void {
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(onboarding)
        .set({ rules: rules === null ? null : JSON.stringify(rules) })
        .where(eq(onboarding.id, 1))
        .run();
      this.#changed(
        by,
        rules === null ? "onboarding.rules.reset" : "onboarding.rules.set",
        rules === null ? {} : { ...rules }
      );
    });
    this.#deliverAudit();
  }

  /**
   * Counts a piece of work as known by hand, or leaves it to the rules
   * again. False when there is no such piece of work.
   */
  countAsKnown(work: string, known: boolean, by: AuditActor): boolean {
    return this.ctx.storage.transactionSync(() => {
      const [row] = this.#db
        .select({ id: works.id })
        .from(works)
        .where(eq(works.id, work))
        .all();
      if (row === undefined) {
        return false;
      }
      if (known) {
        this.#db
          .insert(countedWorks)
          .values({ work, at: new Date().toISOString(), by: whoIs(by) })
          .onConflictDoNothing()
          .run();
      } else {
        this.#db.delete(countedWorks).where(eq(countedWorks.work, work)).run();
      }
      this.#changed(
        by,
        known ? "onboarding.work.counted" : "onboarding.work.uncounted",
        { work }
      );
      return true;
    });
  }

  /**
   * Draws a piece of work again from everything its people agreed to, as
   * though none of it was drawn yet, at the next alarm: what was drawn
   * stays until the new drawing replaces it, and one that kept failing is
   * tried again at once. Says when there is no such piece of work, or
   * nothing it could be drawn from.
   */
  async drawWorkAgain(
    work: string,
    by: AuditActor
  ): Promise<"drawing" | "no_work" | "nothing"> {
    const due = this.ctx.storage.transactionSync(() => {
      const known = this.#db
        .select({ id: works.id })
        .from(works)
        .where(eq(works.id, work))
        .all();
      if (known.length === 0) {
        return "no_work";
      }
      const [row] = this.#db
        .select({ agreed: drawnWorks.agreed })
        .from(drawnWorks)
        .where(eq(drawnWorks.work, work))
        .all();
      if (row !== undefined) {
        this.#db
          .update(drawnWorks)
          .set({ agreed: "{}" })
          .where(eq(drawnWorks.work, work))
          .run();
      }
      this.#db
        .delete(drawFailures)
        .where(eq(drawFailures.item, `work:${work}`))
        .run();
      const isDue = this.#worksToDraw(Date.now()).some(({ id }) => id === work);
      if (!isDue) {
        // Nothing to draw it from: as it was.
        if (row !== undefined) {
          this.#db
            .update(drawnWorks)
            .set({ agreed: row.agreed })
            .where(eq(drawnWorks.work, work))
            .run();
        }
        return "nothing";
      }
      this.#changed(by, "onboarding.work.redraw", { work });
      return "drawing";
    });
    if (due === "drawing") {
      this.#deliverAudit();
      await this.#armDrawing();
    }
    return due;
  }

  /**
   * Deletes someone's interview, from the device it is on, at any time
   * their link opens there: what they said, and everything drawn from it,
   * is gone at once (`#forget`), and a copy left open elsewhere can't save
   * it back. Only the onboarding's own log has it (`#forget`), never the
   * audit log: its moment would tell the admin whose it was.
   */
  async deleteInterview(
    secretMark: string,
    keyMark: string,
    now: string = new Date().toISOString()
  ): Promise<LinkAnswer<{ deleted: true }>> {
    const found = this.#onLink(secretMark, now, "delete");
    if (!found.ok) {
      return found;
    }
    const { person, link } = found.value;
    if (link.keyMark === null || link.keyMark !== keyMark) {
      return refused("interview.elsewhere");
    }
    const lines = await this.#lineKeysOf([person.id]);
    const said = this.ctx.storage.transactionSync(() => {
      const forgotten = this.#forget(
        person.id,
        now,
        "interview.deleted",
        interviewee,
        lines
      );
      this.#db
        .update(links)
        .set({ deletedAt: now, version: link.version + 1 })
        .where(eq(links.person, person.id))
        .run();
      return forgotten;
    });
    await this.#afterForget([said]);
    return answered({ deleted: true });
  }

  /**
   * A new start for someone who lost the device their interview was on:
   * what they said goes, and the link opens again for the next device to
   * open it. Staff do it; the audit log has that they did, not for whom.
   */
  async newStart(person: string, by: AuditActor): Promise<boolean> {
    const [link] = this.#db
      .select()
      .from(links)
      .where(eq(links.person, person))
      .all();
    if (link === undefined) {
      return false;
    }
    const now = new Date().toISOString();
    const lines = await this.#lineKeysOf([person]);
    const said = this.ctx.storage.transactionSync(() => {
      const forgotten = this.#forget(
        person,
        now,
        "interview.new_start",
        whoIs(by),
        lines
      );
      this.#db
        .update(links)
        .set({ keyMark: null, deletedAt: null, version: link.version + 1 })
        .where(eq(links.person, person))
        .run();
      this.#changed(by, "onboarding.interview.restarted", {});
      return forgotten;
    });
    this.#deliverAudit();
    // The new start is made: failing it now would have the same command,
    // given again, start anew a second time and take what was said since.
    try {
      await this.#afterForget([said]);
    } catch (error) {
      log.error("onboarding.after_forget_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    return true;
  }

  /**
   * Sends every mail of someone's that failed again, from its first try,
   * to their address as the roster has it now: staff do it once what
   * stopped it is put right, an address the admin corrected among it.
   * Their link with the reminder, when both failed: the link is what the
   * company's admin is told failed (`#linkMailFailed`), so it must go too.
   * A reminder only while it is still owed (`#reminderOwed`): never to
   * someone who finished, withdrew or deleted their interview since it
   * failed. The audit log has that staff did, never for whom nor which
   * mail: the admin reads it, and a reminder goes only to whoever hasn't
   * finished. Says why when nothing goes: none failed, they have no
   * address now, or what failed was a reminder no longer owed.
   */
  sendAgain(
    person: string,
    by: AuditActor
  ): "sent" | "none_failed" | "no_address" | "not_owed" {
    const failed = mailAbout(this.ctx.storage.sql, person).filter(
      ({ state }) => state === "failed"
    );
    if (failed.length === 0) {
      return "none_failed";
    }
    const to = this.#roster()?.people.find(({ id }) => id === person)?.email;
    if (to === undefined || to === "") {
      return "no_address";
    }
    const owed = this.#reminderOwed(person);
    const again = failed.filter(
      ({ key }) => owed || !key.startsWith("reminder/")
    );
    if (again.length === 0) {
      return "not_owed";
    }
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      for (const { key } of again) {
        const [kind = "mail"] = key.split("/");
        if (kind === "link" || kind === "reminder") {
          this.#linkWentTo(person, to);
        }
        // All due at once, so they go in the order they were first queued.
        queueAgain(this.ctx.storage.sql, key, to, Date.parse(now));
        this.#noted(person, `mail.${kind}.again`, now, whoIs(by));
      }
      this.#changed(by, "onboarding.mail.resent", {});
    });
    this.#deliverAudit();
    this.#deliverMailSoon();
    // A send-again to a second address ended a link: owed at once.
    this.#decideInterviews();
    return "sent";
  }

  /**
   * Whether `person` is still owed their reminder now (`owesReminder`),
   * reading only what the rule needs of them: when a failed reminder is
   * sent again, and again as it goes (`#mailWanted`), since they may have
   * finished in between.
   */
  #reminderOwed(person: string): boolean {
    const [one] = this.#db
      .select()
      .from(people)
      .where(eq(people.id, person))
      .all();
    if (one === undefined) {
      return false;
    }
    // Their team alone: all `takingPart` reads of the roster.
    const theirs = this.#db
      .select()
      .from(teams)
      .where(eq(teams.id, one.team))
      .all();
    const [link] = this.#db
      .select({ deletedAt: links.deletedAt })
      .from(links)
      .where(eq(links.person, person))
      .all();
    const [state] = this.#db
      .select({ completedAt: interviewStates.completedAt })
      .from(interviewStates)
      .where(eq(interviewStates.person, person))
      .all();
    return owesReminder({
      takingPart: takingPart({ teams: theirs, people: [one] }, one),
      email: one.email,
      link,
      completed: (state?.completedAt ?? null) !== null,
      withdrawn: this.#withdrawnAt(person) !== null,
    });
  }

  /** Whether a mail about to go still should: a reminder only while it is owed. */
  #mailWanted({ key, about }: { key: string; about: string | null }): boolean {
    return (
      !key.startsWith("reminder/") ||
      (about !== null && this.#reminderOwed(about))
    );
  }

  /** People whose link went out, and when: for the links themselves (GRA-287) and the admin's list. */
  sentLinks(): { person: string; sentAt: string }[] {
    return this.#db
      .select({ person: links.person, sentAt: links.sentAt })
      .from(links)
      .orderBy(asc(links.sentAt), asc(links.person))
      .all();
  }

  /**
   * Everyone who takes part, or whose link is out, in the roster's order,
   * with their link once it is out: for the company's admin to send
   * themselves. A link is new to them until they take it.
   */
  async linksToSend(): Promise<LinkToSend[]> {
    const roster = this.#roster();
    if (roster === null) {
      return [];
    }
    const out = new Map(
      this.#db
        .select({ person: links.person, takenAt: links.takenAt })
        .from(links)
        .all()
        .map(({ person, takenAt }) => [person, takenAt])
    );
    const teamName = new Map(roster.teams.map(({ id, name }) => [id, name]));
    const listed = roster.people.filter(
      (person) => takingPart(roster, person) || out.has(person.id)
    );
    return await Promise.all(
      listed.map(async (person) => {
        const taken = out.get(person.id);
        return {
          person: person.id,
          name: person.name,
          team: teamName.get(person.team) ?? "",
          email: person.email,
          path: taken === undefined ? null : await this.linkOf(person.id),
          fresh: taken === null,
          mailFailed: this.#linkMailFailed(person.id),
        };
      })
    );
  }

  /**
   * The admin took these people's links to send: those out and new are
   * new no more. The audit log has how many, never whose. Returns how
   * many were new.
   */
  linksTaken(persons: readonly string[], by: AuditActor): number {
    if (persons.length === 0) {
      return 0;
    }
    const now = new Date().toISOString();
    const taken = this.ctx.storage.transactionSync(() => {
      let count = 0;
      // A few at a time: a query binds a hundred values at most.
      for (let at = 0; at < persons.length; at += takenPage) {
        count += this.#db
          .update(links)
          .set({ takenAt: now })
          .where(
            and(
              inArray(links.person, persons.slice(at, at + takenPage)),
              isNull(links.takenAt)
            )
          )
          .returning({ person: links.person })
          .all().length;
      }
      if (count > 0) {
        this.#changed(by, "onboarding.links.taken", { count });
      }
      return count;
    });
    if (taken > 0) {
      this.#deliverAudit();
    }
    return taken;
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
    // The interviewer's voice reads what this is before they agree to take
    // part, so it doesn't wait for that; once they withdrew it says nothing.
    if (this.#withdrawnAt(person.id) !== null) {
      return refused("interview.withdrawn");
    }
    const who = `${linkWho}${person.id}`;
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
    this.ctx.storage.transactionSync(() => {
      this.#countSeconds(who, { purpose, model: "voice", seconds }, now);
    });
  }

  /**
   * Whom a live transcription on someone's link is for, from the device
   * it is on, while their interview may be saved, as a line said is
   * (`speechOnLink`): the key what is heard is counted under, the seconds
   * heard under it today, and the person, for the onboarding's own log.
   */
  transcriptionOnLink(
    secretMark: string,
    keyMark: string,
    now: string = new Date().toISOString()
  ): LinkAnswer<{ who: string; heard: number; person: string }> {
    const found = this.speechOnLink(secretMark, keyMark, now);
    if (!found.ok) {
      return found;
    }
    const who = heardKey(found.value.who);
    const person = found.value.who.slice(linkWho.length);
    // Nothing they say is heard before they agreed to take part.
    const taking = this.#participating(person);
    if (taking !== null) {
      return refused(taking);
    }
    return answered({ who, heard: this.voiceSaid(who, now), person });
  }

  /**
   * Whether a live transcription open on someone's link may go on, as it
   * might open (`transcriptionOnLink`): checked again while it is open,
   * so it doesn't count as a call on the link.
   */
  transcriptionStill(
    secretMark: string,
    keyMark: string,
    now: string = new Date().toISOString()
  ): LinkAnswer<null> {
    const found = this.#onLink(secretMark, now, "save", false);
    if (!found.ok) {
      return found;
    }
    const { person, link } = found.value;
    if (link.keyMark === null || link.keyMark !== keyMark) {
      return refused("interview.elsewhere");
    }
    // Withdrawing stops what is being heard, too.
    const taking = this.#participating(person.id);
    if (taking !== null) {
      return refused(taking);
    }
    return answered(null);
  }

  /** Seconds heard by live transcription for an admin today. */
  heardForAdmin(
    userId: string,
    now: string = new Date().toISOString()
  ): { who: string; heard: number } {
    const who = heardKey(`admin:${userId}`);
    return { who, heard: this.voiceSaid(who, now) };
  }

  /**
   * Opens a live transcription for `who`: holds the seconds it may hear
   * against `who`'s budget for today, at once, so sockets opened side by
   * side share one budget rather than each finding it untouched, and a
   * socket whose close is never counted keeps what it held. Notes it on
   * someone's link in the onboarding's own log, which only staff read,
   * never in the audit log, which would tell the company who talked, and
   * when; for an admin in the audit log, with the session's ID and
   * nothing heard. The seconds held, and the day they are held on; none,
   * and nothing noted, when the budget is spent.
   */
  transcriptionOpened(
    session: TranscriptionSessionNote & {
      who: string;
      budget: number;
      most: number;
    },
    now: string = new Date().toISOString()
  ): { held: number; day: string } {
    const day = now.slice(0, 10);
    const held = this.ctx.storage.transactionSync(() => {
      const left = session.budget - this.voiceSaid(session.who, now);
      const most = Math.floor(Math.min(left, session.most));
      if (most <= 0) {
        return 0;
      }
      this.#db.delete(voiceUse).where(lt(voiceUse.day, day)).run();
      this.#db
        .insert(voiceUse)
        .values({ who: session.who, day, seconds: most })
        .onConflictDoUpdate({
          target: [voiceUse.who, voiceUse.day],
          set: { seconds: sql`${voiceUse.seconds} + ${most}` },
        })
        .run();
      if (session.person === undefined) {
        this.#changed(session.by, "onboarding.transcription.opened", {
          session: session.id,
        });
      } else {
        this.#noted(session.person, "transcription.opened", now);
      }
      return most;
    });
    if (held > 0 && session.person === undefined) {
      this.#deliverAudit();
    }
    return { held, day };
  }

  /**
   * Counts a live transcription once it closed: the seconds of audio it
   * heard in the onboarding's use, what it held and didn't hear given
   * back to `who`'s budget on the day it was held (`transcriptionOpened`),
   * and notes it as it was opened, with how it ended. Never anything
   * heard.
   */
  transcriptionClosed(
    session: TranscriptionSessionNote & {
      who: string;
      purpose: Took["purpose"];
      seconds: number;
      held: number;
      day: string;
      ended: string;
    },
    now: string = new Date().toISOString()
  ): void {
    const seconds = Math.min(counted(session.seconds), session.held);
    const back = session.held - seconds;
    this.ctx.storage.transactionSync(() => {
      if (back > 0) {
        this.#db
          .update(voiceUse)
          .set({ seconds: sql`max(${voiceUse.seconds} - ${back}, 0)` })
          .where(
            and(eq(voiceUse.who, session.who), eq(voiceUse.day, session.day))
          )
          .run();
      }
      this.meter(
        { purpose: session.purpose, model: "transcription", seconds },
        now
      );
      if (session.person === undefined) {
        this.#changed(session.by, "onboarding.transcription.closed", {
          session: session.id,
          seconds: Math.round(seconds),
          ended: session.ended,
        });
      } else {
        this.#noted(session.person, "transcription.closed", now);
      }
    });
    if (session.person === undefined) {
      this.#deliverAudit();
    }
  }

  /**
   * Counts a recording written down for `who` (hear.ts): its seconds,
   * against the same budget as live transcription's, and in the
   * onboarding's use. Never anything heard.
   */
  countHeard(
    who: string,
    purpose: Took["purpose"],
    seconds: number,
    now: string = new Date().toISOString()
  ): void {
    this.ctx.storage.transactionSync(() => {
      this.#countSeconds(
        who,
        { purpose, model: "transcription", seconds },
        now
      );
    });
  }

  /** Adds `took`'s seconds to `who`'s today, and to the onboarding's use; the days before today go. */
  #countSeconds(
    who: string,
    took: Took & { seconds: number },
    now: string
  ): void {
    const day = now.slice(0, 10);
    const add = counted(took.seconds);
    this.#db.delete(voiceUse).where(lt(voiceUse.day, day)).run();
    this.#db
      .insert(voiceUse)
      .values({ who, day, seconds: add })
      .onConflictDoUpdate({
        target: [voiceUse.who, voiceUse.day],
        set: { seconds: sql`${voiceUse.seconds} + ${add}` },
      })
      .run();
    this.meter({ ...took, seconds: add }, now);
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
   * Notes what one turn of an interview ran on: the text that spoke, its
   * interviewer and language, kept with the interview of the link's
   * person, so the lines of its voice can be found again when the
   * interview goes (`#saidIn`). The turn checked the link and the device
   * first (`turnContext`).
   */
  turnRan(
    secretMark: string,
    ran: Omit<typeof interviewSettings.$inferInsert, "person">
  ): void {
    const [code] = this.#db
      .select({ person: linkCodes.person })
      .from(linkCodes)
      .where(eq(linkCodes.mark, secretMark))
      .all();
    if (code === undefined) {
      return;
    }
    this.#db
      .insert(interviewSettings)
      .values({ person: code.person, ...ran })
      .onConflictDoUpdate({ target: interviewSettings.person, set: ran })
      .run();
  }

  /** Where the agreements stand, as staff last said; none before they did. */
  agreements(): Agreements | null {
    return this.#row().agreements;
  }

  /** Whether the team is told: a link ever went out, even to someone since taken off the roster. */
  #told(): boolean {
    const [row] = this.#db
      .select({ toldAt: onboarding.toldAt })
      .from(onboarding)
      .where(eq(onboarding.id, 1))
      .all();
    // Links sent before the store kept when the first went out count too.
    return (
      (row?.toldAt ?? null) !== null ||
      this.#db.select({ person: links.person }).from(links).limit(1).all()
        .length > 0
    );
  }

  /** Where the company's admin is in their onboarding: the screens they finished. */
  place(): SetupPlace {
    const [row] = this.#db
      .select({ place: onboarding.place })
      .from(onboarding)
      .where(eq(onboarding.id, 1))
      .all();
    const stored = row?.place ?? null;
    if (stored === null) {
      return { done: [] };
    }
    // One kept before a screen was renamed reads as none finished: they go through them again.
    const read = setupPlaceSchema.safeParse(JSON.parse(stored));
    return read.success ? read.data : { done: [] };
  }

  /**
   * Notes that the admin finished `steps`: added to what they finished
   * before, never taken away, so going back a screen loses nothing. In
   * the log and the audit log by the screens' names, only when one is new.
   */
  finishSteps(steps: readonly SetupStepId[], by: AuditActor): SetupPlace {
    const changed = this.ctx.storage.transactionSync(() => {
      const before = this.place();
      const next = withDone(before, steps);
      if (next.done.length === before.done.length) {
        return false;
      }
      this.#db
        .update(onboarding)
        .set({ place: JSON.stringify(next) })
        .where(eq(onboarding.id, 1))
        .run();
      this.#changed(by, "onboarding.place.set", {
        finished: next.done
          .filter((step) => !before.done.includes(step))
          .join(" "),
      });
      return true;
    });
    if (changed) {
      this.#deliverAudit();
    }
    return this.place();
  }

  /** How much onboarding the company goes through, and whether staff set it. */
  flow(): { flow: OnboardingFlow; changed: boolean } {
    const { flow, flowSet } = this.#row();
    return { flow, changed: flowSet };
  }

  /**
   * Sets how much onboarding the company goes through; null takes all of
   * it back. False, changing nothing, once the team is told and the flow
   * would take the interviews out: people were told they'd be heard, and
   * what they said is part of what Grasp knows. Checked and saved in one
   * transaction, so no link can go out between the two. Nothing a step
   * kept is removed when it is switched off. In the log and the audit log
   * by which steps are on, in order, and which of Grasp's own.
   */
  setFlow(flow: OnboardingFlow | null, by: AuditActor): boolean {
    const next = flow ?? defaultFlow;
    const saved = this.ctx.storage.transactionSync(() => {
      if (
        this.#told() &&
        flowInterviews(this.#row().flow) &&
        !flowInterviews(next)
      ) {
        return false;
      }
      this.#db
        .update(onboarding)
        .set({ flow: flow === null ? null : JSON.stringify(flow) })
        .where(eq(onboarding.id, 1))
        .run();
      this.#changed(
        by,
        flow === null ? "onboarding.flow.reset" : "onboarding.flow.set",
        flow === null
          ? {}
          : {
              on: flow.on,
              steps: flow.steps
                .filter(({ on }) => on)
                .map(({ id }) => id)
                .join(" "),
              kickoff: flow.grasp.kickoff,
              agreements: flowAgreements
                .filter((agreement) => flow.grasp.agreements[agreement])
                .join(" "),
            }
      );
      return true;
    });
    if (saved) {
      this.#deliverAudit();
    }
    return saved;
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

  /**
   * The documents the admin shared, the newest first: those checked
   * against the purges since their reading started (`checkDocument`), or,
   * for a purge, `unchecked` too.
   */
  documents(unchecked = false): OnboardingDocument[] {
    return this.#db
      .select()
      .from(documents)
      .where(unchecked ? undefined : isNull(documents.checkMark))
      .orderBy(desc(documents.at))
      .all()
      .map(documentOf);
  }

  /**
   * The documents still waiting to be checked that were added before
   * `before`, each with the erasure mark its reading started at: their writer never
   * checked them.
   */
  uncheckedDocuments(
    before: Date
  ): { id: string; name: string; checkMark: number }[] {
    return this.#db
      .select({
        id: documents.id,
        name: documents.name,
        checkMark: documents.checkMark,
      })
      .from(documents)
      .where(
        and(
          isNotNull(documents.checkMark),
          lt(documents.at, before.toISOString())
        )
      )
      .all()
      .flatMap(({ checkMark, ...rest }) =>
        checkMark === null ? [] : [{ ...rest, checkMark }]
      );
  }

  /** Serves a document checked against the purges since its reading started. */
  checkDocument(id: string): void {
    this.#db
      .update(documents)
      .set({ checkMark: null })
      .where(eq(documents.id, id))
      .run();
  }

  /**
   * Keeps a shared document's reading, which started at erasure mark
   * `checkMark`,
   * unchecked (`checkDocument`); in the log and the audit log without its
   * words.
   */
  addDocument(
    kept: { id: string; name: string; reading: DocumentReading },
    checkMark: number,
    by: AuditActor
  ): OnboardingDocument {
    const row = {
      id: kept.id,
      name: kept.name,
      at: new Date().toISOString(),
      by: whoIs(by),
      reading: JSON.stringify(kept.reading),
      answer: null,
      checkMark,
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

  /** Keeps the admin's answer to a checked document's question; null for no such document. */
  answerDocument(
    id: string,
    answer: string,
    by: AuditActor
  ): OnboardingDocument | null {
    const [row] = this.#db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), isNull(documents.checkMark)))
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
   * Forgets shared documents' readings for good, as a Knowledge purge
   * reached them (documents.ts `documentReadingErasure`): each reading,
   * its question and the admin's answer, so neither Stephen's context nor
   * the brain's sources and tools (brain-rpc.ts) show them again; every
   * drawing made since the first of them was shared, which may have had
   * it for context, to be drawn again without it; and every drawing the
   * brain was given since (`purgeOnboardingDrawings`), each of which is
   * given again once drawn again. The brain first: when that fails,
   * nothing here has changed, and running the purge again finds the
   * readings still here. In the audit log by counts alone. Within
   * `#withBrain`, so no intake lands between. Returns how many readings
   * it forgot.
   */
  async forgetDocuments(
    ids: readonly string[],
    by: AuditActor
  ): Promise<number> {
    return await this.#withBrain(async () => {
      const rows = this.#db
        .select({ id: documents.id, at: documents.at })
        .from(documents)
        .where(inList(documents.id, ids))
        .all();
      const [first] = rows.map(({ at }) => at).toSorted();
      if (first === undefined) {
        return 0;
      }
      const purged = await purgeOnboardingDrawings(this.env, new Date(first));
      const now = new Date().toISOString();
      this.ctx.storage.transactionSync(() => {
        this.#db
          .delete(documents)
          .where(
            inList(
              documents.id,
              rows.map(({ id }) => id)
            )
          )
          .run();
        const forgotten = this.#db
          .select({ work: drawnWorks.work })
          .from(drawnWorks)
          .where(gte(drawnWorks.at, first))
          .all()
          .map(({ work }) => work);
        this.#db
          .delete(drawnWorks)
          .where(inList(drawnWorks.work, forgotten))
          .run();
        // And the ways of a difference checked in them: words of theirs.
        this.#db
          .delete(checkedDifferences)
          .where(inList(checkedDifferences.work, forgotten))
          .run();
        this.#db
          .delete(drawFailures)
          .where(
            inList(
              drawFailures.item,
              forgotten.map((work) => `work:${work}`)
            )
          )
          .run();
        // A drawing given since but drawn before is given again as it is.
        const given = this.#db
          .selectDistinct({ team: brainSent.team })
          .from(brainSent)
          .where(inList(brainSent.record, purged))
          .all();
        this.#db
          .delete(brainSent)
          .where(inList(brainSent.record, purged))
          .run();
        for (const { team } of given) {
          this.#brainDue(team, now);
        }
        this.#changed(by, "onboarding.document.purged", {
          documents: rows.length,
          drawings: forgotten.length,
          records: purged.length,
        });
      });
      this.#deliverAudit();
      await this.#armDrawing();
      return rows.length;
    });
  }

  /** The shared documents' ids: what a drawing has for context as it starts. */
  #sharedIds(): string[] {
    return this.#db
      .select({ id: documents.id })
      .from(documents)
      .where(isNull(documents.checkMark))
      .all()
      .map(({ id }) => id);
  }

  /** Whether any of `ids` (`#sharedIds`) was forgotten since (`forgetDocuments`). */
  #anyForgotten(ids: readonly string[]): boolean {
    if (ids.length === 0) {
      return false;
    }
    const left = this.#db
      .select({ id: documents.id })
      .from(documents)
      .where(inList(documents.id, ids))
      .all();
    return left.length < ids.length;
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
   * When the kickoff the brain names as a source came in: the kickoff's,
   * or one a purge forgot (`kickoffSourceKey`), whose records the purge
   * rewrote and still name it. Null when there was none.
   */
  kickoffSourceAt(): string | null {
    const [row] = this.#db.select({ at: kickoff.at }).from(kickoff).all();
    if (row !== undefined) {
      return row.at;
    }
    const forgotten = this.ctx.storage.kv.get(kickoffSourceKey);
    return typeof forgotten === "string" ? forgotten : null;
  }

  /**
   * Gives the brain the kickoff's records still owed (`kickoffOwedKey`),
   * under the brain lock it is called in, and clears what it kept. A
   * failure leaves them owed, for the alarm to keep.
   */
  async #keepOwedKickoffRecords(): Promise<void> {
    const owed = this.ctx.storage.kv.get(kickoffOwedKey);
    if (owed !== "replaced" && owed !== "answered") {
      return;
    }
    try {
      await keepKickoffRecords(this.env, this.kickoff(), {
        replaced: owed === "replaced",
      });
    } catch (error) {
      log.error("onboarding.kickoff_records_owed", {
        error: error instanceof Error ? error.name : "unknown",
      });
      await this.#alarmBy(Date.now() + purgeRetryMs);
      return;
    }
    // Kept as it was when read: an answer meanwhile owes its own.
    if (this.ctx.storage.kv.get(kickoffOwedKey) === owed) {
      this.ctx.storage.kv.delete(kickoffOwedKey);
    }
  }

  /** The kickoff's records still owed, kept now: what the alarm runs. */
  async keepKickoffRecordsNow(): Promise<void> {
    await this.#withBrain(async () => {
      await this.#keepOwedKickoffRecords();
    });
  }

  /** Notes that a purge reached, or rewrote, what the onboarding holds (`purgesKey`). */
  #purged(): void {
    this.ctx.storage.kv.put(purgesKey, this.purgeMark() + 1);
  }

  /**
   * How often a Knowledge content purge reached the onboarding, or
   * rewrote what it holds (`purgesKey`): what a save of the kickoff, or a
   * drawing, takes as it begins reading, and must still find as it keeps
   * what it made.
   */
  purgeMark(): number {
    const held = this.ctx.storage.kv.get(purgesKey);
    return typeof held === "number" ? held : 0;
  }

  /**
   * Notes that a Knowledge content purge reached the onboarding, under
   * the brain lock, before it looks in the kickoff (kickoff-erasure.ts):
   * a save whose reading began before is refused (`saveKickoff`), so what
   * it read can't bring the purged words back. One saved already is what
   * the purge then looks in.
   */
  async notePurge(): Promise<void> {
    await this.#withBrain(async () => {
      this.#purged();
      await Promise.resolve();
    });
  }

  /**
   * Keeps the kickoff's transcript and its reading, replacing any before
   * them; the sponsor's answers stay, for they answer the company, not one
   * transcript. Then gives the brain what it holds (kickoff-records.ts).
   * Under the brain lock, as the kickoff's purge is (`forgetKickoff`): a
   * save whose reading began before a content purge reached the
   * onboarding (`mark`, `purgeMark` as it began) is refused,
   * `kickoff.purged`, so the purged words never come back with it. In the log and the audit log
   * without its words.
   */
  async saveKickoff(
    kept: {
      transcript: string;
      fileName: string | null;
      reading: KickoffReading;
    },
    by: AuditActor,
    mark: number
  ): Promise<KickoffView> {
    return await this.#withBrain(async () => {
      if (this.purgeMark() !== mark) {
        throw kickoffErrors.create("kickoff.purged");
      }
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
        this.ctx.storage.kv.put(kickoffOwedKey, "replaced");
      });
      this.#deliverAudit();
      await this.#keepOwedKickoffRecords();
      return this.kickoff();
    });
  }

  /**
   * Every text the kickoff keeps: its transcript, each of its reading's
   * words and the sponsor's answers. What a Knowledge purge looks in
   * (kickoff-records.ts `kickoffErasure`); never served otherwise. Empty
   * before it is in.
   */
  kickoffTexts(): string[] {
    const [row] = this.#db.select().from(kickoff).all();
    if (row === undefined) {
      return [];
    }
    // Its file's name too: staff's upload may be named for what a purge
    // takes out.
    const texts: string[] = [
      row.transcript,
      ...(row.fileName === null ? [] : [row.fileName]),
    ];
    const collect = (value: unknown): void => {
      if (typeof value === "string") {
        texts.push(value);
      } else if (Array.isArray(value)) {
        for (const each of value) {
          collect(each);
        }
      } else if (typeof value === "object" && value !== null) {
        for (const each of Object.values(value)) {
          collect(each);
        }
      }
    };
    collect(JSON.parse(row.reading));
    collect(JSON.parse(row.answers));
    return texts;
  }

  /**
   * Forgets the kickoff for good, as a Knowledge purge reached it: its
   * transcript, its reading and the sponsor's answers, so nothing of it
   * is read, or given the brain, again (kickoff-records.ts). A purge is
   * the admin's hard delete: what was derived from it goes with it. The
   * brain's records it gave were rewritten by the same purge. In the audit
   * log without its words. Whether there was one to forget.
   */
  async forgetKickoff(by: AuditActor): Promise<boolean> {
    // Under the brain lock: a keep of its records already under way ends
    // first (and the same purge rewrites what it kept); one after finds
    // no kickoff, and keeps nothing.
    return await this.#withBrain(async () => {
      const [row] = this.#db
        .select({ id: kickoff.id, at: kickoff.at })
        .from(kickoff)
        .all();
      if (row === undefined) {
        return false;
      }
      this.ctx.storage.transactionSync(() => {
        this.#db.delete(kickoff).where(eq(kickoff.id, row.id)).run();
        // Its source stays, by its title and day alone: the records the
        // purge rewrote still name it. Nothing is owed of what's gone.
        this.ctx.storage.kv.put(kickoffSourceKey, row.at);
        this.ctx.storage.kv.delete(kickoffOwedKey);
        this.#changed(by, "onboarding.kickoff.purged", {});
      });
      this.#deliverAudit();
      return await Promise.resolve(true);
    });
  }

  /**
   * Keeps the sponsor's answer to what the kickoff left open about
   * `field`; an empty one takes it back. Then gives the brain what the
   * kickoff holds (kickoff-records.ts): an answer about the goals or the
   * pain is a new vision. Under the brain lock, as the kickoff's purge is
   * (`forgetKickoff`): after one, there is nothing to answer. False before
   * the kickoff is in.
   */
  async answerKickoff(
    field: VisionField,
    text: string,
    by: AuditActor
  ): Promise<boolean> {
    return await this.#withBrain(async () => {
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
        // A new kickoff's records not kept yet still retire the last one's.
        if (this.ctx.storage.kv.get(kickoffOwedKey) !== "replaced") {
          this.ctx.storage.kv.put(kickoffOwedKey, "answered");
        }
      });
      this.#deliverAudit();
      await this.#keepOwedKickoffRecords();
      return true;
    });
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

  /**
   * Everyone on the roster whose latest mail failed for good, by id: for
   * Grasp's admin snapshot (staff), never the company's admin, as it says
   * which mail.
   */
  failedMails(): Map<string, FailedMail> {
    const failed = new Map<string, FailedMail>();
    for (const { id } of this.#roster()?.people ?? []) {
      const mail = this.#failedMail(id);
      if (mail !== null) {
        failed.set(id, mail);
      }
    }
    return failed;
  }

  /**
   * Someone's latest mail, when it failed for good, for staff: which, why
   * and when. A mail sent or still queued since means it isn't, unless it
   * is their link that failed: the company's admin is told of that
   * (`#linkMailFailed`) until it goes, so staff see it too, to send it
   * again, though a reminder reached them since.
   */
  #failedMail(person: string): FailedMail | null {
    const mails = mailAbout(this.ctx.storage.sql, person);
    const [latest] = mails;
    const link = mails.find(({ key }) => key.startsWith("link/"));
    let failed: MailState | undefined;
    if (latest?.state === "failed") {
      failed = latest;
    } else if (link?.state === "failed") {
      failed = link;
    }
    if (failed === undefined) {
      return null;
    }
    const [kind] = failed.key.split("/");
    return {
      kind: kind === "reminder" ? "reminder" : "link",
      reason: failed.reason,
      at: failed.settledAt ?? failed.queuedAt,
    };
  }

  /**
   * Whether someone's latest link mail failed for good, and wasn't sent
   * since: what the company's admin is told, to put their address right
   * or hand them their link. Only the link, which everyone taking part
   * gets on their day whatever they do after: a reminder goes only to
   * whoever hasn't finished, so its failing, its kind, its date, or a
   * notice that appears once it fails, would tell the admin that of
   * someone they can name.
   */
  #linkMailFailed(person: string): boolean {
    const link = mailAbout(this.ctx.storage.sql, person).find(({ key }) =>
      key.startsWith("link/")
    );
    return link?.state === "failed";
  }

  /**
   * What a practice person said and approved, for the Stephen Lab alone
   * (lab.ts, on a local stack): the lab played them, and scores what was
   * written down. Never reached on a deployed core, where Grasp's staff
   * see no word of an interview (GRA-329).
   */
  practiceInterviewOf(person: string): {
    startedAt: string | null;
    completedAt: string | null;
    progress: InterviewProgress | null;
  } | null {
    if (!this.#onRoster(person)) {
      return null;
    }
    const state = this.#interviews().get(person);
    return {
      startedAt: state?.startedAt ?? null,
      completedAt: state?.completedAt ?? null,
      progress: this.#forSpeaker(person, this.#held(person)),
    };
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
   * Closes `person`'s link for good, as core asks as it erases them,
   * before their interview is deleted (person-erasure.ts): its code goes,
   * so it answers `interview.link_invalid`, it is marked erased, so no
   * code is made for it again, and the device it opened on is forgotten.
   * Unlike a delete on their own request, no new interview can be saved
   * under it. What they were asked about goes too (a referral naming them
   * may have set it, `#referOne`): nobody asks them anything again. Their
   * entry on the list stays, an admin's to remove; taken off the list, the
   * mark goes with the link.
   */
  closeLinkOf(person: string, now: string = new Date().toISOString()): void {
    this.ctx.storage.transactionSync(() => {
      this.#db.delete(linkCodes).where(eq(linkCodes.person, person)).run();
      this.#db.delete(askedAbout).where(eq(askedAbout.person, person)).run();
      // Mail still to go about them (a reminder, say) goes nowhere now.
      // Sent mail stays: the company's record, as the roster is.
      dropMailAbout(this.ctx.storage.sql, person);
      // Marked erased for good, so no code is made for the link again
      // (`linkOf`, `#writeRoster`): a missing code alone is a link not
      // made yet.
      this.#db
        .update(links)
        .set({
          keyMark: null,
          // Their account no longer reads anything of the onboarding's:
          // their interview leaves the new Brain (`owedErasures`).
          account: null,
          erasedAt: sql`coalesce(${links.erasedAt}, ${now})`,
        })
        .where(eq(links.person, person))
        .run();
      // Every address their link went to goes with them.
      this.#db
        .delete(linkAddresses)
        .where(eq(linkAddresses.person, person))
        .run();
    });
    this.#decideInterviews();
  }

  /**
   * Deletes `person`'s interview and closes their link for good, as core
   * asks once it erased whoever had their address (person-erasure.ts), but
   * only a link that went out by `sentBy`, when the erasure was asked for:
   * one sent after it went to someone the address was released to, whose
   * interview stays. Whether it deleted one.
   */
  async eraseInterviewOf(person: string, sentBy: string): Promise<boolean> {
    const [link] = this.#db
      .select({ sentAt: links.sentAt })
      .from(links)
      .where(eq(links.person, person))
      .all();
    if (link === undefined || link.sentAt > sentBy) {
      return false;
    }
    // Their link answers nothing any more, before anything waits: no new
    // interview is saved under the entry that stays, even while the
    // delete waits on the Brain's and the voice's cleanup.
    this.closeLinkOf(person);
    await this.deleteOnRequest(person, { type: "system" });
    return true;
  }

  /**
   * Who is on the list, by their ID and email, for core to find someone it
   * erases by the address that was theirs (person-erasure.ts): only core
   * asks, and nothing of it leaves core.
   */
  rosterEmails(): { id: string; email: string }[] {
    return this.#db
      .select({ id: people.id, email: people.email })
      .from(people)
      .all();
  }

  /**
   * Deletes someone's interview because they asked Grasp to: what they
   * said is gone at once, a copy left open can't save it back, and their
   * link opens a new one on the device it is on. False when no link of
   * theirs went out. The audit log has that staff did, not for whom.
   */
  async deleteOnRequest(
    person: string,
    by: AuditActor,
    now: string = new Date().toISOString()
  ): Promise<boolean> {
    const [link] = this.#db
      .select()
      .from(links)
      .where(eq(links.person, person))
      .all();
    if (link === undefined) {
      return false;
    }
    const lines = await this.#lineKeysOf([person]);
    const said = this.ctx.storage.transactionSync(() => {
      const forgotten = this.#forget(
        person,
        now,
        "interview.deleted",
        whoIs(by),
        lines
      );
      this.#db
        .update(links)
        .set({ deletedAt: now, version: link.version + 1 })
        .where(eq(links.person, person))
        .run();
      this.#changed(by, "onboarding.interview.deleted", {});
      return forgotten;
    });
    this.#deliverAudit();
    await this.#afterForget([said]);
    return true;
  }

  /**
   * What Grasp's admin reads of the links and interviews (admin-snapshot.ts),
   * by person: each link's times, and each interview as numbers. What was
   * said is read here, inside the store, and only its counts leave it.
   */
  adminFacts(): {
    told: boolean;
    mapped: string[];
    links: Omit<
      typeof links.$inferSelect,
      | "keyMark"
      | "version"
      | "ledTeam"
      | "takenAt"
      | "erasedAt"
      | "account"
      | "brainMark"
    >[];
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
        .select({
          state: interviewStates,
          version: interviewSettings.version,
          locale: interviewSettings.locale,
        })
        .from(interviewStates)
        .leftJoin(
          interviewSettings,
          eq(interviewSettings.person, interviewStates.person)
        )
        .all()
        .map(({ state, version, locale }) => ({
          ...state,
          ...(countsBy.get(state.person) ?? noCounts),
          version: version ?? null,
          locale: locale ?? null,
        })),
    };
  }

  /**
   * Delivers audit events the log didn't take yet, and releases every link
   * that is due while the interviews are open; then sets itself again for
   * the next.
   */
  override async alarm(): Promise<void> {
    try {
      // Erasure first (GRA-329): nothing else that fails holds it up.
      this.#decideInterviews();
      try {
        await this.purgeBrain();
      } catch (error) {
        log.error("onboarding.purge_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
      await this.forgetLinesNow();
      await this.keepKickoffRecordsNow();
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
    } finally {
      // Set again whatever failed above, so what is left is tried again.
      await this.#armLinks();
      await this.#armDrawing();
    }
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
        wanted: (mail) => this.#mailWanted(mail),
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
      for (const person of due) {
        this.#send({ roster, plan, said }, person, now);
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
    const due = this.#remindable(now);
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
    // A reminder to a second address ended a link: owed at once.
    this.#decideInterviews();
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
   * Whose reminder is due by `now`: not reminded yet, still owed one
   * (`#reminderOwed`: never someone who finished, withdrew or deleted
   * their interview), and their link out the working days before. A link
   * handed over on paper is the admin's to remind about.
   */
  #remindable(now: string): { person: string; sentAt: string }[] {
    // Each read once for everyone: the roster can be thousands of people.
    const roster = this.#roster();
    if (roster === null) {
      return [];
    }
    const byId = new Map(roster.people.map((person) => [person.id, person]));
    const states = this.#interviews();
    const withdrawn = new Set(
      this.#db
        .select({ person: participations.person })
        .from(participations)
        .where(isNotNull(participations.withdrawnAt))
        .all()
        .map(({ person }) => person)
    );
    return this.#db
      .select()
      .from(links)
      .orderBy(asc(links.sentAt), asc(links.person))
      .all()
      .filter((link) => {
        const one = byId.get(link.person);
        return (
          link.remindedAt === null &&
          dayOf(now) >=
            addWorkingDays(dayOf(link.sentAt), remindAfterWorkingDays) &&
          one !== undefined &&
          owesReminder({
            takingPart: takingPart(roster, one),
            email: one.email,
            link,
            completed: (states.get(link.person)?.completedAt ?? null) !== null,
            withdrawn: withdrawn.has(link.person),
          })
        );
      })
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
    // A link and a reminder both carry the link: whoever reads this
    // address holds it (`linkAccount`).
    this.#linkWentTo(person.id, person.email);
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

  /**
   * Sends someone's link, in the caller's transaction: the first link out
   * tells the team, for good; it is emailed to whoever has an address; and
   * everyone but a lead is counted as asked, once ever, so a person taken
   * off and on again isn't asked twice. Whether they lead a team is kept
   * as it is now: a lead named later never makes theirs a lead's interview.
   */
  #send(
    { roster, plan, said }: { roster: Roster; plan: Plan; said: MailContext },
    person: string,
    now: string
  ): void {
    this.#db
      .update(onboarding)
      .set({ toldAt: sql`coalesce(${onboarding.toldAt}, ${now})` })
      .where(eq(onboarding.id, 1))
      .run();
    const ledTeam =
      roster.teams.find(({ lead: led }) => led === person)?.id ?? null;
    this.#db.insert(links).values({ person, sentAt: now, ledTeam }).run();
    // The link's first sending, recorded with the link itself: a link with
    // none (made before addresses were recorded) is never linked to anyone.
    this.#linkWentTo(
      person,
      roster.people.find(({ id }) => id === person)?.email ?? "",
      true
    );
    this.#queuePersonMail({ roster, plan, said, person, sentAt: now }, "link");
    const team = roster.people.find(({ id }) => id === person)?.team;
    if (team !== undefined && ledTeam === null) {
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
      unconfirmed: this.#unconfirmed(),
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
    referral?: true;
  }[] {
    return [
      ...this.#teamsToMap(now).map((team) => ({
        ...team,
        item: `team:${team.id}`,
        about: team.lead,
      })),
      // Who does what is put right before work is drawn, so it is drawn
      // from those who do it.
      ...this.#referralsDue(now),
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
        const told = agreedAbout(row.id, doers, asked, (id) =>
          onRoster.has(id) ? agreedAt.get(id) : undefined
        );
        const tellers = told.map(([id]) => id);
        const agreed = Object.fromEntries(told);
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
    // Before anything is read: whose interviews it may be drawn from, the
    // documents and the purge mark as they are now. Whatever changes from
    // here on, while the brief is read too, keeps nothing.
    const lead =
      this.#roster()?.teams.find(({ id }) => id === due.team)?.lead ?? null;
    // Only those with an interview agreed to now: the brief reads no one
    // else's, in the same turn.
    const began = new Map(
      [
        ...this.#interviewsOf([
          ...Object.keys(due.agreed),
          ...(lead === null ? [] : [lead]),
        ]),
      ].filter(([, held]) => held !== null)
    );
    const shared = this.#sharedIds();
    const purges = this.purgeMark();
    const briefed = await this.#briefOf(due);
    if (briefed === "gone") {
      return;
    }
    if (briefed === "nothing") {
      // Nothing agreed to draw from: noted as drawn as it is, so it isn't due again and again.
      this.#keepDrawing(due, null, at);
      return;
    }
    const { brief } = briefed;
    const drawn = await drawWork(this.env, brief, (took) => {
      this.meter(took, at);
    });
    this.ctx.storage.transactionSync(() => {
      // Their interview deleted meanwhile, or deleted and begun anew; or
      // a document it had for context purged meanwhile; or a purge
      // rewrote what it was drawn from: drawn again without it, as the
      // work is still due.
      if (this.#stale(began, purges) || this.#anyForgotten(shared)) {
        return;
      }
      this.#keepDrawing(due, drawn, at);
    });
  }

  /**
   * What a piece of work is drawn from (`#drawWork`): "gone" when it or
   * its team isn't there any more, "nothing" when nobody it would be drawn
   * from agreed to anything. `lead` is the team's lead when what they
   * agreed to is there for context.
   */
  async #briefOf(
    due: Pick<WorkToDraw, "id" | "team" | "agreed">
  ): Promise<{ brief: WorkBrief; lead: string | null } | "gone" | "nothing"> {
    const roster = this.#roster();
    const team = roster?.teams.find(({ id }) => id === due.team);
    const work = this.teamWorks(due.team).find(({ id }) => id === due.id);
    if (roster === null || team === undefined || work === undefined) {
      return "gone";
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
      return "nothing";
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
        // A file's name is said in the conversation, never read back or
        // approved (GRA-329): only approved facts leave the store.
        example: null,
        ...(about === undefined ? {} : { about }),
      };
    });
    // Read in the same turn as the documents `#drawWork` checks against
    // (`#sharedIds`), before anything is awaited: one shared meanwhile is
    // in neither.
    const shown = this.documentsBrief(team.name);
    const brief: WorkBrief = {
      company: await companyName(this.env),
      team: team.name,
      teams: roster.teams
        .filter(({ id }) => id !== team.id)
        .map(({ name }) => name),
      work: { name: work.name, local: work.local, one: work.one },
      lead: leadInput?.facts.map(({ record }) => record) ?? [],
      tellers,
      documents: shown,
    };
    return { brief, lead: leadInput?.person ?? null };
  }

  /**
   * Every piece of work drawn again from what its people agreed to, as it
   * would be drawn now, and kept nowhere: the Stephen Lab's drawing bench
   * (lab.ts) draws the same agreements again and again, so two runs differ
   * only by how the work is drawn. Its calls are the lab's, so the
   * onboarding counts none of them.
   */
  async drawnAgain(): Promise<
    { work: string; name: string; drawn: DrawnWork }[]
  > {
    const roster = this.#roster();
    if (roster === null) {
      return [];
    }
    const onRoster = new Set(roster.people.map(({ id }) => id));
    const asked = this.#db.select().from(askedAbout).all();
    const found: { work: string; name: string; drawn: DrawnWork }[] = [];
    for (const row of this.#db.select().from(works).all()) {
      const doers = doersOf(row.doers);
      const agreed = Object.fromEntries(
        agreedAbout(row.id, doers, asked, (id) =>
          onRoster.has(id) ? (this.#agreedAt(id) ?? undefined) : undefined
        )
      );
      // As the alarm does: a lead's overview alone draws only their own work.
      const lead = roster.teams.find(({ id }) => id === row.team)?.lead;
      const leadOnly = Object.keys(agreed).every((id) => id === lead);
      const leadsOwn = doers.length > 0 && doers.every((id) => id === lead);
      if (leadOnly && !leadsOwn) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one drawing at a time, as the alarm draws them
      const briefed = await this.#briefOf({
        id: row.id,
        team: row.team,
        agreed,
      });
      if (typeof briefed !== "string") {
        // oxlint-disable-next-line no-await-in-loop -- one drawing at a time
        const drawn = await drawWork(this.env, briefed.brief, noMeter);
        found.push({ work: row.id, name: row.name, drawn });
      }
    }
    return found;
  }

  /**
   * Which interview each of `people` holds now: when it began, or null for
   * none agreed to. A delete and a new start make it another.
   */
  #interviewsOf(whose: readonly string[]): Map<string, string | null> {
    const rows = this.#db
      .select({
        person: interviewStates.person,
        startedAt: interviewStates.startedAt,
        agreedAt: interviewStates.agreedAt,
        revocations: interviewStates.revocations,
      })
      .from(interviewStates)
      .where(inList(interviewStates.person, whose))
      .all();
    // Something they approved stopping counting (`revocations`, a count,
    // so two in one millisecond still differ) makes what was read before
    // it as gone as a delete does.
    return new Map(
      whose.map((person) => {
        const row = rows.find((each) => each.person === person);
        return [
          person,
          row === undefined || row.agreedAt === null
            ? null
            : `${row.startedAt ?? ""}|${row.revocations}`,
        ];
      })
    );
  }

  /** Who of `began` (`#interviewsOf`) no longer holds the interview they held then. */
  #goneSince(began: Map<string, string | null>): string[] {
    const now = this.#interviewsOf([...began.keys()]);
    return [...began].flatMap(([person, held]) =>
      held === null || now.get(person) !== held ? [person] : []
    );
  }

  /**
   * Whether what a drawing was drawn from changed since it `began` (an
   * interview went, or went and began anew) or a purge since (`purges`,
   * `purgeMark` as it began) rewrote it: then it keeps nothing.
   */
  #stale(began: Map<string, string | null>, purges: number): boolean {
    return this.#goneSince(began).length > 0 || this.purgeMark() !== purges;
  }

  /**
   * Keeps a piece of work as drawn, from whose agreements, or as it was
   * when `drawn` is null; and notes as drawn whoever it was drawn for
   * that has nothing else waiting to be drawn. A new drawing replaces the
   * old one whole: the difference checked in the old one goes with it, so
   * a fresh drawing never carries an old one's words (it is checked anew
   * as it reaches the brain).
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
    if (drawn !== null) {
      this.#db
        .delete(checkedDifferences)
        .where(eq(checkedDifferences.work, due.id))
        .run();
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
        // As of their generation now: a take-back since the drawing began
        // kept it from being kept (`#goneSince`).
        this.drawn(person, this.#drawGeneration(person) ?? agreedAt);
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
   * from the lead alone. None while fewer than `minTeamShown` of its people
   * agreed: it waits.
   */
  #teamIntake(teamId: string): TeamIntake | null {
    const roster = this.#roster();
    const team = roster?.teams.find(({ id }) => id === teamId);
    if (roster === null || team === undefined || team.off) {
      return null;
    }
    const tellers = this.#tellers(teamId);
    if (tellers.length < minTeamShown) {
      return null;
    }
    const { lead } = team;
    const leadAgreed =
      lead !== null && this.#agreedAt(lead) !== null ? [lead] : [];
    // The pieces of work are the lead's map: none reach the brain while
    // what it was drawn from no longer counts (`#mapBacked`).
    const mapped = this.#mapBacked(teamId) ? this.teamWorks(teamId) : [];
    return {
      team: { id: team.id, name: team.name },
      names: roster.people.map(({ name }) => name),
      tellers,
      works: mapped.flatMap((work) => {
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
   * The people of a team whose facts reach the brain (GRA-329): on its
   * list, not its lead, whose role alone says who they are, and with
   * something they approved that counts. Only they count towards the five
   * a team needs (`minTeamShown`).
   */
  #tellers(teamId: string): { person: string; facts: DrawInput["facts"] }[] {
    const roster = this.#roster();
    const team = roster?.teams.find(({ id }) => id === teamId);
    if (roster === null || team === undefined) {
      return [];
    }
    return roster.people.flatMap(({ id, team: of }) => {
      if (of !== teamId || id === team.lead) {
        return [];
      }
      const input = this.drawInput(id);
      return input === null || input.kind !== "own"
        ? []
        : [{ person: id, facts: input.facts }];
    });
  }

  /**
   * Whether a team's map stands on what its lead's facts are now: drawn
   * from their agreement, and nothing they approved stopped counting since
   * (an edit or a withdrawal, `revocations`). A team without a lead has no
   * map of anyone's.
   */
  #mapBacked(teamId: string): boolean {
    const team = this.#roster()?.teams.find(({ id }) => id === teamId);
    if (team === undefined || team.lead === null) {
      return true;
    }
    const [row] = this.#db
      .select({ mappedFrom: teams.mappedFrom })
      .from(teams)
      .where(eq(teams.id, teamId))
      .all();
    const from = row?.mappedFrom ?? null;
    // Drawn from the lead's admission as it is now: this interview, and
    // every take-back of it there is. A take-back, however close in time,
    // or an interview begun anew, which counts its take-backs from nothing
    // again, leaves the map unbacked until it is drawn again.
    const now = this.#interviewsOf([team.lead]).get(team.lead) ?? null;
    return from !== null && now !== null && from === now;
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
    // Who it rests on, as their interviews stand now, before anything is
    // awaited: whatever happens to them meanwhile is seen at the end.
    const began = this.#interviewsOf(
      this.#roster()?.people.map(({ id }) => id) ?? []
    );
    // What five or more of its people said, put together (GRA-1084):
    // never one person's fact. A failing model throws, and the intake is
    // tried again, with nothing written.
    // One budget of checks for both: past it, nothing is written.
    const checks = checksFor(this.env, (took) => {
      this.meter(took, at);
    });
    const claims = await teamClaims(intake, checks);
    // Who told each part of each drawing, checked, never the drawing
    // model's word (drawing-support.ts).
    const clean = withoutNames(intake.names);
    const factsOf = new Map(
      intake.tellers.map(({ person, facts }) => [
        person,
        facts.map(({ record }) => clean(record)),
      ])
    );
    const supports = new Map<string, Support>();
    for (const work of intake.works) {
      // oxlint-disable-next-line no-await-in-loop -- one drawing at a time
      supports.set(work.id, await checkedSupport(checks, work, factsOf, clean));
    }
    const { records, rests } = await intakeOf(intake, claims, supports);
    // The team's claims are these now: any statement given before that
    // isn't one of them goes, so no earlier one outlives what it was put
    // together from. Found both where it is noted whom each rests on and
    // in the brain itself, so one given with no note of it goes too: read
    // before anything is written.
    const current = new Set(records.map(({ id }) => id));
    // And each piece of work's earlier drawings: only the one checked now
    // is the brain's (GRA-1084), never one drawn before with fewer than
    // five behind a part of it.
    const workflows = records.flatMap(({ type, id }) =>
      type === "workflow" ? [id] : []
    );
    const givenStatements = await onboardingStatementsOf(
      this.env,
      intakeIds.team(teamId)
    );
    const givenDrawings = await onboardingDrawingsOf(this.env, workflows);
    const given = [
      ...givenStatements.map((record) => ({
        record,
        type: "statement" as const,
        parent: null,
      })),
      ...givenDrawings.map(({ id, workflowId }) => ({
        record: id,
        type: "workflowVersion" as const,
        parent: workflowId,
      })),
    ];
    const noted = this.#db
      .select({
        record: brainSent.record,
        type: brainSent.type,
        parent: brainSent.parent,
      })
      .from(brainSent)
      .where(
        and(
          eq(brainSent.team, teamId),
          inList(brainSent.type, ["statement", "workflowVersion"])
        )
      )
      .all();
    const stale = [
      ...new Map(
        [...given, ...noted]
          .filter(({ record }) => !current.has(record))
          .map((each) => [each.record, each])
      ).values(),
    ];
    const claimed = [
      ...new Set(
        rests.flatMap(({ record, type }) =>
          type === "statement" ? [record] : []
        )
      ),
    ];
    // Whom each record rests on is noted before the brain holds it, so no
    // record is ever there without it: a withdrawal finds it whatever
    // happens after (`#toPurge`). Each earlier claim is noted as resting
    // on nobody left (`gonePrefix`), to be taken out at once or by the
    // alarm until it is, however the intake itself ends.
    const changed = this.ctx.storage.transactionSync(() => {
      // One rule for whom a record rests on (GRA-1084): someone counts only
      // while what they approved is still exactly what the claims and
      // drawings were made from, read in this transaction against when the
      // intake began (`#goneSince`). Anyone whose approval changed since is
      // noted as gone, and the team stays due for another intake. A gone
      // mark is never cleared here.
      const since = new Set(this.#goneSince(began));
      // A claim rests on exactly the people behind it now: whoever it
      // rested on before and doesn't now no longer counts towards the five
      // it needs. Who is gone stays gone.
      this.#db
        .delete(brainSent)
        .where(
          and(
            inList(brainSent.record, claimed),
            not(like(brainSent.person, `${gonePrefix}%`))
          )
        )
        .run();
      // One row a record: within SQLite's bound parameters.
      for (const rest of rests) {
        this.#db
          .insert(brainSent)
          .values({
            ...rest,
            person: since.has(rest.person)
              ? `${gonePrefix}${rest.person}`
              : rest.person,
            team: teamId,
          })
          .onConflictDoNothing()
          .run();
      }
      for (const { record, type, parent } of stale) {
        this.#db
          .update(brainSent)
          .set({ person: sql`${gonePrefix} || ${brainSent.person}` })
          .where(
            and(
              eq(brainSent.record, record),
              not(like(brainSent.person, `${gonePrefix}%`))
            )
          )
          .run();
        this.#db
          .insert(brainSent)
          .values({
            record,
            type,
            team: teamId,
            person: `${gonePrefix}${record}`,
            parent,
          })
          .onConflictDoNothing()
          .run();
      }
      return since.size > 0;
    });
    await keepOnboardingRecords(this.env, records, {
      sources: new Set([rosterSource, await intakeIds.interviews(teamId)]),
      teams: new Set([intakeIds.team(teamId)]),
    });
    const gone = this.ctx.storage.transactionSync(() => {
      // Whose interview went meanwhile, though they began anew: what rests
      // on it rests on someone gone (`gonePrefix`), and is taken out.
      const since = this.#goneSince(began);
      const ours = [...new Set(rests.map(({ record }) => record))];
      for (const person of since) {
        this.#db
          .update(brainSent)
          .set({ person: `${gonePrefix}${person}` })
          .where(
            and(eq(brainSent.person, person), inList(brainSent.record, ours))
          )
          .run();
      }
      this.#db
        .update(brainTeams)
        .set({ sentAt: sql`coalesce(${brainTeams.sentAt}, ${at})` })
        .where(eq(brainTeams.team, teamId))
        .run();
      // Which differences the review may show: those whose two ways five
      // or more were checked to tell, each, in the drawing as it stands.
      for (const work of intake.works) {
        const support = supports.get(work.id);
        const { differs } = work.drawn;
        const checked =
          support !== undefined &&
          differs !== null &&
          (support.steps[differs.step] ?? []).length >= minTeamShown &&
          support.other.length >= minTeamShown;
        if (checked) {
          // As checked: each way with the roster's names taken out now,
          // never again with whatever names it has later.
          const shown = {
            drawnAt: work.drawn.at,
            way: clean(work.drawn.steps[differs.step]?.text ?? ""),
            other: clean(differs.other),
            at,
          };
          // In one statement, only while what it was checked from still
          // stands as the intake read it: the drawing it checked, and the
          // interview of everyone it rests on, at the same admission
          // (`admissionSql`). One forgotten, withdrawn, deleted or taken
          // back meanwhile leaves no copy of its words.
          const restsOn = [
            ...new Set([
              ...(support.steps[differs.step] ?? []),
              ...support.other,
            ]),
          ];
          const standing = and(
            sql`EXISTS (SELECT 1 FROM ${drawnWorks}
              WHERE ${drawnWorks.work} = ${work.id}
                AND json_extract(${drawnWorks.drawn}, '$.at') = ${work.drawn.at})`,
            ...restsOn.map(
              (person) =>
                sql`${admissionSql(person)} IS ${began.get(person) ?? null}`
            )
          );
          this.#db
            .insert(checkedDifferences)
            .select(
              sql`SELECT ${work.id}, ${shown.drawnAt}, ${shown.way}, ${shown.other}, ${shown.at} WHERE ${standing}`
            )
            .onConflictDoUpdate({ target: checkedDifferences.work, set: shown })
            .run();
        } else {
          this.#db
            .delete(checkedDifferences)
            .where(eq(checkedDifferences.work, work.id))
            .run();
        }
      }
      // The team's claims, for the new Brain (GRA-1741): only from an
      // intake nobody it rests on moved under, as five or more back each
      // as read. Otherwise the team stays due, and the next intake notes
      // them.
      if (since.length === 0 && !changed) {
        this.#noteClaims(
          teamId,
          records.flatMap((record) =>
            record.type === "statement"
              ? [
                  {
                    record: record.id,
                    text: record.text,
                    people: rests.flatMap(({ record: of, person }) =>
                      of === record.id ? [person] : []
                    ),
                  },
                ]
              : []
          )
        );
      }
      this.#brainSettled(teamId, dueAt);
      return changed || since.length > 0 || stale.length > 0;
    });
    // The claims it noted reach the hand-over with their events.
    this.#deliverAudit();
    // Someone it rests on deleted their interview while it was given, or a
    // claim it gave before isn't the team's now: taken out again at once,
    // or by the alarm.
    if (gone) {
      try {
        await this.#purgeNow();
      } catch (error) {
        log.error("onboarding.purge_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
        await this.#armDrawing();
      }
    }
  }

  /** Notes, in the caller's transaction, that `person`'s link was queued to `email`. */
  #linkWentTo(person: string, email: string, first = false): void {
    const address = foldedAddress(email);
    if (address === "" && !first) {
      return;
    }
    this.#db
      .insert(linkAddresses)
      .values({ person, address, first })
      .onConflictDoNothing()
      .run();
    // A second address: whoever read either may hold the link, so an
    // account linked to it is linked no more, at once, and the interview's
    // copy in the Brain is owed an erasure (`#decideInterviews`). It is never
    // linked again (`linkAccount`).
    const recorded = this.#db
      .select({ address: linkAddresses.address })
      .from(linkAddresses)
      .where(eq(linkAddresses.person, person))
      .all();
    if (recorded.length > 1) {
      this.#db
        .update(links)
        .set({ account: null })
        .where(eq(links.person, person))
        .run();
    }
  }

  /**
   * Links `account` to the person on the list whose link went to `email`,
   * once: from a sign-in only (auth.ts, after the identity provider's
   * claims were checked), never from anything a person or an admin sends.
   * Only while that address is the one address their link, or a reminder
   * carrying it, was ever queued to (`link_addresses`): whoever held any
   * other address could hold the link too (GRA-1790, review of #2206). So
   * nobody is linked when no link went to that address, when it went to
   * more than one person's, when theirs also went to another address,
   * when that person is linked already, when the account is linked to
   * someone else, or when core erased them. Editing the list afterwards
   * changes nothing. Their interview reaches the new Brain, readable by
   * that account alone, from core's next hand-over (onboarding/new-brain.ts).
   */
  linkAccount(account: string, email: string): boolean {
    const address = foldedAddress(email);
    if (account === "" || address === "") {
      return false;
    }
    const linked = this.ctx.storage.transactionSync(() => {
      const taken = this.#db
        .select({ person: links.person })
        .from(links)
        .where(eq(links.account, account))
        .all();
      const to = this.#db
        .select({ person: linkAddresses.person })
        .from(linkAddresses)
        .where(eq(linkAddresses.address, address))
        .all();
      const [only] = to;
      if (taken.length > 0 || to.length !== 1 || only === undefined) {
        return false;
      }
      const addresses = this.#db
        .select({ address: linkAddresses.address, first: linkAddresses.first })
        .from(linkAddresses)
        .where(eq(linkAddresses.person, only.person))
        .all();
      const [link] = this.#db
        .select({ account: links.account, erasedAt: links.erasedAt })
        .from(links)
        .where(eq(links.person, only.person))
        .all();
      // Only one address ever, and it is the link's first sending: a
      // history that starts later (a link made before addresses were
      // recorded) can't say who else read it.
      if (
        addresses.length !== 1 ||
        addresses[0]?.first !== true ||
        link === undefined ||
        link.account !== null ||
        link.erasedAt !== null
      ) {
        return false;
      }
      this.#db
        .update(links)
        .set({ account })
        .where(and(eq(links.person, only.person), isNull(links.account)))
        .run();
      // One event: the account itself, in the client's audit log; whose
      // entry it is only in the onboarding's own.
      this.#changed(
        { type: "person", userId: account },
        "onboarding.interview.account_linked",
        {},
        only.person
      );
      return true;
    });
    if (linked) {
      this.#deliverAudit();
      this.#decideInterviews();
    }
    return linked;
  }

  /**
   * The staff-list team of the person `account` is linked to
   * (`linkAccount`), while they are on the list, core didn't erase them,
   * the team may have claims shown (`teamMayClaim`), and none of its
   * claims is owed an erasure: whose claims they read in the new Brain
   * (brain-next.ts, `readerOf`). Null otherwise.
   */
  interviewTeamOf(account: string): string | null {
    const [link] = this.#db
      .select({ person: links.person })
      .from(links)
      .where(and(eq(links.account, account), isNull(links.erasedAt)))
      .all();
    if (link === undefined) {
      return null;
    }
    // A team too small to have claims shown gives its group to nobody,
    // from the moment its count changes (`teamMayClaim`); and so does a
    // team with any claim owed an erasure the Brain hasn't confirmed, so
    // that what may be read never rests on a Brain call having succeeded:
    // readers read less, never more, until it has.
    const team = this.#teamOfPerson(link.person);
    if (team === null || !teamMayClaim(this.#tellers(team).length)) {
      return null;
    }
    const [owed] = this.#db
      .select({ source: brainClaims.source })
      .from(brainClaims)
      .where(and(eq(brainClaims.team, team), eq(brainClaims.erase, true)))
      .limit(1)
      .all();
    return owed === undefined ? team : null;
  }

  /**
   * People whose interview the new Brain may hold otherwise than the
   * store last decided: what it was decided from changed
   * (`interviewMarkSql`), or they left the list with a source of theirs
   * still standing.
   */
  #interviewsDue(): string[] {
    return this.ctx.storage.sql
      .exec<{ person: string }>(
        `SELECT l.person AS person FROM links l
          WHERE (${interviewMarkSql}) IS NOT l.brain_mark
        UNION
        SELECT b.person AS person FROM brain_interviews b
          WHERE b.erase = 0
            AND NOT EXISTS (SELECT 1 FROM links l WHERE l.person = b.person)`
      )
      .toArray()
      .map(({ person }) => person);
  }

  /** What `person`'s interview is settled from now (`interviewMarkSql`); null for nothing. */
  #interviewMark(person: string): string | null {
    const [row] = this.ctx.storage.sql
      .exec<{ mark: string | null }>(
        `SELECT (${interviewMarkSql}) AS mark FROM links l WHERE l.person = ?`,
        person
      )
      .toArray();
    return row?.mark ?? null;
  }

  /**
   * What the new Brain should hold of `person`'s interview now: the facts
   * they approved, readable by the account linked to them; null for
   * nothing (no account, erased, withdrawn, or nothing approved).
   */
  #interviewWanted(person: string): { account: string; text: string } | null {
    const [link] = this.#db
      .select({ account: links.account, erasedAt: links.erasedAt })
      .from(links)
      .where(eq(links.person, person))
      .all();
    if (link === undefined || link.account === null || link.erasedAt !== null) {
      return null;
    }
    const text = this.#admitted(person)
      .map(({ record }) => record.trim())
      .filter((record) => record !== "")
      .join("\n");
    return text === "" ? null : { account: link.account, text };
  }

  /**
   * Decides, in the caller's transaction, what the new Brain is to hold
   * of `person`'s interview, from one read of the store: a source stands
   * for one mark of it (`interviewMarkSql`), so one made for another mark
   * is marked to be erased, and a new one is noted (`brain_interviews`,
   * under an id minted here) before anything adds it. Its row stays until
   * the Brain's erasure of it returned, so the Brain never holds an
   * interview the store doesn't know of. Answers the text wanted, if any.
   */
  #decideInterview(person: string): string | null {
    const mark = this.#interviewMark(person);
    const wanted = mark === null ? null : this.#interviewWanted(person);
    const rows = this.#db
      .select()
      .from(brainInterviews)
      .where(eq(brainInterviews.person, person))
      .all();
    const standing = rows.find(
      (row) => !row.erase && wanted !== null && row.mark === mark
    );
    for (const row of rows) {
      if (row !== standing && !row.erase) {
        this.#db
          .update(brainInterviews)
          .set({ erase: true })
          .where(eq(brainInterviews.source, row.source))
          .run();
      }
    }
    if (wanted !== null && mark !== null && standing === undefined) {
      const source = crypto.randomUUID();
      this.#db
        .insert(brainInterviews)
        .values({ source, person, account: wanted.account, mark })
        .run();
      this.#noteBrainSource("interview", source, person);
    }
    this.#db
      .update(links)
      .set({ brainMark: mark })
      .where(eq(links.person, person))
      .run();
    return wanted?.text ?? null;
  }

  /**
   * Notes, in the caller's transaction, that the new Brain is to take the
   * source `source` of `kind`: an audit event naming it, which the outbox's
   * drain notes as a hand-over (brain-hand-overs.ts), in the same
   * transaction as the row that says it stands. What it holds is read when
   * the hand-over runs (`interviewToHand`, `claimToHand`), never here.
   */
  #noteBrainSource(
    kind: "interview" | "claim",
    source: string,
    about: string | null
  ): void {
    const at = new Date().toISOString();
    const {
      actions: [action],
      target: targetType,
    } = handOverProducers[kind];
    this.#db
      .insert(events)
      .values({ at, by: whoIs({ type: "system" }), what: action, about })
      .run();
    const event = createAuditEvent(
      {
        actor: { type: "system" },
        action,
        target: { type: targetType, id: source },
        detail: {},
      },
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

  /**
   * Decides, in one transaction, what the new Brain is to hold of every
   * interview whose decision is due (`#decideInterview`): at most everyone
   * on the list, which `onboardingPeopleMax` bounds. Each new source is
   * noted for the hand-over (`#noteBrainSource`); each that no longer
   * stands is owed an erasure (`owedErasures`). Run after every change
   * that may move one, and by the alarm.
   */
  #decideInterviews(): void {
    const decided = this.ctx.storage.transactionSync(() => {
      const due = this.#interviewsDue();
      for (const person of due) {
        this.#decideInterview(person);
      }
      return due.length > 0;
    });
    if (decided) {
      this.#deliverAudit();
    }
  }

  /**
   * The interview `source` as the hand-over adds it now: its account and
   * the text it stands for, only while it is the one the store decided
   * for that person's interview as it is now. Null otherwise: withdrawn,
   * deleted, begun anew, edited, unlinked, erased or gone.
   */
  interviewToHand(source: string): { account: string; text: string } | null {
    this.#decideInterviews();
    const [row] = this.#db
      .select()
      .from(brainInterviews)
      .where(eq(brainInterviews.source, source))
      .all();
    if (row === undefined || row.erase) {
      return null;
    }
    const wanted = this.#interviewWanted(row.person);
    return wanted === null ||
      wanted.account !== row.account ||
      this.#interviewMark(row.person) !== row.mark
      ? null
      : wanted;
  }

  /**
   * The claim `source` as the hand-over adds it now: its sentence and its
   * team, only while it stands (five or more back it, and its team may
   * have claims shown, `teamMayClaim`). Null otherwise.
   */
  claimToHand(source: string): { text: string; team: string } | null {
    const [row] = this.#db
      .select()
      .from(brainClaims)
      .where(eq(brainClaims.source, source))
      .all();
    if (
      row === undefined ||
      row.erase ||
      !teamMayClaim(this.#tellers(row.team).length)
    ) {
      return null;
    }
    return { text: row.text, team: row.team };
  }

  /**
   * Every erasure the onboarding still owes the new Brain: each source it
   * noted that no longer stands, until core says it is erased
   * (`erasedFromBrain`). Interviews are decided first. Scoped to what a
   * request erases at once, the rest left to core's clock:
   *
   * - `person`: that person's interviews, and the claims now owed of
   *   their team and of `teams` (the teams whose claims they backed before
   *   their request, `claimTeamsOf`): what their withdrawal or delete
   *   takes out (a claim they backed that fell under five, or every claim
   *   of a team their leaving took under seven), never another team's;
   * - `claims`: every claim owed, after a roster save, which may take any
   *   team under seven.
   */
  owedErasures(
    scope?: { person: string; teams?: readonly string[] } | { claims: true }
  ): OwedErasure[] {
    this.#decideInterviews();
    if (scope !== undefined) {
      const ofTeams = new Set<string>();
      if ("person" in scope) {
        for (const team of scope.teams ?? []) {
          ofTeams.add(team);
        }
        const now = this.#teamOfPerson(scope.person);
        if (now !== null) {
          ofTeams.add(now);
        }
      }
      return this.owedErasures().filter((owed) =>
        "claims" in scope
          ? owed.kind === "claim"
          : (owed.kind === "interview" &&
              this.#interviewPersonOf(owed.source) === scope.person) ||
            (owed.kind === "claim" && ofTeams.has(owed.team))
      );
    }
    const owedInterviews: OwedErasure[] = this.#db
      .select()
      .from(brainInterviews)
      .where(eq(brainInterviews.erase, true))
      .all()
      .map(({ source, person, account }) => ({
        kind: "interview",
        source,
        account,
        reason: this.#withdrawnAt(person) === null ? "deleted" : "withdrawn",
      }));
    const claims: OwedErasure[] = this.#db
      .select()
      .from(brainClaims)
      .where(eq(brainClaims.erase, true))
      .all()
      .map(({ source, team }) => ({ kind: "claim", source, team }));
    return [...owedInterviews, ...claims];
  }

  /**
   * The teams whose standing claims `person` backs now, from the rows the
   * intake keeps of who each claim rests on (`brain_sent`): asked before a
   * request of theirs that may drop them (onboarding/links.ts), whose
   * recount forgets those rows. At most the claims they back.
   */
  claimTeamsOf(person: string): string[] {
    const backed = this.#backedRecords(person);
    return [
      ...new Set(
        this.#db
          .select({ team: brainClaims.team })
          .from(brainClaims)
          .where(inList(brainClaims.record, backed))
          .all()
          .map(({ team }) => team)
      ),
    ];
  }

  /**
   * Those of `candidates` who back a claim of `team` now: they agree to what
   * they said, and are in that team on the list now, so someone moved
   * away no longer backs it. The one rule, for the recount (`#toPurge`)
   * and for noting a claim (`#noteClaims`).
   */
  #currentBackers(
    team: string,
    candidates: readonly string[],
    agreed: ReadonlySet<string> = new Set(
      this.#db
        .select({ person: interviewStates.person })
        .from(interviewStates)
        .where(isNotNull(interviewStates.agreedAt))
        .all()
        .map(({ person }) => person)
    )
  ): string[] {
    const inTeam = new Set(
      this.#db
        .select({ id: people.id })
        .from(people)
        .where(eq(people.team, team))
        .all()
        .map(({ id }) => id)
    );
    return candidates.filter(
      (person) => agreed.has(person) && inTeam.has(person)
    );
  }

  /** The intake's statement records `person` is among the backers of (`brain_sent`). */
  #backedRecords(person: string): string[] {
    return this.#db
      .select({ record: brainSent.record })
      .from(brainSent)
      .where(and(eq(brainSent.person, person), eq(brainSent.type, "statement")))
      .all()
      .map(({ record }) => record);
  }

  /** The staff-list team `person` is in now; null when they aren't on the list. */
  #teamOfPerson(person: string): string | null {
    const [row] = this.#db
      .select({ team: people.team })
      .from(people)
      .where(eq(people.id, person))
      .all();
    return row?.team ?? null;
  }

  /** Whose interview the source `source` is; null for none. */
  #interviewPersonOf(source: string): string | null {
    const [row] = this.#db
      .select({ person: brainInterviews.person })
      .from(brainInterviews)
      .where(eq(brainInterviews.source, source))
      .all();
    return row?.person ?? null;
  }

  /**
   * The person a link's secret (`secretMark`) is theirs, for core's own
   * use after a request on that link (onboarding/links.ts): never answered
   * to the link's holder. Null for an unknown link.
   */
  personOfLink(secretMark: string): string | null {
    const [code] = this.#db
      .select({ person: linkCodes.person })
      .from(linkCodes)
      .where(eq(linkCodes.mark, secretMark))
      .all();
    return code?.person ?? null;
  }

  /** Forgets the owed erasure of `source` of `kind`: core's `eraseSource` of it returned. */
  erasedFromBrain(kind: OwedErasure["kind"], source: string): void {
    this.ctx.storage.transactionSync(() => {
      if (kind === "interview") {
        this.#db
          .delete(brainInterviews)
          .where(
            and(
              eq(brainInterviews.source, source),
              eq(brainInterviews.erase, true)
            )
          )
          .run();
      } else {
        this.#db
          .delete(brainClaims)
          .where(
            and(eq(brainClaims.source, source), eq(brainClaims.erase, true))
          )
          .run();
      }
    });
  }

  /**
   * Whether the new Brain may still hold `person`'s interview otherwise
   * than the store does now: for core's erasures and purges, which let go
   * only once it doesn't.
   */
  interviewOwed(person: string): boolean {
    this.#decideInterviews();
    const [row] = this.ctx.storage.sql
      .exec<{ owed: number }>(
        "SELECT EXISTS (SELECT 1 FROM brain_interviews WHERE person = ? AND erase = 1) AS owed",
        person
      )
      .toArray();
    return row?.owed === 1;
  }

  /**
   * Notes, in the caller's transaction, that the statements `claims` of
   * `team` are the team's claims now: each new one is to be written to
   * the new Brain under a change key minted here, and each written before
   * that isn't one of them any more is to be erased.
   */
  #noteClaims(
    team: string,
    claims: readonly {
      record: string;
      text: string;
      people: readonly string[];
    }[]
  ): void {
    // A team too small to have claims shown has none (`teamMayClaim`); a
    // claim is noted only while five or more of its team's people now
    // back it (`#currentBackers`, the recount's own rule): one moved away
    // while the claims were put together doesn't count.
    const shown = teamMayClaim(this.#tellers(team).length)
      ? claims.filter(
          ({ people: backing }) =>
            this.#currentBackers(team, backing).length >= minTeamShown
        )
      : [];
    const current = new Set(shown.map(({ record }) => record));
    const held = this.#db
      .select({ record: brainClaims.record })
      .from(brainClaims)
      .where(and(eq(brainClaims.team, team), eq(brainClaims.erase, false)))
      .all();
    this.#eraseClaims(
      held.flatMap(({ record }) => (current.has(record) ? [] : [record]))
    );
    const kept = new Set(held.map(({ record }) => record));
    for (const { record, text } of shown) {
      if (!kept.has(record)) {
        const source = crypto.randomUUID();
        this.#db
          .insert(brainClaims)
          .values({ source, record, team, text })
          .run();
        this.#noteBrainSource("claim", source, null);
      }
    }
  }

  /**
   * Marks, in the caller's transaction, every claim of a team that may no
   * longer have claims shown (`teamMayClaim`) to be erased.
   */
  #eraseClaimsOfSmallTeams(): void {
    const teamsHeld = new Set(
      this.#db
        .select({ team: brainClaims.team })
        .from(brainClaims)
        .where(eq(brainClaims.erase, false))
        .all()
        .map(({ team }) => team)
    );
    for (const team of teamsHeld) {
      if (!teamMayClaim(this.#tellers(team).length)) {
        this.#db
          .update(brainClaims)
          .set({ erase: true })
          .where(eq(brainClaims.team, team))
          .run();
      }
    }
  }

  /** Marks the claims standing for `records` to be erased, in the caller's transaction. */
  #eraseClaims(records: readonly string[]): void {
    this.#db
      .update(brainClaims)
      .set({ erase: true })
      .where(inList(brainClaims.record, records))
      .run();
  }

  /** Runs `work` with the brain once what it is doing with it now is done. */
  async #withBrain<T>(work: () => Promise<T>): Promise<T> {
    const before = this.#braining;
    const run = (async () => {
      await before;
      return await work();
    })();
    this.#braining = whatever(run);
    return await run;
  }

  /**
   * What is to be taken out of the brain, from who each record rests on
   * (`brain_sent`), now that some interviews are gone (their agreement no
   * longer counts, `#agreedAt`):
   *
   * - a statement once fewer than `minTeamShown` of the people it rests on
   *   are left: a claim is the team's only while five or more make it
   *   (GRA-1084);
   * - a drawing once anyone it rests on is gone: their numbers and words
   *   are in it, and what is left is drawn again without them;
   * - a workflow once nobody it rests on is left, or none of its drawings;
   * - everything of a team fewer than `minTeamShown` of whose people still
   *   agreed, or that left the staff list: the brain has a team's work
   *   only from three of its people (GRA-359), and gets it again once it
   *   does.
   *
   * Also who is gone, whatever rested on them, and the teams emptied.
   */
  #toPurge(): { records: string[]; gone: string[]; emptied: string[] } {
    const rows = this.#db.select().from(brainSent).all();
    if (rows.length === 0) {
      return { records: [], gone: [], emptied: [] };
    }
    const agreed = new Set(
      this.#db
        .select({ person: interviewStates.person })
        .from(interviewStates)
        .where(isNotNull(interviewStates.agreedAt))
        .all()
        .map(({ person }) => person)
    );
    const roster = this.#roster();
    const teamIds = [...new Set(rows.map(({ team }) => team))];
    const emptied = new Set(
      teamIds.filter((team) => {
        const onRoster = roster?.teams.some(({ id }) => id === team) === true;
        return !onRoster || this.#tellers(team).length < minTeamShown;
      })
    );
    // A map no longer standing on its lead's facts takes its pieces of
    // work, and every drawing of them, out of the brain (GRA-329).
    const unmapped = new Set(teamIds.filter((team) => !this.#mapBacked(team)));
    const records = new Map<
      string,
      { type: string; team: string; people: string[] }
    >();
    for (const { record, type, team, person } of rows) {
      const held = records.get(record) ?? { type, team, people: [] };
      held.people.push(person);
      records.set(record, held);
    }
    const purged = new Set<string>();
    for (const [record, { type, team, people: on }] of records) {
      const left = on.filter((person) => agreed.has(person));
      const backers = this.#currentBackers(team, on, agreed);
      if (
        emptied.has(team) ||
        left.length === 0 ||
        // A claim rests on five or more of its team's people now, or isn't
        // the team's.
        (type === "statement" && backers.length < minTeamShown) ||
        (type === "workflowVersion" && left.length < on.length) ||
        (unmapped.has(team) &&
          (type === "workflow" || type === "workflowVersion"))
      ) {
        purged.add(record);
      }
    }
    // A workflow goes with the last of its drawings.
    const drawn = new Set(
      rows.flatMap(({ parent }) => (parent === null ? [] : [parent]))
    );
    const drawingsLeft = new Set(
      rows.flatMap(({ record, parent }) =>
        parent === null || purged.has(record) ? [] : [parent]
      )
    );
    for (const [record, { type }] of records) {
      if (
        type === "workflow" &&
        drawn.has(record) &&
        !drawingsLeft.has(record)
      ) {
        purged.add(record);
      }
    }
    return {
      records: [...purged],
      gone: [
        ...new Set(
          rows.flatMap(({ person }) => (agreed.has(person) ? [] : [person]))
        ),
      ],
      emptied: [...emptied],
    };
  }

  /**
   * Takes out of the brain what `#toPurge` finds, then forgets here who it
   * rested on: what stays rests on nobody who is gone. A team emptied has
   * no interviews in the brain until it is given again. Within
   * `#withBrain`, so no intake lands between.
   */
  async #purgeNow(): Promise<number> {
    // A team's claims go with the team dropping below what may have them
    // shown, whoever left it and whatever else is purged.
    this.ctx.storage.transactionSync(() => {
      this.#eraseClaimsOfSmallTeams();
    });
    const { records, gone, emptied } = this.#toPurge();
    if (records.length === 0 && gone.length === 0) {
      return 0;
    }
    // The new Brain's claims among them are to be erased, noted before
    // anything is awaited (core erases them, onboarding/new-brain.ts).
    this.ctx.storage.transactionSync(() => {
      this.#eraseClaims(records);
    });
    const purged = await purgeOnboardingRecords(this.env, records);
    this.ctx.storage.transactionSync(() => {
      this.#db.delete(brainSent).where(inList(brainSent.record, records)).run();
      this.#db.delete(brainSent).where(inList(brainSent.person, gone)).run();
      this.#db
        .update(brainTeams)
        .set({ sentAt: null })
        .where(inList(brainTeams.team, emptied))
        .run();
    });
    return purged;
  }

  /**
   * Stops drawing a piece of work that keeps failing, until someone agrees
   * to something new about it: what was drawn of it before stays.
   */
  /**
   * What Stephen learns from once someone said the work they were asked
   * about isn't theirs (GRA-1285): the work they do instead, as they said
   * it, from then on in their interview.
   */
  #insteadKnown(person: Roster["people"][number]): string[] {
    const instead = this.#held(person.id)?.facts.findLast(
      ({ tag, out }) => tag === "work" && out !== true
    );
    return instead === undefined
      ? []
      : [
          `${firstName(person.name)} said the work they were asked about is not theirs. From here on, learn about their own: ${instead.record}`,
        ];
  }

  /**
   * Queues putting right who does what (GRA-1285) when someone, not a
   * lead, agreed to having said the work they were asked about isn't
   * theirs: a `who` or `work` fact of theirs counts.
   */
  #queueReferral(person: string, now: string): void {
    const roster = this.#roster();
    if (roster === null || leads(roster, person)) {
      return;
    }
    const said = this.#admitted(person).some(
      ({ tag }) => tag === "who" || tag === "work"
    );
    if (!said) {
      return;
    }
    this.#db
      .insert(referrals)
      .values({ person, at: now })
      .onConflictDoNothing()
      .run();
  }

  /** The referrals due, the oldest first, as the drawing's queue takes them. */
  #referralsDue(now: number): {
    item: string;
    id: string;
    about: string;
    after: number;
    tries: number;
    referral: true;
  }[] {
    const failures = new Map(
      this.#db
        .select()
        .from(drawFailures)
        .all()
        .map((row) => [row.item, row])
    );
    return this.#db
      .select()
      .from(referrals)
      .orderBy(asc(referrals.at))
      .all()
      .map(({ person }) => {
        const failed = failures.get(`refer:${person}`);
        return {
          item: `refer:${person}`,
          id: person,
          about: person,
          after: failed === undefined ? now : Date.parse(failed.after),
          tries: failed?.tries ?? 0,
          referral: true as const,
        };
      });
  }

  /**
   * Someone said the work they were asked about isn't theirs: what they
   * agreed to says which work they do and who does that one (referral.ts).
   * The record is put right, whoever they named is asked about it next and
   * sent their link at once, so that work is told by those who do it.
   */
  async #referOne(personId: string, at: string): Promise<void> {
    const done = () => {
      this.#db.delete(referrals).where(eq(referrals.person, personId)).run();
    };
    const roster = this.#roster();
    const person = roster?.people.find(({ id }) => id === personId);
    const [askedRow] = this.#db
      .select({ work: askedAbout.work })
      .from(askedAbout)
      .where(eq(askedAbout.person, personId))
      .all();
    const all = this.#db.select().from(works).all();
    const asked = all.find(({ id }) => id === askedRow?.work);
    const facts = this.#admitted(personId).filter(
      ({ tag }) => tag === "who" || tag === "work"
    );
    if (
      roster === null ||
      person === undefined ||
      asked === undefined ||
      facts.length === 0
    ) {
      done();
      return;
    }
    const teamNames = new Map(roster.teams.map(({ id, name }) => [id, name]));
    // Someone erased stays on the list, the company's entry (D5), but is
    // never named again: found by the address that was theirs, as their
    // erasure keeps it (erased-people.ts), until an admin releases it.
    const erased = await erasedEmailsAmong(
      this.env,
      roster.people.map(({ email }) => email)
    );
    const found = await referralOf(
      this.env,
      {
        asked: asked.local === "" ? asked.name : asked.local,
        works: all
          .filter(({ team, id }) => team === person.team && id !== asked.id)
          .map(({ id, name, local }) => ({ id, name, local })),
        people: roster.people
          .filter(
            ({ id, away, email }) =>
              id !== personId && !away && !erased.has(normalizedEmail(email))
          )
          .map(({ id, name, title, team }) => ({
            id,
            name,
            title,
            team: teamNames.get(team) ?? "",
          })),
        facts: facts.map(({ tag, record }) => ({ tag, record })),
      },
      (took) => {
        this.meter(took, at);
      }
    );
    // What changed while it was read stands: read again.
    const said = await this.#mailContext();
    // The person it names, erased while the model read (GRA-903): what it
    // found is dropped. The last read before the save, which is
    // synchronous from here on, so nothing of this object runs between
    // the two; an erasure core records after it comes after the save, and
    // its interview area takes what the save wrote (`eraseInterviewOf`).
    const namedEmail =
      found.who === null
        ? undefined
        : this.#roster()?.people.find(({ id }) => id === found.who)?.email;
    if (
      namedEmail !== undefined &&
      (await isErasedEmail(this.env, namedEmail))
    ) {
      done();
      return;
    }
    const now = this.#roster();
    const { plan } = this.#row();
    if (now === null) {
      done();
      return;
    }
    const talked = new Set(
      this.#db
        .select({ person: interviewStates.person })
        .from(interviewStates)
        .where(isNotNull(interviewStates.completedAt))
        .all()
        .map(({ person: id }) => id)
    );
    const change = referred(
      this.#db
        .select()
        .from(works)
        .all()
        .map(({ id, team, doers }) => ({ id, team, doers: doersOf(doers) })),
      { by: personId, asked: asked.id, ...found },
      now.people.map(({ id, team, away }) => ({
        id,
        team,
        away,
      })),
      (id) => talked.has(id)
    );
    const invite =
      change.invite === null
        ? undefined
        : now.people.find(({ id }) => id === change.invite);
    const sending =
      invite !== undefined &&
      plan !== null &&
      this.isOpen() &&
      takingPart(now, invite) &&
      !this.#linkFacts().sent.has(invite.id);
    const saved = this.ctx.storage.transactionSync(() => {
      // Its maker erased while the model read: their erasure deleted the
      // referral with their interview (`#erase`), so it saves nothing.
      const [still] = this.#db
        .select({ person: referrals.person })
        .from(referrals)
        .where(eq(referrals.person, personId))
        .all();
      if (still === undefined) {
        return false;
      }
      for (const work of change.works) {
        this.#db
          .update(works)
          .set({ doers: JSON.stringify(work.doers) })
          .where(eq(works.id, work.id))
          .run();
      }
      for (const { person: who, work } of change.asked) {
        this.#db
          .insert(askedAbout)
          .values({ person: who, work })
          .onConflictDoUpdate({ target: askedAbout.person, set: { work } })
          .run();
      }
      this.#db
        .insert(events)
        .values({
          at,
          by: interviewee,
          what: "interview.referred",
          about: personId,
          named: found.who,
        })
        .run();
      if (sending && plan !== null) {
        this.#send({ roster: now, plan, said }, invite.id, at);
        this.#noted(invite.id, "onboarding.link.sent_referred", at, "grasp");
      }
      done();
      return true;
    });
    if (saved && sending) {
      this.#deliverMailSoon();
    }
  }

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

  /** Forgets the drawings of pieces of work that are gone, how they were settled and whether they were counted. */
  #dropOrphanDrawings(): void {
    this.#db
      .delete(drawnWorks)
      .where(sql`${drawnWorks.work} not in (select ${works.id} from ${works})`)
      .run();
    this.#db
      .delete(settledWorks)
      .where(
        sql`${settledWorks.work} not in (select ${works.id} from ${works})`
      )
      .run();
    this.#db
      .delete(countedWorks)
      .where(
        sql`${countedWorks.work} not in (select ${works.id} from ${works})`
      )
      .run();
    this.#db
      .delete(checkedDifferences)
      .where(
        sql`${checkedDifferences.work} not in (select ${works.id} from ${works})`
      )
      .run();
  }

  /** Sets the alarm for the next thing to draw, when there is one. */
  async #armDrawing(): Promise<void> {
    const now = Date.now();
    const drawing = this.#dueToDraw(now);
    const drawn = new Set(drawing.map(({ id, work }) => work?.team ?? id));
    // A team still being drawn goes to the brain once it is drawn.
    const { records, gone } = this.#toPurge();
    const afters = [
      ...drawing.map(({ after }) => after),
      ...this.#brainDueAt(now).flatMap(({ team, after }) =>
        drawn.has(team) ? [] : [after]
      ),
      // What rests on an interview that is gone, still in the brain, and
      // the voice's lines of one still in the cache.
      ...(records.length > 0 ||
      gone.length > 0 ||
      this.#db
        .select({ key: linesToForget.key })
        .from(linesToForget)
        .limit(1)
        .all().length > 0 ||
      this.ctx.storage.kv.get(kickoffOwedKey) !== undefined
        ? [now + purgeRetryMs]
        : []),
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
   * then it's drawn once more. A lead whose interview went while it was
   * drawn takes the map with them: nothing drawn from it is kept.
   */
  async #mapTeam(teamId: string, at: string): Promise<void> {
    // Before anything is read: what a purge since would have rewritten.
    const purges = this.purgeMark();
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
      const generation =
        team.lead === null ? null : this.#drawGeneration(team.lead);
      if (team.lead !== null && generation !== null) {
        this.drawn(team.lead, generation);
      }
      return;
    }
    const began = this.#interviewsOf([input.person]);
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
      // The lead's interview deleted meanwhile, or deleted and begun anew;
      // or a purge rewrote what it was drawn from: drawn again.
      if (now === null || still === undefined || this.#stale(began, purges)) {
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
      const wanted = this.#moreVoicesWanted();
      const assigned = assignWork(
        open,
        drawn,
        members,
        // Asked for more voices: asked about first.
        new Map(drawn.map(({ id }) => [id, wanted.has(id) ? -1 : 0]))
      );
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
      const generation = this.#drawGeneration(input.person);
      const admission = this.#interviewsOf([input.person]).get(input.person);
      this.drawn(input.person, input.generation);
      this.#db
        .update(teams)
        .set({
          does: map.does === "" ? still.does : map.does,
          ...(generation === input.generation && admission === input.admission
            ? {
                mappedAt: sql`coalesce(${teams.mappedAt}, ${at})`,
                mappedFrom: input.admission,
              }
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
      const generation = this.#drawGeneration(lead);
      if (generation !== null) {
        this.drawn(lead, generation);
      }
      this.#db
        .update(teams)
        .set({ mappedAt: sql`coalesce(${teams.mappedAt}, ${at})` })
        .where(eq(teams.id, teamId))
        .run();
      this.#noted(lead, "map.gave_up", at, "grasp");
    });
  }

  /**
   * Someone's agreement's generation (`DrawInput.generation`): when they
   * last agreed, and how often something they approved stopped counting.
   * Null while nothing they agreed to counts.
   */
  #drawGeneration(person: string): string | null {
    const [state] = this.#db
      .select({
        agreedAt: interviewStates.agreedAt,
        revocations: interviewStates.revocations,
      })
      .from(interviewStates)
      .where(eq(interviewStates.person, person))
      .all();
    return state?.agreedAt === null || state === undefined
      ? null
      : `${state.agreedAt}|${state.revocations}`;
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
    use: "open" | "save" | "delete",
    /** Whether it counts as a call on the link: a check again does not. */
    call = true
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
    if (call && !this.#withinLimit(person.id, now)) {
      return refused("interview.limited");
    }
    const [link] = this.#db
      .select()
      .from(links)
      .where(eq(links.person, person.id))
      .all();
    if (link !== undefined && link.erasedAt !== null) {
      return refused("interview.link_invalid");
    }
    const row = this.#row();
    if (link === undefined || row.plan === null) {
      return refused("interview.not_yet");
    }
    if (use !== "delete") {
      if (row.pausedAt !== null) {
        return refused("interview.paused");
      }
      if (!agreementsIn(row.agreements, flowAgreementsOf(row.flow))) {
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

  /**
   * What someone's interview holds now; none before a save, and none for
   * one that no longer reads as an interview: it gives nothing to a
   * drawing or a count, and a purge reaches it as stored
   * (`interviewStored`), so nothing stops on it.
   */
  #held(person: string): InterviewProgress | null {
    const stored = this.interviewStored(person);
    return stored !== null && "progress" in stored ? stored.progress : null;
  }

  /**
   * Whether what someone says may be recorded or read by a model now
   * (GRA-329): they agreed to take part, to the notice as it is now, and
   * didn't withdraw. Null when it may; why not otherwise.
   */
  #participating(person: string): LinkRefusal | null {
    const [held] = this.#db
      .select()
      .from(participations)
      .where(eq(participations.person, person))
      .all();
    if (held === undefined) {
      return "interview.not_participating";
    }
    if (held.withdrawnAt !== null) {
      return "interview.withdrawn";
    }
    return held.notice === participationNotice.version
      ? null
      : "interview.notice_changed";
  }

  /** When someone withdrew; null while they haven't. */
  #withdrawnAt(person: string): string | null {
    const [held] = this.#db
      .select({ withdrawnAt: participations.withdrawnAt })
      .from(participations)
      .where(eq(participations.person, person))
      .all();
    return held?.withdrawnAt ?? null;
  }

  /** Each of someone's facts' revision as last saved, by id. */
  #revisionsOf(person: string): Map<string, string> {
    const [row] = this.#db
      .select({ revisions: interviews.revisions })
      .from(interviews)
      .where(eq(interviews.person, person))
      .all();
    const parsed = revisionsSchema.safeParse(
      row === undefined ? {} : parsedJson(row.revisions)
    );
    return new Map(parsed.success ? Object.entries(parsed.data) : []);
  }

  /** The fact revisions someone approved (`revisionKey`). */
  #approvedOf(person: string): Set<string> {
    return new Set(
      this.#db
        .select({ fact: approvals.fact, revision: approvals.revision })
        .from(approvals)
        .where(eq(approvals.person, person))
        .all()
        .map(({ fact, revision }) => revisionKey(fact, revision))
    );
  }

  /**
   * The facts of someone's interview that count (GRA-329): not taken out,
   * and approved at the revision they stand at, while they take part and
   * didn't withdraw. A changed notice doesn't take back what was approved
   * under the one before; it only stops anything new being recorded.
   * Nothing else ever leaves the store for a drawing, a map or the brain.
   */
  #admitted(
    person: string,
    progress: InterviewProgress | null = this.#held(person),
    revisions: ReadonlyMap<string, string> = this.#revisionsOf(person)
  ): InterviewFact[] {
    const [held] = this.#db
      .select({ withdrawnAt: participations.withdrawnAt })
      .from(participations)
      .where(eq(participations.person, person))
      .all();
    if (progress === null || held === undefined || held.withdrawnAt !== null) {
      return [];
    }
    const approved = this.#approvedOf(person);
    return progress.facts.filter(({ id, out }) => {
      const revision = revisions.get(id);
      return (
        out !== true &&
        revision !== undefined &&
        approved.has(revisionKey(id, revision))
      );
    });
  }

  /** What counts of someone's interview, as fact revisions (`revisionKey`). */
  #admittedKeys(
    person: string,
    progress: InterviewProgress | null = this.#held(person),
    revisions: ReadonlyMap<string, string> = this.#revisionsOf(person)
  ): string[] {
    return this.#admitted(person, progress, revisions).map(({ id }) =>
      revisionKey(id, revisions.get(id) ?? "")
    );
  }

  /**
   * Someone's interview as they read it back, and staff: whether they
   * read what this is (`told`) and which facts they agreed to (`agreed`)
   * as this store holds them, never as the page last said.
   */
  #forSpeaker(
    person: string,
    progress: InterviewProgress | null
  ): InterviewProgress | null {
    if (progress === null) {
      return null;
    }
    const revisions = this.#revisionsOf(person);
    const approved = this.#approvedOf(person);
    return {
      ...progress,
      told: this.#participating(person) === null,
      facts: progress.facts.map(({ agreed: _agreed, ...fact }) => {
        const revision = revisions.get(fact.id);
        return revision !== undefined &&
          approved.has(revisionKey(fact.id, revision))
          ? { ...fact, agreed: true as const }
          : fact;
      }),
    };
  }

  /**
   * What follows what counts of someone's interview changing, in the
   * transaction it changed in. Something they had approved that stopped
   * counting (`lost`) makes every record the brain has resting on them
   * rest on someone gone, so it is taken out unless someone else's
   * approval keeps it, and what is drawn or given from before is thrown
   * away (`revokedAt`). While anything still counts (`counts`) it is
   * drawn and given to the brain again; once nothing does, it is as if
   * they never agreed.
   */
  #admissionChanged(
    person: Roster["people"][number],
    counts: boolean,
    lost: boolean,
    now: string
  ): void {
    if (lost) {
      // Every drawing it was in goes, whatever still counts: one drawn
      // from what no longer does never comes back, even when drawing it
      // again fails.
      this.#forgetDrawings(person.id);
      this.#db
        .update(interviewStates)
        .set({
          revokedAt: now,
          revocations: sql`${interviewStates.revocations} + 1`,
        })
        .where(eq(interviewStates.person, person.id))
        .run();
      const sent = this.#db
        .select()
        .from(brainSent)
        .where(eq(brainSent.person, person.id))
        .all();
      for (const row of sent) {
        this.#db
          .insert(brainSent)
          .values({ ...row, person: `${gonePrefix}${person.id}` })
          .onConflictDoNothing()
          .run();
      }
      this.#db.delete(brainSent).where(eq(brainSent.person, person.id)).run();
    }
    if (counts) {
      this.#db
        .update(interviewStates)
        .set({ agreedAt: now })
        .where(eq(interviewStates.person, person.id))
        .run();
      this.#brainDue(person.team, now);
      return;
    }
    this.#db
      .update(interviewStates)
      .set({ agreedAt: null, drawnAt: null })
      .where(eq(interviewStates.person, person.id))
      .run();
  }

  #onRoster(person: string): boolean {
    return this.#db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.id, person))
      .all()
      .some(({ id }) => id === person);
  }

  /**
   * Removes what someone said, where their interview stood and every
   * drawing it was in (`#erase`), and notes why. Returns what was said
   * in it, for its lines kept to go too (`#afterForget`).
   */
  #forget(
    person: string,
    now: string,
    what: string,
    by: string,
    lines: ReadonlyMap<string, string[]>
  ): SaidIn | null {
    this.#queueLines(lines.get(person) ?? []);
    const said = this.#erase(person);
    this.#noted(person, what, now, by);
    return said;
  }

  /**
   * Removes someone's interview, in the transaction it is called in: what
   * they said and agreed to, where it stood, and every drawing it was in (`#forgetDrawings`). From then on nothing
   * they agreed to counts (`#agreedAt` is null), which is how the brain's
   * records resting on them are found (`#toPurge`). Returns what was said
   * in it, as its lines may have been kept.
   */
  #erase(person: string): SaidIn | null {
    const said = this.#saidIn(person);
    this.#forgetDrawings(person);
    this.#db.delete(interviews).where(eq(interviews.person, person)).run();
    this.#db
      .delete(interviewStates)
      .where(eq(interviewStates.person, person))
      .run();
    this.#db
      .delete(interviewSettings)
      .where(eq(interviewSettings.person, person))
      .run();
    // Withdrawing is final (GRA-329): its mark outlives a delete and a new
    // start, so they never take part again while on the list. Nothing said
    // is in it; leaving the list takes it too (`#writeRoster`).
    this.#db
      .delete(participations)
      .where(
        and(
          eq(participations.person, person),
          isNull(participations.withdrawnAt)
        )
      )
      .run();
    this.#db.delete(approvals).where(eq(approvals.person, person)).run();
    this.#db.delete(readbacks).where(eq(readbacks.person, person)).run();
    // A roster fix still to make from what they agreed to rests on it, and
    // goes with it. A referral names nobody else: whom it names is worked
    // out from the roster only as it is made (`#referOne`).
    this.#db.delete(referrals).where(eq(referrals.person, person)).run();
    return said;
  }

  /** `person`'s interview as stored, or null when there is none or it doesn't parse. */
  #storedProgress(person: string): InterviewProgress | null {
    const [stored] = this.#db
      .select({ progress: interviews.progress })
      .from(interviews)
      .where(eq(interviews.person, person))
      .all();
    if (stored === undefined) {
      return null;
    }
    const parsed = interviewProgressSchema.safeParse(
      JSON.parse(stored.progress)
    );
    return parsed.success ? parsed.data : null;
  }

  /** The interviewer's lines and the facts read back in someone's interview; none before a save. */
  #saidIn(
    person: string,
    held: InterviewProgress | null = this.#storedProgress(person)
  ): SaidIn | null {
    if (held === null) {
      return null;
    }
    const progress = held;
    const [settings] = this.#db
      .select()
      .from(interviewSettings)
      .where(eq(interviewSettings.person, person))
      .all();
    const speakers = [
      ...new Set(
        [settings?.interviewer, progress.interviewer].flatMap((each) =>
          each === undefined ? [] : [each]
        )
      ),
    ];
    return {
      texts: [
        ...progress.lines
          .filter(({ from }) => from === "stephen")
          .map(({ text }) => text),
        ...progress.facts.map(({ text }) => text),
      ],
      speakers: speakers.length > 0 ? speakers : ["stephen", "claire"],
      languages: settings === undefined ? anyLanguage : [settings.locale],
    };
  }

  /**
   * Forgets every drawing someone's interview was in, so each piece of
   * work is drawn again from who is left, or stays undrawn when nobody is:
   * one drawn from them or from whose agreements, and, when they lead a
   * team or gave its lead's interview, every one of that team, whose
   * drawings had their facts for context. A drawing under way is thrown
   * away as it ends (`#drawWork`).
   */
  #forgetDrawings(person: string): void {
    const [state] = this.#db
      .select({ leadOf: interviewStates.leadOf })
      .from(interviewStates)
      .where(eq(interviewStates.person, person))
      .all();
    const [link] = this.#db
      .select({ ledTeam: links.ledTeam })
      .from(links)
      .where(eq(links.person, person))
      .all();
    const led = new Set(
      [
        state?.leadOf,
        link?.ledTeam,
        ...(this.#roster()
          ?.teams.filter(({ lead }) => lead === person)
          .map(({ id }) => id) ?? []),
      ].flatMap((team) => (team === undefined || team === null ? [] : [team]))
    );
    const teamOf = new Map(
      this.#db
        .select({ id: works.id, team: works.team })
        .from(works)
        .all()
        .map(({ id, team }) => [id, team])
    );
    for (const row of this.#db.select().from(drawnWorks).all()) {
      const drawn = drawingOf(row.drawn);
      const rests =
        drawn?.from.includes(person) === true ||
        // A drawing that no longer reads as one may still hold them.
        row.drawn?.includes(JSON.stringify(person)) === true ||
        person in agreedOf(row.agreed) ||
        led.has(teamOf.get(row.work) ?? "");
      if (rests) {
        this.#db.delete(drawnWorks).where(eq(drawnWorks.work, row.work)).run();
        // The ways of a difference checked in it hold their words too.
        this.#db
          .delete(checkedDifferences)
          .where(eq(checkedDifferences.work, row.work))
          .run();
        this.#db
          .delete(drawFailures)
          .where(eq(drawFailures.item, `work:${row.work}`))
          .run();
      }
    }
  }

  /**
   * The stored keys of the voice's lines of each of `persons`' interviews,
   * as they stand: hashed before anything is erased, so the erasing
   * transaction keeps them waiting itself (`#queueLines`, GRA-329).
   */
  async #lineKeysOf(persons: Iterable<string>): Promise<Map<string, string[]>> {
    const keys = new Map<string, string[]>();
    for (const person of persons) {
      const said = this.#saidIn(person);
      if (said !== null) {
        // oxlint-disable-next-line no-await-in-loop -- one interview's lines at a time
        keys.set(person, await spokenKeysOf(said));
      }
    }
    return keys;
  }

  /** Keeps the voice's lines `keys` waiting to go, in the transaction it is called in. */
  #queueLines(keys: readonly string[]): void {
    for (const key of keys) {
      this.#db
        .insert(linesToForget)
        .values({ key })
        .onConflictDoNothing()
        .run();
    }
  }

  /**
   * What follows someone's interview going, once it's gone here: what is
   * left of the work it was in is drawn again, the brain's records that
   * rested on it are taken out (`purgeBrain`), and so are the lines said
   * in it that were kept. Both are tried again by the alarm until done
   * (`#armDrawing`): the brain's records rest on someone gone until they
   * are out, and the lines wait by their stored keys, hashes, never what
   * was said (`linesToForget`, GRA-329), queued by the erasing transaction
   * itself; any line said after they were hashed is queued here.
   */
  async #afterForget(said: readonly (SaidIn | null)[]): Promise<void> {
    const each = await Promise.all(
      said.map(async (lines) =>
        lines === null ? [] : await spokenKeysOf(lines)
      )
    );
    const keys = each.flat();
    this.ctx.storage.transactionSync(() => {
      this.#queueLines(keys);
    });
    await this.#armDrawing();
    // What the new Brain holds of their interview is decided again: an
    // erasure owed, before anything else (`owedErasures`).
    this.#decideInterviews();
    try {
      await this.purgeBrain();
    } catch (error) {
      log.error("onboarding.purge_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    await this.forgetLinesNow();
  }

  /**
   * Takes the voice's lines kept by `stored` (hashes) out of the cache, now
   * or from the alarm until done: a line the voice said while a content
   * purge landed (speech.ts, `keepUnlessPurged`).
   */
  async forgetSpoken(stored: readonly string[]): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.#queueLines(stored);
    });
    await this.forgetLinesNow();
    await this.#armDrawing();
  }

  /**
   * Most stored lines one try takes out of the cache: each is a line's
   * folder, listed before its objects go (speech-cache.ts).
   */
  static readonly #linesPerTry = 100;

  /** Most tries one call makes; the alarm takes the rest. */
  static readonly #triesPerCall = 5;

  /**
   * Takes the voice's lines still waiting (`linesToForget`) out of the
   * cache, a page at a time, each forgotten here once the cache confirms
   * it. What fails, or is left past this call's tries, waits for the
   * alarm. Returns how many went.
   */
  async forgetLinesNow(): Promise<number> {
    let gone = 0;
    for (let tries = 0; tries < Onboarding.#triesPerCall; tries += 1) {
      const page = this.#db
        .select({ key: linesToForget.key })
        .from(linesToForget)
        .orderBy(asc(linesToForget.key))
        .limit(Onboarding.#linesPerTry)
        .all()
        .map(({ key }) => key);
      if (page.length === 0) {
        return gone;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- one page at a time
        await forgetStored(this.env, page);
      } catch (error) {
        log.error("onboarding.lines_unforgotten", {
          error: error instanceof Error ? error.name : "unknown",
        });
        return gone;
      }
      this.#db
        .delete(linesToForget)
        .where(inList(linesToForget.key, page))
        .run();
      gone += page.length;
    }
    return gone;
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
    /** How much onboarding the company goes through: staff's, or all of it. */
    flow: OnboardingFlow;
    /** Whether staff set the flow. */
    flowSet: boolean;
  } {
    const [row] = this.#db
      .select()
      .from(onboarding)
      .where(eq(onboarding.id, 1))
      .all();
    const plan = row?.plan ?? null;
    const agreements = row?.agreements ?? null;
    const { flow, set: flowSet } = storedFlowOf(row?.flow ?? null);
    return {
      plan: plan === null ? null : planSchema.parse(JSON.parse(plan)),
      agreements:
        agreements === null
          ? null
          : agreementsSchema.parse(JSON.parse(agreements)),
      pausedAt: row?.pausedAt ?? null,
      flow,
      flowSet,
    };
  }

  /** When a piece of work counts as known here: staff's, or the starting values. */
  #rules(): OrgRules {
    const [row] = this.#db
      .select({ rules: onboarding.rules })
      .from(onboarding)
      .where(eq(onboarding.id, 1))
      .all();
    const stored = row?.rules ?? null;
    return stored === null
      ? STARTING_ORG_RULES
      : (orgRulesSchema.safeParse(JSON.parse(stored)).data ??
          STARTING_ORG_RULES);
  }

  /** The pieces of work Grasp counts as known by hand. */
  #countedWorks(): Set<string> {
    return new Set(
      this.#db
        .select({ work: countedWorks.work })
        .from(countedWorks)
        .all()
        .map(({ work }) => work)
    );
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
    detail: Record<string, AuditDetailValue>,
    about: string | null = null
  ): void {
    const at = new Date().toISOString();
    // The onboarding's own log may name whom it was about; the audit log never does.
    this.#db
      .insert(events)
      .values({ at, by: whoIs(by), what: action, about })
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
