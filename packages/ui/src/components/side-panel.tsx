// Side panel: the details of one thing beside a page, in sections:
// on the high lift, the system's corner, one start edge for everything in
// it. It scrolls on its own, a landmark (`<aside>`) named by its `aria-label`. Its header folds as
// it scrolls: the bar stays and gains its hairline, and the views slide into the bar as icons. Its
// content is one SidePanelContent per view, or one alone when it has none.
//
//   <SidePanel aria-label="Agent" defaultValue="settings">
//     <SidePanelHeader title="Weekly pipeline digest" views={[...]} actions={...} onClose={close} />
//     <SidePanelContent value="settings">
//       <SidePanelSection title="Triggers">
//         <SidePanelSectionAdd onClick={openTriggers}>Add trigger</SidePanelSectionAdd>
//       </SidePanelSection>
//     </SidePanelContent>
//   </SidePanel>
//
// Beside a page, put it in a ResizablePanel or a grid column of {side-panel-width}; on a phone, in a
// Sheet with `framed={false}`. A shell that seats it (beside its page, or in its own sheet) says so
// with SidePanelPlacementProvider. Every value is a token. A caller may set layout only.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  TabsList as TabsListPrimitive,
  TabsPanel as TabsPanelPrimitive,
  Tabs as TabsPrimitive,
  TabsTab as TabsTabPrimitive,
} from "@ui-sdk/react/tabs";
import type { TabsTabState } from "@ui-sdk/react/tabs";
import {
  createContext,
  Fragment,
  use,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";

import { useI18n } from "../lib/i18n";
import { Icon, Maximize2Icon, MinusIcon, PlusIcon, XIcon } from "../lib/icons";
import type { IconData } from "../lib/icons";
import {
  focusRing,
  focusRingInset,
  focusRingText,
  scrollbarHidden,
  tapTarget,
  visuallyHidden,
} from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { durations } from "../lib/tokens.values";
import { className, isBlank } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars, sidePanelCardMarker } from "../lib/vars.stylex";
import { Button } from "./button";
import { ghostVars } from "./button.stylex";
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "./item";
import { Skeleton } from "./skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

const HOVER = media.hover;
const FORCED = media.forcedColors;
const COARSE = media.pointerCoarse;

// ---- Where it stands -----------------------------------------------------------------------------

/**
 * Where a shell seats the panel: `none`, on its own; `beside`, flush with the shell's page card;
 * `sheet`, in the shell's own sheet, whose close closes it.
 */
export type SidePanelPlacement = "none" | "beside" | "sheet";

const PlacementContext = createContext<SidePanelPlacement>("none");

/** Every prop a SidePanelPlacementProvider takes. */
interface SidePanelPlacementProviderProps {
  /** Where the panels inside stand. */
  value: SidePanelPlacement;
  /** What the shell seats: a SidePanel. */
  children: ReactNode;
}

/**
 * Tells the SidePanel inside where a shell seats it. Seated, the panel is unframed unless `framed`
 * is given, and its ground is the shell card's; in a sheet its header leaves out its close button,
 * since the sheet's own closes it.
 */
export const SidePanelPlacementProvider = ({
  value,
  children,
}: SidePanelPlacementProviderProps) => (
  <PlacementContext value={value}>{children}</PlacementContext>
);

// ---- What the parts share ------------------------------------------------------------------------

interface PanelState {
  /** Something has scrolled under the bar: it shows its hairline. */
  scrolled: boolean;
  /** The views have reached the bar: they stand in it as icons. */
  folded: boolean;
  /** The panel's scroller, which the parts watch. */
  scroller: RefObject<HTMLDivElement | null>;
  /** The panel has views (tabs), so its content is one SidePanelContent per view. */
  hasViews: boolean;
  /** Seated by a shell: the bar and the views strip stand on the shell card's ground. */
  seated: boolean;
  /** What stands behind the head (SidePanel's `cover`). */
  cover: ReactNode;
  setScrolled: (scrolled: boolean) => void;
  setFolded: (folded: boolean) => void;
}

const PanelContext = createContext<PanelState | null>(null);

const usePanel = (): PanelState => {
  const state = use(PanelContext);
  if (state === null) {
    throw new Error("A side panel's parts go inside a SidePanel.");
  }
  return state;
};

// ---- The panel -----------------------------------------------------------------------------------

