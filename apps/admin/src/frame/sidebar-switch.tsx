import { ChevronLeftIcon, Icon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { focusRingInset, visuallyHidden } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { durations } from "@grasp-os/ui/lib/tokens.values";
import { announce } from "@grasp-os/ui/lib/utils";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type {
  KeyboardEvent,
  ReactElement,
  ReactNode,
  RefCallback,
} from "react";

import { switchMarker } from "./sidebar-switch.stylex.ts";

// The sidebar's switch under its head (Home | Inbox, an App's preview
// widths) and a level's head (Back and the level's name as one raised
// segment), as the reference draws them (#2503's grasp/sidebar/section.tsx):
// a track on the sidebar's hover fill, its tabs sharing its width, the
// chosen one raised on a thumb that glides from tab to tab. Damsko's Tabs
// draw a segmented track of their own width on the muted fill, so the
// sidebar draws its own on Damsko's tokens (registry gap of 24 Nov 2026).

const HOVER = media.hover;
const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;

/** How far the track stands round its tabs, on all four sides, and between them. */
const INSET = "2px";
/** The track's corner: the system's, as round as a pill at most. */
const TRACK_CORNER = `min(${radius.xl}, calc((${size.sidebarIconButton} + 2 * ${INSET}) / 2))`;
/** A tab's corner, and the thumb's: the track's less the inset, so the two nest. */
const TAB_CORNER = `calc(${TRACK_CORNER} - ${INSET})`;
/** The chosen ground's veil in dark, as a segmented chosen tab has it. */
const VEIL = `linear-gradient(light-dark(transparent, ${colors.accentActive}), light-dark(transparent, ${colors.accentActive}))`;

const styles = stylex.create({
  row: {
    flexShrink: 0,
    paddingInline: space["2"],
    paddingBlockStart: space["1"],
  },
  track: {
    position: "relative",
    display: "flex",
    boxSizing: "border-box",
    width: "100%",
    gap: INSET,
    padding: INSET,
    borderRadius: TRACK_CORNER,
    cornerShape: radius.shape,
    backgroundColor: colors.sidebarHover,
    outline: { default: "none", [FORCED]: "1px solid CanvasText" },
    outlineOffset: "-1px",
  },
  // A level's head holds the track's room but draws nothing: the segment stands flat on the sidebar.
  headTrack: { backgroundColor: "transparent" },
  // The chosen ground, one for the switch: it travels from the tab left to the tab chosen, its
  // leading edge first and its trailing edge after. Until it stands (before script) and in forced
  // colours, the chosen tab draws its own ground instead.
  thumb: {
    position: "absolute",
    insetBlock: INSET,
    left: 0,
    width: 0,
    boxSizing: "border-box",
    borderRadius: TAB_CORNER,
    cornerShape: radius.shape,
    backgroundColor: colors.sidebarCard,
    backgroundImage: VEIL,
    boxShadow: shadow.sm,
    pointerEvents: "none",
    display: {
      default: "none",
      [stylex.when.ancestor("[data-thumb]", switchMarker)]: {
        default: "block",
        [FORCED]: "none",
      },
    },
  },
  tab: {
    position: "relative",
    display: "inline-flex",
    flexGrow: 1,
    flexBasis: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: size.sidebarIconGap,
    boxSizing: "border-box",
    minWidth: 0,
    minHeight: size.sidebarIconButton,
    margin: 0,
    paddingBlock: 0,
    paddingInline: `calc(${size.sidebarRowInline} - ${INSET})`,
    borderWidth: 0,
    borderRadius: TAB_CORNER,
    cornerShape: radius.shape,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    letterSpacing: size.sidebarTracking,
    whiteSpace: "nowrap",
    color: {
      default: colors.sidebarSecondaryForeground,
      [HOVER]: {
        default: colors.sidebarSecondaryForeground,
        ":hover": colors.sidebarForeground,
      },
    },
    backgroundColor: "transparent",
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    transitionProperty: "color, background-color",
    transitionDuration: `${duration.ui}, ${duration.hover}`,
    transitionTimingFunction: duration.ease,
  },
  // Chosen: its ink, and its own ground only until the thumb stands (and always in forced colours).
  tabChosen: {
    forcedColorAdjust: { default: null, [FORCED]: "none" },
    color: { default: colors.sidebarForeground, [FORCED]: "HighlightText" },
    backgroundColor: {
      default: colors.sidebarCard,
      [stylex.when.ancestor("[data-thumb]", switchMarker)]: {
        default: "transparent",
        [FORCED]: "Highlight",
      },
      [FORCED]: "Highlight",
    },
    backgroundImage: {
      default: VEIL,
      [stylex.when.ancestor("[data-thumb]", switchMarker)]: "none",
      [FORCED]: "none",
    },
    boxShadow: {
      default: shadow.sm,
      [stylex.when.ancestor("[data-thumb]", switchMarker)]: "none",
      [FORCED]: "none",
    },
  },
  // A finger's target, the look unchanged.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${size.sidebarIconButton} - ${size.tapTarget}) / 2)`,
    },
  },
  hold: { position: "relative", display: "inline-flex", minWidth: 0 },
  words: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // How many wait: a red dot on its icon's corner, raised at the words' end when it has no icon.
  count: {
    position: "absolute",
    insetBlockStart: `calc(${space["2"]} / -2 + ${size.hairline} / 2)`,
    insetInlineStart: `calc(100% - ${space["2"]} / 2 - ${size.hairline})`,
    width: `calc(${space["2"]} - ${size.hairline})`,
    height: `calc(${space["2"]} - ${size.hairline})`,
    borderRadius: radius.full,
    backgroundColor: { default: colors.destructive, [FORCED]: "Highlight" },
    backgroundImage: {
      default: `radial-gradient(circle at 35% 30%, oklch(from ${colors.destructive} calc(l + 0.09) c h), ${colors.destructive} 55%, oklch(from ${colors.destructive} calc(l - 0.05) c h))`,
      [FORCED]: "none",
    },
    boxShadow: {
      default: `0 ${size.hairline} calc(${size.hairline} * 2) ${colors.destructiveShadowColor}`,
      [FORCED]: "none",
    },
  },
  countAtWords: { insetInlineStart: "100%", marginInlineStart: space["1"] },
  // A level's head: Back and its name as one segment, raised out of the track as a chosen tab.
  head: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    gap: size.sidebarRowGap,
    paddingInline: space["2"],
    paddingBlockStart: space["1"],
  },
  segment: {
    display: "flex",
    flexGrow: 1,
    alignItems: "stretch",
    minWidth: 0,
    borderRadius: TAB_CORNER,
    cornerShape: radius.shape,
    backgroundColor: { default: colors.control, [FORCED]: "Canvas" },
    boxShadow: {
      default: `inset 0 0 0 ${size.hairline} ${colors.borderStrongColor}`,
      [FORCED]: "none",
    },
    outline: { default: null, [FORCED]: `${size.hairline} solid CanvasText` },
  },
  part: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    minHeight: {
      default: size.sidebarMenuButtonHeight,
      [COARSE]: size.tapTarget,
    },
    cornerShape: radius.shape,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    letterSpacing: size.sidebarTracking,
    textDecoration: "none",
    backgroundColor: {
      default: "transparent",
      [HOVER]: { default: "transparent", ":hover": colors.sidebarHover },
    },
    transitionProperty: "color, background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // Back: the chevron alone, centred on the rows' icon column, the segment's start corners.
  back: {
    justifyContent: "center",
    flexShrink: 0,
    width: { default: size.sidebarIconButton, [COARSE]: size.tapTarget },
    borderStartStartRadius: TAB_CORNER,
    borderEndStartRadius: TAB_CORNER,
    color: {
      default: colors.sidebarSecondaryForeground,
      [HOVER]: {
        default: colors.sidebarSecondaryForeground,
        ":hover": colors.sidebarForeground,
      },
      [FORCED]: "LinkText",
    },
  },
  heading: {
    display: "flex",
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    fontSize: "inherit",
    fontWeight: "inherit",
  },
  // The level's own first page: its icon and name, in the sidebar's ink, the segment's end corners.
  home: {
    flexGrow: 1,
    gap: size.sidebarIconGap,
    minWidth: 0,
    paddingInline: `calc(${size.sidebarRowInline} - ${INSET})`,
    borderStartEndRadius: TAB_CORNER,
    borderEndEndRadius: TAB_CORNER,
    color: { default: colors.sidebarForeground, [FORCED]: "LinkText" },
  },
  // A mark of the level's own before its name (an agent's face), in the icon's box.
  mark: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: size.sidebarIcon,
    height: size.sidebarIcon,
  },
});

