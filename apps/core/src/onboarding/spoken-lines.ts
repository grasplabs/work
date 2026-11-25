// How Stephen's lines are said (speech.ts). What the voice was asked to
// say is noted by the onboarding's store by its cache key, as it is asked
// (the store's `speechOnLink` and `speechForAdmin`), and erasing anything
// of an interview takes all of it out of the cache (GRA-368, GRA-1897).

import type { voiceTags } from "@grasp-os/shared/interview-links";

/**
 * The emotion Voxtral says each of Stephen's tones with, one of its own
 * (https://docs.mistral.ai/studio/audio/text-to-speech/emotion-tags); none
 * for a tone that is the voice as it is.
 */
const emotions: Readonly<Record<(typeof voiceTags)[number], string | null>> = {
  "warm, relaxed": "warm",
  "sincere, steady": "calm",
  "curious, gently": "curious",
  softly: "calm",
  "interested, a little lighter": "curious",
  patient: "calm",
  "neutral, light": null,
  "upbeat, understanding": "hopeful",
  "upbeat, reassuring": "confident",
  "sincere, steady, reassuring": "calm",
  "amused, soft chuckle": "amused",
  warm: "warm",
  "easy, light": null,
  "clear, measured pace": "calm",
  "warm, grateful": "grateful",
  "warm, kind": "warm",
};

/**
 * The languages whose lines are led by their emotion tag: only English,
 * the one language Mistral has tested its tags in (https://docs.mistral.ai/
 * studio/audio/text-to-speech/emotion-tags). In Dutch a tag pulls the
 * line toward English delivery, so Stephen sounds English; the model
 * takes the emotion from the words themselves, untagged.
 */
const taggedLanguages: ReadonlySet<string> = new Set(["en"]);

/**
 * What the voice is sent: the line led by its tone, as an emotion tag,
 * which isn't said, in a language whose tags were tested
 * (`taggedLanguages`); the bare line in any other, or for no tone.
 */
export const spokenOf = (
  text: string,
  tone: (typeof voiceTags)[number] | undefined,
  language: string
): string => {
  const emotion =
    tone === undefined || !taggedLanguages.has(language)
      ? null
      : emotions[tone];
  return emotion === null ? text : `[emotion=${emotion}]${text}`;
};
