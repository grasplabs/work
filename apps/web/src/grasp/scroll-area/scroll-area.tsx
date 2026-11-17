// ScrollArea: a box whose content scrolls behind a thin bar, from shadcn's
// (registry/bases/base/ui/scroll-area.tsx, on Base UI), converted from Tailwind to StyleX and
// rebuilt on UI SDK's ScrollArea: the browser's own scroller inside, so keys, wheel, touch, find in
// page and screen readers all scroll it. Made as Palermo's: a 10px bar with a pill thumb that shows
// while the pointer is over it or it scrolls.
//
//   <ScrollArea style={size.list}>…</ScrollArea>
//   <ScrollArea aria-label="Release notes" style={size.notes}>…</ScrollArea>   words alone: a tab stop
//
// It draws no frame: the box it sits in does. Every value is a token (src/tokens). A caller sets its
// size and layout (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
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

import { focus } from "../focus/focus";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

/** What a caller may style: its size and where it sits. Never its bar. */
export type ScrollAreaLayoutStyle = LayoutStyle;

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
  /** @deprecated Use `layout`. */
  style?: ScrollAreaLayoutStyle;
  /** Its size and where it sits. Never its bar. */
  layout?: ScrollAreaLayoutStyle;
}

// The shared ring's line (src/focus), drawn here on the area round the viewport that has focus.
const ring = `${grasp.ringWidth} solid ${grasp.ring}`;
const forcedRing = `calc(2 * ${grasp.ringWidth}) solid Highlight`;

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
    // viewport it stood a pixel in, at a smaller corner, with the frame's pale edge still round it
    // (B-scroll-area-02). The viewport draws none of its own.
    outline: {
      default: "none",
      ":has(> :focus-visible)": { default: ring, [media.forced]: forcedRing },
    },
    outlineOffset: 0,
  },
  // UI SDK makes it scroll and hides the browser's own bar while ours is drawn.
  viewport: {
    flexGrow: 1,
    minHeight: 0,
    width: "100%",
    borderRadius: "inherit",
  },
  bar: {
    display: "flex",
    boxSizing: "border-box",
    padding: grasp.scrollbarInset,
    opacity: { default: 0, ":is([data-visible])": 1 },
    transitionProperty: "opacity",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
  },
  // The thumb keeps a step of room from the content's side, as Palermo's. At each end the bar
  // stops space-3 short: past the curve of the frame's corner (20px, round where a browser draws no
  // squircle), so the thumb's end is never cut by it. At space-2 it was, by about a pixel.
  vertical: {
    width: grasp.scrollbarSize,
    paddingInlineStart: `calc(2 * ${grasp.scrollbarInset})`,
    paddingBlock: grasp.space3,
  },
  horizontal: {
    flexDirection: "column",
    height: grasp.scrollbarSize,
    paddingBlockStart: `calc(2 * ${grasp.scrollbarInset})`,
    paddingInline: grasp.space3,
  },
  thumb: {
    position: "relative",
    flexGrow: 1,
    borderRadius: grasp.cornerPill,
    backgroundColor: {
      default: grasp.scrollThumb,
      ":hover": { default: null, [media.hover]: grasp.scrollThumbHover },
      ":is([data-dragging])": grasp.scrollThumbHover,
      [media.forced]: "CanvasText",
    },
    transitionProperty: "background-color",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
  },
});

export const ScrollArea = ({
  children,
  "aria-label": label,
  orientation = "vertical",
  style: styleProp,
  layout,
  ...options
}: ScrollAreaProps) => {
  const named = label !== undefined;
  return (
    <ScrollAreaPrimitive
      {...options}
      {...stylex.props(styles.root, layout ?? styleProp)}
    >
      <ScrollAreaViewport
        role={named ? "region" : undefined}
        aria-label={label}
        tabIndex={named ? 0 : undefined}
        {...stylex.props(styles.viewport, focus.carrier)}
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
