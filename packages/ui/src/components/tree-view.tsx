// TreeView: nested items that open and close, such as folders and files or the pages of a section,
// on UI SDK's Tree. The rows follow Select's items and Sidebar's rows: the height of
// a small control, each level a step in, a chevron that turns as a branch opens, an icon per item,
// the words. One item or several can be chosen, a branch's children can load when it first opens,
// and Enter runs an item's action. A row can end in a badge (a count, a mark) and in its own buttons
// (`actions`), and a node with `selectable: false` opens without being chosen.
//
//   <TreeView aria-label="Files" items={[{ value: "reports", label: "Reports", icon: FolderIcon,
//     children: [{ value: "reports/summary", label: "Summary", icon: FileIcon }] }]} />
//
// The keys are the tree pattern's: Up and Down move, Right opens a branch or goes into it, Left
// closes it or goes up to its parent (mirrored right to left), Home and End jump, a letter finds the
// next item that starts with it, Enter runs, Space chooses, `*` opens every branch beside the
// focused one. A screen reader hears each item's level, whether it is open, and whether it is chosen.
// A row's buttons take no part in those keys, nor in the row's name. They are drawn only for the row
// under the pointer and the row that holds focus (on a touch screen, the rows in view), so a tree of
// thousands of rows mounts no buttons; and only the focused row's are in the Tab order, one Tab
// from it.
"use client";

import * as stylex from "@stylexjs/stylex";
import { renderElement } from "@ui-sdk/react/primitive";
import {
  Tree as TreePrimitive,
  TreeGroup as GroupPrimitive,
  TreeItem as ItemPrimitive,
  TreeItemIndicator as IndicatorPrimitive,
  TreeItemLabel as LabelPrimitive,
} from "@ui-sdk/react/tree";
import type { TreeItemData } from "@ui-sdk/react/tree";
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactElement,
  ReactNode,
} from "react";

import { useI18n } from "../lib/i18n";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  Icon,
  SearchIcon,
} from "../lib/icons";
import type { IconData } from "../lib/icons";
import { listStyles } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import { className } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupClear,
  InputGroupInput,
} from "./input-group";
import { Spinner } from "./spinner";

/** One item of a tree. */
export interface TreeNode {
  /** Names the item: unique in the tree, and what is chosen and expanded. */
  value: string;
  /** Its words: a name, short. Typeahead matches them. */
  label: string;
  /** An icon before the words, such as a folder or a file. */
  icon?: IconData;
  /** Its children: a branch. An empty list is a branch whose children load when it opens. */
  children?: TreeNode[];
  /** It cannot be chosen, opened or run; it still takes focus, so a screen reader finds it. */
  disabled?: boolean;
  /**
   * Whether it can be chosen. `false` for one that only opens and runs, such as a folder in a tree
   * where only files are chosen: a press, Space and Enter leave the choice as it was.
   * @default true
   */
  selectable?: boolean;
  /** What stands at the row's end, after its words: a count, a mark such as sensitive or read-only. */
  badge?: ReactNode;
  /**
   * The row's buttons, at its end: small icon Buttons, each with its own name ("Rename notes.md").
   * They are drawn while the row is pointed at or holds focus (on a touch screen, while it is in
   * view), after its words; Tab from the focused row goes to them, and no other row's are in the Tab
   * order. A press or a key on one is the button's: the row is not chosen, opened or moved from. They
   * are no part of the row's name.
   */
  actions?: ReactNode;
  /**
   * Where the row leads: the row is then a link, opened by a press, Enter, a middle click or in a
   * new tab. The keys and typeahead stay the tree's.
   */
  href?: string;
  /**
   * The element the row's link is drawn as, for a router's link (`render: <Link to="/notes" />`): it
   * takes the row's look, its words and `aria-current` for the open one (`current`), and keeps its
   * own props. Without it, an `<a href>`. Leave `href` out when the router's link carries the address.
   */
  render?: ReactElement<Record<string, unknown>>;
}

