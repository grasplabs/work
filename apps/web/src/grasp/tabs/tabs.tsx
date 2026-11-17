// Tabs: views of one thing, one shown at a time, from shadcn's (registry/bases/base/ui/tabs.tsx,
// on Base UI), converted from Tailwind to StyleX and rebuilt on UI SDK's Tabs, then made Grasp's:
// the docs' own tab line, words in muted that turn ink, and a mint line under the chosen one; or,
// segmented, the chosen one filled, as Palermo's Segmented Tabs.
//
//   <Tabs defaultValue="overview">
//     <TabsList aria-label="Project">
//       <TabsTab value="overview">Overview</TabsTab>
//       <TabsTab value="activity">Activity</TabsTab>
//     </TabsList>
//     <TabsPanel value="overview">…</TabsPanel>
//     <TabsPanel value="activity">…</TabsPanel>
//   </Tabs>
//
// The chosen tab draws its own line, so the choice shows before any script runs and in forced
// colours. Every value is a token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ChangeDetails } from "@ui-sdk/core";
import {
  Tabs as TabsPrimitive,
  TabsList as TabsListPrimitive,
  TabsPanel as TabsPanelPrimitive,
  TabsTab as TabsTabPrimitive,
} from "@ui-sdk/react/tabs";
import type { TabsListState, TabsTabState } from "@ui-sdk/react/tabs";
import { createContext, useContext } from "react";
import type { ComponentProps, ReactNode } from "react";

import { focus, focusMarker } from "../focus/focus";
import type { LayoutStyle } from "../layout/layout";
import { glide, spanOf } from "../motion/glide";
import { grasp, media } from "../tokens/tokens.stylex";
import { fadeVars } from "./fade.stylex";
import { rowMarker } from "./tabs.stylex";

/** What a caller may style: where the tabs sit. Never their look. */
export type TabsLayoutStyle = LayoutStyle;

/** Every prop Tabs takes. */
export interface TabsProps {
  /** Its list, then a panel for each tab. */
  children: ReactNode;
  /** The tab shown at first. Leave it out to show the first tab that is not disabled. */
  defaultValue?: string;
  /** The tab shown, when you keep it in state. Pair it with `onValueChange`. */
  value?: string;
  /**
   * Called with the tab chosen and why: a press, the arrow keys, or code and agents.
   * `details.source` is `"agent"` when an agent chose, and `details.cancel()` keeps the tab.
   */
  onValueChange?: (value: string | null, details: ChangeDetails) => void;
  /**
   * When the arrow keys choose: `automatic` as they move, `manual` on Enter or Space. Use
   * `manual` when a panel takes a moment to show.
   * @default "automatic"
   */
  activation?: "automatic" | "manual";
  /**
   * `line` for views of a page, with a line under the chosen tab. `segmented` for a small
   * switch in a toolbar, the chosen tab filled.
   * @default "line"
   */
  variant?: "line" | "segmented";
  /** Layout only: margins, alignment and width. */
  style?: TabsLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: TabsLayoutStyle;
}

/** Every prop a TabsList takes. */
export interface TabsListProps extends Omit<
  ComponentProps<typeof TabsListPrimitive>,
  "className" | "style" | "render" | "ref"
> {
  /** What the tabs are of, as a screen reader and an agent say it ("Project"). */
  "aria-label"?: string;
}

/** Every prop a TabsTab takes. */
export interface TabsTabProps extends Omit<
  ComponentProps<typeof TabsTabPrimitive>,
  "className" | "style" | "render" | "value" | "disabled" | "children"
> {
  /** Its words: a short noun for its view ("Activity"). */
  children: ReactNode;
  /** Pairs the tab with the panel of the same `value`. */
  value: string;
  /**
   * Can be reached but not chosen. Say why near it.
   * @default false
   */
  disabled?: boolean;
}

