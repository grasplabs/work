// Button's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `workingLabel` and `holdLabels` still win until the breaking release's
// step 5.
export const buttonWords = {
  /** Said to a screen reader while it works, when no `workingLabel` is given. */
  working: "Working",
  /** A hold's name while it is held, from the button's own words: "Hold to delete draft". */
  holdTo: (words: string) =>
    `Hold to ${words.charAt(0).toLowerCase()}${words.slice(1)}`,
  /** A hold's confirmation title, from the button's words: "Delete draft?". */
  ask: (words: string) => `${words}?`,
  /** The confirmation's title when the button has no words. */
  confirm: "Confirm",
  /** The confirmation's way out. */
  cancel: "Cancel",
  /** What an agent is told before it presses a danger or approve button with no words. */
  agentAsks: "Does something that needs your yes",
  /** What an agent is told before it presses a danger or approve button, from its words. */
  agentPresses: (words: string) => `Presses "${words}"`,
  /** What an agent's press is told while the button still shows its result. */
  agentStillSays: (shown: string) =>
    `It still says "${shown}". Press it again in a moment.`,
};

export type ButtonOwnWords = typeof buttonWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    button: ButtonOwnWords;
  }
}
