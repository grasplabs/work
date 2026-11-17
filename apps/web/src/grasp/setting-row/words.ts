// Setting row's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's text props still win until the breaking release's step 5.
export const settingRowWords = {
  /** The info mark's name, for a screen reader. */
  info: "More about this setting",
  /** Said while it saves. */
  saving: "Saving",
  /** Said once it saved. */
  saved: "Saved",
  /** Said when the save failed: what did not happen, and that the value is kept. */
  failed: "Could not save. Your choice is kept.",
  /** The button that saves again. */
  retry: "Try again",
};

export type SettingRowWords = typeof settingRowWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    settingRow: SettingRowWords;
  }
}
