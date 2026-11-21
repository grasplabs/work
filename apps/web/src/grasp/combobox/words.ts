// Combobox's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `empty` and `triggerLabel` still win until the breaking release's step 5.
export const comboboxWords = {
  /** Said in the list when nothing matches. */
  empty: "No results",
  /** The name of the button that opens the list. */
  trigger: "Show the choices",
  /** At a row's end in the list's picture (ListItemStill), when its action failed. */
  failed: "Failed",
};

export type ComboboxWords = typeof comboboxWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    combobox: ComboboxWords;
  }
}

/**
 * What it tells an agent that chose a value outside the list, and a developer who gave one: they
 * read English, so these are kept here with the words and are not in the catalogue.
 */
export const comboboxNotices = {
  notChoice: (value: string) => `${value} is not one of the choices`,
  notItem: (value: string) => `Combobox: ${value} is not one of its items.`,
};
