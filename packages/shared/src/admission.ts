import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// Knowledge admission's exclusion topics: what is never stored in the
// company brain. The platform's own (health, pay and the other sensitive
// categories) are Grasp's and can't be changed; a company adds its own,
// each detected by the words and phrases it lists. Every change is a new
// revision, effective a minute after it's saved at the earliest, so a
// write already being checked can't commit under a policy it never saw.
// Exclusion topics aren't statement categories: they decide what is never
// stored, not how a stored statement is filed.

/** The product's languages, which a topic's examples are in. */
export const admissionLanguages = ["en", "nl", "de", "fr", "es"] as const;
export type AdmissionLanguage = (typeof admissionLanguages)[number];

/**
 * How long after it's saved a topic revision takes effect at the earliest:
 * a write checks the policy in effect over this window ahead (admission.ts).
 */
export const topicLeadMs = 60_000;

/** Who owns a topic: Grasp's platform minimum, or the company. */
export type TopicOwner = "platform" | "company";

/** An example of what a topic covers, in one language. */
export const topicExampleSchema = z.strictObject({
  language: z.enum(admissionLanguages),
  text: z.string().trim().min(1).max(500),
});
export type TopicExample = z.infer<typeof topicExampleSchema>;

/** A company topic's ID: `company-` and a UUID. */
export const companyTopicIdSchema = z
  .string()
  .regex(
    /^company-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
  );

/** A run of spaces and hyphens: one gap between a term's words. */
const termGap = /[\s-]+/gu;
const notLetter = /[^\p{L}\p{N}]/gu;

/** The letters and digits a term's stem needs before its `*`, at least. */
export const topicStemMinLength = 3;

/** The letters and digits of `word`. */
const lettersOf = (word: string): number =>
  word.replaceAll(notLetter, "").length;

/**
 * A word or phrase a company topic is detected by, matched as whole words,
 * whatever their case or accents; a trailing `*` matches any ending
 * ("reorgani*": "reorganisation", "reorganization") of a stem of at least
 * `topicStemMinLength` letters, so one can't match most words. Each run
 * of spaces and hyphens is one gap between words ("covid - 19" is "covid
 * 19"), as admission reads text: one gap is what keeps its detector
 * linear in the text (admission.ts's `termsPattern`).
 */
export const topicTermSchema = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}' .-]*\*?$/u)
  .transform((term) => {
    const stem = term.endsWith("*");
    const words = (stem ? term.slice(0, -1) : term)
      .replaceAll(termGap, " ")
      .trim();
    return stem ? `${words}*` : words;
  })
  .refine((term) => (term.endsWith("*") ? term.length - 1 : term.length) >= 2)
  .refine(
    (term) =>
      !term.endsWith("*") ||
      lettersOf(term.slice(0, -1).split(" ").at(-1) ?? "") >=
        topicStemMinLength,
    { message: `A stem needs ${topicStemMinLength} letters before its *.` }
  );

/** Most terms one company topic lists. */
export const topicMaxTerms = 200;

/** Most company topics in use at once: the gate reads them all per write. */
export const topicMaxActive = 100;

/**
 * Most company topic revisions saved but not yet in effect, all topics'
 * together: the gate reads those too.
 */
export const topicMaxPending = 100;

/**
 * A company topic, new (`ifRevision` 0, no `id`) or its next revision
 * (`id` and the revision it was read at). `effectiveAt`: from when, never
 * sooner than `topicLeadMs` from now (a sooner time is moved to it).
 */
export const topicInputSchema = z.strictObject({
  id: companyTopicIdSchema.optional(),
  ifRevision: z.int().min(0),
  name: z.string().trim().min(1).max(100),
  coverage: z.string().trim().min(1).max(1000),
  examples: z.array(topicExampleSchema).min(1).max(50),
  terms: z.array(topicTermSchema).min(1).max(topicMaxTerms),
  effectiveAt: z.iso.datetime().optional(),
});
export type TopicInput = z.infer<typeof topicInputSchema>;

/** Retiring a company topic, from the revision it was read at. */
export const topicRetireSchema = z.strictObject({
  id: companyTopicIdSchema,
  ifRevision: z.int().min(1),
});
export type TopicRetire = z.infer<typeof topicRetireSchema>;

/** A topic's revision, as admins see it. */
export interface AdmissionTopic {
  id: string;
  revision: number;
  name: string;
  coverage: string;
  examples: TopicExample[];
  /** The words it's detected by: a company topic's; empty for Grasp's. */
  terms: string[];
  owner: TopicOwner;
  effectiveAt: string;
  /** Whether this revision ends the topic. */
  retired: boolean;
  /** Who saved it: a person's ID, or `null` for Grasp's. */
  createdBy: string | null;
}

/** Each topic: the revision in effect, and a later one still to come. */
export interface AdmissionTopicState {
  current: AdmissionTopic | null;
  upcoming: AdmissionTopic | null;
}

/** Knowledge admission's topics, for admins. */
export interface AdmissionApi {
  /** Every topic, the platform's first. */
  topics: () => Promise<AdmissionTopicState[]>;
  /** Saves a company topic, or its next revision. */
  saveTopic: (input: TopicInput) => Promise<AdmissionTopic>;
  /** Ends a company topic, from its next revision. */
  retireTopic: (input: TopicRetire) => Promise<AdmissionTopic>;
}

/** Why a topic change was refused. */
export const admissionErrors = defineErrorFamily({
  "admission.invalid": "That isn't a valid topic.",
  "admission.not_found": "There's no such topic.",
  "admission.platform":
    "Grasp's own topics keep sensitive personal data out and can't be changed.",
  "admission.conflict":
    "This topic changed since you opened it. Load it again and apply your change to it.",
  "admission.retired": "This topic is retired already.",
  "admission.limit":
    "There are as many topics, or changes still to take effect, as Grasp allows. Retire a topic, or wait for a change to take effect.",
});
