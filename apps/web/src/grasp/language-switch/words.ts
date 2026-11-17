// The Language switch's own words, in English. The product gives them in its languages through
// GraspWords (src/words), as the catalogue's `languageSwitch`; a caller's `…Label` props still win
// until the breaking release's step 5. The languages' names are the caller's, never these.

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

/** The switch's words in the catalogue: its own, and the button's name. */
export const languageSwitchWords = {
  ...defaultWords,
  button: defaultButtonLabel,
};

export type LanguageSwitchCatalogueWords = typeof languageSwitchWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    languageSwitch: LanguageSwitchCatalogueWords;
  }
}
