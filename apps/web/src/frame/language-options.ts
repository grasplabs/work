import { isLocale, localeNames } from "../i18n.ts";
import type { Locale } from "../i18n.ts";
import { DE, ES, FR, GB, NL } from "./flag.tsx";
import type { FlagData } from "./flag.tsx";

// The five languages Grasp speaks, as the reference lists
// them: each by its own name, with its flag. Where a person
// chooses their language with flags (Settings › Profile).

const flags: Record<Locale, FlagData> = {
  en: GB,
  de: DE,
  nl: NL,
  es: ES,
  fr: FR,
};

/** The languages to choose from, in the catalogs' order. */
export const languageOptions = Object.entries(localeNames).flatMap(
  ([code, name]) => (isLocale(code) ? [{ code, name, flag: flags[code] }] : [])
);
