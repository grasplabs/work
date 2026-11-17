// HoverCardTrigger: the link a hover card previews (hover-card.tsx). It is an <a>: a press, Enter
// or a tap follows it, whether or not the card opened.
"use client";

import * as stylex from "@stylexjs/stylex";
import { HoverCardTrigger as TriggerPrimitive } from "@ui-sdk/react/hover-card";
import type { HoverCardTriggerState } from "@ui-sdk/react/hover-card";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import { hoverCardStyles as styles } from "./styles";

/** Every prop a HoverCardTrigger takes. */
export interface HoverCardTriggerProps {
  /** Where the link goes: the page that holds everything the card shows, and more. */
  href: string;
  /** The link's words: the name of what it leads to ("Amara Okafor", "Q3 forecast"). */
  children: ReactNode;
}

/** The link. Its words take the text around them, underlined. */
export const HoverCardTrigger = ({ href, children }: HoverCardTriggerProps) => (
  <TriggerPrimitive
    href={href}
    className={(state: HoverCardTriggerState) =>
      stylex.props(styles.trigger, state.open && styles.open, focus.words)
        .className
    }
  >
    {children}
  </TriggerPrimitive>
);