/** Every prop a TreeView takes. */
export interface TreeViewProps {
  /** The items, nested by `children`. */
  items: TreeNode[];
  /** The tree's name for a screen reader, a voice command and an agent ("Files"). */
  "aria-label"?: string;
  /**
   * How many items can be chosen: `single`, `multiple` (Shift and the arrows, or Ctrl or Command
   * with A, choose several), or `none` for a tree that only opens and runs.
   * @default "single"
   */
  selectionMode?: "none" | "single" | "multiple";
  /** The chosen item, or items with `multiple`. Pass it with `onValueChange` to hold it yourself. */
  value?: string | string[] | null;
  /** The chosen item, or items, it starts with. */
  defaultValue?: string | string[] | null;
  /** Runs when the choice changes. */
  onValueChange?: (value: string | string[] | null) => void;
  /** The open branches. Pass it with `onExpandedChange` to hold them yourself. */
  expandedValue?: string[];
  /** The branches open at first. */
  defaultExpandedValue?: string[];
  /** Runs when a branch opens or closes. */
  onExpandedChange?: (expanded: string[]) => void;
  /**
   * Loads a branch's children the first time it opens with none: return them. While it loads
   * a spinner takes the chevron's place; if it fails, a mark does, and the next open tries again.
   */
  loadChildren?: (
    value: string,
    details: { signal: AbortSignal }
  ) => Promise<TreeNode[]>;
  /** Runs when an item is pressed or Enter is pressed on it: open a file, go to a page. */
  onAction?: (value: string) => unknown;
  /** The item for the page that is open, in a tree of pages: it is marked (`aria-current`), and its branches open. */
  current?: string | null;
  /**
   * Whether a press on a branch's row opens or closes it, as well as its chevron.
   * @default true
   */
  expandOnPress?: boolean;
  /**
   * The tree guide on nested items, as Sidebar's nested rows: a stem down from each open branch's
   * chevron and a rounded elbow into each of its items, stopping at the last.
   * @default false
   */
  showIndentGuides?: boolean;
  /** Nothing can be chosen, opened or run. */
  disabled?: boolean;
  /**
   * A filter field over the tree: what is typed narrows the items to those whose words hold it, each
   * with the branches above it, opened; the matched words are marked. Emptied, the tree's folds come
   * back as they were. Escape clears it, and Down moves into the tree. A branch whose children have
   * not loaded yet is matched by its own words only.
   * @default false
   */
  filterable?: boolean;
  /** The filter's words. Pass it with `onFilterChange` to hold them yourself. */
  filter?: string;
  /**
   * The filter's words at first.
   * @default ""
   */
  defaultFilter?: string;
  /** Runs as the filter's words change. */
  onFilterChange?: (filter: string) => void;
}

// ---- The look --------------------------------------------------------------------------------------

const HOVER = media.hover;
const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;
const chosen = ":is([data-selected], [data-current])";
const LEAD = `calc(${space.treeViewRowPadding} + (var(--tree-level, 1) - 1) * ${space.treeViewIndent})`;

// The tree guide's measures (`showIndentGuides`), the Sidebar's own: a row's middle; the stem's
// column, under the parent's chevron; the elbow, a space-3 round unless the indent is too short.
const ROW_MIDDLE = `calc(${size.treeViewRow} / 2)`;
const ROW_MIDDLE_TOUCH = `calc(${size.treeViewRowTouch} / 2)`;
const GUIDE_X = `calc(${space.treeViewRowPadding} + (var(--tree-level, 2) - 2) * ${space.treeViewIndent} + ${size.iconSm} / 2 - ${size.treeViewGuide} / 2)`;
const GUIDE_ELBOW = `min(${space["3"]}, calc(${space.treeViewIndent} - ${space["1"]}))`;
const guideLine = { default: colors.border, [FORCED]: "GrayText" };

