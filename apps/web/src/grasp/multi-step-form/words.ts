// Multi-step form's own words, in English. The product gives them in its languages through
// GraspWords (src/words); a caller's `…Label` props still win until the breaking release's step 5.
export const multiStepFormWords = {
  /** The button to the page before. */
  back: "Back",
  /** The button to the next page. */
  next: "Next",
  /** The button that sends it, on the last page. */
  submit: "Send",
  /** Said when sending failed. */
  failed: "Could not send",
  /** Said before the page's count, to a screen reader. */
  page: "Page",
  /** Which page of how many ("2 of 4"). */
  counter: (page: number, total: number) => `${page} of ${total}`,
};

export type MultiStepFormWords = typeof multiStepFormWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    multiStepForm: MultiStepFormWords;
  }
}
