import type { SpokenWord } from "@grasp-os/shared/voice";

// The voice models the model gateway offers (models.ts) for Grasp's own
// speech and listening (@grasp-os/shared/platform-ai), beside the text
// models of pi's catalog: our own small catalog, as pi's has no voice
// models. Each speech model is Mistral's or ElevenLabs's, priced per
// character it is asked to say, which is how both bill speech. Each transcription
// model is OpenAI's or Mistral's, priced per second it hears, at a price never below
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
const mistralDollarsPer1000Chars = {
  /** Voxtral TTS 3, in which an interview's lines are said. */
  "voxtral-mini-tts-3-0": 0.013,
} as const;

/**
 * ElevenLabs's API prices for text to speech, in US dollars per 1,000
 * characters, the same on every plan.
 *
 * Source: ElevenLabs's API pricing page, "Model pricing"
 * (https://elevenlabs.io/pricing/api), read on 2026-10-21: v4 and v3 at
 * $0.08, v4 Turbo and Flash at $0.04.
 */
const elevenLabsDollarsPer1000Chars = {
  /** Eleven v4: the most expressive, in which the admin's onboarding is said. */
  eleven_v4: 0.08,
  eleven_v4_turbo: 0.04,
  eleven_v3: 0.08,
  eleven_flash_v2_5: 0.04,
} as const;

/** Each speech provider's models, with their prices (platform-ai.ts). */
const dollarsPer1000Chars = {
  mistral: mistralDollarsPer1000Chars,
  elevenlabs: elevenLabsDollarsPer1000Chars,
} as const;

/** The providers that say a line: Mistral and ElevenLabs (platform-ai.ts). */
const speechProviders = ["mistral", "elevenlabs"] as const;

/** The providers that write down speech: OpenAI and Mistral (platform-ai.ts). */
const transcriptionProviders = ["openai", "mistral"] as const;

/** A speech model the gateway offers. */
export type VoiceRef = {
  [P in (typeof speechProviders)[number]]: {
    provider: P;
    id: keyof (typeof dollarsPer1000Chars)[P];
  };
}[(typeof speechProviders)[number]];

const isMistralModel = (
  id: string
): id is keyof typeof mistralDollarsPer1000Chars =>
  Object.hasOwn(mistralDollarsPer1000Chars, id);

const isElevenLabsModel = (
  id: string
): id is keyof typeof elevenLabsDollarsPer1000Chars =>
  Object.hasOwn(elevenLabsDollarsPer1000Chars, id);

/**
 * A speech model as the gateway names it, `<provider>/<model>`, such as
 * `mistral/voxtral-mini-tts-3-0` or `elevenlabs/eleven_v4`; `undefined`
 * for any other.
 */
export const parseVoiceRef = (ref: string): VoiceRef | undefined => {
  const [provider, id, ...rest] = ref.split("/");
  if (id === undefined || rest.length > 0) {
    return undefined;
  }
  if (provider === "mistral" && isMistralModel(id)) {
    return { provider, id };
  }
  if (provider === "elevenlabs" && isElevenLabsModel(id)) {
    return { provider, id };
  }
  return undefined;
};

/** A model's price per 1,000 characters, in US dollars. */
const priceOf = (ref: VoiceRef): number =>
  ref.provider === "mistral"
    ? dollarsPer1000Chars.mistral[ref.id]
    : dollarsPer1000Chars.elevenlabs[ref.id];

/** What saying `characters` characters costs on `ref`, in US dollars: per million, so whole micros stay whole. */
export const speechCostOf = (ref: VoiceRef, characters: number): number =>
  (characters * priceOf(ref) * 1000) / 1_000_000;

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
const openAiDollarsPerHour = {
  "gpt-4o-transcribe": 0.6,
  "gpt-4o-mini-transcribe": 0.3,
  "whisper-1": 0.36,
} as const;

/**
 * Mistral's prices for speech to text, in US dollars per hour of audio.
 * Voxtral Mini Transcribe Realtime is billed per minute heard, $0.006
 * (Mistral's launch of Voxtral Realtime, read on 2026-11-26): charged
 * $0.01 a minute, above it, as OpenAI's are.
 */
const mistralDollarsPerHour = {
  "voxtral-mini-transcribe-realtime-3": 0.6,
} as const;

/** Each transcription provider's models, with their prices. */
const hearingPrices = {
  openai: openAiDollarsPerHour,
  mistral: mistralDollarsPerHour,
} as const;

const dollarsPerHour = { ...openAiDollarsPerHour, ...mistralDollarsPerHour };

/** A transcription model the gateway offers. */
export interface HearingRef {
  provider: (typeof transcriptionProviders)[number];
  id: keyof typeof dollarsPerHour;
}

/** Whether `id` is one of `provider`'s transcription models. */
const isHearingModel = (
  provider: HearingRef["provider"],
  id: string
): id is HearingRef["id"] => Object.hasOwn(hearingPrices[provider], id);

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
    isHearingModel(provider, id)
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

/** When each character of a line is said, in seconds, as ElevenLabs aligns it. */
export interface Alignment {
  characters: readonly string[];
  character_start_times_seconds: readonly number[];
  character_end_times_seconds: readonly number[];
}

const space = /^\s$/u;

/**
 * The words of a line ElevenLabs aligned, each a run of characters
 * between spaces, with when its first character starts and its last
 * ends, in whole ms. `undefined` when the alignment doesn't hold one time
 * of each kind for every character.
 */
export const alignedWordsOf = ({
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
