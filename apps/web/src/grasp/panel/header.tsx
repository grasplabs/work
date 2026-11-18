// PanelHeader: an inspector panel's header (panel.tsx), after Profound's. A bar of actions at the
// top (the main one, Share, more, then close after a short line); under it the object's tile, its
// title in the serif, one line about it, who and when, and its views as quiet tabs, each an icon
// and a word. As the panel scrolls the bar stays: it gains its hairline once anything passes
// under it, and when the views reach it they slide into it as icons only, in one motion, and back.
//
// The views are one tab list, never two: it stands in the panel's flow and sticks in the bar, so
// the head folds with no jump and the keyboard always meets the same tabs.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  TabsList as TabsListPrimitive,
  TabsTab as TabsTabPrimitive,
} from "@ui-sdk/react/tabs";
import type { TabsTabState } from "@ui-sdk/react/tabs";
import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";

import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { Cross, Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { RowListAction } from "../row-list";
import { grasp, media } from "../tokens/tokens.stylex";
import { ms } from "../tokens/tokens.values";
import { useWords, withGiven } from "../words/words";
import { usePanel } from "./context";
import { panelWords } from "./words";

/** One view of the object: a tab with an icon and a word. */
export interface PanelHeaderView {
  /** Pairs the tab with the PanelView of the same `value`. */
  value: string;
  /** Its word, a short noun ("Settings"). It stays its name when only the icon shows. */
  label: string;
  /** Its icon, from the icons entry (`@/components/grasp/icons`): it alone stands for the view once the head has folded. */
  icon: IconData;
}

/** Every prop a PanelHeader takes. */
export interface PanelHeaderProps {
  /** The object's name, in sentence case ("Weekly pipeline digest"). The panel's heading. */
  title: string;
  /** One line about it: what it does or holds. */
  description?: ReactNode;
  /** The object's own icon, in an IconTile, above the title. */
  icon?: ReactNode;
  /** Who and when, each a short part, a small dot between them ("By Amara Okafor", "Updated 18h ago"). */
  meta?: ReactNode[];
  /** In the bar: the panel's own buttons, `xs`, the main one first ("Run agent", "Share", more). */
  actions?: ReactNode;
  /** Shows a close button at the bar's end, after a short line. Runs when it is pressed. */
  onClose?: () => void;
  /**
   * The close button's name.
   * @default "Close"
   */
  closeLabel?: string;
  /** The object's views, as tabs under its head. The Panel needs a `defaultView` or `view`. */
  views?: PanelHeaderView[];
  /**
   * What the views are of, as a screen reader says it.
   * @default "Views"
   */
  viewsLabel?: string;
  /**
   * The level of the title's heading.
   * @default 2
   */
  headingLevel?: 1 | 2;
  /** @deprecated Use `headingLevel`. */
  level?: 1 | 2;
  /**
   * A very faint dither of the light behind the head: for the one object a page is about.
   * @default false
   */
  texture?: boolean;
}

const HOVER = media.hover;

const styles = stylex.create({
  bar: {
    position: "sticky",
    top: 0,
    zIndex: 1,
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "flex-end",
    gap: grasp.space2,
    boxSizing: "border-box",
    height: grasp.inspectorBar,
    paddingInline: grasp.space2,
    backgroundColor: grasp.raised,
    // The hairline is there from the start, unseen; it shows once something scrolls under the bar.
    borderBlockEndWidth: grasp.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: "transparent",
    transitionProperty: "border-color",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  barScrolled: { borderBlockEndColor: grasp.line },
  // A bar that holds nothing (no actions, no close) takes no room: it stands just above the views,
  // over the room they already have, and is there only for them to fold into once they reach the
  // panel's top. With no views there is no bar at all.
  barBare: {
    marginBlockEnd: `calc(-1 * ${grasp.inspectorBar})`,
    pointerEvents: "none",
  },
  divider: {
    flexShrink: 0,
    width: grasp.hairline,
    height: grasp.iconMd,
    backgroundColor: grasp.line,
  },
  // The first sentinel: 1px under the bar, so anything passing under it is seen.
  sentinel: {
    flexShrink: 0,
    height: grasp.hairline,
    marginBlockEnd: `calc(-1 * ${grasp.hairline})`,
    pointerEvents: "none",
  },
  head: {
    position: "relative",
    display: "grid",
    justifyItems: "start",
    rowGap: grasp.space1,
    paddingBlockStart: grasp.inspectorPad,
    paddingInline: grasp.inspectorPad,
    minWidth: 0,
  },
  texture: {
    position: "absolute",
    insetInline: 0,
    top: `calc(-1 * ${grasp.inspectorBar})`,
    bottom: 0,
    pointerEvents: "none",
    opacity: grasp.inspectorDitherStrength,
    backgroundImage: `radial-gradient(120% 90% at 0% 0%, ${grasp.mint}, transparent 70%)`,
    maskImage: `radial-gradient(circle, black ${grasp.composerDot}, transparent calc(${grasp.composerDot} + ${grasp.hairline}))`,
    maskSize: `${grasp.composerDither} ${grasp.composerDither}`,
    maskRepeat: "repeat",
    // Forced colours: no texture.
    display: { default: "block", [media.forced]: "none" },
  },
  // With no bar above the head, the texture starts at the head's own top.
  textureTopmost: { top: 0 },
  tile: { position: "relative", marginBlockEnd: grasp.space3 },
  title: {
    position: "relative",
    margin: 0,
    fontFamily: grasp.fontSerif,
    fontSize: grasp.titleSm,
    lineHeight: grasp.titleSmLine,
    fontWeight: grasp.weightRegular,
    color: grasp.ink,
    overflowWrap: "anywhere",
  },
  description: {
    position: "relative",
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  meta: {
    position: "relative",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: grasp.space2,
    rowGap: grasp.space1,
    marginBlockStart: grasp.space2,
    fontSize: grasp.inspectorText,
    lineHeight: grasp.inspectorTextLine,
    color: grasp.muted,
  },
  metaPart: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
  },
  dot: {
    flexShrink: 0,
    width: grasp.inspectorDot,
    height: grasp.inspectorDot,
    borderRadius: grasp.cornerCircle,
    backgroundColor: "currentColor",
  },
  // The second sentinel, just above the views: once it passes the bar's middle, they have folded.
  viewsSentinel: {
    flexShrink: 0,
    height: grasp.hairline,
    marginBlockStart: grasp.space5,
    marginBlockEnd: `calc(-1 * ${grasp.hairline})`,
    pointerEvents: "none",
  },
  // The views: one tab list in the flow that sticks in the bar's middle, above it.
  views: {
    position: "sticky",
    top: `calc((${grasp.inspectorBar} - ${grasp.controlXs}) / 2)`,
    zIndex: 2,
    display: "flex",
    alignSelf: "flex-start",
    alignItems: "center",
    gap: grasp.space1,
    maxWidth: `calc(100% - 2 * ${grasp.inspectorPad})`,
    marginInline: grasp.inspectorPad,
    // Room for a finger's target round each tab, without a scrollbar.
    overflow: "visible",
  },
  tab: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space1,
    boxSizing: "border-box",
    height: grasp.controlXs,
    minWidth: grasp.controlXs,
    margin: 0,
    paddingBlock: 0,
    paddingInline: `calc(${grasp.space2} - ${grasp.hairline})`,
    // A real border, unseen, so forced colours can mark the chosen view with it.
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
    fontFamily: grasp.fontSans,
    fontSize: grasp.inspectorText,
    lineHeight: grasp.inspectorTextLine,
    fontWeight: grasp.weightMedium,
    whiteSpace: "nowrap",
    cursor: "pointer",
    color: grasp.muted,
    backgroundColor: "transparent",
    transitionProperty: "background-color, color",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
    // A finger's target: 44px round the 28px tab, drawn unseen.
    "::after": {
      content: '""',
      position: "absolute",
      // By the tab's own inner height, so its edge's width does not come off the 44.
      insetBlock: {
        default: 0,
        [media.coarse]: `calc((100% - ${grasp.tap}) / 2)`,
      },
      insetInline: {
        default: 0,
        [media.coarse]: `calc((${grasp.controlXs} - ${grasp.tap}) / 2)`,
      },
    },
  },
  tabLive: {
    color: {
      default: grasp.muted,
      ":hover": { default: null, [HOVER]: grasp.ink },
    },
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: grasp.ghostFillHover },
    },
  },
  tabChosen: {
    color: grasp.ink,
    backgroundColor: grasp.soft,
    // Forced colours drop the fill: the border, in the system's highlight, marks the chosen view.
    borderColor: { default: "transparent", [media.forced]: "Highlight" },
  },
  // Folded: the tab is its icon alone, a 28px square, and its word stays its name.
  tabFolded: {
    paddingInline: 0,
    width: grasp.controlXs,
    justifyContent: "center",
  },
  words: {},
  // The line that closes the head, across the whole panel.
  line: {
    flexShrink: 0,
    height: grasp.hairline,
    marginBlockStart: grasp.space4,
    backgroundColor: grasp.line,
  },
  lineAlone: { marginBlockStart: grasp.inspectorPad },
});

