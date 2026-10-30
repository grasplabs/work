import { voiceTags } from "@grasp-os/shared/interview-links";
import { interviewLocales } from "@grasp-os/shared/onboarding";
import { defaultPlatformAi } from "@grasp-os/shared/platform-ai";
import type { Speaker } from "@grasp-os/shared/voice";

import { platformAi } from "../platform-ai.ts";
import { forgetLines, storedKeysOf } from "../speech-cache.ts";
import type { SpokenKey } from "../speech-cache.ts";
import { speechModelOf } from "../speech.ts";

// How Stephen's lines are said (speech.ts), and taking them out of the
// cache of lines said before (speech-cache.ts) once the interview they
// were said in is deleted (GRA-368): his lines read back what someone
// told, and the cache keeps a line's words with its sound for a month.

/**
 * Each speaker's voice, by the speech provider's name for it: the
 * platform's settings' (@grasp-os/shared/platform-ai); none while they
 * don't parse.
 */
export const speakerVoicesOf = (
  env: Pick<Env, "PLATFORM_AI">
): Record<Speaker, string> | undefined => platformAi(env)?.speech.voices;

/**
 * How a line is to be said, for the speech model to hear apart from the
 * line itself: the tone it takes, one of Stephen's (`voiceTags`).
 */
export const toneInstructions = (
  tone: string | undefined
): string | undefined =>
  tone === undefined ? undefined : `Say it in this tone: ${tone}.`;

/**
 * What a line is kept by in the cache, of what is said: the line led by
 * its tone, in any language, as the tone changes how it sounds.
 */
export const spokenOf = (text: string, tone: string | undefined): string =>
  tone === undefined ? text : `[${tone}] ${text}`;

/** What was said in an interview, as its lines may have been kept. */
export interface SaidIn {
  /** The lines the interviewer said, and the facts read back. */
  texts: readonly string[];
  /** Who said them; both interviewers when it isn't known. */
  speakers: readonly Speaker[];
  /** In which language; every one when it isn't known. */
  languages: readonly string[];
}

/**
 * Every key a line of `said` may be kept by: each tone, speech model,
 * speaker's voice and language, the platform's settings' now and the
 * defaults', so a line kept before the settings changed back is found too.
 */
const keysOf = (env: Env, said: SaidIn): SpokenKey[] => {
  const defaults = defaultPlatformAi.speech;
  const models = [
    ...new Set([
      `${defaults.provider}/${defaults.model}`,
      ...[speechModelOf(env)].filter((model) => model !== undefined),
    ]),
  ];
  const voices = speakerVoicesOf(env);
  const tones = [undefined, ...voiceTags];
  return said.texts.flatMap((text) =>
    said.languages.flatMap((language) =>
      tones.flatMap((tone) =>
        said.speakers.flatMap((speaker) =>
          [...new Set([defaults.voices[speaker], voices?.[speaker]])]
            .filter((voice) => voice !== undefined)
            .flatMap((voice) =>
              models.map((model) => ({
                spoken: spokenOf(text, tone),
                voice,
                model,
                language,
              }))
            )
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
