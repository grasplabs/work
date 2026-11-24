import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverFooter,
  PopoverTitle,
} from "@grasp-os/ui/components/popover";
import { focusRingText, visuallyHidden } from "@grasp-os/ui/lib/styles";
import { radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";
import type { KeyboardEvent, SubmitEvent } from "react";

// A name renamed in place, in a small popup with a field: the page bar's
// last crumb (the page's own name, a chat's on its page) given `onRename`,
// as #2503's shell has it. The same words and keys as the chat panel's
// title (head.tsx): a double-click, F2 or Enter opens it, Enter keeps the
// new name, Escape the old one. The host keeps the name.

const styles = stylex.create({
  // A button with no look of one: the name's own words, where they stood.
  name: {
    display: "block",
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    fontWeight: "inherit",
    textAlign: "start",
    cursor: "text",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    borderRadius: radius.sm,
  },
  field: { display: "flex", flexDirection: "column", gap: space["3"] },
});

/** Whether a key on the name opens the rename: F2, or Enter as on any button. */
const opensRename = (event: KeyboardEvent<HTMLElement>) =>
  event.key === "F2" || event.key === "Enter";

/** Every prop a RenamableName takes. */
interface RenamableNameProps {
  /** The name as it stands. */
  name: string;
  /** Runs with the new name, trimmed and changed. */
  onRename: (name: string) => void;
  /** Said of the name when it is the page itself. */
  current?: boolean;
  /** Whether the popup is open, when the host opens it itself; else the name keeps it. */
  open?: boolean;
  /** Runs when the popup opens or closes. */
  onOpenChange?: (open: boolean) => void;
}

/** The name as a button: a double-click, F2 or Enter opens the popup that renames it. */
export const RenamableName = ({
  name,
  onRename,
  current = false,
  open: given,
  onOpenChange,
}: RenamableNameProps) => {
  const { t } = useLingui();
  const hint = useId();
  const [own, setOwn] = useState(false);
  const open = given ?? own;
  const setOpen = (next: boolean) => {
    setOwn(next);
    onOpenChange?.(next);
  };
  const [draft, setDraft] = useState(name);
  // Opened by the host (a menu's Rename): the field starts from the name as it is now.
  const [opened, setOpened] = useState(open);
  if (opened !== open) {
    setOpened(open);
    if (open) {
      setDraft(name);
    }
  }
  const start = () => {
    setDraft(name);
    setOpen(true);
  };
  const save = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = draft.trim();
    if (next !== "" && next !== name) {
      onRename(next);
    }
    setOpen(false);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (opensRename(event)) {
      event.preventDefault();
      start();
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          type="button"
          title={name}
          dir="auto"
          aria-current={current ? "page" : undefined}
          aria-haspopup="dialog"
          aria-describedby={hint}
          data-slot="app-shell-renamable"
          onDoubleClick={start}
          onKeyDown={handleKeyDown}
          {...stylex.props(styles.name, focusRingText)}
        >
          {name}
        </button>
      </PopoverAnchor>
      <span id={hint} {...stylex.props(visuallyHidden)}>
        {t`Double-click or press F2 to rename`}
      </span>
      <PopoverContent align="start" side="bottom">
        <form onSubmit={save} {...stylex.props(styles.field)}>
          <PopoverTitle>{t`Rename`}</PopoverTitle>
          <Input aria-label={t`Name`} onValueChange={setDraft} value={draft} />
          <PopoverFooter>
            <Button
              onClick={() => {
                setOpen(false);
              }}
              size="sm"
              variant="ghost"
            >
              {t`Cancel`}
            </Button>
            <Button size="sm" type="submit">
              {t`Save`}
            </Button>
          </PopoverFooter>
        </form>
      </PopoverContent>
    </Popover>
  );
};
