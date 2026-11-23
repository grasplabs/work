// ScrollArea: a box whose content scrolls behind a thin bar, in StyleX,
// built on UI SDK's ScrollArea: the browser's own scroller inside, so keys, wheel, touch, find in
// page and screen readers all scroll it. The browser's bar never shows (the shared scrollbarHidden);
// in its place, a 10px bar with a pill thumb that shows while the pointer is over it
// or it scrolls. The wheel scrolls it while it can, then passes on to the page.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <ScrollArea style={size.list}>…</ScrollArea>
//   <ScrollArea aria-label="Release notes" style={size.notes}>…</ScrollArea>   words alone: a tab stop
//
// It draws no frame: the box it sits in does. UI SDK names every part's data-slot (scroll-area,
// scroll-area-viewport, scroll-area-scrollbar…). Every value is a token. A caller sets its size and
// where it sits (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  ScrollArea as ScrollAreaPrimitive,
  ScrollAreaContent,
  ScrollAreaCorner,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from "@ui-sdk/react/scroll-area";
import type { ScrollAreaType } from "@ui-sdk/react/scroll-area";
import type { ReactNode } from "react";

import { focusCarrier, scrollbarHidden } from "../lib/styles";
import {
  colors,
  duration,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { motionVars } from "../lib/vars.stylex";

/** Every prop a ScrollArea takes. */
export interface ScrollAreaProps {
  /** What scrolls. */
  children: ReactNode;
  /**
   * What it holds ("Release notes"). Give it when nothing inside can take focus: the area becomes
   * a named region and a tab stop, so a keyboard can scroll it.
   */
  "aria-label"?: string;
  /**
   * Which way the content runs past the box: `vertical`, `horizontal`, or `both`.
   * @default "vertical"
   */
  orientation?: "vertical" | "horizontal" | "both";
  /**
   * When the bar shows: `hover` while the pointer is over it or it scrolls, `scroll` only while it
   * scrolls, `auto` whenever the content runs past, `always` even when it does not.
   * @default "hover"
   */
  type?: ScrollAreaType;
  /**
   * Starts at the end and stays there as the content grows, as a chat or a log, until someone
   * scrolls back.
   * @default false
   */
  stickToEnd?: boolean;
  /** Its size and where it sits. Never its bar. */
  style?: LayoutStyle;
}

// The shared ring's line, drawn here on the area round the viewport that has focus.
const ring = `${size.ringWidth} solid ${colors.ring}`;
const forcedRing = `calc(2 * ${size.lineStrong}) solid Highlight`;
const FORCED = media.forcedColors;

const styles = stylex.create({
  root: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    borderRadius: "inherit",
    cornerShape: "inherit",
    // The keyboard's focus on a named area's viewport: the ring on the area's own edge, over the
    // frame's edge round it and in its shape. Drawn here, where nothing clips it: drawn inside the
    // viewport it stood a pixel in, at a smaller corner, with the frame's pale edge still round it.
    // The viewport draws none of its own.
    outline: {
      default: "none",
      ":has(> :focus-visible)": { default: ring, [FORCED]: forcedRing },
    },
    outlineOffset: 0,
  },
  viewport: {
    flexGrow: 1,
    minHeight: 0,
    width: "100%",
    borderRadius: "inherit",
    cornerShape: "inherit",
  },
  bar: {
    display: "flex",
    boxSizing: "border-box",
    padding: size.scrollbarPadding,
    opacity: { default: 0, ":is([data-visible])": 1 },
    transitionProperty: "opacity",
    transitionDuration: motionVars.mark,
    transitionTimingFunction: duration.ease,
  },
  // The thumb keeps a step of room from the content's side. At each end the bar
  // stops space-3 short: past the curve of the frame's corner (20px, round where a browser draws no
  // squircle), so the thumb's end is never cut by it. At space-2 it was, by about a pixel.
  vertical: {
    width: size.scrollbarSize,
    paddingInlineStart: `calc(2 * ${size.scrollbarPadding})`,
    paddingBlock: space["3"],
  },
  horizontal: {
    flexDirection: "column",
    height: size.scrollbarSize,
    paddingBlockStart: `calc(2 * ${size.scrollbarPadding})`,
    paddingInline: space["3"],
  },
  thumb: {
    position: "relative",
    flexGrow: 1,
    borderRadius: radius.full,
    backgroundColor: {
      default: colors.scrollThumb,
      ":hover": { default: null, [media.hover]: colors.scrollThumbHover },
      ":is([data-dragging])": colors.scrollThumbHover,
      [FORCED]: "CanvasText",
    },
    transitionProperty: "background-color",
    transitionDuration: motionVars.mark,
    transitionTimingFunction: duration.ease,
  },
});

/** A box whose content scrolls with no visible browser bar, behind a thin bar of its own. */
export const ScrollArea = ({
  children,
  "aria-label": label,
  orientation = "vertical",
  style,
  ...options
}: ScrollAreaProps) => {
  const named = label !== undefined;
  return (
    <ScrollAreaPrimitive {...options} {...stylex.props(styles.root, style)}>
      <ScrollAreaViewport
        role={named ? "region" : undefined}
        aria-label={label}
        tabIndex={named ? 0 : undefined}
        {...stylex.props(styles.viewport, scrollbarHidden, focusCarrier)}
      >
        <ScrollAreaContent>{children}</ScrollAreaContent>
      </ScrollAreaViewport>
      {orientation !== "horizontal" && (
        <ScrollAreaScrollbar
          orientation="vertical"
          {...stylex.props(styles.bar, styles.vertical)}
        >
          <ScrollAreaThumb {...stylex.props(styles.thumb)} />
        </ScrollAreaScrollbar>
      )}
      {orientation !== "vertical" && (
        <ScrollAreaScrollbar
          orientation="horizontal"
          {...stylex.props(styles.bar, styles.horizontal)}
        >
          <ScrollAreaThumb {...stylex.props(styles.thumb)} />
        </ScrollAreaScrollbar>
      )}
      {orientation === "both" && <ScrollAreaCorner />}
    </ScrollAreaPrimitive>
  );
};
