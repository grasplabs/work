"use client";

import * as stylex from "@stylexjs/stylex";
import type { CommandActionDetails } from "@ui-sdk/react/command";
import {
  DialogBackdrop,
  DialogContent,
  Dialog as DialogPrimitive,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { useRef, useState } from "react";

import { DialogTrigger } from "../dialog";
import { dialogStyles } from "../dialog/styles";
import { visuallyHidden } from "../hidden/hidden";
import { Search } from "../icons";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords } from "../words/words";
import { CommandView } from "./command";
import type { CommandItems } from "./command";
import { commandWords } from "./words";

/** Every prop a CommandDialog takes. */
export interface CommandDialogProps {
  /** The commands, as Command takes them: commands, groups and separators. */
  items: CommandItems;
  /**
   * Runs the command with this value. The palette closes once it has run; when it returns a
   * Promise, once that settles, and it stays open showing the `failedLabel` if it rejects.
   */
  onAction?: (value: string, details: CommandActionDetails) => unknown;
  /** The search field's name, and the palette's, as a screen reader and an agent say it ("Search actions"). */
  "aria-label": string;
  /**
   * The words on the trigger.
   * @default "Search"
   */
  trigger?: string;
  /**
   * The keys that open it from anywhere on the page: `mod` is Command on a Mac and Control
   * elsewhere. Pass `null` for none.
   * @default "mod+k"
   */
  shortcut?: string | null;
  /**
   * What the empty field says: a verb and the thing.
   * @default "Type a command or search"
   */
  placeholder?: string;
  /**
   * What the list says when nothing matches.
   * @default "No results"
   */
  empty?: string;
}

const MOVING = ":is([data-starting-style], [data-ending-style])";

const styles = stylex.create({
  // In and out: a fade alone, at most 150ms in and faster out, the shade with it. A palette is
  // opened from the keyboard many times a day: it answers at once, it does not travel or grow.
  fade: {
    opacity: { default: 1, [MOVING]: 0 },
    transitionProperty: "opacity",
    transitionDuration: {
      default: simply.searchOpen,
      ":is([data-ending-style])": simply.searchClose,
    },
    transitionTimingFunction: grasp.ease,
  },
  // The panel: the dialog's own surface, place and width (a sheet on a phone), set three gutters
  // from the top so the list grows down from the field without moving it.
  panel: {
    marginBlockStart: {
      default: `calc(3 * ${grasp.dialogGutter})`,
      [media.belowPhone]: 0,
    },
    maxHeight: {
      default: `calc(var(--visual-viewport-height, 100dvh) - 4 * ${grasp.dialogGutter})`,
      [media.belowPhone]: `calc(var(--visual-viewport-height, 100dvh) - ${grasp.dialogGutter})`,
    },
  },
});

/** Waits for a command's work: the palette closes once it is done, and stays open when it fails. */
const waitThenClose = async (
  work: unknown,
  pending: { current: boolean },
  close: () => void
) => {
  let done: unknown;
  try {
    done = await work;
  } catch (error) {
    pending.current = false;
    throw error;
  }
  pending.current = false;
  close();
  return done;
};

/** The trigger and the palette it opens. */
export const CommandDialog = ({
  items,
  onAction,
  "aria-label": ariaLabel,
  trigger,
  shortcut = "mod+k",
  placeholder,
  empty,
}: CommandDialogProps) => {
  const words = useWords("command", commandWords);
  const [open, setOpen] = useState(false);
  // While a command works, nothing closes the palette: its outcome is shown where it ran.
  const pending = useRef(false);
  // Close once the command has run; a failure keeps it open, showing why (Command does that).
  const run = (value: string, details: CommandActionDetails) => {
    const result = onAction?.(value, details);
    const thenable =
      result !== null && typeof result === "object" && "then" in result;
    if (!thenable) {
      setOpen(false);
      return result;
    }
    pending.current = true;
    return waitThenClose(result, pending, () => {
      setOpen(false);
    });
  };
  return (
    <DialogPrimitive
      open={open}
      onOpenChange={(next: boolean, details: { cancel: () => void }) => {
        if (!next && pending.current) {
          details.cancel();
          return;
        }
        setOpen(next);
      }}
    >
      <DialogTrigger icon={Search} shortcut={shortcut ?? undefined}>
        {trigger ?? words.dialogTrigger}
      </DialogTrigger>
      <DialogBackdrop {...stylex.props(dialogStyles.scrim, styles.fade)} />
      <DialogContent
        {...stylex.props(
          dialogStyles.panel,
          dialogStyles.placed,
          styles.fade,
          styles.panel
        )}
      >
        <DialogTitle {...stylex.props(visuallyHidden)}>{ariaLabel}</DialogTitle>
        <CommandView
          bare
          items={items}
          onAction={run}
          aria-label={ariaLabel}
          placeholder={placeholder ?? words.dialogPlaceholder}
          empty={empty}
        />
      </DialogContent>
    </DialogPrimitive>
  );
};
