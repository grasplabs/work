import {
  speechProviders,
  transcriptionProviders,
} from "@grasp-os/shared/platform-ai";
import type { SpokenWord } from "@grasp-os/shared/voice";

import type { ListPrices } from "./model-prices.ts";

// The voice models the model gateway offers (models.ts) for Grasp's own
// speech and listening (@grasp-os/shared/platform-ai), beside the text
// models of pi's catalog: our own small catalog, as pi's has no voice
// models. Each speech model is priced by what the provider bills for it:
// the text it is asked to say, per character, and the audio it answers
// with, per millisecond, the ledger reserving the longest a line may play
// and charging how long it did. Each transcription model is priced per
// second it hears, at a price never below what the provider bills for it.
// Grasp pays for these on its own keys: no organization's budget holds
// them, but the ledger records what each cost, for the spend overview.

/**
 * OpenAI's prices for text to speech (OpenAI's pricing page, read on
 * 2026-10-31), in US dollars: the text in, per million characters, and
 * the audio out, per minute. GPT-4o mini TTS is billed per token: $0.60 a
 * million of text in, never more tokens than characters in the languages
 * an interview is held in, and $12 a million of audio out, which OpenAI
 * puts at $0.015 a minute of speech. `tts-1` and `tts-1-hd` are billed
 * per character alone, $15 and $30 a million, nothing for the audio.
 */
const speechPrices = {
  "gpt-4o-mini-tts": { perMillionChars: 0.6, perMinuteAudio: 0.015 },
  "tts-1": { perMillionChars: 15, perMinuteAudio: 0 },
  "tts-1-hd": { perMillionChars: 30, perMinuteAudio: 0 },
} as const;

/**
 * The longest a line plays, per character it says, in ms: five
 * characters a second, slower than anyone speaks. What the ledger
 * reserves for a line's audio before it is said.
 */
export const speechMsPerCharMost = 200;

/** A speech model the gateway offers. */
export interface VoiceRef {
  provider: (typeof speechProviders)[number];
  id: keyof typeof speechPrices;
}

const isVoiceModel = (id: string): id is VoiceRef["id"] =>
  Object.hasOwn(speechPrices, id);

const isSpeechProvider = (provider: string): provider is VoiceRef["provider"] =>
  speechProviders.some((one) => one === provider);

/**
 * A speech model as the gateway names it, `<provider>/<model>`, such as
 * `openai/gpt-4o-mini-tts`; `undefined` for any other.
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
 * A speech model's prices in the shape the ledger pins: its input per
 * million characters of text it is asked to say, its output per million
 * ms of audio it answers with. A model that bills nothing for the audio
 * is priced its input rate for it too, as the ledger takes no free rate,
 * and is never charged any (`speechCountsOf`).
 */
export const voicePricesOf = ({ id }: VoiceRef): ListPrices => {
  const { perMillionChars, perMinuteAudio } = speechPrices[id];
  const perMillionMs = (perMinuteAudio / 60_000) * 1_000_000;
  return {
    input: perMillionChars,
    output: perMillionMs > 0 ? perMillionMs : perMillionChars,
    cacheRead: 0,
    cacheWrite: 0,
  };
};

/**
 * What a line counts as, at `voicePricesOf`'s rates: its characters in,
 * and the ms of audio it answered with, for a model that bills its audio.
 */
export const speechCountsOf = (
  { id }: VoiceRef,
  characters: number,
  audioMs: number
): { input: number; output: number } => ({
  input: characters,
  output: speechPrices[id].perMinuteAudio > 0 ? Math.ceil(audioMs) : 0,
});

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
 * Characters a line is charged as, its instructions with it: their UTF-16
 * length, never fewer than the characters (code points) or tokens a
 * provider counts, so the ledger's reservation is never below what the
 * line's text is billed.
 */
export const charactersOf = (text: string): number => text.length;

/**
 * The audio OpenAI's speech answers with when asked for `pcm`: 16-bit
 * signed little-endian samples, mono, at 24 kHz. Asked for so the line's
 * length is known exactly, from its size, as no provider's speech says
 * when each word is said.
 */
export const speechPcm = { sampleRate: 24_000, bytesPerSample: 2 } as const;

/** How long `bytes` of the speech's PCM take to play, in ms. */
export const pcmMs = (bytes: number): number =>
  (bytes / (speechPcm.sampleRate * speechPcm.bytesPerSample)) * 1000;

const wavHeaderBytes = 44;

/**
 * `pcm` (16-bit, mono, at `sampleRate`) as a WAV file, which every browser
 * plays: the canonical 44-byte RIFF header, then the samples unchanged.
 */
export const wavOf = (pcm: Uint8Array, sampleRate: number): Uint8Array => {
  const wav = new Uint8Array(wavHeaderBytes + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const ascii = (at: number, text: string): void => {
    for (let offset = 0; offset < text.length; offset += 1) {
      view.setUint8(at + offset, text.codePointAt(offset) ?? 0);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, wavHeaderBytes - 8 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  // The format chunk: 16 bytes, PCM, mono.
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * speechPcm.bytesPerSample, true);
  view.setUint16(32, speechPcm.bytesPerSample, true);
  view.setUint16(34, speechPcm.bytesPerSample * 8, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, wavHeaderBytes);
  return wav;
};

const wordPattern = /\S+/gu;

/**
 * The words of a line said in `ms`, each between spaces, punctuation with
 * its word, timed by its share of the line's characters: when each word is
 * said, as near as the length of the audio tells, for the page to light
 * the words up as they are said. The last ends with the audio.
 */
export const wordsTimed = (text: string, ms: number): SpokenWord[] => {
  const words = [...text.matchAll(wordPattern)].map(([word]) => word);
  const total = words.reduce((sum, word) => sum + word.length, 0);
  if (total === 0) {
    return [];
  }
  let said = 0;
  return words.map((word) => {
    const startMs = Math.round((said / total) * ms);
    said += word.length;
    return { text: word, startMs, endMs: Math.round((said / total) * ms) };
  });
};
