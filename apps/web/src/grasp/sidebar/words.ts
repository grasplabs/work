// The Sidebar's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a row's `actionsLabel`, `renamedLabel` and `workingLabel` still win where a caller
// passes them. Renaming a row reads the shared rename words (src/words/rename.ts), as App shell's
// panel title does.

export const sidebarWords = {
  /** The sidebar's name, said as its landmark. */
  name: "Sidebar",
  /** The main list's navigation, said as its landmark. */
  main: "Main",
  /** The search button's name. */
  search: "Search",
  /** The fold button's name. */
  fold: "Show or hide the sidebar",
  /** The tabs' name, over the main list. */
  views: "Views",
  /** A section's way back. */
  back: "Back",
  /** The theme's row in the person's menu. */
  appearance: "Appearance",
  /** The three dots' name: which row's menu they open. */
  actions: (label: string) => `More for ${label}`,
  /** What a screen reader hears once a row is renamed. */
  renamed: (name: string) => `Renamed to ${name}`,
  /** Said after a row's name while the agent works there. */
  working: "Working",
};

export type SidebarWords = typeof sidebarWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    sidebar: SidebarWords;
  }
}
