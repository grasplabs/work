// Tree: nested items that open and close, such as folders and files or the pages of a section,
// on UI SDK's Tree. Rows the height of a small control, each level a step in, a chevron that turns
// as a branch opens, an icon per item, the words. One item or several can be chosen, a branch's
// children can load when it first opens, and Enter runs an item's action. Palermo has no tree, so
// it follows Grasp's Select items and Sidebar rows.
//
//   <Tree label="Files" items={[{ value: "reports", label: "Reports", icon: Folder,
//     children: [{ value: "reports/summary", label: "Summary", icon: File }] }]} />
//
// The keys are the tree's: arrows move and open, Home and End jump, a letter finds the next item
// that starts with it, Enter runs, Space chooses, `*` opens every branch beside the focused one.
// Every value is a token (src/tokens).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { renderElement } from "@ui-sdk/react/primitive";
import type { RenderProp } from "@ui-sdk/react/primitive";
import {
  Tree as TreePrimitive,
  TreeGroup as GroupPrimitive,
  TreeItem as ItemPrimitive,
  TreeItemIndicator as IndicatorPrimitive,
  TreeItemLabel as LabelPrimitive,
} from "@ui-sdk/react/tree";
import type { TreeItemData } from "@ui-sdk/react/tree";
import { useContext, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { listStyles } from "../combobox/list.styles";
import { focus } from "../focus/focus";
import { ChevronRight, Failed, Icon, Search } from "../icons";
import type { IconData } from "../icons";
import {
  InputGroup,
  InputGroupClear,
  InputGroupInput,
  InputGroupText,
} from "../input-group";
import { Spinner } from "../spinner";
import { useWords } from "../words/words";
import { TreeChevronSeated } from "./seat";
import { treeStyles as styles } from "./styles";
import { treeRowMarker } from "./tree.stylex";
import { treeWords } from "./words";

/** One item of a tree. */
export interface TreeNode {
  /** Names the item: unique in the tree, and what is chosen and expanded. */
  value: string;
  /** Its words: a name, short. Type-ahead matches them. */
  label: string;
  /** An icon before the words, such as a folder or a file. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** Its children: a branch. An empty list is a branch whose children load when it opens. */
  children?: TreeNode[];
  /** It cannot be chosen, opened or run; it still takes focus, so a screen reader finds it. */
  disabled?: boolean;
  /** What stands at the row's end, after its words: a count, a mark such as sensitive or read-only. */
  end?: ReactNode;
  /**
   * Where the row leads: the row is then a link, opened by a press, Enter, a middle click or in a
   * new tab. The keys and type-ahead stay the tree's.
   */
  href?: string;
  /**
   * The element the row's link is drawn as, for a router's link (`render={<Link to="/notes" />}`): it
   * takes the row's look, its words and `aria-current` for the open one (`current`), and keeps its own
   * props. Without it, an `<a href>`. Leave `href` out when the router's link carries the address.
   */
  render?: RenderProp;
}

/** Every prop a Tree takes. */
export interface TreeProps {
  /** The items, nested by `children`. */
  items: TreeNode[];
  /** The tree's name for a screen reader, a voice command and an agent ("Files"). */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /**
   * How many items can be chosen: `single`, `multiple` (Shift and the arrows, or Ctrl or Command
   * with A, choose several), or `none` for a tree that only opens and runs.
   * @default "single"
   */
  mode?: "none" | "single" | "multiple";
  /** The chosen item, or items with `multiple`. Pass it with `onValueChange` to hold it yourself. */
  value?: string | string[] | null;
  /** The chosen item, or items, it starts with. */
  defaultValue?: string | string[] | null;
  /** Runs when the choice changes. */
  onValueChange?: (value: string | string[] | null) => void;
  /** The open branches. Pass it with `onExpandedChange` to hold them yourself. */
  expanded?: string[];
  /** The branches open at first. */
  defaultExpanded?: string[];
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
  /** The item for the page that is open, in a tree of pages: it is marked, and its branches open. */
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
  guides?: boolean;
  /** Nothing can be chosen, opened or run. */
  disabled?: boolean;
  /**
   * A filter field over the tree: what is typed narrows the items to those whose words hold it, each
   * with the branches above it, opened; the matched words are marked. Emptied, the tree's folds come
   * back as they were. Escape clears it, and ↓ moves into the tree. A branch whose children have not
   * loaded yet is matched by its own words only.
   * @default false
   */
  filterable?: boolean;
  /** The filter's words. Pass it with `onFilterChange` to hold them yourself. */
  filter?: string;
  /** The filter's words at first. @default "" */
  defaultFilter?: string;
  /** Runs as the filter's words change. */
  onFilterChange?: (filter: string) => void;
}

/** UI SDK's items, from ours: the whole shape, for the keys and type-ahead. */
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
      <mark key={at} {...stylex.props(listStyles.mark)}>
        {words.slice(at, at + query.length)}
      </mark>
    );
    from = at + query.length;
  }
  parts.push(words.slice(from));
  return parts;
};

