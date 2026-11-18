// Dialog's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `closeLabel` still wins until the breaking release's step 5.
export const dialogWords = {
  /** The name of the close button in the corner. */
  close: "Close",
  /**
   * An action whose work failed, when the host gives no `failedLabel` of its own: neutral, as the
   * work may be a save, a check or a send.
   */
  actionFailed: "Could not finish",
};

export type DialogWords = typeof dialogWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    dialog: DialogWords;
  }
}
