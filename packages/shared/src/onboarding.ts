import { z } from "zod";

import type { AdminSnapshot } from "./admin-snapshot.ts";
import type { OrgRules } from "./admin/onboarding-admin.ts";
import type { OnboardingDirectoryApi } from "./directory.ts";
import type { OnboardingPlacesApi } from "./document-places.ts";
import { defineErrorFamily } from "./errors.ts";
import type { OnboardingHrApi } from "./hr.ts";
import type { KickoffApi } from "./kickoff.ts";
import type { OnboardingChoicesApi } from "./onboarding-choices.ts";
import type { OnboardingContext } from "./onboarding-context.ts";
import type { OnboardingDocumentsApi } from "./onboarding-documents.ts";
import type {
  OrganizationChangeInput,
  StaffOrganization,
} from "./onboarding-organization.ts";
import type {
  LogFilter,
  StaffAgreements,
  StaffAiUseRow,
  StaffInterviewers,
  StaffLog,
  StaffNote,
  StaffOverview,
  StaffInterview,
  StaffWorks,
  StephenSetup,
  StephenSetupView,
} from "./onboarding-staff.ts";
import type { onboardingStages } from "./onboarding-summary.ts";

// The onboarding's interviews: Stephen, or Claire if the person prefers,
// talks with every team lead and then with everyone else, in the language
// they choose. Shared by core, which holds the interviews, and the web
// app, which shows them.

/** The languages an interview is held in: the ones the frontend speaks. */
export const interviewLocales = ["en", "nl", "de", "fr", "es"] as const;
export const interviewLocaleSchema = z.enum(interviewLocales);
export type InterviewLocale = z.infer<typeof interviewLocaleSchema>;

/**
 * Who holds an interview. It is one interview either way: the same
 * questions in the same order under the same rules, so what two people
 * told two interviewers can be laid side by side. What differs is the
 * person: the voice, the face, and how they react.
 */
export const interviewers = ["stephen", "claire"] as const;
export const interviewerSchema = z.enum(interviewers);
export type Interviewer = z.infer<typeof interviewerSchema>;

/** Who holds an interview when nobody chose. */
export const firstInterviewer: Interviewer = "stephen";

/** What each is called: a name, the same in every language. */
export const interviewerNames: Record<Interviewer, string> = {
  stephen: "Stephen",
  claire: "Claire",
};

/**
 * What an interview is about: someone's own piece of work, or, with a team
 * lead, the work of their whole team.
 */
export const interviewKinds = ["own", "lead"] as const;
export const interviewKindSchema = z.enum(interviewKinds);
export type InterviewKind = z.infer<typeof interviewKindSchema>;

/** The mark of the text that spoke: its SHA-256, in hex. */
export const interviewerTextMarkSchema = z.string().regex(/^[0-9a-f]{64}$/u);

// The onboarding's store (core's onboarding/store.ts): one per deployment.
// Its admin gives it the people and the plan, and reads back numbers per
// team, never anyone's words and never who did or did not talk. Grasp's
// staff pause the interviews and mark the agreements in place.

/** The most people and teams one onboarding takes. */
export const onboardingPeopleMax = 2000;
export const onboardingTeamsMax = 120;

/** Teams smaller than this show the company no numbers of their own. */
export const minTeamShown = 5;

/**
 * Fewer than this many who talked show as none known: the admin controls
 * the list, so made-up people could fill a team to five asked, and one or
 * two who talked would stand out.
 */
export const minTalkedShown = 3;

/**
 * A team's links go out once its lead has talked; after this many working
 * days without the lead they go out anyway.
 */
export const leadWaitWorkingDays = 3;

/**
 * Whoever hasn't finished this many working days after their link went
 * out gets one reminder, while the interviews run. Then nothing more.
 */
export const remindAfterWorkingDays = 3;

/** How long the interviews run, in days: by default, and at least and most. */
export const planDays = { usual: 14, least: 5, most: 42 } as const;

const nameSchema = z.string().trim().min(1).max(80);
const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,60}$/u, "Letters, digits, - and _ only");

