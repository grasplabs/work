// A name renamed in place, in a small popup with a field: the bar's last crumb (the page's own name)
// given `onRename`. The same words (src/words/rename.ts) and keys as the panel's title and the
// Sidebar's row: a double-click, F2 or Enter opens it, Enter keeps the new name, Escape the old one.
// The host keeps the name.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";
import type { KeyboardEvent, SubmitEvent } from "react";

import { Button } from "../button";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { Input } from "../input";
import {
  Popover,
  PopoverContent,
  PopoverFooter,
  PopoverTitle,
} from "../popover";
import { grasp } from "../tokens/tokens.stylex";
import { renameWords } from "../words/rename";
import { useWords } from "../words/words";

const styles = stylex.create({
  // A button with no look of one: the name's own words, where they stood, cut as they were.
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
    borderRadius: grasp.cornerMark,
  },
  field: { display: "flex", flexDirection: "column", gap: grasp.space3 },
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
  /** The look the name has where it stands (the crumb's: cut with an ellipsis), over the button's. */
  look: stylex.StyleXStyles;
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
  look,
  current = false,
  open: given,
  onOpenChange,
}: RenamableNameProps) => {
  const words = useWords("rename", renameWords);
  const hint = useId();
  const [element, setElement] = useState<HTMLButtonElement | null>(null);
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
    <>
      <button
        ref={setElement}
        type="button"
        title={name}
        dir="auto"
        aria-current={current ? "page" : undefined}
        aria-haspopup="dialog"
        aria-describedby={hint}
        data-slot="app-shell-renamable"
        onDoubleClick={start}
        onKeyDown={handleKeyDown}
        {...stylex.props(styles.name, look, focus.words)}
      >
        {name}
      </button>
      <span id={hint} {...stylex.props(visuallyHidden)}>
        {words.hint}
      </span>
      {element !== null && (
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
          }}
        >
          <PopoverContent anchor={element} side="bottom" align="start">
            <form onSubmit={save} {...stylex.props(styles.field)}>
              <PopoverTitle>{words.rename}</PopoverTitle>
              <Input
                aria-label={words.field}
                value={draft}
                onValueChange={setDraft}
              />
              <PopoverFooter>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setOpen(false);
                  }}
                >
                  {words.cancel}
                </Button>
                <Button size="sm" type="submit">
                  {words.save}
                </Button>
              </PopoverFooter>
            </form>
          </PopoverContent>
        </Popover>
      )}
    </>
  );
};
