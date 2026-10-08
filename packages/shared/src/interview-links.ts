import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { interviewerSchema } from "./onboarding.ts";
import type { InterviewKind } from "./onboarding.ts";

// Everyone who takes part in the onboarding has a link of their own
// (core's onboarding/links.ts). It opens their interview, and nothing
// else, on the first device that opens it, from the day it goes out until
// the interviews close. The link's secret is 256 bits, only ever in the
// URL's fragment and in request bodies; core keeps only its hash. The
// first device to open it is given a key of its own, also 256 bits, also
// kept only as a hash: from then on the interview opens, saves and
// deletes only with that key. Anyone else holding the link, the company's
// admin who handed it out included, sees that it is open elsewhere and
// nothing that was said.

/** Where the interview's page talks to core: one POST per action. */
export const interviewApiPath = "/api/interview";

/** Where an interview link leads: the page, with the secret after the `#`. */
export const interviewPagePath = "/interview";

/** A link's secret, or a device's key: 32 random bytes, base64url. */
export const interviewSecretSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u, "An interview link's secret");

/** The parts of an interview, in order. */
export const interviewPhases = [
  "open",
  "you",
  "anchor",
  "story",
  "steps",
  "exceptions",
  "numbers",
  "result",
  "readback",
] as const;

/** What a fact is about: the kinds Stephen marks in what someone says. */
export const factTags = [
  "step",
  "system",
  "handoff",
  "wait",
  "exception",
  "rule",
  "judgment",
  "workaround",
  "ai",
  "wish",
  "number",
  "done",
  "stop",
  "case",
  "term",
  "next",
  "work",
] as const;

/** Where someone invited stands. */
export const personStates = [
  "invited",
  "opened",
  "progress",
  "incomplete",
  "completed",
  "expired",
] as const;

/** How Stephen says a line. */
export const voiceTags = [
  "warm, relaxed",
  "sincere, steady",
  "curious, gently",
  "softly",
  "interested, a little lighter",
  "patient",
  "neutral, light",
  "upbeat, understanding",
  "upbeat, reassuring",
  "sincere, steady, reassuring",
  "amused, soft chuckle",
  "warm",
  "easy, light",
  "clear, measured pace",
  "warm, grateful",
  "warm, kind",
] as const;

/** The most lines and facts one interview keeps, and the longest of each. */
export const interviewLimits = {
  lines: 400,
  facts: 200,
  marks: 40,
  line: 4000,
  fact: 300,
  file: 200,
} as const;

const factTagSchema = z.enum(factTags);

/** One line said in an interview: Stephen's, or the person's. */
export const interviewLineSchema = z.strictObject({
  from: z.enum(["stephen", "person"]),
  text: z.string().max(interviewLimits.line),
  /** A person's line that was typed, not heard. */
  typed: z.literal(true).optional(),
  /** In a person's line: what Stephen marked in it. */
  marks: z
    .array(
      z.strictObject({
        quote: z.string().max(interviewLimits.fact),
        tag: factTagSchema,
      })
    )
    .max(interviewLimits.marks)
    .optional(),
  /** A file they shared with this line, by its name. */
  file: z.string().max(interviewLimits.file).optional(),
  /** How Stephen said his line. */
  tone: z.enum(voiceTags).optional(),
});
export type InterviewLine = z.output<typeof interviewLineSchema>;

/** One thing Stephen understood, as he reads it back. */
export const interviewFactSchema = z.strictObject({
  id: z.string().regex(/^[a-z]\d{1,4}$/u),
  tag: factTagSchema,
  /** As he reads it back, in their language. */
  text: z.string().trim().min(1).max(interviewLimits.fact),
  /** The same as the record keeps it, in English. */
  record: z.string().max(interviewLimits.fact),
  /** Taken out by the person in the read-back. */
  out: z.literal(true).optional(),
  /** Said in the read-back where it was missing: the part it goes in. */
  pin: z
    .int()
    .min(0)
    .max(interviewLimits.facts - 1)
    .optional(),
  /** Read back and agreed to before. */
  agreed: z.literal(true).optional(),
});
export type InterviewFact = z.output<typeof interviewFactSchema>;

