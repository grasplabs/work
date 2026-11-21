// PopoverPanel: the panel of a popover (popover.tsx), UI SDK's PopoverContent in Grasp's look. It
// stands beside its trigger, flips to the other side when there is no room, and shifts to stay
// inside the window, clear of its edges by the gutter.
"use client";

import * as stylex from "@stylexjs/stylex";
import { PopoverContent as ContentPrimitive } from "@ui-sdk/react/popover";
import { useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { scroll } from "../scroll/scroll";
import { popup } from "../tokens/tokens.values";
import { popoverMarker } from "./popover.stylex";
import { useStill } from "./still-context";
import { popoverStyles as styles } from "./styles";

type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;

/** Every prop a PopoverPanel takes: these, and the rest of UI SDK's PopoverContent. */
export interface PopoverContentProps extends Omit<
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
   * Where focus goes when it opens. By default the first field or control in it; when it holds
   * none (words only, a picture), focus stays on the trigger, so no ring frames the panel and
   * Escape still closes it. `"content"` focuses the panel itself; `"none"` always leaves focus on
   * the trigger.
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

// What can take focus by Tab inside the panel: its first one, if any.
const TABBABLE =
  "button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1']), [contenteditable='true']";
const firstTabbable = (body: HTMLElement): HTMLElement | null => {
  // The body itself, when it scrolls, is a stop of its own (a region the keys can scroll).
  if (body.tabIndex >= 0) {
    return body;
  }
  return (
    [...body.querySelectorAll<HTMLElement>(TABBABLE)].find(
      (element) => element.getClientRects().length > 0
    ) ?? null
  );
};

export const PopoverContent = ({
  children,
  initialFocus,
  ...rest
}: PopoverContentProps) => {
  const still = useStill();
  // When the body holds more than it shows, it joins the Tab order as a region named by the title,
  // so the keys can scroll it (WCAG 2.1.1), as a Dialog's body does.
  const [scrolls, setScrolls] = useState(false);
  const [title, setTitle] = useState<string>();
  const body = useRef<HTMLDivElement | null>(null);
  const box = (element: HTMLDivElement | null) => {
    body.current = element;
    return element === null
      ? undefined
      : watchBody(element, setTitle, setScrolls);
  };
  // The default: the first control in it, else the trigger, which holds focus as it opens. Where a
  // tap left focus on nothing (the page), the panel takes it, as UI SDK's own default does.
  const firstOrTrigger = () => {
    const first = body.current === null ? null : firstTabbable(body.current);
    if (first !== null) {
      return first;
    }
    const held = document.activeElement;
    return held instanceof HTMLElement && held !== document.body ? held : null;
  };
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
      initialFocus={initialFocus ?? firstOrTrigger}
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

/** @deprecated Use `PopoverContent`. */
export const PopoverPanel = PopoverContent;
/** @deprecated Use `PopoverContentProps`. */
export type PopoverPanelProps = PopoverContentProps;