/** Every prop a TabsPanel takes. */
export interface TabsPanelProps extends Omit<
  ComponentProps<typeof TabsPanelPrimitive>,
  "className" | "style" | "render" | "value"
> {
  /** The `value` of the tab it belongs to. */
  value: string;
  /**
   * Stays in the page, hidden, while another tab is shown, so a draft in it is kept.
   * @default false
   */
  keepMounted?: boolean;
}

// ---- The look --------------------------------------------------------------------------------------

const HOVER = media.hover;
const COARSE = media.coarse;
const FORCED = media.forced;

// The fade at a side with more tabs: space-10 wide, or from the start of a tab cut there that shows
// less than half of itself (fadeVars), clear for the last space-2, so what runs under it has
// dissolved into the ground before the edge. Written from the start side and the end side; the
// gradient's direction flips them in right to left.
const fadeStart = `transparent ${grasp.space2}, black max(${grasp.space10}, ${fadeVars.start})`;
const fadeEnd = `black calc(100% - max(${grasp.space10}, ${fadeVars.end})), transparent calc(100% - ${grasp.space2})`;

const styles = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
  },
  // Segmented: the tabs on a soft track, the chosen one raised out of it, as Palermo's. The track's
  // room above and below holds each tab's 44px target on a touch screen, so the row's scrolling
  // never cuts it.
  listSegmented: {
    gap: grasp.space1,
    padding: {
      default: grasp.space1,
      [COARSE]: `calc((${grasp.tap} - ${grasp.controlSm}) / 2) ${grasp.space1}`,
    },
    borderRadius: `min(${grasp.corner}, calc((${grasp.controlSm} + 2 * ${grasp.space1}) / 2))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.soft,
    backgroundImage: "none",
    boxShadow: "none",
    marginInline: 0,
    width: "fit-content",
    maxWidth: "100%",
  },
  list: {
    // The box the gliding line is placed in.
    position: "relative",
    display: "flex",
    // The words stand a tab gap apart. The gap is between the tabs, not padding inside them, so a
    // tab, and the line it draws, is exactly as wide as its word (A3-nav-01).
    gap: grasp.tabGap,
    minWidth: 0,
    marginInline: `calc(-1 * ${grasp.tabGap} / 2)`,
    paddingInline: `calc(${grasp.tabGap} / 2)`,
    overflowX: "auto",
    scrollbarWidth: "none",
    backgroundImage: `linear-gradient(${grasp.line}, ${grasp.line})`,
    backgroundSize: `calc(100% - ${grasp.tabGap}) 1px`,
    backgroundPosition: "center bottom",
    backgroundRepeat: "no-repeat",
    maskImage: {
      default: null,
      ":is([data-under-end]:not([data-under-start]))": `linear-gradient(to right, ${fadeEnd})`,
      ":is([data-under-start]:not([data-under-end]))": `linear-gradient(to right, ${fadeStart}, black)`,
      ":is([data-under-start][data-under-end])": `linear-gradient(to right, ${fadeStart}, ${fadeEnd})`,
      ":is([dir=rtl] *):is([data-under-end]:not([data-under-start]))": `linear-gradient(to left, ${fadeEnd})`,
      ":is([dir=rtl] *):is([data-under-start]:not([data-under-end]))": `linear-gradient(to left, ${fadeStart}, black)`,
      ":is([dir=rtl] *):is([data-under-start][data-under-end])": `linear-gradient(to left, ${fadeStart}, ${fadeEnd})`,
    },
  },
  tab: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    minHeight: grasp.controlLg,
    margin: 0,
    // No room at the sides: the tab is its word, so its line starts and ends with the word, and the
    // first tab's word and line start on the content's edge together (A3-nav-01). The ring round
    // the word stands in the row's gap, evenly at both sides.
    paddingInline: 0,
    paddingBlock: grasp.space2,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    whiteSpace: "nowrap",
    color: grasp.muted,
    backgroundColor: "transparent",
    // The line is a real border, so forced colours keep it.
    borderWidth: 0,
    borderBottomWidth: grasp.tabLineWidth,
    borderStyle: "solid",
    borderColor: { default: "transparent", [FORCED]: "Canvas" },
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    // Only the words fade: the line never fades from one tab to another, it glides (glide below).
    transitionProperty: "color",
    transitionDuration: grasp.durationMark,
    transitionTimingFunction: grasp.ease,
  },
  // Can be chosen: the words turn ink under a pointer.
  live: {
    color: {
      default: grasp.muted,
      ":hover": { default: null, [HOVER]: grasp.ink },
    },
  },
  chosen: {
    color: grasp.ink,
    borderBottomColor: {
      default: grasp.tabLine,
      [stylex.when.ancestor("[data-gliding]", rowMarker)]: "transparent",
      [FORCED]: "Highlight",
    },
  },
  // The one line that glides from the chosen tab to the next (src/motion/glide.ts). Unseen at rest,
  // where the chosen tab draws its own line, so the choice shows before script and in forced colours.
  glide: {
    position: "absolute",
    left: 0,
    bottom: 0,
    width: 0,
    height: grasp.tabLineWidth,
    backgroundColor: grasp.tabLine,
    pointerEvents: "none",
    opacity: {
      default: 0,
      [stylex.when.ancestor("[data-gliding]", rowMarker)]: 1,
    },
    display: { default: "block", [FORCED]: "none" },
  },
  // Segmented: a small filled control, no line.
  segment: {
    minHeight: grasp.controlSm,
    paddingBlock: 0,
    paddingInline: grasp.space3,
    borderBottomWidth: 0,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
    cornerShape: grasp.cornerShape,
    transitionProperty: "color, background-color",
  },
  // Under a pointer, a segment that is not chosen takes a faint fill.
  segmentLive: {
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: grasp.ghostFillHover },
    },
  },
  // Chosen: raised out of the track, with the edge and lift of a card, so the choice is a shape and
  // not a colour alone.
  // In dark a lift's shadow is lost on the dark ground and raised is barely lighter than the track,
  // so there the fill also takes the pressed veil: it stands out of the track more than a hovered
  // segment (the hover veil) does. Light is untouched.
  segmentChosen: {
    color: { default: grasp.ink, [FORCED]: "HighlightText" },
    backgroundColor: { default: grasp.tabFillChosen, [FORCED]: "Highlight" },
    backgroundImage: {
      default: `linear-gradient(light-dark(transparent, ${grasp.ghostFillPress}), light-dark(transparent, ${grasp.ghostFillPress}))`,
      [FORCED]: "none",
    },
    boxShadow: grasp.liftLow,
  },
  targetSegment: {
    insetInline: 0,
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${grasp.controlSm} - ${grasp.tap}) / 2)`,
    },
  },
  disabled: {
    opacity: grasp.dim,
    cursor: "not-allowed",
  },
  // A line tab's words, which carry its ring: a space-1 of room at each side, given back by the
  // margin, so the ring stands as far from the words at the sides as above and below and is as
  // wide as the tab and its line, still inside the tab.
  label: {
    paddingInline: grasp.space1,
    marginInline: `calc(-1 * ${grasp.space1})`,
  },
  // A finger needs 44px: an invisible area inside the tab reaches past its edges.
  target: {
    position: "absolute",
    // Half the gap out at each side, so the tabs' areas meet and a short word ("All") is still a
    // wide target; up and down the tab is tall enough already.
    insetInline: `calc(-1 * ${grasp.tabGap} / 2)`,
    insetBlock: 0,
  },
  // Its focus ring (a panel takes focus when it has nothing focusable) follows the system's corner
  // and stands clear of the words: room on each side, given back by the margin, so the words keep
  // their place under the tabs.
  // Its first space-2 is a margin, not padding, so the ring stands clear of the tab line above it.
  panel: {
    minWidth: 0,
    marginTop: grasp.space2,
    marginInline: `calc(-1 * ${grasp.space2})`,
    paddingInline: grasp.space2,
    paddingBottom: grasp.space2,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    paddingTop: `calc(${grasp.space4} - ${grasp.space2})`,
    color: grasp.text,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
});

