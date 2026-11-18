// Question tool's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `…Label` props and `label` still win until the breaking release's step 5.
export const questionToolWords = {
  /** The row for an answer of one's own. */
  other: "Other",
  /** The question's name, as a group, when it gives none. */
  name: "Question",
  /** The button that sends the answer. */
  submit: "Send answer",
  /** The button that skips the question. */
  skip: "Skip",
  /** The button to the question before. */
  back: "Back",
  /** The mark on the recommended choice. */
  recommended: "Recommended",
  /** Which question of how many ("2 of 3"). */
  step: (step: number, count: number) => `${step} of ${count}`,
};

export type QuestionToolWords = typeof questionToolWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    questionTool: QuestionToolWords;
  }
}
