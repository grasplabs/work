// Tabs: views of one thing, one shown at a time,
// in StyleX, built on UI SDK's Tabs. Two looks, on the list:
// `default`, the tabs on a soft track with the chosen one raised; `line`, words in muted
// on one hairline that turn ink, a line under the chosen one that glides to the next.
//
//   <Tabs defaultValue="overview">
//     <TabsList aria-label="Project" variant="line">
//       <TabsTrigger value="overview">Overview</TabsTrigger>
//       <TabsTrigger value="activity">Activity</TabsTrigger>
//     </TabsList>
//     <TabsContent value="overview">…</TabsContent>
//     <TabsContent value="activity">…</TabsContent>
//   </Tabs>
//
// The keys are the tabs pattern's: the arrows move along the row (mirrored right to left), Home and
// End jump to its ends, and with `activationMode="manual"` Enter or Space chooses. More tabs than
// room scroll sideways inside the row, its sides fading. The chosen tab draws its own line, so the
// choice shows before any script runs and in forced colours.
//
// TabsNav and TabsLink: views that each have their own address, drawn as tabs are. Not a tablist:
// they go somewhere, so they are a navigation of links (`<nav>`) with aria-current="page" on the one
// you are on, and no panels. Each link is its own Tab stop, as links are; the arrows, Home and End
// also move along the row. Where the links do not fit, they fold to one button with the current
// view, whose Dropdown menu holds the same links; they never wrap and never scroll sideways.
//
//   <TabsNav aria-label="Run">
//     <TabsLink href="/runs/42" current>Overview</TabsLink>
//     <TabsLink asChild><RouterLink to="/runs/42/logs">Logs</RouterLink></TabsLink>
//   </TabsNav>
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ChangeDetails } from "@ui-sdk/core";
import {
  MenuItemIcon,
  MenuItem as MenuItemPrimitive,
} from "@ui-sdk/react/menu";
import { mergeProps, renderElement } from "@ui-sdk/react/primitive";
import {
  Tabs as TabsPrimitive,
  TabsList as TabsListPrimitive,
  TabsPanel as TabsPanelPrimitive,
  TabsTab as TabsTabPrimitive,
} from "@ui-sdk/react/tabs";
import type { TabsTabState } from "@ui-sdk/react/tabs";
import { TooltipTrigger as TooltipTriggerPrimitive } from "@ui-sdk/react/tooltip";
import { createContext, createElement, isValidElement, use } from "react";
import type {
  ComponentProps,
  KeyboardEvent,
  ReactElement,
  ReactNode,
} from "react";

import { useI18n } from "../lib/i18n";
import { ChevronDownIcon, Icon, XIcon } from "../lib/icons";
import type { IconData } from "../lib/icons";
import {
  focusCarrier,
  focusLabel,
  focusRing,
  focusRingInset,
  menuStyles,
  segmentedStyles,
} from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import { durations } from "../lib/tokens.values";
import { className } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { focusMarker, iconVars, motionVars } from "../lib/vars.stylex";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { tabsFadeVars, tabsRowMarker } from "./tabs.stylex";
import { Tooltip, TooltipContent } from "./tooltip";

// Every prop is documented once, here; the props on the docs page are read from these types.

/** The two looks of a row of tabs. */
type TabsVariant = "default" | "line";

