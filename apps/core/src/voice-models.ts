import type { SpokenWord } from "@grasp-os/shared/voice";

// The voice models the model gateway offers (models.ts) for Grasp's own
// speech and listening (@grasp-os/shared/platform-ai), beside the text
// models of pi's catalog: our own small catalog, as pi's has no voice
// models. Each speech model is Mistral's, priced per character it is
// asked to say, which is how Mistral bills speech. Each transcription
// model is OpenAI's, priced per second it hears, at a price never below
// what the provider bills for it. Grasp pays for these on its own keys:
// what each cost is recorded for Grasp's spend overview (model-usage.ts).

/**
 * Mistral's API prices for text to speech, in US dollars per 1,000
 * characters.
 *
 * Source: Mistral's model page for Voxtral TTS 3
 * (https://docs.mistral.ai/models/voxtral-mini-tts-3-0), read on
 * 2026-11-24: $13 per million characters.
 */
const dollarsPer1000Chars = {
  /** Voxtral TTS 3, in which every line is said. */
  "voxtral-mini-tts-3-0": 0.013,
} as const;

/** The providers that say a line: Mistral (platform-ai.ts). */
const speechProviders = ["mistral"] as const;

/** The providers that write down speech: OpenAI (platform-ai.ts). */
const transcriptionProviders = ["openai"] as const;

/** A speech model the gateway offers. */
export interface VoiceRef {
  provider: (typeof speechProviders)[number];
  id: keyof typeof dollarsPer1000Chars;
}

const isVoiceModel = (id: string): id is VoiceRef["id"] =>
  Object.hasOwn(dollarsPer1000Chars, id);

const isSpeechProvider = (provider: string): provider is VoiceRef["provider"] =>
  speechProviders.some((one) => one === provider);

/**
 * A speech model as the gateway names it, `<provider>/<model>`, such as
 * `mistral/voxtral-mini-tts-3-0`; `undefined` for any other.
 */
export const parseVoiceRef = (ref: string): VoiceRef | undefined => {
  const [provider, id, ...rest] = ref.split("/");
  return provider !== undefined &&
    isSpeechProvider(provider) &&
    id !== undefined &&
    rest.length === 0 &&
    isVoiceModel(id)
    ? { provider, id }
    : undefined;
};

/** What saying `characters` characters costs on `ref`, in US dollars: per million, so whole micros stay whole. */
export const speechCostOf = ({ id }: VoiceRef, characters: number): number =>
  (characters * dollarsPer1000Chars[id] * 1000) / 1_000_000;

/**
 * OpenAI's prices for speech to text, in US dollars per hour of audio.
 * Whisper is billed per minute, $0.006. The GPT-4o transcription models
 * are billed per token: audio in ($6 a million, about $0.006 a minute; $3
 * for mini) and the text written out ($10 a million; $5 for mini), live
 * over the realtime socket as from a recording (OpenAI's pricing page,
 * read on 2026-10-29). A minute of speech writes out at most 300 tokens,
 * $0.003 (mini $0.0015): charged $0.01 a minute ($0.005 for mini), above
 * both together, and the prompt of words to listen out for with them.
 */
const dollarsPerHour = {
  "gpt-4o-transcribe": 0.6,
  "gpt-4o-mini-transcribe": 0.3,
  "whisper-1": 0.36,
} as const;

/** A transcription model the gateway offers. */
export interface HearingRef {
  provider: (typeof transcriptionProviders)[number];
  id: keyof typeof dollarsPerHour;
}

const isHearingModel = (id: string): id is HearingRef["id"] =>
  Object.hasOwn(dollarsPerHour, id);

const isTranscriptionProvider = (
  provider: string
): provider is HearingRef["provider"] =>
  transcriptionProviders.some((one) => one === provider);

/**
 * A transcription model as the gateway names it, `<provider>/<model>`,
 * such as `openai/gpt-4o-transcribe`; `undefined` for any other, a speech
 * model too: each takes calls of its own kind only.
 */