/** What a row's link is drawn with: its words, and the look and names the part gives it. */
export interface LinkLook {
  children: ReactNode;
  className?: string;
  title?: string;
  "aria-label"?: string;
  "aria-current"?: "page";
  "data-slot"?: string;
}

/** A router's link, drawn with what the part gives it: `(look) => <Link {...look} to="/brain" />`. */
export type RenderLink = (look: LinkLook) => ReactElement;

/** One tab of the switch. */
export interface SidebarTab {
  /** What the switch calls it ("home"). */
  value: string;
  /** Its words ("Home"). */
  label: string;
  icon?: IconData;
  /** How many things wait there: a red dot on its icon, the number said (`countLabel`). None at 0. */
  count?: number;
  /** What a screen reader hears of the count. @default the number */
  countLabel?: string;
}

const reduced = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const still = () =>
  reduced() || window.matchMedia("(forced-colors: active)").matches;

interface Span {
  x: number;
  w: number;
}

const spanOf = (item: HTMLElement): Span => ({
  x: item.offsetLeft,
  w: item.offsetWidth,
});

const px = (value: string) => Number(value.replace("px", "")) || 0;

const easeOut = (x: number) => 1 - (1 - x) ** 3;
const clamp = (x: number) => Math.min(1, Math.max(0, x));