/** A team, as the staff list and its admin have it. */
export const rosterTeamSchema = z.strictObject({
  id: idSchema,
  name: nameSchema,
  /** Its lead, by person: someone in the team. */
  lead: idSchema.nullable(),
  /** What it does, once its lead said so. */
  does: z.string().trim().max(200).default(""),
  /** Not taking part: nobody in it gets a link. */
  off: z.boolean().default(false),
});
export type RosterTeam = z.output<typeof rosterTeamSchema>;

/** Someone who works there. */
export const rosterPersonSchema = z.strictObject({
  id: idSchema,
  name: nameSchema,
  /** Empty when they have none: their link is handed to them on paper. */
  email: z.union([z.literal(""), z.email().max(120)]).default(""),
  team: idSchema,
  title: z.string().trim().max(80).default(""),
  /** Away these weeks: they get no link, and nothing waits for them. */
  away: z.boolean().default(false),
});
export type RosterPerson = z.output<typeof rosterPersonSchema>;

/**
 * Who works where: every person in a team that exists, every lead in their
 * own team, and no more than the onboarding takes.
 */
export const rosterSchema = z
  .strictObject({
    teams: z.array(rosterTeamSchema).min(1).max(onboardingTeamsMax),
    people: z.array(rosterPersonSchema).min(1).max(onboardingPeopleMax),
  })
  .superRefine(({ teams, people }, context) => {
    const teamIds = new Set<string>();
    for (const [index, team] of teams.entries()) {
      if (teamIds.has(team.id)) {
        context.addIssue({
          code: "custom",
          path: ["teams", index, "id"],
          message: "Two teams have this ID",
        });
      }
      teamIds.add(team.id);
    }
    const teamOf = new Map<string, string>();
    for (const [index, person] of people.entries()) {
      if (teamOf.has(person.id)) {
        context.addIssue({
          code: "custom",
          path: ["people", index, "id"],
          message: "Two people have this ID",
        });
      }
      if (!teamIds.has(person.team)) {
        context.addIssue({
          code: "custom",
          path: ["people", index, "team"],
          message: "No such team",
        });
      }
      teamOf.set(person.id, person.team);
    }
    for (const [index, team] of teams.entries()) {
      if (team.lead !== null && teamOf.get(team.lead) !== team.id) {
        context.addIssue({
          code: "custom",
          path: ["teams", index, "lead"],
          message: "The lead is not in the team",
        });
      }
    }
  });
export type Roster = z.output<typeof rosterSchema>;
export type RosterInput = z.input<typeof rosterSchema>;

/** Whose links the admin took to send, by person. */
export const linksTakenSchema = z.array(idSchema).max(onboardingPeopleMax);

/**
 * When the interviews run: from the start day, for so many days. The leads'
 * links go out at `at` (by default the start of the start day); a team in
 * `later` goes at its own moment, or waits while that is null.
 */
export const planSchema = z.strictObject({
  start: z.iso.date(),
  days: z
    .number()
    .int()
    .min(planDays.least)
    .max(planDays.most)
    .default(planDays.usual),
  at: z.iso.datetime().optional(),
  later: z
    .record(idSchema, z.iso.datetime().nullable())
    .refine((later) => Object.keys(later).length <= onboardingTeamsMax, {
      message: "Too many teams",
    })
    .optional(),
});
export type Plan = z.output<typeof planSchema>;
export type PlanInput = z.input<typeof planSchema>;

/**
 * The agreements that must be in place before any link opens or goes out:
 * the data processing agreement, the company's risk assessment, and the
 * works council's yes, or that the company has none. Each with the day it
 * was signed, signed off or heard, once it was (`…On`): optional, as
 * agreements kept before they had one have none.
 */
export const agreementsSchema = z.strictObject({
  processing: z.boolean(),
  assessment: z.boolean(),
  council: z.enum(["agreed", "none", "waiting"]),
  processingOn: z.iso.date().optional(),
  assessmentOn: z.iso.date().optional(),
  councilOn: z.iso.date().optional(),
});
export type Agreements = z.output<typeof agreementsSchema>;

