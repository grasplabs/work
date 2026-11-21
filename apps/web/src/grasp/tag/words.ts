// Tag's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's text props still win until the breaking release's step 5.
export const tagWords = {
  /** The remove button's name, when the words are not text. */
  remove: "Remove",
  /** The remove button's name, from the tag's words. */
  removeNamed: (words: string) => `Remove ${words}`,
};

export type TagWords = typeof tagWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    tag: TagWords;
  }
}
