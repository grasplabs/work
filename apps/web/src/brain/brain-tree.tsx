import { ChevronRightIcon, Icon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars, motionVars } from "@grasp-os/ui/lib/vars.stylex";
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
import type { KeyboardEvent, ReactNode } from "react";

import { treeRowMarker } from "./brain-tree.stylex.ts";

// The Brain's parts in the sidebar's Brain level, as #2503's library drew a
// tree in the sidebar (`grasp/tree`, seated by the sidebar's group
// content): rows the sidebar's own height, inset, gap, words and fills, a
// branch's chevron in its icon's place (shown while the branch is open,
// under a pointer and with the keys on it), a leaf beside only leaves with
// its words in that seat, and the tree guide into each nested row. On UI
// SDK's Tree, as the library's was: its keys, type-ahead and links. Damsko's
// TreeView has no seat for the chevron and other row measures (the
// registry gap "TreeView in the sidebar"), so the Brain level keeps the
// reference's own.

/** One item of the tree. */
export interface TreeNode {
  /** Names the item: unique in the tree, and what is open and current. */
  value: string;
  /** Its words: a name, short. Type-ahead matches them. */
  label: string;
  /** An icon before the words, in the seat a branch's chevron takes while it is open. */
  icon?: IconData;
  /** Its children: a branch. */
  children?: TreeNode[];
  /** What stands at the row's end, after its words: a count. */
  end?: ReactNode;
  /** The router's link the row is drawn as: it takes the row's look, its words and `aria-current`. */
  render?: RenderProp;
}

const HOVER = media.hover;
const COARSE = media.pointerCoarse;
const chosen = ":is([data-selected], [data-current])";
const BRANCH = ":is([data-branch])";
const OPEN = ":is([data-branch][data-expanded])";
const POINTED = ":is([data-branch]:hover)";
const KEYED = ":is([data-slot=tree-item]:focus-visible > [data-branch])";

/** A row's measures, the sidebar's rows' own. */
const ROW = size.controlSm;
const INSET = size.sidebarRowInline;
const GAP = size.sidebarRowGap;
const ICON_GAP = size.sidebarIconGap;
/** A child's icon stands under its parent's words. */
const INDENT = `calc(${size.sidebarIcon} + ${size.sidebarIconGap})`;
const LEAD = `calc(${INSET} + (var(--tree-level, 1) - 1) * ${INDENT})`;

// The guide: a row's middle; the stem's column under the parent's chevron; the elbow, a space-3
// round unless the indent is too short for it.
const ROW_MIDDLE = `calc(${ROW} / 2)`;
const ROW_MIDDLE_TOUCH = `calc(${size.treeViewRowTouch} / 2)`;
const GUIDE_X = `calc(${INSET} + (var(--tree-level, 2) - 2) * ${INDENT} + ${size.iconSm} / 2 - ${size.treeViewGuide} / 2)`;
const GUIDE_ELBOW = `min(${space["3"]}, calc(${INDENT} - ${space["1"]}))`;
const guideLine = { default: colors.border, [media.forcedColors]: "GrayText" };
const ring = `${size.ringWidth} solid ${colors.ring}`;

