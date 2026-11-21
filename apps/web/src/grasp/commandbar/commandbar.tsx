/* oxlint-disable typescript/no-deprecated -- the breaking release's step 3: Commandbar stays a wrapper over CommandDialog until step 9 removes it (handover/audit/RELEASE.md §7). */
import type { CommandActionDetails } from "@ui-sdk/react/command";

import { CommandDialog } from "../command";
import type { CommandItems } from "../command";

/** @deprecated Use `CommandDialogProps` (from `command`). */
export interface CommandbarProps {
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

/** @deprecated Use `CommandDialog` from `command`: `<CommandDialog aria-label="Search actions" items={…} />`. */
export const Commandbar = (props: CommandbarProps) => (
  <CommandDialog {...props} />
);