/** Whether a node's row is a link. */
const isLinked = (node: TreeNode) =>
  (node.href !== undefined && node.href !== "") || node.render !== undefined;

/**
 * The row's icon, words and end; in a link when the node leads somewhere. The link takes no Tab
 * stop of its own: the tree's item holds focus, and Enter on it follows the link (Tree, below).
 */
const RowInside = ({
  node,
  current,
  query,
  seated,
}: {
  node: TreeNode;
  current: boolean;
  query: string;
  seated: boolean;
}) => {
  const inside = (
    <>
      {node.icon ? (
        <span
          aria-hidden="true"
          {...stylex.props(styles.icon, seated && styles.iconSeated)}
        >
          <Icon icon={node.icon} />
        </span>
      ) : (
        seated && <span aria-hidden="true" {...stylex.props(styles.spacer)} />
      )}
      <span {...stylex.props(styles.words)}>
        <Marked words={node.label} query={query} />
      </span>
      {node.end !== undefined && node.end !== null && node.end !== false && (
        <span {...stylex.props(styles.end)}>{node.end}</span>
      )}
    </>
  );
  if (!isLinked(node)) {
    return inside;
  }
  return renderElement(
    "a",
    {
      href: node.href,
      tabIndex: -1,
      "data-tree-link": "",
      "aria-current": current ? "page" : undefined,
      className: stylex.props(styles.link).className,
      children: inside,
    },
    node.render
  );
};

/** Enter on an item whose row is a link follows it, as a press does. */
const handleTreeKeyDown = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== "Enter" || !(event.target instanceof HTMLElement)) {
    return;
  }
  const item = event.target.closest("[role=treeitem]");
  const link = item?.querySelector(":scope > * > [data-tree-link]");
  if (link instanceof HTMLElement) {
    link.click();
  }
};

interface ItemsProps {
  nodes: TreeNode[];
  current: string | null | undefined;
  query: string;
  /** The chevron stands in the icon's place (seat.ts). */
  seated: boolean;
  /** Draw the tree guide on nested items (Tree's `guides`). */
  guides: boolean;
  /** These items are a branch's children, under its row. */
  nested?: boolean;
}

/**
 * A nested item's part of the tree guide, as Sidebar's: the stem down from its branch's chevron, a
 * rounded elbow into its row, and the stem on to the next sibling, which the last one has not.
 */
const Guide = ({
  last,
  short,
  toWords,
}: {
  last: boolean;
  short: boolean;
  toWords: boolean;
}) => (
  <>
    <span
      aria-hidden="true"
      data-tree-guide="stem"
      {...stylex.props(styles.guideStem)}
    />
    <span
      aria-hidden="true"
      data-tree-guide="elbow"
      {...stylex.props(
        styles.guideBranch,
        short && styles.guideBranchShort,
        toWords && styles.guideBranchToWords,
        !last && styles.guideBranchCut
      )}
    />
    {last ? null : (
      <span
        aria-hidden="true"
        data-tree-guide="on"
        {...stylex.props(styles.guideStemOn)}
      />
    )}
  </>
);

