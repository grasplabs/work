// HoverCardTrigger: the link a hover card previews (hover-card.tsx). It is an <a>: a press, Enter
// or a tap follows it, whether or not the card opened.
"use client";

import * as stylex from "@stylexjs/stylex";
import { HoverCardTrigger as TriggerPrimitive } from "@ui-sdk/react/hover-card";
import type { HoverCardTriggerState } from "@ui-sdk/react/hover-card";
import { renderElement } from "@ui-sdk/react/primitive";
import type { RenderProp } from "@ui-sdk/react/primitive";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import { hoverCardStyles as styles } from "./styles";

/** Every prop a HoverCardTrigger takes. */
export type HoverCardTriggerProps = {
  /** Where the link goes: the page that holds everything the card shows, and more. */
  href?: string;
  /**
   * The link a router draws (`render={<Link to="/people/amara" />}`), in place of an `<a href>`: it
   * takes the trigger's look, its words and the card's behaviour, and keeps its own props. Leave
   * `href` out when the router's link carries the address.
   */
  render?: RenderProp;
  /** The link's words: the name of what it leads to ("Amara Okafor", "Q3 forecast"). */
  children: ReactNode;
} & ({ href: string } | { render: RenderProp });

/** The link. Its words take the text around them, underlined. */
export const HoverCardTrigger = ({
  href,
  render,
  children,
}: HoverCardTriggerProps) => (
  <TriggerPrimitive
    href={href}
    className={(state: HoverCardTriggerState) =>
      stylex.props(styles.trigger, state.open && styles.open, focus.words)
        .className
    }
    // A router's link: UI SDK's props (its behaviour and the look above) go on the host's element.
    render={
      render === undefined
        ? undefined
        : (props: Record<string, unknown>) =>
            renderElement("a", { ...props, href, children }, render)
    }
  >
    {children}
  </TriggerPrimitive>
);
