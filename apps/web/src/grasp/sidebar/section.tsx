"use client";

import * as stylex from "@stylexjs/stylex";
import type { RenderProp } from "@ui-sdk/react/primitive";
import { renderElement } from "@ui-sdk/react/primitive";
import { isValidElement, useEffect, useLayoutEffect, useRef } from "react";
import type {
  KeyboardEvent,
  MouseEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from "react";

import { announce } from "../announce/announce";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { ChevronLeft, Icon } from "../icons";
import type { IconData } from "../icons";
import { glide, spanOf } from "../motion/glide";
import { simply } from "../motion/simply.stylex";
import { tabStyles } from "../tabs/tabs";
import { rowMarker } from "../tabs/tabs.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { ms } from "../tokens/tokens.values";
import { Tip, withTip } from "../tooltip/tip";
import { useWords, withGiven } from "../words/words";
import { useSidebarGivenWords } from "./shell";
import { sidebarWords } from "./words";
import type { SidebarWords } from "./words";

const HOVER = media.hover;
const COARSE = media.coarse;
const FORCED = media.forced;

/** How far the switch's track stands round its tabs, on all four sides, and between them. */
const INSET = grasp.shellSwitchInset;
/** The track's corner: the system's, as round as a pill at most. */
const TRACK_CORNER = `min(${grasp.corner}, calc((${grasp.shellIconButton} + 2 * ${INSET}) / 2))`;
/** A tab's corner, and the thumb's: the track's less the inset, so the two nest. */
const TAB_CORNER = `calc(${TRACK_CORNER} - ${INSET})`;
/** The chosen ground's veil in dark, as Tabs' segmented chosen tab has it. */
const VEIL = `linear-gradient(light-dark(transparent, ${grasp.ghostFillPress}), light-dark(transparent, ${grasp.ghostFillPress}))`;

/** How far the new list travels as it comes in. */
const TRAVEL = grasp.space4;

const fromRight = stylex.keyframes({
  from: { opacity: 0, transform: `translateX(${TRAVEL})` },
  to: { opacity: 1, transform: "none" },
});

const fromLeft = stylex.keyframes({
  from: { opacity: 0, transform: `translateX(calc(-1 * ${TRAVEL}))` },
  to: { opacity: 1, transform: "none" },
});

const styles = stylex.create({
  // What swaps: everything between the head and the foot. It takes the room the rows took.
  area: {
    // The box the list leaving a tab switch is laid over (crossfade).
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    // The swap's move, chosen once the list has changed (data-sidebar-swap), never on first paint:
    // duration-ui, and a cut under reduced motion (simply.ui is 0s there).
    animationName: {
      default: null,
      ":is([data-sidebar-swap=right])": fromRight,
      ":is([data-sidebar-swap=left])": fromLeft,
    },
    animationDuration: simply.ui,
    animationTimingFunction: grasp.ease,
    animationFillMode: "both",
  },
  // The tab panel round the rows, when there are tabs: it stands where the nav stood.
  panel: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  // A section's head: Back, then its name, on the sidebar's gutter, above its groups.
  sectionHead: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    gap: grasp.shellRowGap,
    paddingInline: grasp.shellGutter,
    paddingBlockStart: grasp.space1,
  },
  // The section's name: a heading in a row's box (it leads nowhere, so not a link), in the shell's ink.
  title: {
    display: "flex",
    alignItems: "center",
    gap: grasp.shellIconGap,
    boxSizing: "border-box",
    minWidth: 0,
    height: grasp.shellRow,
    margin: 0,
    paddingInline: grasp.shellRowInline,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    letterSpacing: grasp.shellTracking,
    color: grasp.shellText,
  },
  titleWords: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // The host's own mark before the name (an agent's colour), in the icon's box.
  titleMark: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: grasp.shellIcon,
    height: grasp.shellIcon,
  },
  tabsRow: {
    flexShrink: 0,
    paddingInline: grasp.shellGutter,
    paddingBlockStart: grasp.space1,
  },
  tabs: {
    width: "100%",
    boxSizing: "border-box",
    gap: INSET,
    paddingBlock: INSET,
    paddingInline: INSET,
    overflowX: "visible",
    borderRadius: TRACK_CORNER,
    backgroundColor: grasp.shellHover,
  },
  // The chosen ground, one for the switch: it travels from the tab left to the tab chosen, its
  // leading edge first and its trailing edge after, so it stretches toward the new tab and settles
  // (src/motion/glide.ts, as Tabs' line). Drawn under the tabs' words, icons and count. Until it
  // stands (before script) and in forced colours, the chosen tab draws its own ground instead.
  thumb: {
    position: "absolute",
    insetBlock: INSET,
    left: 0,
    width: 0,
    boxSizing: "border-box",
    borderRadius: TAB_CORNER,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.shellCard,
    backgroundImage: VEIL,
    boxShadow: grasp.liftLow,
    pointerEvents: "none",
    display: {
      default: "none",
      [stylex.when.ancestor("[data-thumb]", rowMarker)]: {
        default: "block",
        [FORCED]: "none",
      },
    },
  },
  tab: {
    flexGrow: 1,
    flexBasis: 0,
    justifyContent: "center",
    gap: grasp.shellIconGap,
    minWidth: 0,
    minHeight: grasp.shellIconButton,
    paddingInline: `calc(${grasp.shellRowInline} - ${INSET})`,
    fontFamily: grasp.fontSans,
    letterSpacing: grasp.shellTracking,
    color: {
      default: grasp.shellTextSecondary,
      [HOVER]: { default: grasp.shellTextSecondary, ":hover": grasp.shellText },
    },
    borderRadius: TAB_CORNER,
    // The ink crosses over with the thumb: the new tab's words and icon reach full as it arrives.
    transitionDuration: `${simply.ui}, ${grasp.durationHover}`,
    transitionTimingFunction: grasp.ease,
  },
  // Back and the home as one segment: raised out of the track as a chosen tab, its two parts each a
  // press of its own, a row's height (a fingertip's on a touch screen), with its own hover fill and
  // focus ring inside the shape, and a hairline between them.
  homeSegment: {
    display: "flex",
    flexGrow: 1,
    alignItems: "stretch",
    minWidth: 0,
    borderRadius: TAB_CORNER,
    cornerShape: grasp.cornerShape,
    backgroundColor: { default: grasp.shellCard, [FORCED]: "Canvas" },
    backgroundImage: { default: VEIL, [FORCED]: "none" },
    boxShadow: { default: grasp.liftLow, [FORCED]: "none" },
    outline: { default: null, [FORCED]: `${grasp.hairline} solid CanvasText` },
  },
  homePart: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    minHeight: { default: grasp.shellRow, [COARSE]: grasp.tap },
    cornerShape: grasp.cornerShape,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    letterSpacing: grasp.shellTracking,
    textDecoration: "none",
    backgroundColor: {
      default: "transparent",
      [HOVER]: { default: "transparent", ":hover": grasp.shellHover },
    },
    transitionProperty: "color, background-color",
    transitionDuration: grasp.shellAnswer,
    transitionTimingFunction: grasp.ease,
  },
  // Back: the chevron alone, centred on the rows' icon column (the track's inset and half its width
  // put it there), the segment's start corners.
  homeBack: {
    justifyContent: "center",
    flexShrink: 0,
    width: { default: grasp.shellIconButton, [COARSE]: grasp.tap },
    borderStartStartRadius: TAB_CORNER,
    borderEndStartRadius: TAB_CORNER,
    color: {
      default: grasp.shellTextSecondary,
      [HOVER]: { default: grasp.shellTextSecondary, ":hover": grasp.shellText },
      [FORCED]: "LinkText",
    },
  },
  homeRule: {
    flexShrink: 0,
    alignSelf: "center",
    width: grasp.hairline,
    height: grasp.space4,
    backgroundColor: { default: grasp.shellRule, [FORCED]: "CanvasText" },
  },
  // The section's name: a heading that holds its link, with no room of its own.
  homeHeading: {
    display: "flex",
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    fontSize: "inherit",
    fontWeight: "inherit",
  },
  // The home: the section's icon and name, in the shell's ink, the segment's end corners.
  home: {
    flexGrow: 1,
    gap: grasp.shellIconGap,
    minWidth: 0,
    paddingInline: `calc(${grasp.shellRowInline} - ${INSET})`,
    borderStartEndRadius: TAB_CORNER,
    borderEndEndRadius: TAB_CORNER,
    color: { default: grasp.shellText, [FORCED]: "LinkText" },
  },
  // Chosen: its ink, and its own ground only until the thumb stands (and always in forced colours).
  tabChosen: {
    color: { default: grasp.shellText, [FORCED]: "HighlightText" },
    backgroundColor: {
      default: grasp.shellCard,
      [stylex.when.ancestor("[data-thumb]", rowMarker)]: {
        default: "transparent",
        [FORCED]: "Highlight",
      },
      [FORCED]: "Highlight",
    },
    backgroundImage: {
      default: VEIL,
      [stylex.when.ancestor("[data-thumb]", rowMarker)]: "none",
      [FORCED]: "none",
    },
    boxShadow: {
      default: grasp.liftLow,
      [stylex.when.ancestor("[data-thumb]", rowMarker)]: "none",
      [FORCED]: "none",
    },
  },
  // The list a tab switch leaves, laid over the new one as it fades (crossfade): placed by script
  // on the panel's box, never pressed, never read.
  leaving: {
    position: "absolute",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    pointerEvents: "none",
  },
  tabWords: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  tabTarget: {
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${grasp.shellIconButton} - ${grasp.tap}) / 2)`,
    },
  },
  hold: {
    position: "relative",
    display: "inline-flex",
    minWidth: 0,
  },
  count: {
    position: "absolute",
    insetBlockStart: `calc(${grasp.space2} / -2 + ${grasp.hairline} / 2)`,
    insetInlineStart: `calc(100% - ${grasp.space2} / 2 - ${grasp.hairline})`,
    width: `calc(${grasp.space2} - ${grasp.hairline})`,
    height: `calc(${grasp.space2} - ${grasp.hairline})`,
    borderRadius: grasp.cornerPill,
    backgroundColor: { default: grasp.danger, [FORCED]: "Highlight" },
    backgroundImage: {
      default: `radial-gradient(circle at 35% 30%, oklch(from ${grasp.danger} calc(l + 0.09) c h), ${grasp.danger} 55%, oklch(from ${grasp.danger} calc(l - 0.05) c h))`,
      [FORCED]: "none",
    },
    boxShadow: {
      default: `0 ${grasp.hairline} calc(${grasp.hairline} * 2) ${grasp.dangerShade}`,
      [FORCED]: "none",
    },
  },
  // With no icon: raised at the word's end.
  countAtWords: {
    insetInlineStart: "100%",
    marginInlineStart: grasp.space1,
  },
});

/** Where Back goes: the parent, or the last main page, as a link. Every word is the host's. */
export interface SidebarBack {
  /**
   * Its words ("Back", "Back to app").
   * @default "Back"
   */
  label?: string;
  /** Where it goes. Leave it out when `render` gives the link. */
  href?: string;
  /** The link itself, when a router draws it: `<Link to="/" />`. It takes the row's look and words. */
  render?: ReactElement;
  /** Runs when it is pressed, before the link is followed. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}

/** One tab at the top of the main list. */
export interface SidebarTab {
  /** What `tab` and `onTabChange` call it ("activity"). */
  value: string;
  /** Its words ("Activity"). */
  label: string;
  /** An icon before the words. From the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** How many things wait there. The tab shows a red dot on its icon that says something is new; the number is said, not shown (`countLabel`). None at 0. A change is said once. */
  count?: number;
  /**
   * What a screen reader hears of the count, with the tab's name and when it changes ("3 items
   * need your input").
   * @default the number
   */
  countLabel?: string;
}

/** What the section's head needs to draw. */
export interface SectionHeadProps {
  title: string;
  icon?: IconData;
  mark?: ReactNode;
  back: SidebarBack;
  /** Back's words: `back.label`, else this. */
  backLabel?: string;
  /** Draws the Back row with the sidebar's own row part. */
  renderBack: (back: SidebarBack & { label: string }) => ReactElement;
  /** The section's own first page (SidebarSection's `home`): its name, above Back, opens it. */
  home?: RenderProp;
  /** That page is the one open. */
  homeCurrent?: boolean;
  /**
   * This instance's own words, over its Sidebar's `words` and the catalogue's (GraspWords), key by key (`{ back: "All settings" }`). Any left out
   * are the Sidebar's, else the catalogue's, else English. A flat text prop given beside it still wins until the
   * release's step 5.
   */
  words?: Partial<SidebarWords>;
}

/** Back, then the section's name: where the tabs would stand on the main list. */
export const SectionHead = ({
  title,
  icon,
  mark,
  back,
  backLabel: backGiven,
  renderBack,
  home,
  homeCurrent = false,
  words,
}: SectionHeadProps) => {
  const fromSidebar = useSidebarGivenWords();
  const backLabel = withGiven(
    useWords(
      "sidebar",
      sidebarWords,
      words === undefined ? fromSidebar : { ...fromSidebar, ...words }
    ),
    { back: backGiven }
  ).back;
  let lead: ReactNode = null;
  if (mark !== undefined) {
    lead = (
      <span aria-hidden="true" {...stylex.props(styles.titleMark)}>
        {mark}
      </span>
    );
  } else if (icon !== undefined) {
    lead = <Icon icon={icon} />;
  }
  if (home !== undefined) {
    return (
      <div
        data-slot="sidebar-section-head"
        {...stylex.props(styles.sectionHead)}
      >
        <div
          {...stylex.props(
            rowMarker,
            tabStyles.list,
            tabStyles.listSegmented,
            styles.tabs
          )}
        >
          <div
            data-slot="sidebar-section-home"
            {...stylex.props(styles.homeSegment)}
          >
            <Tip
              name
              tooltip={backLabel}
              render={(tip: Record<string, unknown>) =>
                renderElement(
                  "a",
                  withTip(
                    {
                      href: back.href,
                      onClick: back.onClick,
                      "aria-label": backLabel,
                      "data-slot": "sidebar-back",
                      className: stylex.props(
                        styles.homePart,
                        styles.homeBack,
                        focus.inside
                      ).className,
                      children: <Icon icon={ChevronLeft} />,
                    },
                    tip
                  ),
                  isValidElement<Record<string, unknown>>(back.render)
                    ? back.render
                    : undefined
                )
              }
            />
            <span aria-hidden="true" {...stylex.props(styles.homeRule)} />
            <h2
              data-slot="sidebar-section-title"
              {...stylex.props(styles.homeHeading)}
            >
              {renderElement(
                "a",
                {
                  "aria-current": homeCurrent ? "page" : undefined,
                  className: stylex.props(
                    styles.homePart,
                    styles.home,
                    focus.inside
                  ).className,
                  children: (
                    <>
                      {lead}
                      <span {...stylex.props(styles.titleWords)}>{title}</span>
                    </>
                  ),
                },
                home
              )}
            </h2>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div data-slot="sidebar-section-head" {...stylex.props(styles.sectionHead)}>
      {renderBack({ ...back, label: backLabel })}
      <h2 data-slot="sidebar-section-title" {...stylex.props(styles.title)}>
        {lead}
        <span {...stylex.props(styles.titleWords)}>{title}</span>
      </h2>
    </div>
  );
};

/** Says each tab's count again when it changes, never on first paint: once, politely. */
const useCountVoice = (tabs: readonly SidebarTab[]) => {
  const heard = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    const before = heard.current;
    heard.current = new Map(tabs.map((tab) => [tab.value, tab.count ?? 0]));
    if (before === null) {
      return;
    }
    for (const tab of tabs) {
      const was = before.get(tab.value);
      const now = tab.count ?? 0;
      if (was !== undefined && was !== now) {
        announce(tab.countLabel ?? String(now));
      }
    }
  });
};

const TAB_KEYS: Record<
  string,
  (at: number, last: number, rtl: boolean) => number
> = {
  ArrowRight: (at, last, rtl) =>
    rtl ? Math.max(at - 1, 0) : Math.min(at + 1, last),
  ArrowLeft: (at, last, rtl) =>
    rtl ? Math.min(at + 1, last) : Math.max(at - 1, 0),
  Home: () => 0,
  End: (_at, last) => last,
};

/** The tab ←/→, Home or End lead to from the one with the keys; null for any other key. */
const tabFor = (
  event: KeyboardEvent<HTMLButtonElement>
): HTMLElement | null => {
  const step = TAB_KEYS[event.key];
  const row = event.currentTarget.closest<HTMLElement>("[role=tablist]");
  const all =
    row === null ? [] : [...row.querySelectorAll<HTMLElement>("[role=tab]")];
  const at = all.indexOf(event.currentTarget);
  if (step === undefined || row === null || at === -1) {
    return null;
  }
  const rtl = getComputedStyle(row).direction === "rtl";
  return all[step(at, all.length - 1, rtl)] ?? null;
};

/** The tab's id, and its panel's, from the sidebar's own id. */
export const tabId = (id: string, value: string) => `${id}-tab-${value}`;
export const tabPanelId = (id: string) => `${id}-tabpanel`;

/** Words only a screen reader reads. */
const Unseen = ({ children }: { children: ReactNode }) => (
  <span {...stylex.props(visuallyHidden)}>{children}</span>
);

/** A tab's count: a red dot on its icon's corner, or raised at its words' end when it has no icon. */
const TabCount = ({ atWords = false }: { atWords?: boolean }) => (
  <span
    aria-hidden="true"
    data-slot="sidebar-tab-count"
    {...stylex.props(styles.count, atWords && styles.countAtWords)}
  />
);

/** One tab: its icon, words and count, chosen or not. */
const Tab = ({
  id,
  tab,
  chosen,
  onChoose,
  panel,
  iconOnly,
}: {
  id: string;
  tab: SidebarTab;
  chosen: boolean;
  onChoose: (value: string) => void;
  /** Ties it to the tab panel round the rows; a section's views have none. */
  panel: boolean;
  /** Its icon alone: its words are its name, and its tooltip. */
  iconOnly: boolean;
}) => {
  const counted = tab.count !== undefined && tab.count > 0;
  const own = {
    role: "tab",
    id: tabId(id, tab.value),
    "aria-selected": chosen,
    "aria-controls": panel ? tabPanelId(id) : undefined,
    tabIndex: chosen ? 0 : -1,
    "data-sidebar-tab": tab.value,
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      const next = tabFor(event);
      if (next !== null) {
        event.preventDefault();
        // Chosen, then focused: a press closes a tab's tooltip, so focus after it opens the tip.
        next.click();
        next.focus();
      }
    },
    onClick: () => {
      onChoose(tab.value);
    },
    ...stylex.props(
      tabStyles.tab,
      tabStyles.segment,
      styles.tab,
      chosen ? styles.tabChosen : tabStyles.segmentLive,
      focus.inside
    ),
  };
  const drawn = (trigger: Record<string, unknown>) => (
    <button type="button" {...withTip(own, trigger)}>
      <span
        aria-hidden="true"
        {...stylex.props(
          tabStyles.target,
          tabStyles.targetSegment,
          styles.tabTarget
        )}
      />
      {tab.icon === undefined ? null : (
        <span {...stylex.props(styles.hold)}>
          <Icon icon={tab.icon} />
          {counted && <TabCount />}
        </span>
      )}
      {iconOnly ? (
        <Unseen>{tab.label}</Unseen>
      ) : (
        <span {...stylex.props(styles.hold)}>
          <span
            data-slot="sidebar-tab-words"
            {...stylex.props(styles.tabWords)}
          >
            {tab.label}
          </span>
          {counted && tab.icon === undefined && <TabCount atWords />}
        </span>
      )}
      {counted && <Unseen>{` ${tab.countLabel ?? String(tab.count)}`}</Unseen>}
    </button>
  );
  // The tip repeats the name, so it describes nothing (`name`): a screen reader hears it once. It is
  // imported, not loaded lazily, as an icon-only Button's is: a late swap drops focus and refs.
  return iconOnly ? <Tip name tooltip={tab.label} render={drawn} /> : drawn({});
};

/** The chosen tab in the switch. */
const chosenTab = (row: HTMLElement) =>
  row.querySelector<HTMLElement>(':scope > [role=tab][aria-selected="true"]');

/** Puts the thumb on the chosen tab at once. */
const putThumb = (row: HTMLElement, thumb: HTMLElement) => {
  const tab = chosenTab(row);
  if (tab !== null) {
    const span = spanOf(tab);
    thumb.style.setProperty("left", `${span.x}px`);
    thumb.style.setProperty("width", `${span.w}px`);
  }
};

const followChoice = (row: HTMLElement, thumb: HTMLElement) => {
  putThumb(row, thumb);
  row.dataset.thumb = "";
  let at = chosenTab(row);
  // Whatever chose (a press, the keys, the host): the thumb glides from where it stands now, so
  // keys held down turn it toward the latest tab and never queue.
  const chosen = new MutationObserver(() => {
    const next = chosenTab(row);
    if (next === null || next === at) {
      return;
    }
    at = next;
    glide(thumb, spanOf(next));
  });
  chosen.observe(row, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-selected"],
  });
  // The sidebar's width changes the tabs' (a phone, a fold): at rest the thumb follows at once.
  const sized = new ResizeObserver(() => {
    if (thumb.getAnimations().length === 0) {
      putThumb(row, thumb);
    }
  });
  sized.observe(row);
  return () => {
    chosen.disconnect();
    sized.disconnect();
    delete row.dataset.thumb;
  };
};

/** The switch's watcher, as a ref callback: the thumb stands on the chosen tab and follows it. */
const watchThumb = (row: HTMLDivElement | null) => {
  const thumb =
    row?.querySelector<HTMLElement>(
      ":scope > [data-slot=sidebar-tabs-thumb]"
    ) ?? null;
  return row === null || thumb === null ? undefined : followChoice(row, thumb);
};

const reduced = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Each scroller in the copy where the original's stood. */
const keepScroll = (from: Element, to: Element) => {
  const copies = [...to.querySelectorAll("*")];
  for (const [index, element] of [...from.querySelectorAll("*")].entries()) {
    const copy = copies[index];
    if (copy !== undefined && element.scrollTop !== 0) {
      copy.scrollTop = element.scrollTop;
    }
  }
};

/**
 * A tab switch's list crossfade: a still copy of the list leaving is laid over the panel and fades
 * out while the new list fades in, both in duration-swap, as the thumb sets off; the panel's box
 * never moves. Under reduced motion the new list is simply there.
 */
const crossfade = (panel: HTMLElement | null) => {
  const area = panel?.parentElement ?? null;
  if (panel === null || area === null || reduced()) {
    return;
  }
  for (const running of panel.getAnimations()) {
    running.cancel();
  }
  for (const old of area.querySelectorAll(
    ":scope > [data-slot=sidebar-tabs-leaving]"
  )) {
    old.remove();
  }
  const leaving = document.createElement("div");
  leaving.setAttribute("aria-hidden", "true");
  leaving.inert = true;
  leaving.dataset.slot = "sidebar-tabs-leaving";
  leaving.className = stylex.props(styles.leaving).className ?? "";
  for (const child of panel.children) {
    leaving.append(child.cloneNode(true));
  }
  for (const named of leaving.querySelectorAll("[id]")) {
    named.removeAttribute("id");
  }
  leaving.style.setProperty("top", `${panel.offsetTop}px`);
  leaving.style.setProperty("left", `${panel.offsetLeft}px`);
  leaving.style.setProperty("width", `${panel.offsetWidth}px`);
  leaving.style.setProperty("height", `${panel.offsetHeight}px`);
  area.append(leaving);
  keepScroll(panel, leaving);
  // One list, then the other, never both: the old one fades out as the thumb sets off (70ms), and
  // the new one fades in only once the old is gone (90ms), done 160ms after the press. As they
  // overlapped, the two lists' words stood over each other ("Chat" on "Needs you").
  const out = ms.durationLeave - ms.durationStagger;
  leaving.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: out,
    easing: "ease",
    fill: "forwards",
  }).onfinish = () => {
    leaving.remove();
  };
  panel.animate([{ opacity: 0 }, { opacity: 1 }], {
    delay: out,
    duration: ms.durationStagger,
    easing: "ease",
    fill: "backwards",
  });
};

/** Whether three or more tabs, each with an icon: worded, they would cut their words in the sidebar's width. */
const crowded = (tabs: readonly SidebarTab[]) =>
  tabs.length > 2 && tabs.every((tab) => tab.icon !== undefined);

/** The tabs at the top of the main list, or a section's views: one tab stop, ←/→, Home and End move and choose. */
export const SidebarTabs = ({
  id,
  tabs,
  value,
  label,
  onChoose,
  panel = true,
  iconOnly = crowded(tabs),
}: {
  id: string;
  tabs: readonly SidebarTab[];
  value: string;
  label: string;
  onChoose: (value: string) => void;
  /**
   * The tabs switch the rows under them, in a tab panel (each tab's `aria-controls`, the lists'
   * crossfade). False for a section's views, which switch what its page shows, not the rows.
   * @default true
   */
  panel?: boolean;
  /**
   * Each tab its icon alone, its words its name and its tooltip.
   * @default true from three tabs that all have an icon
   */
  iconOnly?: boolean;
}) => {
  useCountVoice(tabs);
  return (
    <div {...stylex.props(styles.tabsRow)}>
      <div
        ref={watchThumb}
        role="tablist"
        aria-label={label}
        data-slot="sidebar-tabs"
        {...stylex.props(
          rowMarker,
          tabStyles.list,
          tabStyles.listSegmented,
          styles.tabs
        )}
      >
        <span
          aria-hidden="true"
          data-slot="sidebar-tabs-thumb"
          {...stylex.props(styles.thumb)}
        />
        {tabs.map((tab) => (
          <Tab
            key={tab.value}
            id={id}
            tab={tab}
            chosen={tab.value === value}
            panel={panel}
            iconOnly={iconOnly}
            onChoose={(next) => {
              if (panel && next !== value) {
                crossfade(
                  document.querySelector<HTMLElement>(
                    `#${CSS.escape(tabPanelId(id))}`
                  )
                );
              }
              onChoose(next);
            }}
          />
        ))}
      </div>
    </div>
  );
};

