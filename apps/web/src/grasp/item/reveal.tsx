// ItemReveal: an action that stands quiet in an item's row until the row is pointed at or holds
// focus, as the copy beside a member's email: always there for the keyboard (it shows when it, or
// anything in the row, takes focus) and always shown where there is no pointer to hover with.
//
//   <ItemDescription>
//     {member.email}
//     <ItemReveal><Button size="xs" variant="ghost" icon={Copy} aria-label={`Copy email of ${name}`} /></ItemReveal>
//   </ItemDescription>
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import { Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { itemMarker } from "./markers.stylex";

/** Every prop an ItemReveal takes. */
export interface ItemRevealProps {
  /** The action: a small ghost button with its own name. */
  children: ReactNode;
}

const styles = stylex.create({
  reveal: {
    display: "inline-flex",
    alignItems: "center",
    verticalAlign: "middle",
    // Hidden only to the eye, never to the keyboard or a screen reader: focus shows it.
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover", itemMarker)]: 1,
      [stylex.when.ancestor(":focus-within", itemMarker)]: 1,
      [media.coarse]: 1,
    },
    transitionProperty: "opacity",
    transitionDuration: grasp.durationHover,
  },
});

/** An action in an item's row, shown while the row is hovered or holds focus, and always on touch. */
export const ItemReveal = ({ children }: ItemRevealProps) => (
  <span data-slot="item-reveal" {...stylex.props(styles.reveal)}>
    {children}
  </span>
);

/** Every prop an ItemRevealButton takes. */
export interface ItemRevealButtonProps {
  /** Its mark, from the icons entry (`@/components/grasp/icons`): Copy beside an email. */
  icon: IconData;
  /** What it does, for whom: "Copy email of Anna de Vries". */
  "aria-label": string;
  /** Does it. */
  onClick: () => void;
}

const buttonStyles = stylex.create({
  // A mark the size of the line's own letters, in the line's quiet colour: it never makes the row
  // taller, never moves the words, and reads a step behind them until it is pointed at or focused.
  button: {
    [iconVars.size]: "1em",
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: grasp.textSmLine,
    height: grasp.textSmLine,
    marginInlineStart: grasp.space1,
    padding: 0,
    borderWidth: 0,
    borderRadius: grasp.corner,
    backgroundColor: "transparent",
    fontSize: "inherit",
    color: {
      default: grasp.muted,
      ":hover": { default: null, [media.hover]: grasp.ink },
      ":focus-visible": grasp.ink,
    },
    cursor: "pointer",
    verticalAlign: "middle",
  },
  // A target the size of a finger round the mark, so the small mark is easy to press.
  target: {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: grasp.tap,
    height: grasp.tap,
    translate: "-50% -50%",
  },
});

/** A quiet icon button in an item's line, shown with the row as ItemReveal shows its action. */
export const ItemRevealButton = ({
  icon,
  "aria-label": label,
  onClick,
}: ItemRevealButtonProps) => (
  <ItemReveal>
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      {...stylex.props(buttonStyles.button, focus.ring)}
    >
      <span aria-hidden="true" {...stylex.props(buttonStyles.target)} />
      <Icon icon={icon} />
    </button>
  </ItemReveal>
);
