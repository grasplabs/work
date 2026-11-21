// Step bar's own words, in English. The product gives them in its languages through GraspWords
// (src/words).
export const stepBarWords = {
  /** Back's name and tip: the step before. */
  back: "Back",
  /** Next's name and tip: the next step. */
  next: "Next",
  /** Which step of how many, said with the bar and shown beside it when asked ("Step 3 of 7"). */
  step: (step: number, count: number) => `Step ${step} of ${count}`,
};

export type StepBarWords = typeof stepBarWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    stepBar: StepBarWords;
  }
}