const styles = stylex.create({
  // Focus on an item, which holds its children as well as its row: the keyboard's ring on the row
  // only, inside it, so it never goes round the children.
  focusRow: {
    outline: {
      default: "none",
      ":is([data-slot=tree-view-item]:focus-visible > *)": `${size.ringWidth} solid ${colors.ring}`,
    },
    outlineOffset: `calc(-1 * ${size.ringWidth})`,
  },
  tree: {
    display: "flex",
    flexDirection: "column",
    gap: size.treeViewRowGap,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    margin: 0,
    padding: 0,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.treeViewForeground,
    listStyle: "none",
  },
  // An item holds its row and, when it is a branch, its group. Focus is on the item; its row
  // shows it, as the item also holds its children.
  item: {
    display: "flex",
    flexDirection: "column",
    gap: size.treeViewRowGap,
    minWidth: 0,
    outline: "none",
  },
  group: {
    display: "flex",
    flexDirection: "column",
    gap: size.treeViewRowGap,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // A row: a step in per level, the chevron, the icon, the words.
  row: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "flex",
    alignItems: "center",
    gap: space.treeViewIconGap,
    boxSizing: "border-box",
    minWidth: 0,
    minHeight: { default: size.treeViewRow, [COARSE]: size.treeViewRowTouch },
    paddingInlineStart: LEAD,
    paddingInlineEnd: space.treeViewRowPadding,
    borderRadius: `min(${radius.lg}, calc(${size.treeViewRow} / 2))`,
    cornerShape: radius.shape,
    letterSpacing: size.treeViewTracking,
    // Chosen or current: a fill, which forced colours drop, so the system's highlight there.
    color: {
      default: colors.treeViewForeground,
      ":hover:not([data-selected], [data-current])": {
        default: null,
        [HOVER]: colors.treeViewForegroundHover,
      },
      [chosen]: {
        default: colors.treeViewForegroundSelected,
        [FORCED]: "HighlightText",
      },
    },
    // Three fills, each its own, so a row under a pointer, a chosen row and the current page are
    // told apart: the pointer's quiet fill, the wash of a chosen row, and for the current page a
    // stronger fill under heavier words.
    backgroundColor: {
      default: "transparent",
      // Hover never covers the chosen fill.
      ":hover:not([data-selected], [data-current])": {
        default: null,
        [HOVER]: colors.treeViewBgHover,
      },
      ":is([data-selected])": {
        default: colors.treeViewBgSelected,
        [FORCED]: "Highlight",
      },
      ":is([data-current])": {
        default: colors.treeViewBgActive,
        [FORCED]: "Highlight",
      },
    },
    fontWeight: {
      default: font.treeViewWeight,
      ":is([data-current])": font.treeViewWeightActive,
    },
    cursor: { default: "pointer", ":is([data-disabled])": "default" },
    opacity: { default: 1, ":is([data-disabled])": size.opacityDisabled },
    userSelect: "none",
    transitionProperty: "color, background-color",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
  },
  // The chevron: turns a quarter as its branch opens; at once with reduced motion.
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    color: colors.treeViewIcon,
    transform: { default: "none", ":is([data-expanded])": "rotate(90deg)" },
    transitionProperty: "transform",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  // A leaf has no chevron: the room it would take keeps its icon in line with its siblings'.
  spacer: {
    display: "inline-block",
    flexShrink: 0,
    width: size.iconSm,
  },
  icon: {
    display: "inline-flex",
    flexShrink: 0,
    color: colors.treeViewIcon,
  },
  failed: {
    color: colors.destructive,
  },
  words: {
    minWidth: 0,
    overflowWrap: "anywhere",
    paddingBlock: space["1"],
  },
  // A row that is a link (a node's `href` or `render`): the link fills the row from the icon to its
  // end, so a press anywhere there is the link's, and looks as the row's words do.
  link: {
    display: "flex",
    flexGrow: 1,
    alignItems: "center",
    alignSelf: "stretch",
    gap: space.treeViewIconGap,
    minWidth: 0,
    color: "inherit",
    textDecoration: "none",
    outline: "none",
  },
  // At the row's end: a count, a mark. Quiet, never squeezed, after the words.
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    flexShrink: 0,
    marginInlineStart: "auto",
    color: colors.mutedForeground,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    // Its own weight and spacing, whatever the row's words take.
    fontWeight: font.weightNormal,
    letterSpacing: "normal",
    fontVariantNumeric: "tabular-nums",
  },
  // The row's buttons, after its words and its badge.
  actions: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    flexShrink: 0,
  },
  // With no badge before them the buttons take the row's end themselves.
  actionsAtEnd: { marginInlineStart: "auto" },
  // A tree with its filter: the field over the tree, a step apart.
  filtered: {
    display: "grid",
    gap: space["2"],
    minWidth: 0,
  },
  // Nothing matches: one quiet line in the tree's place.
  none: {
    margin: 0,
    paddingBlock: space["1"],
    paddingInline: space["2"],
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  // The tree guide on a nested item, over the rows' fills: the stem from the gap above down to the
  // elbow, the elbow into the row, and the stem on past the item to its next sibling, which the last
  // item has not.
  guided: { position: "relative" },
  guideStem: {
    position: "absolute",
    zIndex: 1,
    insetInlineStart: GUIDE_X,
    insetBlockStart: `calc(-1 * ${size.treeViewRowGap})`,
    height: {
      default: `calc(${size.treeViewRowGap} + ${ROW_MIDDLE} - ${GUIDE_ELBOW})`,
      [COARSE]: `calc(${size.treeViewRowGap} + ${ROW_MIDDLE_TOUCH} - ${GUIDE_ELBOW})`,
    },
    width: 0,
    borderInlineStartWidth: size.treeViewGuide,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: guideLine,
    pointerEvents: "none",
  },
  guideStemOn: {
    position: "absolute",
    zIndex: 1,
    insetInlineStart: GUIDE_X,
    insetBlockStart: {
      default: `calc(${ROW_MIDDLE} - ${GUIDE_ELBOW})`,
      [COARSE]: `calc(${ROW_MIDDLE_TOUCH} - ${GUIDE_ELBOW})`,
    },
    insetBlockEnd: 0,
    width: 0,
    borderInlineStartWidth: size.treeViewGuide,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: guideLine,
    pointerEvents: "none",
  },
  // The elbow runs past the chevron column to a step before the item's icon. A child's chevron
  // stands half an indent from its parent's: too near for an elbow, so the elbow runs on under it,
  // the chevron standing on the line.
  guideBranch: {
    position: "absolute",
    zIndex: 1,
    insetInlineStart: GUIDE_X,
    insetBlockStart: {
      default: `calc(${ROW_MIDDLE} - ${GUIDE_ELBOW})`,
      [COARSE]: `calc(${ROW_MIDDLE_TOUCH} - ${GUIDE_ELBOW})`,
    },
    boxSizing: "border-box",
    height: GUIDE_ELBOW,
    width: `calc(${space.treeViewIndent} + ${size.iconSm} / 2 + ${space.treeViewIconGap} - ${space["1"]} + ${size.treeViewGuide} / 2)`,
    borderInlineStartWidth: size.treeViewGuide,
    borderBlockEndWidth: size.treeViewGuide,
    borderStyle: "solid",
    borderColor: guideLine,
    borderBlockStartColor: "transparent",
    borderInlineEndColor: "transparent",
    borderEndStartRadius: GUIDE_ELBOW,
    pointerEvents: "none",
  },
  // Where the stem carries on, the elbow leaves the stem's column to it: one layer of line there.
  guideBranchCut: {
    clipPath: {
      default: `inset(0 0 0 ${size.treeViewGuide})`,
      ":dir(rtl)": `inset(0 ${size.treeViewGuide} 0 0)`,
    },
  },
});

