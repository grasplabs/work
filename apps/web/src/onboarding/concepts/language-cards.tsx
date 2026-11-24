import {
  Item,
  ItemActions,
  ItemContent,
  ItemGrid,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { CheckIcon, Icon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef } from "react";

import { isLocale, localeNames } from "../../i18n.ts";
import type { Locale } from "../../i18n.ts";

// The language, chosen from five cards, one a language, each named in its
// own words, one line, in the body's style. The chosen one takes Item's
// selected fill (said as the current one) and a tick. Damsko's ItemGrid lays them
// out as tiles, as many to a row as fit, one a row on a phone.

/** How far each arrow moves, in reading order. */
const arrows: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
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
  // The arrows move between the cards, as in a group of choices; only
  // Enter or Space (the card's own press) chooses, so moving never leaves.
  const room = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = room.current;
    const onKey = (event: KeyboardEvent) => {
      const step = arrows[event.key];
      if (step === undefined || element === null) {
        return;
      }
      const cards = [...element.querySelectorAll<HTMLElement>("button")];
      const at = cards.findIndex((card) => card.matches(":focus"));
      const next = cards[(at + step + cards.length) % cards.length];
      if (at !== -1 && next !== undefined) {
        event.preventDefault();
        next.focus();
      }
    };
    element?.addEventListener("keydown", onKey);
    return () => {
      element?.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <div ref={room}>
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
    </div>
  );
};
