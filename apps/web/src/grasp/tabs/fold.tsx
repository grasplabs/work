// The fold of a TabsNav (nav.tsx): one button with the current view's words and a chevron, opening
// the views as links in Dropdown menu's look. Each item is still a link, through the TabsLink's
// `render`, with aria-current on the current one.
"use client";

import * as stylex from "@stylexjs/stylex";
import { MenuItem as ItemPrimitive } from "@ui-sdk/react/menu";
import { renderElement } from "@ui-sdk/react/primitive";
import type { ReactNode } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  menuStyles,
} from "../dropdown-menu";
import type { TabsLinkProps } from "./nav";
import { PlaceContext } from "./place";

const styles = stylex.create({
  // A link's own underline gives way to the item's look.
  link: {
    textDecorationLine: "none",
  },
  // The nav's own name on the button, hidden once a current view's words stand before it.
  fallback: {
    display: { default: "inline", ":not(:first-child)": "none" },
  },
});

/** A view as an item of the menu: still a link, through `render`, with the dot when current. */
export const MenuLink = ({
  children,
  href,
  render,
  current = false,
}: TabsLinkProps) => (
  <ItemPrimitive
    label={typeof children === "string" ? children : undefined}
    aria-current={current ? "page" : undefined}
    {...stylex.props(menuStyles.item, styles.link)}
    render={(props: Record<string, unknown>) =>
      renderElement("a", { ...props, href }, render)
    }
  >
    <span {...stylex.props(menuStyles.words, menuStyles.wordsBare)}>
      {children}
    </span>
    {current && <span aria-hidden="true" {...stylex.props(menuStyles.dot)} />}
  </ItemPrimitive>
);

/** The fold: the button says the current view (or the nav's name), its menu holds every view. */
export const Fold = ({
  label,
  segmented,
  children,
}: {
  label: string;
  segmented: boolean;
  children: ReactNode;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger
      size="sm"
      variant={segmented ? "quiet" : "ghost"}
      chevron
    >
      <span>
        <PlaceContext.Provider value="trigger">
          {children}
        </PlaceContext.Provider>
        <span {...stylex.props(styles.fallback)}>{label}</span>
      </span>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start">
      <PlaceContext.Provider value="menu">{children}</PlaceContext.Provider>
    </DropdownMenuContent>
  </DropdownMenu>
);
