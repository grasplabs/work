import type { SpokenWord } from "@grasp-os/shared/voice";

import type { ListPrices } from "./model-prices.ts";

// The voice models the model gateway offers (models.ts) for Grasp's own
// speech and listening (@grasp-os/shared/platform-ai), beside the text
// models of pi's catalog: our own small catalog, as pi's has no voice
// models. Each speech model is ElevenLabs's, priced per character it is
// asked to say, which is how ElevenLabs bills speech: what the ledger
// reserves for a line is what it charges. Each transcription model is
// OpenAI's, priced per second it hears, at a price never below what the
// provider bills for it. Grasp pays for these on its own keys: no
// organization's budget holds them, but the ledger records what each
// cost, for the spend overview.

/**
 * ElevenLabs's API prices for text to speech, in US dollars per 1,000
 * characters, the same on every plan.
 *
 * Source: ElevenLabs's API pricing page, "Model pricing"
 * (https://elevenlabs.io/pricing/api), read on 2026-10-21: v4 and v3 at
 * $0.08, v4 Turbo and Flash at $0.04.
 */
const dollarsPer1000Chars = {
  /** Eleven v4: the most expressive, in which Stephen's lines are said. */
  eleven_v4: 0.08,
  /** Eleven v4 Turbo: for a line only known as it is said. Same voices. */
  eleven_v4_turbo: 0.04,
  eleven_v3: 0.08,
  eleven_flash_v2_5: 0.04,
} as const;

/** The providers that say a line: ElevenLabs (platform-ai.ts). */
const speechProviders = ["elevenlabs"] as const;

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
 * `elevenlabs/eleven_v4`; `undefined` for any other.
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

/**
 * A speech model's prices in the shape the ledger pins: per million
 * characters, as the input a request sends. Its answer, the audio, is
 * what the characters pay for, so a request counts no output: it is
 * priced the same, and never charged.
 */
export const voicePricesOf = ({ id }: VoiceRef): ListPrices => {
  const perMillion = dollarsPer1000Chars[id] * 1000;
  return { input: perMillion, output: perMillion, cacheRead: 0, cacheWrite: 0 };
};

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

/**
 * A transcription model's prices in the shape the ledger pins: per
 * million seconds of audio, as the input a request sends. What is heard
 * is all it is billed for, so it counts no output.
 */
export const hearingPricesOf = ({ id }: HearingRef): ListPrices => {
  const perMillion = (dollarsPerHour[id] / 3600) * 1_000_000;
  return { input: perMillion, output: perMillion, cacheRead: 0, cacheWrite: 0 };
};

/**
 * Characters a line is charged as: its UTF-16 length, never fewer than
 * the characters (code points) ElevenLabs counts, so the ledger's
 * reservation is never below what the line is billed.
 */
export const charactersOf = (text: string): number => text.length;

/** When each character of a line is said, in seconds, as ElevenLabs aligns it. */
export interface Alignment {
  characters: readonly string[];
  character_start_times_seconds: readonly number[];
  character_end_times_seconds: readonly number[];
}

const space = /^\s$/u;

/**
 * The words of an aligned line, each a run of characters between spaces,
 * with when its first character starts and its last ends, in whole ms.
 * `undefined` when the alignment doesn't hold one time of each kind for
 * every character.
 */
export const wordsOf = ({
  characters,
  character_start_times_seconds: starts,
  character_end_times_seconds: ends,
}: Alignment): SpokenWord[] | undefined => {
  if (
    starts.length !== characters.length ||
    ends.length !== characters.length
  ) {
    return undefined;
  }
  const words: SpokenWord[] = [];
  let word: { text: string; start: number; end: number } | undefined =
    undefined;
  const close = (): void => {
    if (word !== undefined) {
      words.push({
        text: word.text,
        startMs: Math.round(word.start * 1000),
        endMs: Math.round(word.end * 1000),
      });
      word = undefined;
    }
  };
  for (const [at, character] of characters.entries()) {
    const start = starts[at] ?? 0;
    const end = ends[at] ?? start;
    if (space.test(character)) {
      close();
    } else if (word === undefined) {
      word = { text: character, start, end };
    } else {
      word.text += character;
      word.end = end;
    }
  }
  close();
  return words;
};