const className = (...parts: (stylex.StyleXStyles | false)[]) =>
  stylex.props(...parts).className;

/** The tabs' look, shared with the navigation of links that looks like them (./nav.tsx). */
export const tabStyles = styles;

const Variant = createContext<"line" | "segmented">("line");

export const Tabs = ({
  children,
  style: styleProp,
  layout,
  variant = "line",
  ...options
}: TabsProps) => (
  <Variant.Provider value={variant}>
    <TabsPrimitive
      {...options}
      {...stylex.props(styles.root, layout ?? styleProp)}
    >
      {children}
    </TabsPrimitive>
  </Variant.Provider>
);

/**
 * Marks which sides of the row have tabs beyond them, as attributes its style reads (the fade
 * there), on scroll and whenever the row or its tabs change size; never a render per scroll. A ref
 * callback: it starts watching when the row mounts and stops when it goes.
 */
/** A fade variable's own name, from the `var(--name)` StyleX gives for it. */
const nameOf = (variable: string) => variable.slice("var(".length, -1);

/**
 * How much shows of the tab cut by each side of the row, when that is less than half of it, else
 * 0: the fade then starts at that tab's start, so it never reads as cut.
 */
const cutReach = (element: HTMLElement) => {
  const box = element.getBoundingClientRect();
  const rtl = getComputedStyle(element).direction === "rtl";
  const [startEdge, endEdge] = rtl
    ? [box.right, box.left]
    : [box.left, box.right];
  let start = 0;
  let end = 0;
  for (const tab of element.children) {
    const rect = tab.getBoundingClientRect();
    const [tabStart, tabEnd] = rtl
      ? [rect.right, rect.left]
      : [rect.left, rect.right];
    // How far the tab reaches in past each edge, along the reading direction.
    const pastStart = rtl ? startEdge - tabEnd : tabEnd - startEdge;
    const pastEnd = rtl ? tabStart - endEdge : endEdge - tabStart;
    if (pastStart > 0 && pastStart < rect.width && pastStart < rect.width / 2) {
      start = pastStart;
    }
    if (pastEnd > 0 && pastEnd < rect.width && pastEnd < rect.width / 2) {
      end = pastEnd;
    }
  }
  return { start, end };
};

