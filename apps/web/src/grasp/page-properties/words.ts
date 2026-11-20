// Page properties' own words, in English. The product gives them in its languages through GraspWords
// (src/words).
export const pagePropertiesWords = {
  /** The toggle's name. */
  properties: "Properties",
  /** How many questions wait for an answer, beside the toggle's name ("1 open"). */
  open: (count: number) => `${String(count)} open`,
  /** An open question's value while nobody has answered it. */
  notAnswered: "Not answered yet",
  /** The button that asks the person who can answer. */
  ask: "Ask",
  /** The Ask button's name to a screen reader: whom it asks, and what. */
  askLabel: (who: string, question: string) =>
    `Ask the ${who.toLowerCase()}: ${question}`,
  /** Said while the question goes out. */
  asking: "Asking",
  /** Said once it has gone. */
  asked: "Asked",
  /** Said when it could not go. */
  askFailed: "Not asked",
};

export type PagePropertiesWords = typeof pagePropertiesWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    pageProperties: PagePropertiesWords;
  }
}
