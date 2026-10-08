import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import type { KickoffApi } from "./kickoff.ts";
import type {
  LogFilter,
  StaffLog,
  StaffNote,
  StaffOverview,
  StaffTranscript,
} from "./onboarding-staff.ts";

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
 * works council's yes, or that the company has none.
 */
export const agreementsSchema = z.strictObject({
  processing: z.boolean(),
  assessment: z.boolean(),
  council: z.enum(["agreed", "none", "waiting"]),
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
}

/** The onboarding, for the client's admin (Grasp staff included). */
export interface OnboardingApi {
  view: () => Promise<OnboardingView>;
  /** Replaces who works where. */
  saveRoster: (roster: RosterInput) => Promise<OnboardingView>;
  /** Sets when the interviews run; links go out by it. */
  savePlan: (plan: PlanInput) => Promise<OnboardingView>;
}

/** What only Grasp's staff do in an onboarding, the kickoff included. */
export interface OnboardingStaffApi extends KickoffApi {
  /** Stops the interviews: no link opens and none goes out. */
  pause: () => Promise<OnboardingView>;
  resume: () => Promise<OnboardingView>;
  setAgreements: (agreements: Agreements) => Promise<OnboardingView>;
  /**
   * A new start for someone who lost the device their interview was on:
   * what they said goes, and their link opens on the next device.
   */
  newStart: (person: string) => Promise<void>;
  /** Where the onboarding stands: its stages, what needs Grasp, Grasp's notes. */
  overview: () => Promise<StaffOverview>;
  /** What happened, the newest first, narrowed by `filter`. */
  log: (filter?: LogFilter) => Promise<StaffLog>;
  addNote: (text: string) => Promise<StaffNote>;
  /** Someone's interview; every read is in the audit log, without its words. */
  transcript: (person: string) => Promise<StaffTranscript>;
}

/** Why the onboarding refused something. */
export const onboardingErrors = defineErrorFamily({
  "onboarding.invalid": "That isn't something the onboarding takes.",
  "onboarding.staff_only": "Only Grasp's staff do that.",
  "onboarding.no_roster": "Add who works where first.",
  "onboarding.past": "The interviews can't start in the past.",
  "onboarding.no_link": "That person has no link out yet.",
  "onboarding.not_found": "Nobody on the list by that id.",
});