/** One team as the company's admin sees it: how many talked, never who. */
export interface TeamProgress {
  id: string;
  name: string;
  people: number;
  off: boolean;
  /** Whether the lead has talked: the company knows its own leads. */
  leadTalked: boolean;
  /**
   * How many talked, and how many were asked, as of the start of today:
   * `null` for a team under {@link minTeamShown}, and `talked` also
   * while under {@link minTalkedShown}.
   */
  talked: number | null;
  asked: number | null;
}

/** Where the interviews stand, as the company's admin may see it. */
export interface OnboardingProgress {
  teams: TeamProgress[];
  /** The teams of five or more together, and the leads apart. */
  talked: number;
  asked: number;
  leadsTalked: number;
  leads: number;
  /** The day the numbers are of: they move at most once a day. */
  asOf: string;
}

/** The onboarding as its admin sees it. */
export interface OnboardingView {
  roster: Roster | null;
  plan: Plan | null;
  progress: OnboardingProgress | null;
  /** The agreements are in place: until then no link opens or goes out. */
  agreed: boolean;
  /** Grasp paused the interviews: no link opens and none goes out. */
  paused: boolean;
  /**
   * The sponsor's first name, when the kickoff named them; null before it
   * is in, or when it did not. The one word of the kickoff the admin sees.
   */
  sponsor: string | null;
  /**
   * What the kickoff told about the company that the onboarding speaks
   * of: its suites and places, and Stephen's words about its work. Empty
   * before the kickoff is in, or where it said nothing of it.
   */
  context: OnboardingContext;
  /**
   * How many who take part wait for the admin to confirm the organization
   * before their link can go out: new on a list saved while a plan was set.
   */
  waiting: number;
  /**
   * Whether the deployment can send mail where it runs: false where
   * nothing is bound to send it, as on hosting where mail isn't available
   * yet. Links then go out by hand alone.
   */
  mailSends: boolean;
}

/**
 * How the admin settles a piece of work its people told two ways, when
 * nobody could say why: both ways kept, or which way holds, the way most
 * told it (`first`) or the other.
 */
export const settleChoices = ["both", "first", "other"] as const;
export type SettleChoice = (typeof settleChoices)[number];

export const settleSchema = z.strictObject({
  work: z.string().min(1).max(64),
  holds: z.enum(settleChoices),
});

/**
 * A step of a piece of work that its people told two ways, and nobody
 * could say why: what only the admin can settle. Never who told which way.
 */
export interface Difference {
  /** The piece of work's id. */
  work: string;
  /** The piece of work, in the company's own words. */
  name: string;
  /** The team that does it. */
  team: string;
  /** The step as most told it. */
  way: string;
  /** The other way some told it. */
  other: string;
  /** How the admin settled it; null while it is open. */
  holds: SettleChoice | null;
}

/** What needs the admin once the interviews are done, and what Stephen thanks them with. */
export interface OnboardingReview {
  /** The differences nobody could explain, in the teams that take part. */
  differences: Difference[];
  /** How many pieces of work are drawn from what their people agreed to. */
  mapped: number;
}

/**
 * Someone's own link, as the company's admin takes it to send themselves:
 * from their own email or chat, or on paper to whoever has no address.
 * Grasp emails each link on its day as well; the admin's list is for
 * whoever they would rather reach themselves.
 */
export interface LinkToSend {
  person: string;
  name: string;
  /** Their team's name. */
  team: string;
  /** Empty when they have none. */
  email: string;
  /** The link's path, its secret after the `#`; null while it isn't out. */
  path: string | null;
  /** Out, and not taken by the admin since: new since they last took links. */
  fresh: boolean;
  /** Their latest mail from Grasp, when it failed; null otherwise. */
  failedMail: FailedMail | null;
}

/**
 * Someone's latest mail from Grasp (their link, or the reminder), when it
 * failed for good: which, why as the mail service said it, and when.
 * Never its words or its address. Staff send it again (`sendMailAgain`)
 * once what stopped it is put right.
 */
export interface FailedMail {
  kind: "link" | "reminder";
  /** The mail service's code, or core's own (`mail.unfilled`); null when it gave none. */
  reason: string | null;
  /** When it failed (ISO 8601). */
  at: string;
}

/** How many weeks the programme with Grasp runs. */
export const programmeWeeks = 8;