/** Every prop Tabs takes. */
export interface TabsProps {
  /** Its TabsList, then a TabsContent for each tab. */
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
  activationMode?: "automatic" | "manual";
  /**
   * Every TabsContent stays in the page, hidden, while another tab is shown, so a draft in it is
   * kept. A TabsContent's own `keepMounted` wins.
   * @default false
   */
  keepMounted?: boolean;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

/** Every prop a TabsList takes. */
export interface TabsListProps extends Omit<
  ComponentProps<typeof TabsListPrimitive>,
  "className" | "style" | "render" | "ref" | "children"
> {
  /** Its TabsTriggers. */
  children: ReactNode;
  /** What the tabs are of, as a screen reader and an agent say it ("Project"). */
  "aria-label"?: string;
  /**
   * `default`, the chosen tab raised out of a soft track, for a few panels in a small place;
   * `line` for the views of a page, with a line under the chosen tab. Either way a tab shows a
   * panel: a switch that sets a value and shows nothing of its own is a ToggleGroup.
   * @default "default"
   */
  variant?: TabsVariant;
  /**
   * A `default` track takes the whole width of the box it stands in (across a sidebar or a
   * panel), and its tabs share it equally, each at least as wide as its words. Otherwise the track
   * is as wide as its tabs.
   * @default false
   */
  fullWidth?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a TabsTrigger takes. */
export interface TabsTriggerProps extends Omit<
  ComponentProps<typeof TabsTabPrimitive>,
  "className" | "style" | "render" | "value" | "disabled" | "children"
> {
  /** Its words: a short noun for its view ("Activity"). */
  children: ReactNode;
  /** An icon before the words, a step off them. */
  icon?: IconData;
  /** Pairs the tab with the TabsContent of the same `value`. */
  value: string;
  /**
   * Can be reached but not chosen. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /**
   * The tab can be closed (an open file): a small × at its end, its own button named "Close" and the
   * tab's words, and Delete on the focused tab. Runs when either closes it; take the tab out, and
   * choose another if it was the chosen one. Focus moves to the tab beside it. The × keeps its room
   * whether it shows or not, so the tab never changes size.
   */
  onClose?: () => void;
}

/** Every prop a TabsContent takes. */
export interface TabsContentProps extends Omit<
  ComponentProps<typeof TabsPanelPrimitive>,
  "className" | "style" | "render" | "value" | "keepMounted"
> {
  /** The `value` of the tab it belongs to. */
  value: string;
  /**
   * Stays in the page, hidden, while another tab is shown, so a draft in it is kept.
   * @default the Tabs' `keepMounted`
   */
  keepMounted?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a TabsNav takes. */
export interface TabsNavProps {
  /** What the views are of, as a screen reader and an agent say it ("Run"): the navigation's name. */
  "aria-label": string;
  /**
   * `default`, words on a soft track, the current one raised; `line`, words on one hairline, the
   * current one underlined. The same two looks as a TabsList.
   * @default "default"
   */
  variant?: TabsVariant;
  /**
   * `sm`: only the current link shows its words; every other link with an `icon` shows the icon
   * alone, its words its tooltip and still its name. For a view switch in a narrow bar (Preview,
   * Code, Data, Settings). The words ease in and out as the current view changes.
   * @default "default"
   */
  size?: "default" | "sm";
  /** Its links: TabsLink. */
  children: ReactNode;
  /** Layout only: where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop a TabsLink takes. */
export interface TabsLinkProps {
  /** Its words: a short noun for its view ("Runs"). With `asChild`, the one link, holding them. */
  children: ReactNode;
  /** An icon before the words. */
  icon?: IconData;
  /** Where it goes. Leave it out with `asChild` when the child carries it. */
  href?: string;
  /**
   * Draws the one element given as the child (a router's link) as the view's link: it gets the
   * look and aria-current, and keeps its own props.
   * @default false
   */
  asChild?: boolean;
  /**
   * The view you are on: drawn as the chosen tab and said as the current page (`aria-current`). Set
   * it from your own route match, never from a router link's active state: a link whose search only
   * partly matches marks itself active, and two links would then be current.
   * @default false
   */
  current?: boolean;
}

// ---- The look --------------------------------------------------------------------------------------

const HOVER = media.hover;
const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;

// The fade at a side with more tabs: space-10 wide, or from the start of a tab cut there that shows
// less than half of itself (tabsFadeVars), clear for the last space-2, so what runs under it has
// dissolved into the ground before the edge. Written from the start side and the end side; the
// gradient's direction flips them in right to left.
const fadeStart = `transparent ${space["2"]}, black max(${space["10"]}, ${tabsFadeVars.start})`;
const fadeEnd = `black calc(100% - max(${space["10"]}, ${tabsFadeVars.end})), transparent calc(100% - ${space["2"]})`;

const styles = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
  },
  // The list: tabs in a row on one hairline. More tabs than room scroll sideways inside it, with no
  // bar: the side with more tabs beyond it fades out instead (fadeStart, fadeEnd), as Table's and
  // Code block's do (watchSides marks it). The wheel goes back to the page at its ends.
  //
  // Nothing hangs past the content: the hairline and the first tab's word and line start on the
  // content's edge. The row reaches half a tab gap out at each side only as room inside it, padding
  // the focus ring can use without the scrolling cutting it; the hairline is drawn inset by that room.
  list: {
    // The box the gliding line is placed in.
    position: "relative",
    display: "flex",
    // The words stand a tab gap apart. The gap is between the tabs, not padding inside them, so a
    // tab, and the line it draws, is exactly as wide as its word.
    gap: space.tabGap,
    minWidth: 0,
    marginInline: `calc(-1 * ${space.tabGap} / 2)`,
    paddingInline: `calc(${space.tabGap} / 2)`,
    overflowX: "auto",
    scrollbarWidth: "none",
    backgroundImage: `linear-gradient(${colors.border}, ${colors.border})`,
    backgroundSize: `calc(100% - ${space.tabGap}) 1px`,
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
  // Default: the tabs on the segmented track (segmentedStyles), the chosen one raised out of it.
  // The track's room above and below holds each tab's 44px target on a touch screen, so the row's scrolling never cuts it.
  listDefault: {
    gap: space["1"],
    // Half a tab gap at its sides, as the original's track: more than above and below, so the
    // first and last tab stand clear of the track's rounded ends. Long forms, as the base list's.
    paddingInline: `calc(${space.tabGap} / 2)`,
    paddingBlock: {
      default: space["1"],
      [COARSE]: `calc((${size.tapTarget} - ${size.controlSm}) / 2)`,
    },
    backgroundImage: "none",
    boxShadow: "none",
    marginInline: 0,
    width: "fit-content",
    maxWidth: "100%",
  },
  // A track across its box (fullWidth): its tabs share it equally, halves or thirds, each at least
  // as wide as its words, which stand in the middle of their share.
  listFull: { width: "100%" },
  shared: { flexGrow: 1, flexBasis: 0, justifyContent: "center" },
  tab: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    minHeight: size.controlLg,
    margin: 0,
    // No room at the sides: the tab is its word, so its line starts and ends with the word, and the
    // first tab's word and line start on the content's edge together. The ring round the word
    // stands in the row's gap, evenly at both sides.
    paddingInline: 0,
    paddingBlock: space["2"],
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    whiteSpace: "nowrap",
    color: colors.mutedForeground,
    backgroundColor: "transparent",
    // The line is a real border, so forced colours keep it.
    borderWidth: 0,
    borderBottomWidth: size.tabLineWidth,
    borderStyle: "solid",
    borderColor: { default: "transparent", [FORCED]: "Canvas" },
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    // Only the words fade: the line never fades from one tab to another, it glides.
    transitionProperty: "color",
    transitionDuration: duration.mark,
    transitionTimingFunction: duration.ease,
  },
  // Can be chosen: the words turn ink under a pointer.
  live: {
    color: {
      default: colors.mutedForeground,
      ":hover": { default: null, [HOVER]: colors.foreground },
    },
  },
  chosen: {
    color: colors.foreground,
    borderBottomColor: {
      default: colors.tabLine,
      [stylex.when.ancestor("[data-gliding]", tabsRowMarker)]: "transparent",
      [FORCED]: "Highlight",
    },
  },
  // The one line that glides from the chosen tab to the next. Unseen at rest, where the chosen tab
  // draws its own line, so the choice shows before script and in forced colours.
  glide: {
    position: "absolute",
    left: 0,
    bottom: 0,
    width: 0,
    height: size.tabLineWidth,
    backgroundColor: colors.tabLine,
    pointerEvents: "none",
    opacity: {
      default: 0,
      [stylex.when.ancestor("[data-gliding]", tabsRowMarker)]: 1,
    },
    display: { default: "block", [FORCED]: "none" },
  },
  // Default: a small filled control, no line.
  segment: {
    minHeight: size.controlSm,
    paddingBlock: 0,
    paddingInline: space["3"],
    borderBottomWidth: 0,
    borderRadius: `min(${radius.xl}, calc(${size.controlSm} / 2))`,
    cornerShape: radius.shape,
    transitionProperty: "color, background-color",
  },
  // Under a pointer, a segment that is not chosen takes a faint fill.
  segmentLive: {
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accent },
    },
  },
  targetSegment: {
    insetInline: 0,
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${size.controlSm} - ${size.tapTarget}) / 2)`,
    },
  },
  disabled: {
    opacity: size.opacityDisabled,
    cursor: "not-allowed",
  },
  // A line tab's words, which carry its ring: a space-1 of room at each side, given back by the
  // margin, so the ring stands as far from the words at the sides as above and below.
  label: {
    paddingInline: space["1"],
    marginInline: `calc(-1 * ${space["1"]})`,
  },
  // A finger needs 44px: an invisible area inside the tab reaches past its edges.
  target: {
    position: "absolute",
    // Half the gap out at each side, so the tabs' areas meet and a short word ("All") is still a
    // wide target; up and down the tab is tall enough already.
    insetInline: `calc(-1 * ${space.tabGap} / 2)`,
    insetBlock: 0,
  },
  // A tab that can be closed and its ×: side by side in one box, the × over room the tab keeps at
  // its end, so the tab (and its line) runs under it and never changes size.
  closable: {
    position: "relative",
    display: "inline-flex",
    flexShrink: 0,
  },
  // The words' focus ring stands space-1 off them: the × stands a step further, clear of it.
  closeRoom: {
    paddingInlineEnd: `calc(${size.iconSm} + ${space["1"]} + ${space["2"]})`,
  },
  closeRoomSegment: {
    paddingInlineEnd: `calc(${space["3"]} + ${size.iconSm} + ${space["1"]})`,
  },
  close: {
    [iconVars.size]: `calc(${size.iconSm} * 0.75)`,
    [iconVars.stroke]: size.iconStroke,
    position: "absolute",
    insetBlockStart: "50%",
    insetInlineEnd: 0,
    translate: "0 -50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: `calc(${size.iconSm} + ${space["1"]})`,
    height: `calc(${size.iconSm} + ${space["1"]})`,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    // Button's own shape at this size: the one corner capped at half, as a ghost icon Button hovers.
    borderRadius: `min(${radius.xl}, calc((${size.iconSm} + ${space["1"]}) / 2))`,
    cornerShape: radius.shape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accent },
    },
    color: {
      default: colors.mutedForeground,
      ":hover": { default: null, [HOVER]: colors.foreground },
    },
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    transitionProperty: "color, background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
    // A pointer's target round it, 24px at least (WCAG 2.5.8), unseen. On a touch screen it stays
    // its own box: it stands inside its tab, and a target past it would take the tab's presses.
    "::after": {
      content: '""',
      position: "absolute",
      inset: { default: `calc(-1 * ${space["1"]} / 2)`, [COARSE]: 0 },
    },
  },
  closeSegment: {
    insetInlineEnd: space["2"],
  },
  // Its focus ring (a panel takes focus when it has nothing focusable) follows the system's corner
  // and stands clear of the words: room on each side, given back by the margin, so the words keep
  // their place under the tabs. Its first space-2 is a margin, not padding, so the ring stands clear
  // of the tab line above it.
  panel: {
    minWidth: 0,
    marginTop: space["2"],
    marginInline: `calc(-1 * ${space["2"]})`,
    paddingInline: space["2"],
    paddingBottom: space["2"],
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    paddingTop: `calc(${space["4"]} - ${space["2"]})`,
    color: colors.bodyForeground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
});

// Folding a TabsNav, in CSS alone, so the first paint is already right (no measuring, no flash), on
// the server as in the browser. The box is a size container: 100cqw is the room the nav has. The
// wide row is as wide as its links, and never narrower than the box (100%). Where it is wider than
// the box, its overflow (100% - 100cqw) is above 0, and the row moves that, times a thousand, out of
// sight towards the reading start; the fold layer, as wide as the row, moves back by the same and so
// stands in view. Where the row fits, the overflow is 0: the row stays, and the fold layer moves out
// of sight instead. Nothing is cut, and nothing wraps or scrolls.
// The overflow is taken less a pixel, and never below 0: WebKit resolves the box's 100cqw a fraction
// of a pixel short of the row's 100%, and the thousandfold turned that fraction into a large shift,
// the row out of sight with nothing folded. A row less than a pixel too wide stays.
const SIGN = "var(--tabs-fold-sign, 1)";
const OVER = "max(0px, 100% - 100cqw - 1px)";

const navStyles = stylex.create({
  // A link's own underline and colour give way to the tab's.
  link: {
    textDecorationLine: "none",
  },
  // The icon and the words, side by side (on the line, the focus ring goes round both).
  inside: {
    display: "inline-flex",
    alignItems: "center",
  },
  icon: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "inline-flex",
    flexShrink: 0,
  },
  // The words in a column that eases between their width and none, fading as they go, so a small
  // link's words come and go without a jump or a cut letter left standing; at once under reduced
  // motion.
  words: {
    display: "inline-grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    opacity: 1,
    transitionProperty: "grid-template-columns, opacity",
    transitionDuration: motionVars.mark,
    transitionTimingFunction: duration.ease,
  },
  wordsAway: {
    gridTemplateColumns: "minmax(0, 0fr)",
    opacity: 0,
  },
  wordsInner: {
    minWidth: 0,
    overflow: "hidden",
  },
  // An icon alone is narrower than a finger: on a touch screen its unseen target reaches 44px wide,
  // the look unchanged (a line tab's target already reaches half the gap past each side).
  targetIcon: {
    insetInline: {
      default: null,
      [COARSE]: `min(calc(-1 * ${space.tabGap} / 2), calc((100% - ${size.tapTarget}) / 2))`,
    },
  },
  targetIconSegment: {
    insetInline: {
      default: null,
      [COARSE]: `min(0px, calc((100% - ${size.tapTarget}) / 2))`,
    },
  },
  // After an icon, the words stand a step off it; the step goes with them when they go.
  wordsAfterIcon: {
    paddingInlineStart: space["2"],
  },
  // A tab's words stand a little further off its icon: 10px, as the original's switch.
  wordsAfterTabIcon: {
    paddingInlineStart: `calc(${space["2"]} + ${space["1"]} / 2)`,
  },
  // The words of every link, unseen and with no height: they give the nav its natural width, which
  // the box (a container) cannot give.
  ghost: {
    gridArea: "1 / 1",
    blockSize: 0,
    overflow: "hidden",
    visibility: "hidden",
  },
  box: {
    "--tabs-fold-sign": { default: "-1", ":dir(rtl)": "1" },
    gridArea: "1 / 1",
    containerType: "inline-size",
    position: "relative",
    display: "grid",
    // One column as wide as the box, whatever the row inside it needs.
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
  },
  // At the box's end, so a row wider than the box runs past its start, never past its end, where
  // the page could scroll to it.
  wide: {
    position: "relative",
    justifySelf: "unsafe end",
    width: "max-content",
    minWidth: "100%",
    translate: `calc(${SIGN} * ${OVER} * 1000) 0`,
  },
  fold: {
    position: "absolute",
    insetBlock: 0,
    insetInline: 0,
    display: "flex",
    alignItems: "center",
    translate: `calc(${SIGN} * (max(0px, (1px - ${OVER}) * 100000) - ${OVER} * 1000)) 0`,
  },
  // The fold's button at the box's start: the layer begins the overflow before it (100% is the
  // layer, as wide as the row; 100cqw is the box).
  foldStart: {
    display: "flex",
    marginInlineStart: `calc(${OVER})`,
  },
  // The nav's own name on the fold's button, hidden once a current view's words stand before it.
  fallback: {
    display: { default: "inline", ":not(:first-child)": "none" },
  },
});

// ---- The line that glides ----------------------------------------------------------------------------
// One line that moves from one item to another: the line under the chosen tab. It glides, and its
// width changes as it goes: the leading edge sets off first and reaches the new item early, the
// trailing edge follows, so the line stretches toward the target and then settles to the new width.
// It always starts from where it stands now, so a fast series of presses never queues: it turns
// towards the latest. Within duration-ui on the system's ease-out; under reduced motion or forced
// colours it does not move at all. The line is placed in the same box as the items, by `left` and
// `width` in px (an item's offsetLeft and offsetWidth), so its place and theirs are read the same way.

/** A place along the row: from the left edge, and how wide. */
interface Span {
  x: number;
  w: number;
}

/** Where an item stands, as the line measures it. */
const spanOf = (item: HTMLElement): Span => ({
  x: item.offsetLeft,
  w: item.offsetWidth,
});

/** A length in px, as getComputedStyle gives it ("12.5px"). */
const pixels = (value: string) => Number(value.replace("px", "")) || 0;

/** Where the line stands now, mid-glide too. */
const standing = (line: HTMLElement): Span => {
  const style = getComputedStyle(line);
  return { x: pixels(style.left), w: pixels(style.width) };
};

const still = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
  window.matchMedia("(forced-colors: active)").matches;

/** The system's ease-out, x from 0 to 1, as the tokens' curve leans. */
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const clamp = (x: number) => Math.min(1, Math.max(0, x));

// The leading edge travels in the first 70% of the time, the trailing one in the last 80%.
const LEAD = 0.7;
const TRAIL = 0.2;
const FRAMES = 16;

/** The keyframes from one span to another: the edges eased apart, so the line stretches and settles. */
const framesOf = (from: Span, to: Span): Keyframe[] => {
  const right = to.x + to.w >= from.x + from.w;
  const frames: Keyframe[] = [];
  for (let step = 0; step <= FRAMES; step += 1) {
    const t = step / FRAMES;
    const lead = easeOut(clamp(t / LEAD));
    const trail = easeOut(clamp((t - TRAIL) / (1 - TRAIL)));
    const start = from.x + (to.x - from.x) * (right ? trail : lead);
    const end =
      from.x +
      from.w +
      (to.x + to.w - from.x - from.w) * (right ? lead : trail);
    frames.push({
      left: `${start}px`,
      width: `${Math.max(0, end - start)}px`,
      offset: t,
    });
  }
  return frames;
};

/**
 * Moves the line to `to`, from where it stands, and leaves it there. Returns the motion, or null when
 * it is simply put in place (reduced motion, forced colours, or nothing to travel from).
 */
const glide = (line: HTMLElement, to: Span): Animation | null => {
  const from = standing(line);
  for (const running of line.getAnimations()) {
    running.cancel();
  }
  line.style.setProperty("left", `${to.x}px`);
  line.style.setProperty("width", `${to.w}px`);
  if (still() || from.w === 0 || (from.x === to.x && from.w === to.w)) {
    return null;
  }
  return line.animate(framesOf(from, to), {
    duration: durations.ui,
    easing: "linear",
  });
};

// ---- The row's watchers ------------------------------------------------------------------------------

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

/**
 * Marks which sides of the row have tabs beyond them, as attributes its style reads (the fade
 * there), on scroll and whenever the row or its tabs change size; never a render per scroll.
 */
const watchSides = (element: HTMLElement) => {
  const measure = () => {
    const room = element.scrollWidth - element.clientWidth;
    // Right to left, scrollLeft runs from 0 to minus the room.
    const along = Math.abs(element.scrollLeft);
    element.toggleAttribute("data-under-start", room > 1 && along > 1);
    element.toggleAttribute("data-under-end", room > 1 && along < room - 1);
    const reach = cutReach(element);
    element.style.setProperty(nameOf(tabsFadeVars.start), `${reach.start}px`);
    element.style.setProperty(nameOf(tabsFadeVars.end), `${reach.end}px`);
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

/** The chosen item in a row: a tab, or a link for the page you are on. */
const chosenIn = (row: HTMLElement) =>
  row.querySelector<HTMLElement>(
    ':scope > [aria-selected="true"], :scope > [data-tab-closable] > [aria-selected="true"], :scope > [aria-current="page"]'
  );

/**
 * Moves the row's one line from the chosen item to the next whenever the choice changes, by
 * whatever changed it: a press, the keys, code or an agent. It reads the change from the items
 * themselves (aria-selected, aria-current), so it is the same for Tabs and TabsNav.
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

/** A row's watchers, as a ref callback: the fades at its sides, and on a line row the gliding line. */
const watchBoth = (element: HTMLElement, line: boolean) => {
  const sides = watchSides(element);
  const glider = line ? watchLine(element) : undefined;
  return () => {
    sides();
    glider?.();
  };
};
const watchRow = (line: boolean) => (element: HTMLElement | null) =>
  element === null ? undefined : watchBoth(element, line);
const watchLineRow = watchRow(true);
const watchSegmentRow = watchRow(false);

// ---- Tabs --------------------------------------------------------------------------------------------

const Variant = createContext<TabsVariant>("default");
// Whether the tabs share a track across its box (fullWidth).
const Shared = createContext(false);
const KeepMounted = createContext(false);

/** The root: a TabsList and a TabsContent for each tab. */
export const Tabs = ({
  children,
  activationMode,
  keepMounted = false,
  style,
  ...options
}: TabsProps) => (
  <TabsPrimitive
    {...options}
    activation={activationMode}
    {...stylex.props(styles.root, style)}
  >
    <KeepMounted value={keepMounted}>{children}</KeepMounted>
  </TabsPrimitive>
);

/** The row of tabs. Name it with `aria-label`: what the tabs are of. */
export const TabsList = ({
  children,
  variant = "default",
  fullWidth = false,
  style,
  ...rest
}: TabsListProps) => {
  const line = variant === "line";
  const full = fullWidth && !line;
  return (
    <TabsListPrimitive
      {...rest}
      ref={line ? watchLineRow : watchSegmentRow}
      data-variant={variant}
      {...stylex.props(
        tabsRowMarker,
        styles.list,
        !line && segmentedStyles.track,
        !line && styles.listDefault,
        full && styles.listFull,
        style
      )}
    >
      <Variant value={variant}>
        <Shared value={full}>{children}</Shared>
      </Variant>
      {line && (
        <span
          aria-hidden="true"
          data-tab-glide=""
          {...stylex.props(styles.glide)}
        />
      )}
    </TabsListPrimitive>
  );
};

/** The tab beside `tab` in its list, after it or else before it: where focus goes when it closes. */
const besideOf = (tab: HTMLElement) => {
  const tabs = [
    ...(tab
      .closest("[role=tablist]")
      ?.querySelectorAll<HTMLElement>("[role=tab]") ?? []),
  ];
  const at = tabs.indexOf(tab);
  return tabs[at + 1] ?? tabs[at - 1] ?? null;
};

/**
 * Closes the tab: runs `onClose`, and when focus was on the tab or its ×, gives it to the tab beside
 * it once the closed one is gone.
 */
const closeTab = (tab: HTMLElement | null, onClose: () => void) => {
  const box = tab?.parentElement;
  const held =
    box !== null && box !== undefined && box.contains(document.activeElement);
  const beside = tab ? besideOf(tab) : null;
  onClose();
  if (held && beside) {
    requestAnimationFrame(() => {
      if (beside.isConnected) {
        beside.focus();
      }
    });
  }
};

const tabClass =
  (segmented: boolean, closable: boolean, shared: boolean) =>
  (state: TabsTabState) =>
    className(
      styles.tab,
      segmented && styles.segment,
      shared && styles.shared,
      !state.disabled && !state.selected && styles.live,
      segmented && !state.disabled && !state.selected && styles.segmentLive,
      state.selected && (segmented ? segmentedStyles.chosen : styles.chosen),
      state.disabled && styles.disabled,
      closable && (segmented ? styles.closeRoomSegment : styles.closeRoom),
      // A segment has its corner, so the ring follows it, inside: the row scrolls, so a ring
      // outside would be cut. A line tab runs edge to edge with no corner, so its ring goes
      // round its words instead, never as a square box round the whole tab.
      segmented ? focusRingInset : [focusMarker, focusCarrier]
    );

/**
 * A view's icon and words, a link's or a tab's (`tab`); with `away`, the words gone to the icon
 * alone.
 */
const Inside = ({
  icon,
  away,
  tab = false,
  children,
}: {
  icon: IconData;
  away: boolean;
  tab?: boolean;
  children: ReactNode;
}) => (
  <>
    <span aria-hidden="true" {...stylex.props(navStyles.icon)}>
      <Icon icon={icon} />
    </span>
    <span {...stylex.props(navStyles.words, away && navStyles.wordsAway)}>
      <span {...stylex.props(navStyles.wordsInner)}>
        <span
          {...stylex.props(
            navStyles.inside,
            navStyles.wordsAfterIcon,
            tab && navStyles.wordsAfterTabIcon
          )}
        >
          {children}
        </span>
      </span>
    </span>
  </>
);

/** One tab: a short noun for its view ("Activity"). */
export const TabsTrigger = ({
  children,
  icon,
  onClose,
  ...rest
}: TabsTriggerProps) => {
  const segmented = use(Variant) === "default";
  const shared = use(Shared);
  const { tabs: words } = useI18n();
  const shown =
    icon === undefined ? (
      children
    ) : (
      <Inside icon={icon} away={false} tab>
        {children}
      </Inside>
    );
  const inside = (
    <>
      <span
        aria-hidden="true"
        {...stylex.props(styles.target, segmented && styles.targetSegment)}
      />
      {segmented ? (
        shown
      ) : (
        <span
          {...stylex.props(
            focusLabel,
            styles.label,
            icon !== undefined && navStyles.inside
          )}
        >
          {shown}
        </span>
      )}
    </>
  );
  if (onClose === undefined) {
    return (
      <TabsTabPrimitive
        {...rest}
        render={(props: Record<string, unknown>) =>
          renderElement("button", { ...props, "data-slot": "tabs-trigger" })
        }
        className={tabClass(segmented, false, shared)}
      >
        {inside}
      </TabsTabPrimitive>
    );
  }
  // Its name for the ×: the tab's words, or its value when the words are not plain text.
  const name = typeof children === "string" ? children : rest.value;
  return (
    <TabsTabPrimitive
      {...rest}
      className={tabClass(segmented, true, shared)}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        rest.onKeyDown?.(event);
        if (event.key === "Delete" && !event.defaultPrevented) {
          event.preventDefault();
          closeTab(event.currentTarget, onClose);
        }
      }}
      render={(props: Record<string, unknown>, state: TabsTabState) => (
        <span data-tab-closable="" {...stylex.props(styles.closable)}>
          {renderElement("button", { ...props, "data-slot": "tabs-trigger" })}
          <button
            type="button"
            aria-label={words.close(name)}
            // The chosen tab's × is the one Tab stop after it; the others are reached by the arrows
            // and closed with Delete, as the tabs pattern asks.
            tabIndex={state.selected ? 0 : -1}
            onClick={(event) => {
              closeTab(
                event.currentTarget.parentElement?.querySelector<HTMLElement>(
                  "[role=tab]"
                ) ?? null,
                onClose
              );
            }}
            {...stylex.props(
              styles.close,
              segmented && styles.closeSegment,
              // Beside the tab's words and inside its box: the ring inside the button.
              focusRingInset
            )}
          >
            <Icon icon={XIcon} />
          </button>
        </span>
      )}
    >
      {inside}
    </TabsTabPrimitive>
  );
};

/** The view of one tab. It takes keyboard focus after the list, as the tabs pattern asks. */
export const TabsContent = ({
  keepMounted,
  style,
  ...rest
}: TabsContentProps) => {
  const keepAll = use(KeepMounted);
  return (
    <TabsPanelPrimitive
      {...rest}
      keepMounted={keepMounted ?? keepAll}
      render={(props: Record<string, unknown>) =>
        renderElement("div", { ...props, "data-slot": "tabs-content" })
      }
      className={className(styles.panel, focusRing, style)}
    />
  );
};

// ---- TabsNav -------------------------------------------------------------------------------------------

/** Where a TabsLink is drawn: in the row; unseen, for its width; as the fold's menu item; on its button. */
type Place = "row" | "ghost" | "menu" | "trigger";

const PlaceContext = createContext<Place>("row");
const NavVariant = createContext<TabsVariant>("default");
const Small = createContext(false);

const KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/** The link to move to from `at` for `key`, along the reading direction; null when it stays. */
const nextLink = (
  links: HTMLElement[],
  at: number,
  key: string,
  rtl: boolean
) => {
  if (key === "Home") {
    return links[0] ?? null;
  }
  if (key === "End") {
    return links.at(-1) ?? null;
  }
  const forward = (key === "ArrowRight") !== rtl;
  const step = forward ? 1 : -1;
  return links[(at + step + links.length) % links.length] ?? null;
};

/** Left and right, Home and End move focus along the row of links. */
const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
  if (!KEYS.has(event.key)) {
    return;
  }
  const row = event.currentTarget.closest<HTMLElement>("[data-tabs-row]");
  if (row === null) {
    return;
  }
  const links = [...row.querySelectorAll<HTMLElement>("[data-slot=tabs-link]")];
  const at = links.indexOf(event.currentTarget);
  if (at === -1) {
    return;
  }
  const rtl = getComputedStyle(row).direction === "rtl";
  const next = nextLink(links, at, event.key, rtl);
  if (next !== null) {
    event.preventDefault();
    next.focus();
  }
};

/**
 * Keeps the form out of sight out of reach too: the row's links or the fold's button are inert while
 * the CSS has moved them away. It only reads which one shows; it draws nothing, so the page is right
 * before it runs and without script.
 */
const watchFold = (box: HTMLElement | null) => {
  const wide = box?.querySelector<HTMLElement>("[data-tabs-wide]");
  const row = box?.querySelector<HTMLElement>("[data-tabs-row]");
  const fold = box?.querySelector<HTMLElement>("[data-tabs-fold]");
  const read = () => {
    if (!box || !wide || !row || !fold) {
      return;
    }
    const folded =
      wide.getBoundingClientRect().width - box.getBoundingClientRect().width >=
      1;
    row.inert = folded;
    fold.inert = !folded;
    box.toggleAttribute("data-folded", folded);
  };
  read();
  const observer = new ResizeObserver(read);
  for (const element of [box, wide]) {
    if (element) {
      observer.observe(element);
    }
  }
  return () => {
    observer.disconnect();
  };
};

/** The fold: the button says the current view (or the nav's name), its menu holds every view. */
const Fold = ({
  label,
  segmented,
  children,
}: {
  label: string;
  segmented: boolean;
  children: ReactNode;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button size="sm" variant={segmented ? "outline" : "ghost"}>
        <span>
          <PlaceContext value="trigger">{children}</PlaceContext>
          <span {...stylex.props(navStyles.fallback)}>{label}</span>
        </span>
        <Icon icon={ChevronDownIcon} />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start">
      <PlaceContext value="menu">{children}</PlaceContext>
    </DropdownMenuContent>
  </DropdownMenu>
);

/** A row of links that looks like Tabs, folding to one menu button where they do not fit. */
export const TabsNav = ({
  "aria-label": label,
  variant = "default",
  size: navSize = "default",
  children,
  style,
}: TabsNavProps) => {
  const segmented = variant === "default";
  const list = stylex.props(
    tabsRowMarker,
    styles.list,
    segmented && segmentedStyles.track,
    segmented && styles.listDefault
  );
  return (
    <NavVariant value={variant}>
      <Small value={navSize === "sm"}>
        <nav
          aria-label={label}
          data-slot="tabs-nav"
          {...stylex.props(styles.root, style)}
        >
          <div aria-hidden="true" inert {...stylex.props(navStyles.ghost)}>
            <div className={list.className}>
              <PlaceContext value="ghost">{children}</PlaceContext>
            </div>
          </div>
          <div ref={watchFold} {...stylex.props(navStyles.box)}>
            <div data-tabs-wide="" {...stylex.props(navStyles.wide)}>
              <div
                ref={segmented ? watchSegmentRow : watchLineRow}
                data-tabs-row=""
                className={list.className}
              >
                {children}
                {!segmented && (
                  <span
                    aria-hidden="true"
                    data-tab-glide=""
                    {...stylex.props(styles.glide)}
                  />
                )}
              </div>
              <div data-tabs-fold="" {...stylex.props(navStyles.fold)}>
                <div {...stylex.props(navStyles.foldStart)}>
                  <Fold label={label} segmented={segmented}>
                    {children}
                  </Fold>
                </div>
              </div>
            </div>
          </div>
        </nav>
      </Small>
    </NavVariant>
  );
};

/** The link given with `asChild`, and its words; else the TabsLink's own words and no element. */
const slotOf = (
  asChild: boolean | undefined,
  children: ReactNode
): { words: ReactNode; element?: ReactElement<Record<string, unknown>> } => {
  if (
    asChild !== true ||
    !isValidElement<Record<string, unknown> & { children?: ReactNode }>(
      children
    )
  ) {
    return { words: children };
  }
  const { children: words, ...own } = children.props;
  return { words, element: createElement(children.type, own) };
};

/** A view as an item of the fold's menu: still a link, with the dot when current. */
const MenuLink = ({
  words,
  element,
  href,
  icon,
  current,
}: {
  words: ReactNode;
  element: ReactElement<Record<string, unknown>> | undefined;
  href: string | undefined;
  icon: IconData | undefined;
  current: boolean;
}) => (
  <MenuItemPrimitive
    label={typeof words === "string" ? words : undefined}
    aria-current={current ? "page" : undefined}
    {...stylex.props(menuStyles.item, navStyles.link)}
    render={(props: Record<string, unknown>) =>
      renderElement("a", { ...props, href }, element)
    }
  >
    {icon !== undefined && (
      <MenuItemIcon {...stylex.props(menuStyles.icon)}>
        <Icon icon={icon} />
      </MenuItemIcon>
    )}
    <span
      {...stylex.props(menuStyles.text, icon === undefined && menuStyles.inset)}
    >
      {words}
    </span>
    {current && <span aria-hidden="true" {...stylex.props(menuStyles.dot)} />}
  </MenuItemPrimitive>
);

/** A link's look in the row: a tab or a segment, chosen when current. */
const lookOf = (segmented: boolean, current: boolean) =>
  stylex.props(
    styles.tab,
    navStyles.link,
    segmented && styles.segment,
    !current && styles.live,
    segmented && !current && styles.segmentLive,
    current && (segmented ? segmentedStyles.chosen : styles.chosen),
    segmented ? focusRingInset : [focusMarker, focusCarrier]
  );

/** A view in the row: drawn as a tab, the current one chosen. */
const RowLink = ({
  words,
  element,
  href,
  icon,
  current,
  segmented,
  small,
}: {
  words: ReactNode;
  element: ReactElement<Record<string, unknown>> | undefined;
  href: string | undefined;
  icon: IconData | undefined;
  current: boolean;
  segmented: boolean;
  small: boolean;
}) => {
  const look = lookOf(segmented, current);
  // Small, a link that is not current shows its icon alone, its words its tooltip.
  const away = small && !current && icon !== undefined;
  const inside =
    icon === undefined ? (
      words
    ) : (
      <Inside icon={icon} away={away}>
        {words}
      </Inside>
    );
  const own = {
    href,
    "aria-current": current ? "page" : undefined,
    "data-slot": "tabs-link",
    // On each link, not the row: a nav is not a control and takes no key handler of its own.
    onKeyDown: moveFocus,
    className: look.className,
    children: (
      <>
        <span
          aria-hidden="true"
          {...stylex.props(
            styles.target,
            segmented && styles.targetSegment,
            away &&
              (segmented ? navStyles.targetIconSegment : navStyles.targetIcon)
          )}
        />
        {segmented ? (
          inside
        ) : (
          <span
            {...stylex.props(
              focusLabel,
              styles.label,
              icon !== undefined && navStyles.inside
            )}
          >
            {inside}
          </span>
        )}
      </>
    ),
  };
  if (!(small && icon !== undefined && typeof words === "string")) {
    return renderElement("a", own, element);
  }
  // Kept on every small link with an icon, and opened only while its words are away, so a link
  // stays one element as it becomes current and its words ease in. The tooltip shows the link's
  // own name, so it is not also its description ("Data, Data").
  return (
    <Tooltip disabled={!away}>
      <TooltipTriggerPrimitive
        render={({
          "aria-describedby": _description,
          ...trigger
        }: Record<string, unknown>) =>
          renderElement("a", mergeProps(trigger, own), element)
        }
      />
      <TooltipContent data-agent-hidden="">{words}</TooltipContent>
    </Tooltip>
  );
};

/** One view's link: a short noun ("Runs"), `current` on the one you are on. */
export const TabsLink = ({
  children,
  icon,
  href,
  asChild,
  current = false,
}: TabsLinkProps) => {
  const place = use(PlaceContext);
  const segmented = use(NavVariant) === "default";
  const small = use(Small);
  const { words, element } = slotOf(asChild, children);
  if (place === "menu") {
    return (
      <MenuLink
        words={words}
        element={element}
        href={href}
        icon={icon}
        current={current}
      />
    );
  }
  if (place === "trigger") {
    return current ? <span>{words}</span> : null;
  }
  if (place === "ghost") {
    const away = small && !current && icon !== undefined;
    return (
      <span {...stylex.props(styles.tab, segmented && styles.segment)}>
        {icon === undefined ? (
          words
        ) : (
          <Inside icon={icon} away={away}>
            {words}
          </Inside>
        )}
      </span>
    );
  }
  return (
    <RowLink
      words={words}
      element={element}
      href={href}
      icon={icon}
      current={current}
      segmented={segmented}
      small={small}
    />
  );
};
