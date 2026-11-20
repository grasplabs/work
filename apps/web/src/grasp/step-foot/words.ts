// Step foot's own words, in English. The product gives them in its languages through GraspWords
// (src/words).
export const stepFootWords = {
  /** The button to the step before. */
  back: "Back",
  /** The button to the next step. */
  next: "Next",
  /** Which step of how many, said with the bar and shown beside it when asked ("Step 3 of 7"). */
  step: (step: number, count: number) => `Step ${step} of ${count}`,
};

export type StepFootWords = typeof stepFootWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    stepFoot: StepFootWords;
  }
}