/** Every prop a SidePanel takes. */
export interface SidePanelProps {
  /** Its header, then its content: a SidePanelHeader, then a SidePanelContent for each view. */
  children: ReactNode;
  /** What it is about, as a screen reader names the landmark ("Report details"). */
  "aria-label": string;
  /** The view shown at first, when it has views and holds its own. */
  defaultValue?: string;
  /** The view shown now, when your code holds it. Pair it with `onValueChange`. */
  value?: string;
  /** Runs when a view is chosen, with its value. */
  onValueChange?: (value: string) => void;
  /**
   * Stand on its own: the raised ground, the high lift and the corner. Off inside a Sheet, which
   * draws its own. Seated by a shell (SidePanelPlacementProvider) it is off unless given.
   */
  framed?: boolean;
  /**
   * What stands behind the head of the one thing a page is about, reaching up behind the bar: a
   * faint picture or texture of the product's. Decoration only, hidden from a screen reader.
   */
  cover?: ReactNode;
  /** Layout only: width, height and where it sits. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  // The head's top-end actions, close last: small buttons a gap apart, never a line between.
  actions: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space[2],
  },
  panel: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    minWidth: 0,
    minHeight: 0,
    height: "100%",
    overflow: "clip",
    fontFamily: font.sans,
    color: colors.bodyForeground,
    // Its own direction for what scrolls inside: a sticky bar and views, measured against it.
    containerType: "inline-size",
  },
  framed: {
    backgroundColor: colors.card,
    boxShadow: shadow.lg,
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    outline: { default: "none", [FORCED]: "1px solid CanvasText" },
  },
  scroller: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "auto",
  },
  tabs: { display: "contents" },
  // Folded views need room to reach the bar's line, however short the panel's content.
  scrollerFolded: { paddingBlockEnd: sizes.sidePanelBar },
});

/** The side panel: a landmark that scrolls under its folding header. */
export const SidePanel = ({
  children,
  "aria-label": label,
  defaultValue,
  value,
  onValueChange,
  framed: framedGiven,
  cover,
  style,
}: SidePanelProps) => {
  // Seated by a shell, it takes the shell's frame; given, `framed` wins.
  const placement = use(PlacementContext);
  const framed = framedGiven ?? placement === "none";
  const scroller = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [folded, setFolded] = useState(false);
  const hasViews = defaultValue !== undefined || value !== undefined;
  const state = {
    scrolled,
    folded,
    scroller,
    hasViews,
    seated: placement !== "none",
    cover,
    setScrolled,
    setFolded,
  };
  const inner = (
    <div
      ref={scroller}
      data-slot="side-panel-scroller"
      {...stylex.props(
        styles.scroller,
        folded && styles.scrollerFolded,
        scrollbarHidden
      )}
    >
      {children}
    </div>
  );
  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <PanelContext value={state}>
      <aside
        aria-label={label}
        data-slot="side-panel"
        {...stylex.props(styles.panel, framed && styles.framed, style)}
      >
        {hasViews ? (
          <TabsPrimitive
            defaultValue={defaultValue}
            value={value}
            onValueChange={(next: string | null) => {
              if (next !== null) {
                onValueChange?.(next);
              }
            }}
            {...stylex.props(styles.tabs)}
          >
            {inner}
          </TabsPrimitive>
        ) : (
          inner
        )}
      </aside>
    </PanelContext>
  );
};

// ---- The header ----------------------------------------------------------------------------------

/** One view of the thing: a tab with an icon and a word. */
export interface SidePanelView {
  /** Pairs the tab with the SidePanelContent of the same `value`. */
  value: string;
  /** Its word, a short noun ("Settings"). It stays its name when only the icon shows. */
  label: string;
  /** Its icon: it alone stands for the view once the head has folded. */
  icon: IconData;
}

/** Every prop a SidePanelHeader takes. */
export interface SidePanelHeaderProps {
  /**
   * The thing's name, in sentence case ("Weekly pipeline digest"). The panel's heading. Left out,
   * with no `icon`, `description` or `meta`, there is no head at all: the views stand alone at the
   * panel's top (a note's side panel), and the SidePanel's `aria-label` names the panel.
   */
  title?: string;
  /** One line about it: what it does or holds. */
  description?: ReactNode;
  /** The thing's own icon, in an IconTile, above the title. */
  icon?: ReactNode;
  /** Who and when, each a short part, a small dot between them ("By Amara Okafor", "Updated 18h ago"). */
  meta?: ReactNode[];
  /** In the bar: the panel's own buttons, `sm`, the main one first ("Run agent", "Share", more). */
  actions?: ReactNode;
  /**
   * Shows a close button at the bar's end, a ghost icon Button named by the I18nProvider's
   * `sidePanel.close`. Runs when it is pressed. Left out in a shell's sheet, whose own close closes it.
   */
  onClose?: () => void;
  /** The thing's views, as tabs under its head. The SidePanel needs a `defaultValue` or `value`. */
  views?: SidePanelView[];
  /** What the views are of, as a screen reader names the tab list. Left out, `sidePanel.views`. */
  viewsLabel?: string;
  /**
   * The level of the title's heading.
   * @default 2
   */
  level?: 1 | 2;
  /**
   * The thing is not there yet (a page's first paint): the title, and the line under it when
   * `description` is given (even empty), are quiet placeholders in their own lines, so the head
   * keeps its height.
   * @default false
   */
  loading?: boolean;
}

