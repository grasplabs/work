// Empty's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `title` (or EmptyTitle's words) still wins until the breaking release's
// step 5. Its other words are the host's: what will appear here, and the action.
export const emptyWords = {
  /** An error's title when it is given none, so it is never read as an empty list. */
  failed: "This did not load",
};

export type EmptyWords = typeof emptyWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    empty: EmptyWords;
  }
}
