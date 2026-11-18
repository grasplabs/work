// Dropdown menu's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `pendingAnnouncement` still win until the breaking release's step 5.
export const dropdownMenuWords = {
  /** Said while an item's work is under way. An item's own `failedLabel` is the caller's. */
  working: "Working",
};

export type DropdownMenuWords = typeof dropdownMenuWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    dropdownMenu: DropdownMenuWords;
  }
}