const headerStyles = stylex.create({
  bar: {
    position: "sticky",
    top: 0,
    zIndex: 1,
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space["2"],
    // Each control's touch target reaches the middle of the gap to the next (tapTarget).
    "--tap-room-inline": `calc(${space["2"]} / 2)`,
    boxSizing: "border-box",
    height: sizes.sidePanelBar,
    paddingInline: space["2"],
    backgroundColor: colors.card,
    // The hairline is there from the start, unseen; it shows once something scrolls under the bar.
    borderBlockEndWidth: sizes.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: "transparent",
    transitionProperty: "border-color",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  // Seated by a shell: the bar and the views strip on the shell card's ground, as the panel around them.
  seated: { backgroundColor: colors.sidePanelSeated },
  barScrolled: { borderBlockEndColor: colors.border },
  // Over the head's cover, the bar is clear until something scrolls under it, so the cover reaches
  // the panel's top behind the close.
  barClear: { backgroundColor: "transparent" },
  // A bar that holds nothing (no actions, no close) takes no room: it stands just above the views,
  // over the room they already have, and is there only for them to fold into once they reach the
  // panel's top. With no views there is no bar at all.
  barBare: {
    marginBlockEnd: `calc(-1 * ${sizes.sidePanelBar})`,
    pointerEvents: "none",
  },
  // The first sentinel: 1px under the bar, so anything passing under it is seen.
  sentinel: {
    flexShrink: 0,
    height: sizes.hairline,
    marginBlockEnd: `calc(-1 * ${sizes.hairline})`,
    pointerEvents: "none",
  },
  head: {
    position: "relative",
    display: "grid",
    justifyItems: "start",
    rowGap: space["1"],
    paddingBlockStart: space.sidePanelPad,
    paddingInline: space.sidePanelPad,
    minWidth: 0,
  },
  // Beside a page in a shell, under its bar and with no views: the head reaches side-panel-head
  // from the panel's top to its line, as a page band beside it does, so the two lines are one.
  headBeside: {
    minHeight: `calc(${sizes.sidePanelHead} - ${sizes.sidePanelBar} - ${space.sidePanelPad})`,
  },
  // The cover reaches up behind the bar, so it starts at the panel's top.
  cover: {
    position: "absolute",
    insetBlockStart: `calc(-1 * ${sizes.sidePanelBar})`,
    insetBlockEnd: 0,
    insetInline: 0,
    overflow: "hidden",
    pointerEvents: "none",
    display: { default: "block", [FORCED]: "none" },
  },
  // With no bar above the head, the cover starts at the head's own top.
  coverTopmost: { insetBlockStart: 0 },
  tile: { position: "relative", marginBlockEnd: space["3"] },
  title: {
    position: "relative",
    margin: 0,
    fontFamily: font.serif,
    fontSize: font.headingSm,
    lineHeight: font.headingSmLine,
    fontWeight: font.weightNormal,
    color: colors.foreground,
    overflowWrap: "anywhere",
  },
  description: {
    position: "relative",
    margin: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  // While loading: the title's line, one serif line tall, a placeholder its letters' height across it.
  titleWaitLine: {
    display: "flex",
    alignItems: "center",
    height: font.headingSmLine,
  },
  // Fixed widths: the head's lines size to their words, so a share of them would be nothing.
  titleWait: { display: "block", width: "10rem", maxWidth: "100%" },
  descriptionWait: { display: "block", width: "14rem", maxWidth: "100%" },
  meta: {
    position: "relative",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space["2"],
    rowGap: space["1"],
    marginBlockStart: space["2"],
    fontSize: sizes.sidePanelText,
    lineHeight: sizes.sidePanelTextLine,
    color: colors.mutedForeground,
  },
  metaPart: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    minWidth: 0,
  },
  dot: {
    flexShrink: 0,
    width: sizes.sidePanelDot,
    height: sizes.sidePanelDot,
    borderRadius: radius.circle,
    backgroundColor: "currentColor",
  },
  // The second sentinel, just above the views: once it passes the bar's foot, they have folded.
  viewsSentinel: {
    flexShrink: 0,
    height: sizes.hairline,
    marginBlockStart: space["5"],
    marginBlockEnd: `calc(-1 * ${sizes.hairline})`,
    pointerEvents: "none",
  },
  // The views: one tab list in the flow that sticks in the bar's middle, above it.
  views: {
    position: "sticky",
    top: `calc((${sizes.sidePanelBar} - ${sizes.controlXs}) / 2)`,
    zIndex: 2,
    display: "flex",
    alignSelf: "flex-start",
    alignItems: "center",
    gap: space["1"],
    maxWidth: `calc(100% - 2 * ${space.sidePanelPad})`,
    marginInline: space.sidePanelPad,
    // Room for a finger's target round each tab, without a scrollbar; each reaches the middle of
    // the gap to the next (tapTarget).
    overflow: "visible",
    "--tap-room-inline": `calc(${space["1"]} / 2)`,
  },
  tab: {
    [iconVars.size]: sizes.iconSm,
    [iconVars.stroke]: sizes.iconStroke,
    position: "relative",
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["1"],
    boxSizing: "border-box",
    height: sizes.controlXs,
    minWidth: sizes.controlXs,
    margin: 0,
    paddingBlock: 0,
    paddingInline: `calc(${space["2"]} - ${sizes.hairline})`,
    // A real border, unseen, so forced colours can mark the chosen view with it.
    borderWidth: sizes.hairline,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    fontFamily: font.sans,
    fontSize: sizes.sidePanelText,
    lineHeight: sizes.sidePanelTextLine,
    fontWeight: font.weightMedium,
    whiteSpace: "nowrap",
    cursor: "pointer",
    color: colors.mutedForeground,
    backgroundColor: "transparent",
    transitionProperty: "background-color, color",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
  },
  tabLive: {
    color: {
      default: colors.mutedForeground,
      ":hover": { default: null, [HOVER]: colors.foreground },
    },
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accent },
    },
  },
  tabChosen: {
    color: colors.foreground,
    backgroundColor: colors.muted,
    // Forced colours drop the fill: the border, in the system's highlight, marks the chosen view.
    borderColor: { default: "transparent", [FORCED]: "Highlight" },
  },
  // Folded: the tab is its icon alone, a 28px square, and its word stays its name.
  tabFolded: {
    paddingInline: 0,
    width: sizes.controlXs,
    justifyContent: "center",
  },
  words: {},
  // The line that closes the head, across the whole panel.
  line: {
    flexShrink: 0,
    height: sizes.hairline,
    marginBlockStart: space["4"],
    backgroundColor: colors.border,
  },
  lineAlone: { marginBlockStart: space.sidePanelPad },
  // With no head and no bar, the views are the head: they never fold (there is nothing above them
  // to scroll past), they keep their words, and they stand in a strip at the panel's top, the bar's
  // height, that stays while the content scrolls under it, the closing line its foot.
  viewsStrip: {
    position: "sticky",
    top: 0,
    zIndex: 2,
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    backgroundColor: colors.card,
  },
  viewsStripRow: {
    display: "flex",
    alignItems: "center",
    minHeight: sizes.sidePanelBar,
  },
  viewsAlone: { position: "static", alignSelf: "center" },
  lineFoot: { marginBlockStart: 0 },
});

