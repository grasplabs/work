import { AgentIndicator } from "@grasp-os/ui/components/agent-indicator";
import {
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@grasp-os/ui/components/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Sidebar,
  SidebarCollapsible,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarLevel,
  SidebarLevels,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarTrigger,
  useSidebar,
} from "@grasp-os/ui/components/sidebar";
import { sidebarMenuItemMarker } from "@grasp-os/ui/components/sidebar.stylex";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import {
  ChevronRightIcon,
  EllipsisIcon,
  Icon,
  SearchIcon,
  XIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { focusRingInset, visuallyHidden } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { announce } from "@grasp-os/ui/lib/utils";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type {
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  ReactElement,
  ReactNode,
} from "react";

import { LevelHead, SidebarSwitch, SwitchPanel } from "./sidebar-switch.tsx";
import type { RenderLink, SidebarTab } from "./sidebar-switch.tsx";

// The product's sidebar, as the reference's (#2503's grasp/sidebar, which
// the frame fills from grasp/frame/grasp-sidebar.tsx): the rows as data, in
// groups, drawn with Damsko's Sidebar parts. At its top Grasp's mark, the
// search and the fold; under it the switch of the main list's views (Home,
// Inbox); then the rows, or a level of an area of its own (Settings, an
// App, an agent, the Brain, Integrations) with Back and its name, which
// slides in over the main list and back; at its foot the person.

export type { LinkLook, RenderLink, SidebarTab } from "./sidebar-switch.tsx";

/** One entry of a row's menu: a choice, or a line between choices. */
export type RowAction =
  | {
      value: string;
      label: string;
      icon: IconData;
      /** A choice that removes or destroys, in the danger ink. */
      danger?: boolean;
    }
  | "separator";

/** A row under a row: a page within it. */
export interface SidebarSubRow {
  id?: string;
  label: string;
  /** The link itself (`(look) => <Link {...look} to="/apps" />`): it takes the row's look and its words. */
  render?: RenderLink;
  current?: boolean;
}

/** One row: a link to a page, its icon, and what stands at its end. */
export interface SidebarRow extends SidebarSubRow {
  icon?: IconData;
  /** How many things wait there: a small pill at the row's end. None at 0. */
  count?: number;
  /** What a screen reader hears of the count. @default the number */
  countLabel?: string;
  /** Runs when the row is pressed; a row without `render` is a button. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  /** Its own rows, under its name. */
  rows?: readonly SidebarSubRow[];
  /** A second, quieter line under its name: the row grows to two lines. */
  detail?: string;
  /** Short words at the row's end, quiet, instead of a count ("2d"). */
  end?: string;
  /** What a screen reader hears of `end`. @default `end` */
  endLabel?: string;
  /** Its name in the regular weight: a thing (a chat) in a list of them, not a place. */
  quiet?: boolean;
  /** An agent works there now: the Working mark at the row's end. */
  working?: boolean;
  workingLabel?: string;
  /** Its menu: behind three dots at its end, and on a right-click, a long press, the menu key or Shift+F10. */
  actions?: readonly RowAction[];
  /** The dots' name ("More for Weekly numbers"). */
  actionsLabel?: string;
  onAction?: (value: string) => void;
  /**
   * Renamed in place: its menu's `rename`, F2 or a double-click lays a field over its words;
   * runs with the new name, trimmed, when it is not empty and differs.
   */
  onRename?: (name: string) => void;
  /** The rename field's name ("Rename Weekly numbers"). */
  renameLabel?: string;
  /** Said of a row that renames, after its name ("Double-click or press F2 to rename"). */
  renameHint?: string;
  /** What a screen reader hears once it is renamed ("Renamed to Board report"). */
  renamedLabel?: (name: string) => string;
}

/** The last, quiet row of a group: the way to all of them ("All chats"). */
export interface SidebarMore {
  label: string;
  render?: RenderLink;
  onClick?: () => void;
}

/** A run of rows, under a small label or none. */
export interface SidebarGroupEntry {
  /** What its fold is kept under. @default its label */
  id?: string;
  label?: string;
  rows: readonly SidebarRow[];
  /** Its own content in place of the rows (a tree). */
  content?: ReactElement;
  /** Its label folds the rows away and opens them again. */
  collapsible?: boolean;
  /** A number beside its label. */
  count?: number;
  more?: SidebarMore;
}

/** Views of a level's page, under its name, in the switch (an App's preview widths). */
export interface SidebarSectionViews {
  label: string;
  tabs: readonly SidebarTab[];
  value: string;
  onChange: (value: string) => void;
}

/** An area of the product with a navigation of its own, a level of the sidebar while one of its pages is open. */
export interface SidebarSection {
  id: string;
  title: string;
  icon?: IconData;
  /** A mark of the area's own before its name (an agent's face), instead of `icon`. */
  mark?: ReactNode;
  /** Where Back leads, as a link, and its words. */
  back: { label: string; render: RenderLink };
  /** The area's own first page, as a link: its name opens it. */
  home: RenderLink;
  homeCurrent?: boolean;
  views?: SidebarSectionViews;
  groups: readonly SidebarGroupEntry[];
  /** What its rows are, said as a landmark. @default `title` */
  navLabel?: string;
}

const HOVER = media.hover;
const COARSE = media.pointerCoarse;
// A row whose dots' menu is open.
const HELD_OPEN = ":has([data-slot=sidebar-menu-action][aria-expanded=true])";

const styles = stylex.create({
  // Grasp's mark at the start, the search and the fold at the end, in one
  // row the icon buttons' height; the fold's glyph ends where the rows' ink
  // does.
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: size.sidebarRowGap,
    minHeight: size.sidebarIconButton,
  },
  // In the phone's sheet the head stands nearer the sheet's top, as the
  // reference's: over the main list's switch its buttons in the middle of
  // a row's height at the top; over a level's head 2px lower, the sheet's
  // own inset less the sidebar's room above.
  headInSheet: {
    marginBlockStart: `calc((${size.sidebarMenuButtonHeight} - ${size.sidebarIconButton}) / 2 - ${space["4"]})`,
  },
  headInSheetLevel: { marginBlockStart: `calc(-1 * ${space["3"]})` },
  mark: {
    [iconVars.size]: size.appShellMark,
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    height: size.sidebarIconButton,
    paddingInlineStart: size.sidebarRowInline,
    color: colors.sidebarForeground,
  },
  tools: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    marginInlineStart: "auto",
    marginInlineEnd: `calc(${size.sidebarRowInline} - (${size.sidebarIconButton} - ${size.sidebarIcon}) / 2)`,
  },
  // A group label as tall as its words and their room, as the reference's.
  label: { height: "auto" },
  labelWords: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  labelCount: { flexShrink: 0, fontVariantNumeric: "tabular-nums" },
  // Open, it points down; folded, the way of reading.
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    transform: {
      default: "none",
      ':is([aria-expanded="true"] > *)': "rotate(90deg)",
      ':is([aria-expanded="true"] > *):dir(rtl)': "rotate(-90deg)",
    },
    transitionProperty: "transform",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // The rows of a group that folds stand in from its label, as a tree:
  // room inside its panel, which stays its group's width, so a row's end
  // and its action stay inside the panel that folds it (which cuts off
  // what stands past it). Inline only: nothing shows while it is folded.
  under: { paddingInlineStart: space["3"] },
  // A row's action stands space-1 in from the row's end, as the
  // reference's dots do (Damsko's stands 2px in: registry gap of 24 Nov 2026).
  action: { insetInlineEnd: space["1"] },
  quiet: { fontWeight: font.weightNormal },
  more: {
    fontWeight: font.weightNormal,
    color: {
      default: colors.mutedForeground,
      [HOVER]: {
        default: colors.mutedForeground,
        ":hover": colors.sidebarForeground,
      },
    },
  },
  name: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // A row with a second line: as tall as its lines.
  words: { display: "flex", flexDirection: "column", minWidth: 0 },
  detail: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightNormal,
    letterSpacing: "normal",
    color: colors.mutedForeground,
  },
  end: {
    flexShrink: 0,
    marginInlineStart: "auto",
    fontSize: font.textXs,
    lineHeight: font.textSmLine,
    fontWeight: font.weightNormal,
    letterSpacing: "normal",
    fontVariantNumeric: "tabular-nums",
    color: colors.mutedForeground,
  },
  tall: { height: "auto", minHeight: size.sidebarMenuButtonHeight },
  empty: {
    margin: 0,
    paddingInline: `calc(${space["2"]} + ${size.sidebarRowInline})`,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.sidebarSecondaryForeground,
    textWrap: "pretty",
  },
  // The foot: a rule over the person, a gutter in from each side.
  foot: {
    marginBlockStart: `calc(-1 * ${space["2"]})`,
    paddingBlockStart: space["2"],
    borderBlockStartWidth: size.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: {
      default: colors.sidebarBorder,
      [media.forcedColors]: "CanvasText",
    },
  },
  // Renaming, the field over the row shows the words: the row's own stand hidden in their place,
  // and what stands at its end (its time, its Working mark) with them.
  renaming: { visibility: "hidden" },
  // The Working mark at a row's end, in an icon's room, never squeezed.
  working: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    marginInlineStart: "auto",
  },
  // On a row with dots, where the dots stand: it gives way to them while the row is pointed at,
  // holds focus or has its menu open; on a touch screen, where the dots always show, before them.
  workingSlot: {
    position: { default: "absolute", [COARSE]: "static" },
    insetBlock: 0,
    insetInlineEnd: space["1"],
    width: { default: size.sidebarIconButton, [COARSE]: "auto" },
    opacity: {
      default: 1,
      [stylex.when.ancestor(":hover", sidebarMenuItemMarker)]: {
        default: 1,
        [HOVER]: 0,
      },
      [stylex.when.ancestor(":focus-within", sidebarMenuItemMarker)]: 0,
      [stylex.when.ancestor(HELD_OPEN, sidebarMenuItemMarker)]: 0,
      [COARSE]: 1,
    },
    transitionProperty: "opacity",
    transitionDuration: {
      default: duration.hover,
      [media.reducedMotion]: "0s",
    },
    transitionTimingFunction: duration.ease,
  },
  // The rename field: the row's own box (its fill's start, end, height and corner) over the row's
  // link, which stays drawn under it, its words hidden; the row's type, so nothing jumps.
  field: {
    position: "absolute",
    inset: 0,
    boxSizing: "border-box",
    width: "100%",
    height: "100%",
    margin: 0,
    paddingInlineEnd: size.sidebarRowInline,
    borderWidth: 0,
    borderRadius: radius.sidebarRowRadius,
    backgroundColor: "transparent",
    color: colors.sidebarForeground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    letterSpacing: size.sidebarTracking,
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

/** The search of the person's chats, a round button in the head. */
const SearchButton = ({
  label,
  shortcut,
  onSearch,
}: {
  label: string;
  shortcut: string;
  onSearch: () => void;
}) => (
  <SidebarMenuButton
    aria-label={label}
    onClick={onSearch}
    size="icon"
    title={`${label} (${shortcut})`}
  >
    <Icon icon={SearchIcon} />
  </SidebarMenuButton>
);

// A row with a menu or a rename, as the reference's (#2503's
// grasp/sidebar/row-actions.tsx) on Damsko's parts: three dots at its end
// and the same entries on a right-click, a long press, the menu key or
// Shift+F10; renamed in place from the menu, by F2 or a double-click, by a
// field laid over the row where its words stood, which hides them. One
// text at every step: the row's own words while it rests, the field's while
// it is renamed.

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

/** Whether the row's own name is cut: its words run past their box. */
const isCut = (row: HTMLElement | null) => {
  const name = row?.querySelector<HTMLElement>("[data-row-name]");
  return (
    name !== null && name !== undefined && name.scrollWidth > name.clientWidth
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
      aria-label={label}
      data-row-rename=""
      defaultValue={name}
      onBlur={(event: FocusEvent<HTMLInputElement>) => {
        end(event.currentTarget.value, false);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.nativeEvent.isComposing) {
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          end(event.currentTarget.value, true);
        } else if (event.key === "Escape") {
          // Escape ends the rename only: it does not also close a sheet round it.
          event.preventDefault();
          event.stopPropagation();
          end(undefined, true);
        }
      }}
      ref={field}
      type="text"
      {...stylex.props(
        styles.field,
        fieldAt.at(
          `${String(at.start)}px`,
          `${String(at.top)}px`,
          `${String(at.bottom)}px`
        ),
        focusRingInset
      )}
    />
  );
};

