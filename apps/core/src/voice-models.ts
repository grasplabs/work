import type { SpokenWord } from "@grasp-os/shared/voice";

import type { ListPrices } from "./model-prices.ts";

// The voice models the model gateway offers (models.ts), beside the text
// models of pi's catalog: our own small catalog, as pi's has no voice
// models. Each is priced per character it is asked to say, which is how
// ElevenLabs bills speech.

/** The provider of the gateway's voice models, by its AI Gateway path. */
export const voiceProvider = "elevenlabs";

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

/** A voice model the gateway offers. */
export interface VoiceRef {
  provider: typeof voiceProvider;
  id: keyof typeof dollarsPer1000Chars;
}

const isVoiceModel = (id: string): id is VoiceRef["id"] =>
  Object.hasOwn(dollarsPer1000Chars, id);

/**
 * A voice model as the gateway names it, `elevenlabs/<model>`, such as
 * `elevenlabs/eleven_v4`; `undefined` for any other.
 */
export const parseVoiceRef = (ref: string): VoiceRef | undefined => {
  const [provider, id, ...rest] = ref.split("/");
  return provider === voiceProvider &&
    id !== undefined &&
    rest.length === 0 &&
    isVoiceModel(id)
    ? { provider, id }
    : undefined;
};

/**
 * A voice model's prices in the shape the ledger pins: per million
 * characters, as the input a request sends. Its answer, the audio, is
 * what the characters pay for, so a request counts no output: it is
 * priced the same, and never charged.
 */
export const voicePricesOf = ({ id }: VoiceRef): ListPrices => {
  const perMillion = dollarsPer1000Chars[id] * 1000;
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