// ---- The data ---------------------------------------------------------------------------------------

/** UI SDK's items, from ours: the whole shape, for the keys and typeahead. */
const toData = (nodes: TreeNode[]): TreeItemData[] =>
  nodes.map((node) => ({
    value: node.value,
    label: node.label,
    disabled: node.disabled,
    ...(node.children ? { children: toData(node.children) } : {}),
  }));

/**
 * The nodes with the children that loaded put in. Only a branch still empty in `items` takes
 * them: once the caller gives a branch children of its own, or drops it, those win.
 */
const withLoaded = (
  nodes: TreeNode[],
  loaded: Record<string, TreeNode[]>
): TreeNode[] =>
  nodes.map((node) => {
    if (!node.children) {
      return node;
    }
    if (node.children.length === 0 && node.value in loaded) {
      return {
        ...node,
        children: withLoaded(loaded[node.value] ?? [], loaded),
      };
    }
    return { ...node, children: withLoaded(node.children, loaded) };
  });

/** The values that cannot be chosen (`selectable: false`). */
const fixedValues = (nodes: TreeNode[]): string[] =>
  nodes.flatMap((node) => [
    ...(node.selectable === false ? [node.value] : []),
    ...fixedValues(node.children ?? []),
  ]);

type TreeValue = string | string[] | null;

/**
 * A choice the tree asks for, without what cannot be chosen; undefined when nothing of it is left,
 * so a press on a folder that only opens leaves the choice as it was.
 */
const choosable = (
  next: TreeValue,
  fixed: Set<string>
): TreeValue | undefined => {
  if (Array.isArray(next)) {
    const kept = next.filter((value) => !fixed.has(value));
    return kept.length === 0 && next.length > 0 ? undefined : kept;
  }
  return next !== null && fixed.has(next) ? undefined : next;
};

/** Whether words hold the filter, whatever the case. */
const holds = (words: string, query: string) =>
  words.toLocaleLowerCase().includes(query);

/**
 * The nodes the filter keeps: each one whose words hold it, with its children as they are, and each
 * branch above one, with only the children that lead to one.
 */
const narrowed = (nodes: TreeNode[], query: string): TreeNode[] =>
  nodes.flatMap((node) => {
    if (holds(node.label, query)) {
      return [node];
    }
    const kept = node.children ? narrowed(node.children, query) : [];
    return kept.length > 0 ? [{ ...node, children: kept }] : [];
  });

/** The branches above every match: they open while the filter stands. */
const opened = (nodes: TreeNode[], query: string): string[] =>
  nodes.flatMap((node) => {
    if (!node.children || holds(node.label, query)) {
      return [];
    }
    const below = opened(node.children, query);
    return node.children.some((child) => holds(child.label, query)) ||
      below.length > 0
      ? [node.value, ...below]
      : below;
  });

/** Words with each place they hold the filter marked, as Command marks its matches. */
const Marked = ({ words, query }: { words: string; query: string }) => {
  if (query === "") {
    return words;
  }
  const lower = words.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (
    let at = lower.indexOf(query);
    at !== -1;
    at = lower.indexOf(query, at + query.length)
  ) {
    parts.push(
      words.slice(from, at),
      // A match has no id of its own; its place in the words is its key.
      <mark key={at} {...stylex.props(listStyles.match)}>
        {words.slice(at, at + query.length)}
      </mark>
    );
    from = at + query.length;
  }
  parts.push(words.slice(from));
  return parts;
};

// ---- The rows ---------------------------------------------------------------------------------------