/** A row's menu entries, as a Dropdown menu's or a Context menu's items. */
const MenuEntries = ({
  actions,
  menu,
  onChoose,
}: {
  actions: readonly RowAction[];
  menu: "dropdown" | "context";
  onChoose: (value: string) => void;
}) => {
  const Item = menu === "dropdown" ? DropdownMenuItem : ContextMenuItem;
  const Separator =
    menu === "dropdown" ? DropdownMenuSeparator : ContextMenuSeparator;
  return actions.map((action, index) =>
    action === "separator" ? (
      <Separator key={`separator-${String(index)}`} />
    ) : (
      <Item
        icon={action.icon}
        key={action.value}
        onSelect={() => {
          onChoose(action.value);
        }}
        variant={action.danger === true ? "destructive" : "default"}
      >
        {action.label}
      </Item>
    )
  );
};

/** A row's three dots at its end, shown while the row is pointed at, holds focus or has its menu open. */
const RowDots = ({
  row,
  actions,
  onChoose,
}: {
  row: SidebarRow;
  actions: readonly RowAction[];
  onChoose: (value: string) => void;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <SidebarMenuAction
        aria-label={row.actionsLabel ?? row.label}
        showOnHover
        style={styles.action}
      >
        <Icon icon={EllipsisIcon} />
      </SidebarMenuAction>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start">
      <MenuEntries actions={actions} menu="dropdown" onChoose={onChoose} />
    </DropdownMenuContent>
  </DropdownMenu>
);

/** Whether the row draws its name itself (its weight, a second line, a rename), not as Damsko's bare words. */
const ownName = (row: SidebarRow) =>
  row.detail !== undefined || row.quiet === true || row.onRename !== undefined;

/** Short words at a row's end ("2d"), quiet, and what a screen reader hears of them. */
const rowEnd = (row: SidebarRow, renaming: boolean): ReactNode =>
  row.end === undefined ? null : (
    <span key="end" {...stylex.props(styles.end, renaming && styles.renaming)}>
      <span aria-hidden="true">{row.end}</span>
      <span {...stylex.props(visuallyHidden)}>{row.endLabel ?? row.end}</span>
    </span>
  );

/** The Working mark while an agent works there: where the dots stand, on a row that has them. */
const workingMark = (
  row: SidebarRow,
  renaming: boolean,
  dots: boolean
): ReactNode =>
  row.working === true ? (
    <span
      aria-hidden="true"
      data-slot="sidebar-row-working"
      key="working-mark"
      {...stylex.props(
        styles.working,
        dots && styles.workingSlot,
        renaming && styles.renaming
      )}
    >
      <AgentIndicator />
    </span>
  ) : null;

/**
 * A row's own words and what stands with them: its icon, its name, a second
 * line, its end, its Working mark. A list, not an element of its own, so a
 * name given as bare words reaches the row as such: Damsko's row cuts it
 * with an ellipsis before what stands at its end, and shows it whole in a
 * tooltip while it is cut. A name the row draws itself (`ownName`) is
 * marked `data-row-name`: the rename field stands where it does, and the
 * row's own tooltip (`CutTip`) reads whether it is cut. Renaming, the name
 * and what stands at the end are hidden in their places under the field.
 */
const rowWords = (
  row: SidebarRow,
  renaming: boolean,
  dots: boolean
): ReactNode[] => [
  row.icon === undefined ? null : <Icon icon={row.icon} key="icon" />,
  ownName(row) ? null : row.label,
  ownName(row) && row.detail === undefined ? (
    <span
      data-row-name=""
      key="name"
      {...stylex.props(
        styles.name,
        row.quiet === true && styles.quiet,
        renaming && styles.renaming
      )}
    >
      {row.label}
    </span>
  ) : null,
  row.detail === undefined ? null : (
    <span
      key="words"
      {...stylex.props(styles.words, renaming && styles.renaming)}
    >
      <span
        data-row-name=""
        {...stylex.props(styles.name, row.quiet === true && styles.quiet)}
      >
        {row.label}
      </span>
      <span {...stylex.props(styles.detail)}>{row.detail}</span>
    </span>
  ),
  rowEnd(row, renaming),
  workingMark(row, renaming, dots),
  row.count !== undefined && row.count > 0 && row.countLabel !== undefined ? (
    <span key="count" {...stylex.props(visuallyHidden)}>
      {row.countLabel}
    </span>
  ) : null,
  row.working === true && row.workingLabel !== undefined ? (
    <span key="working" {...stylex.props(visuallyHidden)}>
      {row.workingLabel}
    </span>
  ) : null,
];

/** What a row's tooltip gives its trigger, less the description: the tooltip repeats the row's own name. */
const RowTrigger = ({
  draw,
  "aria-describedby": _repeats,
  ...trigger
}: {
  draw: (trigger: Record<string, unknown>) => ReactElement;
  "aria-describedby"?: string;
} & Record<string, unknown>) => draw(trigger);

/**
 * The row's whole name in a tooltip, only while it is cut, for a row that
 * draws its name itself (Damsko's row shows its own for bare words): at the
 * row's end, on a pointer's rest or on focus, never on a phone.
 */
const CutTip = ({
  label,
  draw,
}: {
  label: string;
  draw: (trigger: Record<string, unknown>) => ReactElement;
}) => {
  const { isMobile } = useSidebar();
  const node = useRef<HTMLElement | null>(null);
  return (
    <Tooltip
      disabled={isMobile}
      onOpenChange={(open, details) => {
        if (open && !isCut(node.current)) {
          details.cancel();
        }
      }}
    >
      <TooltipTrigger
        asChild
        ref={(element: HTMLElement | null) => {
          node.current = element;
        }}
      >
        <RowTrigger draw={draw} />
      </TooltipTrigger>
      <TooltipContent side="end">{label}</TooltipContent>
    </Tooltip>
  );
};

/** Whether an event came from the row's link, not its dots or its field. */
const fromLink = (event: Event): boolean =>
  event.target instanceof Element &&
  event.target.closest("[data-slot=sidebar-menu-button]") !== null;

/**
 * Renaming a row in place: where its name stood as it started, the way to
 * start it, and how it ends. A double-click on the row's link, or F2 on it,
 * starts it; listened to on the item round the link (the events come from
 * the link inside it), so the link stays as the caller drew it. Ending by a
 * key puts focus back on the link, once it is drawn again.
 */
const useRename = (row: SidebarRow) => {
  const itemRef = useRef<HTMLLIElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [at, setAt] = useState<NameAt>();
  const renames = row.onRename !== undefined;
  const linkOf = () =>
    itemRef.current?.querySelector<HTMLElement>(
      "[data-slot=sidebar-menu-button]"
    ) ?? null;
  const start = (): void => {
    const where = nameIn(linkOf());
    if (renames && where !== undefined) {
      setAt(where);
      setRenaming(true);
    }
  };
  const onDoubleClick = useEffectEvent((event: Event) => {
    if (fromLink(event)) {
      start();
    }
  });
  const onKey = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key === "F2" && fromLink(event)) {
      event.preventDefault();
      start();
    }
  });
  useEffect(() => {
    const box = itemRef.current;
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
  const done = (next: string | undefined, byKey: boolean): void => {
    setRenaming(false);
    const trimmed = next?.trim();
    if (trimmed !== undefined && trimmed !== "" && trimmed !== row.label) {
      row.onRename?.(trimmed);
      if (row.renamedLabel !== undefined) {
        announce(row.renamedLabel(trimmed));
      }
    }
    if (byKey) {
      requestAnimationFrame(() => {
        linkOf()?.focus();
      });
    }
  };
  return {
    itemRef,
    renames,
    renaming,
    at: renaming ? at : undefined,
    start,
    onDone: done,
    linkOf,
  };
};

/** The row's link, or its button: its words, and what the rename gives it. */
const RowButton = ({
  row,
  words,
  trigger,
  describedBy,
  inert,
}: {
  row: SidebarRow;
  words: ReactNode[];
  /** The tooltip trigger's props (CutTip), when the row has its own. */
  trigger: Record<string, unknown>;
  describedBy: string | undefined;
  inert: boolean;
}) => {
  const tall = row.detail === undefined ? undefined : styles.tall;
  const own = {
    "aria-describedby": describedBy,
    // While it is renamed: drawn under the field, out of reach.
    inert: inert || undefined,
  };
  return row.render === undefined ? (
    <SidebarMenuButton
      {...trigger}
      {...own}
      isActive={row.current === true}
      onClick={(event) => {
        row.onClick?.(event);
      }}
      style={tall}
    >
      {words}
    </SidebarMenuButton>
  ) : (
    <SidebarMenuButton
      {...trigger}
      {...own}
      asChild
      isActive={row.current === true}
      style={tall}
    >
      {row.render({ children: words })}
    </SidebarMenuButton>
  );
};

/** A row's sub rows: the pages within it. */
const SubRows = ({ rows }: { rows: readonly SidebarSubRow[] | undefined }) =>
  rows === undefined || rows.length === 0 ? null : (
    <SidebarMenuSub>
      {rows.map((sub) => (
        <SidebarMenuSubItem key={sub.id ?? sub.label}>
          {sub.render === undefined ? null : (
            <SidebarMenuSubButton asChild isActive={sub.current === true}>
              {sub.render({ children: sub.label })}
            </SidebarMenuSubButton>
          )}
        </SidebarMenuSubItem>
      ))}
    </SidebarMenuSub>
  );

const Row = ({ row }: { row: SidebarRow }) => {
  const hint = useId();
  const { itemRef, renames, renaming, at, start, onDone, linkOf } =
    useRename(row);
  const actions = row.actions ?? [];
  const hasActions = actions.length > 0;
  const choose = (value: string): void => {
    if (value === "rename" && renames) {
      start();
      return;
    }
    row.onAction?.(value);
  };
  const words = rowWords(row, renaming, hasActions);
  const describedBy =
    renames && !renaming && row.renameHint !== undefined ? hint : undefined;
  const button = (trigger: Record<string, unknown>) => (
    <RowButton
      describedBy={describedBy}
      inert={renaming}
      row={row}
      trigger={trigger}
      words={words}
    />
  );
  const held = (
    <>
      {ownName(row) ? <CutTip draw={button} label={row.label} /> : button({})}
      {at === undefined ? null : (
        <RenameField
          at={at}
          label={row.renameLabel ?? row.label}
          name={row.label}
          onDone={onDone}
        />
      )}
      {describedBy === undefined ? null : (
        <span id={hint} {...stylex.props(visuallyHidden)}>
          {row.renameHint}
        </span>
      )}
      {row.count !== undefined && row.count > 0 && !renaming ? (
        <SidebarMenuBadge>
          <span aria-hidden="true">{row.count}</span>
        </SidebarMenuBadge>
      ) : null}
      {hasActions && !renaming ? (
        <RowDots actions={actions} onChoose={choose} row={row} />
      ) : null}
    </>
  );
  return (
    <SidebarMenuItem ref={itemRef}>
      {/* The row's link is what the keys reach, so the area takes no tab stop; the menu gives focus back to the link, or to nobody when its choice starts renaming (the field takes it). */}
      {hasActions ? (
        <ContextMenu>
          <ContextMenuTrigger aria-label={row.label} tabStop={false}>
            {held}
          </ContextMenuTrigger>
          <ContextMenuContent finalFocus={renaming ? "none" : linkOf}>
            <MenuEntries actions={actions} menu="context" onChoose={choose} />
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        held
      )}
      <SubRows rows={row.rows} />
    </SidebarMenuItem>
  );
};

const MoreRow = ({ more }: { more: SidebarMore }) => {
  const words = (
    <span {...stylex.props(styles.name, styles.more)}>{more.label}</span>
  );
  return (
    <SidebarMenuItem>
      {more.render === undefined ? (
        <SidebarMenuButton
          onClick={() => {
            more.onClick?.();
          }}
        >
          {words}
        </SidebarMenuButton>
      ) : (
        <SidebarMenuButton asChild>
          {more.render({ children: words })}
        </SidebarMenuButton>
      )}
    </SidebarMenuItem>
  );
};

const Rows = ({
  group,
  labelledBy,
}: {
  group: SidebarGroupEntry;
  labelledBy?: string;
}) =>
  group.content ?? (
    <SidebarMenu aria-labelledby={labelledBy}>
      {group.rows.map((row) => (
        <Row key={row.id ?? row.label} row={row} />
      ))}
      {group.more === undefined ? null : <MoreRow more={group.more} />}
    </SidebarMenu>
  );

const Group = ({ group }: { group: SidebarGroupEntry }) => {
  const labelId = useId();
  const { label } = group;
  if (label === undefined) {
    return (
      <SidebarGroup>
        <Rows group={group} />
      </SidebarGroup>
    );
  }
  const words = (
    <>
      <span {...stylex.props(styles.labelWords)}>{label}</span>
      {group.count === undefined ? null : (
        <span {...stylex.props(styles.labelCount)}>{group.count}</span>
      )}
    </>
  );
  if (group.collapsible !== true) {
    return (
      <SidebarGroup>
        <SidebarGroupLabel id={labelId} style={styles.label}>
          {words}
        </SidebarGroupLabel>
        <Rows group={group} labelledBy={labelId} />
      </SidebarGroup>
    );
  }
  return (
    <SidebarCollapsible name={group.id ?? label}>
      <SidebarGroup>
        <CollapsibleTrigger asChild>
          <SidebarGroupLabel asChild style={styles.label}>
            <button id={labelId} type="button">
              {words}
              <span aria-hidden="true" {...stylex.props(styles.chevron)}>
                <Icon icon={ChevronRightIcon} />
              </span>
            </button>
          </SidebarGroupLabel>
        </CollapsibleTrigger>
        {/* The panel alone, without the room above and below a panel's words: the rows follow their label at the rows' own gap. */}
        <CollapsibleContent asChild>
          <div {...stylex.props(group.content === undefined && styles.under)}>
            <Rows group={group} labelledBy={labelId} />
          </div>
        </CollapsibleContent>
      </SidebarGroup>
    </SidebarCollapsible>
  );
};

/** The rows, in their groups; or one quiet sentence when there are none. */
const Nav = ({
  label,
  groups,
  empty,
}: {
  label: string;
  groups: readonly SidebarGroupEntry[];
  empty?: string;
}) => (
  <SidebarContent aria-label={label}>
    {groups.length === 0 && empty !== undefined ? (
      <p {...stylex.props(styles.empty)}>{empty}</p>
    ) : null}
    {groups.map((group, index) => (
      <Group group={group} key={group.id ?? group.label ?? index} />
    ))}
  </SidebarContent>
);

/** A level of an area: Back and its name, its views, its rows. */
const SectionLevel = ({ section }: { section: SidebarSection }) => {
  const viewsId = useId();
  return (
    <SidebarLevel value={section.id}>
      <LevelHead
        back={section.back.render}
        backLabel={section.back.label}
        home={section.home}
        homeCurrent={section.homeCurrent}
        icon={section.icon}
        mark={section.mark}
        title={section.title}
      />
      {section.views === undefined ? null : (
        <SidebarSwitch
          id={viewsId}
          label={section.views.label}
          onChoose={(next) => {
            section.views?.onChange(next);
          }}
          panel={false}
          tabs={section.views.tabs}
          value={section.views.value}
        />
      )}
      <Nav groups={section.groups} label={section.navLabel ?? section.title} />
    </SidebarLevel>
  );
};

/** Every prop the product's sidebar takes. */
export interface FrameSidebarProps {
  /** What its landmark is called. */
  "aria-label": string;
  /** Grasp's mark, at the head's start. */
  mark: ReactNode;
  /** The search of the chats, at the head's end; none without it. */
  search?: { label: string; shortcut: string; onSearch: () => void };
  foldLabel: string;
  closeLabel: string;
  /** The main list's rows, in groups. */
  groups: readonly SidebarGroupEntry[];
  /** What the main list's rows are, as a landmark. */
  navLabel: string;
  /** One quiet sentence where the rows would be, when there are none. */
  empty?: string;
  /** The main list's views, under the head; the host gives each view's rows as `groups`. */
  tabs?: readonly SidebarTab[];
  tab?: string;
  onTabChange?: (value: string) => void;
  tabsLabel?: string;
  /** The area the person is in: its level takes the main list's place. */
  section?: SidebarSection;
  /** The person, at the foot. */
  profile: ReactNode;
}

/**
 * The sidebar: Damsko's Sidebar on its ground beside the page's card, a
 * sheet on a narrow window, folded off the side whole.
 */
export const FrameSidebar = ({
  "aria-label": label,
  mark,
  search,
  foldLabel,
  closeLabel,
  groups,
  navLabel,
  empty,
  tabs,
  tab,
  onTabChange,
  tabsLabel,
  section,
  profile,
}: FrameSidebarProps) => {
  const { isMobile, setOpenMobile } = useSidebar();
  const switchId = useId();
  // The last area's level stays (unseen) after the person leaves it, so the
  // main list comes back in from the way they went.
  const [last, setLast] = useState(section);
  if (section !== undefined && section !== last) {
    setLast(section);
  }
  const shownSection = section ?? last;
  const chosen = tab ?? tabs?.[0]?.value ?? "";
  const rows = <Nav empty={empty} groups={groups} label={navLabel} />;
  return (
    <Sidebar aria-label={label} variant="inset">
      <SidebarHeader>
        <div
          {...stylex.props(
            styles.head,
            isMobile &&
              (section === undefined
                ? styles.headInSheet
                : styles.headInSheetLevel)
          )}
        >
          <span {...stylex.props(styles.mark)}>{mark}</span>
          <div {...stylex.props(styles.tools)}>
            {search === undefined ? null : (
              <SearchButton
                label={search.label}
                onSearch={() => {
                  // The search opens over the page: the phone's sheet goes first.
                  setOpenMobile(false);
                  search.onSearch();
                }}
                shortcut={search.shortcut}
              />
            )}
            {isMobile ? (
              <SidebarMenuButton
                aria-label={closeLabel}
                onClick={() => {
                  setOpenMobile(false);
                }}
                size="icon"
              >
                <Icon icon={XIcon} />
              </SidebarMenuButton>
            ) : (
              <SidebarTrigger aria-label={foldLabel} />
            )}
          </div>
        </div>
      </SidebarHeader>
      <SidebarLevels value={section?.id ?? "main"}>
        <SidebarLevel value="main">
          {tabs === undefined || tabs.length === 0 ? (
            rows
          ) : (
            <>
              <SidebarSwitch
                id={switchId}
                label={tabsLabel ?? ""}
                onChoose={(next) => {
                  onTabChange?.(next);
                }}
                tabs={tabs}
                value={chosen}
              />
              <SwitchPanel id={switchId} value={chosen}>
                {rows}
              </SwitchPanel>
            </>
          )}
        </SidebarLevel>
        {shownSection === undefined ? null : (
          <SectionLevel key={shownSection.id} section={shownSection} />
        )}
      </SidebarLevels>
      <SidebarFooter>
        <div data-slot="sidebar-foot" {...stylex.props(styles.foot)}>
          {profile}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
};
