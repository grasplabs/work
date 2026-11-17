"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Fragment,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";
import type { FocusEvent, KeyboardEvent, ReactElement } from "react";

import { announce } from "../announce/announce";
import { ContextMenu } from "../context-menu";
import type { MenuAction, MenuEntries } from "../context-menu/menu-items";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { More } from "../icons";
import { grasp, media } from "../tokens/tokens.stylex";
import { renameWords } from "../words/rename";
import { useWords } from "../words/words";
import { rowActionsMarker } from "./row-actions.stylex";
import { sidebarWords } from "./words";

/** What a row with actions or a rename takes, beside its link (sidebar.tsx's `SidebarSubRow`). */
export interface RowActionProps {
  /** The row's name: the context menu's name, and its field's words while it is renamed. */
  label: string;
  /**
   * Its menu: behind three dots at its end, and on a right-click, a long press, the menu key or
   * Shift+F10. Context menu's entries; the dots draw its actions, groups and separators.
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
   * @default "Name" (the shared rename words, src/words/rename.ts)
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
const REDUCED = media.reduced;

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
    // There while the row is pointed at or holds focus; always on a touch screen. Hidden by
    // opacity only, so they stay in the tab order and take no room of their own.
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover", rowActionsMarker)]: {
        default: 0,
        [HOVER]: 1,
      },
      [stylex.when.ancestor(":focus-within", rowActionsMarker)]: 1,
      [COARSE]: 1,
    },
    transitionProperty: "opacity",
    transitionDuration: { default: grasp.shellAnswer, [REDUCED]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  open: { opacity: 1 },
  // The rename field: the row's own box (its fill's start, end, height and corner) over the row's
  // link, which stays drawn under it, its words hidden; the row's own type, so nothing jumps.
  field: {
    position: "absolute",
    inset: 0,
    boxSizing: "border-box",
    width: "100%",
    height: "100%",
    margin: 0,
    paddingInlineEnd: grasp.shellRowInline,
    borderWidth: 0,
    borderRadius: grasp.shellCorner,
    backgroundColor: "transparent",
    color: grasp.shellText,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    letterSpacing: grasp.shellTracking,
  },
});

// Where the row's name stood when renaming started, so the field's words stand exactly there.
const fieldAt = stylex.create({
  at: (start: string, top: string, bottom: string) => ({
    paddingInlineStart: start,
    paddingBlockStart: top,
    paddingBlockEnd: bottom,
  }),
});

/** Where the name stands in the row's link: from its start, its top and its bottom, in pixels. */
interface NameAt {
  start: number;
  top: number;
  bottom: number;
}

/** Reads where the row's name stands in its link, as renaming starts. */
const nameIn = (link: HTMLElement | null): NameAt | undefined => {
  const name = link?.querySelector<HTMLElement>("[data-row-name]");
  if (link === null || name === null || name === undefined) {
    return undefined;
  }
  const box = link.getBoundingClientRect();
  const words = name.getBoundingClientRect();
  const rtl = getComputedStyle(link).direction === "rtl";
  return {
    start: rtl ? box.right - words.right : words.left - box.left,
    top: words.top - box.top,
    bottom: box.bottom - words.bottom,
  };
};

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
    variant={entry.danger === true ? "danger" : undefined}
    disabled={entry.disabled}
    icon={entry.icon}
    shortcut={entry.shortcut}
    onSelect={() => {
      onChoose(entry.value);
    }}
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
  inList,
  onChoose,
}: {
  items: MenuEntries;
  label: string;
  inList: boolean;
  onChoose: (value: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <span data-row-dots="" {...stylex.props(styles.dots, open && styles.open)}>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          icon={More}
          aria-label={label}
          size="xs"
          variant="ghost"
          tabIndex={inList ? -1 : undefined}
        />
        <DropdownMenuContent align="start">
          <DotsEntries items={items} onChoose={onChoose} />
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
};

/** The rename field: its words chosen as it opens; Enter or leaving it saves, Escape keeps the name. */
const RenameField = ({
  label,
  name,
  at,
  onDone,
}: {
  label: string;
  name: string;
  at: NameAt;
  /** With the new name, or none to keep the old one; `byKey` when a key ended it. */
  onDone: (name: string | undefined, byKey: boolean) => void;
}) => {
  const field = useRef<HTMLInputElement>(null);
  const ended = useRef(false);
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
      ref={field}
      type="text"
      aria-label={label}
      defaultValue={name}
      onBlur={(event: FocusEvent<HTMLInputElement>) => {
        end(event.currentTarget.value, false);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          event.preventDefault();
          end(event.currentTarget.value, true);
        } else if (event.key === "Escape") {
          // Escape ends the rename only: it does not also fold a peeking sidebar or close a sheet.
          event.preventDefault();
          event.stopPropagation();
          end(undefined, true);
        }
      }}
      data-row-rename=""
      {...stylex.props(
        styles.field,
        fieldAt.at(
          `${String(at.start)}px`,
          `${String(at.top)}px`,
          `${String(at.bottom)}px`
        ),
        focus.fieldInside
      )}
    />
  );
};

