// ActiveBar: the fill that slides behind the item you are on in an upright list of navigation,
// from Palermo's Active Bar, made Grasp's: a faint fill with the one corner, as tall as an item,
// sliding to the next item in 200ms. Put it first inside a list whose items are each
// active-bar-item tall, and tell it which one: it moves when that changes.
//
//   <nav style={{ position: "relative" }}>
//     <ActiveBar index={current} />
//     {items.map((item, index) => <a aria-current={index === current ? "page" : undefined}>…</a>)}
//   </nav>
//
// It is drawn, not read: the items say which is current with aria-current. Every value is a token
// (src/tokens).
import * as stylex from "@stylexjs/stylex";

import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

/** Every prop an ActiveBar takes. */
export interface ActiveBarProps {
  /** The item it stands behind, counted from 0. Leave it out when no item is current. */
  index?: number;
  /**
   * Room between the bar and the list's start edge.
   * @default 0
   */
  insetStart?: number | string;
  /**
   * Room between the bar and the list's end edge.
   * @default 0
   */
  insetEnd?: number | string;
}

const styles = stylex.create({
  bar: (index: number, start: number | string, end: number | string) => ({
    position: "absolute",
    top: 0,
    insetInlineStart: start,
    insetInlineEnd: end,
    height: grasp.activeBarItem,
    transform: `translateY(calc(${index} * ${grasp.activeBarItem}))`,
  }),
  look: {
    zIndex: 0,
    pointerEvents: "none",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: grasp.activeBarFill,
      [media.forced]: "transparent",
    },
    // Forced colours drop the fill: a line keeps the bar.
    outline: { default: "none", [media.forced]: "1px solid CanvasText" },
    outlineOffset: -1,
    transitionProperty: "transform, opacity",
    transitionDuration: simply.slide,
    transitionTimingFunction: grasp.ease,
  },
  away: {
    opacity: 0,
  },
});

export const ActiveBar = ({
  index,
  insetStart = 0,
  insetEnd = 0,
}: ActiveBarProps) => {
  const shown = index !== undefined && index >= 0;
  return (
    <span
      aria-hidden="true"
      data-slot="active-bar"
      {...stylex.props(
        styles.bar(shown ? index : 0, insetStart, insetEnd),
        styles.look,
        !shown && styles.away
      )}
    />
  );
};