/** The tab panel round the rows, when there are tabs. */
export const TabPanel = ({
  id,
  value,
  children,
}: {
  id: string;
  value: string;
  children: ReactNode;
}) => (
  <div
    role="tabpanel"
    id={tabPanelId(id)}
    aria-labelledby={tabId(id, value)}
    {...stylex.props(styles.panel)}
  >
    {children}
  </div>
);

/** What opened a section: a row (its address and words), or an item of the person's menu. */
type Opener = { href: string | null; words: string } | "foot";

/** How long after a press in the sidebar a swap still counts as started by it, in ms. */
const PRESS_WINDOW = 2500;

/** When to look again for focus the person's menu gave back, in ms: after its closing. */
const LAND_AGAIN = 320;

/** The key of a section's list: what tells it from the main list and from another section. */
export const SECTION = "section:";
export const listKey = (section: { id?: string; title: string } | undefined) =>
  section === undefined ? "main" : `${SECTION}${section.id ?? section.title}`;

/** What a press in the sidebar was on: an item of the person's menu, or a row. */
const openerOf = (target: EventTarget | null): Opener | null => {
  if (!(target instanceof Element)) {
    return null;
  }
  if (target.closest("[role=menuitem], [role=menuitemradio]") !== null) {
    return "foot";
  }
  const control = target.closest("a, button");
  if (control === null) {
    return null;
  }
  return {
    href: control.getAttribute("href"),
    words: control.textContent.trim(),
  };
};

