// What the Language switch knows about its options: finding one, its direction, its second name
// from the browser, search without case or accents, and the suggested ones first. Nothing here
// translates: every name is the caller's, the second name the browser's own.
import type { FlagData } from "../flags";

/** One language a person can choose. */
export interface LanguageOption {
  /** The locale as BCP 47 ("nl-NL", "ar"): the value the switch hands back, and the option's `lang`. */
  code: string;
  /** Its name in its own language ("Nederlands", "日本語"). */
  name: string;
  /**
   * A quiet second name ("Dutch"). Left out, the browser's own name for it in the chosen language
   * is shown, where it differs.
   */
  secondName?: string;
  /** The flag of the region it stands for: one of the exports of src/flags (`NL`, `BR`). */
  flag?: FlagData;
  /** Its code in a tile of a flag's shape, for a language with no fair flag ("AR", "EO"). */
  flagCode?: string;
  /** Its direction. Left out, Arabic, Hebrew, Persian, Urdu and their neighbours are right to left. */
  dir?: "ltr" | "rtl";
}

// The scripts written right to left, by their language's code.
const rightToLeft = new Set([
  "ar",
  "arc",
  "ckb",
  "dv",
  "fa",
  "he",
  "iw",
  "ks",
  "ku",
  "ps",
  "sd",
  "ug",
  "ur",
  "yi",
]);

/** The language's primary code ("nl" from "nl-BE"). */
export const primaryOf = (code: string): string =>
  (code.split("-")[0] ?? code).toLowerCase();

export const directionOf = (option: LanguageOption): "ltr" | "rtl" =>
  option.dir ?? (rightToLeft.has(primaryOf(option.code)) ? "rtl" : "ltr");

/** `dir` for an element: only written for right to left, so a left-to-right row inherits. */
export const dirAttribute = (option: LanguageOption): "rtl" | undefined =>
  directionOf(option) === "rtl" ? "rtl" : undefined;

export const findOption = (
  options: readonly LanguageOption[],
  code: string
): LanguageOption | undefined => options.find((option) => option.code === code);

// The browser's name for a language, in another; nothing when it has none or the code is not one.
const displayName = (code: string, inLanguage: string): string | undefined => {
  try {
    const names = new Intl.DisplayNames([inLanguage], {
      type: "language",
      fallback: "none",
    });
    return names.of(code);
  } catch {
    return undefined;
  }
};

// Words compared without case or accents, so "francais" finds "Français".
const plain = (words: string): string =>
  words
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** The quiet second name in `inLanguage`, or nothing when it would only repeat the first. */
export const secondNameOf = (
  option: LanguageOption,
  inLanguage: string,
  automatic: boolean
): string | undefined => {
  if (option.secondName !== undefined) {
    return option.secondName;
  }
  if (!automatic || primaryOf(option.code) === primaryOf(inLanguage)) {
    return undefined;
  }
  const name = displayName(option.code, inLanguage);
  if (name === undefined || plain(name) === plain(option.name)) {
    return undefined;
  }
  return name;
};

/** Whether an option answers a search: by its own name, its second name or its code. */
export const answers = (
  option: LanguageOption,
  query: string,
  inLanguage: string
): boolean => {
  const wanted = plain(query.trim());
  if (wanted === "") {
    return true;
  }
  const words = [
    option.name,
    option.code,
    option.secondName ?? "",
    displayName(option.code, inLanguage) ?? "",
    displayName(option.code, "en") ?? "",
  ];
  return words.some((each) => each !== "" && plain(each).includes(wanted));
};

/**
 * The suggested options, in the order asked (as `navigator.languages` hands them in): an exact
 * code first, else the first option of the same language. Each at most once.
 */
export const suggestedOf = (
  options: readonly LanguageOption[],
  wanted: readonly string[] | undefined
): LanguageOption[] => {
  const found: LanguageOption[] = [];
  for (const code of wanted ?? []) {
    const option =
      options.find((each) => each.code.toLowerCase() === code.toLowerCase()) ??
      options.find((each) => primaryOf(each.code) === primaryOf(code));
    if (option !== undefined && !found.includes(option)) {
      found.push(option);
    }
  }
  return found;
};

/** Past this many options, search and Suggested appear. */
export const MANY = 8;