/**
 * The thumb's way from one tab to the next: its leading edge sets off
 * first and its trailing edge after, so it stretches toward the new tab
 * and settles.
 */
const framesOf = (from: Span, to: Span): Keyframe[] => {
  const right = to.x + to.w >= from.x + from.w;
  const steps = 16;
  return Array.from({ length: steps + 1 }, (_, step) => {
    const at = step / steps;
    const lead = easeOut(clamp(at / 0.7));
    const trail = easeOut(clamp((at - 0.2) / 0.8));
    const start = from.x + (to.x - from.x) * (right ? trail : lead);
    const end =
      from.x +
      from.w +
      (to.x + to.w - from.x - from.w) * (right ? lead : trail);
    return {
      left: `${start}px`,
      width: `${Math.max(0, end - start)}px`,
      offset: at,
    };
  });
};

const glide = (thumb: HTMLElement, to: Span) => {
  const style = getComputedStyle(thumb);
  const from = { x: px(style.left), w: px(style.width) };
  for (const running of thumb.getAnimations()) {
    running.cancel();
  }
  thumb.style.setProperty("left", `${to.x}px`);
  thumb.style.setProperty("width", `${to.w}px`);
  if (still() || from.w === 0 || (from.x === to.x && from.w === to.w)) {
    return;
  }
  thumb.animate(framesOf(from, to), {
    duration: durations.ui,
    easing: "linear",
  });
};

const chosenTab = (row: HTMLElement) =>
  row.querySelector<HTMLElement>(':scope > [role=tab][aria-selected="true"]');

const putThumb = (row: HTMLElement, thumb: HTMLElement) => {
  const tab = chosenTab(row);
  if (tab !== null) {
    const span = spanOf(tab);
    thumb.style.setProperty("left", `${span.x}px`);
    thumb.style.setProperty("width", `${span.w}px`);
  }
};

/** The thumb stands on the chosen tab and follows it, however it is chosen. */
const followChoice = (row: HTMLElement, thumb: HTMLElement) => {
  putThumb(row, thumb);
  row.dataset.thumb = "";
  let at = chosenTab(row);
  const chosen = new MutationObserver(() => {
    const next = chosenTab(row);
    if (next !== null && next !== at) {
      at = next;
      glide(thumb, spanOf(next));
    }
  });
  chosen.observe(row, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-selected"],
  });
  // The sidebar's width changes the tabs': at rest the thumb follows at once.
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

/** What a ref leaves when it watched nothing. */
const nothingWatched = () => {
  // Nothing was watched.
};

/** The switch's watcher, as a ref callback. */
const watchThumb: RefCallback<HTMLDivElement> = (row) => {
  const thumb =
    row?.querySelector<HTMLElement>(
      ":scope > [data-slot=sidebar-tabs-thumb]"
    ) ?? null;
  return row === null || thumb === null
    ? nothingWatched
    : followChoice(row, thumb);
};

/**
 * Whether `value` is a DOM element taking nodes. Read as the DOM's
 * ParentNode: the admin's types also hold the Workers runtime's Element
 * (its HTMLRewriter's), whose own `append` takes HTML text, and the two
 * clash on an HTMLElement.
 */
