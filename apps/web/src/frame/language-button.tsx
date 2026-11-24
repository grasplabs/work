import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { ChevronDownIcon, GlobeIcon, Icon } from "@grasp-os/ui/lib/icons";
import { media } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { chooseLocale, isLocale, localeNames } from "../i18n.ts";
import type { Locale } from "../i18n.ts";

const styles = stylex.create({
  // The short code on a phone, the full name on a wider window.
  phone: { display: { default: "inline", [media.sm]: "none" } },
  wide: { display: { default: "none", [media.sm]: "inline" } },
});

const languages = Object.entries(localeNames).flatMap(([code, name]) =>
  isLocale(code) ? [{ code, name }] : []
);

/**
 * The page's language as a small button in a corner, where there is no
 * person menu (signing in, the onboarding): the chosen one by its own name,
 * opening the five, each named in its own words so anyone finds theirs.
 * Chosen as it is picked.
 */
export const LanguageButton = ({
  side = "top",
  quiet = false,
}: {
  /** Where the menu opens: over a page's foot, under its head. */
  side?: "top" | "bottom";
  /**
   * One of a quiet header's icon buttons (the interview, CONCEPT): ghost, no globe, and on a
   * phone the language's short code ("EN"), its full name on a wide window.
   */
  quiet?: boolean;
}) => {
  const { t, i18n } = useLingui();
  const locale: Locale = isLocale(i18n.locale) ? i18n.locale : "en";
  const name = localeNames[locale];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild aria-label={t`Language: ${name}`}>
        {quiet ? (
          <Button size="sm" variant="ghost">
            <span {...stylex.props(styles.phone)}>{locale.toUpperCase()}</span>
            <span lang={locale} {...stylex.props(styles.wide)}>
              {name}
            </span>
            <Icon icon={ChevronDownIcon} />
          </Button>
        ) : (
          <Button size="sm" variant="outline">
            <Icon icon={GlobeIcon} />
            <span lang={locale}>{name}</span>
            <Icon icon={ChevronDownIcon} />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={side}>
        <DropdownMenuRadioGroup
          onValueChange={(value: unknown) => {
            if (isLocale(value)) {
              void chooseLocale(value);
            }
          }}
          value={locale}
        >
          {languages.map((language) => (
            <DropdownMenuRadioItem
              closeOnSelect
              key={language.code}
              label={language.name}
              value={language.code}
            >
              <span lang={language.code}>{language.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