const styles = stylex.create({
  tree: {
    display: "flex",
    flexDirection: "column",
    gap: GAP,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    margin: 0,
    padding: 0,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.sidebarSecondaryForeground,
    listStyle: "none",
  },
  item: {
    display: "flex",
    flexDirection: "column",
    gap: GAP,
    minWidth: 0,
    outline: "none",
  },
  group: {
    display: "flex",
    flexDirection: "column",
    gap: GAP,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  row: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: ICON_GAP,
    boxSizing: "border-box",
    minWidth: 0,
    minHeight: { default: ROW, [COARSE]: size.treeViewRowTouch },
    paddingInlineStart: LEAD,
    paddingInlineEnd: INSET,
    borderRadius: radius.sidebarRowRadius,
    cornerShape: radius.shape,
    letterSpacing: size.sidebarTracking,
    color: {
      default: colors.sidebarSecondaryForeground,
      ":hover:not([data-selected], [data-current])": {
        default: null,
        [HOVER]: colors.sidebarForeground,
      },
      [chosen]: {
        default: colors.sidebarForeground,
        [media.forcedColors]: "HighlightText",
      },
    },
    backgroundColor: {
      default: "transparent",
      ":hover:not([data-selected], [data-current])": {
        default: null,
        [HOVER]: colors.sidebarHover,
      },
      ":is([data-selected])": {
        default: colors.treeViewBgSelected,
        [media.forcedColors]: "Highlight",
      },
      ":is([data-current])": {
        default: colors.sidebarAccent,
        [media.forcedColors]: "Highlight",
      },
    },
    fontWeight: font.weightMedium,
    cursor: "pointer",
    userSelect: "none",
    transitionProperty: "color, background-color",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
    // The keyboard's ring on the row only, inside it, never round its children.
    outline: {
      default: "none",
      ":is([data-slot=tree-item]:focus-visible > *)": ring,
    },
    outlineOffset: `calc(-1 * ${size.ringWidth})`,
  },
  // A branch's chevron, in its icon's place: shown while the branch is open, under a pointer, with
  // the keys on it, and always on a touch screen.
  chevron: {
    position: "absolute",
    insetBlock: 0,
    insetInlineStart: LEAD,
    zIndex: 1,
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    width: size.iconSm,
    color: colors.sidebarSecondaryForeground,
    transform: { default: "none", ":is([data-expanded])": "rotate(90deg)" },
    opacity: {
      default: 0,
      [stylex.when.ancestor(OPEN, treeRowMarker)]: 1,
      [stylex.when.ancestor(POINTED, treeRowMarker)]: {
        default: null,
        [HOVER]: 1,
      },
      [stylex.when.ancestor(KEYED, treeRowMarker)]: 1,
      [COARSE]: 1,
    },
    transitionProperty: "opacity, transform",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  // Where an icon would stand, for a row without one beside rows that have one.
  spacer: { display: "inline-block", flexShrink: 0, width: size.iconSm },
  icon: {
    display: "inline-flex",
    flexShrink: 0,
    color: colors.sidebarSecondaryForeground,
    opacity: {
      default: 1,
      [stylex.when.ancestor(OPEN, treeRowMarker)]: 0,
      [stylex.when.ancestor(POINTED, treeRowMarker)]: {
        default: null,
        [HOVER]: 0,
      },
      [stylex.when.ancestor(KEYED, treeRowMarker)]: 0,
      [stylex.when.ancestor(BRANCH, treeRowMarker)]: {
        default: null,
        [COARSE]: 0,
      },
    },
    transitionProperty: "opacity",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
  },
  words: {
    minWidth: 0,
    overflowWrap: "anywhere",
    paddingBlock: space["1"],
  },
  link: {
    display: "flex",
    flexGrow: 1,
    alignItems: "center",
    alignSelf: "stretch",
    gap: ICON_GAP,
    minWidth: 0,
    color: "inherit",
    textDecoration: "none",
    outline: "none",
  },
  end: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    flexShrink: 0,
    marginInlineStart: "auto",
    color: colors.mutedForeground,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightNormal,
    letterSpacing: "normal",
    fontVariantNumeric: "tabular-nums",
  },
  guided: { position: "relative" },
  guideStem: {
    position: "absolute",
    zIndex: 1,
    insetInlineStart: GUIDE_X,
    insetBlockStart: `calc(-1 * ${GAP})`,
    height: {
      default: `calc(${GAP} + ${ROW_MIDDLE} - ${GUIDE_ELBOW})`,
      [COARSE]: `calc(${GAP} + ${ROW_MIDDLE_TOUCH} - ${GUIDE_ELBOW})`,
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
    // Short: from the parent's chevron to the child's seat.
    width: `calc(${INDENT} - ${size.iconSm} / 2 - ${space["1"]} + ${size.treeViewGuide} / 2)`,
    borderInlineStartWidth: size.treeViewGuide,
    borderBlockEndWidth: size.treeViewGuide,
    borderStyle: "solid",
    borderColor: guideLine,
    borderBlockStartColor: "transparent",
    borderInlineEndColor: "transparent",
    borderEndStartRadius: GUIDE_ELBOW,
    pointerEvents: "none",
  },
  // Into the words of a leaf with no icon beside a branch: on through its empty seat.
  guideBranchToWords: {
    width: `calc(${INDENT} + ${size.iconSm} / 2 + ${ICON_GAP} - ${space["1"]} + ${size.treeViewGuide} / 2)`,
  },
  guideBranchCut: {
    clipPath: {
      default: `inset(0 0 0 ${size.treeViewGuide})`,
      ":dir(rtl)": `inset(0 ${size.treeViewGuide} 0 0)`,
    },
  },
});

/** The items as UI SDK's Tree holds them. */
const toData = (nodes: TreeNode[]): TreeItemData[] =>
  nodes.map((node) => ({
    value: node.value,
    label: node.label,
    ...(node.children ? { children: toData(node.children) } : {}),
  }));

/** A row's icon (or its empty seat), words and end; in the row's link when it leads somewhere. */
const RowInside = ({
  node,
  current,
  seatless,
}: {
  node: TreeNode;
  current: boolean;
  seatless: boolean;
}) => {
  const inside = (
    <>
      {node.icon ? (
        <span aria-hidden="true" {...stylex.props(styles.icon)}>
          <Icon icon={node.icon} />
        </span>
      ) : (
        !seatless && (
          <span aria-hidden="true" {...stylex.props(styles.spacer)} />
        )
      )}
      <span {...stylex.props(styles.words)}>{node.label}</span>
      {node.end === undefined || node.end === null ? null : (
        <span {...stylex.props(styles.end)}>{node.end}</span>
      )}
    </>
  );
  if (node.render === undefined) {
    return inside;
  }
  return renderElement(
    "a",
    {
      tabIndex: -1,
      "data-tree-link": "",
      "aria-current": current ? "page" : undefined,
      className: stylex.props(styles.link).className,
      children: inside,
    },
    node.render
  );
};

/** Enter on an item follows its link, as a press does; the other keys are the tree's. */
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

/** The guide into a nested row: a stem down from the parent, its elbow, and on to the next. */
const Guide = ({ last, toWords }: { last: boolean; toWords: boolean }) => (
  <>
    <span aria-hidden="true" {...stylex.props(styles.guideStem)} />
    <span
      aria-hidden="true"
      {...stylex.props(
        styles.guideBranch,
        toWords && styles.guideBranchToWords,
        !last && styles.guideBranchCut
      )}
    />
    {last ? null : (
      <span aria-hidden="true" {...stylex.props(styles.guideStemOn)} />
    )}
  </>
);

/** A level's items, each a row and, for a branch, its children under it. */
const Items = ({
  nodes,
  current,
  nested = false,
}: {
  nodes: TreeNode[];
  current: string | null;
  nested?: boolean;
}) =>
  nodes.map((node, index) => {
    const branch = node.children !== undefined;
    // A leaf with no icon among leaves only: its words take the icon's seat.
    const seatless =
      nested &&
      node.icon === undefined &&
      !nodes.some((each) => each.children !== undefined);
    return (
      <ItemPrimitive
        branch={branch || undefined}
        key={node.value}
        label={node.label}
        value={node.value}
        {...stylex.props(styles.item, nested && styles.guided)}
      >
        {nested ? (
          <Guide
            last={index === nodes.length - 1}
            toWords={node.icon === undefined && !branch && !seatless}
          />
        ) : null}
        <LabelPrimitive {...stylex.props(treeRowMarker, styles.row)}>
          {branch ? (
            <IndicatorPrimitive
              render={(props: Record<string, unknown>) => (
                <span {...props} {...stylex.props(styles.chevron)}>
                  <Icon icon={ChevronRightIcon} />
                </span>
              )}
            />
          ) : null}
          <RowInside
            current={current === node.value}
            node={node}
            seatless={seatless}
          />
        </LabelPrimitive>
        {branch ? (
          <GroupPrimitive {...stylex.props(styles.group)}>
            <Items current={current} nested nodes={node.children ?? []} />
          </GroupPrimitive>
        ) : null}
      </ItemPrimitive>
    );
  });

/** The Brain's parts as the sidebar's tree: the part or note open is current, every part open at first. */
export const BrainTree = ({
  items,
  current,
  defaultExpanded,
  "aria-label": label,
}: {
  items: TreeNode[];
  current: string | null;
  defaultExpanded: string[];
  "aria-label": string;
}) => (
  <TreePrimitive
    aria-label={label}
    current={current}
    defaultExpanded={defaultExpanded}
    expandOnPress={false}
    items={toData(items)}
    mode="single"
    onKeyDown={handleTreeKeyDown}
    {...stylex.props(styles.tree)}
  >
    <Items current={current} nodes={items} />
  </TreePrimitive>
);
