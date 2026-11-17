import { STARTING_ORG_RULES } from "@grasp-os/shared/admin/onboarding-admin";
import type { OrgRules } from "@grasp-os/shared/admin/onboarding-admin";
import {
  addDays,
  addWorkingDays,
  dayOf,
} from "@grasp-os/shared/admin/org-record";
import type {
  DrawnWork,
  Told,
  WorkRecord,
} from "@grasp-os/shared/admin/org-record";
import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditActor, AuditDetailValue } from "@grasp-os/shared/audit";
import type { StatementKind } from "@grasp-os/shared/brain";
import { brainRecordSchema } from "@grasp-os/shared/brain-records";
import type { WorkflowVersionRecord } from "@grasp-os/shared/brain-records";
import { randomToken, sha256Hex } from "@grasp-os/shared/encoding";
import {
  erasedFact,
  factRevision,
  interviewPagePath,
  interviewProgressSchema,
  isErased,
  onlyForAsking,
  participationNotice,
  sharedWithTeam,
} from "@grasp-os/shared/interview-links";
import type {
  ApprovedFact,
  InterviewApproval,
  InterviewFact,
  InterviewParticipation,
  InterviewProgress,
  InterviewSaved,
  InterviewSession,
  InterviewWithdrawal,
} from "@grasp-os/shared/interview-links";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import { canonicalJson } from "@grasp-os/shared/json";
import {
  isVisionShared,
  kickoffErrors,
  visionFields,
} from "@grasp-os/shared/kickoff";
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
  lte,
  ne,
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
  brainDrawings,
  brainInterviews,
  brainOpinions,
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
  spokenKeys,
  linkCodes,
  documents,
  kickoff,
  links,
  onboarding,
  opinionBackers,
  opinionCandidates,
  opinionInputs,
  opinionPeople,
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
import { intakeIds, intakeOf, withoutNames } from "./brain-intake.ts";
import type { IntakeClaim, IntakeDrawing, TeamIntake } from "./brain-intake.ts";
import {
  candidateId,
  candidateInputOf,
  companyMayHaveOpinions,
  companyOpinions,
  mergeChecks,
  mergeInputOf,
  opinionBackersMin,
  teamCandidates,
} from "./company-opinions.ts";
import type { CandidateBrief } from "./company-opinions.ts";
import { companyTeamsText } from "./company-teams.ts";
import type { CompanyTeam } from "./company-teams.ts";
import { storedDocumentReadingSchema } from "./document-reading.ts";
import { checkedSupport } from "./drawing-support.ts";
import type { Support } from "./drawing-support.ts";
import { companyKickoffOf, companyKickoffText } from "./kickoff-company.ts";
import type { CompanyKickoff } from "./kickoff-company.ts";
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
import { SourcesFallError } from "./sources-fall.ts";
import type { FallingSource, SourceRemover } from "./sources-fall.ts";
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
// - A link opening what isn't its own (GRA-287, GRA-1790, links.ts): the
//   store is given only the hash of a link's secret and the account signed
//   in, and opens one person's interview for the one account it belongs
//   to: the first whose verified address it was sent to (`#heldAt`).
//   What each person does on their link is in the onboarding's own log,
//   which only staff read, never in the audit log, which the company's
//   admin reads: it would tell them who talked, and when. A delete from
//   the link too: the admin sees each lead's status, so its moment alone
//   would tell them which lead it was (GRA-368).
// - A deleted interview left anywhere (GRA-368): deleting one, from its
//   link, by staff, with a new start or by taking someone off the roster,
//   takes out at once what they said, where it stood, every drawing it
//   was in (drawn again from who is left, or emptied), every claim and
//   drawing of the new Brain that no longer stands without it (out of use
//   before the change commits, `#recountStanding`), and Stephen's lines
//   kept from it (spoken-lines.ts). A drawing or an intake under way when
//   it goes is thrown away, or what it noted forgotten, as it ends.
// - A mail going twice, or a link's secret kept or logged: mail goes
//   through the outbox (mail-outbox.ts), once by its key, the link filled
//   in only as the mail is sent. Each link goes by email on its day, and
//   one reminder after `remindAfterWorkingDays`; the admin's update twice
//   a week holds the admin's own numbers, never a name (mail-text.ts).
// - A removed document's reading living on (GRA-970): removing a shared
//   document forgets its reading here, every drawing that may have had it
//   for context, and those drawings in the brain (`forgetDocuments`). A
//   drawing under way when it goes is thrown away as it ends, and drawn
//   again.

/** The one store of a deployment, by the name it is reached under. */
const storeName = onboardingStoreName;

/** The deployment's onboarding store. */
/**
 * The KV key of how often something was erased from what the onboarding
 * holds (`#purged`: the kickoff deleted, `deleteKickoff`): what anything
 * reading the kickoff or the interviews to write from them later checks
 * it still finds, or keeps nothing.
 */
const purgesKey = "purges";

/**
 * The KV key of the number the last key queued to go from the voice's
 * cache was given (`#queueLines`): store-wide, and it only grows, so a
 * row of `forget_lines` never carries a number it carried before, and a
 * take-out deletes a row only as it read it (`forgetLinesNow`).
 */
const queuedKey = "forget_lines_queued";

/**
 * How often the kickoff changed (a save or an answer), store-wide: the
 * key the new Brain is given with its text at each hand-over
 * (`kickoffToHand`). A version is that text as it stood when the
 * hand-over ran: changes that land between two hand-overs are one
 * version, the later text holding all of them, so nothing anyone could
 * read is lost. A change back to earlier words still counts, so it is a
 * new version, never a retry of an old one; a retry of a hand-over with
 * no change since reads the same key and text and adds nothing.
 */
const kickoffChangesKey = "kickoff_changes";

/**
 * The company's teams as the admin last confirmed them (`#rosterConfirmed`):
 * when, and each confirmed team taking part, its name, the admin's own
 * description and its head count. What every member reads on the Brain
 * page (`companyTeams`); gone with the Brain's copy when the admin erases
 * it (`eraseTeamsFromBrain`), until the next confirmed save.
 */
const rosterConfirmedKey = "roster_confirmed";

const companyTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  does: z.string(),
  people: z.int(),
});

const rosterConfirmedSchema = z.object({
  at: z.string(),
  teams: z.array(companyTeamSchema),
});

/**
 * What the new Brain was last given of the company's teams: under which of
 * its ids (`rosterBrainIdKey`), the key of that change (a count that only
 * grows, so a text back to an earlier one is a new version), and the text.
 * Gone once the admin erased it (`eraseTeamsFromBrain`), so the next
 * confirmed save gives the Brain the teams afresh.
 */
const rosterHandedKey = "roster_handed";

const rosterHandedSchema = z.object({
  id: z.string(),
  change: z.int(),
  text: z.string(),
});

/**
 * How often the admin erased the company's teams from the Brain: the
 * teams' id there is `teams-<that count>` (`rosterBrainId`), so the teams
 * given after an erase are a source of their own, never under the key the
 * erase closed.
 */
const rosterErasesKey = "roster_erases";

/**
 * What starts the key of each id of the company's teams the admin erased
 * that the Brain may still hold, the rest being that id: set with the
 * erase in one transaction, gone once core's erasure of it returned
 * (`rosterErased`).
 */
const rosterErasurePrefix = "roster_erasure_owed:";

/**
 * What starts the key of each kickoff the admin deleted whose source the
 * new Brain still holds (`deleteKickoff`), the rest being its id there:
 * set with the delete in one transaction, gone once core's erasure of it
 * returned (`kickoffErased`). One a deleted kickoff, so a second delete
 * before the first's erasure leaves both owed.
 */
const kickoffErasurePrefix = "kickoff_erasure_owed:";

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
  | "interview.deleted"
  | "interview.limited"
  | "interview.not_participating"
  | "interview.notice_changed"
  | "interview.withdrawn";

/**
 * Who opens a link (links.ts): the account their session is for, and the
 * address the company's sign-in verified for it.
 */
export interface LinkCaller {
  account: string;
  address: string;
}

/** What a link's request gets from the store: an answer, or why not. */
export type LinkAnswer<T> =
  | { ok: true; value: T }
  | { ok: false; code: LinkRefusal };

/**
 * What core settles with the new Brain after a request on someone's link
 * (links.ts, onboarding/new-brain.ts): whose link it is, and the teams
 * whose claims they backed before it. Only for whoever holds the link, so
 * anyone else's request does nothing more on a real link than on one that
 * never was.
 */
export interface LinkWork {
  person: string;
  backed: string[];
}

/** A request on a link that may change what the new Brain holds. */
export type LinkActed<T> = LinkAnswer<T> & { work?: LinkWork };

const refused = (code: LinkRefusal) => ({ ok: false, code }) as const;

/** What a save keeps, and what it erases (`#erasing`). */
interface SaveErasures {
  progress: InterviewProgress;
  revisions: Map<string, string>;
  lines: number;
  dropped: string[];
}

/** A save checked (`#savable`): the answer refusing it, or what it keeps. */
type Savable =
  | { answer: LinkAnswer<InterviewSaved> }
  | { next: number; erasing: SaveErasures };

/** `answer`, with the work core settles after it (`LinkActed`). */
const acted = <T>(work: LinkWork, answer: LinkAnswer<T>): LinkActed<T> => ({
  ...answer,
  work,
});

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
/** What a run of the company's opinions is noted as among the failures (`draw_failures`). */
const opinionsItem = "opinions";
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
 * What an admin's voice counts and notes under (speech.ts): `admin:` and
 * their user ID.
 */
export const adminWho = "admin:";

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

/**
 * The pieces of a map drawn before that outlive a map drawn again, which
 * no longer names them: one someone was asked about, or one drawn already.
 * Only while the map they came from stands (`#mapTeam`).
 */
const outliving = <
  Piece extends { id: string; drawn: unknown; doers: string[] },
>(
  before: readonly Piece[],
  named: readonly { id: string }[],
  members: readonly { id: string }[],
  asked: ReadonlyMap<string, string>
): Piece[] =>
  before
    .filter(
      (old) =>
        !named.some(({ id }) => id === old.id) &&
        (old.drawn !== null ||
          members.some(({ id }) => asked.get(id) === old.id))
    )
    .map((old) => ({ ...old, doers: [...old.doers] }));

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

/** An address as `links.sent_to_email` keeps it, and a sign-in's is compared. */
const foldedAddress = (email: string): string => email.trim().toLowerCase();

/**
 * An erasure the onboarding still owes the new Brain (`owedErasures`), for
 * core to do with `eraseSource` (onboarding/new-brain.ts): a source it
 * gave that no longer stands.
 */
/**
 * A team claim that stands now: not owed an erasure. The one rule, for
 * the hand-over (`claimToHand`) and the Brain page (`standingClaims`). A
 * claim that stops standing (under five backers, its team under seven
 * interviewed, or no longer made) is marked in the transaction of the
 * change that drops it, before that change commits (`#recountStanding`,
 * `#noteClaims`, `#fallenFirst`), so it leaves both before it is out of
 * the Brain, and no unmarked claim is of a team under seven.
 */
const standingClaim = eq(brainClaims.erase, false);

/** A falling source's key among those an object saw taken out (`#takenOut`). */
const fallenKey = ({ producer, id }: FallingSource): string =>
  `${producer}:${id}`;

/** A drawing that stands now: not owed an erasure, as `standingClaim` for claims. */
const standingDrawing = eq(brainDrawings.erase, false);

/** A drawing standing now, as the Brain page shows it (`standingDrawings`). */
export interface StandingDrawing {
  /** Its id in the Brain (`drawing:<source>`). */
  source: string;
  /** The piece of work's id on the Brain page. */
  workflow: string;
  /** The staff list's team. */
  team: string;
  name: string;
  local?: string;
  drawing: WorkflowVersionRecord;
}

/** A drawing as the store keeps it (`brain_drawings.drawing`), or none when it no longer reads as one. */
const brainDrawingOf = (stored: string): WorkflowVersionRecord | null => {
  const parsed = brainRecordSchema.safeParse(JSON.parse(stored));
  return parsed.success && parsed.data.type === "workflowVersion"
    ? parsed.data
    : null;
};

/** A team claim standing now, as the Brain page shows it (`standingClaims`). */
export interface StandingClaim {
  /** Its id in the Brain (`claim:<source>`). */
  source: string;
  /** The staff list's team. */
  team: string;
  kind: StatementKind;
  text: string;
}

export type OwedErasure =
  | {
      kind: "interview";
      source: string;
      account: string;
      reason: "deleted" | "withdrawn";
    }
  | { kind: "claim" | "drawing"; source: string; team: string }
  | { kind: "opinion"; source: string };

/**
 * An opinion of the company's that stands now (GRA-1987): not owed an
 * erasure, as `standingClaim` for a team's claims.
 */
const standingOpinion = eq(brainOpinions.erase, false);

/**
 * An opinion of the company's standing now, as the Brain page shows it
 * (`standingOpinions`): its words alone, never a team, nor who or how
 * many back it.
 */
export interface StandingOpinion {
  /** Its id in the Brain (`opinion:<source>`). */
  source: string;
  kind: StatementKind;
  text: string;
  /** The day the company's opinions were put together, for the page's source. */
  at: string;
}

/**
 * The one rule for whether an opinion of the company's resting on
 * `backers` stands now (GRA-1987): the company has seven or more who may
 * back one (`companyMayHaveOpinions`, the store's `#opinionTellers`), and
 * five or more of `backers` are among them (`opinionBackersMin`). Noting
 * opinions (`#noteOpinions`) and the recount (`#opinionsFalling`) both
 * ask it.
 */
const opinionStands = (
  backers: readonly string[],
  tellers: ReadonlyMap<string, unknown>
): boolean =>
  companyMayHaveOpinions(tellers.size) &&
  backers.filter((person) => tellers.has(person)).length >= opinionBackersMin;

/** A hash of the lines `person` left only counted anonymously, with whose they are: what a run of the opinions compares (`opinion_people`). */
const linesMark = async (
  person: string,
  lines: readonly string[]
): Promise<string> =>
  await sha256Hex(canonicalJson([person, [...lines].toSorted()]));

/**
 * When what the new Brain holds of someone's interview is to be decided
 * again, as SQL over their link `l` (`links.brain_mark`): their account,
 * their link's version (every save, delete and new start moves it), their
 * withdrawal and their approvals. It says only when to
 * look again: which source stands is keyed on what they approved
 * (`#interviewWanted`), so a save that leaves that alone changes nothing.
 * NULL without an account or once core erased them.
 */
const interviewDueSql = `CASE WHEN l.user_id IS NULL OR l.erased_at IS NOT NULL THEN NULL ELSE
  l.user_id || '|' || l.version
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
 * The teams whose results a save may show again once their next intake
 * runs (GRA-1748), so they are given again: both teams of everyone who
 * moved, a move back too, and, once the admin confirms it, each team
 * switched from off to on. A team that waits for confirmation is given
 * again when it is confirmed (`#confirmed`).
 */
const teamsBack = (
  before: Roster | null,
  roster: Roster,
  { confirmed }: { confirmed: boolean }
): string[] => {
  const was = new Map(before?.people.map(({ id, team }) => [id, team]));
  const moved = roster.people.flatMap(({ id, team }) => {
    const from = was.get(id);
    return from === undefined || from === team ? [] : [from, team];
  });
  const offBefore = new Set(
    before?.teams.flatMap(({ id, off }) => (off ? [id] : []))
  );
  const switchedOn = confirmed
    ? roster.teams.flatMap(({ id, off }) =>
        offBefore.has(id) && !off ? [id] : []
      )
    : [];
  return [...moved, ...switchedOn];
};

/**
 * Who a piece of work is drawn from, and when each last agreed: who does
 * it and who was asked about it, as far as they agreed to something and
 * are in its team now (`teamOf`, from the roster): someone who moved to
 * another team takes their part with them (GRA-1748). `agreedAt` says
 * when someone did; undefined when they didn't.
 */