/** The control in the new list (or the foot) the opener names. */
const findOpener = (
  area: HTMLElement,
  panel: HTMLElement,
  opener: Opener | null
): HTMLElement | null => {
  if (opener === null) {
    return null;
  }
  if (opener === "foot") {
    return panel.querySelector<HTMLElement>("[data-slot=sidebar-foot] button");
  }
  const controls = [...area.querySelectorAll<HTMLElement>("nav a, nav button")];
  const { href, words } = opener;
  return (
    controls.find(
      (control) => href !== null && control.getAttribute("href") === href
    ) ??
    controls.find((control) => control.textContent.trim() === words) ??
    null
  );
};

/** Whether focus is the sidebar's to move: on nothing, in the sidebar, or in the person's menu. */
const ours = (panel: HTMLElement) => {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    panel.contains(active) ||
    active.closest("[role=menu]") !== null
  );
};

/** After a swap the sidebar started: focus on the opener when going back, else the current row. */
const land = (area: HTMLElement, panel: HTMLElement, opener: Opener | null) => {
  if (!ours(panel)) {
    return;
  }
  const target =
    findOpener(area, panel, opener) ??
    area.querySelector<HTMLElement>('nav [aria-current="page"]') ??
    area.querySelector<HTMLElement>("a[href], button");
  target?.focus({ preventScroll: true });
  // The person's menu gives focus back to its button as it closes, after this: once it has, the
  // focus goes on to where it belongs.
  window.setTimeout(() => {
    const active = document.activeElement;
    if (
      target !== null &&
      target.isConnected &&
      active !== null &&
      active.closest("[data-slot=sidebar-foot]") !== null &&
      opener !== "foot"
    ) {
      target.focus({ preventScroll: true });
    }
  }, LAND_AGAIN);
};