const reduced = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const given = (node: ReactNode): boolean =>
  node !== undefined && node !== null && node !== false && node !== "";

const headings = { 1: "h1", 2: "h2" } as const;

const tabsOf = (list: HTMLElement | null): HTMLElement[] =>
  list === null
    ? []
    : [...list.children].filter((child) => child instanceof HTMLElement);

// Above the scroller's top, shrunk by the root margin: the sentinel has passed under the bar.
const above = (entry: IntersectionObserverEntry): boolean =>
  !entry.isIntersecting &&
  entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0);

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
    const ease = getComputedStyle(document.documentElement)
      .getPropertyValue("--grasp-ease")
      .trim();
    const easing = ease === "" ? "ease-out" : ease;
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
          { duration: ms.durationUi, easing }
        );
      }
      if (!folded) {
        tab
          .querySelector("[data-panel-view-words]")
          ?.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: ms.durationUi,
            easing,
          });
      }
    }
  }, [folded, list]);

  // Folded, the views stand on the bar's line, as its buttons do. A short panel scrolled to its end
  // can leave them short of it: the panel has room for them then (panel.tsx), and that same scroll
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

/** The bar: the panel's actions, a short line, and close. */
const Bar = ({
  bar,
  actions,
  onClose,
  closeLabel,
  bare = false,
}: Pick<PanelHeaderProps, "actions" | "onClose"> & {
  bar: RefObject<HTMLDivElement | null>;
  closeLabel: string;
  bare?: boolean;
}) => {
  const { scrolled, folded } = usePanel();
  // A bare bar shows its hairline once the views have folded into it; nothing else passes under it sooner.
  const lined = bare ? folded : scrolled;
  return (
    <div
      ref={bar}
      data-slot="panel-bar"
      data-scrolled={lined ? "" : undefined}
      {...stylex.props(
        styles.bar,
        bare && styles.barBare,
        lined && styles.barScrolled
      )}
    >
      {actions}
      {onClose !== undefined && given(actions) && (
        <span aria-hidden {...stylex.props(styles.divider)} />
      )}
      {onClose !== undefined && (
        <RowListAction icon={Cross} aria-label={closeLabel} onPress={onClose} />
      )}
    </div>
  );
};