/** Whether a node's row is a link. */
const isLinked = (node: TreeNode) =>
  (node.href !== undefined && node.href !== "") || node.render !== undefined;

/** Whether a node's slot holds something to draw. */
const filled = (slot: ReactNode) =>
  slot !== undefined && slot !== null && slot !== false;

// ---- A row's buttons -------------------------------------------------------------------------------

/**
 * Which rows draw their buttons: the one under a pointer, the one that holds focus and, on a touch
 * screen, the ones in view. Each row asks for itself, so a change draws two rows anew, not the tree.
 */
const createShown = () => {
  let hovered: string | null = null;
  let focused: string | null = null;
  let seen: ReadonlySet<string> = new Set();
  const asked = new Set<() => void>();
  const tell = () => {
    for (const ask of asked) {
      ask();
    }
  };
  return {
    subscribe: (ask: () => void) => {
      asked.add(ask);
      return () => {
        asked.delete(ask);
      };
    },
    shows: (value: string) =>
      value === hovered || value === focused || seen.has(value),
    hover: (value: string | null) => {
      if (value !== hovered) {
        hovered = value;
        tell();
      }
    },
    focus: (value: string | null) => {
      if (value !== focused) {
        focused = value;
        tell();
      }
    },
    see: (values: ReadonlySet<string>) => {
      seen = values;
      tell();
    },
  };
};

const ShownContext = createContext(createShown());

/** The item an event came from: its element and its value. */
const itemOf = (target: EventTarget | null) => {
  const item =
    target instanceof Element ? target.closest("[role=treeitem]") : null;
  return item instanceof HTMLElement
    ? { item, value: item.dataset.value ?? null }
    : { item: null, value: null };
};

/** What takes focus among a row's buttons. */
const STOPS =
  "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]";

const stopsOf = (actions: Element | null | undefined) => [
  ...(actions?.querySelectorAll<HTMLElement>(STOPS) ?? []),
];

/** An item's own buttons, not those of the items nested in it. */
const actionsOf = (item: Element | null) =>
  item?.querySelector(":scope > * > [data-tree-view-actions]");

/**
 * Tab from the focused row goes to its first button: its buttons hold no Tab stop of their own, so
 * no other row's are walked on the way out of the tree.
 */
const tabToActions = (event: KeyboardEvent<HTMLElement>) => {
  const { item } = itemOf(event.target);
  if (event.key !== "Tab" || event.shiftKey || event.target !== item) {
    return;
  }
  const [first] = stopsOf(actionsOf(item));
  if (first) {
    event.preventDefault();
    first.focus();
  }
};

/**
 * A press or a key on a row's button is the button's: the row is not chosen, opened or moved from.
 * Tab goes on to the row's next button; from the last, out of the tree.
 */
const keep = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
  event.stopPropagation();
  if (!("key" in event) || event.key !== "Tab" || event.shiftKey) {
    return;
  }
  const stops = stopsOf(event.currentTarget);
  const at =
    event.target instanceof HTMLElement ? stops.indexOf(event.target) : -1;
  const next = at === -1 ? undefined : stops[at + 1];
  if (next) {
    event.preventDefault();
    next.focus();
  }
};

/**
 * Where focus goes when the row whose button held it is taken out: the row after it, else the one
 * before, which is its parent when it was the only one.
 */
const rowBeside = (item: Element) => {
  const rows = [
    ...(item
      .closest("[role=tree]")
      ?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? []),
  ];
  const at = rows.findIndex((row) => row.isSameNode(item));
  return rows.slice(at + 1).find((row) => !item.contains(row)) ?? rows[at - 1];
};

/**
 * A row's buttons, drawn while the tree says so (createShown). None is a Tab stop: Tab reaches them
 * from their own row (tabToActions, keep). Pressing one that takes its row out of the tree leaves
 * focus on the row beside it.
 */
const RowActions = ({
  value,
  atEnd,
  children,
}: {
  value: string;
  atEnd: boolean;
  children: ReactNode;
}) => {
  const shown = use(ShownContext);
  const drawn = useSyncExternalStore(
    shown.subscribe,
    () => shown.shows(value),
    () => false
  );
  const span = useRef<HTMLSpanElement>(null);
  // After every draw, since the buttons are the caller's and may change.
  useLayoutEffect(() => {
    for (const stop of stopsOf(span.current)) {
      stop.tabIndex = -1;
    }
  });
  if (!drawn) {
    return null;
  }
  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- it only keeps its buttons' presses and keys from the row; the buttons are the controls
    <span
      ref={(element) => {
        span.current = element;
        return () => {
          span.current = null;
          const item = element?.closest("[role=treeitem]");
          if (!item || element?.contains(document.activeElement) !== true) {
            return;
          }
          // Focus was on one of these buttons as they went. If the row went with them, the row
          // beside it takes focus; if it stayed, the row itself.
          const beside = rowBeside(item);
          queueMicrotask(() => {
            const to = item.isConnected ? item : beside;
            if (to instanceof HTMLElement && to.isConnected) {
              to.focus();
            }
          });
        };
      }}
      data-tree-view-actions=""
      onClick={keep}
      onKeyDown={keep}
      {...stylex.props(styles.actions, atEnd && styles.actionsAtEnd)}
    >
      {children}
    </span>
  );
};

