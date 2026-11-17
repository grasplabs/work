// Dialog's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `closeLabel` still wins until the breaking release's step 5.
export const dialogWords = {
  /** The name of the close button in the corner. */
  close: "Close",
};

export type DialogWords = typeof dialogWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    dialog: DialogWords;
  }
}
