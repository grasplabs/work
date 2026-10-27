import { Input } from "@grasp-os/ui/components/input";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";

// Renaming in place, as the sidebars' rows and an App's bar do it: a click
// opens, a double click renames, and the name is changed in a field that
// keeps it on Enter or leaving it, and the old one on Escape.

/**
 * A name being changed in place (a chat's, an App's): Enter or leaving the field keeps
 * it, Escape keeps the old one. `onDone` gets the new name, or `null` when
 * nothing should change, and whether a key ended it, so the focus can go
 * back to the row (leaving the field put it somewhere else already).
 */
export const RenameField = ({
  value,
  label,
  maxLength,
  onDone,
}: {
  value: string;
  label: string;
  maxLength: number;
  onDone: (name: string | null, byKey: boolean) => void;
}) => {
  const [text, setText] = useState(value);
  // Enter and Escape end it before the field loses focus; leaving it must
  // not end it a second time.
  const done = useRef(false);
  const finish = (name: string | null, byKey: boolean): void => {
    if (done.current) {
      return;
    }
    done.current = true;
    onDone(name, byKey);
  };
  return (
    <Input
      aria-label={label}
      maxLength={maxLength}
      // It opens to be typed in.
      autoFocus
      onBlur={() => {
        finish(text, false);
      }}
      onChange={(event) => {
        setText(event.target.value);
      }}
      onFocus={(event) => {
        event.currentTarget.select();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(text, true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(null, true);
        }
      }}
      value={text}
    />
  );
};

/** How long a first click waits for a second one before it counts as one. */
export const doubleClickMs = 250;

/**
 * A click and a double click that do different things on a link: the
 * click waits a moment, so a double click only renames. A click from the
 * keyboard, or one that opens a new tab, acts at once, as a link does.
 */
export const useClickOrDoubleClick = (
  onClick: () => void,
  onDoubleClick: () => void
) => {
  const pending = useRef(0);
  useEffect(
    () => () => {
      window.clearTimeout(pending.current);
    },
    []
  );
  return {
    onClick: (event: MouseEvent) => {
      window.clearTimeout(pending.current);
      const ownTab =
        event.button === 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey;
      if (event.detail === 0 || !ownTab) {
        return;
      }
      event.preventDefault();
      if (event.detail === 1) {
        pending.current = window.setTimeout(onClick, doubleClickMs);
      }
    },
    onDoubleClick: () => {
      window.clearTimeout(pending.current);
      onDoubleClick();
    },
  };
};
