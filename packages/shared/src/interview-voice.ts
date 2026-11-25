import { z } from "zod";

import {
  interviewFactSchema,
  interviewLimits,
  interviewLineSchema,
  interviewPhases,
  interviewSecretSchema,
} from "./interview-links.ts";
import type { StephenTurn } from "./interview-turn.ts";
import { interviewLocaleSchema } from "./onboarding.ts";

// An interview held as one live voice session at Mistral (core's
// onboarding/voice.ts): Mistral listens, Stephen answers and speaks there,
// and the person can talk over him. Core opens the session through connect
// with Grasp's key and tells Stephen who he talks to; the page joins the
// session's room with what core answers, and its audio goes between the
// browser and Mistral. After each answer the page asks core to write down
// what was said: core reads it from Mistral's own transcript, never from
// the page, and answers the facts with what Stephen is told from then on,
// which the page hands the session.

export const interviewVoicePath = "/api/interview/voice";

/** The most bytes one request may carry: its facts and the conversation before, on a resume. */
export const interviewVoiceMaxBytes = 768 * 1024;

/**
 * The name of the one function Stephen calls in a session: the part of
 * the interview he moves to (`interviewPhases`), so the page and the
 * notes know where it stands. The page answers it; core reads it from
 * Mistral's transcript.
 */
export const partFunction = "part";

/** Where the interview stands, as the page holds it: what it sends each time. */
const standing = {
  secret: interviewSecretSchema,
  locale: interviewLocaleSchema,
  facts: z
    .array(interviewFactSchema.pick({ id: true, tag: true, text: true }))
    .max(interviewLimits.facts),
  phase: z.enum(interviewPhases),
  /** Minutes since they pressed start. */
  minutes: z.number().min(0).max(240),
  /** They agreed to the read-back before and are back to add something. */
  adding: z.boolean().default(false),
  /**
   * The conversation before this session, on a resume or when they came
   * back to add something: a new session doesn't know it.
   */
  before: z
    .array(interviewLineSchema.pick({ from: true, text: true }))
    .max(interviewLimits.lines)
    .default([]),
};

/** The signed pass that ties a session to the link it was opened on (core's voice.ts). */
export const voicePassSchema = z.string().min(1).max(1024);

export const interviewVoiceRequestSchema = z.discriminatedUnion("action", [
  /**
   * Open a session: at the start, or again when they come back to an
   * interview they left (`resume`) or to add something after agreeing to
   * it (`add`), with the conversation so far, which a new session doesn't
   * know.
   */
  z.strictObject({
    action: z.literal("open"),
    event: z.enum(["start", "resume", "add"]),
    ...standing,
    /** The pass of the session they left, if the page still holds it: that one is closed. */
    previous: voicePassSchema.optional(),
  }),
  /**
   * Write down what was said since `noted` of their answers: once one more
   * of theirs stands in Mistral's transcript. One at a time: the page sends
   * the next once this one answered, with the `noted` it answered, or the
   * same answers are written down twice.
   */
  z.strictObject({
    action: z.literal("answer"),
    ...standing,
    pass: voicePassSchema,
    /** How many of their answers in this session were written down already. */
    noted: z.int().min(0).max(interviewLimits.lines),
  }),
  /**
   * Close the session at Mistral: the page left it, the interview is at the
   * read-back, or they withdrew. Taken on the pass alone, whatever the
   * link's state.
   */
  z.strictObject({
    action: z.literal("close"),
    secret: interviewSecretSchema,
    pass: voicePassSchema,
  }),
]);
export type InterviewVoiceRequest = z.output<
  typeof interviewVoiceRequestSchema
>;

/** A session as the page joins it: never Grasp's key. */
export interface VoiceSessionJoin {
  id: string;
  participantToken: string;
  /** The room's address, a `wss:` URL. */
  serverUrl: string;
  /** When the page must have joined by, as Mistral says it: an ISO 8601 time. */
  expiresAt: string;
  /** What the page sends back with each answer and the close. */
  pass: string;
}

/** A line of the session as Mistral wrote it down: theirs as heard, his as it was played. */
export interface VoiceLine {
  from: "person" | "stephen";
  text: string;
}

/** What core answers after an answer. */
export interface VoiceAnswered {
  /** How many of their answers are written down now; the same as sent when Mistral had no new one yet. */
  noted: number;
  /** The conversation of this session, as Mistral wrote it down. */
  lines: VoiceLine[];
  /** What was written down from it, checked against what was said; null when nothing new was said. */
  turn: Pick<StephenTurn, "facts" | "changes" | "phase"> | null;
  /** What Stephen is told from now on: the page hands it the session (`session.update`). */
  instructions: string;
}
