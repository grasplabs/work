// Grasp's voice: saying a line (speech synthesis) and hearing a person
// (live transcription), each behind an interface so the provider behind it
// can be swapped, as the on-prem profile swaps platform services. Core's
// implementation goes through the model gateway (core's src/models.ts):
// what is said or heard is interview content, judged by the same rules as
// any model call.
//
// Only speech is implemented today (core's src/speech.ts), and said for
// the onboarding's pages at `POST /api/speech` (core's
// src/onboarding/speech.ts). Live transcription is the interface it will
// take, once a live run proves ElevenLabs's realtime transcription through
// AI Gateway.

import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { interviewSecretSchema, voiceTags } from "./interview-links.ts";
import { interviewLocaleSchema } from "./onboarding.ts";

/** The longest line one request may have said, so no request runs up the bill. */
export const maxSpeechChars = 600;

/** A line to say. */
export interface SpeechRequest {
  /** The line as it is said, at most {@link maxSpeechChars} characters. */
  text: string;
  /** The provider's ID of the voice to say it in. */
  voice: string;
  /** The language it is said in: an ISO 639-1 code, such as `en`. */
  language: string;
  /**
   * The voice model, as the gateway names it (`<provider>/<model>`): one
   * the deployment allows. The implementation's own when not named.
   */
  model?: string;
}

/** A word of a line, and when it is said, in ms from the start of the audio. */
export interface SpokenWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** A line as said: its audio, and when each of its words is said. */
export interface Speech {
  audio: Uint8Array;
  /** The audio's media type, such as `audio/mpeg`. */
  mime: string;
  /** In the order they are said; punctuation stays with its word. */
  words: SpokenWord[];
}

/** Says lines in a voice. */
export interface SpeechSynthesis {
  /** Says `request`'s line; `signal` cancels it. */
  speak: (request: SpeechRequest, signal?: AbortSignal) => Promise<Speech>;
}

/** What a live transcription is opened with. */
export interface TranscriptionOptions {
  /** The language the person speaks: an ISO 639-1 code, such as `en`. */
  language: string;
  /** Words to listen out for: names, a company's own terms. */
  keyterms: readonly string[];
  /** Samples a second of the audio `send` is given (16-bit PCM, mono). */
  sampleRate: number;
  /** What was said just before, so the first words are heard in context. */
  previousText?: string;
}

/** What a live transcription hears, as it hears it. */
export type TranscriptionEvent =
  /** What it hears so far of what is being said: it may still change. */
  | { type: "partial"; text: string }
  /** What was said, settled, once committed. */
  | { type: "committed"; text: string; words: SpokenWord[] }
  /** It stopped, in the implementation's own words: a code, never content. */
  | { type: "failed"; code: string };

/** One live transcription, open until closed. */
export interface TranscriptionSession {
  /** Sends the next audio: 16-bit PCM at the session's sample rate. */
  send: (audio: Uint8Array) => void;
  /** Settles what was said so far, as one `committed` event. */
  commit: () => void;
  /** Ends the session; `events` then ends too. */
  close: () => void;
  events: AsyncIterable<TranscriptionEvent>;
}

/** Hears a person as they speak. */
export interface LiveTranscription {
  open: (options: TranscriptionOptions) => Promise<TranscriptionSession>;
}

// `POST /api/speech`: a line of the onboarding said out loud, with when
// each word is said, so the page lights the words up as they are said. On
// someone's interview link, with the link's secret and the device's key;
// or for an admin signed in, with the session alone.

/** Where the onboarding's pages have a line said. */
export const speechPath = "/api/speech";

/**
 * Who says a line: Stephen, or Claire when she holds the interview; and
 * the sample speakers of the conversation that shows how an interview
 * goes, each clearly not Stephen.
 */
export const speakers = ["stephen", "claire", "mark", "lisa", "tim"] as const;
export type Speaker = (typeof speakers)[number];

/** The most a speech request's body may hold: a line, a link and a few fields. */
export const speechRequestMaxBytes = 8 * 1024;

/** A bracket, which would read as a direction to the voice. */
const directionMark = /[[\]]/u;

/** What the page asks to have said. */
export const speechRequestSchema = z.strictObject({
  /**
   * The line as written, with no direction of its own: a tone comes only
   * from {@link voiceTags}, as `tone`, so nobody has a line said in one
   * Stephen may not use.
   */
  text: z
    .string()
    .trim()
    .min(1)
    .max(maxSpeechChars)
    .refine((text) => !directionMark.test(text), "A line without brackets"),
  /** The language the line is in, and said in. */
  language: interviewLocaleSchema,
  speaker: z.enum(speakers).default("stephen"),
  /**
   * For a line only known as it is said, such as one with a count or a
   * name: said by the quicker voice model where the deployment allows it.
   */
  quick: z.boolean().default(false),
  /** How the line is said: one of the tones Stephen may use. */
  tone: z.enum(voiceTags).optional(),
  /** Someone's interview link: its secret, and the device's key. */
  link: z
    .strictObject({ secret: interviewSecretSchema, key: interviewSecretSchema })
    .optional(),
});
export type SpeechRequestBody = z.input<typeof speechRequestSchema>;

/** A line as `POST /api/speech` answers it. */
export interface SpeechAnswer {
  /** The audio, base64. */
  audio: string;
  /** Its media type, such as `audio/mpeg`. */
  mime: string;
  /** The words of the line as written, and when each is said. */
  words: SpokenWord[];
}

/** Why a line wasn't said. */
export const speechErrors = defineErrorFamily({
  "speech.invalid": "That isn't a line the voice can say.",
  "speech.limited":
    "The voice has said a lot today. Read on, and it speaks again tomorrow.",
  "speech.busy": "The voice is busy. Try again in a moment.",
  "speech.unavailable": "The voice isn't set up for this deployment yet.",
  "speech.failed": "The voice couldn't say that. Try again.",
});
