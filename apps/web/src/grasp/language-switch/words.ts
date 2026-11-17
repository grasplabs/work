// The Language switch's own words: every visible word is a prop, with these English defaults, so a
// product can translate all of it. The languages' names are the caller's, never these.

/** Every word the switch shows or says of its own. */
export interface LanguageSwitchWords {
  /** Its name: the menu's, the list's and the sheet's title ("Language"). */
  label: string;
  /** The search field's placeholder and name. */
  search: string;
  /** The clear button in the search field. */
  clearSearch: string;
  /** The group of suggested languages. */
  suggested: string;
  /** The group of every other language, under Suggested. */
  all: string;
  /** When a search finds nothing. */
  empty: string;
  /** The quiet row that asks for help with a translation. */
  helpTranslate: string;
}

export const defaultWords: LanguageSwitchWords = {
  label: "Language",
  search: "Search languages",
  clearSearch: "Clear search",
  suggested: "Suggested",
  all: "All languages",
  empty: "No language found",
  helpTranslate: "Help translate",
};

/** The button's name: what it is, and the language it shows ("Language, Nederlands"). */
export const defaultButtonLabel = (label: string, current: string): string =>
  `${label}, ${current}`;
