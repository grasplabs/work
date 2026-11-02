/** The cookie that keeps the person's choice, for this browser. Not a secret, read by no server. */
export const localeCookie = "grasp-locale";

/**
 * The language a page speaks, of the `spoken` ones: the one the person
 * chose (`chosen`), else the first of the browser's `languages` it speaks,
 * else English.
 *
 * i18n.ts chooses with it, and locale-preload.ts writes it, as its source,
 * into the script that preloads that language's catalog before the app
 * runs, so both choose alike. That is why it uses nothing but its
 * arguments.
 */
export const pickLocale = (
  chosen: string | undefined,
  languages: readonly string[],
  spoken: readonly string[]
): string =>
  [
    chosen,
    ...languages.map((tag) => tag.toLowerCase().split("-")[0]),
    "en",
  ].find((each) => each !== undefined && spoken.includes(each)) ?? "en";
