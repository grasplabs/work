import type { SpokenWord } from "@grasp-os/shared/voice";

// The voice models the model gateway offers (models.ts) for Grasp's own
// speech and listening (@grasp-os/shared/platform-ai), beside the text
// models of pi's catalog: our own small catalog, as pi's has no voice
// models. Each speech model is KugelAudio's, priced per second of audio it
// says, which is how KugelAudio bills speech. Each transcription model is
// OpenAI's, priced per second it hears. Each at a price never below what
// the provider bills for it. Grasp pays for these on its own keys: what
// each cost is recorded for Grasp's spend overview (model-usage.ts).

/**
 * What a minute of speech is charged as, in US dollars. KugelAudio bills
 * in euros, per minute of audio: €0.0525 for Kugel 3.5 (kugelaudio.com/
 * en/pricing, read on 2026-11-19). Charged here at $0.07, above it
 * at any exchange rate below $1.33 to the euro, as the spend overview
 * counts in dollars.
 */
const dollarsPerMinute = {
  /** Kugel 3.5: KugelAudio's newest, in which every line is said. */
  "kugel-3.5": 0.07,
} as const;

/** The providers that say a line: KugelAudio (platform-ai.ts). */
const speechProviders = ["kugelaudio"] as const;

/** The providers that write down speech: OpenAI (platform-ai.ts). */
const transcriptionProviders = ["openai"] as const;

/** A speech model the gateway offers. */
export interface VoiceRef {
  provider: (typeof speechProviders)[number];
  id: keyof typeof dollarsPerMinute;
}

const isVoiceModel = (id: string): id is VoiceRef["id"] =>
  Object.hasOwn(dollarsPerMinute, id);

const isSpeechProvider = (provider: string): provider is VoiceRef["provider"] =>
  speechProviders.some((one) => one === provider);

/**
 * A speech model as the gateway names it, `<provider>/<model>`, such as
 * `kugelaudio/kugel-3.5`; `undefined` for any other.
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

/** What `seconds` seconds of speech cost on `ref`, in US dollars. */
export const speechCostOf = ({ id }: VoiceRef, seconds: number): number =>
  (seconds * dollarsPerMinute[id]) / 60;

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
 * A word as KugelAudio aligned it: when it is said, in ms from the start
 * of the audio, and the part of the line as sent that it says, from
 * `from` up to `to`, counted in code points. A number written as digits
 * is said as several words, each with the span of the digits.
 */
export interface AlignedWord {
  startMs: number;
  endMs: number;
  from: number;
  to: number;
}

const space = /^\s$/u;

/**
 * The words of `line` as written, each a run of characters between
 * spaces, with when the first word said for it starts and the last ends.
 * A word nothing is said for (a lone symbol) passes at once, where the
 * word before it ended. `undefined` when no word was aligned at all.
 */
export const wordsOf = (
  line: string,
  aligned: readonly AlignedWord[]
): SpokenWord[] | undefined => {
  if (aligned.length === 0) {
    return undefined;
  }
  const words: SpokenWord[] = [];
  let at = 0;
  let word: { text: string; from: number } | undefined = undefined;
  const close = (): void => {
    if (word === undefined) {
      return;
    }
    const { text, from } = word;
    word = undefined;
    const said = aligned.filter((one) => one.from < at && one.to > from);
    const before = words.at(-1)?.endMs ?? 0;
    words.push(
      said.length === 0
        ? { text, startMs: before, endMs: before }
        : {
            text,
            startMs: Math.min(...said.map(({ startMs }) => startMs)),
            endMs: Math.max(...said.map(({ endMs }) => endMs)),
          }
    );
  };
  // By code point, as KugelAudio counts where a word is in the line.
  for (const character of line) {
    if (space.test(character)) {
      close();
    } else if (word === undefined) {
      word = { text: character, from: at };
    } else {
      word.text += character;
    }
    at += 1;
  }
  close();
  return words;
};
