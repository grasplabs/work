// Container: a page's content in one column of a reading width, in the page's middle with the room
// past it shared on both sides (equal margins on every page), or at its start (`align="start"`). A
// child that needs the page's whole width, a table, stands in ContainerBleed.
//
//   <Container size="sm">
//     <h1>General</h1>
//     <section>…</section>
//     <ContainerBleed><table>…</table></ContainerBleed>
//   </Container>
//
// The column is the frame's width less what is past the size, so it narrows with the page and
// never runs wider. Every value is a token.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { size as sizes, space } from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { containerVars } from "./container.stylex";

/** Every prop a Container takes. */
export interface ContainerProps {
  /** The page's content, top to bottom, and ContainerBleed for what runs the whole width. */
  children: ReactNode;
  /**
   * How wide the column runs: `sm` (40rem) for a settings page, `default` (45rem) for forms, `lg`
   * (64rem) for a page of wider things.
   * @default "default"
   */
  size?: "sm" | "default" | "lg";
  /**
   * Where the column stands: in the page's middle with the room past its size shared on both
   * sides, so its margins are equal, or at the page's start.
   * @default "center"
   */
  align?: "start" | "center";
  /** Where it sits and how much room it takes. */
  style?: LayoutStyle;
}

/** Every prop a ContainerBleed takes. */
export interface ContainerBleedProps {
  /** What runs the page's whole width: a table, a chart. */
  children: ReactNode;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  // The frame: the width the column measures against, and what a bleeding child runs. Measured as
  // a container it has no width of its own, so it takes its parent's.
  frame: { containerType: "inline-size", width: "100%", minWidth: 0 },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: space["8"],
    boxSizing: "border-box",
    minWidth: 0,
  },
  start: {
    paddingInlineEnd: `max(0px, calc(100cqi - ${containerVars.measure}))`,
  },
  // In the middle: what is past the size, half on each side; a bleeding child steps back by one
  // side.
  center: {
    paddingInline: `max(0px, calc((100cqi - ${containerVars.measure}) / 2))`,
    [containerVars.bleedStart]: `min(0px, calc((${containerVars.measure} - 100cqi) / 2))`,
  },
  sm: { [containerVars.measure]: sizes.containerSm },
  default: { [containerVars.measure]: sizes.containerDefault },
  lg: { [containerVars.measure]: sizes.containerLg },
  bleed: {
    width: "100cqi",
    minWidth: 0,
    marginInlineStart: containerVars.bleedStart,
  },
});

/** A page's content in one column of a reading width, in the page's middle or at its start. */
export const Container = ({
  children,
  size = "default",
  align = "center",
  style,
}: ContainerProps) => (
  <div
    data-slot="container"
    data-size={size}
    data-align={align}
    {...stylex.props(styles.frame, style)}
  >
    <div
      {...stylex.props(
        styles.column,
        size === "sm" && styles.sm,
        size === "default" && styles.default,
        size === "lg" && styles.lg,
        align === "center" ? styles.center : styles.start
      )}
    >
      {children}
    </div>
  </div>
);

/** A child of Container that runs the page's whole width. */
export const ContainerBleed = ({ children, style }: ContainerBleedProps) => (
  <div data-slot="container-bleed" {...stylex.props(styles.bleed, style)}>
    {children}
  </div>
);