const watch = (element: HTMLElement) => {
  const measure = () => {
    const room = element.scrollWidth - element.clientWidth;
    // Right to left, scrollLeft runs from 0 to minus the room.
    const along = Math.abs(element.scrollLeft);
    element.toggleAttribute("data-under-start", room > 1 && along > 1);
    element.toggleAttribute("data-under-end", room > 1 && along < room - 1);
    const reach = cutReach(element);
    element.style.setProperty(nameOf(fadeVars.start), `${reach.start}px`);
    element.style.setProperty(nameOf(fadeVars.end), `${reach.end}px`);
  };
  element.addEventListener("scroll", measure, { passive: true });
  // The observer reports each box once when it starts watching, after the page is laid out. The
  // tabs too: their words change the row's width without changing the row's own box.
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  for (const tab of element.children) {
    observer.observe(tab);
  }
  return () => {
    observer.disconnect();
    element.removeEventListener("scroll", measure);
  };
};

/** Fades the side of a row that has more beyond it; shared with ./nav.tsx. */
export const watchSides = (element: HTMLElement | null) =>
  element === null ? undefined : watch(element);

/** The chosen item in a row: a tab, or a link for the page you are on (./nav.tsx). */
const chosenIn = (row: HTMLElement) =>
  row.querySelector<HTMLElement>(
    ':scope > [aria-selected="true"], :scope > [aria-current="page"]'
  );

