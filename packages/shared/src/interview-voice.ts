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

// An interview held as one live conversation with Grasp's ElevenLabs
// agent (core's onboarding/voice.ts). ElevenLabs listens, Stephen answers
// and speaks there, and the person can talk over him. Core asks for the
// conversation's token through connect with Grasp's key; the page starts
// the conversation with what core answers, through ElevenLabs's own SDK,
// and its audio goes between the browser and ElevenLabs. After each
// answer the page asks core to write down what was said, with the
// conversation as it heard it, and core answers the facts.

export const interviewVoicePath = "/api/interview/voice";

/** The most bytes one request may carry: its facts and the conversation before, on a resume. */
export const interviewVoiceMaxBytes = 768 * 1024;

/**
 * The name of the one function Stephen calls in a conversation, as a
 * client tool of the agent's: the part of the interview he moves to
 * (`interviewPhases`), so the page and the notes know where it stands.
 * The page answers it, and sends the part with each answer.
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
   * The conversation before this one, on a resume or when they came back
   * to add something: a new conversation doesn't know it.
   */
  before: z
    .array(interviewLineSchema.pick({ from: true, text: true }))
    .max(interviewLimits.lines)
    .default([]),
};

/** The signed pass that ties a conversation to the link it was opened on (core's voice.ts). */
export const voicePassSchema = z.string().min(1).max(1024);

export const interviewVoiceRequestSchema = z.discriminatedUnion("action", [
  /**
   * Open a conversation: at the start, or again when they come back to an
   * interview they left (`resume`), to add something after agreeing to
   * it (`add`), or when they switch the language on screen (`language`),
   * with the conversation so far, which a new one doesn't know.
   */
  z.strictObject({
    action: z.literal("open"),
    event: z.enum(["start", "resume", "add", "language"]),
    ...standing,
  }),
  /**
   * Write down what was said since `noted` of their answers: once one more
   * of theirs was heard. One at a time: the page sends the next once this
   * one answered, with the `noted` it answered, or the same answers are
   * written down twice.
   */
  z.strictObject({
    action: z.literal("answer"),
    ...standing,
    pass: voicePassSchema,
    /**
     * How many of their answers in this conversation were written down
     * already: 0 for each one opened, a resume's too, whatever came before.
     */
    noted: z.int().min(0).max(interviewLimits.lines),
    /**
     * This conversation as the page heard it, as core doesn't read it at
     * ElevenLabs: their words as the agent heard them, and his as he said
     * them.
     */
    said: z
      .array(interviewLineSchema.pick({ from: true, text: true }))
      .max(interviewLimits.lines),
  }),
  /**
   * The page left the conversation, which it ended at ElevenLabs itself:
   * the interview is at the read-back, or they withdrew. Taken on the pass
   * alone, whatever the link's state.
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

/**
 * A conversation with Grasp's ElevenLabs agent as the page starts it,
 * through ElevenLabs's own client SDK: a token core asked for with
 * Grasp's key, never the key, and who it talks with.
 */
export interface VoiceSessionJoin {
  /** What the page starts the conversation with: it holds a few minutes. */
  conversationToken: string;
  /**
   * Where ElevenLabs holds the conversation, as its SDK names it: where
   * core asked the token, which is joined only there. Its EU data
   * residency on every deployment but a staging one set up for testing.
   */
  location: "eu-residency" | "us";
  /**
   * Who the agent talks with, the language they chose and, on a resume,
   * what was said before: told to it as context as the conversation
   * begins. Its prompt and first line are its own.
   */
  context: string;
  /** What the page sends back with each answer and the close. */
  pass: string;
}

/** A line of the conversation: theirs as heard, his as it was played. */
export interface VoiceLine {
  from: "person" | "stephen";
  text: string;
}

/** What core answers after an answer. */
export interface VoiceAnswered {
  /** How many of their answers are written down now; the same as sent when no new one was heard yet. */
  noted: number;
  /**
   * What was written down from it, checked against what was said; null when
   * nothing new was said. Its facts have no ID yet: the page gives each one
   * as it keeps them, as it does a turn's. A request sent again with the
   * same `noted` writes the same facts again: the page sends each once.
   */
  turn: Pick<StephenTurn, "facts" | "changes" | "phase"> | null;
}