export const parseHearingRef = (ref: string): HearingRef | undefined => {
  const [provider, id, ...rest] = ref.split("/");
  return provider !== undefined &&
    isTranscriptionProvider(provider) &&
    id !== undefined &&
    rest.length === 0 &&
    isHearingModel(id)
    ? { provider, id }
    : undefined;
};

/** What hearing `seconds` seconds costs on `ref`, in US dollars. */
export const hearingCostOf = ({ id }: HearingRef, seconds: number): number =>
  (seconds * dollarsPerHour[id]) / 3600;

/**
 * Mistral's prices for a voice agent's session (its voice agents:
 * listening, the model and the voice in one live session), in US dollars
 * per hour of the session, by the model that answers in it. The session
 * is named by that model.
 *
 * Source: Mistral's launch of its Voice Agents API, as reported on
 * 2026-10-26 (its own pricing page names no rate): $0.04 a minute with
 * Mistral Small, $0.08 with a larger model.
 */
const conversationDollarsPerHour = {
  "mistral-small-latest": 2.4,
} as const;

/** The providers that hold a live voice session: Mistral. */
const conversationProviders = ["mistral"] as const;

/** A voice agent's model the gateway offers. */
export interface ConversingRef {
  provider: (typeof conversationProviders)[number];
  id: keyof typeof conversationDollarsPerHour;
}

const isConversingModel = (id: string): id is ConversingRef["id"] =>
  Object.hasOwn(conversationDollarsPerHour, id);

const isConversationProvider = (
  provider: string
): provider is ConversingRef["provider"] =>
  conversationProviders.some((one) => one === provider);

/**
 * A voice agent's model as the gateway names it, `<provider>/<model>`,
 * such as `mistral/mistral-small-latest`; `undefined` for any other.
 */
export const parseConversingRef = (ref: string): ConversingRef | undefined => {
  const [provider, id, ...rest] = ref.split("/");
  return provider !== undefined &&
    isConversationProvider(provider) &&
    id !== undefined &&
    rest.length === 0 &&
    isConversingModel(id)
    ? { provider, id }
    : undefined;
};

/** What `seconds` of a voice session cost on `ref`, in US dollars. */
export const conversationCostOf = (
  { id }: ConversingRef,
  seconds: number
): number => (seconds * conversationDollarsPerHour[id]) / 3600;

/**
 * Characters a line is charged as: its UTF-16 length, never fewer than
 * the characters (code points) Mistral counts, so what is recorded is
 * never below what the line is billed.
 */
export const charactersOf = (text: string): number => text.length;

/** A direction to the voice inside a line, which isn't said: `[emotion=warm]`. */
const direction = /\[[^\]]*\]/gu;

const spaces = /\s+/u;

/** After these a voice waits a moment: counted as letters said. */
const pauses: Readonly<Record<string, number>> = {
  ",": 2,
  ";": 3,
  ":": 3,
  ".": 5,
  "!": 5,
  "?": 5,
  "\u2026": 5,
};

/** The wait a word's last mark asks for, in letters. */
const pauseAfter = (word: string): number => pauses[word.at(-1) ?? ""] ?? 0;

/**
 * The words of a line, each a run of characters between spaces, with when
 * it is said, in whole ms. Mistral's speech tells no word's time, so each
 * is worked out: the audio's length shared over the words by how many
 * letters each has, with a letter for the space after it and the wait its
 * last mark asks for; the last word ends with the audio. A direction in
 * brackets isn't said and is no word.
 */
export const wordsOf = (line: string, seconds: number): SpokenWord[] => {
  const written = line
    .replaceAll(direction, " ")
    .split(spaces)
    .filter((word) => word !== "");
  const letters = written.map((word) => word.length);
  const after = written.map((word, at) =>
    at === written.length - 1 ? 0 : 1 + pauseAfter(word)
  );
  const whole = [...letters, ...after].reduce((sum, part) => sum + part, 0);
  const words: SpokenWord[] = [];
  let before = 0;
  for (const [at, text] of written.entries()) {
    const said = letters[at] ?? 0;
    words.push({
      text,
      startMs: Math.round((before / whole) * seconds * 1000),
      endMs: Math.round(((before + said) / whole) * seconds * 1000),
    });
    before += said + (after[at] ?? 0);
  }
  return words;
};
