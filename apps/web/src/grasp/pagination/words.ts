// Pagination's own words, in English. The product gives them in its languages through GraspWords
// (src/words), and numbers follow its locale; a caller's `unit` and `*Label` props still win
// until the breaking release's step 5.
/** What the items are called, by the language's plural forms: `other` always, `one` and the rest where the language has them. */
type PaginationUnit = Partial<Record<Intl.LDMLPluralRule, string>> & {
  other: string;
};
const englishUnit: PaginationUnit = { one: "item", other: "items" };

export const paginationWords = {
  /** Its name, for a page with more than one. */
  name: "Pagination",
  /** The name of the step back. */
  previous: "Previous page",
  /** The name of the step on. */
  next: "Next page",
  /** Said while the next page loads. */
  loading: "Loading the page",
  /** What the items are called, by the language's plural forms (`one`, `other`, and any it has). */
  unit: englishUnit,
  /** The range beside the steps: the first and last item shown, the total and what they are. */
  range: (first: string, last: string, total: string, unit: string) =>
    `Showing ${first} – ${last} of ${total} ${unit}`,
  /** The page beside the steps, for a screen reader. */
  page: (current: string, count: string) => `Page ${current} of ${count}`,
  /** When there are none. */
  none: (unit: string) => `No ${unit}`,
};

export type PaginationWords = typeof paginationWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    pagination: PaginationWords;
  }
}
