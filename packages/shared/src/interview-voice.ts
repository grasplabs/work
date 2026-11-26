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
import type { InterviewLocale } from "./onboarding.ts";

// An interview held as one live voice session (core's onboarding/voice.ts):
// a conversation with Grasp's ElevenLabs agent, or a session at Mistral.
// At Mistral, Mistral listens, Stephen answers and speaks there,
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
   * interview they left (`resume`), to add something after agreeing to
   * it (`add`), or when they switch the language on screen (`language`),
   * with the conversation so far, which a new session doesn't know.
   */
  z.strictObject({
    action: z.literal("open"),
    event: z.enum(["start", "resume", "add", "language"]),
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
    /**
     * How many of their answers in this session were written down already:
     * 0 for each session opened, a resume's too, whatever came before.
     */
    noted: z.int().min(0).max(interviewLimits.lines),
    /**
     * The conversation of this session as the page heard it, for a
     * conversation with Grasp's ElevenLabs agent (`AgentJoin`), whose
     * transcript core doesn't read: their words as the agent heard them,
     * and his as he said them. Left out for a session at Mistral, whose
     * own transcript core reads.
     */
    said: z
      .array(interviewLineSchema.pick({ from: true, text: true }))
      .max(interviewLimits.lines)
      .optional(),
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

/** A session at Mistral as the page joins it: never Grasp's key. */
export interface MistralJoin {
  via: "mistral";
  id: string;
  participantToken: string;
  /** The room's address, a `wss:` URL. */
  serverUrl: string;
  /** When the page must have joined by, as Mistral says it: an ISO 8601 time. */
  expiresAt: string;
  /** What the page sends back with each answer and the close. */
  pass: string;
}

/**
 * A conversation with Grasp's ElevenLabs agent as the page starts it,
 * through ElevenLabs's own client SDK: a token core asked for with
 * Grasp's key, never the key, and what Stephen is told for this
 * conversation, which the page sends as the agent's overrides.
 */
export interface AgentJoin {
  via: "elevenlabs";
  /** What the page starts the conversation with: it holds a few minutes. */
  conversationToken: string;
  /** Who Stephen is, how the interview goes and where it stands: the agent's prompt for this conversation. */
  prompt: string;
  /** What he says first. */
  firstMessage: string;
  /** The language they talk in. */
  language: InterviewLocale;
  /** What the page sends back with each answer and the close. */
  pass: string;
}

/** A live session as the page joins it: never Grasp's key. */
export type VoiceSessionJoin = MistralJoin | AgentJoin;

/** A line of the session as Mistral wrote it down: theirs as heard, his as it was played. */
export interface VoiceLine {
  from: "person" | "stephen";
  text: string;
}

/** What core answers after an answer. */
export interface VoiceAnswered {
  /** How many of their answers are written down now; the same as sent when Mistral had no new one yet. */
  noted: number;
  /**
   * The conversation of this session, as Mistral wrote it down, its last
   * `interviewLimits.lines`: on a resume the page sends back the last that
   * many of everything before (`before`).
   */
  lines: VoiceLine[];
  /**
   * What was written down from it, checked against what was said; null when
   * nothing new was said. Its facts have no ID yet: the page gives each one
   * as it keeps them, as it does a turn's. A request sent again with the
   * same `noted` writes the same facts again: the page sends each once.
   */
  turn: Pick<StephenTurn, "facts" | "changes" | "phase"> | null;
  /** What Stephen is told from now on: the page hands it the session (`session.update`). */
  instructions: string;
  /**
   * Where the interview stands now, alone: what a conversation with the
   * ElevenLabs agent is told (a contextual update), as its prompt can't
   * change while it runs.
   */
  situation: string;
}
