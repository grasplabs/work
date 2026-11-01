import { interviewLocales } from "@grasp-os/shared/onboarding";
import type { Speaker } from "@grasp-os/shared/voice";

import { forgetLines, storedKeysOf } from "../speech-cache.ts";

// How Stephen's lines are said (speech.ts), and taking them out of the
// cache of lines said before (speech-cache.ts) once the interview they
// were said in is deleted (GRA-368): his lines read back what someone
// told, and the cache keeps a line's words with its sound for a month.

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

/**
 * Takes out of the cache every line of `said`, however it was said: in
 * any voice, model, tone or language, the speech settings' now or any
 * before (speech-cache.ts). A line someone else heard too ("Hello, I'm
 * Stephen") is said anew the next time: a cost, never a leak.
 */
export const forgetSpokenLines = async (
  env: Pick<Env, "FILES">,
  said: SaidIn
): Promise<void> => {
  if (said.texts.length === 0) {
    return;
  }
  await forgetLines(env, said.texts);
};

/**
 * What erasing every line of `said` takes out of the cache, however it was
 * said: hashes, so they can wait to be taken out without keeping what was
 * said.
 */
export const spokenKeysOf = async (said: SaidIn): Promise<string[]> =>
  await storedKeysOf(said.texts);

/** Every language an interview may be held in, when its own isn't known. */
export const anyLanguage: readonly string[] = interviewLocales;