/** When the next weekly report is ready, and what it is about. */
export interface NextReport {
  /** Days from today until a report is ready; 0 on the day it is. */
  inDays: number;
  /** The week it is on: the one that just closed when it is ready, otherwise the one that runs. */
  week: number;
  /** How many of that week's seven days have passed, 0 to 7; 7 on the day it is ready. */
  through: number;
}

/** The days a weekly report is about, as run activity reads them. */
export interface ReportWindow {
  /** Its last day, `YYYY-MM-DD`. */
  to: string;
  /** How many days, up to and with `to`. */
  days: number;
}

/**
 * The programme with Grasp, as the dashboard shows it to everyone signed
 * in: when it began, where the onboarding stands, and where today falls
 * in its weeks and its weekly reports, nothing more. It begins on the
 * Monday (UTC) of the week the interviews start, and runs in weeks from
 * there; a week's report is ready on the first day of the week after it.
 * Core counts the days (onboarding/cadence.ts), so every page says the
 * same week.
 */
export interface Programme {
  /** Its first day, a Monday: `YYYY-MM-DD`. */
  start: string;
  weeks: typeof programmeWeeks;
  /**
   * Where the onboarding stands (`onboarding-summary.ts`): being prepared,
   * the interviews running, waiting for Grasp's go, or open; null when
   * none has begun.
   */
  stage: Exclude<(typeof onboardingStages)[number], "none"> | null;
  /** Today, as the programme counts days (UTC): `YYYY-MM-DD`. */
  today: string;
  /** The week today is in, from 1: week 1 before it begins, and on past its last. */
  week: number;
  /** Whether `week` is one of the programme's own, so the line counts it "of 8". */
  inProgramme: boolean;
  /** The next weekly report. */
  nextReport: NextReport;
  /** What the next weekly report is about: its week's days up to today. */
  reportWindow: ReportWindow;
}

/**
 * The onboarding, for the client's admin (Grasp staff included); its
 * programme for everyone signed in.
 */
export interface OnboardingApi
  extends
    OnboardingDocumentsApi,
    OnboardingDirectoryApi,
    OnboardingChoicesApi,
    OnboardingPlacesApi,
    OnboardingHrApi {
  /** The programme, for the dashboard; null without a plan. Any role. */
  programme: () => Promise<Programme | null>;
  view: () => Promise<OnboardingView>;
  /**
   * Replaces who works where. While a plan is set, whoever is new on it
   * gets no link until the admin confirms the organization.
   */
  saveRoster: (roster: RosterInput) => Promise<OnboardingView>;
  /** Replaces who works where, as the admin confirmed it: nobody waits for that any more. */
  confirmRoster: (roster: RosterInput) => Promise<OnboardingView>;
  /** Sets when the interviews run; links go out by it. */
  savePlan: (plan: PlanInput) => Promise<OnboardingView>;
  /** What only the admin can settle, and how much of the work is mapped. */
  review: () => Promise<OnboardingReview>;
  /** Settles a piece of work told two ways: both kept, or which holds. */
  settle: (work: string, holds: SettleChoice) => Promise<OnboardingReview>;
  /** Everyone who takes part, with their link once it is out. */
  links: () => Promise<LinkToSend[]>;
  /** The admin took these people's links to send: they are new no more. */
  linksTaken: (people: string[]) => Promise<void>;
}