/**
 * Moves the row's one line (styles.glide) from the chosen item to the next whenever the choice
 * changes, by whatever changed it: a press, the keys, code or an agent. It reads the change from the
 * items themselves (aria-selected, aria-current), so it is the same for Tabs and TabsNav.
 */
const watchLine = (row: HTMLElement) => {
  const line = row.querySelector<HTMLElement>(":scope > [data-tab-glide]");
  let at = chosenIn(row);
  const observer = new MutationObserver(() => {
    const next = chosenIn(row);
    if (!line || next === null || next === at) {
      return;
    }
    // From the line where it is mid-glide, else from the last chosen item where it stands now.
    if (at && line.getAnimations().length === 0) {
      const from = spanOf(at);
      line.style.setProperty("left", `${from.x}px`);
      line.style.setProperty("width", `${from.w}px`);
    }
    at = next;
    const motion = glide(line, spanOf(next));
    if (motion) {
      row.dataset.gliding = "";
      motion.onfinish = () => {
        delete row.dataset.gliding;
      };
    } else {
      delete row.dataset.gliding;
    }
  });
  observer.observe(row, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-selected", "aria-current"],
  });
  return () => {
    observer.disconnect();
  };
};

const watchBoth = (element: HTMLElement) => {
  const sides = watch(element);
  const line = watchLine(element);
  return () => {
    sides();
    line();
  };
};

/** A line row's watchers: the fades at its sides and the gliding line. Shared with ./nav.tsx. */
export const watchRow = (element: HTMLElement | null) =>
  element === null ? undefined : watchBoth(element);

/** The row of tabs. Name it with `aria-label`: what the tabs are of. */
export const TabsList = ({ children, ...rest }: TabsListProps) => {
  const segmented = useContext(Variant) === "segmented";
  return (
    <TabsListPrimitive
      {...rest}
      ref={segmented ? watchSides : watchRow}
      {...stylex.props(
        rowMarker,
        styles.list,
        segmented && styles.listSegmented
      )}
    >
      {(state: TabsListState) => (
        <>
          {typeof children === "function" ? children(state) : children}
          {!segmented && (
            <span
              aria-hidden="true"
              data-tab-glide=""
              {...stylex.props(styles.glide)}
            />
          )}
        </>
      )}
    </TabsListPrimitive>
  );
};

/** One tab: a short noun for its view ("Activity"). */
export const TabsTab = ({ children, ...rest }: TabsTabProps) => {
  const segmented = useContext(Variant) === "segmented";
  return (
    <TabsTabPrimitive
      {...rest}
      className={(state: TabsTabState) =>
        stylex.props(
          styles.tab,
          segmented && styles.segment,
          !state.disabled && !state.selected && styles.live,
          segmented && !state.disabled && !state.selected && styles.segmentLive,
          state.selected && (segmented ? styles.segmentChosen : styles.chosen),
          state.disabled && styles.disabled,
          // A segment has its corner, so the ring follows it, inside: the row scrolls, so a ring
          // outside would be cut. A line tab runs edge to edge with no corner, so its ring goes
          // round its words instead, never as a square box round the whole tab.
          segmented ? focus.inside : [focusMarker, focus.carrier]
        ).className
      }
    >
      <span
        aria-hidden="true"
        {...stylex.props(styles.target, segmented && styles.targetSegment)}
      />
      {segmented ? (
        children
      ) : (
        <span {...stylex.props(focus.label, styles.label)}>{children}</span>
      )}
    </TabsTabPrimitive>
  );
};

/** The view of one tab. It takes keyboard focus after the list, as the tabs pattern asks. */
export const TabsPanel = (props: TabsPanelProps) => (
  <TabsPanelPrimitive
    {...props}
    className={className(styles.panel, focus.ring)}
  />
);
