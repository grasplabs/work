// How Stephen's lines are said (speech.ts). What the voice was asked to
// say is noted by the onboarding's store by its cache key, as it is asked
// (the store's `speechOnLink` and `speechForAdmin`), and erasing anything
// of an interview takes all of it out of the cache (GRA-368, GRA-1897).

/**
 * What the voice is sent: the line, bare, whatever tone it was asked in.
 * An emotion tag per line (https://docs.mistral.ai/studio/audio/
 * text-to-speech/emotion-tags) gave each line of Stephen's a delivery of
 * its own, so his lines jumped from one tone to the next, and in Dutch
 * pulled them toward English, the one language Mistral tested its tags
 * in. Untagged, Voxtral takes the emotion from the words, in Rob's own
 * steady voice.
 */
export const spokenOf = (text: string): string => text;
