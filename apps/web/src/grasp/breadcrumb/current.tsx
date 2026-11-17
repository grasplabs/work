// The page you are on, last in a Breadcrumb (breadcrumb.tsx). Its whole name is always in the page,
// so a screen reader hears all of it, once; when the line has no room left it is cut off with an
// ellipsis and takes keyboard focus, and Grasp's Tooltip shows the whole name on hover and on
// focus. It stays one element either way, so focus on it survives the line growing or shrinking.
"use client";

import * as stylex from "@stylexjs/stylex";
import { TooltipTrigger as TriggerPrimitive } from "@ui-sdk/react/tooltip";
import { useState } from "react";

import { focus } from "../focus/focus";
import { grasp } from "../tokens/tokens.stylex";
import { Tooltip, TooltipContent } from "../tooltip";

const styles = stylex.create({
  current: {
    display: "block",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: grasp.ink,
    fontWeight: grasp.weightMedium,
    borderRadius: grasp.cornerMark,
  },
});

/** The page you are on: its name, and its tooltip when the name is cut off (its title before the script runs). */
export const Current = ({
  label,
  cut,
  whole,
}: {
  label: string;
  cut: boolean;
  whole: boolean;
}) => {
  // Focus already on the name keeps it there when the name stops being cut off.
  const [held, setHeld] = useState(false);
  return (
    <Tooltip disabled={!cut}>
      <TriggerPrimitive
        // It takes focus while cut off, so the keyboard reaches its tooltip, and keeps it after.
        // The trigger merges these with its own focus handlers.
        tabIndex={cut || held ? 0 : undefined}
        onFocus={() => {
          setHeld(true);
        }}
        onBlur={() => {
          setHeld(false);
        }}
        // The tooltip repeats the name, which is already the element's own words: it describes
        // nothing new, so a screen reader is not told it twice.
        render={({
          type: _type,
          "aria-describedby": _description,
          ...props
        }: Record<string, unknown>) => (
          <span
            {...props}
            aria-current="page"
            data-slot="breadcrumb-current"
            data-cut={cut ? "" : undefined}
            // Its tooltip, which a screen reader is not told of; before the script runs, a title.
            data-tooltip-trigger={cut ? "" : undefined}
            title={whole ? label : undefined}
            {...stylex.props(styles.current, focus.words)}
          >
            {label}
          </span>
        )}
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
};