/**
 * The row's icon, words and badge, in a link when the node leads somewhere, then its buttons, which
 * a link cannot hold. The link takes no Tab stop of its own: the tree's item holds focus, and Enter
 * on it follows the link (TreeView, below).
 */
const RowInside = ({
  node,
  current,
  query,
  nameId,
}: {
  node: TreeNode;
  current: boolean;
  query: string;
  /** The id of the row's words, which name its item; its badge takes `${nameId}-badge`. */
  nameId: string;
}) => {
  const inside = (
    <>
      {node.icon && (
        <span aria-hidden="true" {...stylex.props(styles.icon)}>
          <Icon icon={node.icon} />
        </span>
      )}
      <span id={nameId} {...stylex.props(styles.words)}>
        <Marked words={node.label} query={query} />
      </span>
      {filled(node.badge) && (
        <span id={`${nameId}-badge`} {...stylex.props(styles.badge)}>
          {node.badge}
        </span>
      )}
    </>
  );
  return (
    <>
      {isLinked(node)
        ? renderElement(
            "a",
            {
              href: node.href,
              tabIndex: -1,
              "data-tree-view-link": "",
              "aria-current": current ? "page" : undefined,
              className: className(styles.link),
              children: inside,
            },
            node.render
          )
        : inside}
      {filled(node.actions) && (
        <RowActions value={node.value} atEnd={!filled(node.badge)}>
          {node.actions}
        </RowActions>
      )}
    </>
  );
};

/** Enter on an item whose row is a link follows it, as a press does. */
const followLink = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== "Enter" || !(event.target instanceof HTMLElement)) {
    return;
  }
  const item = event.target.closest("[role=treeitem]");
  const link = item?.querySelector(":scope > * > [data-tree-view-link]");
  if (link instanceof HTMLElement) {
    link.click();
  }
};

/**
 * A nested item's part of the tree guide, as Sidebar's: the stem down from its branch's chevron, a
 * rounded elbow into its row, and the stem on to the next sibling, which the last one has not.
 */
const Guide = ({ last }: { last: boolean }) => (
  <>
    <span aria-hidden="true" {...stylex.props(styles.guideStem)} />
    <span
      aria-hidden="true"
      {...stylex.props(styles.guideBranch, !last && styles.guideBranchCut)}
    />
    {last ? null : (
      <span aria-hidden="true" {...stylex.props(styles.guideStemOn)} />
    )}
  </>
);

/** A branch's chevron; while its children load, a spinner; when they failed, a mark. */
const Chevron = (
  props: Record<string, unknown>,
  state: { loading?: boolean; failed?: boolean }
) => (
  <span
    {...props}
    {...stylex.props(styles.chevron, state.failed === true && styles.failed)}
  >
    {state.loading === true ? (
      <Spinner />
    ) : (
      <Icon icon={state.failed === true ? CircleAlertIcon : ChevronRightIcon} />
    )}
  </span>
);

/**
 * An item's element. It is named by its row's words and its badge, never by its row's buttons; one
 * that cannot be chosen says nothing of being chosen.
 */
const itemElement = (props: Record<string, unknown>, node: TreeNode) => {
  const nameId = String(props["aria-labelledby"]);
  return renderElement("div", {
    ...props,
    "data-slot": "tree-view-item",
    "data-value": node.value,
    "aria-labelledby": filled(node.badge)
      ? `${nameId} ${nameId}-badge`
      : nameId,
    ...(node.selectable === false ? { "aria-selected": undefined } : {}),
  });
};

interface ItemsProps {
  nodes: TreeNode[];
  current: string | null | undefined;
  query: string;
  /** Draw the tree guide on nested items (`showIndentGuides`). */
  guides: boolean;
  /** These items are a branch's children, under its row. */
  nested?: boolean;
}

