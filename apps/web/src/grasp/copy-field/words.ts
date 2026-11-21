// Copy field's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's text props still win until the breaking release's step 5.
export const copyFieldWords = {
  /** Said once it is copied, and what the tick means. */
  copied: "Copied",
  /** Said when it could not copy. */
  failed: "Could not copy",
};

export type CopyFieldWords = typeof copyFieldWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    copyField: CopyFieldWords;
  }
}
