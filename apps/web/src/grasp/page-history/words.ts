// Page history's own words, in English. The product gives them in its languages through GraspWords
// (src/words).
export const pageHistoryWords = {
  /** The sheet's title. */
  title: "History",
  /** Under the title: what it holds, and that Restore loses nothing. */
  description:
    "Every change, with who made it. Restore brings a version back as a new one; nothing is lost.",
  /** The list of versions, to a screen reader. */
  versions: "Versions",
  /** After the newest version's author. */
  now: "now",
  /** Over the changes when the newest version is chosen. */
  isNow: "This is the page now",
  /** Over the changes since an older version. */
  since: (who: string, when: string) => `What changed since ${who}, ${when}`,
  /** The changes, to a screen reader. */
  changes: "Changes",
  /** The button that brings the chosen version back. */
  restore: "Restore this version",
};

export type PageHistoryWords = typeof pageHistoryWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    pageHistory: PageHistoryWords;
  }
}
