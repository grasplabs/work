import {
  Item,
  ItemActions,
  ItemContent,
  ItemGrid,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { CheckIcon, Icon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";

import { isLocale, localeNames } from "../../i18n.ts";
import type { Locale } from "../../i18n.ts";

// The language, chosen from five cards, one a language, each named in its
// own words, one line: Damsko's Items as choices, each one button, in Tab
// order, Enter or Space to choose. Coming back to the step, the language in
// use takes Item's selected fill (said as the current one) and a tick;
// never on a first visit. Damsko's ItemGrid lays them
// out as tiles, as many to a row as fit, one a row on a phone.

const languages = Object.entries(localeNames).flatMap(([code, name]) =>
  isLocale(code) ? [{ code, name }] : []
);

export const LanguageCards = ({
  chosen,
  onPick,
}: {
  /** The language chosen, if one is. */
  chosen: Locale | null;
  onPick: (locale: Locale) => void;
}) => {
  const { t } = useLingui();
  return (
    <ItemGrid aria-label={t`Your language`}>
      {languages.map(({ code, name }) => (
        <Item
          active={chosen === code}
          key={code}
          onClick={() => {
            onPick(code);
          }}
          variant="outline"
        >
          <ItemContent>
            <ItemTitle>
              <span lang={code}>{name}</span>
            </ItemTitle>
          </ItemContent>
          {chosen === code ? (
            <ItemActions>
              <Icon icon={CheckIcon} label={t`Chosen`} />
            </ItemActions>
          ) : null}
        </Item>
      ))}
    </ItemGrid>
  );
};
