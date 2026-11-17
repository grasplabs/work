// Section card's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's text props still win until the breaking release's step 5.
export const sectionCardWords = {
  /** The info mark's name beside the title, for a screen reader. */
  info: "More about this section",
};

export type SectionCardWords = typeof sectionCardWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    sectionCard: SectionCardWords;
  }
}
