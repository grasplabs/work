import { Button } from "@grasp-os/app-kit/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@grasp-os/app-kit/components/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/app-kit/components/select";
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

/** The language as a field of its own, as Settings → Profile offers it. */
export const LanguageSelect = ({ id }: { id: string }) => {
  const { i18n } = useLingui();
  const locale: Locale = isLocale(i18n.locale) ? i18n.locale : "en";
  return (
    <Select
      items={languages}
      onValueChange={(value: unknown) => {
        if (isLocale(value)) {
          void chooseLocale(value);
        }
      }}
      value={locale}
    >
      <SelectTrigger className="w-full" id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {languages.map((language) => (
          <SelectItem
            key={language.value}
            lang={language.value}
            value={language.value}
          >
            {language.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