const Items = ({ nodes, current, query, guides, nested = false }: ItemsProps) =>
  nodes.map((node, index) => {
    const branch = node.children !== undefined;
    const guided = guides && nested;
    return (
      <ItemPrimitive
        key={node.value}
        value={node.value}
        branch={branch || undefined}
        disabled={node.disabled}
        label={node.label}
        render={(props: Record<string, unknown>) => itemElement(props, node)}
        {...stylex.props(styles.item, guided && styles.guided)}
      >
        {guided ? <Guide last={index === nodes.length - 1} /> : null}
        <LabelPrimitive
          // The row takes the label's states for its look; the label's id goes to the row's words,
          // so the row's buttons are no part of the item's name.
          render={({ id, ...row }: Record<string, unknown>) => (
            <div {...row} data-tree-view-row="">
              {branch ? (
                <IndicatorPrimitive render={Chevron} />
              ) : (
                <span aria-hidden="true" {...stylex.props(styles.spacer)} />
              )}
              <RowInside
                node={node}
                current={current === node.value}
                query={query}
                nameId={String(id)}
              />
            </div>
          )}
          {...stylex.props(styles.row, styles.focusRow)}
        />
        {branch && (
          <GroupPrimitive {...stylex.props(styles.group)}>
            <Items
              nodes={node.children ?? []}
              current={current}
              query={query}
              guides={guides}
              nested
            />
          </GroupPrimitive>
        )}
      </ItemPrimitive>
    );
  });

// ---- The filter -------------------------------------------------------------------------------------

/** The filter field, the system's own InputGroup, as Sidebar's: Escape clears it, Down moves into the tree. */
const FilterField = ({
  text,
  onText,
  onDown,
}: {
  text: string;
  onText: (text: string) => void;
  onDown: () => void;
}) => {
  const { treeView: words } = useI18n();
  return (
    <InputGroup>
      <InputGroupAddon>
        <Icon icon={SearchIcon} />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        aria-label={words.filter}
        placeholder={words.filter}
        value={text}
        onValueChange={(value: string) => {
          onText(value);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === "Escape" && text !== "") {
            event.preventDefault();
            event.stopPropagation();
            onText("");
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            onDown();
          }
        }}
      />
      <InputGroupClear aria-label={words.clear} />
    </InputGroup>
  );
};

/** Where the tree's keys are: the item that takes its Tab stop, else its first. */
const treeStop = (box: HTMLElement | null) =>
  box?.querySelector<HTMLElement>('[role=treeitem][tabindex="0"]') ??
  box?.querySelector<HTMLElement>("[role=treeitem]") ??
  null;

/** The filter's words: the caller's when it holds them, else the tree's own. */
const useFilterText = (
  filter: string | undefined,
  defaultFilter: string,
  onFilterChange: ((filter: string) => void) | undefined
) => {
  const [own, setOwn] = useState(defaultFilter);
  const change = (next: string) => {
    if (filter === undefined) {
      setOwn(next);
    }
    onFilterChange?.(next);
  };
  return { text: filter ?? own, change };
};

/**
 * The folds of a tree with a filter, which the tree holds: while the filter stands, the branches
 * above each match are open (and can be folded); emptied, the folds from before it come back, the
 * caller's when it holds them, else the tree's own.
 */
const useFilterFolds = (
  nodes: TreeNode[],
  query: string,
  props: Pick<
    TreeViewProps,
    "expandedValue" | "defaultExpandedValue" | "onExpandedChange"
  >
) => {
  const [own, setOwn] = useState<string[]>(props.defaultExpandedValue ?? []);
  const [folds, setFolds] = useState<{ query: string; open: string[] } | null>(
    null
  );
  const filtering = query !== "";
  const kept = folds?.query === query ? folds.open : undefined;
  const now = filtering
    ? (kept ?? opened(nodes, query))
    : (props.expandedValue ?? own);
  const change = (next: string[]) => {
    if (filtering) {
      setFolds({ query, open: next });
      return;
    }
    if (props.expandedValue === undefined) {
      setOwn(next);
    }
    props.onExpandedChange?.(next);
  };
  return { now, change };
};

/**
 * On a touch screen no pointer rests on a row, so the rows in view draw their buttons: one observer
 * for the tree, told of rows as they come and go.
 */
const useRowsInView = (
  tree: HTMLElement | null,
  shown: ReturnType<typeof createShown>
) => {
  useEffect(() => {
    const seen = new Set<string>();
    const sight = new IntersectionObserver((entries) => {
      for (const { target, isIntersecting } of entries) {
        const { value } = itemOf(target);
        if (value !== null && isIntersecting && target.isConnected) {
          seen.add(value);
        } else if (value !== null) {
          seen.delete(value);
        }
      }
      shown.see(new Set(seen));
    });
    // Watching a row again is nothing; a row that left is forgotten when it is next reported.
    const watch = () => {
      for (const row of tree?.querySelectorAll("[data-tree-view-row]") ?? []) {
        sight.observe(row);
      }
    };
    const rows = new MutationObserver(watch);
    if (tree !== null && window.matchMedia("(pointer: coarse)").matches) {
      watch();
      rows.observe(tree, { childList: true, subtree: true });
    }
    return () => {
      sight.disconnect();
      rows.disconnect();
    };
  }, [tree, shown]);
};

const treeElement = (props: Record<string, unknown>) =>
  renderElement("div", { ...props, "data-slot": "tree-view" });

