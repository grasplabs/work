// The Ask bar's own words, in English: the bar, its panel's head and the page picker. The product
// gives them in its languages through GraspWords (src/words); a caller's text props still win until
// the breaking release's step 5. The box's own words (Add, Upload, Stop, Writing) are the Composer's.
export const askBarWords = {
  /** Under the bar when a send failed, and given to an agent (`failedLabel`). */
  failed: "Could not send",
  /** Said while the answer is on its way (`workingLabel`). */
  working: "Working",
  /** The button that picks a part of the page to ask about (`targetLabel`). */
  target: "Target",
  /** The button that dictates (`dictateLabel`). */
  dictate: "Dictate",
  /** Said when the page picker starts (`useTargetPicker`'s `startLabel`). */
  pick: "Pick a part of the page. Escape to stop.",
  /** The panel's name while the chat has none yet (AskPanelHead `titleFallback`). */
  untitled: "New chat",
  /** The button that starts a new chat (AskPanelHead `newLabel`). */
  newChat: "New chat",
  /** The button that takes the panel full screen (AskPanelHead `expandLabel`). */
  expand: "Full screen",
  /** The same button while full screen (AskPanelHead `dockLabel`). */
  dock: "Dock beside the page",
  /** The button that closes the chat (AskPanelHead `closeLabel`). */
  close: "Close the chat",
};

export type AskBarWords = typeof askBarWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    askBar: AskBarWords;
  }
}
