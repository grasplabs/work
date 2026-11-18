// TabsNav and TabsLink: views of one thing that each have their own address (an app's Overview,
// Runs and Settings, each a route), drawn as Tabs are: the line or the segmented track, the current
// one marked. Not a tablist: tabs switch panels in place, and a screen reader says "tab" for them;
// these go somewhere, so they are a navigation of links (`<nav>`) with aria-current="page" on the
// one you are on, and no panels. Each link is its own Tab stop, as links are; the arrow keys, Home
// and End also move focus along the row, as on Tabs. Where the links do not fit the nav's width,
// they fold to one button with the current view, whose menu (Dropdown menu's) holds the same links;
// they never wrap and never scroll sideways. Its children are TabsLinks, directly.
//
//   <TabsNav label="Run">
//     <TabsLink href="/runs/42" current>Overview</TabsLink>
//     <TabsLink render={<RouterLink to="/runs/42/logs" />}>Logs</TabsLink>
//   </TabsNav>
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { mergeProps, renderElement } from "@ui-sdk/react/primitive";
import type { RenderProp } from "@ui-sdk/react/primitive";
import { createContext, useContext } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { focus } from "../focus/focus";
import { focusMarker } from "../focus/focus.stylex";
import { Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { WithTip } from "../tooltip/lazy-tip";
import { Fold, MenuLink } from "./fold";
import { PlaceContext } from "./place";
import { tabStyles, watchRow, watchSides } from "./tabs";
import type { TabsLayoutStyle } from "./tabs";
import { rowMarker } from "./tabs.stylex";

/** Every prop a TabsNav takes. */
export interface TabsNavProps {
  /** What the views are of, as a screen reader and an agent say it ("Run"): the navigation's name. */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /**
   * `line`, words on one hairline, the current one underlined; `segmented`, words on a soft track,
   * the current one raised. The same two looks as Tabs.
   * @default "line"
   */
  variant?: "line" | "segmented";
  /**
   * Only the current link shows its words; every other link with an `icon` shows the icon alone,
   * its words its tooltip and still its name. For a view switch in a narrow bar (Preview, Code, Data,
   * Settings). The words ease in and out as the current view changes.
   * @default false
   */
  compact?: boolean;
  /** Its links: TabsLink. */
  children: ReactNode;
  /** Layout only: where it sits and how wide it is. */
  layout?: TabsLayoutStyle;
}

/** Every prop a TabsLink takes. */
export interface TabsLinkProps {
  /** Its words: a short noun for its view ("Runs"). */
  children: ReactNode;
  /** An icon before the words. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** Where it goes. Leave it out when `render` is a router's own link that carries it. */
  href?: string;
  /**
   * The element it is drawn as, for a router's link (`render={<Link to="/runs" />}`): it gets the
   * look, the words and aria-current, and keeps its own props. Without it, an `<a href>`.
   */
  render?: RenderProp;
  /**
   * The view you are on: drawn as the chosen tab and said as the current page. Set it from your own
   * route match, never from a router link's active state: a link whose search only partly matches
   * marks itself active, and two links would then be current.
   * @default false
   */
  current?: boolean;
}

// Folding, in CSS alone, so the first paint is already right (no measuring, no flash), on the server
// as in the browser. The box is a size container: 100cqw is the room the nav has. The wide row is
// as wide as its links, and never narrower than the box (100%). Where it is wider than the box, its
// overflow (100% - 100cqw) is above 0, and the row moves that, times a thousand, out of sight
// towards the reading start; the fold layer, as wide as the row, moves back by the same and so
// stands in view. Where the row fits, the overflow is 0: the row stays, and the fold layer moves
// out of sight instead. Nothing is cut, and nothing wraps or scrolls.
// The overflow is taken less a pixel, and never below 0: WebKit (26) resolves the box's 100cqw a
// fraction of a pixel short of the row's 100% (571.77 against 572px at 768), and the thousandfold
// below turned that fraction into a 234px shift, the row out of sight with nothing folded (check-tabs,
// "fold", in WebKit). A row less than a pixel too wide stays; one any wider folds as before.
const SIGN = "var(--grasp-fold-sign, 1)";
const OVER = "max(0px, 100% - 100cqw - 1px)";

const styles = stylex.create({
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
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "inline-flex",
    flexShrink: 0,
  },
  // The words in a column that eases between their width and none, so a compact link's words come
  // and go without a jump; at once under reduced motion.
  words: {
    display: "inline-grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    transitionProperty: "grid-template-columns",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
  },
  wordsAway: {
    gridTemplateColumns: "minmax(0, 0fr)",
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
      [media.coarse]: `min(calc(-1 * ${grasp.tabGap} / 2), calc((100% - ${grasp.tap}) / 2))`,
    },
  },
  targetIconSegment: {
    insetInline: {
      default: null,
      [media.coarse]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
    },
  },
  // After an icon, the words stand a step off it; the step goes with them when they go.
  wordsAfterIcon: {
    paddingInlineStart: grasp.space2,
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
    "--grasp-fold-sign": { default: "-1", ":dir(rtl)": "1" },
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
});

const Variant = createContext<"line" | "segmented">("line");
const Compact = createContext(false);

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
  const row = event.currentTarget.closest<HTMLElement>("[data-slot=tabs-nav]");
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
 * the CSS above has moved them away. It only reads which one shows; it draws nothing, so the page is
 * right before it runs and without script. Set from a ref, never in an effect.
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

