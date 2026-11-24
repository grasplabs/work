import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGrid,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { CheckIcon, Icon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";

import { isLocale, localeNames } from "../../i18n.ts";
import type { Locale } from "../../i18n.ts";

// The language, chosen from five cards, one a language: its name in its
// own words, and Stephen's hello in it, so the admin hears him in their
// language before they choose it. The chosen one takes Item's selected
// fill (said as the current one) and a tick. Damsko's ItemGrid lays them
// out as tiles, as many to a row as fit, one a row on a phone.

/** Stephen's hello in each language, written in it. */
const hellos: Record<Locale, string> = {
  en: "Hello, I’m Stephen.",
  de: "Hallo, ich bin Stephen.",
  nl: "Hallo, ik ben Stephen.",
  es: "Hola, soy Stephen.",
  fr: "Bonjour, je suis Stephen.",
};

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
            <ItemDescription>
              <span lang={code}>{hellos[code]}</span>
            </ItemDescription>
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
