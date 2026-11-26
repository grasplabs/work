import type { SpokenWord } from "@grasp-os/shared/voice";

// The voice models the model gateway offers (models.ts) for Grasp's own
// speech and listening (@grasp-os/shared/platform-ai), beside the text
// models of pi's catalog: our own small catalog, as pi's has no voice
// models. Each speech model is ElevenLabs's, priced per character it is
// asked to say, which is how it bills speech. Each transcription
// model is OpenAI's or Mistral's, priced per second it hears, at a price never below
// what the provider bills for it. A conversation with Grasp's ElevenLabs
// agent is priced per second it is expected to last. Grasp pays for these on its own keys:
// what each cost is recorded for Grasp's spend overview (model-usage.ts).

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

/** The providers that write down speech: OpenAI and Mistral (platform-ai.ts). */
const transcriptionProviders = ["openai", "mistral"] as const;

/** A speech model the gateway offers: ElevenLabs says every line (platform-ai.ts). */
export interface VoiceRef {
  provider: "elevenlabs";
  id: keyof typeof elevenLabsDollarsPer1000Chars;
}

const isElevenLabsModel = (id: string): id is VoiceRef["id"] =>
  Object.hasOwn(elevenLabsDollarsPer1000Chars, id);

/**
 * A speech model as the gateway names it, `<provider>/<model>`, such as
 * `elevenlabs/eleven_v4`; `undefined` for any other.
 */
export const parseVoiceRef = (ref: string): VoiceRef | undefined => {
  const [provider, id, ...rest] = ref.split("/");
  return provider === "elevenlabs" &&
    id !== undefined &&
    rest.length === 0 &&
    isElevenLabsModel(id)
    ? { provider, id }
    : undefined;
};

/** What saying `characters` characters costs on `ref`, in US dollars: per million, so whole micros stay whole. */
export const speechCostOf = (ref: VoiceRef, characters: number): number =>
  (characters * elevenLabsDollarsPer1000Chars[ref.id] * 1000) / 1_000_000;

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
 * ElevenLabs's price for a conversation with one of its agents
 * (listening, the model and the voice in one live conversation), in US
 * dollars per hour of it.
 *
 * Source: ElevenLabs's pricing page (https://elevenlabs.io/pricing), read
 * in 2026-11: its agents at $0.10 a minute on the Creator and Pro plans,
 * $0.08 on Business. Charged at $0.10: an estimate until the rate of
 * Grasp's own contract is known.
 */
const agentDollarsPerHour = 6;

/** An agent's ID as ElevenLabs writes it. */
const agentId = /^agent_[A-Za-z0-9]{1,64}$/u;

/** A voice agent the gateway opens conversations with. */
export interface AgentRef {
  provider: "elevenlabs";
  id: string;
}

/**
 * A voice agent as the gateway names it, `<provider>/<agent's ID>`, such
 * as `elevenlabs/agent_4601m8c6`; `undefined` for any other.
 */
export const parseAgentRef = (ref: string): AgentRef | undefined => {
  const [provider, id, ...rest] = ref.split("/");
  return provider === "elevenlabs" &&
    id !== undefined &&
    rest.length === 0 &&
    agentId.test(id)
    ? { provider, id }
    : undefined;
};

/** What `seconds` of a conversation with an agent cost, in US dollars. */
export const conversationCostOf = (seconds: number): number =>
  (seconds * agentDollarsPerHour) / 3600;

/**
 * Characters a line is charged as: its UTF-16 length, never fewer than
 * the characters (code points) its provider counts, so what is recorded
 * is never below what the line is billed.
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
