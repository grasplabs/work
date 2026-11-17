"use client";

// A row's own actions in the Sidebar (sidebar.tsx): three dots at the row's end, there while the row
// is pointed at or holds focus (always on a touch screen), opening the row's `actions` in a Dropdown
// menu; the same actions in a Context menu on a right-click, the menu key or Shift+F10; and renaming
// the row in place, where the row takes `onRename`: a double-click on it, F2 on it, or its action
// "rename" turns its name into a field of the row's own height and type, its words chosen; Enter or
// leaving it saves, Escape or an empty name keeps the name, and a screen reader hears the new one. A
// press on the row still follows its link at once. Every word is the row's prop, with English
// defaults in words.ts.
//
// Work's local change to Damsko's Sidebar (17 Nov 2026): see `.context/library-changes.md`.

import * as stylex from "@stylexjs/stylex";
import { Fragment, useEffect, useEffectEvent, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, ReactElement } from "react";

import { announce } from "../announce/announce";
import { ContextMenu } from "../context-menu";
import type { MenuAction, MenuEntries } from "../context-menu";
import {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPanel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { focus } from "../focus/focus";
import { More } from "../icons";
import { grasp, media } from "../tokens/tokens.stylex";
import { rowActionsMarker } from "./row-actions.stylex";
import {
  defaultActionsLabel,
  defaultRenamedLabel,
  defaultRenameLabel,
} from "./words";

/** What a row with actions or a rename takes, beside its link (sidebar.tsx's `SidebarSubRow`). */
export interface RowActionProps {
  /** The row's name: the context menu's name, and its field's words while it is renamed. */
  label: string;
  /**
   * Its menu: behind three dots at its end, and on a right-click, the menu key or Shift+F10.
   * Context menu's entries; the dots draw its actions, groups and separators.
   */
  actions?: MenuEntries;
  /** Runs with an action's `value` when it is chosen ("rename" only starts renaming, where the row takes `onRename`). */
  onAction?: (value: string) => void;
  /** Lets the row be renamed in place; runs with the new name, trimmed, when it is not empty and differs. */
  onRename?: (name: string) => void;
  /**
   * The three dots' name, for a screen reader.
   * @default `More for ${label}`
   */
  actionsLabel?: string;
  /**
   * The rename field's name, for a screen reader.
   * @default `Rename ${label}`
   */
  renameLabel?: string;
  /**
   * What a screen reader hears once the row is renamed, with its new name.
   * @default (name) => `Renamed to ${name}`
   */
  renamedLabel?: (name: string) => string;
}

const COARSE = media.coarse;
const HOVER = media.hover;

const styles = stylex.create({
  // The row and its dots: the dots stand over the row's end.
  holder: {
    position: "relative",
  },
  // The room the dots take at the row's end, kept whether they show or not, so nothing moves when
  // they come: the name is cut before them.
  room: {
    paddingInlineEnd: `calc(${grasp.shellRowInline} + ${grasp.shellIconButton})`,
  },
  dots: {
    position: "absolute",
    insetBlock: 0,
    insetInlineEnd: grasp.space1,
    display: "flex",
    alignItems: "center",
    // There while the row is pointed at or holds focus; always on a touch screen.
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover", rowActionsMarker)]: {
        default: 0,
        [HOVER]: 1,
      },
      [stylex.when.ancestor(":focus-within", rowActionsMarker)]: 1,
      [COARSE]: 1,
    },
  },
  open: { opacity: 1 },
  // The rename field: the row's own words, in the row's box, so nothing jumps.
  field: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: grasp.shellCorner,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
    fontWeight: "inherit",
    lineHeight: "inherit",
    letterSpacing: "inherit",
  },
});

/** Whether an event came from the row itself, not its dots. */
const fromRow = (event: Event): boolean =>
  event.target instanceof Element &&
  event.target.closest("[data-row-dots]") === null;

/** An action as a Dropdown menu item. */
const DotsItem = ({
  entry,
  onChoose,
}: {
  entry: MenuAction;
  onChoose: (value: string) => void;
}) => (
  <DropdownMenuItem
    danger={entry.danger}
    disabled={entry.disabled}
    icon={entry.icon}
    onSelect={() => {
      onChoose(entry.value);
    }}
    shortcut={entry.shortcut}
  >
    {entry.label}
  </DropdownMenuItem>
);

/**
 * The entries in the dots' Dropdown menu: actions, groups and separators. A checkbox or a radio
 * group has nothing in a row to report its change to, so the dots leave them to the Context menu.
 */
const DotsEntries = ({
  items,
  onChoose,
}: {
  items: MenuEntries;
  onChoose: (value: string) => void;
}) =>
  items.map((entry, index) => {
    if (!("type" in entry)) {
      return <DotsItem entry={entry} key={entry.value} onChoose={onChoose} />;
    }
    if (entry.type === "group") {
      return (
        <DropdownMenuGroup key={`group-${entry.label}`}>
          <DropdownMenuLabel>{entry.label}</DropdownMenuLabel>
          {entry.items.map((inner) => (
            <DotsItem entry={inner} key={inner.value} onChoose={onChoose} />
          ))}
        </DropdownMenuGroup>
      );
    }
    if (entry.type === "separator") {
      // A separator has nothing of its own to key it by but where it stands.
      return (
        <Fragment key={`separator-${String(index)}`}>
          <DropdownMenuSeparator />
        </Fragment>
      );
    }
    return null;
  });

