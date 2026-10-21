// Grasp's voice: saying a line (speech synthesis) and hearing a person
// (live transcription), each behind an interface so the provider behind it
// can be swapped, as the on-prem profile swaps platform services. Core's
// implementation goes through the model gateway (core's src/models.ts):
// what is said or heard is interview content, judged by the same rules as
// any model call.
//
// Only speech is implemented today (core's src/speech.ts). Live
// transcription is the interface it will take, once a live run proves
// ElevenLabs's realtime transcription through AI Gateway.

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