/** Which way the new list comes in: from the end going in, from the start going back. */
const travel = (element: HTMLElement, inside: boolean) => {
  const rtl = getComputedStyle(element).direction === "rtl";
  return inside === rtl ? "left" : "right";
};

/** Marks the new list with the way it comes in, which starts its move (styles.area). */
const markSwap = (element: HTMLElement, inside: boolean) => {
  element.dataset.sidebarSwap = travel(element, inside);
};

/** Whether a press is recent enough to have started the swap. */
const recent = (press: { at: number } | null) =>
  press !== null && performance.now() - press.at < PRESS_WINDOW;

/**
 * The swap: when `list` changes, the area (keyed on it, so it is new) moves in, and, when a press
 * in the sidebar started it, focus lands. Returns what the panel runs on a press (capturing), so a
 * press in the person's menu counts too.
 */
export const useSwap = (
  list: string,
  inside: boolean,
  area: RefObject<HTMLDivElement | null>,
  panel: RefObject<HTMLDivElement | null>
) => {
  const last = useRef<string | null>(null);
  const press = useRef<{ at: number; opener: Opener | null } | null>(null);
  const opener = useRef<Opener | null>(null);

  useLayoutEffect(() => {
    const before = last.current;
    last.current = list;
    const element = area.current;
    const host = panel.current;
    if (
      before === null ||
      before === list ||
      element === null ||
      host === null
    ) {
      return;
    }
    markSwap(element, inside);
    const pressed = press.current;
    press.current = null;
    if (pressed === null || !recent(pressed)) {
      return;
    }
    // Into a section from the main list: remember what opened it, for Back.
    if (inside && !before.startsWith(SECTION)) {
      opener.current = pressed.opener;
    }
    land(element, host, inside ? null : opener.current);
    if (!inside) {
      opener.current = null;
    }
  }, [list, inside, area, panel]);

  return (event: MouseEvent<HTMLElement>) => {
    press.current = { at: performance.now(), opener: openerOf(event.target) };
  };
};

/** The area that swaps, keyed by the caller on its list. */
export const SwapArea = ({
  ref,
  children,
}: {
  ref: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) => (
  <div ref={ref} data-slot="sidebar-list" {...stylex.props(styles.area)}>
    {children}
  </div>
);
