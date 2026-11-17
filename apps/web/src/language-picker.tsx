import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { useLingui } from "@lingui/react/macro";

import { chooseLocale, isLocale, localeNames } from "./i18n.ts";
import type { Locale } from "./i18n.ts";

const languages = Object.entries(localeNames).map(([value, label]) => ({
  value,
  label,
}));

/**
 * The language as a small button in a page's corner, where there is no
 * person menu (signing in). Its code says enough, as language buttons do.
 */
export const LanguageButton = () => {
  const { t, i18n } = useLingui();
  const locale: Locale = isLocale(i18n.locale) ? i18n.locale : "en";
  const name = localeNames[locale];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`Language: ${name}`}
        render={<Button size="icon-sm" variant="ghost" />}
      >
        {locale.toUpperCase()}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top">
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(value: unknown) => {
            if (isLocale(value)) {
              void chooseLocale(value);
            }
          }}
        >
          {languages.map((language) => (
            <DropdownMenuRadioItem
              key={language.value}
              lang={language.value}
              value={language.value}
            >
              {language.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
