// HoverCardPanel: the card itself (hover-card.tsx), UI SDK's HoverCardContent in Grasp's look. It
// stands beside its link, flips to the other side when there is no room, and shifts to stay inside
// the window, clear of its edges by the gutter.
"use client";

import * as stylex from "@stylexjs/stylex";
import { HoverCardContent as ContentPrimitive } from "@ui-sdk/react/hover-card";
import { useSyncExternalStore } from "react";
import type { ComponentProps, ReactNode } from "react";

// UI SDK places a popup in pixels: popover-gap and popup-gutter, as the generator writes them.
import { popup, px } from "../tokens/tokens.values";
import { hoverCardStyles as styles } from "./styles";

type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;

/** Every prop a HoverCardPanel takes. */
export interface HoverCardContentProps {
  /** The title, a line about it, and a quiet fact. Nothing to press: the link's page has the actions. */
  children: ReactNode;
  /**
   * The side of the link it opens on. It flips to the other side when there is no room.
   * @default "bottom"
   */
  side?: ContentPrimitiveProps["side"];
  /**
   * How it lines up with the link: `start` and `end` follow the reading direction.
   * @default "center"
   */
  align?: ContentPrimitiveProps["align"];
}

// Under the phone breakpoint the card takes the window's width less the gutter, so beside its link it
// never fits: UI SDK only flips to the other side, which has no room either, and the card ran off the
// window (third look). There it opens under or over the link, whichever has the room. On the server
// there is no window, and the card is placed as asked.
const PHONE = `(width < ${px.phone}px)`;
const watchPhone = (change: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener("change", change);
  return () => {
    query.removeEventListener("change", change);
  };
};
const onPhone = () => window.matchMedia(PHONE).matches;
const notOnPhone = () => false;
const across = new Set<HoverCardContentProps["side"]>([
  "left",
  "right",
  "start",
  "end",
]);

/** The card, beside its link. Under 640px it takes the window's width less the gutter, under or over the link. */
export const HoverCardContent = ({
  children,
  side,
  align,
}: HoverCardContentProps) => {
  const phone = useSyncExternalStore(watchPhone, onPhone, notOnPhone);
  return (
    <ContentPrimitive
      side={phone && across.has(side) ? "bottom" : side}
      align={align}
      sideOffset={popup.popoverGap}
      collisionPadding={popup.gutter}
      {...stylex.props(styles.panel)}
    >
      {children}
    </ContentPrimitive>
  );
};

/** @deprecated Use `HoverCardContent`. */
export const HoverCardPanel = HoverCardContent;
/** @deprecated Use `HoverCardContentProps`. */
export type HoverCardPanelProps = HoverCardContentProps;
