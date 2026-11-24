import { Text } from "@grasp-os/ui/components/text";
import { CheckIcon, Icon } from "@grasp-os/ui/lib/icons";
import { focusRing } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { isLocale, localeNames } from "../i18n.ts";
import type { Locale } from "../i18n.ts";
import { useField } from "./field/stephen-field.tsx";
import { FlagPicture } from "./flag-picture.tsx";

// The language, chosen from five cards, one a language, each named in its
// own words: one list, a card a row, at every width, so the five never
// break into an uneven grid. Each card is one button, in Tab order, Enter
// or Space to choose; its flag in its own colours lies over the card,
// whole at the far edge and thinning out toward the name. Coming back to
// the step, the language in use takes the selected fill (said as the
// current one) and a tick; never on a first visit. The flag is decoration:
// the language's own name is the card's name. A component of the setup's
// own, not an Item: the card's corner clips its picture, which an Item
// can't hold without a layer inside it. Under the pointer or the keyboard's
// focus, Stephen comes to the card: his light gathers round it and comes in
// over its edge, and its flag starts to wave.

/** Under a pointer that can hover, as Damsko's own parts write it. */
const HOVER = "@media (hover: hover)";

const styles = stylex.create({
  list: {
    display: "grid",
    gap: space[3],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  card: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    width: "100%",
    minHeight: "6rem",
    margin: 0,
    paddingInline: space[6],
    borderWidth: 0,
    borderRadius: radius.lg,
    cornerShape: radius.shape,
    overflow: "hidden",
    cursor: "pointer",
    textAlign: "start",
    backgroundColor: {
      default: colors.card,
      ":hover": { default: null, [HOVER]: colors.controlHover },
      ":active": colors.controlActive,
    },
    boxShadow: size.borderStrong,
    // Stephen's line: the card's own ring, so it follows its corner exactly; his dither lies outside it.
    transitionProperty: "box-shadow",
    transitionDuration: { default: duration.ui, [media.reducedMotion]: "0s" },
    transitionTimingFunction: duration.ease,
  },
  lit: { boxShadow: `0 0 0 2px ${colors.mint}` },
  current: { backgroundColor: colors.accentActive },
  name: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space[2],
  },
});

const languages = Object.entries(localeNames).flatMap(([code, name]) =>
  isLocale(code) ? [{ code, name }] : []
);

export const LanguageCards = ({
  chosen,
  onPick,
}: {
  /** The language in use, when they come back to the step; never on a first visit. */
  chosen: Locale | null;
  /** Told which, and the card that was pressed: where Stephen carries the page on from. */
  onPick: (locale: Locale, card: Element) => void;
}) => {
  const { t } = useLingui();
  const field = useField();
  const [lit, setLit] = useState<Locale | null>(null);
  const come = (code: Locale, card: Element) => {
    setLit(code);
    field.attend(card);
  };
  const go = (code: Locale, card: Element) => {
    field.release(card);
    // Only the card he is on goes dark: he may already be on the next one.
    setLit((current) => (current === code ? null : current));
  };
  return (
    <ul aria-label={t`Your language`} {...stylex.props(styles.list)}>
      {languages.map(({ code, name }) => (
        <li key={code}>
          <button
            {...(chosen === code && { "aria-current": true })}
            onBlur={(event) => {
              go(code, event.currentTarget);
            }}
            onClick={(event) => {
              onPick(code, event.currentTarget);
            }}
            onFocus={(event) => {
              come(code, event.currentTarget);
            }}
            onPointerEnter={(event) => {
              come(code, event.currentTarget);
            }}
            onPointerLeave={(event) => {
              go(code, event.currentTarget);
            }}
            type="button"
            {...stylex.props(
              styles.card,
              lit === code && styles.lit,
              chosen === code && styles.current,
              focusRing
            )}
          >
            <FlagPicture lit={lit === code} locale={code} />
            <span {...stylex.props(styles.name)}>
              {chosen === code ? (
                <Icon icon={CheckIcon} label={t`Chosen`} />
              ) : null}
              <Text as="span" color="default" size="lg">
                <span lang={code}>{name}</span>
              </Text>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
};
