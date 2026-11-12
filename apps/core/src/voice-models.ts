import type { SpokenWord } from "@grasp-os/shared/voice";

// The voice models the model gateway offers (models.ts) for Grasp's own
// speech and listening (@grasp-os/shared/platform-ai), beside the text
// models of pi's catalog: our own small catalog, as pi's has no voice
// models. Each is Mistral's Voxtral, in the EU: a speech model priced per
// character it is asked to say, a transcription model per second it hears,
// at a price never below what Mistral bills for it. Grasp pays for these
// on its own key: what each cost is recorded for Grasp's spend overview
// (model-usage.ts).

/**
 * Mistral's price for text to speech, in US dollars per 1,000 characters.
 *
 * Source: Mistral's Voxtral 3 announcement (https://mistral.ai/news/
 * voxtral-3/), read on 2026-11-12: Voxtral TTS 3 at $13 a million
 * characters.
 */
const dollarsPer1000Chars = {
  /** Voxtral TTS 3: says a whole line, in a preset or a saved voice. */
  "voxtral-mini-tts-3-0": 0.013,
} as const;

/** The providers that say a line: Mistral (platform-ai.ts). */
const speechProviders = ["mistral"] as const;

/** The providers that write down speech: Mistral (platform-ai.ts). */
const transcriptionProviders = ["mistral"] as const;

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
 * Mistral's prices for speech to text, in US dollars per hour of audio,
 * billed per minute: live over the realtime socket $0.008 a minute, from
 * a recording $0.0035 a minute (the Voxtral 3 announcement, read on
 * 2026-11-12).
 */
const dollarsPerHour = {
  /** Voxtral Transcribe Realtime 3: hears as someone speaks. */
  "voxtral-mini-transcribe-realtime-3-0": 0.48,
  /** Voxtral Mini Transcribe 3: writes a recording down. */
  "voxtral-mini-transcribe-3-0": 0.21,
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
 * such as `mistral/voxtral-mini-transcribe-3-0`; `undefined` for any other, a speech
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
 * Characters a line is charged as: its UTF-16 length, never fewer than
 * the characters (code points) Mistral counts, so what is recorded is
 * never below what the line is billed. A direction (`[emotion=warm]`)
 * counts too, as it is sent.
 */
export const charactersOf = (text: string): number => text.length;

/** A WAV file's four-letter mark at `at`. */
const markAt = (bytes: Uint8Array, at: number): string =>
  String.fromCodePoint(...bytes.subarray(at, at + 4));

/** Where a WAV file's first chunk starts, after `RIFF`, its size and `WAVE`. */
const wavChunksStart = 12;

/** A chunk's header: its four-letter mark and its size. */
const wavChunkHeader = 8;

/**
 * How long a WAV file plays, in ms: the bytes of its samples over the
 * bytes a second its format names. `undefined` for anything that isn't a
 * WAV file with both. A `data` chunk that names more than the file holds
 * (a size written before the audio was known) counts what is there.
 */
export const wavDurationMs = (bytes: Uint8Array): number | undefined => {
  if (
    bytes.length < wavChunksStart ||
    markAt(bytes, 0) !== "RIFF" ||
    markAt(bytes, 8) !== "WAVE"
  ) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let bytesPerSecond: number | undefined = undefined;
  let at = wavChunksStart;
  while (at + wavChunkHeader <= bytes.length) {
    const mark = markAt(bytes, at);
    const size = view.getUint32(at + 4, true);
    const body = at + wavChunkHeader;
    if (mark === "fmt " && body + 12 <= bytes.length) {
      bytesPerSecond = view.getUint32(body + 8, true);
    } else if (mark === "data") {
      const samples = Math.min(size, bytes.length - body);
      return bytesPerSecond === undefined || bytesPerSecond === 0
        ? undefined
        : Math.round((samples * 1000) / bytesPerSecond);
    }
    // A chunk of odd size is followed by one byte of padding.
    at = body + size + (size % 2);
  }
  return undefined;
};

/** A direction to the voice, which is sent and never said: `[emotion=warm]`. */
const direction = /\[[^\]]*\]/gu;

const spaces = /\s+/u;

/** A word's last character that ends a sentence, and one that ends a clause. */
const sentenceEnd = /[.?!…]$/u;
const clauseEnd = /[,;:]$/u;

/**
 * The pause after a word, in characters' worth of time: a breath after a
 * comma, a longer one after a full stop, as the page paces a line it has
 * no times for (apps/web/src/voice/timing.ts).
 */
const pauseAfter = (word: string): number => {
  if (sentenceEnd.test(word)) {
    return 6;
  }
  return clauseEnd.test(word) ? 3 : 1;
};

/**
 * When each word of a line is said, estimated: Mistral's speech names no
 * times, so each word takes its share of the audio's length by its
 * characters and the pause after it. Close enough to light a line's words
 * up as they are said (the page's use of them); never exact. Directions
 * are left out, as they aren't said.
 */
export const wordsOver = (text: string, durationMs: number): SpokenWord[] => {
  const written = text
    .replaceAll(direction, " ")
    .split(spaces)
    .filter((word) => word !== "");
  const shares = written.map((word) => charactersOf(word) + pauseAfter(word));
  const whole = shares.reduce((sum, share) => sum + share, 0);
  const words: SpokenWord[] = [];
  let before = 0;
  for (const [at, word] of written.entries()) {
    const share = shares[at] ?? 0;
    words.push({
      text: word,
      startMs: Math.round((before * durationMs) / whole),
      endMs: Math.round(((before + share) * durationMs) / whole),
    });
    before += share;
  }
  return words;
};
