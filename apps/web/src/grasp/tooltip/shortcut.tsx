// TooltipShortcut: the keys of what the trigger does, at the end of the tooltip's words, written
// for the platform: ⌘D on a Mac, Ctrl+D elsewhere. The keys come from the Tooltip's `shortcut`.
"use client";

import * as stylex from "@stylexjs/stylex";
import { formatShortcut } from "@ui-sdk/react/shortcuts";
import { TooltipShortcut as ShortcutPrimitive } from "@ui-sdk/react/tooltip";

import { useStill } from "./still-context";
import { tooltipStyles as styles } from "./styles";

/** Every prop a TooltipShortcut takes. */
export interface TooltipShortcutProps {
  /** Other keys to show than the Tooltip's `shortcut`. It changes only what is shown, not `aria-keyshortcuts`. */
  shortcut?: string;
}

/** The shortcut's keys, quieter than the words before them. */
export const TooltipShortcut = ({ shortcut }: TooltipShortcutProps) => {
  const still = useStill();
  if (still) {
    const keys = shortcut ?? still.shortcut;
    if (keys === undefined || keys === "") {
      return null;
    }
    // Written for a Mac and for the rest the same way on the server and in the browser.
    return (
      <span data-tooltip-keys="" {...stylex.props(styles.shortcut)}>
        {formatShortcut(keys, false)}
      </span>
    );
  }
  return (
    <ShortcutPrimitive
      shortcut={shortcut}
      data-tooltip-keys=""
      {...stylex.props(styles.shortcut)}
    />
  );
};
