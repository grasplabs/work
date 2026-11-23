// The order a person types a date in: the page's language in their own
// region. A browser's date field follows the browser's region, so an
// English page in a browser set to the UK reads 12/01/2027 as 12 January,
// in one set to the US as 1 December. Pure: send-plan-form.tsx gives it
// the page's language and the browser's languages.

const localeOf = (tag: string): Intl.Locale | undefined => {
  try {
    return new Intl.Locale(tag);
  } catch {
    // Not a language tag: it says nothing of a region.
    return undefined;
  }
};

/**
 * The locale a typed date is read and written in, for a page in
 * `language` in a browser that prefers `browser` (`navigator.languages`):
 * the browser's own choice of region for that language ("en-GB"), else
 * the region of its first language ("en" with "nl-NL" first: "en-NL",
 * day first), else the language's usual one ("en": the US).
 */
export const dateLocale = (
  language: string,
  browser: readonly string[]
): string => {
  const base = localeOf(language)?.language ?? "en";
  const preferred = browser.flatMap((tag) => {
    const locale = localeOf(tag);
    return locale === undefined ? [] : [locale];
  });
  const own = preferred.find(
    (locale) => locale.language === base && locale.region !== undefined
  );
  const region = own?.region ?? preferred[0]?.maximize().region;
  return region === undefined ? base : `${base}-${region}`;
};
