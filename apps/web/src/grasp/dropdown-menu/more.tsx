// DropdownMenuMore: a "More" button (an ellipsis) and its menu of actions, in order, links as links.
// The one menu the library folds actions into: the App card's "…", the App shell bar's More.
"use client";

import type { RenderProp } from "@ui-sdk/react/primitive";

import type { ButtonSize } from "../button";
import { More } from "../icons";
import type { IconData } from "../icons";
import { DropdownMenuItem } from "./item";
import { DropdownMenu } from "./menu";
import { DropdownMenuContent } from "./panel";
import { DropdownMenuTrigger } from "./trigger";

/**
 * One action that folds into a "More" menu: the App card's "…" menu, the App shell bar's actions
 * when room runs out. A button while it shows, an item of the menu once folded.
 */
export interface DropdownMenuAction {
  /** Its words ("Rename", "Duplicate"). */
  label: string;
  /** Runs when it is chosen. */
  onSelect?: () => void;
  /** An icon before the words. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** A step that cannot be undone, in the danger colour. */
  danger?: boolean;
  /** Shown, but not chosen now. */
  disabled?: boolean;
  /**
   * Where it leads ("Settings"): the item is then a link, opened by a press, Enter, a middle click
   * or in a new tab, as Dropdown menu's item is. The menu closes as it goes.
   */
  href?: string;
  /**
   * The link a router draws (`<Link to="…" />`), in place of an `<a href>`: it takes the item's look,
   * words and place in the arrows' order. Leave `href` out when the router's link carries the address.
   */
  render?: RenderProp;
}

/** Every prop a DropdownMenuMore takes. */
export interface DropdownMenuMoreProps {
  /** The actions, in order. */
  actions: readonly DropdownMenuAction[];
  /** The button's name ("More actions"). */
  label: string;
  /** Its size. @default "sm" */
  size?: ButtonSize;
}

/** A "More" button and its menu of actions. */
export const DropdownMenuMore = ({
  actions,
  label,
  size = "sm",
}: DropdownMenuMoreProps) => (
  <DropdownMenu>
    <DropdownMenuTrigger
      icon={More}
      aria-label={label}
      variant="ghost"
      size={size}
    />
    <DropdownMenuContent align="end">
      {actions.map((action) => (
        <DropdownMenuItem
          key={action.label}
          icon={action.icon}
          variant={action.danger === true ? "danger" : undefined}
          disabled={action.disabled}
          href={action.href}
          render={action.render}
          onSelect={() => {
            action.onSelect?.();
          }}
        >
          {action.label}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);
