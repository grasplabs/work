// Tree's own words, in English. The product gives them in its languages through GraspWords
// (src/words).
export const treeWords = {
  /** The filter field's name and its placeholder. */
  filter: "Filter",
  /** Clears the filter field. */
  clear: "Clear the filter",
  /** Shown in the tree's place when the filter matches nothing. */
  noMatches: "No matches",
};

export type TreeWords = typeof treeWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    tree: TreeWords;
  }
}
