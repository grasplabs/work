// Link's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `externalLabel` still win until the breaking release's step 5.
export const linkWords = {
  /** Said after a link that opens in a new tab, as part of its name. */
  external: "opens in a new tab",
};

export type LinkWords = typeof linkWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    link: LinkWords;
  }
}