const reduced = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const titleHeadings = { 1: "h1", 2: "h2" } as const;

const tabsOf = (list: HTMLElement | null): HTMLElement[] =>
  list === null
    ? []
    : [...list.children].filter((child) => child instanceof HTMLElement);

// Above the scroller's top, shrunk by the root margin: the sentinel has passed under the bar.
const above = (entry: IntersectionObserverEntry): boolean =>
  !entry.isIntersecting &&
  entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0);

/** The system's curve, for the tabs' slide: the CSS variable the `duration.ease` token names. */
const easing = (): string => {
  const name = duration.ease.slice("var(".length, -1);
  const ease = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return ease === "" ? "ease-out" : ease;
};

interface FoldRefs {
  bar: RefObject<HTMLDivElement | null>;
  top: RefObject<HTMLDivElement | null>;
  fold: RefObject<HTMLDivElement | null>;
  list: RefObject<HTMLDivElement | null>;
}

/**
 * Two sentinels, watched against the scroller: one under the bar (something has scrolled under
 * it), one above the views (they have reached the bar's foot). No scroll handler. As the views
 * fold or unfold, each tab slides from where it stood, and the words fade back as they return.
 */
const useFold = ({ bar, top, fold, list }: FoldRefs) => {
  const { folded, scroller, setScrolled, setFolded } = usePanel();
  // Where each tab stood before the fold changed, so it can slide from there.
  const before = useRef<number[] | null>(null);

  useEffect(() => {
    const root = scroller.current;
    const watching: IntersectionObserver[] = [];
    // Without a scroller, or an observer, nothing folds: the head stays as it is.
    if (root !== null && typeof IntersectionObserver !== "undefined") {
      const barHeight = bar.current?.offsetHeight ?? 0;
      const watchTop = new IntersectionObserver(
        ([entry]) => {
          if (entry !== undefined) {
            setScrolled(above(entry));
          }
        },
        { root, rootMargin: `-${barHeight}px 0px 0px 0px` }
      );
      const watchFold = new IntersectionObserver(
        ([entry]) => {
          if (entry === undefined) {
            return;
          }
          before.current = tabsOf(list.current).map(
            (tab) => tab.getBoundingClientRect().left
          );
          setFolded(above(entry));
        },
        // They fold as their top meets the bar's foot, not at the bar's middle: until they fold
        // they carry their words, and from the bar's foot to its middle those words lay over the
        // bar's own buttons.
        { root, rootMargin: `-${barHeight}px 0px 0px 0px` }
      );
      if (top.current !== null) {
        watchTop.observe(top.current);
      }
      if (fold.current !== null) {
        watchFold.observe(fold.current);
      }
      watching.push(watchTop, watchFold);
    }
    return () => {
      for (const observer of watching) {
        observer.disconnect();
      }
    };
  }, [scroller, bar, top, fold, list, setScrolled, setFolded]);

  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    if (was === null || reduced()) {
      return;
    }
    const curve = easing();
    for (const [index, tab] of tabsOf(list.current).entries()) {
      const from = was[index];
      if (from === undefined) {
        continue;
      }
      const dx = from - tab.getBoundingClientRect().left;
      if (Math.abs(dx) > 0.5) {
        tab.animate(
          [
            { transform: `translateX(${dx}px)` },
            { transform: "translateX(0)" },
          ],
          { duration: durations.ui, easing: curve }
        );
      }
      if (!folded) {
        tab
          .querySelector("[data-side-panel-view-words]")
          ?.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: durations.ui,
            easing: curve,
          });
      }
    }
  }, [folded, list]);

  // Folded, the views stand on the bar's line, as its buttons do. A short panel scrolled to its end
  // can leave them short of it: the panel has room for them then (SidePanel), and that same scroll
  // goes on to where they stand on the line.
  useLayoutEffect(() => {
    const root = scroller.current;
    const views = list.current;
    if (!folded || root === null || views === null) {
      return;
    }
    const stick = Number(getComputedStyle(views).top.replace("px", ""));
    const gap =
      views.getBoundingClientRect().top -
      root.getBoundingClientRect().top -
      stick;
    const room = root.scrollHeight - root.clientHeight - root.scrollTop;
    // Only where the content alone could not reach the line (the room the fold adds is its end
    // padding): a long panel folding mid-scroll is never moved.
    const added = Number(
      getComputedStyle(root).paddingBlockEnd.replace("px", "")
    );
    if (gap > 0.5 && room >= gap && room - added < gap) {
      root.scrollBy({ top: gap });
    }
  }, [folded, scroller, list]);
};

