import { voiceTags } from "@grasp-os/shared/interview-links";
import { interviewLocales } from "@grasp-os/shared/onboarding";
import type { Speaker } from "@grasp-os/shared/voice";

import { gatewaySettings } from "../models.ts";
import { forgetLines, storedKeysOf } from "../speech-cache.ts";
import type { SpokenKey } from "../speech-cache.ts";

// How Stephen's lines are said (speech.ts), and taking them out of the
// cache of lines said before (speech-cache.ts) once the interview they
// were said in is deleted (GRA-368): his lines read back what someone
// told, and the cache keeps a line's words with its sound for a month.

/**
 * Each speaker's voice, by its ElevenLabs ID. Stephen's is "Adam", the
 * voice Eleven v4 is shown with: young, confident, conversational.
 * Claire's is "Jessica": playful, bright and warm, checked by ElevenLabs
 * in English, Dutch, German and Spanish, not in French. The sample
 * speakers are ElevenLabs's own voices, each clearly not Stephen.
 */
export const speakerVoices: Record<Speaker, string> = {
  stephen: "s3TPKV1kjDlVtZbl4Ksh",
  claire: "r1KmysJdVYZjJCm4mL3b",
  lisa: "EXAVITQu4vr4xnSDxMaL",
  mark: "cjVigY5qzO86Huf0OWal",
  tim: "TX3LPaxmHKxFdv7VOQHJ",
};

/**
 * The voice models a line is said in, by the gateway's names: Eleven v4,
 * the most expressive; for a line only known as it is said, v4 Turbo,
 * which is quicker, with the same voices and directions.
 */
export const voiceModels = {
  said: "elevenlabs/eleven_v4",
  quick: "elevenlabs/eleven_v4_turbo",
} as const;

/**
 * What the voice is sent: the line led by its tone, in English; the bare
 * line in any other language. A direction is English words in front of
 * the line, and the voice then starts it in English: the first Dutch word
 * came out with an English sound, "nog" as "nok".
 */
export const spokenOf = (
  text: string,
  language: string,
  tone: string | undefined
): string =>
  tone !== undefined && language === "en" ? `[${tone}] ${text}` : text;

/** What was said in an interview, as its lines may have been kept. */
export interface SaidIn {
  /** The lines the interviewer said, and the facts read back. */
  texts: readonly string[];
  /** Who said them; both interviewers when it isn't known. */
  speakers: readonly Speaker[];
  /** In which language; every one when it isn't known. */
  languages: readonly string[];
}

/** Every key a line of `said` may be kept by: each tone, voice model, speaker and language. */
const keysOf = (env: Env, said: SaidIn): SpokenKey[] => {
  const models = [
    ...new Set([
      voiceModels.said,
      voiceModels.quick,
      ...gatewaySettings(env).voices,
    ]),
  ];
  const tones = [undefined, ...voiceTags];
  return said.texts.flatMap((text) =>
    said.languages.flatMap((language) =>
      (language === "en" ? tones : [undefined]).flatMap((tone) =>
        said.speakers.flatMap((speaker) =>
          models.map((model) => ({
            spoken: spokenOf(text, language, tone),
            voice: speakerVoices[speaker],
            model,
            language,
          }))
        )
      )
    )
  );
};

/**
 * Takes out of the cache every line of `said`, as it may have been kept.
 * A line someone else heard too ("Hello, I'm Stephen") is said anew the
 * next time: a cost, never a leak.
 */
export const forgetSpokenLines = async (
  env: Env,
  said: SaidIn
): Promise<void> => {
  if (said.texts.length === 0) {
    return;
  }
  await forgetLines(env, keysOf(env, said));
};

/**
 * The stored keys of every line of `said`, as it may have been kept:
 * hashes, so they can wait to be taken out without keeping what was said.
 */
export const spokenKeysOf = async (
  env: Env,
  said: SaidIn
): Promise<string[]> =>
  said.texts.length === 0 ? [] : await storedKeysOf(keysOf(env, said));

/** Every language an interview may be held in, when its own isn't known. */
export const anyLanguage: readonly string[] = interviewLocales;
