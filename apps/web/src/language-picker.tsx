import { useLingui } from "@lingui/react/macro";

import { languageOptions } from "./frame/language-options.ts";
import { LanguageSwitch } from "./grasp/language-switch/index.ts";
import { chooseLocale, isLocale } from "./i18n.ts";

// The language as Grasp UI's Language switch, compact, in a page's corner
// where there is no person menu (signing in, a guest's chat). Its words are
// the parts' catalogue's (frame/part-words.tsx).

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
      options={languageOptions}
      size="sm"
      value={i18n.locale}
    />
  );
};