interface BarProps {
  bar: RefObject<HTMLDivElement | null>;
  actions?: ReactNode;
  onClose?: () => void;
  bare?: boolean;
  clear?: boolean;
}

/** The bar: the panel's actions, then close. */
const Bar = ({
  bar,
  actions,
  onClose,
  bare = false,
  clear = false,
}: BarProps) => {
  const { scrolled, folded, seated } = usePanel();
  const { close } = useI18n().sidePanel;
  // A bare bar shows its hairline once the views have folded into it; nothing else passes under it sooner.
  const lined = bare ? folded : scrolled;
  return (
    <div
      ref={bar}
      data-slot="side-panel-bar"
      data-scrolled={lined ? "" : undefined}
      {...stylex.props(
        headerStyles.bar,
        seated && headerStyles.seated,
        bare && headerStyles.barBare,
        clear && !scrolled && headerStyles.barClear,
        lined && headerStyles.barScrolled
      )}
    >
      <div {...stylex.props(styles.actions)}>
        {actions}
        {onClose !== undefined && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={close}
            onClick={onClose}
          >
            <Icon icon={XIcon} />
          </Button>
        )}
      </div>
    </div>
  );
};

/** Who and when: short parts with a small dot between them. */
const Meta = ({ meta }: { meta: ReactNode[] }) => (
  <div {...stylex.props(headerStyles.meta)}>
    {meta.map((part, index) => (
      <Fragment key={index}>
        {index > 0 && <span aria-hidden {...stylex.props(headerStyles.dot)} />}
        <span {...stylex.props(headerStyles.metaPart)}>{part}</span>
      </Fragment>
    ))}
  </div>
);

interface HeadProps extends Pick<
  SidePanelHeaderProps,
  "title" | "description" | "icon" | "meta" | "level" | "loading"
> {
  topmost: boolean;
  beside: boolean;
}

/** The head: the cover behind it, the tile, the title, its line, and who and when. */
const Head = ({
  title,
  description,
  icon,
  meta,
  level = 2,
  topmost,
  loading = false,
  beside,
}: HeadProps) => {
  const { cover } = usePanel();
  const Heading = titleHeadings[level];
  // While loading, the title and its line are placeholders in their own lines, so the head keeps
  // its height; who and when wait.
  const titleLine = loading ? (
    <div {...stylex.props(headerStyles.titleWaitLine)}>
      <span {...stylex.props(headerStyles.titleWait)}>
        <Skeleton size="lg" />
      </span>
    </div>
  ) : (
    title !== undefined && (
      <Heading {...stylex.props(headerStyles.title)}>{title}</Heading>
    )
  );
  const descriptionLine = loading
    ? description !== undefined && (
        <p {...stylex.props(headerStyles.description)}>
          <span {...stylex.props(headerStyles.descriptionWait)}>
            <Skeleton size="sm" />
          </span>
        </p>
      )
    : !isBlank(description) && (
        <p {...stylex.props(headerStyles.description)}>{description}</p>
      );
  return (
    <div
      data-slot="side-panel-header"
      aria-busy={loading ? "true" : undefined}
      {...stylex.props(headerStyles.head, beside && headerStyles.headBeside)}
    >
      {!isBlank(cover) && (
        <div
          aria-hidden
          data-slot="side-panel-cover"
          {...stylex.props(
            headerStyles.cover,
            topmost && headerStyles.coverTopmost
          )}
        >
          {cover}
        </div>
      )}
      {!isBlank(icon) && (
        <span {...stylex.props(headerStyles.tile)}>{icon}</span>
      )}
      {titleLine}
      {descriptionLine}
      {!loading && meta !== undefined && meta.length > 0 && (
        <Meta meta={meta} />
      )}
    </div>
  );
};

interface ViewsProps {
  views: SidePanelView[];
  /** The tab list's name; left out, the I18nProvider's `sidePanel.views`. */
  label: string | undefined;
  list: RefObject<HTMLDivElement | null>;
  alone?: boolean;
}