const agreedAbout = (
  work: { id: string; team: string },
  doers: readonly string[],
  asked: readonly { person: string; work: string }[],
  teamOf: ReadonlyMap<string, string>,
  agreedAt: (person: string) => string | undefined
): [person: string, at: string][] =>
  [
    ...new Set([
      ...doers,
      ...asked
        .filter((each) => each.work === work.id)
        .map(({ person }) => person),
    ]),
  ].flatMap((person): [string, string][] => {
    const at = teamOf.get(person) === work.team ? agreedAt(person) : undefined;
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
  /** Of the facts kept in, those they chose to share with their team (GRA-1987). */
  shared: number;
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
  /** Of the facts kept in, those they marked as shared as how their team works (GRA-1987). */
  shared: number;
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
  shared: 0,
};

/** The statements of `progress` taken out in the read-back and not erased yet. */
const takenOut = (progress: InterviewProgress): InterviewFact[] =>
  progress.facts.filter((fact) => fact.out === true && !isErased(fact));

/** `progress` with every statement taken out erased (`erasedFact`), each in its place. */
const withTakenOutErased = (
  progress: InterviewProgress
): InterviewProgress => ({
  ...progress,
  facts: progress.facts.map((fact) =>
    fact.out === true ? erasedFact(fact) : fact
  ),
});

/**
 * Whether `progress` brings back what `held` holds erased: a line they
 * removed, or the words of a statement erased (or the statement gone).
 */
const bringsBack = (
  held: InterviewProgress,
  progress: InterviewProgress
): boolean =>
  held.lines.some(
    (line, at) => line.removed === true && progress.lines[at]?.removed !== true
  ) ||
  held.facts.some(
    (fact) =>
      isErased(fact) &&
      !progress.facts.some((each) => each.id === fact.id && isErased(each))
  );

const countsOf = (progress: InterviewProgress): InterviewCounts => ({
  state: progress.person,
  phase: progress.phase,
  facts: progress.facts.filter(({ out }) => out !== true).length,
  shared: progress.facts.filter(
    ({ out, share }) => out !== true && share === "team"
  ).length,
  // One erased counts nowhere.
  out: takenOut(progress).length,
  confirmed: progress.confirmed,
  rating: progress.rating ?? null,
  typed: progress.mode === "type",
  interviewer: progress.interviewer ?? null,
});

/** The page a save names: its id, and how many saves it sent with this one. */
interface SavingPage {
  id: string;
  save: number;
}

/**
 * Whether a save over `version` goes on from the version `link` keeps:
 * it is that version, or an earlier save of the same page made it, which
 * this one comes after, and nothing moved it since (a delete, another
 * tab). A page's later save holds all its earlier ones did.
 */
const goesOnFromKept = (
  link: {
    version: number;
    savedByPage: string | null;
    savedPageSave: number | null;
    savedVersion: number | null;
  },
  version: number,
  page: SavingPage | undefined
): boolean =>
  version === link.version ||
  (page !== undefined &&
    link.savedByPage === page.id &&
    link.savedPageSave !== null &&
    page.save > link.savedPageSave &&
    link.savedVersion === link.version);

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

  /**
   * Team claims and drawings this object saw taken out of use in the Brain
   * (`#fallenFirst`) and still owed their erasure, by `fallenKey`: the
   * recount takes the rest of those owed out again first. Lost with the
   * object: after a restart, each owed is taken out once more.
   */
  readonly #takenOut = new Set<string>();

  /** Whether arming the alarm is asked for already, once the change that asked is done (`#armSoon`). */
  #arming = false;

  /**
   * How claims and drawings that stop standing are taken out of use in the
   * Brain (`#fallenFirst`): given by core's subclass, the object the
   * Worker runs (onboarding/object.ts). Without one, a change that drops
   * one fails, with nothing of it made.
   */
  readonly #removeFallen: SourceRemover | undefined;

  constructor(ctx: DurableObjectState, env: Env, removeFallen?: SourceRemover) {
    super(ctx, env);
    this.#removeFallen = removeFallen;
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
      kickoff: this.#kickoffState(),
      teamsInBrain: this.#teamsInBrain(),
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

  /** Whether the kickoff is kept, or deleted with its source in the new Brain still being erased (`kickoffErasuresOwed`). */
  #kickoffState(): OnboardingView["kickoff"] {
    const [row] = this.#db.select({ id: kickoff.id }).from(kickoff).all();
    if (row !== undefined) {
      return "in";
    }
    return this.kickoffErasuresOwed().length === 0 ? null : "erasing";
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
    return await this.#fallenFirst(
      async () => await this.#saveRosterOnce(roster, by, { confirmed })
    );
  }

  /** `saveRoster`, once: made again by `#fallenFirst` while claims fall. */
  async #saveRosterOnce(
    roster: Roster,
    by: AuditActor,
    { confirmed = true }: { confirmed?: boolean } = {}
  ): Promise<OnboardingView> {
    const fresh = await this.#freshCodes(roster);
    const said = this.ctx.storage.transactionSync(() => {
      const before = this.#roster();
      const { removed, erased } = this.#writeRoster(roster, fresh, {
        late: false,
      });
      this.#dueAgain(teamsBack(before, roster, { confirmed }));
      if (confirmed) {
        this.#confirmed(before, roster);
        this.#rosterConfirmed(new Date().toISOString());
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
      await this.#afterForget();
    }
    return this.view();
  }

  /**
   * Keeps the teams and people new on `roster`, while a plan is set, as
   * waiting for the admin to confirm the organization, with those that
   * waited already and are still on it; and a team switched from off to
   * on, so nothing of it shows again before the admin confirms it
   * (GRA-1748: a team's results follow the stricter of what the admin
   * confirmed and what they saved). Details of everyone else change at
   * once; their ids and links stay.
   */
  #holdNew(before: Roster | null, roster: Roster): void {
    if (this.#row().plan === null) {
      return;
    }
    const was = this.#unconfirmed();
    const teamsBefore = new Set(before?.teams.map(({ id }) => id));
    const peopleBefore = new Set(before?.people.map(({ id }) => id));
    const offBefore = new Set(
      before?.teams.flatMap(({ id, off }) => (off ? [id] : []))
    );
    this.#keepUnconfirmed({
      teams: roster.teams
        .filter(
          ({ id, off }) =>
            waits(id, teamsBefore, was.teams) || (offBefore.has(id) && !off)
        )
        .map(({ id }) => id),
      people: roster.people
        .map(({ id }) => id)
        .filter((id) => waits(id, peopleBefore, was.people)),
    });
  }

  /**
   * The admin confirmed the organization: nothing waits for it any more,
   * and a team that takes part only now, the ones that waited or were
   * switched on, starts as a late one, its lead first (`#lateTeams`), and
   * is due to be given to the Brain again.
   */
  #confirmed(before: Roster | null, roster: Roster): void {
    const { teams: waited } = this.#unconfirmed();
    // Its results may be shown now: an intake that ran while it waited
    // noted none of them (`#teamShowsResults`), so it is given again.
    this.#dueAgain([...waited]);
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
   * (`#askNewcomers`). Returns how many left, and whose interviews it
   * erased (`#erase`), for `#afterForget`.
   */

  #writeRoster(
    roster: Roster,
    fresh: readonly { person: string; linkId: string; mark: string }[],
    { late }: { late: boolean },
    now: string = new Date().toISOString()
  ): { removed: number; erased: string[] } {
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
          mappedDoes: teams.mappedDoes,
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
          // What its map drew, kept apart from what the admin wrote (GRA-1748).
          mappedDoes: was?.mappedDoes ?? null,
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
    const erased: string[] = [];
    for (const person of new Set([...gone, ...stale])) {
      this.#erase(person);
      erased.push(person);
      // Off the list, they take part in nothing: no mark of theirs stays,
      // their withdrawal's neither.
      this.#db
        .delete(participations)
        .where(eq(participations.person, person))
        .run();
      this.#db.delete(linkCodes).where(eq(linkCodes.person, person)).run();
      this.#db.delete(links).where(eq(links.person, person)).run();
      dropMailAbout(this.ctx.storage.sql, person);
    }
    this.#lateTeams(late ? before : roster, roster, now);
    this.#askNewcomers(before, roster);
    // Someone moved out, made a lead or taken off may leave a team too
    // small to have claims shown (`teamMayClaim`), or a claim under five of
    // its team's people now: those claims are out of use in the Brain
    // before this transaction commits (`#recountStanding`).
    this.#recountStanding("all");
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
      const mine = this.#worksStanding(team.id);
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

  /** Whoever core erased whose entry is still on the list (`#closeAndDeleteHeldBy`). */
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
   * What a link opens, for the signed-in `caller` (links.ts): the account
   * it belongs to, or, before it belongs to any, one whose address the
   * company's sign-in verified is the one it was sent to (`#holds`). The
   * first such opening makes the interview that account's, for good
   * (`links.account`, GRA-1790): from then on that account alone opens it,
   * whatever the list says. Anyone else is told it opens nothing, as for a
   * link that never was.
   */
  openLink(
    secretMark: string,
    caller: LinkCaller,
    now: string = new Date().toISOString()
  ): LinkAnswer<InterviewSession> {
    const found = this.ctx.storage.transactionSync(() => {
      const opened = this.#onLink(secretMark, caller, now, "open");
      if (!opened.ok) {
        return opened;
      }
      const { person, link } = opened.value;
      if (link.account === null || link.openedAt === null) {
        // Theirs from this moment, in the same transaction that found the
        // address theirs (`#holds`).
        this.#db
          .update(links)
          .set({
            openedAt: link.openedAt ?? now,
            account: caller.account,
            // The address it was opened under stays its address.
            sentTo: link.sentTo ?? foldedAddress(caller.address ?? ""),
          })
          .where(eq(links.person, person.id))
          .run();
        if (link.openedAt === null) {
          this.#noted(person.id, "interview.opened", now);
        }
      }
      return opened;
    });
    if (!found.ok) {
      return found;
    }
    const { person, link, roster, plan } = found.value;
    const team = roster.teams.find(({ id }) => id === person.team);
    const lead = roster.people.find(
      ({ id }) => id === team?.lead && id !== person.id
    );
    const closes = closesOn(plan);
    return answered({
      state: "open",
      name: firstName(person.name),
      team: team?.name ?? "",
      lead: lead === undefined ? null : firstName(lead.name),
      kind: leads(roster, person.id) ? "lead" : "own",
      closes,
      closed: dayOf(now) > closes,
      progress: this.#forSpeaker(person.id, this.#held(person.id)),
      version: link.version,
      withdrawn: this.#withdrawnAt(person.id) !== null,
      // What the Brain kept of theirs, or of their team's claims, is still
      // owed its erasure (a withdrawal's or a delete's that didn't land
      // yet): the page says so until it lands.
      removing: this.owedErasures({ person: person.id }).length > 0,
    });
  }

  /** Whose interviews are kept. */
  #interviewPeople(): string[] {
    return this.#db
      .select({ person: interviews.person })
      .from(interviews)
      .all()
      .map(({ person }) => person);
  }

  /**
   * `person`'s interview as kept: read as an interview, or, one that no
   * longer reads as one, as stored (its words are still in it); null when
   * none is kept. Never served otherwise.
   */
  #interviewStored(
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
   * Keeps where someone's interview is, for the account it belongs to. A save
   * from an older copy than the one kept is refused with the one kept, so
   * two tabs never quietly overwrite each other. Deleting moves the version
   * on too: only a copy opened since the delete saves again. One save goes
   * on from the version before: the one a page sent as it closed, `after`
   * its own save that made the version kept now, whose answer never
   * reached it. It holds all that one did and what changed since.
   */
  async saveInterview(
    secretMark: string,
    account: string,
    version: number,
    progress: InterviewProgress,
    page?: SavingPage,
    now: string = new Date().toISOString()
  ): Promise<LinkActed<InterviewSaved>> {
    return await this.#fallenFirst(
      async (again) =>
        await this.#saveInterviewOnce(
          secretMark,
          account,
          version,
          progress,
          page,
          now,
          !again
        )
    );
  }

  /**
   * `saveInterview`, once: made again by `#fallenFirst` while claims fall,
   * then not counted (`asCall`) against the link's calls a second time.
   */
  async #saveInterviewOnce(
    secretMark: string,
    account: string,
    version: number,
    progress: InterviewProgress,
    page: SavingPage | undefined,
    now: string,
    asCall: boolean
  ): Promise<LinkActed<InterviewSaved>> {
    const found = this.#onLink(secretMark, { account }, now, "save", asCall);
    if (!found.ok) {
      return found;
    }
    const { person, roster } = found.value;
    const work = this.#linkWork(person.id);
    // Checked again whenever another save landed while this one's erasures
    // were worked out; from that check to the write below nothing waits,
    // so nothing lands between them.
    let savable: Savable;
    do {
      // oxlint-disable-next-line no-await-in-loop -- one check after another
      savable = await this.#savable(person.id, version, page, progress);
    } while (
      !("answer" in savable) &&
      this.#versionOf(person.id) !== savable.next - 1
    );
    if ("answer" in savable) {
      return acted(work, savable.answer);
    }
    const { next, erasing } = savable;
    const { progress: keeping, revisions } = erasing;
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
    const after = this.#admittedKeys(person.id, keeping, revisions);
    const lost = before.some((key) => !after.includes(key));
    const changed = admissionKey(before) !== admissionKey(after);
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(links)
        .set({
          version: next,
          savedByPage: page?.id ?? null,
          savedPageSave: page?.save ?? null,
          savedVersion: next,
        })
        .where(eq(links.person, person.id))
        .run();
      const kept = {
        progress: JSON.stringify(keeping),
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
      this.#keepErased(person.id, erasing, now);
    });
    // What it queued goes from the cache now; whatever the cache doesn't
    // take waits for the alarm.
    await this.forgetLinesNow();
    if (lost) {
      // What rested on a revision that no longer counts leaves the brain
      // now, or from the alarm until it does.
      this.ctx.waitUntil(this.#afterForget());
    } else if (changed) {
      this.ctx.waitUntil(this.#alarmBy(Date.parse(now) + drawAfterMs));
    }
    return acted(work, answered({ saved: true, version: next }));
  }

  /**
   * They read what the interview is for (`participationNotice`) and agree
   * to take part: nothing they say is recorded or read by a model before
   * (GRA-329). The same notice agreed to again answers as the first time;
   * someone who withdrew can't take part again in this interview.
   */
  participate(
    secretMark: string,
    account: string,
    notice: number,
    now: string = new Date().toISOString()
  ): LinkAnswer<InterviewParticipation> {
    const found = this.#onLink(secretMark, { account }, now, "save");
    if (!found.ok) {
      return found;
    }
    const { person } = found.value;
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
    account: string,
    facts: readonly ApprovedFact[],
    now: string = new Date().toISOString()
  ): Promise<LinkActed<InterviewApproval>> {
    // From the request alone, before anything here is read.
    const receipt = await receiptOf(facts);
    const found = this.#onLink(secretMark, { account }, now, "save");
    if (!found.ok) {
      return found;
    }
    const { person, link } = found.value;
    const work = this.#linkWork(person.id);
    const taking = this.#participating(person.id);
    if (taking !== null) {
      return acted(work, refused(taking));
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
      return acted(
        work,
        answered({
          approved: false,
          version: link.version,
          progress: this.#forSpeaker(person.id, progress),
        })
      );
    }
    const [kept] = this.#db
      .select({ at: readbacks.at })
      .from(readbacks)
      .where(
        and(eq(readbacks.person, person.id), eq(readbacks.receipt, receipt))
      )
      .all();
    if (kept !== undefined) {
      return acted(work, answered({ approved: true, receipt, at: kept.at }));
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
    return acted(work, answered({ approved: true, receipt, at: now }));
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
    account: string,
    now: string = new Date().toISOString()
  ): Promise<LinkActed<InterviewWithdrawal>> {
    return await this.#fallenFirst(
      async (again) =>
        await this.#withdrawOnce(secretMark, account, now, !again)
    );
  }

  /**
   * `withdraw`, once: made again by `#fallenFirst` while claims fall, then
   * not counted (`asCall`) against the link's calls a second time.
   */
  async #withdrawOnce(
    secretMark: string,
    account: string,
    now: string,
    asCall: boolean
  ): Promise<LinkActed<InterviewWithdrawal>> {
    const found = this.#onLink(secretMark, { account }, now, "delete", asCall);
    if (!found.ok) {
      return found;
    }
    const { person } = found.value;
    const work = this.#linkWork(person.id);
    const [held] = this.#db
      .select({ withdrawnAt: participations.withdrawnAt })
      .from(participations)
      .where(eq(participations.person, person.id))
      .all();
    if (held === undefined) {
      return acted(work, refused("interview.not_participating"));
    }
    if (held.withdrawnAt !== null) {
      return acted(work, answered({ withdrawn: true, at: held.withdrawnAt }));
    }
    this.ctx.storage.transactionSync(() => {
      this.#queueSpokenOf(person.id);
      this.#db
        .update(participations)
        .set({ withdrawnAt: now })
        .where(eq(participations.person, person.id))
        .run();
      this.#admissionChanged(person, false, true, now);
      this.#noted(person.id, "interview.withdrawn", now);
    });
    // Final, with no undo (GRA-329): every output it was in is erased, the
    // brain's records now or from the alarm until they are, and everything
    // the interviewer's voice said in it.
    await this.#afterForget();
    return acted(work, answered({ withdrawn: true, at: now }));
  }

  /**
   * What one turn of someone's interview may know, for the account it
   * belongs to, while the interviews run: who they are, their team and lead, and
   * what Stephen knows of the company beforehand, and what earlier
   * interviews about their work left open. Never from the page,
   * which could say anything. `work` stays empty until the team's map
   * names their piece of work: Stephen then asks which one it is.
   */
  turnContext(
    secretMark: string,
    account: string,
    now: string = new Date().toISOString()
  ): LinkAnswer<TurnContext> {
    const found = this.#onLink(secretMark, { account }, now, "save");
    if (!found.ok) {
      return found;
    }
    const { person, roster } = found.value;
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
   * nothing they added after until they agreed to that too. Only the lines
   * they chose to share as how their team works (GRA-1987): one
   * only counted anonymously never reaches the team's map, its drawings or
   * its claims, and someone with none to share tells their team nothing.
   * This is the one way facts leave the store for any of those.
   */
  drawInput(person: string): DrawInput | null {
    const [state] = this.#db
      .select()
      .from(interviewStates)
      .where(eq(interviewStates.person, person))
      .all();
    if (state === undefined) {
      return null;
    }
    const facts = this.#admitted(person).filter((fact) =>
      sharedWithTeam(fact, state.kind)
    );
    if (state.agreedAt === null || facts.length === 0) {
      return null;
    }
    return {
      person,
      kind: state.kind,
      agreedAt: state.agreedAt,
      generation: `${state.agreedAt}|${state.revocations}`,
      admission: `${state.startedAt ?? ""}|${state.revocations}`,
      // Who does the work they were asked about, and the work someone
      // says they do instead, are for putting right who is asked what
      // (`#referOne`), never shared (`sharedWithTeam` leaves them out).
      facts: facts.map(({ tag, record }) => ({ tag, record })),
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
   * The team claims and drawings that rest on someone's interview
   * (brain-intake.ts): what deleting it takes down (GRA-368). For staff and
   * the store alone; the Brain never names anyone.
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
   * The teams whose results may be shown (`#teamShowsResults`, the one
   * rule a team's claims and drawings stand by too): on the list, taking
   * part, and seven or more who tell their own work (GRA-1748).
   */
  #teamsShowingResults(roster: Roster | null): string[] {
    const mayClaim = new Map<string, boolean>();
    return (roster?.teams ?? []).flatMap(({ id }) =>
      this.#teamShowsResults(id, { roster, mayClaim }) ? [id] : []
    );
  }

  /**
   * Each team whose interviews its claims and drawings cite: one source
   * for all of them (brain-intake.ts), with how many of its people agreed
   * and the day the first of them did, never who. Only while its results
   * may be shown (`#teamsShowingResults`), in the order of that day.
   */
  interviewSources(): {
    team: string;
    name: string;
    people: number;
    since: string;
  }[] {
    const roster = this.#roster();
    const states = this.#agreedInterviews();
    return this.#teamsShowingResults(roster)
      .flatMap((id) => {
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
      })
      .toSorted(
        (a, b) => a.since.localeCompare(b.since) || a.team.localeCompare(b.team)
      );
  }

  /**
   * How many interviews the brain learned from, week by week, never who
   * gave them or on which day (GRA-1278): the interviews of the people who
   * agreed and still take part, in teams whose results may be shown
   * (`#teamsShowingResults`), by the Monday of the week each finished in.
   * A week of fewer than `minTeamShown` is left out, never added to
   * another week: no line stands for fewer people than a team's claim
   * needs, and a week a withdrawal takes below it goes without its rest
   * showing up elsewhere, where the difference would tell how many were
   * left.
   */
  interviewWeeks(): { week: string; interviews: number }[] {
    const roster = this.#roster();
    const showing = new Set(this.#teamsShowingResults(roster));
    const inShowing = new Set(
      (roster?.people ?? [])
        .filter((person) => showing.has(person.team))
        .map(({ id }) => id)
    );
    const byWeek = new Map<string, number>();
    for (const { person, completedAt } of this.#agreedInterviews()) {
      if (completedAt !== null && inShowing.has(person)) {
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
    const roster = this.#roster();
    const showing = new Set(this.#teamsShowingResults(roster));
    for (const team of roster?.teams ?? []) {
      if (team.off) {
        continue;
      }
      // A team whose results may not be shown shows no difference either:
      // its intake checks none (`#teamIntake`), and one checked before
      // stays out until it may again (GRA-1084, GRA-1748).
      const heard = showing.has(team.id);
      for (const work of this.#worksStanding(team.id)) {
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
   * Deletes someone's interview, for the account it belongs to, at any
   * time their link opens for it: what they said, and everything drawn from it,
   * is gone at once (`#forget`), and a copy left open elsewhere can't save
   * it back. Only the onboarding's own log has it (`#forget`), never the
   * audit log: its moment would tell the admin whose it was.
   */
  async deleteInterview(
    secretMark: string,
    account: string,
    now: string = new Date().toISOString()
  ): Promise<LinkActed<{ deleted: true }>> {
    return await this.#fallenFirst(
      async (again) =>
        await this.#deleteInterviewOnce(secretMark, account, now, !again)
    );
  }

  /**
   * `deleteInterview`, once: made again by `#fallenFirst` while claims
   * fall, then not counted (`asCall`) against the link's calls a second time.
   */
  async #deleteInterviewOnce(
    secretMark: string,
    account: string,
    now: string,
    asCall: boolean
  ): Promise<LinkActed<{ deleted: true }>> {
    const found = this.#onLink(secretMark, { account }, now, "delete", asCall);
    if (!found.ok) {
      return found;
    }
    const { person, link } = found.value;
    const work = this.#linkWork(person.id);
    this.ctx.storage.transactionSync(() => {
      this.#forget(person.id, now, "interview.deleted", interviewee);
      this.#db
        .update(links)
        .set({ deletedAt: now, version: link.version + 1 })
        .where(eq(links.person, person.id))
        .run();
    });
    await this.#afterForget();
    return acted(work, answered({ deleted: true }));
  }

  /**
   * A new start for someone whose interview went wrong: what they said
   * goes, and the link belongs to no account again, nor to the address it
   * went to: the next account whose address is the list's now opens it
   * (`#heldAt`), so a link that went to a wrong address, and was opened
   * there, is theirs again once the list is put right. Staff do it, as the
   * person asks; the audit log has that they did, not for whom.
   */
  async newStart(person: string, by: AuditActor): Promise<boolean> {
    return await this.#fallenFirst(
      async () => await this.#newStartOnce(person, by)
    );
  }

  /** `newStart`, once: made again by `#fallenFirst` while claims fall. */
  async #newStartOnce(person: string, by: AuditActor): Promise<boolean> {
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
        .set({
          account: null,
          sentTo: null,
          deletedAt: null,
          version: link.version + 1,
        })
        .where(eq(links.person, person))
        .run();
      this.#changed(by, "onboarding.interview.restarted", {});
    });
    this.#deliverAudit();
    // The new start is made: failing it now would have the same command,
    // given again, start anew a second time and take what was said since.
    try {
      await this.#afterForget();
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
   * Whom a line said on someone's link is for, for the account it belongs
   * to, while their interview may be saved: `link:<person>`, the key its
   * voice is counted under (`countVoice`), and the seconds said under it
   * today. Counted within the link's limit, as every call on it. The
   * line asked for is noted by its cache key (`stored`) in this same call,
   * so no erasure lands between finding the link open and the note
   * (`#noteSpoken`).
   */
  speechOnLink(
    secretMark: string,
    account: string,
    stored: string,
    budget: number,
    now: string = new Date().toISOString()
  ): LinkAnswer<{ who: string; said: number }> {
    const found = this.#voiceOnLink(secretMark, account, now);
    if (found.ok) {
      const { who, said } = found.value;
      this.#noteSpoken(who, stored, said < budget);
    }
    return found;
  }

  /** `speechOnLink`'s checks, noting nothing: whom the link's voice is for, and what was said under it today. */
  #voiceOnLink(
    secretMark: string,
    account: string,
    now: string
  ): LinkAnswer<{ who: string; said: number }> {
    const found = this.#onLink(secretMark, { account }, now, "save");
    if (!found.ok) {
      return found;
    }
    const { person } = found.value;
    // The interviewer's voice reads what this is before they agree to take
    // part, so it doesn't wait for that; once they withdrew it says nothing.
    if (this.#withdrawnAt(person.id) !== null) {
      return refused("interview.withdrawn");
    }
    const who = `${linkWho}${person.id}`;
    return answered({ who, said: this.voiceSaid(who, now) });
  }

  /**
   * The seconds of voice said for the admin `who` today, noting the line
   * asked for, by its cache key (`stored`), as it is (`#noteSpoken`).
   */
  speechForAdmin(who: string, stored: string, budget: number): number {
    const said = this.voiceSaid(who);
    this.#noteSpoken(who, stored, said < budget);
    return said;
  }

  /**
   * Notes that the voice was asked to say, for `who`, the text whose cache
   * key is `stored` (speech-cache.ts `storedKeyOf`: a hash, never the
   * words): what erasing anything of theirs takes out of the cache, as
   * said, a sentence or a story at a time (GRA-1897). Only for a line
   * that may be said (`sayable`): one past the day's budget is said only
   * from the cache, where a line said before, and noted then, is kept.
   */
  #noteSpoken(who: string, stored: string, sayable: boolean): void {
    if (sayable) {
      this.#db
        .insert(spokenKeys)
        .values({ who, key: stored })
        .onConflictDoNothing()
        .run();
    }
  }

  /**
   * Whether the line `stored` is still noted as said for `who`: false once
   * something of theirs was erased since it was asked for, so a line the
   * voice said meanwhile is taken out again (speech.ts).
   */
  stillNoted(who: string, stored: string): boolean {
    return (
      this.#db
        .select({ key: spokenKeys.key })
        .from(spokenKeys)
        .where(and(eq(spokenKeys.who, who), eq(spokenKeys.key, stored)))
        .all().length > 0
    );
  }

  /**
   * Takes everything the voice said for the admin `user` out of the cache,
   * as erasing them as a person does (person-erasure.ts). Otherwise their
   * notes are bounded by their voice budget (an hour of new speech a
   * day) and go with the kickoff's deletion.
   */
  async forgetSpokenForAdmin(user: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.#queueSpokenBy(eq(spokenKeys.who, `${adminWho}${user}`));
    });
    await this.forgetLinesNow();
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
   * Whom a live transcription on someone's link is for, for the account
   * it belongs to, while their interview may be saved, as a line said is
   * (`speechOnLink`): the key what is heard is counted under, the seconds
   * heard under it today, and the person, for the onboarding's own log.
   */
  transcriptionOnLink(
    secretMark: string,
    account: string,
    now: string = new Date().toISOString()
  ): LinkAnswer<{ who: string; heard: number; person: string }> {
    const found = this.#voiceOnLink(secretMark, account, now);
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
    account: string,
    now: string = new Date().toISOString()
  ): LinkAnswer<null> {
    const found = this.#onLink(secretMark, { account }, now, "save", false);
    if (!found.ok) {
      return found;
    }
    const { person } = found.value;
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
   * person. The turn checked the link and the account first
   * (`turnContext`).
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
        document: kept.id,
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
      this.#changed(by, "onboarding.document.answered", { document: id });
    });
    this.#deliverAudit();
    return documentOf({ ...row, answer });
  }

  /**
   * Forgets shared documents' readings for good, as removing them does
   * (documents.ts): each reading,
   * its question and the admin's answer, so neither Stephen's context nor
   * the brain's sources and tools (brain-rpc.ts) show them again; every
   * drawing made since the first of them was shared, which may have had
   * it for context, to be drawn again without it; and every drawing the
   * Brain and its page were given since, each of which is given again once
   * drawn again. Those are out of use in the Brain first (`#fallenFirst`):
   * when that fails, nothing here has changed, and removing them again
   * finds the readings still here. In the audit log by counts alone. Within
   * `#withBrain`, so no intake lands between; answered 0 at once, without
   * waiting for one, when none of `ids` is a shared document's. With
   * `sharedBy`, only the documents that person shared: their file's
   * upload deleted (brain-uploads.ts). Returns how many readings it
   * forgot.
   */
  async forgetDocuments(
    ids: readonly string[],
    by: AuditActor,
    sharedBy?: string
  ): Promise<number> {
    if (this.#documentsAmong(ids, sharedBy).length === 0) {
      return 0;
    }
    return await this.#withBrain(async () => {
      const rows = this.#documentsAmong(ids, sharedBy);
      const [first] = rows.map(({ at }) => at).toSorted();
      if (first === undefined) {
        return 0;
      }
      // Every drawing given since, to be given again once drawn again: out
      // of use in the Brain before the readings go (`#fallenFirst`).
      const given = this.#db
        .select({ record: brainDrawings.record, team: brainDrawings.team })
        .from(brainDrawings)
        .where(gte(brainDrawings.at, first))
        .all();
      const purged = [...new Set(given.map(({ record }) => record))];
      const now = new Date().toISOString();
      await this.#fallenFirst(() => {
        this.ctx.storage.transactionSync(() => {
          // Each standing, and each marked that this object hasn't seen
          // taken out (a removal that failed, a restart): it may be in use
          // still, so it is taken out before the reading goes.
          const inUse = this.#db
            .select({
              source: brainDrawings.source,
              erase: brainDrawings.erase,
            })
            .from(brainDrawings)
            .where(gte(brainDrawings.at, first))
            .all()
            .flatMap(({ source, erase }) => {
              const fallen = { producer: "drawing" as const, id: source };
              return this.#mayBeInUse(fallen, erase) ? [fallen] : [];
            });
          if (inUse.length > 0) {
            throw new SourcesFallError(inUse);
          }
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
          this.#db
            .delete(brainSent)
            .where(inList(brainSent.record, purged))
            .run();
          for (const team of new Set(given.map(({ team: of }) => of))) {
            this.#brainDue(team, now);
          }
          this.#changed(by, "onboarding.document.purged", {
            documents: rows.length,
            drawings: forgotten.length,
            records: purged.length,
          });
        });
      });
      this.#deliverAudit();
      await this.#armDrawing();
      return rows.length;
    });
  }

  /** Which of `ids` are shared documents, of `sharedBy` when given, and when each was shared. */
  #documentsAmong(
    ids: readonly string[],
    sharedBy: string | undefined
  ): { id: string; at: string }[] {
    return this.#db
      .select({ id: documents.id, at: documents.at })
      .from(documents)
      .where(
        and(
          inList(documents.id, ids),
          sharedBy === undefined
            ? undefined
            : inList(documents.by, [
                whoIs({ type: "person", userId: sharedBy }),
                whoIs({ type: "staff", userId: sharedBy }),
              ])
        )
      )
      .all();
  }

  /** The shared documents' ids: what a drawing has for context as it starts. */
  #sharedIds(): string[] {
    return this.#db
      .select({ id: documents.id })
      .from(documents)
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
   * When the kickoff the brain names as a source came in. Null when there
   * is none.
   */
  kickoffSourceAt(): string | null {
    const [row] = this.#db.select({ at: kickoff.at }).from(kickoff).all();
    return row?.at ?? null;
  }

  /**
   * The kickoff's id in the new Brain (`kickoff:<id>`, onboarding/
   * new-brain.ts): one a kickoff, from how often one was deleted
   * (`purgeMark`), so a kickoff brought in after a delete is a source of
   * its own, never under the key that delete's erasure closed.
   */
  kickoffBrainId(): string {
    return `company-${this.purgeMark()}`;
  }

  /** What every member reads of the kickoff (kickoff-company.ts); null before it is in. */
  companyKickoff(): CompanyKickoff | null {
    return companyKickoffOf(this.kickoff());
  }

  /**
   * The kickoff `id` as the hand-over gives the new Brain now: its text
   * for every member as it stands (kickoff-company.ts), under the count of
   * changes so far (`kickoffChangesKey`). Changes since the last hand-over
   * are in this one text, one version. Null when `id` is not the kickoff
   * kept now (deleted since).
   */
  kickoffToHand(id: string): { change: string; text: string } | null {
    const company = this.companyKickoff();
    if (company === null || id !== this.kickoffBrainId()) {
      return null;
    }
    const text = companyKickoffText(company);
    const changes = this.ctx.storage.kv.get(kickoffChangesKey);
    return { change: String(typeof changes === "number" ? changes : 0), text };
  }

  /**
   * In the transaction of a change of the kickoff (a save or an answer):
   * counts it (`kickoffChangesKey`) and notes the kickoff for the
   * hand-over, which reads its text here when it runs (`kickoffToHand`).
   * A noting replaces one not yet handed over, and a hand-over that ends
   * removes only its own noting, so a change after its read is handed
   * over again.
   */
  #kickoffChanged(): void {
    const changes = this.ctx.storage.kv.get(kickoffChangesKey);
    this.ctx.storage.kv.put(
      kickoffChangesKey,
      (typeof changes === "number" ? changes : 0) + 1
    );
    this.#noteHandOver("kickoff", this.kickoffBrainId());
  }

  /**
   * The company's teams as the admin confirmed them (GRA-1748): each team
   * taking part, its name, the admin's own description and how many
   * people the roster has in it, in the admin's order. Only what the admin
   * gave: never what a lead's map says a team does (`mappedDoes`, from
   * their own interview), who is in a team, their titles or its lead;
   * never a team switched off, nor a team or person still waiting for the
   * admin to confirm the organization.
   */
  #confirmedTeams(): CompanyTeam[] {
    const roster = this.#roster();
    const waiting = this.#unconfirmed();
    const confirmed = (roster?.people ?? []).filter(
      ({ id }) => !waiting.people.has(id)
    );
    return (roster?.teams ?? [])
      .filter(({ id, off }) => !off && !waiting.teams.has(id))
      .map(({ id, name, does }) => ({
        id,
        name,
        does,
        people: confirmed.filter(({ team }) => team === id).length,
      }));
  }

  /**
   * The company's teams as every member reads them (GRA-1748): as the admin
   * last confirmed them (`rosterConfirmedKey`), and when. Null before any
   * confirmed save.
   */
  companyTeams(): z.infer<typeof rosterConfirmedSchema> | null {
    const held = this.ctx.storage.kv.get(rosterConfirmedKey);
    return held === undefined ? null : rosterConfirmedSchema.parse(held);
  }

  /**
   * The roster as Grasp's staff read it: what each team does as its lead's
   * map drew it, where it did (`mappedDoes`), else as the admin described
   * it. Staff's alone (admin-snapshot.ts); never a member's, never the
   * Brain's (GRA-1748).
   */
  rosterAsMapped(): Roster | null {
    const roster = this.#roster();
    if (roster === null) {
      return null;
    }
    const mapped = new Map(
      this.#db
        .select({ id: teams.id, mappedDoes: teams.mappedDoes })
        .from(teams)
        .all()
        .flatMap(({ id, mappedDoes }) =>
          mappedDoes === null ? [] : [[id, mappedDoes] as const]
        )
    );
    return {
      ...roster,
      teams: roster.teams.map((team) => ({
        ...team,
        does: mapped.get(team.id) ?? team.does,
      })),
    };
  }

  /** The company's teams' id in the new Brain now: `teams-<erases>` (`rosterErasesKey`). */
  rosterBrainId(): string {
    const erases = this.ctx.storage.kv.get(rosterErasesKey);
    return `teams-${typeof erases === "number" ? erases : 0}`;
  }

  /** What the new Brain was last given of the company's teams (`rosterHandedKey`); null before any, or since the admin erased it. */
  #rosterHanded(): z.infer<typeof rosterHandedSchema> | null {
    const held = this.ctx.storage.kv.get(rosterHandedKey);
    return held === undefined ? null : rosterHandedSchema.parse(held);
  }

  /**
   * The company's teams as the hand-over gives the new Brain now: as the
   * admin last confirmed them, under the key of that change, so confirmed
   * changes since the last hand-over are one version. Null for any
   * id but the one they were given under, or once the admin erased them.
   */
  rosterToHand(id: string): { change: string; text: string } | null {
    const handed = this.#rosterHanded();
    return handed === null || id !== handed.id
      ? null
      : { change: String(handed.change), text: handed.text };
  }

  /**
   * In the transaction of a save the admin confirmed: the company's teams
   * as they stand now (`#confirmedTeams`), kept as what every member reads
   * (`companyTeams`) and, when their text differs from what the Brain was
   * last given, given to it under its id now, noted for the hand-over,
   * which reads them when it runs (`rosterToHand`). The same text changes
   * nothing in the Brain and notes nothing: no version, and no event in
   * the audit log. No team taking part is given only once the Brain holds
   * teams, as a version saying so, so it never keeps listing them.
   */
  #rosterConfirmed(at: string): void {
    const confirmed = this.#confirmedTeams();
    this.ctx.storage.kv.put(rosterConfirmedKey, { at, teams: confirmed });
    const before = this.#rosterHanded();
    if (confirmed.length === 0 && before === null) {
      return;
    }
    const text = companyTeamsText(confirmed);
    if (text === before?.text) {
      return;
    }
    const id = this.rosterBrainId();
    this.ctx.storage.kv.put(rosterHandedKey, {
      id,
      change: (before?.change ?? 0) + 1,
      text,
    });
    this.#noteHandOver("roster", id);
  }

  /**
   * The admin erases the company's teams from the Brain (GRA-1748): every
   * version, through the Brain's ledger, owed from this transaction
   * (`rosterErasuresOwed`) until core's erasure of it returned
   * (onboarding/new-brain.ts `eraseOwedRosters`). What members read of
   * them on the Brain page goes in the same transaction; the roster itself
   * stays as it is. The next confirmed save gives both the teams afresh,
   * the Brain under a new id
   * (`rosterBrainId`). One audit event, never a word of them. False, with
   * nothing recorded, when the Brain was given nothing of them.
   */
  eraseTeamsFromBrain(by: AuditActor): boolean {
    const handed = this.#rosterHanded();
    if (handed === null) {
      return false;
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put(`${rosterErasurePrefix}${handed.id}`, true);
      const erases = this.ctx.storage.kv.get(rosterErasesKey);
      this.ctx.storage.kv.put(
        rosterErasesKey,
        (typeof erases === "number" ? erases : 0) + 1
      );
      this.ctx.storage.kv.delete(rosterHandedKey);
      this.ctx.storage.kv.delete(rosterConfirmedKey);
      this.#changed(by, "onboarding.roster.brain_erased", {});
    });
    this.#deliverAudit();
    return true;
  }

  /** The ids of the company's teams the admin erased that the Brain may still hold (`rosterErasurePrefix`). */
  rosterErasuresOwed(): string[] {
    return [...this.ctx.storage.kv.list({ prefix: rosterErasurePrefix })].map(
      ([key]) => key.slice(rosterErasurePrefix.length)
    );
  }

  /** Notes that core erased the company's teams `id` from the new Brain: nothing of them is owed. */
  rosterErased(id: string): void {
    this.ctx.storage.kv.delete(`${rosterErasurePrefix}${id}`);
  }

  /** Whether the Brain holds the company's teams, or they are still being erased from it. */
  #teamsInBrain(): OnboardingView["teamsInBrain"] {
    if (this.rosterErasuresOwed().length > 0) {
      return "erasing";
    }
    return this.#rosterHanded() === null ? null : "in";
  }

  /** The ids of the deleted kickoffs whose source the new Brain still holds (`kickoffErasurePrefix`). */
  kickoffErasuresOwed(): string[] {
    return [...this.ctx.storage.kv.list({ prefix: kickoffErasurePrefix })].map(
      ([key]) => key.slice(kickoffErasurePrefix.length)
    );
  }

  /** Notes that core erased the deleted kickoff `id` from the new Brain: nothing of it is owed. */
  kickoffErased(id: string): void {
    this.ctx.storage.kv.delete(`${kickoffErasurePrefix}${id}`);
  }

  /** Notes that the kickoff was deleted from what the onboarding holds (`purgesKey`). */
  #purged(): void {
    this.ctx.storage.kv.put(purgesKey, this.purgeMark() + 1);
  }

  /**
   * How often the kickoff was deleted (`purgesKey`): what a save of the kickoff, or a drawing, takes as it
   * begins reading, and must still find as it keeps what it made.
   */
  purgeMark(): number {
    const held = this.ctx.storage.kv.get(purgesKey);
    return typeof held === "number" ? held : 0;
  }

  /**
   * Keeps the kickoff's transcript and its reading, replacing any before
   * them; the sponsor's answers stay, for they answer the company, not one
   * transcript. What every member reads of it goes to the new Brain at the
   * next hand-over, as a version of the kickoff's source
   * (`#kickoffChanged`). A save whose
   * reading began before the kickoff was deleted (`mark`, `purgeMark` as
   * it began) is refused, `kickoff.purged`, so the erased words never come
   * back with it. In the log and the audit log without its words.
   */
  saveKickoff(
    kept: {
      transcript: string;
      fileName: string | null;
      reading: KickoffReading;
    },
    by: AuditActor,
    mark: number
  ): KickoffView {
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
      this.#kickoffChanged();
    });
    this.#deliverAudit();
    return this.kickoff();
  }

  /**
   * The admin deletes the kickoff for good (GRA-1897): its transcript,
   * its file's name, its reading and the sponsor's answers. Whatever reads
   * it reads nothing of it from then on: the admin's onboarding, Stephen's
   * setup, every interview turn's brief and the Brain page. Its source in
   * the new Brain is owed an erasure in the same transaction
   * (`kickoffErasuresOwed`), which core does right after and on its clock
   * until done (onboarding/new-brain.ts `eraseOwedKickoffs`); the purge
   * mark moves on, so a staff save whose reading began before is refused
   * (`saveKickoff`), and a kickoff brought in later is a source of its own
   * (`kickoffBrainId`). One audit event, never a word of it. Asked again
   * with nothing left, it changes nothing and records nothing. Whether
   * there was anything to delete.
   */
  async deleteKickoff(by: AuditActor): Promise<boolean> {
    const [row] = this.#db.select({ id: kickoff.id }).from(kickoff).all();
    if (row === undefined) {
      return false;
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put(
        `${kickoffErasurePrefix}${this.kickoffBrainId()}`,
        true
      );
      this.#purged();
      this.#db.delete(kickoff).run();
      // What the voice said on the admins' onboarding may have quoted it
      // (the sponsor, what the company does): all of it goes from the
      // cache, said anew when asked.
      this.#queueSpokenBy(like(spokenKeys.who, `${adminWho}%`));
      this.#changed(by, "onboarding.kickoff.deleted", {});
    });
    this.#deliverAudit();
    // Whatever the cache doesn't take now waits for the alarm.
    await this.forgetLinesNow();
    return true;
  }

  /**
   * Keeps the sponsor's answer to what the kickoff left open about
   * `field`; an empty one takes it back. An answer about the vision, what
   * every member reads of the kickoff, goes to the new Brain at the
   * next hand-over (`#kickoffChanged`). False before
   * the kickoff is in, or after its delete: there is nothing to answer.
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
      // Only the vision's answers are what every member reads of it.
      if (isVisionShared(field)) {
        this.#kickoffChanged();
      }
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
   * Closes `person`'s link for good and deletes their interview, in one
   * transaction, as core asks as it erases `account` (person-erasure.ts),
   * but only while the link was sent by `sentBy`, isn't closed yet, and is
   * held by `account` or by no account: checked by the same statement that
   * closes it, so the next holder's link, after a new start, is never
   * closed for someone else, and an erasure that finds the same link twice
   * (by the account, then by the address) deletes it once. Its code goes,
   * so it answers `interview.link_invalid`, it is marked erased, so no code
   * is made for it again, and the account it belonged to and the address
   * it went to are forgotten. Unlike a delete on their own request, no new
   * interview can be saved under it. What they were asked about goes too
   * (a referral naming them may have set it, `#referOne`): nobody asks them
   * anything again. Their entry on the list stays, an admin's to remove;
   * taken off the list, the mark goes with the link. Whether it did.
   */
  #closeAndDeleteHeldBy(
    person: string,
    account: string,
    sentBy: string,
    now: string
  ): boolean {
    return this.ctx.storage.transactionSync(() => {
      const [link] = this.#db
        .update(links)
        .set({
          // Their account and their address go: their interview leaves
          // the new Brain (`owedErasures`), and nobody opens it again.
          account: null,
          sentTo: null,
          erasedAt: now,
        })
        .where(
          and(
            eq(links.person, person),
            lte(links.sentAt, sentBy),
            isNull(links.erasedAt),
            or(isNull(links.account), eq(links.account, account))
          )
        )
        .returning({ person: links.person })
        .all();
      if (link === undefined) {
        return false;
      }
      this.#db.delete(linkCodes).where(eq(linkCodes.person, person)).run();
      this.#db.delete(askedAbout).where(eq(askedAbout.person, person)).run();
      // Mail still to go about them (a reminder, say) goes nowhere now.
      // Sent mail stays: the company's record, as the roster is.
      dropMailAbout(this.ctx.storage.sql, person);
      this.#deleteRows(person, { type: "system" }, now);
      return true;
    });
  }

  /**
   * Moves the interview that belongs to `from` to `to`: as `from` turned out
   * to be the member the directory made (`to`), at their first sign-in once
   * the gate opened (auth.ts `adoptDirectoryMember`), while their interview
   * was opened under the account their sign-in made before. Its copy in the
   * new Brain is replaced under `to` (`#decideInterview`: the mark names the
   * account), erased under `from` by core's clock. Nothing when `from` holds
   * none, or `to` holds one already.
   */
  accountMoved(from: string, to: string): void {
    this.ctx.storage.transactionSync(() => {
      const [held] = this.#db
        .select({ person: links.person })
        .from(links)
        .where(eq(links.account, to))
        .all();
      if (held !== undefined) {
        return;
      }
      this.#db
        .update(links)
        .set({ account: to })
        .where(eq(links.account, from))
        .run();
    });
    this.#decideInterviews();
  }

  /**
   * Whose interview belongs to `account` now (`links.account`, GRA-1790):
   * for core's erasure of that account, which finds it so whatever address
   * the list has for them now. Null when none does. What the Brain still
   * holds under the account, from a link it no longer holds, is erased by
   * the account (`owedErasures` with `account`), never through this.
   */
  personOfAccount(account: string): string | null {
    const [link] = this.#db
      .select({ person: links.person })
      .from(links)
      .where(eq(links.account, account))
      .all();
    return link?.person ?? null;
  }

  /**
   * Deletes `person`'s interview and closes their link for good, as core
   * asks as it erases `account` (person-erasure.ts), but only a link that
   * went out by `sentBy`, when the erasure was asked for (one sent after
   * it went to someone the address was released to, whose interview
   * stays), and that `account` or no account holds (after a new start,
   * the next holder's interview stays: `#closeAndDeleteHeldBy`). Whether it
   * deleted one.
   */
  async eraseInterviewOf(
    person: string,
    account: string,
    sentBy: string
  ): Promise<boolean> {
    return await this.#fallenFirst(
      async () => await this.#eraseInterviewOfOnce(person, account, sentBy)
    );
  }

  /** `eraseInterviewOf`, once: made again by `#fallenFirst` while claims fall. */
  async #eraseInterviewOfOnce(
    person: string,
    account: string,
    sentBy: string
  ): Promise<boolean> {
    // Their link answers nothing any more and what they said is gone,
    // before anything waits: no new interview is saved under the entry
    // that stays, even while the Brain's and the voice's cleanup follow.
    if (
      !this.#closeAndDeleteHeldBy(
        person,
        account,
        sentBy,
        new Date().toISOString()
      )
    ) {
      return false;
    }
    this.#deliverAudit();
    await this.#afterForget();
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
   * link opens a new one for the account it belongs to. False when no link of
   * theirs went out. The audit log has that staff did, not for whom.
   */
  async deleteOnRequest(
    person: string,
    by: AuditActor,
    now: string = new Date().toISOString()
  ): Promise<boolean> {
    return await this.#fallenFirst(
      async () => await this.#deleteOnRequestOnce(person, by, now)
    );
  }

  /** `deleteOnRequest`, once: made again by `#fallenFirst` while claims fall. */
  async #deleteOnRequestOnce(
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
    this.ctx.storage.transactionSync(() => {
      this.#deleteRows(person, by, now);
    });
    this.#deliverAudit();
    await this.#afterForget();
    return true;
  }

  /**
   * Deletes `person`'s interview, in the caller's transaction, as `by`
   * asked (`deleteOnRequest`, and core's erasure, `#closeAndDeleteHeldBy`):
   * what they said goes, a copy left open can't save it back (the link's
   * version moves on), and the audit log has that it was done, not for
   * whom.
   */
  #deleteRows(person: string, by: AuditActor, now: string): void {
    this.#forget(person, now, "interview.deleted", whoIs(by));
    this.#db
      .update(links)
      .set({ deletedAt: now, version: sql`${links.version} + 1` })
      .where(eq(links.person, person))
      .run();
    this.#changed(by, "onboarding.interview.deleted", {});
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
      | "sentTo"
      | "brainMark"
      | "savedByPage"
      | "savedPageSave"
      | "savedVersion"
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
      this.#forgetFallen();
      await this.forgetLinesNow();
      try {
        await this.eraseTakenOutAfterClose();
      } catch (error) {
        log.error("onboarding.taken_out_unerased", {
          error: error instanceof Error ? error.name : "unknown",
        });
        await this.#alarmBy(Date.now() + purgeRetryMs);
      }
      await this.#drainAudit();
      await this.releaseDue();
      // A team's map opens its links.
      if ((await this.drawNext()) !== null) {
        await this.releaseDue();
      }
      await this.intakeNext();
      await this.opinionsNext();
      await this.remindDue();
      await this.sendUpdate();
      await this.deliverMail();
    } finally {
      // Set again whatever failed above, so what is left is tried again.
      await this.#armLinks();
      await this.#armDrawing();
      await this.#armOpinions();
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
    // A link and a reminder both carry the link: until an account opened
    // it, the one whose address this is opens it (`#holds`).
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
    // Paused or not, links waiting or not: the erasure at the close runs.
    await this.#armErasure();
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
   * Sets the alarm for the erasure at the close (`eraseTakenOutAfterClose`)
   * while any interview kept still holds a statement taken out with its
   * words: for the start of the day after the close, or, past it, a
   * moment from now, so a run that failed or skipped one is tried again.
   * Nothing taken out left, nothing is set.
   */
  async #armErasure(): Promise<void> {
    const { plan } = this.#row();
    if (plan === null || !this.#anyTakenOut()) {
      return;
    }
    const closed = Date.parse(`${addDays(closesOn(plan), 1)}T00:00:00.000Z`);
    await this.#alarmBy(Math.max(closed, Date.now() + purgeRetryMs));
  }

  /** Whether any interview kept holds a statement taken out, with its words. */
  #anyTakenOut(): boolean {
    // Only those that hold one taken out at all are read.
    return this.#db
      .select({ person: interviews.person })
      .from(interviews)
      .where(sql`instr(${interviews.progress}, '"out":true') > 0`)
      .all()
      .some(({ person }) => {
        const held = this.#storedProgress(person);
        return held !== null && takenOut(held).length > 0;
      });
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
    const teamOf = new Map(roster.people.map(({ id, team }) => [id, team]));
    const stands = new Map<string, boolean>();
    const standing = (team: string): boolean => {
      const known = stands.get(team);
      if (known !== undefined) {
        return known;
      }
      const backed = this.#mapBacked(team);
      stands.set(team, backed);
      return backed;
    };
    const due = this.#db
      .select()
      .from(works)
      .all()
      .flatMap((row): (WorkToDraw & { since: string })[] => {
        const team = teamsOn.get(row.team);
        // A piece of a map that no longer stands is drawn from nobody
        // until the map is drawn again (GRA-1987).
        if (team === undefined || !standing(row.team)) {
          return [];
        }
        const doers = doersOf(row.doers);
        const told = agreedAbout(row, doers, asked, teamOf, (id) =>
          agreedAt.get(id)
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
        // Someone it was drawn from who no longer counts for it (moved to
        // another team): drawn again without them.
        const left = Object.keys(before).some((id) => !(id in agreed));
        const [first = left ? "" : undefined] = since;
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
      // a document it had for context removed meanwhile; or the kickoff
      // deleted (`purgeMark`): drawn again without it, as the work is
      // still due.
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
    const work = this.#worksStanding(due.team).find(({ id }) => id === due.id);
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
    const teamOf = new Map(roster.people.map(({ id, team }) => [id, team]));
    const asked = this.#db.select().from(askedAbout).all();
    const found: { work: string; name: string; drawn: DrawnWork }[] = [];
    for (const row of this.#db.select().from(works).all()) {
      const doers = doersOf(row.doers);
      const agreed = Object.fromEntries(
        agreedAbout(
          row,
          doers,
          asked,
          teamOf,
          (id) => this.#agreedAt(id) ?? undefined
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
   * interview went, or went and began anew) or the kickoff was deleted
   * since (`purges`, `purgeMark` as it began): then it keeps nothing.
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
    this.#armSoon();
  }

  /**
   * Arms the alarm that draws and gives teams to the brain
   * (`#armDrawing`), once the change that asked for it is done: its
   * transaction committed (or rolled back, which leaves nothing new to
   * arm for). Whatever marks a team due asks it (`#brainDue`), so no
   * caller can leave due work with no alarm to do it, as after the
   * onboarding closed and every link went out. Asked again before it ran,
   * it arms once.
   */
  #armSoon(): void {
    if (this.#arming) {
      return;
    }
    this.#arming = true;
    this.ctx.waitUntil(
      (async () => {
        await Promise.resolve();
        this.#arming = false;
        await this.#armDrawing();
        await this.#armOpinions();
      })()
    );
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
   * from the lead alone. None while the team may not have its results
   * shown (`#teamShowsResults`: under seven who tell, switched off, or
   * waiting for the admin): nothing it could note would stand, so no
   * model is asked. It waits until a change makes the team due again.
   */
  #teamIntake(teamId: string): TeamIntake | null {
    const roster = this.#roster();
    const team = roster?.teams.find(({ id }) => id === teamId);
    if (
      roster === null ||
      team === undefined ||
      !this.#teamShowsResults(teamId, { roster })
    ) {
      return null;
    }
    const tellers = this.#tellers(teamId, roster);
    const { lead } = team;
    const leadAgreed =
      lead !== null && this.#agreedAt(lead) !== null ? [lead] : [];
    // The pieces of work are the lead's map: none reach the brain while
    // what it was drawn from no longer counts (`#mapBacked`).
    const mapped = this.#worksStanding(teamId);
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
  #tellers(
    teamId: string,
    /** The list as read once for many teams (a recount), else read here. */
    roster: Roster | null = this.#roster()
  ): { person: string; facts: DrawInput["facts"] }[] {
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
  /**
   * A team's pieces of work, as anyone but Grasp's staff may meet them: an
   * interview asked about one, a drawing, the review, the team's results.
   * None while its map no longer stands on what its lead shares (GRA-1987,
   * `#mapBacked`): a map is drawn from the lead's shared lines alone, so
   * one drawn before a line it came from stopped counting as shared, or
   * from lines with no destination, names nothing until drawn again.
   */
  #worksStanding(teamId: string): TeamWork[] {
    return this.#mapBacked(teamId) ? this.teamWorks(teamId) : [];
  }

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
   * Notes what a team learned, as it was due at `dueAt` (brain-intake.ts):
   * its claims and the drawings of its work, which the onboarding keeps
   * and hands the new Brain itself (GRA-1748), and who each rests on, here
   * alone. Noting the same again adds nothing.
   */
  async #intakeTeam(teamId: string, dueAt: string, at: string): Promise<void> {
    const intake = this.#teamIntake(teamId);
    if (intake === null || this.rosterSavedAt() === null) {
      this.#brainSettled(teamId, dueAt);
      return;
    }
    // Who it may rest on, as their interviews stand now, before anything
    // is awaited: whatever happens to them meanwhile is seen at the end.
    // Only those whose interview counts now: nothing of anyone else is in
    // it, so someone who hasn't agreed (or whose interview went before it
    // began) is never one who went meanwhile, which would keep the team's
    // claims and drawings from ever being noted while anyone on the list
    // hasn't agreed. One who agrees meanwhile makes the team due again.
    const began = new Map(
      [
        ...this.#interviewsOf(this.#roster()?.people.map(({ id }) => id) ?? []),
      ].filter(([, held]) => held !== null)
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
    const {
      claims: made,
      drawings,
      rests,
    } = await intakeOf(intake, claims, supports);
    // The team's claims and drawings are these now: any noted before that
    // isn't one of them goes, so no earlier one outlives what it was put
    // together from (only the drawing checked now is the team's, GRA-1084,
    // never one drawn before with fewer than five behind a part of it),
    // found where it is noted whom each rests on. Read before anything is
    // written.
    const current = new Set([
      ...made.map(({ record }) => record),
      ...drawings.map(({ record }) => record),
    ]);
    const noted = this.#db
      .select({ record: brainSent.record, type: brainSent.type })
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
        noted
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
    // A claim or drawing of the team the new backing leaves standing no
    // more, or a team it leaves under seven, is out of use in the Brain
    // before this transaction commits (`#recountStanding`): made again
    // then, from what the intake gave, its model never asked twice.
    const gone = await this.#fallenFirst(() =>
      this.ctx.storage.transactionSync(() => {
        // One rule for whom a record rests on (GRA-1084): someone counts
        // only while what they approved is still exactly what the claims
        // and drawings were made from, read in this transaction against
        // when the intake began (`#goneSince`). Anyone whose approval
        // changed since is noted as gone (`gonePrefix`), and the team stays
        // due for another intake.
        const since = new Set(this.#goneSince(began));
        // A claim rests on exactly the people behind it now, and on nobody
        // else: whoever it rested on before, gone marks included, is
        // replaced. Someone who took back their part while this intake ran
        // was marked gone on it as their take-back committed; kept here, the
        // mark would stand beside five who back it now, a claim that still
        // stands, and never be forgotten (`#forgetFallen` forgets only
        // what falls). Who went while it ran is marked again below.
        this.#db
          .delete(brainSent)
          .where(inList(brainSent.record, claimed))
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
        // Each earlier claim or drawing rests on nobody left, and is
        // forgotten here (`#forgetFallen`).
        for (const { record, type } of stale) {
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
            })
            .onConflictDoNothing()
            .run();
        }
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
              .onConflictDoUpdate({
                target: checkedDifferences.work,
                set: shown,
              })
              .run();
          } else {
            this.#db
              .delete(checkedDifferences)
              .where(eq(checkedDifferences.work, work.id))
              .run();
          }
        }
        // The team's claims (GRA-1741) and drawings (GRA-1748), for the new
        // Brain and the Brain page: only from an intake nobody it rests on
        // moved under, each standing as read. Otherwise the team stays
        // due, and the next intake notes them.
        if (since.size === 0) {
          const restingOn = (record: string): string[] =>
            rests.flatMap(({ record: of, person }) =>
              of === record ? [person] : []
            );
          this.#noteClaims(
            teamId,
            made.map((claim) => ({ ...claim, people: restingOn(claim.record) }))
          );
          this.#noteDrawings(
            teamId,
            drawings.map((drawing) => ({
              ...drawing,
              people: restingOn(drawing.record),
            }))
          );
        }
        // Whoever's interview went meanwhile no longer backs a claim of it.
        this.#recountStanding([teamId]);
        this.#brainSettled(teamId, dueAt);
        return since.size > 0 || stale.length > 0;
      })
    );
    // The claims it noted reach the hand-over with their events.
    this.#deliverAudit();
    // Someone it rests on deleted their interview while it ran, or a claim
    // or drawing it noted before isn't the team's now: whom it rested on
    // is forgotten at once.
    if (gone) {
      this.#forgetFallen();
    }
  }

  /**
   * Notes, in the caller's transaction, that `person`'s link was queued to
   * `email`: while no account opened it yet, that address alone opens it
   * (`#holds`). Once one did, a send changes nothing.
   */
  #linkWentTo(person: string, email: string): void {
    const address = foldedAddress(email);
    if (address === "") {
      return;
    }
    this.#db
      .update(links)
      .set({ sentTo: address })
      .where(and(eq(links.person, person), isNull(links.account)))
      .run();
  }

  /**
   * Whether someone signing in with `email`, which the company's sign-in
   * verified, may come in for their interview while the gate is closed
   * (auth.ts): a link that is out, not erased, may be opened under it
   * (`#holds`, by its address alone). Says nothing about whose.
   */
  interviewInvites(email: string): boolean {
    const address = foldedAddress(email);
    if (address === "") {
      return false;
    }
    const roster = this.#roster();
    const listed = new Map(
      (roster?.people ?? []).map(({ id, email: on }) => [id, foldedAddress(on)])
    );
    return this.#db
      .select({ person: links.person, sentTo: links.sentTo })
      .from(links)
      .where(isNull(links.erasedAt))
      .all()
      .some(
        ({ person, sentTo }) =>
          listed.has(person) && (sentTo ?? listed.get(person)) === address
      );
  }

  /**
   * People whose interview the new Brain may hold otherwise than the
   * store last decided: something it rests on moved (`interviewDueSql`),
   * or they left the list with a source of theirs still standing.
   */
  #interviewsDue(): string[] {
    return this.ctx.storage.sql
      .exec<{ person: string }>(
        `SELECT l.person AS person FROM links l
          WHERE (${interviewDueSql}) IS NOT l.brain_mark
        UNION
        SELECT b.person AS person FROM brain_interviews b
          WHERE b.erase = 0
            AND NOT EXISTS (SELECT 1 FROM links l WHERE l.person = b.person)`
      )
      .toArray()
      .map(({ person }) => person);
  }

  /** When `person`'s interview is to be decided again (`interviewDueSql`). */
  #interviewDue(person: string): string | null {
    const [row] = this.ctx.storage.sql
      .exec<{ due: string | null }>(
        `SELECT (${interviewDueSql}) AS due FROM links l WHERE l.person = ?`,
        person
      )
      .toArray();
    return row?.due ?? null;
  }

  /**
   * What the new Brain should hold of `person`'s interview now: the facts
   * they approved, readable by the account it belongs to, and its mark,
   * which names exactly that: the account and each approved fact at its
   * revision (`#admittedKeys`, a hash of what was read back and kept).
   * Null for nothing (no account, erased, withdrawn, or nothing approved).
   */
  #interviewWanted(
    person: string
  ): { account: string; text: string; mark: string } | null {
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
    if (text === "") {
      return null;
    }
    const approved = this.#admittedKeys(person).toSorted().join(",");
    return { account: link.account, text, mark: `${link.account}|${approved}` };
  }

  /**
   * Decides, in the caller's transaction, what the new Brain is to hold
   * of `person`'s interview, from one read of the store: a source stands
   * for one mark of it (`#interviewWanted`), so one made for another mark
   * is marked to be erased at once, and a new one is noted
   * (`brain_interviews`, under an id minted here) before core adds it
   * (`interviewsToAdd`). Its row stays until the Brain's erasure of it
   * returned, so the Brain never holds an interview the store doesn't know
   * of. A new one is noted in the onboarding's own log alone, which only
   * staff read: nothing of anyone's interview reaches the audit log the
   * company reads, not even that it is in their Brain (GRA-1790).
   */
  #decideInterview(person: string, now: string): void {
    const wanted = this.#interviewWanted(person);
    const rows = this.#db
      .select()
      .from(brainInterviews)
      .where(eq(brainInterviews.person, person))
      .all();
    const standing = rows.find(
      (row) =>
        !row.erase &&
        wanted !== null &&
        row.mark === wanted.mark &&
        row.account === wanted.account
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
    if (wanted !== null && standing === undefined) {
      this.#db
        .insert(brainInterviews)
        .values({
          source: crypto.randomUUID(),
          person,
          account: wanted.account,
          mark: wanted.mark,
        })
        .run();
      this.#noted(person, "interview.in_brain", now);
    }
    this.#db
      .update(links)
      .set({ brainMark: this.#interviewDue(person) })
      .where(eq(links.person, person))
      .run();
  }

  /**
   * Notes, in the caller's transaction, that the new Brain is to take the
   * team claim `source`: an audit event naming it, which the outbox's
   * drain notes as a hand-over (brain-hand-overs.ts), in the same
   * transaction as the row that says it stands. What it holds is read when
   * the hand-over runs (`claimToHand`), never here.
   */
  #noteClaimSource(source: string): void {
    this.#noteHandOver("claim", source);
  }

  /**
   * Notes `producer`'s source `id` for core's hand-over to the new Brain,
   * in the transaction of the change that moved it: an event in the
   * onboarding's log, and its audit event in the outbox, whose drain
   * notes the hand-over (brain-hand-overs.ts). Names the source by its id
   * alone; what it holds is read when the hand-over runs.
   */
  #noteHandOver(
    producer: "claim" | "drawing" | "kickoff" | "opinion" | "roster",
    id: string
  ): void {
    const at = new Date().toISOString();
    const {
      actions: [action],
      target: targetType,
    } = handOverProducers[producer];
    this.#db
      .insert(events)
      .values({ at, by: whoIs({ type: "system" }), what: action, about: null })
      .run();
    const event = createAuditEvent(
      {
        actor: { type: "system" },
        action,
        target: { type: targetType, id },
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
   * on the list, which `onboardingPeopleMax` bounds. Each new source waits
   * for core to add it (`interviewsToAdd`); each that no longer stands is
   * owed an erasure (`owedErasures`). Run after every change that may move
   * one, and from core's clock.
   */
  #decideInterviews(now: string = new Date().toISOString()): void {
    this.ctx.storage.transactionSync(() => {
      for (const person of this.#interviewsDue()) {
        this.#decideInterview(person, now);
      }
    });
  }

  /**
   * The interview sources core is to add to the new Brain now: each the
   * store decided stands and core hasn't added yet, with the account that
   * reads it and the text it stands for, as they are now; only `person`'s
   * when given (after a request of theirs). Core adds each with
   * `addSource` and says so (`addedToBrain`); a source that stops standing
   * meanwhile is owed an erasure, and the erasure closes its key, so an
   * add that lands after it is refused.
   */
  interviewsToAdd(
    person?: string
  ): { source: string; account: string; text: string }[] {
    this.#decideInterviews();
    const rows = this.#db
      .select()
      .from(brainInterviews)
      .where(
        and(
          eq(brainInterviews.erase, false),
          eq(brainInterviews.added, false),
          person === undefined ? undefined : eq(brainInterviews.person, person)
        )
      )
      .all();
    return rows.flatMap((row) => {
      const wanted = this.#interviewWanted(row.person);
      return wanted === null ||
        wanted.mark !== row.mark ||
        wanted.account !== row.account
        ? []
        : [{ source: row.source, account: row.account, text: wanted.text }];
    });
  }

  /** Notes that core added the interview `source` to the new Brain: it is not added again. */
  addedToBrain(source: string): void {
    this.ctx.storage.transactionSync(() => {
      this.#db
        .update(brainInterviews)
        .set({ added: true })
        .where(eq(brainInterviews.source, source))
        .run();
    });
  }

  /**
   * The team claims standing now (`standingClaim`), as every member reads
   * them on the Brain page (GRA-1748), by the rule the hand-over adds them
   * by (`claimToHand`). Each with its kind, its team and its words; never
   * who backs it.
   */
  standingClaims(): StandingClaim[] {
    return this.#db
      .select({
        source: brainClaims.source,
        team: brainClaims.team,
        kind: brainClaims.kind,
        text: brainClaims.text,
      })
      .from(brainClaims)
      .where(and(standingClaim, isNotNull(brainClaims.kind)))
      .all()
      .flatMap(({ source, team, kind, text }) =>
        kind === null ? [] : [{ source, team, kind, text }]
      );
  }

  /**
   * The company's opinions standing now (`standingOpinion`, GRA-1987), as
   * every member reads them on the Brain page, by the rule the hand-over
   * adds them by (`opinionToHand`): each with its kind and words, in the
   * order of its words, never by when, and never with a team or who or
   * how many back it.
   */
  standingOpinions(): StandingOpinion[] {
    return this.#db
      .select({
        source: brainOpinions.source,
        kind: brainOpinions.kind,
        text: brainOpinions.text,
        at: brainOpinions.at,
      })
      .from(brainOpinions)
      .where(standingOpinion)
      .orderBy(asc(brainOpinions.text), asc(brainOpinions.source))
      .all();
  }

  /**
   * The opinion `source` as the hand-over adds it now: its sentence, only
   * while it stands (`standingOpinion`). Null otherwise.
   */
  opinionToHand(source: string): { text: string } | null {
    const [row] = this.#db
      .select({ text: brainOpinions.text })
      .from(brainOpinions)
      .where(and(eq(brainOpinions.source, source), standingOpinion))
      .all();
    return row ?? null;
  }

  /**
   * The lines `person` left only counted anonymously that count now
   * (GRA-1987): approved, in an interview they agree to, not shared as
   * how their team works, and never a line only used to know whom to ask
   * (`onlyForAsking`, the one guard). As the record keeps them.
   */
  #anonymousLines(person: string, agreed: ReadonlySet<string>): string[] {
    const [state] = this.#db
      .select({ kind: interviewStates.kind })
      .from(interviewStates)
      .where(eq(interviewStates.person, person))
      .all();
    if (state === undefined || !agreed.has(person)) {
      return [];
    }
    return this.#admitted(person).flatMap((fact) =>
      fact.share === "team" || onlyForAsking(fact.tag, state.kind)
        ? []
        : [fact.record]
    );
  }

  /**
   * Who may back the company's opinions now, with their lines only
   * counted anonymously, by team: everyone on the list with such a line
   * that counts, in a team taking part (not switched off, not waiting for
   * the admin), leads too: a role says nothing in a company's opinion.
   * The one rule for the company's floor and for whom an opinion rests on.
   */
  #opinionTellers(
    roster: Roster | null = this.#roster()
  ): Map<string, { team: string; lines: string[] }> {
    if (roster === null) {
      return new Map();
    }
    const waiting = this.#unconfirmed().teams;
    const teamsTakingPart = new Set(
      roster.teams.flatMap(({ id, off }) =>
        off || waiting.has(id) ? [] : [id]
      )
    );
    const agreed = this.#agreedPeople();
    return new Map(
      roster.people.flatMap(({ id, team }) => {
        if (team === null || !teamsTakingPart.has(team)) {
          return [];
        }
        const lines = this.#anonymousLines(id, agreed);
        return lines.length === 0 ? [] : [[id, { team, lines }]];
      })
    );
  }

  /**
   * The company's opinions that no longer stand (`opinionStands`) and
   * may still be in use in the Brain, or that are owed their erasure and
   * this object hasn't seen taken out: what any recount takes out before
   * its change commits (`#recountStanding`). Opinions have no team, so
   * every recount asks.
   */
  #opinionsFalling(): FallingSource[] {
    const held = this.#db
      .select({
        source: brainOpinions.source,
        record: brainOpinions.record,
        erase: brainOpinions.erase,
      })
      .from(brainOpinions)
      .all();
    if (held.length === 0) {
      return [];
    }
    const standing = held.filter(({ erase }) => !erase);
    const tellers = standing.length === 0 ? new Map() : this.#opinionTellers();
    return held.flatMap(({ source, record, erase }) => {
      const id = { producer: "opinion" as const, id: source };
      if (erase) {
        return this.#mayBeInUse(id, erase) ? [id] : [];
      }
      const backers = this.#db
        .select({ person: opinionBackers.person })
        .from(opinionBackers)
        .where(eq(opinionBackers.record, record))
        .all()
        .map(({ person }) => person);
      return opinionStands(backers, tellers) ? [] : [id];
    });
  }

  /**
   * Marks the opinions `sources` to be erased, in the caller's
   * transaction (`#fallenFirst`), and forgets whom those still standing
   * rested on. Nothing is made due: the opinions are put together again
   * once five more people's lines change (`#opinionsRun`).
   */
  #opinionsFell(sources: readonly string[]): void {
    if (sources.length === 0) {
      return;
    }
    const fell = this.#db
      .select({ record: brainOpinions.record })
      .from(brainOpinions)
      .where(and(inList(brainOpinions.source, sources), standingOpinion))
      .all()
      .map(({ record }) => record);
    this.#db
      .delete(opinionBackers)
      .where(inList(opinionBackers.record, fell))
      .run();
    this.#db
      .update(brainOpinions)
      .set({ erase: true })
      .where(inList(brainOpinions.source, sources))
      .run();
  }

  /**
   * Forgets, in the caller's transaction, every candidate and opinion
   * `person` was behind: what they approved stopped counting, or they are
   * erased. The recount of the change then takes out what that leaves
   * under five (`#recountStanding`).
   */
  #forgetOpinionsOf(person: string): void {
    // Every hash taken over their lines goes too: the teams their
    // candidates were of, the team they are in, and the merge's. So the
    // next run puts those teams together anew, and their lines count as
    // changed (no `opinion_people` row): a line moved away and back, an
    // edit undone or a new start with the same lines backs again.
    const teamsOf = new Set(
      this.#db
        .select({ team: opinionCandidates.team })
        .from(opinionCandidates)
        .where(eq(opinionCandidates.person, person))
        .all()
        .map(({ team }) => team)
    );
    const now = this.#teamOfPerson(person);
    if (now !== null) {
      teamsOf.add(now);
    }
    this.#db
      .delete(opinionInputs)
      .where(
        inList(opinionInputs.key, [
          "merge",
          ...[...teamsOf].map((team) => `team:${team}`),
        ])
      )
      .run();
    this.#db
      .delete(opinionCandidates)
      .where(eq(opinionCandidates.person, person))
      .run();
    this.#db
      .delete(opinionBackers)
      .where(eq(opinionBackers.person, person))
      .run();
    this.#db
      .delete(opinionPeople)
      .where(eq(opinionPeople.person, person))
      .run();
  }

  /**
   * Forgets, in a transaction of its own, everything the company's
   * opinions are put together from: every candidate, every hash of what
   * a model was given, and of anyone's lines. While fewer than seven may
   * back an opinion none stands (the recount took them out), and nothing
   * taken over people's lines is kept for a merge that can't happen.
   */
  #opinionsBelowFloor(): void {
    this.ctx.storage.transactionSync(() => {
      this.#db.delete(opinionCandidates).run();
      this.#db.delete(opinionInputs).run();
      this.#db.delete(opinionPeople).run();
    });
  }

  /**
   * Who of `tellers` (`#opinionTellers`) has lines only counted
   * anonymously other than when the opinions were last put together from
   * them, each with a hash of their lines now (`linesMark`), and the run
   * under way, if any: each person it took in, with the hash it took.
   */
  async #opinionsState(
    tellers: ReadonlyMap<string, { team: string; lines: string[] }>
  ): Promise<{
    marks: Map<string, string>;
    changed: string[];
    run: Map<string, string>;
  }> {
    const marks = new Map<string, string>();
    for (const [person, { lines }] of tellers) {
      // oxlint-disable-next-line no-await-in-loop -- a hash each
      marks.set(person, await linesMark(person, lines));
    }
    const rows = this.#db.select().from(opinionPeople).all();
    const merged = new Map(rows.map((row) => [row.person, row.mergedFrom]));
    const run = new Map(
      rows.flatMap(({ person, runFrom }) =>
        runFrom === null ? [] : [[person, runFrom] as const]
      )
    );
    return {
      marks,
      changed: [...marks].flatMap(([person, mark]) =>
        merged.get(person) === mark ? [] : [person]
      ),
      run,
    };
  }

  /**
   * Sets the alarm for the company's opinions (GRA-1987) when a run is
   * under way, or five or more people's lines only counted anonymously
   * changed since they were last put together: the same five that protect
   * whom an opinion rests on, so whatever tips one to standing hides among
   * five people's changes. While the company has fewer than seven who may
   * back one, nothing is armed and nothing is kept (`#opinionsBelowFloor`).
   */
  async #armOpinions(): Promise<void> {
    const tellers = this.#opinionTellers();
    if (!companyMayHaveOpinions(tellers.size)) {
      this.#opinionsBelowFloor();
      return;
    }
    const { changed, run } = await this.#opinionsState(tellers);
    if (run.size === 0 && changed.length < opinionBackersMin) {
      return;
    }
    const [failed] = this.#db
      .select()
      .from(drawFailures)
      .where(eq(drawFailures.item, opinionsItem))
      .all();
    const after = failed === undefined ? 0 : Date.parse(failed.after);
    await this.#alarmBy(Math.max(after, Date.now() + drawNextMs));
  }

  /**
   * Puts the company's opinions together (GRA-1987): a run starts once
   * five or more people's lines only counted anonymously changed since
   * they were last put together, and takes in only what was agreed as it
   * started (`opinion_people.run_from`): anyone whose lines change while it
   * runs counts towards the next five instead. Each run does one team
   * whose lines changed (`opinions:<team>`), then the company's merge
   * (`opinions`). A company with fewer than seven who may back one asks no
   * model. What fails is tried again after a minute, five and thirty, then
   * given up until five more change. Returns what it did, or null.
   */
  async opinionsNext(now: number = Date.now()): Promise<string | null> {
    return await this.#withBrain(async () => await this.#opinionsRun(now));
  }

  async #opinionsRun(now: number): Promise<string | null> {
    const roster = this.#roster();
    const tellers = this.#opinionTellers(roster);
    if (roster === null || !companyMayHaveOpinions(tellers.size)) {
      this.#opinionsBelowFloor();
      return null;
    }
    const [failed] = this.#db
      .select()
      .from(drawFailures)
      .where(eq(drawFailures.item, opinionsItem))
      .all();
    if (failed !== undefined && Date.parse(failed.after) > now) {
      return null;
    }
    const state = await this.#opinionsState(tellers);
    let { run } = state;
    if (run.size === 0) {
      if (state.changed.length < opinionBackersMin) {
        return null;
      }
      // The run starts: it takes in each teller as their lines are now.
      run = state.marks;
      this.ctx.storage.transactionSync(() => {
        for (const [person, mark] of run) {
          this.#db
            .insert(opinionPeople)
            .values({ person, runFrom: mark })
            .onConflictDoUpdate({
              target: opinionPeople.person,
              set: { runFrom: mark },
            })
            .run();
        }
      });
    }
    // Only who still holds the lines the run took them in with.
    const taken = new Map(
      [...tellers].filter(
        ([person]) => run.get(person) === state.marks.get(person)
      )
    );
    const at = new Date(now).toISOString();
    try {
      const team = await this.#formCandidates(at, roster, taken);
      if (team !== null) {
        return `${opinionsItem}:${team}`;
      }
      await this.#mergeOpinions(at, roster, taken);
      this.#opinionsRunEnded();
    } catch (error) {
      const tries = (failed?.tries ?? 0) + 1;
      log.error("onboarding.opinions_failed", {
        tries,
        error: error instanceof Error ? error.name : "unknown",
      });
      const wait = drawRetryMs[tries - 1];
      if (wait === undefined) {
        // Given up until five more change: what it took in counts as
        // merged, so the next run starts from them.
        this.#opinionsRunEnded();
        return opinionsItem;
      }
      const after = new Date(now + wait).toISOString();
      this.ctx.storage.transactionSync(() => {
        this.#db
          .insert(drawFailures)
          .values({ item: opinionsItem, tries, after })
          .onConflictDoUpdate({
            target: drawFailures.item,
            set: { tries, after },
          })
          .run();
      });
    }
    return opinionsItem;
  }

  /** Ends the run under way: what each person's lines were as it took them in is what was last merged. */
  #opinionsRunEnded(): void {
    this.ctx.storage.transactionSync(() => {
      this.#db
        .delete(drawFailures)
        .where(eq(drawFailures.item, opinionsItem))
        .run();
      this.#db
        .update(opinionPeople)
        .set({ mergedFrom: opinionPeople.runFrom, runFrom: null })
        .where(isNotNull(opinionPeople.runFrom))
        .run();
    });
  }

  /**
   * Puts the candidates of the first team whose lines, as the run took
   * them in (`taken`), changed since they were last put together
   * (`candidateInputOf`), and keeps them in this store alone: the team,
   * or null when every team's are current. A team that left the list
   * takes its candidates with it.
   */
  async #formCandidates(
    at: string,
    roster: Roster,
    taken: ReadonlyMap<string, { team: string; lines: string[] }>
  ): Promise<string | null> {
    const listed = new Set(roster.teams.map(({ id }) => `team:${id}`));
    this.ctx.storage.transactionSync(() => {
      for (const { key } of this.#db.select().from(opinionInputs).all()) {
        if (key.startsWith("team:") && !listed.has(key)) {
          this.#db
            .delete(opinionCandidates)
            .where(eq(opinionCandidates.team, key.slice("team:".length)))
            .run();
          this.#db
            .delete(opinionInputs)
            .where(eq(opinionInputs.key, key))
            .run();
        }
      }
    });
    const formed = new Map(
      this.#db
        .select()
        .from(opinionInputs)
        .all()
        .map(({ key, input }) => [key, input])
    );
    for (const { id: team } of roster.teams.toSorted((a, b) =>
      a.id.localeCompare(b.id)
    )) {
      const brief: CandidateBrief = {
        names: roster.people.map(({ name }) => name),
        teamNames: roster.teams.map(({ name }) => name),
        tellers: [...taken].flatMap(([person, told]) =>
          told.team === team ? [{ person, lines: told.lines }] : []
        ),
      };
      // oxlint-disable-next-line no-await-in-loop -- a hash a team, until one changed
      const input = await candidateInputOf(brief);
      if (formed.get(`team:${team}`) === input) {
        continue;
      }
      // Whose interviews it is put together from, before anything is
      // awaited: anyone's that moves meanwhile counts for nothing of it.
      const began = this.#interviewsOf(
        brief.tellers.map(({ person }) => person)
      );
      // oxlint-disable-next-line no-await-in-loop -- one team a run
      const candidates = await teamCandidates(
        brief,
        checksFor(this.env, (took) => {
          this.meter(took, at);
        })
      );
      // oxlint-disable-next-line no-await-in-loop -- one team a run
      const ids = await Promise.all(
        candidates.map(async ({ text }) => await candidateId(team, text))
      );
      this.ctx.storage.transactionSync(() => {
        const gone = new Set(this.#goneSince(began));
        this.#db
          .delete(opinionCandidates)
          .where(eq(opinionCandidates.team, team))
          .run();
        for (const [index, { text, people: on }] of candidates.entries()) {
          for (const person of on.filter((each) => !gone.has(each))) {
            this.#db
              .insert(opinionCandidates)
              .values({ id: ids[index] ?? "", team, text, person })
              .onConflictDoNothing()
              .run();
          }
        }
        // Kept only while nobody it was taken over went meanwhile.
        if (gone.size === 0) {
          this.#db
            .insert(opinionInputs)
            .values({ key: `team:${team}`, input })
            .onConflictDoUpdate({
              target: opinionInputs.key,
              set: { input },
            })
            .run();
        }
      });
      return team;
    }
    return null;
  }

  /**
   * Merges every team's candidates of the people the run took in
   * (`taken`) into the company's opinions (company-opinions.ts) and notes
   * them (`#noteOpinions`): from the candidates' sentences alone, never a
   * person or a team. When what it would be given is what the opinions
   * standing were put together from (`opinion_inputs` `merge`), no model is
   * asked and nothing changes.
   */
  async #mergeOpinions(
    at: string,
    roster: Roster,
    taken: ReadonlyMap<string, { team: string; lines: string[] }>
  ): Promise<void> {
    const byId = new Map<
      string,
      { id: string; text: string; people: string[] }
    >();
    for (const { id, text, person } of this.#db
      .select()
      .from(opinionCandidates)
      .all()) {
      if (!taken.has(person)) {
        continue;
      }
      const held = byId.get(id) ?? { id, text, people: [] };
      held.people.push(person);
      byId.set(id, held);
    }
    const candidates = [...byId.values()];
    const brief = {
      candidates,
      names: roster.people.map(({ name }) => name),
      teamNames: roster.teams.map(({ name }) => name),
      lines: new Map([...taken].map(([person, { lines }]) => [person, lines])),
    };
    const input = await mergeInputOf(brief);
    const [held] = this.#db
      .select()
      .from(opinionInputs)
      .where(eq(opinionInputs.key, "merge"))
      .all();
    if (held?.input === input) {
      return;
    }
    const began = this.#interviewsOf([
      ...new Set(candidates.flatMap(({ people: on }) => on)),
    ]);
    const opinions = await companyOpinions(
      brief,
      mergeChecks(this.env, (took) => {
        this.meter(took, at);
      })
    );
    await this.#fallenFirst(() => {
      this.ctx.storage.transactionSync(() => {
        const gone = new Set(this.#goneSince(began));
        this.#noteOpinions(
          opinions.map((opinion) => ({
            ...opinion,
            people: opinion.people.filter((person) => !gone.has(person)),
          })),
          at
        );
        // Kept only while nobody it was taken over went meanwhile.
        if (gone.size === 0) {
          this.#db
            .insert(opinionInputs)
            .values({ key: "merge", input })
            .onConflictDoUpdate({
              target: opinionInputs.key,
              set: { input },
            })
            .run();
        }
      });
    });
    // The opinions it noted reach the hand-over with their events.
    this.#deliverAudit();
  }

  /**
   * Notes, in the caller's transaction, that `opinions` are the company's
   * opinions now (GRA-1987): each new one that stands (`opinionStands`)
   * is to be written to the new Brain under a change key minted here, and
   * whom it rests on is noted here alone. Each noted before that isn't one
   * of them any more (no longer made, or no longer backed by five) falls:
   * it is out of use in the Brain before this transaction commits
   * (`SourcesFallError`, `#fallenFirst`).
   */
  #noteOpinions(
    opinions: readonly {
      record: string;
      kind: StatementKind;
      text: string;
      people: readonly string[];
    }[],
    at: string
  ): void {
    const tellers = this.#opinionTellers();
    const shown = opinions.filter(({ people: on }) =>
      opinionStands(on, tellers)
    );
    const current = new Set(shown.map(({ record }) => record));
    const held = this.#db
      .select({ source: brainOpinions.source, record: brainOpinions.record })
      .from(brainOpinions)
      .where(standingOpinion)
      .all();
    const dropped = held.filter(({ record }) => !current.has(record));
    if (dropped.length > 0) {
      throw new SourcesFallError(
        dropped.map(({ source }) => ({ producer: "opinion", id: source }))
      );
    }
    const kept = new Set(held.map(({ record }) => record));
    for (const { record, kind, text, people: on } of shown) {
      // Whom it rests on is exactly who backs it now.
      this.#db
        .delete(opinionBackers)
        .where(eq(opinionBackers.record, record))
        .run();
      for (const person of on) {
        this.#db
          .insert(opinionBackers)
          .values({ record, person })
          .onConflictDoNothing()
          .run();
      }
      if (!kept.has(record)) {
        const source = crypto.randomUUID();
        this.#db
          .insert(brainOpinions)
          .values({ source, record, kind, text, at: at.slice(0, 10) })
          .run();
        this.#noteHandOver("opinion", source);
      }
    }
  }

  /**
   * The drawings standing now (`standingDrawing`), as every member reads
   * them on the Brain page (GRA-1748), by the rule the hand-over adds them
   * by (`drawingToHand`): each piece of work's one drawing, with its team
   * and names. Never who told what.
   */
  standingDrawings(): StandingDrawing[] {
    return this.#db
      .select()
      .from(brainDrawings)
      .where(standingDrawing)
      .all()
      .flatMap((row) => {
        const drawing = brainDrawingOf(row.drawing);
        return drawing === null
          ? []
          : [
              {
                source: row.source,
                workflow: row.workflow,
                team: row.team,
                name: row.name,
                ...(row.local === null ? {} : { local: row.local }),
                drawing,
              },
            ];
      });
  }

  /**
   * The drawing `source` as the hand-over adds it now: what it holds, for
   * its team, only while it stands (`standingDrawing`). Null otherwise.
   */
  drawingToHand(source: string): StandingDrawing | null {
    return (
      this.standingDrawings().find((each) => each.source === source) ?? null
    );
  }

  /**
   * The claim `source` as the hand-over adds it now: its sentence and its
   * team, only while it stands (`standingClaim`). Null otherwise.
   */
  claimToHand(source: string): { text: string; team: string } | null {
    const [row] = this.#db
      .select()
      .from(brainClaims)
      .where(and(eq(brainClaims.source, source), standingClaim))
      .all();
    return row === undefined ? null : { text: row.text, team: row.team };
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
    scope?:
      | { person: string; teams?: readonly string[] }
      | { claims: true }
      | { account: string }
  ): OwedErasure[] {
    this.#decideInterviews();
    if (scope !== undefined && "account" in scope) {
      return this.owedErasures().filter(
        (owed) => owed.kind === "interview" && owed.account === scope.account
      );
    }
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
      // The company's opinions have no team: any owed is every scope's.
      return this.owedErasures().filter((owed) =>
        "claims" in scope
          ? owed.kind !== "interview"
          : (owed.kind === "interview" &&
              this.#interviewPersonOf(owed.source) === scope.person) ||
            owed.kind === "opinion" ||
            ((owed.kind === "claim" || owed.kind === "drawing") &&
              ofTeams.has(owed.team))
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
    const drawings: OwedErasure[] = this.#db
      .select({ source: brainDrawings.source, team: brainDrawings.team })
      .from(brainDrawings)
      .where(eq(brainDrawings.erase, true))
      .all()
      .map(({ source, team }) => ({ kind: "drawing", source, team }));
    const opinions: OwedErasure[] = this.#db
      .select({ source: brainOpinions.source })
      .from(brainOpinions)
      .where(eq(brainOpinions.erase, true))
      .all()
      .map(({ source }) => ({ kind: "opinion", source }));
    return [...owedInterviews, ...claims, ...drawings, ...opinions];
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
   * away no longer backs it. The one rule, for the recount
   * (`#recountStanding`), for noting a claim (`#noteClaims`) and for
   * forgetting whom one rested on (`#toForget`).
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
   * What core settles with the new Brain once `person`'s own request on
   * their link is done (`LinkWork`), read before it changes anything.
   */
  #linkWork(person: string): LinkWork {
    return { person, backed: this.claimTeamsOf(person) };
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
      } else if (kind === "claim") {
        this.#db
          .delete(brainClaims)
          .where(
            and(eq(brainClaims.source, source), eq(brainClaims.erase, true))
          )
          .run();
      } else if (kind === "opinion") {
        this.#db
          .delete(brainOpinions)
          .where(
            and(eq(brainOpinions.source, source), eq(brainOpinions.erase, true))
          )
          .run();
      } else {
        this.#db
          .delete(brainDrawings)
          .where(
            and(eq(brainDrawings.source, source), eq(brainDrawings.erase, true))
          )
          .run();
      }
    });
    if (kind !== "interview") {
      this.#takenOut.delete(fallenKey({ producer: kind, id: source }));
    }
  }

  /**
   * Notes, in the caller's transaction, that the statements `claims` of
   * `team` are the team's claims now: each new one is to be written to
   * the new Brain under a change key minted here. Each written before that
   * isn't one of them any more (no longer made, or no longer backed by
   * five) falls: it is out of use in the Brain before this transaction
   * commits (`SourcesFallError`, `#fallenFirst`), as for any change that
   * drops one.
   */
  #noteClaims(
    team: string,
    claims: readonly (IntakeClaim & { people: readonly string[] })[]
  ): void {
    // Noted only while it stands, by the recount's own rule
    // (`#claimStands`): one moved away while the claims were put together
    // doesn't count.
    const read = { roster: this.#roster(), mayClaim: new Map() };
    const shown = claims.filter(({ people: backing }) =>
      this.#claimStands(team, backing, read)
    );
    const current = new Set(shown.map(({ record }) => record));
    const held = this.#db
      .select({ source: brainClaims.source, record: brainClaims.record })
      .from(brainClaims)
      .where(and(eq(brainClaims.team, team), eq(brainClaims.erase, false)))
      .all();
    const dropped = held.filter(({ record }) => !current.has(record));
    if (dropped.length > 0) {
      throw new SourcesFallError(
        dropped.map(({ source }) => ({ producer: "claim", id: source }))
      );
    }
    const kept = new Set(held.map(({ record }) => record));
    for (const { record, kind, text } of shown) {
      if (!kept.has(record)) {
        const source = crypto.randomUUID();
        this.#db
          .insert(brainClaims)
          .values({ source, record, team, kind, text })
          .run();
        this.#noteClaimSource(source);
      }
    }
  }

  /**
   * Notes, in the caller's transaction, that `drawings` of `team` are the
   * drawings of its pieces of work now (GRA-1748): each new one is to be
   * written to the new Brain under a change key minted here, and shown on
   * the Brain page. Each noted before that isn't one of them any more
   * (drawn anew, no longer drawn, or no longer standing) falls: it is out
   * of use in the Brain before this transaction commits
   * (`SourcesFallError`, `#fallenFirst`), as for any change that drops one.
   */
  #noteDrawings(
    team: string,
    drawings: readonly (IntakeDrawing & { people: readonly string[] })[]
  ): void {
    // Noted only while it stands, by the recount's own rule
    // (`#drawingStands`).
    const read = { roster: this.#roster(), agreed: this.#agreedPeople() };
    const shown = drawings.filter(({ people: resting }) =>
      this.#drawingStands(team, resting, read)
    );
    const current = new Set(shown.map(({ record }) => record));
    const held = this.#db
      .select({ source: brainDrawings.source, record: brainDrawings.record })
      .from(brainDrawings)
      .where(and(eq(brainDrawings.team, team), standingDrawing))
      .all();
    const dropped = held.filter(({ record }) => !current.has(record));
    if (dropped.length > 0) {
      throw new SourcesFallError(
        dropped.map(({ source }) => ({ producer: "drawing", id: source }))
      );
    }
    const kept = new Set(held.map(({ record }) => record));
    const at = new Date().toISOString();
    for (const { record, workflow, name, local, drawing } of shown) {
      if (!kept.has(record)) {
        const source = crypto.randomUUID();
        this.#db
          .insert(brainDrawings)
          .values({
            source,
            record,
            workflow,
            team,
            name,
            local: local ?? null,
            drawing: JSON.stringify(drawing),
            at,
          })
          .run();
        this.#noteHandOver("drawing", source);
      }
    }
  }

  /** Who agrees to what they said now: their interview counts (`agreedAt`). */
  #agreedPeople(): Set<string> {
    return new Set(
      this.#db
        .select({ person: interviewStates.person })
        .from(interviewStates)
        .where(isNotNull(interviewStates.agreedAt))
        .all()
        .map(({ person }) => person)
    );
  }

  /**
   * The one recount of the team claims (GRA-1741) and drawings (GRA-1748),
   * in the transaction of a change that may take one down: the standing
   * claims and drawings of the teams `of` (`all` for a roster save). A
   * claim stands while its team may have claims shown and five or more of
   * its people back it (`#claimStands`); a drawing while all it rests on
   * still count (`#drawingStands`). One that no longer stands must be out
   * of use in the Brain before the change commits (GRA-1946): the Brain
   * decides what is read, inside its own statement, so a read that runs
   * after the change finds nothing of it, also one whose reader was found
   * before. So, finding one, it throws `SourcesFallError`, which rolls the
   * whole change back: the change is made again once they are out
   * (`#fallenFirst`).
   */
  #recountStanding(of: readonly (string | null)[] | "all"): void {
    // The company's opinions have no team: every recount counts them
    // (`#opinionsFalling`), whatever teams it names.
    const opinions = this.#opinionsFalling();
    const named = of === "all" ? [] : of.filter((team) => team !== null);
    if (of !== "all" && named.length === 0) {
      if (opinions.length > 0) {
        throw new SourcesFallError(opinions);
      }
      return;
    }
    const claims = this.#db
      .select({
        source: brainClaims.source,
        record: brainClaims.record,
        team: brainClaims.team,
        erase: brainClaims.erase,
      })
      .from(brainClaims)
      .where(of === "all" ? undefined : inList(brainClaims.team, named))
      .all()
      .map((row) => ({ ...row, producer: "claim" as const }));
    const drawings = this.#db
      .select({
        source: brainDrawings.source,
        record: brainDrawings.record,
        team: brainDrawings.team,
        erase: brainDrawings.erase,
      })
      .from(brainDrawings)
      .where(of === "all" ? undefined : inList(brainDrawings.team, named))
      .all()
      .map((row) => ({ ...row, producer: "drawing" as const }));
    const held = [...claims, ...drawings];
    // One owed its erasure that this object hasn't seen taken out (it was
    // marked just before a removal that failed, or before a restart) may
    // still be in use: it is taken out again first.
    const owed = held.filter(
      ({ producer, source, erase }) =>
        erase && this.#mayBeInUse({ producer, id: source }, erase)
    );
    const standing = held.filter(({ erase }) => !erase);
    if (owed.length === 0 && standing.length === 0) {
      if (opinions.length > 0) {
        throw new SourcesFallError(opinions);
      }
      return;
    }
    const roster = this.#roster();
    const agreed = this.#agreedPeople();
    const mayClaim = new Map<string, boolean>();
    const falling = standing.filter(({ producer, record, team }) => {
      const resting = this.#db
        .select({ person: brainSent.person })
        .from(brainSent)
        .where(eq(brainSent.record, record))
        .all()
        .map(({ person }) => person);
      return producer === "claim"
        ? !this.#claimStands(team, resting, { roster, agreed, mayClaim })
        : !this.#drawingStands(team, resting, { roster, agreed, mayClaim });
    });
    const out = [
      ...[...owed, ...falling].map(({ producer, source }) => ({
        producer,
        id: source,
      })),
      ...opinions,
    ];
    if (out.length > 0) {
      throw new SourcesFallError(out);
    }
  }

  /**
   * The one rule for whether a drawing of `team` resting on `resting`
   * stands now (GRA-1084, GRA-1748): its team may have its results shown
   * (`#teamShowsResults`, as for a claim), everyone it rests on still
   * counts (none gone, none who took back what they approved, none moved
   * to another team), and its
   * team's map stands on what its lead's facts are now (`#mapBacked`,
   * GRA-329). The
   * recount (`#recountStanding`), noting a drawing (`#noteDrawings`) and
   * forgetting whom one rested on (`#toForget`) ask it, so none keeps what
   * another drops.
   */
  #drawingStands(
    team: string,
    resting: readonly string[],
    {
      roster = this.#roster(),
      agreed,
      mayClaim = new Map<string, boolean>(),
    }: {
      roster?: Roster | null;
      agreed: ReadonlySet<string>;
      mayClaim?: Map<string, boolean>;
    }
  ): boolean {
    return (
      this.#teamShowsResults(team, { roster, mayClaim }) &&
      resting.length > 0 &&
      // Each still agrees, and is in the team now: one who moved away takes
      // their part with them, as for a claim (`#currentBackers`).
      this.#currentBackers(team, resting, agreed).length === resting.length &&
      this.#mapBacked(team)
    );
  }

  /**
   * The one rule for whether `team` may have its results (its claims and
   * the drawings of its work) read at all (GRA-1748): it is on the list,
   * it takes part (an admin may switch a team off: then nothing of it is
   * shown to members, #2344; one switched on again, or new, shows only
   * once the admin confirms it), and seven or more of its people tell their
   * own work (`teamMayClaim`: five backers in a team of seven, the
   * owner's decision of 16 November). Both `#claimStands` and
   * `#drawingStands` ask it. A read of many passes the list read once, and
   * a map of each team's answer (`mayClaim`), filled as it goes.
   */
  #teamShowsResults(
    team: string,
    {
      roster = this.#roster(),
      mayClaim = new Map<string, boolean>(),
    }: { roster?: Roster | null; mayClaim?: Map<string, boolean> }
  ): boolean {
    const known = mayClaim.get(team);
    if (known !== undefined) {
      return known;
    }
    // Switched off, or switched on or new and still waiting for the admin
    // to confirm it (`#holdNew`): nothing of it is shown.
    const takesPart =
      roster?.teams.some(({ id, off }) => id === team && !off) === true &&
      !this.#unconfirmed().teams.has(team);
    const may = takesPart && teamMayClaim(this.#tellers(team, roster).length);
    mayClaim.set(team, may);
    return may;
  }

  /**
   * The one rule for whether a claim of `team` resting on `backers` stands
   * now (GRA-1741): its team may have its results shown
   * (`#teamShowsResults`), and five or more of `backers` back it now
   * (`#currentBackers`). Both noting
   * a claim (`#noteClaims`) and the recount (`#recountStanding`) ask it, so
   * neither keeps what the other drops. A recount over many claims passes
   * the list and the agreed people read once, and a map of what each team
   * may (`mayClaim`), filled as it goes.
   */
  #claimStands(
    team: string,
    backers: readonly string[],
    {
      roster = this.#roster(),
      agreed,
      mayClaim = new Map<string, boolean>(),
    }: {
      roster?: Roster | null;
      agreed?: ReadonlySet<string>;
      mayClaim?: Map<string, boolean>;
    } = {}
  ): boolean {
    return (
      this.#teamShowsResults(team, { roster, mayClaim }) &&
      this.#currentBackers(team, backers, agreed).length >= minTeamShown
    );
  }

  /** Notes, in a transaction of its own or the caller's, that the teams `due` are due to be given to the Brain again. */
  #dueAgain(due: readonly string[]): void {
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      for (const team of new Set(due)) {
        this.#brainDue(team, at);
      }
    });
  }

  /** The teams of the claims and drawings `sources`. */
  #teamsOf(sources: readonly FallingSource[]): string[] {
    const of = (producer: FallingSource["producer"]): string[] =>
      sources.flatMap((source) =>
        source.producer === producer ? [source.id] : []
      );
    return [
      ...this.#db
        .select({ team: brainClaims.team })
        .from(brainClaims)
        .where(inList(brainClaims.source, of("claim")))
        .all(),
      ...this.#db
        .select({ team: brainDrawings.team })
        .from(brainDrawings)
        .where(inList(brainDrawings.source, of("drawing")))
        .all(),
    ].map(({ team }) => team);
  }

  /**
   * Whether `source`, marked to be erased or not (`erase`), may still be in
   * use in the Brain: standing, or marked but not seen taken out by this
   * object (`#takenOut`: a removal that failed after the mark, or a restart
   * since). The one rule for what a change takes out again before what
   * rests on it goes (`#recountStanding`, a document's removal).
   */
  #mayBeInUse(source: FallingSource, erase: boolean): boolean {
    return !erase || !this.#takenOut.has(fallenKey(source));
  }

  /**
   * Makes a change that may take team claims or drawings down
   * (`#recountStanding`, `#noteClaims`, `#noteDrawings`, a document's
   * removal). Each it finds falling (`SourcesFallError`) is first marked
   * here to be erased (`owedErasures`), in a transaction of its own, so
   * one the Brain may have taken out never reads as standing here, on the
   * Brain page or for the hand-over, whatever happens next. It is then
   * taken out of use in the shared store (the Brain's `removeSources`:
   * one transaction there, its key closed for good, also while its add is
   * in flight) and erased there, so the Brain's ledger keeps it out after
   * a restore too (an erasure that fails is left to core's clock: it is
   * out of use already). Then the change is made again from the start,
   * every check read afresh, with `again` (a link's call then isn't
   * counted twice). One found falling then too, as things moved
   * meanwhile, goes the same way; each round takes out at least one more,
   * so it ends. A Brain that can't take them out (out of reach, or
   * restoring) fails the change, with nothing of it made: nothing stays
   * readable past a change that drops it. One taken out by a change that
   * then fails stands again only through the team's next intake, under a
   * new key.
   */
  async #fallenFirst<T>(
    change: (again: boolean) => Promise<T> | T,
    again = false
  ): Promise<T> {
    try {
      return await change(again);
    } catch (error) {
      if (!(error instanceof SourcesFallError)) {
        throw error;
      }
      const { sources } = error;
      const ofProducer = (producer: FallingSource["producer"]): string[] =>
        sources.flatMap((source) =>
          source.producer === producer ? [source.id] : []
        );
      this.ctx.storage.transactionSync(() => {
        this.#db
          .update(brainClaims)
          .set({ erase: true })
          .where(inList(brainClaims.source, ofProducer("claim")))
          .run();
        this.#db
          .update(brainDrawings)
          .set({ erase: true })
          .where(inList(brainDrawings.source, ofProducer("drawing")))
          .run();
        this.#opinionsFell(ofProducer("opinion"));
      });
      if (this.#removeFallen === undefined) {
        throw new Error("Nothing takes sources out of the Brain here.", {
          cause: error,
        });
      }
      const erased = await this.#takeOut(this.#removeFallen, sources);
      for (const source of sources) {
        this.#takenOut.add(fallenKey(source));
      }
      for (const { producer, id } of erased) {
        this.erasedFromBrain(producer, id);
      }
      return await this.#fallenFirst(change, true);
    }
  }

  /**
   * Takes `sources`, marked already, out of the Brain with `remove`: the
   * ones it erased. When the Brain can't, the change is refused, its
   * sources off the page: their teams are given again at their next
   * intake (`#dueAgain`), so what still stands comes back once the Brain
   * takes it.
   */
  async #takeOut(
    remove: SourceRemover,
    sources: readonly FallingSource[]
  ): Promise<readonly FallingSource[]> {
    try {
      return await remove(sources);
    } catch (error) {
      this.#dueAgain(this.#teamsOf(sources));
      throw error;
    }
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
   * The claims and drawings whose backing is to be forgotten (`brain_sent`):
   * every one that stands no more, by the rules the recount asks
   * (`#claimStands`, `#drawingStands`). Whoever is gone goes with them:
   * one who withdrew, deleted their interview or took back what they
   * approved backs nothing that still stands, as a claim rests on exactly
   * the five whose facts were checked first (team-claims.ts `supported`)
   * and a drawing on everyone it was drawn from, so each fell as they went.
   * An intake that rebuilds such a claim while they go rests it on who
   * backs it now alone, their gone mark dropped (`#intakeTeam`), so no
   * standing claim keeps one.
   */
  #toForget(): string[] {
    const rows = this.#db
      .select({
        record: brainSent.record,
        type: brainSent.type,
        team: brainSent.team,
        person: brainSent.person,
      })
      .from(brainSent)
      .all();
    if (rows.length === 0) {
      return [];
    }
    const roster = this.#roster();
    const agreed = this.#agreedPeople();
    const mayClaim = new Map<string, boolean>();
    const resting = new Map<
      string,
      { type: string; team: string; people: string[] }
    >();
    for (const { record, type, team, person } of rows) {
      const held = resting.get(record) ?? { type, team, people: [] };
      held.people.push(person);
      resting.set(record, held);
    }
    return [...resting].flatMap(([record, { type, team, people: on }]) => {
      const stands =
        type === "statement"
          ? this.#claimStands(team, on, { roster, agreed, mayClaim })
          : this.#drawingStands(team, on, { roster, agreed, mayClaim });
      return stands ? [] : [record];
    });
  }

  /**
   * Forgets whom what `#toForget` finds rested on (GRA-368): what stays
   * rests on nobody who is gone. Nothing leaves the Brain here: a claim or
   * drawing that stops standing is out of use there before the change
   * that drops it commits (`#recountStanding`), and owed its erasure until
   * done. After an interview goes, after an intake, and from the alarm.
   */
  #forgetFallen(): void {
    const records = this.#toForget();
    if (records.length > 0) {
      this.#db.delete(brainSent).where(inList(brainSent.record, records)).run();
    }
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
    const forgettable = this.#toForget().length > 0;
    const afters = [
      ...drawing.map(({ after }) => after),
      ...this.#brainDueAt(now).flatMap(({ team, after }) =>
        drawn.has(team) ? [] : [after]
      ),
      // Whom what no longer stands rested on, and the voice's lines of an
      // interview that is gone still in the cache.
      ...(forgettable ||
      this.#db
        .select({ key: linesToForget.key })
        .from(linesToForget)
        .limit(1)
        .all().length > 0
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
    // Before anything is read: whether the kickoff is deleted meanwhile.
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
      // or the kickoff deleted meanwhile: drawn again.
      if (now === null || still === undefined || this.#stale(began, purges)) {
        return;
      }
      const members = now.people.filter(({ team: of }) => of === teamId);
      const before = this.teamWorks(teamId);
      // Whether the map drawn before still stands on what the lead
      // approved: once a line it was drawn from stopped counting as shared
      // (GRA-1987), no piece of it outlives this map unless it names it.
      const stood = this.#mapBacked(teamId);
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
      if (stood) {
        drawn.push(...outliving(before, drawn, members, asked));
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
          // The lead's map is theirs, from their interview: kept apart from
          // what the admin wrote, never shown as theirs (GRA-1748). A map
          // saying nothing of it leaves nothing of an earlier one.
          mappedDoes: map.does === "" ? null : map.does,
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
      .select({ local: works.local, team: works.team })
      .from(askedAbout)
      .innerJoin(works, eq(works.id, askedAbout.work))
      .where(eq(askedAbout.person, person))
      .all();
    // A piece of a map that no longer stands is named to nobody (GRA-1987).
    return row === undefined || !this.#mapBacked(row.team) ? "" : row.local;
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
    /**
     * Who asks: the account signed in (links.ts), and, to open a link that
     * belongs to no account yet, the address the company's sign-in verified.
     */
    caller: { account: string; address?: string },
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
    const [link] = this.#db
      .select()
      .from(links)
      .where(eq(links.person, person.id))
      .all();
    // Someone else's link answers as one that never was: whose it is, and
    // whether it is open, paused, over or busy, is for its own person
    // alone. So only the calls of whoever holds it count against its limit:
    // nobody else can hold its person up.
    if (
      link === undefined ||
      link.erasedAt !== null ||
      this.#heldAt(link, person.email, caller, use === "open") === null
    ) {
      return refused("interview.link_invalid");
    }
    if (call && !this.#withinLimit(person.id, now)) {
      return refused("interview.limited");
    }
    const row = this.#row();
    if (row.plan === null) {
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

  /**
   * The address under which `caller` holds `link` (GRA-1790), null when
   * they don't: the account it belongs to holds it; or, only to `open` one
   * that belongs to no account yet, an account whose verified address is
   * the one the link was last sent to (`listed`, the list's address, for a
   * link no mail carried), that no other link went to, and that holds no
   * other interview. A link with no address at all is held by nobody.
   */
  #heldAt(
    link: typeof links.$inferSelect,
    listed: string,
    caller: { account: string; address?: string },
    open: boolean
  ): string | null {
    if (caller.account === "") {
      return null;
    }
    if (link.account !== null) {
      return link.account === caller.account ? (link.sentTo ?? "") : null;
    }
    const address = foldedAddress(caller.address ?? "");
    const to = link.sentTo ?? foldedAddress(listed);
    if (!open || to === "" || address !== to) {
      return null;
    }
    const others = this.#db
      .select({ person: links.person })
      .from(links)
      .where(
        and(
          ne(links.person, link.person),
          or(eq(links.sentTo, address), eq(links.account, caller.account))
        )
      )
      .all();
    const listedElsewhere = (this.#roster()?.people ?? []).some(
      ({ id, email }) => id !== link.person && foldedAddress(email) === address
    );
    return others.length === 0 && !listedElsewhere ? address : null;
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
   * drawing or a count, and its deletion takes it as stored, so nothing
   * stops on it.
   */
  #held(person: string): InterviewProgress | null {
    const stored = this.#interviewStored(person);
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
      // again fails. So does what their map says a team does.
      this.#forgetMapOf(person.id);
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
      this.#forgetOpinionsOf(person.id);
    }
    if (counts) {
      this.#db
        .update(interviewStates)
        .set({ agreedAt: now })
        .where(eq(interviewStates.person, person.id))
        .run();
      this.#brainDue(person.team, now);
    } else {
      this.#db
        .update(interviewStates)
        .set({ agreedAt: null, drawnAt: null })
        .where(eq(interviewStates.person, person.id))
        .run();
    }
    // A claim it took under five backers, or a team it took under seven
    // interviewed, is out of use in the Brain before this transaction
    // commits (`#recountStanding`). Only a loss can take either down: a gain
    // never lowers backing, so it pays no recount, and going from counting
    // to not counting always loses something.
    if (lost) {
      this.#recountStanding([this.#teamOfPerson(person.id)]);
    }
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
   * drawing it was in (`#erase`), and notes why.
   */
  #forget(person: string, now: string, what: string, by: string): void {
    this.#erase(person);
    // A claim it took under five backers, or a team it took under seven
    // interviewed, is out of use in the Brain before this transaction
    // commits (`#recountStanding`). A roster save, which erases everyone it
    // takes off the list, recounts once for them all at the end of its
    // own transaction (`#writeRoster`).
    this.#recountStanding([this.#teamOfPerson(person)]);
    this.#noted(person, what, now, by);
  }

  /**
   * Removes someone's interview, in the transaction it is called in: what
   * they said and agreed to, where it stood, and every drawing it was in (`#forgetDrawings`). From then on nothing
   * they agreed to counts (`#agreedAt` is null), which is how the claims
   * and drawings resting on them are found (`#recountStanding`,
   * `#toForget`). Everything the voice
   * was asked to say in it goes from the cache (`#queueSpokenOf`).
   */
  #erase(person: string): void {
    this.#queueSpokenOf(person);
    this.#forgetMapOf(person);
    this.#forgetDrawings(person);
    this.#forgetOpinionsOf(person);
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

  /**
   * What a save of `progress` erases of `person`'s interview as kept
   * (GRA-1897), or "unremoved" when it brings back a line they removed or
   * the words of a statement erased. The lines it removes, by how many;
   * once the interview is completed, the statements they took out in the
   * read-back, erased in the copy kept (`progress`, `erasedFact`: each
   * keeps its id and place, so no id is given again), by id; and each
   * kept fact's revision. Either takes everything the voice said in the
   * interview out of the cache (`#keepErased`). Until it is completed, a
   * statement taken out can be put back.
   */
  async #erasing(
    person: string,
    progress: InterviewProgress
  ): Promise<SaveErasures | "unremoved"> {
    const held = this.#storedProgress(person);
    if (held !== null && bringsBack(held, progress)) {
      return "unremoved";
    }
    const removed = (held?.lines ?? []).filter(
      (line, at) =>
        line.removed !== true && progress.lines[at]?.removed === true
    );
    // Erased now: taken out of an interview completed, or erased by the
    // page itself as it completed, each with its words as last held.
    const heldFacts = new Map(
      (held?.facts ?? []).map((fact) => [fact.id, fact])
    );
    const out = [
      ...(progress.person === "completed" ? takenOut(progress) : []),
      ...progress.facts.flatMap((fact) => {
        const was = heldFacts.get(fact.id);
        return isErased(fact) && was !== undefined && !isErased(was)
          ? [was]
          : [];
      }),
    ];
    const keeping =
      progress.person === "completed" ? withTakenOutErased(progress) : progress;
    return {
      progress: keeping,
      // Each fact's revision as kept, from the save alone: what an
      // approval must name for the fact to count.
      revisions: new Map(
        await Promise.all(
          keeping.facts.map(
            async (fact) => [fact.id, await factRevision(fact)] as const
          )
        )
      ),
      lines: removed.length,
      dropped: out.map(({ id }) => id),
    };
  }

  /**
   * Once the interviews closed (`closesOn`), nobody can finish one any
   * more: what was taken out of each in the read-back is erased, as
   * completing it erases it (`#erasing`). Run by the alarm, which is set
   * for it while anything taken out is left (`#armErasure`), paused or
   * not, and sets it again a moment later while anything is left, as
   * after a failure. Each interview is read and written in one
   * transaction.
   * Returns how many it erased in.
   */
  async eraseTakenOutAfterClose(
    now: string = new Date().toISOString()
  ): Promise<number> {
    const { plan } = this.#row();
    if (plan === null || dayOf(now) <= closesOn(plan)) {
      return 0;
    }
    let erased = 0;
    for (const person of this.#interviewPeople()) {
      // Read and written in one transaction: nothing lands between.
      erased += this.ctx.storage.transactionSync(() => {
        const held = this.#storedProgress(person);
        const dropped = held === null ? [] : takenOut(held).map(({ id }) => id);
        if (held === null || dropped.length === 0) {
          return 0;
        }
        const revisions = this.#revisionsOf(person);
        for (const id of dropped) {
          revisions.delete(id);
        }
        this.#db
          .update(interviews)
          .set({
            progress: JSON.stringify(withTakenOutErased(held)),
            revisions: JSON.stringify(Object.fromEntries(revisions)),
          })
          .where(eq(interviews.person, person))
          .run();
        // A page's copy, with the words, is older from now on.
        this.#db
          .update(links)
          .set({ version: sql`${links.version} + 1` })
          .where(eq(links.person, person))
          .run();
        this.#keepErased(person, { lines: 0, dropped }, now);
        return 1;
      });
    }
    if (erased > 0) {
      await this.forgetLinesNow();
    }
    return erased;
  }

  /**
   * Keeps what a save erases (`#erasing`), in the transaction it is called
   * in: the approvals of the statements dropped, which are digests of
   * their words; and everything the voice said in the interview, to go
   * from the cache (`#queueSpokenOf`; a line being said as it goes is
   * taken out once kept, speech.ts `keepUnlessErased`). Nothing drawn
   * reads a line or a statement taken out, so no drawing is touched. A
   * removed line is noted only in the onboarding's own log, as a delete
   * from the link is: in the audit log its moment would tell the admin
   * whose interview it was.
   */
  #keepErased(
    person: string,
    erasing: { lines: number; dropped: string[] },
    now: string
  ): void {
    if (erasing.dropped.length > 0) {
      this.#db
        .delete(approvals)
        .where(
          and(
            eq(approvals.person, person),
            inList(approvals.fact, erasing.dropped)
          )
        )
        .run();
    }
    if (erasing.lines > 0 || erasing.dropped.length > 0) {
      this.#queueSpokenOf(person);
    }
    if (erasing.lines > 0) {
      this.#noted(person, "interview.line_removed", now);
    }
  }

  /**
   * Whether `person`'s save over `version` (from `page`, if named) goes on
   * from the link as kept now, and
   * what its erasures are: the version it makes, or the answer that
   * refuses it. Hashing its erasures lets another save land meanwhile, so
   * the caller asks again if one did (`saveInterview`): the closing save
   * of a page whose own save landed meanwhile then goes on from it, and a
   * copy that brings back a line they removed never does.
   */
  async #savable(
    person: string,
    version: number,
    page: SavingPage | undefined,
    progress: InterviewProgress
  ): Promise<Savable> {
    const [link] = this.#db
      .select({
        version: links.version,
        savedByPage: links.savedByPage,
        savedPageSave: links.savedPageSave,
        savedVersion: links.savedVersion,
        deletedAt: links.deletedAt,
      })
      .from(links)
      .where(eq(links.person, person))
      .all();
    if (link === undefined || !goesOnFromKept(link, version, page)) {
      const held = this.#held(person);
      if (held === null && (link?.deletedAt ?? null) !== null) {
        return { answer: refused("interview.deleted") };
      }
      return {
        answer: answered({
          saved: false,
          version: link?.version ?? version,
          progress: this.#forSpeaker(person, held),
        }),
      };
    }
    const erasing = await this.#erasing(person, progress);
    // A copy that brings back a line they removed is an older one,
    // whichever tab sends it.
    if (erasing === "unremoved") {
      return {
        answer: answered({
          saved: false,
          version: this.#versionOf(person) ?? version,
          progress: this.#forSpeaker(person, this.#held(person)),
        }),
      };
    }
    return { next: link.version + 1, erasing };
  }

  /** The version of `person`'s link as kept now; null without one. */
  #versionOf(person: string): number | null {
    const [row] = this.#db
      .select({ version: links.version })
      .from(links)
      .where(eq(links.person, person))
      .all();
    return row?.version ?? null;
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
    const led = this.#ledBy(person);
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

  /** The teams `person` leads or led in their interview, by its state, their link or the roster. */
  #ledBy(person: string): Set<string> {
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
    return new Set(
      [
        state?.leadOf,
        link?.ledTeam,
        ...(this.#roster()
          ?.teams.filter(({ lead }) => lead === person)
          .map(({ id }) => id) ?? []),
      ].flatMap((team) => (team === undefined || team === null ? [] : [team]))
    );
  }

  /**
   * Takes what `person`'s map says a team they lead does (`mappedDoes`), a
   * model's answer from their interview, from staff too, in the
   * transaction of their withdrawal, delete or erasure, or of an approval
   * they took back (GRA-1748); a map drawn again gives it anew. The
   * team's pieces of work stay, kept for staff and for ids the company
   * settled or counted, but no longer stand (`#mapBacked`): nobody meets
   * them until the map is drawn again, which keeps only what it names
   * (GRA-1987).
   */
  #forgetMapOf(person: string): void {
    const led = [...this.#ledBy(person)];
    if (led.length > 0) {
      this.#db
        .update(teams)
        .set({ mappedDoes: null })
        .where(inArray(teams.id, led))
        .run();
    }
  }

  /**
   * Queues every text the voice was asked to say in `person`'s interview
   * to go from the cache (`#noteSpoken`), and forgets having said them, in
   * the transaction it is called in. A request for speech holds only its
   * text, never which line or statement it voices, so anything erased of
   * an interview takes all of its speech out: a cache, said again when
   * asked.
   */
  #queueSpokenOf(person: string): number {
    return this.#queueSpokenBy(eq(spokenKeys.who, `${linkWho}${person}`));
  }

  /**
   * Queues the keys noted (`#noteSpoken`) for whoever `who` matches, and
   * forgets them, in the transaction it is called in. Returns how many.
   */
  #queueSpokenBy(who: SQL): number {
    const keys = this.#db
      .delete(spokenKeys)
      .where(who)
      .returning({ key: spokenKeys.key })
      .all()
      .map(({ key }) => key);
    this.#queueLines(keys);
    return keys.length;
  }

  /** Keeps the voice's lines `keys` waiting to go, in the transaction it is called in. */
  #queueLines(keys: readonly string[]): void {
    for (const key of keys) {
      // A number never given before (`queuedKey`), on a new row and on
      // one queued again: a take-out already under way for the key, which
      // read it with another, leaves it to be asked once more.
      const held = this.ctx.storage.kv.get(queuedKey);
      const queued = (typeof held === "number" ? held : 0) + 1;
      this.ctx.storage.kv.put(queuedKey, queued);
      this.#db
        .insert(linesToForget)
        .values({ key, queued })
        .onConflictDoUpdate({ target: linesToForget.key, set: { queued } })
        .run();
    }
  }

  /**
   * What follows someone's interview going, once it's gone here: what is
   * left of the work it was in is drawn again, whom the claims and
   * drawings it was behind rested on is forgotten (`#forgetFallen`), and so
   * are the lines said in it that were kept. The lines are tried again by
   * the alarm until done (`#armDrawing`): they wait by their stored keys,
   * hashes, never what was said (`linesToForget`, GRA-329), queued by the
   * erasing transaction itself (`#erase`); one the voice says as it goes
   * is taken out once kept (speech.ts `keepUnlessErased`).
   */
  async #afterForget(): Promise<void> {
    await this.#armDrawing();
    // What the new Brain holds of their interview is decided again: an
    // erasure owed, before anything else (`owedErasures`).
    this.#decideInterviews();
    this.#forgetFallen();
    await this.forgetLinesNow();
  }

  /**
   * Takes the voice's lines kept by `stored` (hashes) out of the cache, now
   * or from the alarm until done: a line the voice said while what it
   * was said for was erased (speech.ts, `keepUnlessErased`).
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
        .select({ key: linesToForget.key, queued: linesToForget.queued })
        .from(linesToForget)
        .orderBy(asc(linesToForget.key))
        .limit(Onboarding.#linesPerTry)
        .all();
      if (page.length === 0) {
        return gone;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- one page at a time
        await forgetStored(
          this.env,
          page.map(({ key }) => key)
        );
      } catch (error) {
        log.error("onboarding.lines_unforgotten", {
          error: error instanceof Error ? error.name : "unknown",
        });
        // oxlint-disable-next-line no-await-in-loop -- once, as it stops
        await this.#alarmBy(Date.now() + purgeRetryMs);
        return gone;
      }
      // Each as read: one queued again meanwhile is asked once more.
      this.ctx.storage.transactionSync(() => {
        for (const { key, queued } of page) {
          this.#db
            .delete(linesToForget)
            .where(
              and(
                eq(linesToForget.key, key),
                queued === null
                  ? isNull(linesToForget.queued)
                  : eq(linesToForget.queued, queued)
              )
            )
            .run();
        }
      });
      gone += page.length;
    }
    // More than one call takes: the alarm takes the rest.
    await this.#alarmBy(Date.now() + purgeRetryMs);
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
    // Its events note nothing for the Brain: no note to try alone.
    const left = await drainObjectOutbox(this.env, this.ctx.storage.sql, 0);
    if (left === 0) {
      this.#auditRetryMs = auditRetryMs.first;
      return;
    }
    const retryMs = this.#auditRetryMs;
    this.#auditRetryMs = Math.min(retryMs * 2, auditRetryMs.most);
    await this.#alarmBy(Date.now() + retryMs);
  }
}