/**
 * Where someone's interview is, as their page keeps it and sends it to be
 * kept. Checked item by item: a save with anything else in it, or more of
 * it than an interview holds, is refused whole.
 */
export const interviewProgressSchema = z.strictObject({
  person: z.enum(personStates),
  told: z.boolean(),
  mode: z.enum(["talk", "type"]).nullable(),
  lines: z.array(interviewLineSchema).max(interviewLimits.lines),
  facts: z
    .array(interviewFactSchema)
    .max(interviewLimits.facts)
    .refine(
      (facts) => new Set(facts.map(({ id }) => id)).size === facts.length,
      "Each fact once"
    ),
  phase: z.enum(interviewPhases),
  wants: z.enum(["answer", "file", "readback", "end"]),
  /** When they started talking, in ms since the epoch. */
  startedAt: z.number().nonnegative().nullable(),
  confirmed: z.int().min(0).max(interviewLimits.facts),
  adding: z.boolean(),
  addedAt: z.number().nonnegative(),
  /** How they found it, from 1 to 5, when they said so. */
  rating: z.int().min(1).max(5).optional(),
  interviewer: interviewerSchema.optional(),
});
export type InterviewProgress = z.output<typeof interviewProgressSchema>;

/** The most one save may carry, as its request's bytes. */
export const interviewRequestMaxBytes = 768 * 1024;

/** What the interview's page sends. */
export const interviewRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("session"),
    secret: interviewSecretSchema,
    /** This device's key, once it was given one. */
    key: interviewSecretSchema.optional(),
  }),
  z.strictObject({
    action: z.literal("save"),
    secret: interviewSecretSchema,
    key: interviewSecretSchema,
    /** The version this copy was saved as, 0 before it ever was. */
    version: z.int().min(0),
    progress: interviewProgressSchema,
  }),
  z.strictObject({
    action: z.literal("delete"),
    secret: interviewSecretSchema,
    key: interviewSecretSchema,
  }),
]);
export type InterviewRequest = z.input<typeof interviewRequestSchema>;

/** What a link opens on the device it is on. */
export interface InterviewSession {
  state: "open";
  /** This device's key, given once, the first time a device opens the link. */
  key?: string;
  /** Their first name, their team, and their lead's first name. */
  name: string;
  team: string;
  lead: string | null;
  kind: InterviewKind;
  /** The last day the link takes anything, as an ISO day. */
  closes: string;
  /** The interviews are over: what was said can be read and deleted, no more. */
  closed: boolean;
  /** What was said, none before anything was saved. */
  progress: InterviewProgress | null;
  version: number;
}

/** What a link answers anyone but the device it is on: nothing that was said. */
export interface InterviewElsewhere {
  state: "elsewhere";
}

/** What saving answers: the version kept, or the newer copy that was. */
export type InterviewSaved =
  | { saved: true; version: number }
  | { saved: false; version: number; progress: InterviewProgress | null };

/** Why an interview link refused something. */
export const interviewErrors = defineErrorFamily({
  "interview.link_invalid":
    "This link doesn't work. Ask whoever sent it for a new one.",
  "interview.not_yet":
    "Your interview isn't open yet. You'll get an email when it is.",
  "interview.paused":
    "The interviews are paused for now. Try again a little later.",
  "interview.closed": "The interviews are over. Thank you for your time.",
  "interview.elsewhere":
    "This interview is open on another device. Carry on there.",
  "interview.deleted":
    "You deleted this interview. Start again to talk with Stephen.",
  "interview.limited": "That was a lot at once. Wait a minute, then go on.",
  "interview.invalid": "That isn't something an interview takes.",
});
