// How Stephen's lines are said (speech.ts). What the voice was asked to
// say is noted by the onboarding's store by its cache key, as it was
// asked (`noteSpoken`), and erasing anything of an interview takes all of
// it out of the cache (GRA-368, GRA-1897).

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