/** Nested items that open and close. */
export const TreeView = ({
  items,
  "aria-label": label,
  selectionMode = "single",
  value,
  defaultValue,
  onValueChange,
  expandedValue,
  defaultExpandedValue,
  onExpandedChange,
  loadChildren,
  onAction,
  current,
  expandOnPress = true,
  showIndentGuides = false,
  disabled,
  filterable = false,
  filter,
  defaultFilter = "",
  onFilterChange,
}: TreeViewProps) => {
  const { treeView: words } = useI18n();
  // Children that loaded are kept here, so the tree knows them from then on.
  const [loaded, setLoaded] = useState<Record<string, TreeNode[]>>({});
  const box = useRef<HTMLDivElement>(null);
  const { text, change: changeText } = useFilterText(
    filter,
    defaultFilter,
    onFilterChange
  );
  const query = filterable ? text.trim().toLocaleLowerCase() : "";
  // The React Compiler keeps these between renders while their inputs stay the same.
  const nodes = withLoaded(items, loaded);
  const shown = query === "" ? nodes : narrowed(nodes, query);
  const data = toData(shown);
  // The choice is held here, the caller's or the tree's own, so what cannot be chosen never is.
  const fixed = new Set(fixedValues(nodes));
  const [own, setOwn] = useState<TreeValue>(
    defaultValue ?? (selectionMode === "multiple" ? [] : null)
  );
  const choose = (next: TreeValue) => {
    const kept = choosable(next, fixed);
    if (kept === undefined) {
      return;
    }
    if (value === undefined) {
      setOwn(kept);
    }
    onValueChange?.(kept);
  };
  const load = async (branch: string, details: { signal: AbortSignal }) => {
    // A branch loads once: one that loaded empty stays empty, and is not asked again.
    if (!loadChildren || branch in loaded) {
      return;
    }
    const children = await loadChildren(branch, details);
    // A late answer to a load that was cancelled is not kept.
    if (details.signal.aborted) {
      throw details.signal.reason;
    }
    setLoaded((now) => ({ ...now, [branch]: children }));
  };
  // Without a filter the folds are the caller's or the tree's own. With one, the tree holds them.
  const folds = useFilterFolds(nodes, query, {
    expandedValue,
    defaultExpandedValue,
    onExpandedChange,
  });
  const foldProps = filterable
    ? { expanded: folds.now, onExpandedChange: folds.change }
    : {
        expanded: expandedValue,
        defaultExpanded: defaultExpandedValue,
        onExpandedChange:
          onExpandedChange &&
          ((next: string[]) => {
            onExpandedChange(next);
          }),
      };
  // Which rows draw their buttons (createShown), from where the pointer and focus are.
  // oxlint-disable-next-line react/hook-use-state -- a store made once, never replaced
  const [shownRows] = useState(createShown);
  const [treeNode, setTreeNode] = useState<HTMLElement | null>(null);
  useRowsInView(treeNode, shownRows);
  const tree = (
    <TreePrimitive
      ref={setTreeNode}
      aria-label={label}
      items={data}
      mode={selectionMode}
      value={value === undefined ? own : value}
      onValueChange={choose}
      {...foldProps}
      loadChildren={loadChildren ? load : undefined}
      onAction={
        onAction
          ? (item: string) => {
              onAction(item);
            }
          : undefined
      }
      current={current}
      expandOnPress={expandOnPress}
      disabled={disabled}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
        followLink(event);
        tabToActions(event);
      }}
      onPointerOver={(event: PointerEvent<HTMLElement>) => {
        // A finger rests on nothing: the rows in view have theirs (useRowsInView).
        if (event.pointerType !== "touch") {
          shownRows.hover(itemOf(event.target).value);
        }
      }}
      onPointerLeave={() => {
        shownRows.hover(null);
      }}
      onFocus={(event: FocusEvent<HTMLElement>) => {
        shownRows.focus(itemOf(event.target).value);
      }}
      onBlur={(event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          shownRows.focus(null);
        }
      }}
      render={treeElement}
      {...stylex.props(styles.tree)}
    >
      <ShownContext value={shownRows}>
        <Items
          nodes={shown}
          current={current}
          query={query}
          guides={showIndentGuides}
        />
      </ShownContext>
    </TreePrimitive>
  );
  if (!filterable) {
    return tree;
  }
  return (
    <div
      ref={box}
      data-slot="tree-view-filtered"
      {...stylex.props(styles.filtered)}
    >
      <FilterField
        text={text}
        onText={changeText}
        onDown={() => {
          treeStop(box.current)?.focus();
        }}
      />
      {query !== "" && shown.length === 0 ? (
        <output {...stylex.props(styles.none)}>{words.empty}</output>
      ) : (
        tree
      )}
    </div>
  );
};
