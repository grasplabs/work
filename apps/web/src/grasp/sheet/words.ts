// Sheet's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `closeLabel` (and SheetClose's `label`) still wins until the breaking
// release's step 5.
export const sheetWords = {
  /** The name of the close button in the corner. */
  close: "Close",
};

export type SheetWords = typeof sheetWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    sheet: SheetWords;
  }
}
