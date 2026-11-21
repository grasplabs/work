// The "…" of a Breadcrumb (breadcrumb.tsx): the levels folded out of the line, behind a button
// named "Show hidden levels" that opens Grasp's Dropdown menu with each hidden level as a link, in
// the order of the path. UI SDK's menu follows a link item (an `a[href]`) on Enter as on a click.
// The Breadcrumb holds it open or closed, so no level leaves the menu while it is open.
"use client";

import * as stylex from "@stylexjs/stylex";
import { MenuItem as ItemPrimitive } from "@ui-sdk/react/menu";
import type { MenuItemState } from "@ui-sdk/react/menu";
import { mergeProps, renderElement } from "@ui-sdk/react/primitive";
import type { RenderProp } from "@ui-sdk/react/primitive";
import { useRef } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  menuStyles,
} from "../dropdown-menu";
import { More } from "../icons";
import { grasp } from "../tokens/tokens.stylex";

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
  // A level drawn as a button (its `render`): none of a button's own look, so it reads as the rest.
  press: {
    appearance: "none",
    margin: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    fontFamily: "inherit",
    textAlign: "start",
  },
});

interface HiddenLevelsProps {
  /** The folded levels, in the order of the path: each its name and where it goes, or what it is drawn as. */
  levels: { label: string; href?: string; render?: RenderProp }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
}

/** One folded level, as a link; or as what its `render` draws, a button that Enter presses as a click does. */
const Level = ({ level }: { level: HiddenLevelsProps["levels"][number] }) => {
  const element = useRef<HTMLElement>(null);
  return (
    <ItemPrimitive
      label={level.label}
      className={(state: MenuItemState) =>
        stylex.props(
          menuStyles.item,
          styles.link,
          level.render !== undefined && styles.press,
          state.highlighted && menuStyles.highlighted
        ).className
      }
      // The menu takes Enter and Space for its own select, so a level drawn as a button is pressed
      // from there: its click runs the caller's own handler and closes the menu.
      onSelect={(event: Event) => {
        if (level.render !== undefined && event instanceof KeyboardEvent) {
          event.preventDefault();
          element.current?.click();
        }
      }}
      render={(props: Record<string, unknown>) =>
        renderElement(
          "a",
          mergeProps(props, {
            ref: element,
            href: level.href,
            children: (
              <span {...stylex.props(menuStyles.words)}>{level.label}</span>
            ),
          }),
          level.render
        )
      }
    />
  );
};

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
        <Level key={`${index}:${level.href ?? level.label}`} level={level} />
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);
