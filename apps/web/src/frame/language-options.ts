import { DE, ES, FR, GB, NL } from "../grasp/flags/index.ts";
import type { FlagData } from "../grasp/flags/index.ts";
import { isLocale, localeNames } from "../i18n.ts";
import type { Locale } from "../i18n.ts";

// The five languages Grasp speaks, as the library's language switch takes
// them: each by its own name, with its flag. Shared by every place a person
// chooses their language (Settings, Profile; the sign-in page).

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
