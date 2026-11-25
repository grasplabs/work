import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { ChevronDownIcon, Icon } from "@grasp-os/ui/lib/icons";
import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { chooseLocale, isLocale, localeNames } from "../i18n.ts";
import type { Locale } from "../i18n.ts";
import { Flag } from "./flag.tsx";
import { languageOptions } from "./language-options.ts";

const styles = stylex.create({
  // Every language's flag and name stacked in one cell, only the chosen one
  // seen: the button keeps the width of the widest and never shifts.
  stack: {
    display: "inline-grid",
    alignItems: "center",
    justifyItems: "start",
  },
  face: {
    gridArea: "1 / 1",
    display: "inline-flex",
    alignItems: "center",
    gap: space["2"],
  },
  gone: { visibility: "hidden" },
  chevron: { display: "inline-flex", color: colors.mutedForeground },
  item: { display: "inline-flex", alignItems: "center", gap: space["2"] },
});

/**
 * The page's language as a small button in a corner, where there is no
 * person menu (signing in, the onboarding, an interview), as #2503's
 * compact language switch: the chosen one by its flag and its own name, at
 * the width of the widest, opening the five, each by its flag and named in
 * its own words so anyone finds theirs. Chosen as it is picked.
 */
export const LanguageButton = ({
  side = "top",
}: {
  /** Where the menu opens: over a page's foot, under its head. */
  side?: "top" | "bottom";
}) => {
  const { t, i18n } = useLingui();
  const locale: Locale = isLocale(i18n.locale) ? i18n.locale : "en";
  const name = localeNames[locale];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild aria-label={t`Language: ${name}`}>
        <Button size="xs" variant="outline">
          <span {...stylex.props(styles.stack)}>
            {languageOptions.map((option) => (
              <span
                aria-hidden={option.code === locale ? undefined : true}
                key={option.code}
                {...stylex.props(
                  styles.face,
                  option.code !== locale && styles.gone
                )}
              >
                <Flag flag={option.flag} />
                <span lang={option.code}>{option.name}</span>
              </span>
            ))}
          </span>
          <span aria-hidden="true" {...stylex.props(styles.chevron)}>
            <Icon icon={ChevronDownIcon} />
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={side}>
        <DropdownMenuRadioGroup
          onValueChange={(value: unknown) => {
            if (isLocale(value)) {
              void chooseLocale(value);
            }
          }}
          value={locale}
        >
          {languageOptions.map((option) => (
            <DropdownMenuRadioItem
              closeOnSelect
              key={option.code}
              label={option.name}
              value={option.code}
            >
              <span {...stylex.props(styles.item)}>
                <Flag flag={option.flag} />
                <span lang={option.code}>{option.name}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