/** The three dots and their menu. */
const Dots = ({
  items,
  label,
  onChoose,
}: {
  items: MenuEntries;
  label: string;
  onChoose: (value: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <span data-row-dots="" {...stylex.props(styles.dots, open && styles.open)}>
      <DropdownMenu onOpenChange={setOpen} open={open}>
        <DropdownMenuTrigger
          icon={More}
          label={label}
          size="xs"
          variant="ghost"
        />
        <DropdownMenuPanel align="start">
          <DotsEntries items={items} onChoose={onChoose} />
        </DropdownMenuPanel>
      </DropdownMenu>
    </span>
  );
};

/**
 * The rename field: its words chosen as it opens; Enter or leaving it saves, Escape keeps the name.
 * Opened from the Context menu, which gives focus back to its area as it closes, the field takes it
 * back once (`retake`), until a key is pressed in it.
 */
const RenameField = ({
  label,
  name,
  retake,
  onDone,
}: {
  label: string;
  name: string;
  retake: boolean;
  /** With the new name, or none to keep the old one; `byKey` when a key ended it. */
  onDone: (name: string | undefined, byKey: boolean) => void;
}) => {
  const field = useRef<HTMLInputElement>(null);
  const ended = useRef(false);
  const retaking = useRef(retake);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const end = (next: string | undefined, byKey: boolean): void => {
    if (ended.current) {
      return;
    }
    ended.current = true;
    onDone(next, byKey);
  };
  return (
    <input
      aria-label={label}
      defaultValue={name}
      onBlur={(event: FocusEvent<HTMLInputElement>) => {
        const to = event.relatedTarget;
        const own = event.currentTarget;
        // The menu giving focus back to the row's area, round the field: not the person leaving.
        if (retaking.current && to instanceof Node && to.contains(own)) {
          retaking.current = false;
          requestAnimationFrame(() => {
            own.focus();
          });
          return;
        }
        end(own.value, false);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        retaking.current = false;
        if (event.key === "Enter") {
          event.preventDefault();
          end(event.currentTarget.value, true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          end(undefined, true);
        }
      }}
      ref={field}
      type="text"
      {...stylex.props(styles.field, focus.field)}
    />
  );
};

/**
 * A row's link (`children`, drawn with `look`) with its three dots, its context menu and its
 * rename. A row with neither actions nor `onRename` is its link alone.
 */
export const RowActions = ({
  label,
  actions,
  onAction,
  onRename,
  actionsLabel,
  renameLabel,
  renamedLabel,
  look,
  children,
}: RowActionProps & {
  /** The row's look, for the box the rename field stands in. */
  look: ReturnType<typeof stylex.props>;
  /** The row's link. */
  children: ReactElement;
}): ReactElement => {
  const [renaming, setRenaming] = useState(false);
  // Renamed from a menu: the field takes focus back from the menu closing.
  const [byMenu, setByMenu] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const hasActions = actions !== undefined && actions.length > 0;
  const renames = onRename !== undefined;
  const startRename = (menu = false): void => {
    if (renames) {
      setRenaming(true);
      setByMenu(menu);
    }
  };
  const choose = (value: string): void => {
    if (value === "rename" && renames) {
      startRename(true);
      return;
    }
    onAction?.(value);
  };
  // A double-click on the row, or F2 on it, renames it; not on its dots. Listened to on the box
  // round the link (the events come from the link inside it), so the link stays as it was drawn.
  const onDoubleClick = useEffectEvent((event: Event) => {
    if (fromRow(event)) {
      startRename();
    }
  });
  const onKey = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key === "F2" && fromRow(event)) {
      event.preventDefault();
      startRename();
    }
  });
  useEffect(() => {
    const box = holder.current;
    const listening = box !== null && renames && !renaming;
    if (listening) {
      box.addEventListener("dblclick", onDoubleClick);
      box.addEventListener("keydown", onKey);
    }
    return () => {
      if (listening) {
        box.removeEventListener("dblclick", onDoubleClick);
        box.removeEventListener("keydown", onKey);
      }
    };
  }, [renames, renaming]);
  if (!hasActions && !renames) {
    return children;
  }
  // While it is a field, the row is not a link: the field stands in the row's own box.
  const row = renaming ? (
    <div {...look}>
      <RenameField
        label={renameLabel ?? defaultRenameLabel(label)}
        name={label}
        onDone={(next, byKey) => {
          setRenaming(false);
          const trimmed = next?.trim();
          if (trimmed !== undefined && trimmed !== "" && trimmed !== label) {
            onRename?.(trimmed);
            announce((renamedLabel ?? defaultRenamedLabel)(trimmed));
          }
          if (byKey) {
            // Back on the row's link, once it is drawn again.
            requestAnimationFrame(() => {
              holder.current?.querySelector<HTMLElement>("a, button")?.focus();
            });
          }
        }}
        retake={byMenu}
      />
    </div>
  ) : (
    children
  );
  const held = (
    <div ref={holder} {...stylex.props(styles.holder, rowActionsMarker)}>
      {row}
      {hasActions && !renaming && (
        <Dots
          items={actions}
          label={actionsLabel ?? defaultActionsLabel(label)}
          onChoose={choose}
        />
      )}
    </div>
  );
  return hasActions ? (
    <ContextMenu aria-label={label} items={actions} onAction={choose}>
      {held}
    </ContextMenu>
  ) : (
    held
  );
};

/** The room a row with actions keeps at its end for the dots: add it to the row's look. */
export const rowActionsRoom = styles.room;