/** A row of links that looks like Tabs, folding to one menu button where they do not fit. */
export const TabsNav = ({
  label: labelDeprecated,
  "aria-label": label = labelDeprecated ?? "",
  variant = "line",
  compact = false,
  children,
  layout,
}: TabsNavProps) => {
  const segmented = variant === "segmented";
  const list = stylex.props(
    rowMarker,
    tabStyles.list,
    segmented && tabStyles.listSegmented
  );
  return (
    <Variant.Provider value={variant}>
      <Compact.Provider value={compact}>
        <nav
          aria-label={label}
          data-slot="tabs-nav"
          {...stylex.props(tabStyles.root, layout)}
        >
          <div aria-hidden="true" inert {...stylex.props(styles.ghost)}>
            <div className={list.className}>
              <PlaceContext.Provider value="ghost">
                {children}
              </PlaceContext.Provider>
            </div>
          </div>
          <div ref={watchFold} {...stylex.props(styles.box)}>
            <div data-tabs-wide="" {...stylex.props(styles.wide)}>
              <div
                ref={segmented ? watchSides : watchRow}
                data-tabs-row=""
                className={list.className}
              >
                {children}
                {!segmented && (
                  <span
                    aria-hidden="true"
                    data-tab-glide=""
                    {...stylex.props(tabStyles.glide)}
                  />
                )}
              </div>
              <div data-tabs-fold="" {...stylex.props(styles.fold)}>
                <div {...stylex.props(styles.foldStart)}>
                  <Fold label={label} segmented={segmented}>
                    {children}
                  </Fold>
                </div>
              </div>
            </div>
          </div>
        </nav>
      </Compact.Provider>
    </Variant.Provider>
  );
};

/** A link's icon and words; with `away`, the words gone to the icon alone. */
const Inside = ({
  icon,
  away,
  children,
}: {
  icon: IconData;
  away: boolean;
  children: ReactNode;
}) => (
  <>
    <span aria-hidden="true" {...stylex.props(styles.icon)}>
      <Icon icon={icon} />
    </span>
    <span {...stylex.props(styles.words, away && styles.wordsAway)}>
      <span {...stylex.props(styles.wordsInner)}>
        <span {...stylex.props(styles.inside, styles.wordsAfterIcon)}>
          {children}
        </span>
      </span>
    </span>
  </>
);

/** A link's look in the row: a tab or a segment, chosen when current. */
const lookOf = (segmented: boolean, current: boolean) =>
  stylex.props(
    tabStyles.tab,
    styles.link,
    segmented && tabStyles.segment,
    !current && tabStyles.live,
    segmented && !current && tabStyles.segmentLive,
    current && (segmented ? tabStyles.segmentChosen : tabStyles.chosen),
    segmented ? focus.inside : [focusMarker, focus.carrier]
  );

/** A view in the row: drawn as a tab, the current one chosen. */
const RowLink = ({
  children,
  href,
  render,
  icon,
  current = false,
  segmented,
  compact,
}: TabsLinkProps & { segmented: boolean; compact: boolean }) => {
  const look = lookOf(segmented, current);
  // Compact, a link that is not current shows its icon alone, its words its tooltip.
  const away = compact && !current && icon !== undefined;
  const inside =
    icon === undefined ? (
      children
    ) : (
      <Inside icon={icon} away={away}>
        {children}
      </Inside>
    );
  const words = segmented ? (
    inside
  ) : (
    <span
      {...stylex.props(
        focus.label,
        tabStyles.label,
        icon !== undefined && styles.inside
      )}
    >
      {inside}
    </span>
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
            tabStyles.target,
            segmented && tabStyles.targetSegment,
            away && (segmented ? styles.targetIconSegment : styles.targetIcon)
          )}
        />
        {words}
      </>
    ),
  };
  return (
    <WithTip
      // Kept on every compact link with an icon, and opened only while its words are away, so a link
      // stays one element as it becomes current and its words ease in.
      tooltip={
        compact && icon !== undefined && typeof children === "string"
          ? children
          : undefined
      }
      off={!away}
      // The tooltip shows the link's own name, so it is not also its description ("Data, Data").
      render={(tipProps: Record<string, unknown>) =>
        renderElement(
          "a",
          { ...mergeProps(tipProps, own), "aria-describedby": undefined },
          render
        )
      }
    />
  );
};

/** One view's link: a short noun ("Runs"), `current` on the one you are on. */
export const TabsLink = (props: TabsLinkProps) => {
  const place = useContext(PlaceContext);
  const segmented = useContext(Variant) === "segmented";
  const compact = useContext(Compact);
  if (place === "menu") {
    return <MenuLink {...props} />;
  }
  if (place === "trigger") {
    return props.current === true ? <span>{props.children}</span> : null;
  }
  if (place === "ghost") {
    const away = compact && props.current !== true && props.icon !== undefined;
    return (
      <span {...stylex.props(tabStyles.tab, segmented && tabStyles.segment)}>
        {props.icon === undefined ? (
          props.children
        ) : (
          <Inside icon={props.icon} away={away}>
            {props.children}
          </Inside>
        )}
      </span>
    );
  }
  return <RowLink {...props} segmented={segmented} compact={compact} />;
};