/** What the row's link takes from its actions: the rename hint, as its description. */
export interface RowLinkExtras {
  "aria-describedby"?: string;
  /** While the row is renamed: its link stays drawn under the field, out of reach. */
  inert?: boolean;
}

const rtl = (element: Element) => getComputedStyle(element).direction === "rtl";

/** Whether a key goes toward the row's end (→ in left to right, ← in right to left). */
const towardEnd = (event: globalThis.KeyboardEvent, element: Element) =>
  event.key === (rtl(element) ? "ArrowLeft" : "ArrowRight");

/** Whether a key goes back toward the row's start. */
const towardStart = (event: globalThis.KeyboardEvent, element: Element) =>
  event.key === (rtl(element) ? "ArrowRight" : "ArrowLeft");

/**
 * A row's link (drawn by `children`) with its three dots, its context menu and its
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
  inList,
  children,
}: RowActionProps & {
  /** The row is one of a list's items (`keys="list"`): one tab stop, the dots reached by → from it. */
  inList: boolean;
  /** Draws the row's link, with what it takes from its actions. */
  children: (extras: RowLinkExtras) => ReactElement;
}): ReactElement => {
  const words = useWords("sidebar", sidebarWords);
  const said = useWords("rename", renameWords);
  const hint = useId();
  const [renaming, setRenaming] = useState(false);
  const [at, setAt] = useState<NameAt>();
  const holder = useRef<HTMLDivElement>(null);
  const hasActions = actions !== undefined && actions.length > 0;
  const renames = onRename !== undefined;
  const linkOf = () =>
    holder.current?.querySelector<HTMLElement>(":scope > a, :scope > button") ??
    null;
  const dotsOf = () =>
    holder.current?.querySelector<HTMLElement>("[data-row-dots] button") ??
    null;
  const startRename = (): void => {
    const where = nameIn(linkOf());
    if (renames && where !== undefined) {
      setAt(where);
      setRenaming(true);
    }
  };
  const choose = (value: string): void => {
    if (value === "rename" && renames) {
      startRename();
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
    const dots =
      event.target instanceof Element &&
      event.target.closest("[data-row-dots]") !== null;
    if (event.key === "F2" && !dots && renames) {
      event.preventDefault();
      startRename();
    } else if (
      inList &&
      !dots &&
      hasActions &&
      event.target instanceof Element &&
      towardEnd(event, event.target)
    ) {
      // In a list the row is the one stop: → reaches its dots, and ← or Escape comes back.
      event.preventDefault();
      dotsOf()?.focus();
    } else if (
      inList &&
      dots &&
      event.target instanceof Element &&
      (event.key === "Escape" || towardStart(event, event.target))
    ) {
      event.preventDefault();
      linkOf()?.focus();
    }
  });
  useEffect(() => {
    const box = holder.current;
    const listening =
      box !== null && (renames || (inList && hasActions)) && !renaming;
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
  }, [renames, renaming, inList, hasActions]);
  if (!hasActions && !renames) {
    return children({});
  }
  const done = (next: string | undefined, byKey: boolean) => {
    setRenaming(false);
    const trimmed = next?.trim();
    if (trimmed !== undefined && trimmed !== "" && trimmed !== label) {
      onRename?.(trimmed);
      announce((renamedLabel ?? words.renamed)(trimmed));
    }
    if (byKey) {
      // Back on the row's link, once it is drawn again.
      requestAnimationFrame(() => {
        linkOf()?.focus();
      });
    }
  };
  // While it is renamed, the row's link stays under the field, its words hidden and out of reach,
  // and the field takes the link's whole box.
  const extras: RowLinkExtras = renaming ? { inert: true } : {};
  const row = children(
    renames && !renaming ? { "aria-describedby": hint } : extras
  );
  const held = (
    <div ref={holder} {...stylex.props(styles.holder, rowActionsMarker)}>
      {row}
      {renaming && at !== undefined && (
        <RenameField
          label={renameLabel ?? said.field}
          name={label}
          at={at}
          onDone={done}
        />
      )}
      {renames && (
        <span id={hint} {...stylex.props(visuallyHidden)}>
          {said.hint}
        </span>
      )}
      {hasActions && !renaming && (
        <Dots
          items={actions}
          label={actionsLabel ?? words.actions(label)}
          inList={inList}
          onChoose={choose}
        />
      )}
    </div>
  );
  // The row's link is what the keys reach, so the area takes no tab stop; the menu gives focus back
  // to the link, or to nobody when its choice starts renaming (the field takes it).
  return hasActions ? (
    <ContextMenu
      aria-label={label}
      items={actions}
      onAction={choose}
      tabStop={false}
      finalFocus={renaming ? "none" : linkOf}
    >
      {held}
    </ContextMenu>
  ) : (
    held
  );
};

/** The room a row with actions keeps at its end for the dots: add it to the row's look. */
export const rowActionsRoom = styles.room;
