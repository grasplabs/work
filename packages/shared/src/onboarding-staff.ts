import { z } from "zod";

import { SETTLERS } from "./admin/onboarding-admin.ts";
import type { OrgRules } from "./admin/onboarding-admin.ts";
import { heardAnswers } from "./admin/org-record.ts";
import type { DrawnWork, WorkRecord } from "./admin/org-record.ts";
import { answerMaxLength, kickoffTeamNameMaxLength } from "./kickoff.ts";
import { interviewLocaleSchema } from "./onboarding.ts";

// What Grasp's staff steer and read of a client's onboarding, from the
// admin (admin-command.ts, admin-snapshot.ts): how Stephen is set up, the
// organization's rules and the drawn work.

/**
 * The most lines in each of Stephen's lists, and the longest line: as long
 * as what the kickoff suggests can be (the sponsor's answer, a team's
 * name), so a suggestion is kept whole, never cut, when staff save it.
 */
export const stephenLimitsMax = 30;
export const stephenTermsMax = 100;
export const stephenLimitMaxLength = answerMaxLength;
export const stephenTermMaxLength = kickoffTeamNameMaxLength;

const linesOf = (most: number, longest: number) =>
  z
    .array(z.string().trim().min(1).max(longest))
    .max(most)
    .refine((lines) => new Set(lines).size === lines.length, {
      message: "A line twice",
    });

/**
 * How Stephen is set up for this deployment, in every interview he holds:
 * the languages he interviews in, what he leaves alone, and the words he
 * has to know to hear them right (tools, products, the company's terms).
 */
export const stephenSetupSchema = z.strictObject({
  languages: z
    .array(interviewLocaleSchema)
    .min(1)
    .refine((languages) => new Set(languages).size === languages.length, {
      message: "A language twice",
    }),
  limits: linesOf(stephenLimitsMax, stephenLimitMaxLength),
  terms: linesOf(stephenTermsMax, stephenTermMaxLength),
});
export type StephenSetup = z.output<typeof stephenSetupSchema>;

/** Stephen's setup as staff see it. */
export interface StephenSetupView {
  /** What holds in every interview: staff's, or else what the kickoff suggests. */
  setup: StephenSetup;
  /** Staff changed it; null-saving takes it back to `suggested`. */
  changed: boolean;
  /** What the kickoff suggests: its limits, and the teams it named as words. */
  suggested: StephenSetup;
  /** What the kickoff said of the languages and the tools, to set him by. */
  kickoff: { languages: string | null; systems: string | null };
}

/**
 * When a piece of work counts as known at this organization, as staff set
 * it (`OrgRules`): how many people must have told a step, how many
 * interviews before it is checked, the share of new facts under which it
 * stops, after how many it is better split in two, how many of the last
 * interviews are looked at, and who settles a difference nobody can
 * explain.
 */
export const orgRulesSchema = z.strictObject({
  people: z.int().min(1).max(10),
  minInterviews: z.int().min(1).max(30),
  stopShare: z.number().min(0).max(1),
  maxInterviews: z.int().min(1).max(50),
  run: z.int().min(1).max(10),
  settles: z.enum(SETTLERS),
}) satisfies z.ZodType<OrgRules>;

/**
 * Every piece of work as staff see it: as each team's map holds it, with
 * its drawing (each person's own numbers in `drawn.told`, and what the
 * next interviews still need to ask in `drawn.open`), this organization's
 * rules, and the pieces Grasp counts as known by hand.
 */
export interface StaffWorks {
  works: WorkRecord[];
  rules: OrgRules;
  /** Pieces of work Grasp counts as known by hand, by id. */
  counted: string[];
}

const triple = z.tuple([z.number(), z.number(), z.number()]);

/** A drawing as the store keeps it, read back. */
export const drawnWorkSchema = z.object({
  at: z.string(),
  from: z.array(z.string()),
  starts: z.string(),
  steps: z.array(
    z.object({
      text: z.string(),
      who: z.string(),
      tool: z.string(),
      minutes: triple.nullable(),
      documented: z.boolean(),
    })
  ),
  waits: z.array(z.string()),
  differently: z.array(
    z.object({
      when: z.string(),
      does: z.string(),
      outOfTen: z.number().nullable(),
      after: z.number(),
    })
  ),
  decides: z.string(),
  own: z.string(),
  ai: z.string(),
  right: z.string(),
  ask: z.string(),
  next: z.string(),
  term: z.object({ word: z.string(), meaning: z.string() }).nullable(),
  differs: z
    .object({
      step: z.number(),
      other: z.string(),
      why: z.enum(["condition", "place", "conflict"]),
      because: z.string(),
    })
    .nullable(),
  per: z.enum(["week", "month"]),
  unit: z.enum(["minutes", "hours"]),
  heard: z.partialRecord(z.enum(heardAnswers), z.array(z.string())).optional(),
  told: z.record(
    z.string(),
    z.object({
      start: z.boolean(),
      steps: z.array(z.number()),
      end: z.boolean(),
      way: z.object({ step: z.number(), other: z.boolean() }).nullable(),
      waits: z.array(z.number()),
      differently: z.array(z.number()),
      decides: z.boolean(),
      own: z.boolean(),
      ai: z.boolean(),
      volume: z.tuple([z.number(), z.number()]).nullable(),
      volumeOf: z.enum(["me", "team", "unknown"]).optional(),
      takes: triple.nullable(),
      wrong: z.number().nullable(),
      right: z.boolean(),
      ask: z.boolean(),
      next: z.boolean(),
      example: z.string().nullable(),
      term: z.boolean(),
      out: z.array(z.string()),
      stepMinutes: z
        .array(
          z.object({
            step: z.number(),
            minutes: triple,
            normal: z.number().nullable().optional(),
          })
        )
        .optional(),
      gave: z
        .object({
          quiet: z.number().nullable(),
          busy: z.number().nullable(),
          per: z.enum(["week", "month"]).nullable(),
          takes: z.tuple([
            z.number().nullable(),
            z.number().nullable(),
            z.number().nullable(),
          ]),
        })
        .optional(),
      caseShares: z
        .array(z.object({ case: z.number(), outOfTen: z.number() }))
        .optional(),
    })
  ),
  open: z.array(z.string()),
}) satisfies z.ZodType<DrawnWork>;

/**
 * Every piece of work as staff read it (`StaffWorks`), checked on its way
 * out of core (its staff RPC and the admin snapshot): only what the
 * schema names leaves it.
 */
export const staffWorksSchema = z.object({
  works: z.array(
    z.object({
      id: z.string(),
      team: z.string(),
      name: z.string(),
      local: z.string().optional(),
      item: z.tuple([z.string(), z.string()]),
      doers: z.array(z.string()),
      share: z.number(),
      from: z.enum(["lead", "grasp"]),
      drawn: drawnWorkSchema.nullable(),
      stale: z.boolean(),
    })
  ),
  rules: orgRulesSchema,
  counted: z.array(z.string()),
}) satisfies z.ZodType<StaffWorks>;