/** The views: one tab list that sticks in the bar and shows only its icons there. */
const Views = ({ views, label, list, alone = false }: ViewsProps) => {
  const { folded: foldedHere } = usePanel();
  const { views: named } = useI18n().sidePanel;
  // Alone at the panel's top they never fold.
  const folded = foldedHere && !alone;
  return (
    <TabsListPrimitive
      ref={list}
      aria-label={label ?? named}
      data-folded={folded ? "" : undefined}
      {...stylex.props(headerStyles.views, alone && headerStyles.viewsAlone)}
    >
      {views.map((view) => (
        <TabsTabPrimitive
          key={view.value}
          value={view.value}
          title={folded ? view.label : undefined}
          className={(state: TabsTabState) =>
            className(
              headerStyles.tab,
              !state.selected && headerStyles.tabLive,
              state.selected && headerStyles.tabChosen,
              folded && headerStyles.tabFolded,
              focusRing
            )
          }
        >
          <span aria-hidden="true" {...stylex.props(tapTarget)} />
          <Icon icon={view.icon} />
          <span
            data-side-panel-view-words=""
            {...stylex.props(folded ? visuallyHidden : headerStyles.words)}
          >
            {view.label}
          </span>
        </TabsTabPrimitive>
      ))}
    </TabsListPrimitive>
  );
};

/** With no head and no bar, the views alone at the panel's top: a strip that stays, its line its foot. */
const ViewsStrip = ({ views, label, list }: Omit<ViewsProps, "alone">) => {
  const { seated } = usePanel();
  return (
    <div
      data-slot="side-panel-views-header"
      {...stylex.props(headerStyles.viewsStrip, seated && headerStyles.seated)}
    >
      <div {...stylex.props(headerStyles.viewsStripRow)}>
        <Views views={views} label={label} list={list} alone />
      </div>
      <div
        aria-hidden
        {...stylex.props(headerStyles.line, headerStyles.lineFoot)}
      />
    </div>
  );
};

/** Whether there is any head to draw: a title, an icon, a line or who and when. */
const hasHead = ({
  title,
  icon,
  description,
  meta,
}: Pick<SidePanelHeaderProps, "title" | "icon" | "description" | "meta">) =>
  title !== undefined ||
  !isBlank(icon) ||
  !isBlank(description) ||
  (meta !== undefined && meta.length > 0);

/**
 * The folding header: a bar of actions (the main one, Share, more, then close), the thing's tile,
 * its title in the serif, one line about it, who and when, and its views as quiet tabs. The views
 * are one tab list, never two: it stands in the panel's flow and sticks in the bar, so the head
 * folds with no jump and the keyboard always meets the same tabs.
 */
export const SidePanelHeader = ({
  title,
  description,
  icon,
  meta,
  actions,
  onClose: onCloseGiven,
  views,
  viewsLabel,
  level,
  loading,
}: SidePanelHeaderProps) => {
  const { cover } = usePanel();
  // In a shell's sheet the sheet's own close closes it: one close, not two.
  const placement = use(PlacementContext);
  const onClose = placement === "sheet" ? undefined : onCloseGiven;
  const bar = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const fold = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useFold({ bar, top, fold, list });
  const hasViews = views !== undefined && views.length > 0;
  // With nothing to hold, the bar takes no room above the head: the head is the panel's top.
  const holds = !isBlank(actions) || onClose !== undefined;
  // No title and nothing else of a head: no head, no empty room; the views are the panel's top.
  const headed = hasHead({ title, icon, description, meta });
  if (!headed && !holds && hasViews) {
    return <ViewsStrip views={views} label={viewsLabel} list={list} />;
  }
  return (
    <>
      {holds && (
        <Bar
          bar={bar}
          actions={actions}
          onClose={onClose}
          clear={!isBlank(cover) && headed}
        />
      )}
      {holds && (
        <div ref={top} aria-hidden {...stylex.props(headerStyles.sentinel)} />
      )}
      {headed && (
        <Head
          title={title}
          description={description}
          icon={icon}
          meta={meta}
          level={level}
          topmost={!holds}
          loading={loading}
          beside={placement === "beside" && holds && !hasViews}
        />
      )}
      {!holds && hasViews && <Bar bar={bar} bare />}
      {hasViews && (
        <div
          ref={fold}
          aria-hidden
          {...stylex.props(headerStyles.viewsSentinel)}
        />
      )}
      {hasViews && <Views views={views} label={viewsLabel} list={list} />}
      <div
        aria-hidden
        data-slot="side-panel-header-line"
        {...stylex.props(
          headerStyles.line,
          !hasViews && headerStyles.lineAlone
        )}
      />
    </>
  );
};

// ---- The content ---------------------------------------------------------------------------------

/** Every prop a SidePanelContent takes. */
export interface SidePanelContentProps {
  /** Its sections: SidePanelSection, then a Collapsible for the rarely changed, last. */
  children: ReactNode;
  /** The value of the view it shows, when the panel has views. */
  value?: string;
}

const contentStyles = stylex.create({
  content: {
    display: "grid",
    alignContent: "start",
    rowGap: space.sidePanelGap,
    flexShrink: 0,
    minWidth: 0,
    paddingBlockStart: space.sidePanelPad,
    paddingBlockEnd: space.sidePanelPadEnd,
    paddingInline: space.sidePanelPad,
  },
});

/**
 * The content of one view, or the panel's content when it has none. Its sections stand
 * {side-panel-gap} apart, inset {side-panel-pad} on one start edge, with room under the last so it
 * never ends on the window's edge.
 */
