// Alert's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `dismissLabel` still wins until the breaking release's step 5.
export const alertWords = {
  /** The banner look's dismiss button, named for a screen reader. */
  dismiss: "Dismiss",
};

export type AlertWords = typeof alertWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    alert: AlertWords;
  }
}