/** Who and when: short parts with a small dot between them. */
const Meta = ({ meta }: { meta: ReactNode[] }) => (
  <div {...stylex.props(styles.meta)}>
    {meta.map((part, index) => (
      <Fragment key={index}>
        {index > 0 && <span aria-hidden {...stylex.props(styles.dot)} />}
        <span {...stylex.props(styles.metaPart)}>{part}</span>
      </Fragment>
    ))}
  </div>
);

/** The head: the tile, the title, its line, and who and when. */
const Head = ({
  title,
  description,
  icon,
  meta,
  level,
  texture,
  topmost,
}: Pick<PanelHeaderProps, "title" | "description" | "icon" | "meta"> & {
  level: 1 | 2;
  texture: boolean;
  topmost: boolean;
}) => {
  const Heading = headings[level];
  return (
    <div data-slot="panel-head" {...stylex.props(styles.head)}>
      {texture && (
        <span
          aria-hidden
          data-slot="panel-texture"
          {...stylex.props(styles.texture, topmost && styles.textureTopmost)}
        />
      )}
      {given(icon) && <span {...stylex.props(styles.tile)}>{icon}</span>}
      <Heading {...stylex.props(styles.title)}>{title}</Heading>
      {given(description) && (
        <p {...stylex.props(styles.description)}>{description}</p>
      )}
      {meta !== undefined && meta.length > 0 && <Meta meta={meta} />}
    </div>
  );
};

