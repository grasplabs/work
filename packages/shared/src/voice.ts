// Grasp's voice: saying a line (speech synthesis) and hearing a person
// (live transcription), each behind an interface so the provider behind it
// can be swapped, as the on-prem profile swaps platform services. Core's
// implementation goes through the model gateway (core's src/models.ts):
// what is said or heard is interview content, judged by the same rules as
// any model call.
//
// Each goes to the provider and model the platform's settings name
// (@grasp-os/shared/platform-ai), OpenAI's by default, with Grasp's own
// key, which connect holds.
//
// Speech is core's src/speech.ts, said for the onboarding's pages at
// `POST /api/speech` (core's src/onboarding/speech.ts). Live transcription
// is core's src/transcription.ts, which the onboarding's pages reach over a
// WebSocket on their own origin, `GET /api/transcription` (core's
// src/onboarding/transcription.ts): no provider token or host ever reaches
// the browser.

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
   * The speech model, as the gateway names it (`<provider>/<model>`). The
   * platform's setting when not named.
   */
  model?: string;
  /** How to say it, such as its tone: never said itself. */
  instructions?: string;
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

// `GET /api/transcription`: what someone says, written down as they say
// it. A WebSocket on the page's own origin, which core relays to the
// transcription upstream. On someone's interview link, with the link's
// secret and the device's key in the first frame; or for an admin signed
// in, with the session the upgrade carries. The frames are described where
// core serves it (src/onboarding/transcription.ts).

/** Where the onboarding's pages open a live transcription. */
export const transcriptionPath = "/api/transcription";

/** The sample rates the audio may have, in samples a second. */
export const transcriptionSampleRates = [
  8000, 16_000, 22_050, 24_000, 44_100, 48_000,
] as const;

/** The most one audio frame may hold: about a second of 16 kHz audio. */
export const transcriptionFrameMaxBytes = 32 * 1024;

/** The most a text frame from the page may hold: a start, or a commit. */
export const transcriptionTextMaxBytes = 4 * 1024;

/** The longest `previousText` the page may send. */
export const transcriptionPreviousTextMaxChars = 1000;

/** The first frame: the language, the audio's rate, and whose interview. */
export const transcriptionStartSchema = z.strictObject({
  type: z.literal("start"),
  language: interviewLocaleSchema,
  sampleRate: z.union(transcriptionSampleRates.map((rate) => z.literal(rate))),
  previousText: z.string().max(transcriptionPreviousTextMaxChars).optional(),
  /** Someone's interview link: its secret, and the device's key. */
  link: z
    .strictObject({ secret: interviewSecretSchema, key: interviewSecretSchema })
    .optional(),
});
export type TranscriptionStart = z.input<typeof transcriptionStartSchema>;

/** A text frame after `ready`: settle what was said so far. */
export const transcriptionCommitSchema = z.strictObject({
  type: z.literal("commit"),
});

/** What core sends the page, each a text frame of JSON. */
export type TranscriptionMessage =
  | {
      type: "ready";
      /** The session's ID, as its audit entries name it. */
      session: string;
      /** Seconds of audio this socket takes before it ends. */
      maxSeconds: number;
    }
  | { type: "partial"; text: string }
  | { type: "final"; text: string; words: SpokenWord[] }
  | { type: "error"; code: string; message: string };

/**
 * How core closes the page's socket: `ended` when either side ended it, or
 * the session reached its length; `refused` after a frame or a link it
 * refused, or a budget spent; `failed` when the upstream failed. An
 * `error` frame says why before any but `ended`.
 */
export const transcriptionCloseCodes = {
  ended: 1000,
  refused: 1008,
  failed: 1011,
} as const;

/** Why a live transcription was refused or ended. */
export const transcriptionErrors = defineErrorFamily({
  "transcription.invalid": "That isn't something live transcription takes.",
  "transcription.limited":
    "Stephen has listened a lot today. Type your answers, and he listens again tomorrow.",
  "transcription.over_budget":
    "The AI budget for listening is used up. Type your answers for now.",
  "transcription.busy":
    "Listening is busy right now. Type your answer, or try again in a moment.",
  "transcription.expired":
    "This listening session reached its end. Start a new one to go on.",
  "transcription.unavailable":
    "Live transcription isn't set up for this deployment yet.",
  "transcription.failed": "Live transcription stopped. Try again.",
});
