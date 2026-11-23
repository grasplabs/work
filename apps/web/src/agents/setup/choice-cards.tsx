import { CheckIcon, Icon } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

// One answer from a few, as cards you press (Ruben, 21 November: "just
// click on a card, and then the card highlights"): no radio dot. The
// chosen card stands raised, ringed in ink, with a tick in its corner;
// the others lie soft and lift under the pointer. Underneath it is a
// native radio group, so arrows move between the cards and a screen reader
// says which is chosen. The product's own until Damsko has a choice card
// (logged as a gap against it), drawn on the Card's own tokens so it
// reads as one.

/** One card: its mark, its name, and a line on what it means. */
export interface ChoiceCard<T extends string> {
  value: T;
  title: string;
  description: string;
  /** Its mark, beside or above its words. */
  media?: ReactNode;
  /** A small picture under its words, such as how far it reaches. */
  foot?: ReactNode;
}

const HOVER = media.hover;

/** So many cards a row, one when narrow. */
const columnsOf = stylex.create({
  grid: (columns: number) => ({
    gridTemplateColumns: {
      default: `repeat(${String(columns)}, minmax(0, 1fr))`,
      [media.maxSm]: "minmax(0, 1fr)",
    },
  }),
});

const styles = stylex.create({
  cards: {
    display: "grid",
    gap: space["3"],
    margin: 0,
    padding: 0,
    borderWidth: 0,
  },
  card: {
    position: "relative",
    display: "grid",
    alignContent: "start",
    justifyItems: "start",
    gap: space["3"],
    boxSizing: "border-box",
    minWidth: 0,
    padding: space["5"],
    borderRadius: radius.base,
    cornerShape: radius.shape,
    backgroundColor: {
      default: colors.muted,
      [HOVER]: { default: colors.muted, ":hover": colors.card },
    },
    boxShadow: {
      default: size.borderStrong,
      [HOVER]: { default: size.borderStrong, ":hover": shadow.md },
    },
    // In forced colours the shadow is dropped: a real border draws the edge.
    borderWidth: { default: 0, [media.forcedColors]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    color: colors.foreground,
    cursor: "pointer",
    transitionProperty: "background-color, box-shadow",
    transitionDuration: {
      default: duration.hover,
      [media.reducedMotion]: "0s",
    },
    transitionTimingFunction: duration.ease,
    outline: { default: "none", ":has(:focus-visible)": "2px solid" },
    outlineColor: colors.ring,
    outlineOffset: size.ringOffset,
  },
  // The chosen card: raised, and ringed in ink so it reads at a glance.
  chosen: {
    backgroundColor: colors.card,
    boxShadow: `inset 0 0 0 1.5px ${colors.foreground}, ${shadow.md}`,
    borderWidth: { default: 0, [media.forcedColors]: 3 },
  },
  row: {
    gridAutoFlow: "column",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    alignItems: "center",
  },
  words: { display: "grid", gap: space["1"], minWidth: 0 },
  title: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  description: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    textWrap: "pretty",
  },
  tick: {
    position: "absolute",
    insetBlockStart: space["3"],
    insetInlineEnd: space["3"],
    display: "grid",
    placeItems: "center",
    width: "1.25rem",
    height: "1.25rem",
    borderRadius: radius.circle,
    backgroundColor: colors.foreground,
    color: colors.background,
    [iconVars.size]: "0.75rem",
  },
});

/**
 * One answer from `cards`, each a card to press. `layout="row"` sets each
 * card's mark beside its words, for a short list; the default sets it above.
 */
export const ChoiceCards = <T extends string>({
  label,
  cards,
  value,
  onValueChange,
  columns,
  layout = "stack",
}: {
  /** What is asked, for a screen reader: the page's heading says it to the eye. */
  label: string;
  cards: readonly ChoiceCard<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** Cards a row, on a screen wider than a phone: all of them unless given. */
  columns?: number;
  layout?: "stack" | "row";
}) => {
  const name = useId();
  const across = columns ?? cards.length;
  return (
    <fieldset
      aria-label={label}
      role="radiogroup"
      {...stylex.props(styles.cards, columnsOf.grid(across))}
    >
      {cards.map((card) => {
        const chosen = card.value === value;
        return (
          <label
            data-chosen={chosen || undefined}
            key={card.value}
            {...stylex.props(
              styles.card,
              chosen && styles.chosen,
              layout === "row" && styles.row
            )}
          >
            <input
              checked={chosen}
              name={name}
              onChange={() => {
                onValueChange(card.value);
              }}
              type="radio"
              value={card.value}
              {...stylex.props(visuallyHidden)}
            />
            {card.media}
            <span {...stylex.props(styles.words)}>
              <span {...stylex.props(styles.title)}>{card.title}</span>
              <span {...stylex.props(styles.description)}>
                {card.description}
              </span>
              {card.foot}
            </span>
            {chosen ? (
              <span aria-hidden="true" {...stylex.props(styles.tick)}>
                <Icon icon={CheckIcon} />
              </span>
            ) : null}
          </label>
        );
      })}
    </fieldset>
  );
};
