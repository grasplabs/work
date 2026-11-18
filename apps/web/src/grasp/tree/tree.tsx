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
import { useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { focus } from "../focus/focus";
import { ChevronRight, Failed, Icon } from "../icons";
import type { IconData } from "../icons";
import { Spinner } from "../spinner";
import { treeStyles as styles } from "./styles";

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
  /** Nothing can be chosen, opened or run. */
  disabled?: boolean;
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

/** Whether a node's row is a link. */
const isLinked = (node: TreeNode) =>
  (node.href !== undefined && node.href !== "") || node.render !== undefined;

/**
 * The row's icon, words and end; in a link when the node leads somewhere. The link takes no Tab
 * stop of its own: the tree's item holds focus, and Enter on it follows the link (Tree, below).
 */
const RowInside = ({ node, current }: { node: TreeNode; current: boolean }) => {
  const inside = (
    <>
      {node.icon && (
        <span aria-hidden="true" {...stylex.props(styles.icon)}>
          <Icon icon={node.icon} />
        </span>
      )}
      <span {...stylex.props(styles.words)}>{node.label}</span>
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

const Items = ({
  nodes,
  current,
}: {
  nodes: TreeNode[];
  current: string | null | undefined;
}) =>
  nodes.map((node) => {
    const branch = node.children !== undefined;
    return (
      <ItemPrimitive
        key={node.value}
        value={node.value}
        branch={branch || undefined}
        disabled={node.disabled}
        label={node.label}
        {...stylex.props(styles.item)}
      >
        <LabelPrimitive {...stylex.props(styles.row, focus.row)}>
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
            <span aria-hidden="true" {...stylex.props(styles.spacer)} />
          )}
          <RowInside node={node} current={current === node.value} />
        </LabelPrimitive>
        {branch && (
          <GroupPrimitive {...stylex.props(styles.group)}>
            <Items nodes={node.children ?? []} current={current} />
          </GroupPrimitive>
        )}
      </ItemPrimitive>
    );
  });

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
  disabled,
}: TreeProps) => {
  // Children that loaded are kept here, so the tree knows them from then on.
  const [loaded, setLoaded] = useState<Record<string, TreeNode[]>>({});
  // The React Compiler keeps these between renders while their inputs stay the same.
  const nodes = withLoaded(items, loaded);
  const data = toData(nodes);
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
  return (
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
      expanded={expanded}
      defaultExpanded={defaultExpanded}
      onExpandedChange={
        onExpandedChange
          ? (next: string[]) => {
              onExpandedChange(next);
            }
          : undefined
      }
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
      <Items nodes={nodes} current={current} />
    </TreePrimitive>
  );
};
