// PopoverPanel: the panel of a popover (popover.tsx), UI SDK's PopoverContent in Grasp's look. It
// stands beside its trigger, flips to the other side when there is no room, and shifts to stay
// inside the window, clear of its edges by the gutter.
"use client";

import * as stylex from "@stylexjs/stylex";
import { PopoverContent as ContentPrimitive } from "@ui-sdk/react/popover";
import { useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { scroll } from "../scroll/scroll";
import { popup } from "../tokens/tokens.values";
import { popoverMarker } from "./popover.stylex";
import { useStill } from "./still-context";
import { popoverStyles as styles } from "./styles";

type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;

/** Every prop a PopoverPanel takes: these, and the rest of UI SDK's PopoverContent. */
export interface PopoverPanelProps extends Omit<
  ContentPrimitiveProps,
  | "children"
  | "className"
  | "style"
  | "render"
  | "sideOffset"
  | "collisionPadding"
  | "arrowPadding"
> {
  /** The title, the description, the fields and the footer, in that order. */
  children: ReactNode;
  /**
   * The side of the trigger it opens on. It flips to the other side when there is no room.
   * @default "bottom"
   */
  side?: ContentPrimitiveProps["side"];
  /**
   * How it lines up with the trigger: `start` and `end` follow the reading direction. `end` for a
   * trigger at the end of a row or a toolbar.
   * @default "center"
   */
  align?: ContentPrimitiveProps["align"];
  /**
   * Where focus goes when it opens: the first field or control by default, or the panel itself when
   * it holds none or was opened by a tap, so no keyboard appears. `"none"` leaves focus on the trigger.
   * @default "auto"
   */
  initialFocus?: ContentPrimitiveProps["initialFocus"];
}

/** The panel, beside its trigger. Under 640px it takes the window's width less the gutter. */
/**
 * Watches the body: whether it holds more than it shows, and the title that names the panel. The
 * body mounts each time the popover opens, so it is watched from its own ref.
 */
const watchBody = (
  element: HTMLDivElement,
  setTitle: (title: string | undefined) => void,
  setScrolls: (scrolls: boolean) => void
) => {
  // Read on each measure: the panel names itself by the title once the title has mounted.
  const measure = () => {
    setTitle(
      element.closest('[role="dialog"]')?.getAttribute("aria-labelledby") ??
        undefined
    );
    setScrolls(element.scrollHeight > element.clientHeight + 1);
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  for (const child of element.children) {
    observer.observe(child);
  }
  return () => {
    observer.disconnect();
  };
};

export const PopoverPanel = ({ children, ...rest }: PopoverPanelProps) => {
  const still = useStill();
  // When the body holds more than it shows, it joins the Tab order as a region named by the title,
  // so the keys can scroll it (WCAG 2.1.1), as a Dialog's body does.
  const [scrolls, setScrolls] = useState(false);
  const [title, setTitle] = useState<string>();
  const box = (element: HTMLDivElement | null) =>
    element === null ? undefined : watchBody(element, setTitle, setScrolls);
  if (still) {
    if (still.phase === "closed") {
      return null;
    }
    return (
      <div
        data-slot="popover-content"
        {...stylex.props(styles.panel, still.look.panel)}
      >
        <div {...stylex.props(styles.body, scroll.bar)}>{children}</div>
      </div>
    );
  }
  return (
    <ContentPrimitive
      {...rest}
      sideOffset={popup.popoverGap}
      collisionPadding={popup.gutter}
      {...stylex.props(
        popoverMarker,
        styles.panel,
        styles.placed,
        styles.motion,
        styles.ring
      )}
    >
      <div
        ref={box}
        data-slot="popover-body"
        tabIndex={scrolls ? 0 : undefined}
        role={scrolls ? "region" : undefined}
        aria-labelledby={scrolls ? title : undefined}
        {...stylex.props(styles.body, scroll.bar, styles.bodyRing)}
      >
        {children}
      </div>
    </ContentPrimitive>
  );
};