export const SidePanelContent = ({
  children,
  value,
}: SidePanelContentProps) => {
  const { hasViews } = usePanel();
  if (hasViews && value !== undefined) {
    return (
      <TabsPanelPrimitive
        value={value}
        render={<div data-slot="side-panel-content" />}
        {...stylex.props(contentStyles.content, focusRingInset)}
      >
        {children}
      </TabsPanelPrimitive>
    );
  }
  return (
    <div
      data-slot="side-panel-content"
      {...stylex.props(contentStyles.content)}
    >
      {children}
    </div>
  );
};

// ---- A long text ---------------------------------------------------------------------------------

/** Every prop a SidePanelText takes. */
export interface SidePanelTextProps {
  /** The words: a Markdown, or paragraphs. */
  children: ReactNode;
  /**
   * Open at its full height at first.
   * @default false
   */
  defaultOpen?: boolean;
  /**
   * The name of the button that opens it, for what it holds ("Show all the instructions").
   * @default the I18nProvider's `sidePanel.showAll` ("Show all")
   */
  "aria-label"?: string;
}

const textStyles = stylex.create({
  card: {
    position: "relative",
    minWidth: 0,
  },
  body: {
    boxSizing: "border-box",
    paddingBlock: space["4"],
    paddingInlineStart: space.sidePanelPadding,
    // Room for the button in the corner, so no word runs under it.
    paddingInlineEnd: `calc(${sizes.controlXs} + ${space["4"]})`,
    fontSize: sizes.sidePanelText,
    lineHeight: font.textSmLine,
    color: colors.bodyForeground,
  },
  shut: {
    maxHeight: sizes.sidePanelLong,
    overflow: "hidden",
    maskImage: `linear-gradient(to bottom, black calc(100% - ${sizes.sidePanelLongFade}), transparent)`,
  },
  corner: {
    position: "absolute",
    // On the first line's centre, as a heading's line stands.
    top: `calc(${space["4"]} + (${font.textBaseLine} - ${sizes.controlXs}) / 2)`,
    insetInlineEnd: space["2"],
    zIndex: 1,
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    backgroundColor: { default: colors.card, [FORCED]: "Canvas" },
  },
});

/**
 * A long text in a card (an agent's instructions, a note): it stands {side-panel-long} tall, its
 * words fade out at the foot, and a button in its top corner, named by `aria-label`, opens it to
 * its full height and closes it again.
 */
export const SidePanelText = ({
  children,
  defaultOpen = false,
  "aria-label": ariaLabel,
}: SidePanelTextProps) => {
  const words = useI18n().sidePanel;
  const showAll = ariaLabel ?? words.showAll;
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  // Opened by a press, the words it brings are scrolled into view: the card grows below the
  // panel's fold, and only the icon changed where the eye was.
  useEffect(() => {
    if (open && opened.current) {
      body.current?.scrollIntoView({ block: "start" });
    }
    opened.current = true;
  }, [open]);
  return (
    <div data-slot="side-panel-text" {...stylex.props(textStyles.card)}>
      <span {...stylex.props(textStyles.corner)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={showAll}
              aria-expanded={open}
              aria-controls={id}
              onClick={() => {
                setOpen((was) => !was);
              }}
            >
              <Icon icon={open ? MinusIcon : Maximize2Icon} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{showAll}</TooltipContent>
        </Tooltip>
      </span>
      <div
        ref={body}
        id={id}
        data-open={open ? "" : undefined}
        {...stylex.props(textStyles.body, !open && textStyles.shut)}
      >
        {children}
      </div>
    </div>
  );
};

// ---- A section -----------------------------------------------------------------------------------

/** Every prop a SidePanelSection takes. */
export interface SidePanelSectionProps {
  /** Its name, a word or two in sentence case, on one line ("Triggers"). */
  title: string;
  /**
   * One sentence that says what the section is for, in a tooltip on the title, which then wears a
   * dashed underline ("What starts this agent: a schedule, an event or a person."). In one panel,
   * every section has a description or none does, so a lone dashed title never stands out.
   */
  description?: string;
  /** At the end of the title's row: one quiet action, a ghost Button ("Add") or a two-way ToggleGroup. */
  action?: ReactNode;
  /**
   * The heading level of the title, under the panel's own.
   * @default 3
   */
  level?: 2 | 3 | 4;
  /** Layout only: margins. */
  style?: LayoutStyle;
  /**
   * What the card holds: an ItemGroup, a SidePanelText, or fields. Empty, a SidePanelSectionAdd:
   * the one row that adds the first.
   */
  children: ReactNode;
  /**
   * Draw the card round the children. Off for children that draw their own.
   * @default true
   */
  card?: boolean;
}

/** Every prop a SidePanelSectionAdd takes. */
export interface SidePanelSectionAddProps {
  /** Its words, what it adds ("Add trigger"). */
  children: ReactNode;
  /** Runs when the row is pressed. */
  onClick?: () => void;
}

/** The id of the section's title, which names the row that adds its first. */
const SectionContext = createContext<string | undefined>(undefined);

const sectionStyles = stylex.create({
  section: {
    display: "grid",
    rowGap: space.sidePanelLabelGap,
    minWidth: 0,
    fontFamily: font.sans,
  },
  // The title row: 28px, its words inset as far as the card's rows' words.
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["2"],
    boxSizing: "border-box",
    height: sizes.controlXs,
    minWidth: 0,
    paddingInlineStart: space.sidePanelPadding,
  },
  // One line, never clipped: a described title's 44px target reaches past its words.
  title: {
    margin: 0,
    whiteSpace: "nowrap",
    fontSize: sizes.sidePanelText,
    lineHeight: sizes.sidePanelTextLine,
    fontWeight: font.weightMedium,
    color: colors.mutedForeground,
  },
  // The title that explains itself: a dashed underline, a step under the words. Its box stands a
  // step out round the words, into its own margin, so the ring keeps off the letters and clears the
  // dashed underline; the line it sits in stays the same.
  described: {
    margin: `calc(-1 * ${sizes.ringOffsetText})`,
    padding: sizes.ringOffsetText,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    fontWeight: "inherit",
    cursor: "help",
    position: "relative",
    // Its target: the title row's 28px, and a finger's 44px on touch, drawn unseen.
    "::after": {
      content: '""',
      position: "absolute",
      // A short title ("Owner") is narrower than a finger: the target grows to 44px either side.
      left: {
        default: 0,
        [COARSE]: `min(0px, calc((100% - ${sizes.tapTarget}) / 2))`,
      },
      right: {
        default: 0,
        [COARSE]: `min(0px, calc((100% - ${sizes.tapTarget}) / 2))`,
      },
      // Longhands: StyleX drops the inset-block shorthand.
      top: {
        default: `calc((${sizes.sidePanelTextLine} - ${sizes.controlXs}) / 2 + ${sizes.ringOffsetText})`,
        [COARSE]: `calc((${sizes.sidePanelTextLine} - ${sizes.tapTarget}) / 2 + ${sizes.ringOffsetText})`,
      },
      bottom: {
        default: `calc((${sizes.sidePanelTextLine} - ${sizes.controlXs}) / 2 + ${sizes.ringOffsetText})`,
        [COARSE]: `calc((${sizes.sidePanelTextLine} - ${sizes.tapTarget}) / 2 + ${sizes.ringOffsetText})`,
      },
    },
    textDecorationLine: "underline",
    textDecorationStyle: "dashed",
    textDecorationColor: colors.subtleForeground,
    textDecorationThickness: sizes.hairline,
    textUnderlineOffset: sizes.sidePanelDashOffset,
    borderRadius: radius.sm,
    cornerShape: radius.shape,
  },
  // Its one action is quiet, as the title is: a ghost Button in it is muted until the pointer comes.
  end: {
    [ghostVars.ink]: {
      default: colors.mutedForeground,
      ":hover": { default: null, [media.hover]: colors.foreground },
    },
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
  },
  card: {
    minWidth: 0,
    overflow: "clip",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: shadow.md,
    // Forced colours drop the lift: a line keeps the card.
    outline: { default: "none", [FORCED]: "1px solid CanvasText" },
  },
});

