import { useLingui } from "@lingui/react/macro";

import { DE, ES, FR, GB, NL } from "./grasp/flags/index.ts";
import type { FlagData } from "./grasp/flags/index.ts";
import { LanguageSwitch } from "./grasp/language-switch/index.ts";
import { chooseLocale, isLocale, localeNames } from "./i18n.ts";
import type { Locale } from "./i18n.ts";

// The language as Grasp UI's Language switch, compact, in a page's corner
// where there is no person menu (signing in, a guest's chat). Its words are
// the parts' catalogue's (frame/part-words.tsx).

/** The flag that stands for each language Grasp speaks: its home region's. */
const flags: Record<Locale, FlagData> = {
  en: GB,
  de: DE,
  nl: NL,
  es: ES,
  fr: FR,
};

const languages = Object.entries(localeNames).flatMap(([code, name]) =>
  isLocale(code) ? [{ code, name, flag: flags[code] }] : []
);

/** The page's language, chosen as it is picked. */
export const LanguageButton = () => {
  const { i18n } = useLingui();
  return (
    <LanguageSwitch
      look="compact"
      onValueChange={(code) => {
        if (isLocale(code)) {
          void chooseLocale(code);
        }
      }}
      options={languages}
      size="sm"
      value={i18n.locale}
    />
  );
};