const Items = ({
  nodes,
  current,
  query,
  seated,
  guides,
  nested = false,
}: ItemsProps) =>
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
        {...stylex.props(styles.item, guided && styles.guided)}
      >
        {guided ? (
          <Guide
            last={index === nodes.length - 1}
            short={seated}
            toWords={seated && node.icon === undefined && !branch}
          />
        ) : null}
        <LabelPrimitive
          {...stylex.props(
            treeRowMarker,
            styles.row,
            seated && styles.rowSeated,
            focus.row
          )}
        >
          {branch ? (
            <IndicatorPrimitive
              render={(
                props: Record<string, unknown>,
                state: { loading?: boolean; failed?: boolean }
              ) => (
                <span
                  {...props}
                  {...stylex.props(
                    styles.chevron,
                    seated && styles.chevronSeated,
                    state.failed === true && styles.failed
                  )}
                >
                  {state.loading === true ? (
                    <Spinner size="sm" />
                  ) : (
                    <Icon
                      icon={state.failed === true ? Failed : ChevronRight}
                    />
                  )}
                </span>
              )}
            />
          ) : (
            <span
              aria-hidden="true"
              {...stylex.props(styles.spacer, seated && styles.spacerSeated)}
            />
          )}
          <RowInside
            node={node}
            current={current === node.value}
            query={query}
            seated={seated}
          />
        </LabelPrimitive>
        {branch && (
          <GroupPrimitive {...stylex.props(styles.group)}>
            <Items
              nodes={node.children ?? []}
              current={current}
              query={query}
              seated={seated}
              guides={guides}
              nested
            />
          </GroupPrimitive>
        )}
      </ItemPrimitive>
    );
  });

/** The filter field, the system's own (InputGroup), as Sidebar's: Escape clears it, ↓ moves into the tree. */
const FilterField = ({
  text,
  onText,
  onDown,
}: {
  text: string;
  onText: (text: string) => void;
  onDown: () => void;
}) => {
  const words = useWords("tree", treeWords);
  return (
    <InputGroup>
      <InputGroupText icon={Search} />
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
  props: Pick<TreeProps, "expanded" | "defaultExpanded" | "onExpandedChange">
) => {
  const [own, setOwn] = useState<string[]>(props.defaultExpanded ?? []);
  const [folds, setFolds] = useState<{ query: string; open: string[] } | null>(
    null
  );
  const filtering = query !== "";
  const kept = folds?.query === query ? folds.open : undefined;
  const now = filtering
    ? (kept ?? opened(nodes, query))
    : (props.expanded ?? own);
  const change = (next: string[]) => {
    if (filtering) {
      setFolds({ query, open: next });
      return;
    }
    if (props.expanded === undefined) {
      setOwn(next);
    }
    props.onExpandedChange?.(next);
  };
  return { now, change };
};

/** Nested items that open and close. */
export const Tree = ({
  items,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated,
  mode = "single",
  value,
  defaultValue,
  onValueChange,
  expanded,
  defaultExpanded,
  onExpandedChange,
  loadChildren,
  onAction,
  current,
  expandOnPress = true,
  guides = false,
  disabled,
  filterable = false,
  filter,
  defaultFilter = "",
  onFilterChange,
}: TreeProps) => {
  const words = useWords("tree", treeWords);
  const seated = useContext(TreeChevronSeated) === "icon";
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
  // Without a filter the folds are the caller's or the tree's own, as they always were. With one,
  // the tree holds them (useFilterFolds).
  const folds = useFilterFolds(nodes, query, {
    expanded,
    defaultExpanded,
    onExpandedChange,
  });
  const foldProps = filterable
    ? { expanded: folds.now, onExpandedChange: folds.change }
    : {
        expanded,
        defaultExpanded,
        onExpandedChange:
          onExpandedChange &&
          ((next: string[]) => {
            onExpandedChange(next);
          }),
      };
  const tree = (
    <TreePrimitive
      aria-label={label}
      items={data}
      mode={mode}
      value={value}
      defaultValue={defaultValue}
      onValueChange={
        onValueChange
          ? (next: string | string[] | null) => {
              onValueChange(next);
            }
          : undefined
      }
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
      onKeyDown={handleTreeKeyDown}
      {...stylex.props(styles.tree)}
    >
      <Items
        nodes={shown}
        current={current}
        query={query}
        seated={seated}
        guides={guides}
      />
    </TreePrimitive>
  );
  if (!filterable) {
    return tree;
  }
  return (
    <div ref={box} data-slot="tree-filtered" {...stylex.props(styles.filtered)}>
      <FilterField
        text={text}
        onText={changeText}
        onDown={() => {
          treeStop(box.current)?.focus();
        }}
      />
      {query !== "" && shown.length === 0 ? (
        <output {...stylex.props(styles.none)}>{words.noMatches}</output>
      ) : (
        tree
      )}
    </div>
  );
};