const isParentNode = (value: unknown): value is ParentNode =>
  value instanceof Element;

/** Puts `node` at the end of `parent`, as the DOM's `append` does. */
const appendTo = (parent: unknown, node: Node): void => {
  if (isParentNode(parent)) {
    parent.append(node);
  }
};

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

const leavingStyle = stylex.create({
  leaving: {
    position: "absolute",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    pointerEvents: "none",
  },
});

/**
 * The lists' crossfade as the switch turns: a still copy of the list
 * leaving is laid over the panel and fades out as the thumb sets off, then
 * the new list fades in; the panel's box never moves. Under reduced motion
 * the new list is simply there.
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
  leaving.className = stylex.props(leavingStyle.leaving).className ?? "";
  for (const child of panel.children) {
    appendTo(leaving, child.cloneNode(true));
  }
  for (const named of leaving.querySelectorAll("[id]")) {
    named.removeAttribute("id");
  }
  leaving.style.setProperty("top", `${panel.offsetTop}px`);
  leaving.style.setProperty("left", `${panel.offsetLeft}px`);
  leaving.style.setProperty("width", `${panel.offsetWidth}px`);
  leaving.style.setProperty("height", `${panel.offsetHeight}px`);
  appendTo(area, leaving);
  keepScroll(panel, leaving);
  // One list, then the other, never both.
  const out = durations.leave - durations.stagger;
  leaving.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: out,
    easing: "ease",
    fill: "forwards",
  }).onfinish = () => {
    leaving.remove();
  };
  panel.animate([{ opacity: 0 }, { opacity: 1 }], {
    delay: out,
    duration: durations.stagger,
    easing: "ease",
    fill: "backwards",
  });
};

/** Says each tab's count again when it changes, never on first paint. */
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

/** The tab ←/→, Home or End lead to; null for any other key. */
const tabFor = (
  event: KeyboardEvent<HTMLButtonElement>
): HTMLElement | null => {
  const row = event.currentTarget.closest<HTMLElement>("[role=tablist]");
  const all =
    row === null ? [] : [...row.querySelectorAll<HTMLElement>("[role=tab]")];
  const at = all.indexOf(event.currentTarget);
  if (row === null || at === -1) {
    return null;
  }
  const rtl = getComputedStyle(row).direction === "rtl";
  const last = all.length - 1;
  const forward = rtl ? "ArrowLeft" : "ArrowRight";
  const backward = rtl ? "ArrowRight" : "ArrowLeft";
  const steps: Record<string, number> = {
    [forward]: Math.min(at + 1, last),
    [backward]: Math.max(at - 1, 0),
    Home: 0,
    End: last,
  };
  const next = steps[event.key];
  return next === undefined ? null : (all[next] ?? null);
};

export const tabId = (id: string, value: string) => `${id}-tab-${value}`;
export const tabPanelId = (id: string) => `${id}-tabpanel`;

/** A tab's count: a red dot on its icon's corner, or raised at its words' end with no icon. */
const TabCount = ({ atWords = false }: { atWords?: boolean }) => (
  <span
    aria-hidden="true"
    data-slot="sidebar-tab-count"
    {...stylex.props(styles.count, atWords && styles.countAtWords)}
  />
);

const Tab = ({
  id,
  tab,
  chosen,
  panel,
  iconOnly,
  onChoose,
}: {
  id: string;
  tab: SidebarTab;
  chosen: boolean;
  panel: boolean;
  iconOnly: boolean;
  onChoose: (value: string) => void;
}) => {
  const counted = tab.count !== undefined && tab.count > 0;
  return (
    <button
      aria-controls={panel ? tabPanelId(id) : undefined}
      // Its words are its name when only its icon shows.
      aria-label={iconOnly ? tab.label : undefined}
      aria-selected={chosen}
      data-sidebar-tab={tab.value}
      id={tabId(id, tab.value)}
      onClick={() => {
        onChoose(tab.value);
      }}
      onKeyDown={(event) => {
        const next = tabFor(event);
        if (next !== null) {
          event.preventDefault();
          next.click();
          next.focus();
        }
      }}
      role="tab"
      tabIndex={chosen ? 0 : -1}
      title={iconOnly ? tab.label : undefined}
      type="button"
      {...stylex.props(styles.tab, chosen && styles.tabChosen, focusRingInset)}
    >
      <span aria-hidden="true" {...stylex.props(styles.target)} />
      {tab.icon === undefined ? null : (
        <span {...stylex.props(styles.hold)}>
          <Icon icon={tab.icon} />
          {counted ? <TabCount /> : null}
        </span>
      )}
      {iconOnly ? null : (
        <span {...stylex.props(styles.hold)}>
          <span data-slot="sidebar-tab-words" {...stylex.props(styles.words)}>
            {tab.label}
          </span>
          {counted && tab.icon === undefined ? <TabCount atWords /> : null}
        </span>
      )}
      {counted ? (
        <span {...stylex.props(visuallyHidden)}>
          {` ${tab.countLabel ?? String(tab.count)}`}
        </span>
      ) : null}
    </button>
  );
};

