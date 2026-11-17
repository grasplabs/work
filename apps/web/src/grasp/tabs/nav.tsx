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
import { renderElement } from "@ui-sdk/react/primitive";
import type { RenderProp } from "@ui-sdk/react/primitive";
import { createContext, useContext } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { focus } from "../focus/focus";
import { focusMarker } from "../focus/focus.stylex";
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
  /** Its links: TabsLink. */
  children: ReactNode;
  /** Layout only: where it sits and how wide it is. */
  layout?: TabsLayoutStyle;
}

/** Every prop a TabsLink takes. */
export interface TabsLinkProps {
  /** Its words: a short noun for its view ("Runs"). */
  children: ReactNode;
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
    </Variant.Provider>
  );
};

/** A view in the row: drawn as a tab, the current one chosen. */
const RowLink = ({
  children,
  href,
  render,
  current = false,
  segmented,
}: TabsLinkProps & { segmented: boolean }) => {
  const look = stylex.props(
    tabStyles.tab,
    styles.link,
    segmented && tabStyles.segment,
    !current && tabStyles.live,
    segmented && !current && tabStyles.segmentLive,
    current && (segmented ? tabStyles.segmentChosen : tabStyles.chosen),
    segmented ? focus.inside : [focusMarker, focus.carrier]
  );
  const words = segmented ? (
    children
  ) : (
    <span {...stylex.props(focus.label, tabStyles.label)}>{children}</span>
  );
  return renderElement(
    "a",
    {
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
              segmented && tabStyles.targetSegment
            )}
          />
          {words}
        </>
      ),
    },
    render
  );
};

/** One view's link: a short noun ("Runs"), `current` on the one you are on. */
export const TabsLink = (props: TabsLinkProps) => {
  const place = useContext(PlaceContext);
  const segmented = useContext(Variant) === "segmented";
  if (place === "menu") {
    return <MenuLink {...props} />;
  }
  if (place === "trigger") {
    return props.current === true ? <span>{props.children}</span> : null;
  }
  if (place === "ghost") {
    return (
      <span {...stylex.props(tabStyles.tab, segmented && tabStyles.segment)}>
        {props.children}
      </span>
    );
  }
  return <RowLink {...props} segmented={segmented} />;
};
