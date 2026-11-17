// The "…" of a Breadcrumb (breadcrumb.tsx): the levels folded out of the line, behind a button
// named "Show hidden levels" that opens Grasp's Dropdown menu with each hidden level as a link, in
// the order of the path. UI SDK's menu follows a link item (an `a[href]`) on Enter as on a click.
// The Breadcrumb holds it open or closed, so no level leaves the menu while it is open.
"use client";

import * as stylex from "@stylexjs/stylex";
import { MenuItem as ItemPrimitive } from "@ui-sdk/react/menu";
import type { MenuItemState } from "@ui-sdk/react/menu";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  menuStyles,
} from "../dropdown-menu";
import { More } from "../icons";
import { grasp } from "../tokens/tokens.stylex";
import type { BreadcrumbItem } from "./breadcrumb";

const styles = stylex.create({
  // The trigger is a small ghost Button; the margins round it hand back what it is taller than the
  // line, so the trail stays one line high, and what it is wider than its "…", so the "…" stands
  // as far from the chevrons as a level's words do. Its fill, on hover, still clears them.
  // Its ring is drawn inside its edge, by a ring and a words offset (the ring offset set here): it is
  // then as tall as a level's ring and stands as far from the chevrons, evenly (A3-nav-02: outside
  // its edge it stood 3px off them against a level's 6px, and 30px tall against 24px).
  trigger: {
    display: "inline-flex",
    marginBlock: `calc((${grasp.textSmLine} - ${grasp.controlXs}) / 2)`,
    marginInline: `calc((${grasp.iconSm} - ${grasp.controlXs}) / 2)`,
    "--grasp-ring-offset": `calc(-1 * (${grasp.ringWidth} + ${grasp.ringOffsetWords}))`,
  },
  link: {
    textDecoration: "none",
  },
});

interface HiddenLevelsProps {
  levels: BreadcrumbItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
}

/** The button and its menu of the folded levels. */
export const HiddenLevels = ({
  levels,
  open,
  onOpenChange,
  label,
}: HiddenLevelsProps) => (
  <DropdownMenu open={open} onOpenChange={onOpenChange}>
    <span {...stylex.props(styles.trigger)}>
      <DropdownMenuTrigger
        icon={More}
        aria-label={label}
        variant="ghost"
        size="xs"
      />
    </span>
    <DropdownMenuContent align="start">
      {levels.map((level, index) => (
        <ItemPrimitive
          key={`${index}:${level.href ?? level.label}`}
          label={level.label}
          className={(state: MenuItemState) =>
            stylex.props(
              menuStyles.item,
              styles.link,
              state.highlighted && menuStyles.highlighted
            ).className
          }
          render={(props: Record<string, unknown>) => (
            <a {...props} href={level.href}>
              <span {...stylex.props(menuStyles.words)}>{level.label}</span>
            </a>
          )}
        />
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);