const sectionHeadings = { 2: "h2", 3: "h3", 4: "h4" } as const;

/** The title's words: a button that opens its description in a tooltip, or the words alone. */
const SectionTitle = ({
  title,
  description,
}: {
  title: string;
  description: string | undefined;
}) => {
  if (description === undefined || description === "") {
    return title;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          {...stylex.props(sectionStyles.described, focusRingText)}
        >
          {title}
        </button>
      </TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  );
};

/**
 * One section of a side panel. Always the same three things: a
 * quiet title (with a dashed underline when it explains itself in a tooltip), one quiet action at
 * the end of the title's row, and one card under it. Empty, the card is one row that adds the
 * first. The title's words stand on the same line as the words in the card's rows.
 */
export const SidePanelSection = ({
  title,
  description,
  action,
  level = 3,
  style,
  children,
  card = true,
}: SidePanelSectionProps) => {
  const id = useId();
  const Heading = sectionHeadings[level];
  return (
    <section
      aria-labelledby={id}
      data-slot="side-panel-section"
      {...stylex.props(sectionStyles.section, style)}
    >
      <div
        data-slot="side-panel-section-header"
        {...stylex.props(sectionStyles.head)}
      >
        <Heading id={id} {...stylex.props(sectionStyles.title)}>
          <SectionTitle title={title} description={description} />
        </Heading>
        {!isBlank(action) && (
          <div {...stylex.props(sectionStyles.end)}>{action}</div>
        )}
      </div>
      <SectionContext value={id}>
        {card ? (
          <div
            data-slot="side-panel-section-card"
            {...stylex.props(sidePanelCardMarker, sectionStyles.card)}
          >
            {children}
          </div>
        ) : (
          children
        )}
      </SectionContext>
    </section>
  );
};

/** An empty section's card: the one row that adds the first, named by the section's title. */
export const SidePanelSectionAdd = ({
  children,
  onClick,
}: SidePanelSectionAddProps) => {
  const id = use(SectionContext);
  return (
    // A list of one, named by the title.
    <ItemGroup aria-labelledby={id}>
      <Item
        size="xs"
        onClick={() => {
          onClick?.();
        }}
      >
        <ItemMedia>
          <Icon icon={PlusIcon} />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{children}</ItemTitle>
        </ItemContent>
      </Item>
    </ItemGroup>
  );
};
