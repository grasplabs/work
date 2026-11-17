"use client";

import { createContext, use } from "react";
import type { ReactNode } from "react";

/**
 * Every part's owned words, by part. Empty here: each part adds its own entry from its
 * `words.ts`, by declaration merging, so the type lists exactly the parts a product installed.
 *
 *   declare module "../../words/words" { interface GraspWordsCatalog { pagination: PaginationWords } }
 */
// oxlint-disable-next-line typescript/no-empty-object-type, typescript/no-empty-interface -- filled by each part's words.ts (declaration merging)
export interface GraspWordsCatalog {}

/** The name of a part in the catalog ("pagination"). */
export type GraspPart = keyof GraspWordsCatalog;

const WordsContext = createContext<Partial<GraspWordsCatalog> | undefined>(
  undefined
);
const LocaleContext = createContext<string | undefined>(undefined);

export interface GraspWordsProps {
  /** The page's language, as a BCP 47 tag ("nl-NL"): numbers and dates are formatted in it. */
  locale: string;
  /** Every installed part's words in that language. A module constant, never built during render. */
  words: GraspWordsCatalog;
  children: ReactNode;
}

/** The words of every part inside it, in one language. Once per React root. */
export const GraspWords = ({ locale, words, children }: GraspWordsProps) => (
  <LocaleContext value={locale}>
    <WordsContext value={words}>{children}</WordsContext>
  </LocaleContext>
);

/**
 * A part's words: the provider's for this part, else the part's own English. Each key falls back
 * on its own, so a catalog from before a part gained a key still works.
 */
export const useWords = <P extends GraspPart>(
  part: P,
  english: GraspWordsCatalog[P]
): GraspWordsCatalog[P] => {
  const given = use(WordsContext)?.[part];
  // Object.assign, as each entry's type is a part's own object, which a generic spread cannot know.
  // oxlint-disable-next-line unicorn/prefer-object-spread, prefer-object-spread -- see above
  return given === undefined ? english : Object.assign({}, english, given);
};

/** The page's language for numbers and dates: the provider's, else the browser's, else English. */
export const useWordsLocale = (): string | undefined => use(LocaleContext);

/**
 * A part's words with a caller's text props over them, where given (until the breaking release's
 * step 5 removes those props): `withGiven(words, { close: closeLabel })`.
 */
export const withGiven = <W extends object>(words: W, given: Partial<W>): W => {
  const out: W = { ...words };
  for (const [key, value] of Object.entries(given)) {
    if (value !== undefined) {
      Object.assign(out, { [key]: value });
    }
  }
  return out;
};