/** The views: one tab list that sticks in the bar and shows only its icons there. */
const Views = ({
  views,
  label,
  list,
}: {
  views: PanelHeaderView[];
  label: string;
  list: RefObject<HTMLDivElement | null>;
}) => {
  const { folded } = usePanel();
  return (
    <TabsListPrimitive
      ref={list}
      aria-label={label}
      data-slot="panel-views"
      data-folded={folded ? "" : undefined}
      {...stylex.props(styles.views)}
    >
      {views.map((view) => (
        <TabsTabPrimitive
          key={view.value}
          value={view.value}
          title={folded ? view.label : undefined}
          className={(state: TabsTabState) =>
            stylex.props(
              styles.tab,
              !state.selected && styles.tabLive,
              state.selected && styles.tabChosen,
              folded && styles.tabFolded,
              focus.ring
            ).className
          }
        >
          <Icon icon={view.icon} />
          <span
            data-panel-view-words=""
            {...stylex.props(folded ? visuallyHidden : styles.words)}
          >
            {view.label}
          </span>
        </TabsTabPrimitive>
      ))}
    </TabsListPrimitive>
  );
};

/** The folding header: bar, head and views. */
export const PanelHeader = ({
  title,
  description,
  icon,
  meta,
  actions,
  onClose,
  closeLabel: closeLabelGiven,
  views,
  viewsLabel: viewsLabelGiven,
  level: levelDeprecated,
  headingLevel: level = levelDeprecated ?? 2,
  texture = false,
}: PanelHeaderProps) => {
  const { close: closeLabel, views: viewsLabel } = withGiven(
    useWords("panel", panelWords),
    { close: closeLabelGiven, views: viewsLabelGiven }
  );
  const bar = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const fold = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useFold({ bar, top, fold, list });
  const hasViews = views !== undefined && views.length > 0;
  // With nothing to hold, the bar takes no room above the head: the head is the panel's top.
  const holds = given(actions) || onClose !== undefined;
  return (
    <>
      {holds && (
        <Bar
          bar={bar}
          actions={actions}
          onClose={onClose}
          closeLabel={closeLabel}
        />
      )}
      {holds && (
        <div ref={top} aria-hidden {...stylex.props(styles.sentinel)} />
      )}
      <Head
        title={title}
        description={description}
        icon={icon}
        meta={meta}
        level={level}
        texture={texture}
        topmost={!holds}
      />
      {!holds && hasViews && <Bar bar={bar} closeLabel={closeLabel} bare />}
      {hasViews && (
        <div ref={fold} aria-hidden {...stylex.props(styles.viewsSentinel)} />
      )}
      {hasViews && <Views views={views} label={viewsLabel} list={list} />}
      <div
        aria-hidden
        {...stylex.props(styles.line, !hasViews && styles.lineAlone)}
      />
    </>
  );
};