/**
 * The switch under the sidebar's head, or a level's views under its name:
 * one tab stop, ←/→, Home and End move and choose. From three tabs that
 * all have an icon, each shows its icon alone.
 */
export const SidebarSwitch = ({
  id,
  tabs,
  value,
  label,
  onChoose,
  panel = true,
}: {
  id: string;
  tabs: readonly SidebarTab[];
  value: string;
  label: string;
  onChoose: (value: string) => void;
  /** The tabs switch the rows under them, in a tab panel; false for views of the page. */
  panel?: boolean;
}) => {
  useCountVoice(tabs);
  const iconOnly =
    tabs.length > 2 && tabs.every((tab) => tab.icon !== undefined);
  return (
    <div {...stylex.props(styles.row)}>
      <div
        aria-label={label}
        data-slot="sidebar-tabs"
        ref={watchThumb}
        role="tablist"
        {...stylex.props(switchMarker, styles.track)}
      >
        <span
          aria-hidden="true"
          data-slot="sidebar-tabs-thumb"
          {...stylex.props(styles.thumb)}
        />
        {tabs.map((tab) => (
          <Tab
            chosen={tab.value === value}
            iconOnly={iconOnly}
            id={id}
            key={tab.value}
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
            panel={panel}
            tab={tab}
          />
        ))}
      </div>
    </div>
  );
};

const panelStyle = stylex.create({
  panel: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
});

/** The tab panel round the rows the switch chooses. */
export const SwitchPanel = ({
  id,
  value,
  children,
}: {
  id: string;
  value: string;
  children: ReactNode;
}) => (
  <div
    aria-labelledby={tabId(id, value)}
    id={tabPanelId(id)}
    role="tabpanel"
    {...stylex.props(panelStyle.panel)}
  >
    {children}
  </div>
);

/**
 * A level's head: Back (its chevron alone, named) and the level's name, a
 * link to its own first page, as one segment raised on the sidebar.
 */
export const LevelHead = ({
  title,
  icon,
  mark,
  back,
  backLabel,
  home,
  homeCurrent = false,
}: {
  title: string;
  icon?: IconData;
  mark?: ReactNode;
  /** The link Back leads by (`<Link to="/apps" />`): it takes the chevron and its name. */
  back: RenderLink;
  backLabel: string;
  /** The link to the level's own first page. */
  home: RenderLink;
  homeCurrent?: boolean;
}) => {
  let lead: ReactNode = null;
  if (mark !== undefined) {
    lead = (
      <span aria-hidden="true" {...stylex.props(styles.mark)}>
        {mark}
      </span>
    );
  } else if (icon !== undefined) {
    lead = <Icon icon={icon} />;
  }
  return (
    <div data-slot="sidebar-section-head" {...stylex.props(styles.head)}>
      <div {...stylex.props(styles.track, styles.headTrack)}>
        <div data-slot="sidebar-section-home" {...stylex.props(styles.segment)}>
          {back({
            "aria-label": backLabel,
            title: backLabel,
            "data-slot": "sidebar-back",
            className: stylex.props(styles.part, styles.back, focusRingInset)
              .className,
            children: <Icon icon={ChevronLeftIcon} />,
          })}
          <h2
            data-slot="sidebar-section-title"
            {...stylex.props(styles.heading)}
          >
            {home({
              ...(homeCurrent ? { "aria-current": "page" as const } : {}),
              className: stylex.props(styles.part, styles.home, focusRingInset)
                .className,
              children: (
                <>
                  {lead}
                  <span {...stylex.props(styles.words)}>{title}</span>
                </>
              ),
            })}
          </h2>
        </div>
      </div>
    </div>
  );
};
