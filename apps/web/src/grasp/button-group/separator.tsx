// ButtonGroupSeparator: the page's hairline (the Separator component) between two buttons of a
// ButtonGroup, set in from the surface's edges: between an action and the button that opens its
// other ways, as in a split button.
"use client";

import * as stylex from "@stylexjs/stylex";

import { Separator } from "../separator";
import { grasp, media } from "../tokens/tokens.stylex";
import { useGroup } from "./context";

/** A ButtonGroupSeparator takes no props: it follows its group's direction. */
export type ButtonGroupSeparatorProps = Record<never, never>;

// A button beside the line that shows a fill, as a ghost Button does (button.tsx, ghostLive): pressed
// or held on, and under a fine pointer.
const held =
  ":is(:active:not(:disabled, [aria-disabled=true]), [aria-pressed=true])";
const hovered = ":hover:not(:disabled, [aria-disabled=true])";

const styles = stylex.create({
  line: {
    display: "flex",
    flexShrink: 0,
    alignSelf: "stretch",
    opacity: {
      default: 1,
      [`:is(${held} + *)`]: 0,
      [`:has(+ ${held})`]: 0,
      [`:is(${hovered} + *)`]: { default: null, [media.hover]: 0 },
      [`:has(+ ${hovered})`]: { default: null, [media.hover]: 0 },
    },
    transitionProperty: "opacity",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  horizontal: { flexDirection: "row", marginBlock: grasp.space2 },
  vertical: { flexDirection: "column", marginInline: grasp.space2 },
});

/** A hairline between two buttons of a group. Only a line: the buttons' names divide them. */
export const ButtonGroupSeparator = () => {
  const { orientation } = useGroup();
  return (
    <span
      aria-hidden="true"
      data-slot="button-group-separator"
      {...stylex.props(styles.line, styles[orientation])}
    >
      <Separator
        decorative
        orientation={orientation === "horizontal" ? "vertical" : "horizontal"}
      />
    </span>
  );
};
