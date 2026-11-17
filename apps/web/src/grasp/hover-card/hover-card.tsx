// HoverCard: a preview of where a link goes, for someone who rests on it, from shadcn's
// (registry/bases/base/ui/hover-card.tsx, on Base UI), converted from Tailwind to StyleX and rebuilt
// on UI SDK's HoverCard, then made Grasp's: the popup's raised surface with the one corner, placed
// beside the link and kept inside the window. The link stays a link: a press or a tap follows it.
//
//   <HoverCard>
//     <HoverCardTrigger href="/people/amara">Amara Okafor</HoverCardTrigger>
//     <HoverCardPanel>
//       <HoverCardTitle>Amara Okafor</HoverCardTitle>
//       <HoverCardDescription>Leads research on the payments team.</HoverCardDescription>
//     </HoverCardPanel>
//   </HoverCard>
//
// A touch screen has no hover, and a screen reader may never open it: everything in the card is
// also on the page the link goes to. Every value is a token (src/tokens).
"use client";

import { HoverCard as HoverCardPrimitive } from "@ui-sdk/react/hover-card";
import { useId, useState, useSyncExternalStore } from "react";
import type { ComponentProps, ReactNode } from "react";

import { noteOpen, openNow, openOnServer, watchOpen } from "./one-open";

type RootProps = ComponentProps<typeof HoverCardPrimitive>;

/** Every prop a HoverCard takes. */
export interface HoverCardProps {
  /** The link and its card. */
  children: ReactNode;
  /** Open now. Pass it with `onOpenChange` to open and close it yourself. */
  open?: boolean;
  /**
   * Open when the page loads.
   * @default false
   */
  defaultOpen?: boolean;
  /** Runs when the card wants to open or close; `details.reason` says why, such as `"trigger-hover"`. */
  onOpenChange?: RootProps["onOpenChange"];
  /**
   * How long the pointer rests on the link, or keyboard focus stays on it, before the card opens,
   * in milliseconds. Long enough that passing over a page of links shows nothing.
   * @default 600
   */
  delay?: number;
  /**
   * How long the card stays once the pointer leaves the link and the card, in milliseconds. The
   * pointer can cross the gap into the card.
   * @default 300
   */
  closeDelay?: number;
  /**
   * The card never opens, and the link stays a plain link.
   * @default false
   */
  disabled?: boolean;
}

/**
 * The root: holds the link and the card, and renders nothing of its own. One card is open at a
 * time (one-open.ts): a card that keeps its own state closes as soon as another opens. A card whose
 * `open` the host keeps is left as the host says.
 */
export const HoverCard = ({
  children,
  open,
  defaultOpen = false,
  onOpenChange,
  ...rest
}: HoverCardProps) => {
  const id = useId();
  const [own, setOwn] = useState(defaultOpen);
  // Whether it has opened or closed since the page loaded: before that, only `defaultOpen` says.
  const [moved, setMoved] = useState(false);
  const current = useSyncExternalStore(watchOpen, openNow, openOnServer);
  const shown = own && (current === id || (current === null && !moved));
  return (
    <HoverCardPrimitive
      {...rest}
      open={open ?? shown}
      onOpenChange={(next, details) => {
        setOwn(next);
        setMoved(true);
        noteOpen(id, next);
        onOpenChange?.(next, details);
      }}
    >
      {children}
    </HoverCardPrimitive>
  );
};