/** What only Grasp's staff do in an onboarding, the kickoff included. */
export interface OnboardingStaffApi extends KickoffApi {
  /** Stops the interviews: no link opens and none goes out. */
  pause: () => Promise<OnboardingView>;
  resume: () => Promise<OnboardingView>;
  /** Where the agreements stand, and the links that wait for them. */
  agreements: () => Promise<StaffAgreements>;
  /** Records where the agreements stand; once all are in, the links due go out. */
  setAgreements: (agreements: Agreements) => Promise<OnboardingView>;
  /** How Stephen is set up for this deployment, and what the kickoff suggests. */
  stephen: () => Promise<StephenSetupView>;
  /** Sets how Stephen is set up; null takes him back to what the kickoff suggests. */
  saveStephen: (setup: StephenSetup | null) => Promise<StephenSetupView>;
  /**
   * A new start for someone who lost the device their interview was on:
   * what they said goes, and their link opens on the next device.
   */
  newStart: (person: string) => Promise<void>;
  /**
   * Sends someone's mail that failed (their link, or the reminder) again,
   * once whatever stopped it is put right.
   */
  sendMailAgain: (person: string) => Promise<void>;
  /** Where the onboarding stands: its stages, what needs Grasp, Grasp's notes. */
  overview: () => Promise<StaffOverview>;
  /** What happened, the newest first, narrowed by `filter`. */
  log: (filter?: LogFilter) => Promise<StaffLog>;
  addNote: (text: string) => Promise<StaffNote>;
  /**
   * Where someone's interview stands, and its numbers: never a word of it
   * (GRA-329). Every look is in the audit log, as it names them.
   */
  interview: (person: string) => Promise<StaffInterview>;
  /**
   * Where everyone stands with their link and their interview, by name, as
   * Grasp's admin reads it: numbers, never anyone's words. It names
   * people, so every read is in the audit log.
   */
  interviews: () => Promise<AdminSnapshot>;
  /**
   * Someone's own link, for staff to send them by hand: its path, the
   * secret after the `#`. Every read is in the audit log, without it.
   */
  link: (person: string) => Promise<string>;
  /**
   * Notes the one reminder as sent by hand to each of `people` whose link
   * is out, who hasn't finished and wasn't reminded yet. Returns how many.
   */
  remind: (people: string[]) => Promise<number>;
  /** A team that didn't take part takes part: its lead's link goes out first. */
  askIn: (team: string) => Promise<OnboardingView>;
  /**
   * Deletes someone's interview because they asked: what they said is
   * gone, and their link opens a new one.
   */
  deleteInterview: (person: string) => Promise<void>;
  /** How Stephen and Claire are doing, as numbers: never who said what. */
  interviewers: () => Promise<StaffInterviewers>;
  /** The AI the onboarding used, by day, purpose and model. */
  aiUse: () => Promise<StaffAiUseRow[]>;
  /**
   * The organization as Grasp knows it, team by team: it names people, so
   * every read is in the audit log.
   */
  organization: () => Promise<StaffOrganization>;
  /** Puts the list right, one change at a time; each is in the log. */
  changeOrganization: (change: OrganizationChangeInput) => Promise<void>;
  /**
   * Every piece of work as drawn from what its people agreed to, with
   * this organization's rules for when one is known and the pieces Grasp
   * counts as known by hand. It holds what people said, by name, so every
   * read is in the audit log.
   */
  works: () => Promise<StaffWorks>;
  /** Sets when a piece of work counts as known here; null takes the starting values back. */
  setRules: (rules: OrgRules | null) => Promise<void>;
  /** Counts a piece of work as known by hand, or leaves it to the rules again. */
  countAsKnown: (work: string, counted: boolean) => Promise<void>;
  /** Draws a piece of work again from everything its people agreed to. */
  drawWorkAgain: (work: string) => Promise<void>;
}

/** Why the onboarding refused something. */
export const onboardingErrors = defineErrorFamily({
  "onboarding.invalid": "That isn't something the onboarding takes.",
  "onboarding.staff_only": "Only Grasp's staff do that.",
  "onboarding.no_roster": "Add who works where first.",
  "onboarding.past": "The interviews can't start in the past.",
  "onboarding.no_link": "That person has no link out yet.",
  "onboarding.not_found": "Nobody on the list by that id.",
  "onboarding.no_team": "No team on the list by that id.",
  "onboarding.team_taken": "There is a team with this name already.",
  "onboarding.no_work": "That piece of work isn't on their team's map.",
  "onboarding.not_now":
    "No link goes out while the interviews are paused, before the agreements are in, or to someone who doesn't take part.",
  "onboarding.no_map":
    "The team's lead hasn't agreed to anything to draw its map from yet.",
  "onboarding.no_failed_mail": "That person has no mail that failed.",
  "onboarding.no_difference":
    "Nothing about that piece of work needs settling.",
  "onboarding.nothing_to_draw":
    "Nobody who does that work has agreed to anything yet.",
  "onboarding.agreements_kept":
    "The team is told: what was agreed stays as it was agreed.",
});
