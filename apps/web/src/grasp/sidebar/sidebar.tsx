// Sidebar: a product's main navigation down the start of the window, as Ruben drew it for Grasp's
// frame (the product repo, grasp/frame/grasp-sidebar.tsx and nav.tsx, 13 November 2026), on the
// window's ground beside the page's card. Top down: the product's mark, with search and the
// sidebar's fold beside it; the rows, in groups; at the foot the person and their organisation,
// with their menu (profile.tsx). A row is quiet (the secondary words and icon) until the pointer
// is on it or the person is there, when it takes the selected fill and the primary words.
//
// Folded, it is gone and the page takes the whole width. It is still a pointer's reach away:
// resting on its edge slides it in over the page as a floating card (a peek), which slides away
// when the pointer leaves, and its fold there keeps it open again. A button at the top start
// corner opens it again. On a phone, put it in a Sheet (App shell does).
//
//   <Sidebar
//     head={<Logo />}
//     onSearch={openSearch}
//     groups={[
//       { rows: [{ label: "Chat", href: "/", icon: Conversation, current: true }] },
//       { label: "From your Apps", rows: [{ label: "Board", href: "/apps/board", icon: AppWindow }] },
//     ]}
//     profile={{ name: "Sanne de Wit", organisation: "Noordkade Finance", items: [...] }}
//   />
//
// Plain semantic HTML: an aside holding a nav of lists of links. UI SDK has no sidebar, and a
// sidebar is links, not a menu, so Tab and Enter do what they do on any page. Every value is a
// token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  createElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { MouseEvent, ReactElement, ReactNode } from "react";

import { focus } from "../focus/focus";
import { Icon, Search, SidebarToggle } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { SidebarProfile } from "./profile";
import type { SidebarProfileProps } from "./profile";

/** One of a row's own rows, under its name: a link to a page within it. */
export interface SidebarSubRow {
  /** The page's name ("Requests"). It names the link. */
  label: string;
  /** Where it goes. Leave it out when `render` gives the link. */
  href?: string;
  /**
   * The link itself, when a router draws it: `<Link to="/workflows/requests" />`. It takes the
   * row's look, its name and `aria-current`.
   */
  render?: ReactElement;
  /** The page you are on: the selected fill, said as the current page. */
  current?: boolean;
}

/** One row: a link to a page, with its icon, and a count where something waits. */
export interface SidebarRow extends SidebarSubRow {
  /** An icon before the name. From src/icons. */
  icon?: IconData;
  /** How many things wait there: a small pill at the row's end. None at 0. */
  count?: number;
  /**
   * What a screen reader hears of the count instead of the bare number ("3 things waiting").
   * @default the number
   */
  countLabel?: string;
  /** Runs when the row is pressed. A row with neither `href` nor `render` is a button. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  /** Its own rows, under its name: the pages within it. */
  rows?: readonly SidebarSubRow[];
}

/** A run of rows, with a label over it when it is not the main one. */
export interface SidebarGroup {
  /** A small label over the rows ("From your Apps"). Leave it out for the first, main run. */
  label?: string;
  /** Its rows, in order. */
  rows: readonly SidebarRow[];
}

type Layout = string | number | null;

/** What a caller may style: where the sidebar sits and how tall it is. Never its look or width. */
export type SidebarLayoutStyle = stylex.StyleXStyles<{
  alignSelf?: Layout;
  gridArea?: Layout;
  gridColumn?: Layout;
  gridRow?: Layout;
  order?: Layout;
  height?: Layout;
  minHeight?: Layout;
  maxHeight?: Layout;
  position?: Layout;
  insetBlockStart?: Layout;
}>;

/** Every prop a Sidebar takes. */
export interface SidebarProps {
  /** The rows, in runs, top to bottom. */
  groups: readonly SidebarGroup[];
  /** What stands at the top start: the product's mark, 20px tall. It is not a control. */
  head?: ReactNode;
  /** Shows a search button at the top, and runs when it is pressed (to open the search). */
  onSearch?: () => void;
  /**
   * The search button's name.
   * @default "Search"
   */
  searchLabel?: string;
  /** The keys that open the search elsewhere, shown in the button's title ("⌘K"). */
  searchShortcut?: string;
  /** The person signed in, at the foot, with their menu. */
  profile?: SidebarProfileProps;
  /** Open at first, when you do not keep it in state. @default true */
  defaultOpen?: boolean;
  /** Open or folded away, when you keep it in state. Pair it with `onOpenChange`. */
  open?: boolean;
  /** Called with the new state when the fold opens or folds it. */
  onOpenChange?: (open: boolean) => void;
  /**
   * The fold button's name, at the top, and the name of the button that opens it again.
   * @default "Show or hide the sidebar"
   */
  foldLabel?: string;
  /**
   * What the sidebar is, said to a screen reader as a landmark.
   * @default "Sidebar"
   */
  label?: string;
  /**
   * What its rows are, said to a screen reader as a navigation landmark.
   * @default "Main"
   */
  navLabel?: string;
  /** Layout only: where it sits and how tall it is. */
  style?: SidebarLayoutStyle;
}

/** How long the pointer rests on the edge before the sidebar peeks in, in ms. */
const PEEK_AFTER = 120;

/** How long the pointer may be off the peeking sidebar before it goes, in ms. */
const LEAVE_AFTER = 240;

const HOVER = media.hover;
const COARSE = media.coarse;
const FORCED = media.forced;

const styles = stylex.create({
  aside: {
    position: "relative",
    display: "flex",
    flexShrink: 0,
    alignSelf: "stretch",
    // In App shell's phone sheet it fills the sheet, so its rows and its foot run to the edge.
    width: {
      default: grasp.shellSidebar,
      [stylex.when.ancestor('[data-slot="app-shell-sheet"]')]: "100%",
    },
    height: "100%",
    minHeight: 0,
    transitionProperty: "width",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  asideFolded: { width: 0 },
  // What the sidebar holds, standing in its place while it is open.
  panel: {
    display: "flex",
    boxSizing: "border-box",
    width: {
      default: grasp.shellSidebar,
      [stylex.when.ancestor('[data-slot="app-shell-sheet"]')]: "100%",
    },
    height: "100%",
    overflow: "hidden",
    backgroundColor: grasp.shellGround,
    // In forced colours the ground is dropped, so a line marks its edge.
    borderInlineEndWidth: { default: 0, [FORCED]: grasp.hairline },
    borderInlineEndStyle: "solid",
    borderInlineEndColor: "CanvasText",
  },
  // Folded, it waits off the start edge as a floating card, and slides in over the page while it
  // peeks. In right to left it waits off the right edge.
  panelFolded: {
    position: "absolute",
    insetBlock: grasp.shellInset,
    insetInlineStart: grasp.shellInset,
    height: "auto",
    borderRadius: grasp.shellCardCorner,
    // Its lift only while it peeks: waiting off the edge, its wide shadow would tint the page's edge.
    boxShadow: "none",
    borderWidth: { default: 0, [FORCED]: grasp.hairline },
    borderStyle: "solid",
    borderColor: "CanvasText",
    transform: {
      default: `translateX(calc(-100% - 2 * ${grasp.shellInset}))`,
      ":dir(rtl)": `translateX(calc(100% + 2 * ${grasp.shellInset}))`,
    },
    transitionProperty: "transform, box-shadow",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  panelPeeking: {
    transform: { default: "none", ":dir(rtl)": "none" },
    boxShadow: grasp.shellCardShadow,
  },
  // The start edge, where resting the pointer brings it back.
  edge: {
    position: "absolute",
    insetBlock: 0,
    insetInlineStart: 0,
    width: grasp.shellInset,
  },
  inner: {
    [iconVars.size]: grasp.shellIcon,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    minHeight: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.shellText,
  },
  // The head: the mark at the start, search and the fold at the end.
  head: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.shellRowGap,
    paddingBlockStart: grasp.shellHead,
    paddingInline: grasp.shellGutter,
    paddingBlockEnd: grasp.space1,
  },
  mark: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    height: grasp.shellIconButton,
    paddingInlineStart: grasp.shellRowInline,
    color: grasp.shellText,
  },
  tools: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.shellRowGap,
    marginInlineStart: "auto",
  },
  iconButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    width: { default: grasp.shellIconButton, [COARSE]: grasp.tap },
    height: { default: grasp.shellIconButton, [COARSE]: grasp.tap },
    padding: 0,
    borderWidth: 0,
    borderRadius: grasp.shellCorner,
    color: {
      default: grasp.shellTextSecondary,
      [HOVER]: { default: grasp.shellTextSecondary, ":hover": grasp.shellText },
    },
    backgroundColor: {
      default: "transparent",
      [HOVER]: { default: "transparent", ":hover": grasp.shellHover },
    },
    cursor: "pointer",
    transitionProperty: "color, background-color",
    transitionDuration: grasp.shellAnswer,
    transitionTimingFunction: grasp.ease,
  },
  // On a phone the sidebar is in a sheet, which closes as any sheet does: no fold there.
  fold: { display: { default: "inline-flex", [media.belowTablet]: "none" } },
  // Folded, the button that opens it again stands at the top start corner, level with the head's
  // row, as Ruben's page bar has it (an App shell keeps its top bar clear of it).
  reveal: {
    position: "absolute",
    insetBlockStart: grasp.shellHead,
    insetInlineStart: grasp.shellGutter,
  },
  body: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: grasp.shellGutter,
    minHeight: 0,
    margin: 0,
    padding: grasp.shellGutter,
    overflowX: "hidden",
    overflowY: "auto",
  },
  group: { display: "flex", flexDirection: "column", gap: grasp.shellRowGap },
  groupLabel: {
    margin: 0,
    paddingInline: grasp.shellRowInline,
    paddingBlockStart: grasp.space2,
    paddingBlockEnd: grasp.space1,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    color: grasp.shellTextTertiary,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.shellRowGap,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  sub: { marginBlockStart: grasp.shellRowGap },
  row: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: grasp.shellIconGap,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    // A finger needs 44px: on a touch screen the row is that tall.
    height: { default: grasp.shellRow, [COARSE]: grasp.tap },
    margin: 0,
    paddingBlock: grasp.shellRowBlock,
    paddingInline: grasp.shellRowInline,
    borderWidth: 0,
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: grasp.shellCorner,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    letterSpacing: grasp.shellTracking,
    color: {
      default: grasp.shellTextSecondary,
      [HOVER]: { default: grasp.shellTextSecondary, ":hover": grasp.shellText },
    },
    backgroundColor: {
      default: "transparent",
      [HOVER]: { default: "transparent", ":hover": grasp.shellHover },
    },
    textDecoration: "none",
    textAlign: "start",
    whiteSpace: "nowrap",
    cursor: "pointer",
    transitionProperty: "color, background-color",
    transitionDuration: grasp.shellAnswer,
    transitionTimingFunction: grasp.ease,
  },
  // A row under a row: its name lines up with the name above.
  subRow: {
    paddingInlineStart: `calc(${grasp.shellRowInline} + ${grasp.shellIcon} + ${grasp.shellIconGap})`,
  },
  // Where the person is. In forced colours the fill is dropped, so a border marks it.
  current: {
    color: grasp.shellText,
    backgroundColor: grasp.shellSelected,
    borderWidth: { default: 0, [FORCED]: grasp.hairline },
  },
  name: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // A count: a small pill at the row's end.
  count: {
    flexShrink: 0,
    marginInlineStart: "auto",
    paddingInline: grasp.shellCountInline,
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: grasp.shellRule,
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.shellCard,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    letterSpacing: "normal",
    fontVariantNumeric: "tabular-nums",
    color: grasp.shellTextSecondary,
  },
  // Words only a screen reader reads, such as what a count is of.
  unseen: {
    position: "absolute",
    width: grasp.hairline,
    height: grasp.hairline,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
  // The foot: a rule across the sidebar, then the person.
  foot: {
    display: "flex",
    flexShrink: 0,
    justifyContent: "center",
    padding: grasp.shellGutter,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: { default: grasp.shellRule, [FORCED]: "CanvasText" },
  },
});

/** Words only a screen reader reads. */
const Unseen = ({ children }: { children: ReactNode }) => (
  <span {...stylex.props(styles.unseen)}>{children}</span>
);

/** The row's element: the caller's link, a plain link, or a button. */
/** What a row gives the caller's link element: its look, its name and whether it is the page. */
interface LinkProps {
  className?: string;
  style?: ReturnType<typeof stylex.props>["style"];
  children?: ReactNode;
  "aria-current"?: "page";
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}

const Linked = ({
  row,
  look,
  children,
  onClick,
}: {
  row: SidebarSubRow;
  look: ReturnType<typeof stylex.props>;
  children: ReactNode;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}) => {
  const shared = {
    "aria-current": row.current === true ? ("page" as const) : undefined,
    onClick,
  };
  if (row.render !== undefined && isValidElement<LinkProps>(row.render)) {
    const own = row.render.props.className;
    const props: LinkProps = {
      ...shared,
      ...look,
      className: [own, look.className]
        .filter((part) => part !== undefined && part !== "")
        .join(" "),
      children,
    };
    // The caller's element again, its own props and the row's together.
    return createElement(row.render.type, { ...row.render.props, ...props });
  }
  if (row.href !== undefined) {
    return (
      <a href={row.href} {...shared} {...look}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" {...shared} {...look}>
      {children}
    </button>
  );
};

const Row = ({ row }: { row: SidebarRow }) => {
  const counted = row.count !== undefined && row.count > 0;
  const { onClick: handleClick } = row;
  return (
    <li>
      <Linked
        row={row}
        onClick={handleClick}
        look={stylex.props(
          styles.row,
          row.current === true && styles.current,
          focus.inside
        )}
      >
        {row.icon === undefined ? null : <Icon icon={row.icon} />}
        <span {...stylex.props(styles.name)}>{row.label}</span>
        {counted && (
          <>
            <span aria-hidden="true" {...stylex.props(styles.count)}>
              {row.count}
            </span>
            <Unseen>{` ${row.countLabel ?? String(row.count)}`}</Unseen>
          </>
        )}
      </Linked>
      {row.rows !== undefined && row.rows.length > 0 && (
        <ul {...stylex.props(styles.list, styles.sub)}>
          {row.rows.map((sub) => (
            <li key={`${sub.label}-${sub.href ?? ""}`}>
              <Linked
                row={sub}
                look={stylex.props(
                  styles.row,
                  styles.subRow,
                  sub.current === true && styles.current,
                  focus.inside
                )}
              >
                <span {...stylex.props(styles.name)}>{sub.label}</span>
              </Linked>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
};

/** While it is folded, the peeking panel stays while the pointer or the keys are on it, and goes
 * when they leave it or on Escape. Returns the clean-up. */
const watchPeek = (
  element: HTMLElement,
  on: { stay: () => void; leave: () => void; close: () => void }
) => {
  const blur = (event: FocusEvent) => {
    const to = event.relatedTarget;
    if (!(to instanceof Node && element.contains(to))) {
      on.close();
    }
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      on.close();
    }
  };
  element.addEventListener("pointerenter", on.stay);
  element.addEventListener("pointerleave", on.leave);
  element.addEventListener("focusin", on.stay);
  element.addEventListener("focusout", blur);
  element.addEventListener("keydown", escape);
  return () => {
    element.removeEventListener("pointerenter", on.stay);
    element.removeEventListener("pointerleave", on.leave);
    element.removeEventListener("focusin", on.stay);
    element.removeEventListener("focusout", blur);
    element.removeEventListener("keydown", escape);
  };
};

/** A product's main navigation down the start, that folds away and peeks back in. */
export const Sidebar = ({
  groups,
  head,
  onSearch,
  searchLabel = "Search",
  searchShortcut,
  profile,
  defaultOpen = true,
  open: given,
  onOpenChange,
  foldLabel = "Show or hide the sidebar",
  label = "Sidebar",
  navLabel = "Main",
  style,
}: SidebarProps) => {
  const [own, setOwn] = useState(defaultOpen);
  const open = given ?? own;
  const [peeking, setPeeking] = useState(false);
  // 0 is never a timer's id: clearing it does nothing.
  const timer = useRef(0);
  const panel = useRef<HTMLDivElement>(null);
  const foldButton = useRef<HTMLButtonElement>(null);
  const revealButton = useRef<HTMLButtonElement>(null);
  // Where focus goes once the fold has changed it, when the keys did it.
  const refocus = useRef<"fold" | "reveal" | null>(null);
  const id = useId();

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    []
  );

  // Once the keys have folded or opened it, focus goes to the button that now stands in its place.
  useEffect(() => {
    const button = open ? foldButton.current : revealButton.current;
    const target =
      refocus.current === (open ? "fold" : "reveal") ? button : null;
    refocus.current = null;
    target?.focus();
  }, [open]);

  /** Peeks in, or goes, after `ms`, unless the pointer changes its mind. */
  const peekAfter = (next: boolean, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      // A menu open from the sidebar (the person's) stands outside it: the sidebar stays meanwhile.
      const menuOpen =
        (panel.current?.querySelector('[aria-expanded="true"]') ?? null) !==
        null;
      if (next || !menuOpen) {
        setPeeking(next);
      }
    }, ms);
  };

  // While it is folded, the peeking sidebar stays while the pointer or the keys are on it, and goes
  // when they leave it or on Escape.
  useEffect(() => {
    const element = panel.current;
    return open || element === null
      ? undefined
      : watchPeek(element, {
          stay: () => {
            window.clearTimeout(timer.current);
          },
          leave: () => {
            peekAfter(false, LEAVE_AFTER);
          },
          close: () => {
            setPeeking(false);
          },
        });
  });

  const change = (next: boolean, byKeys: boolean) => {
    window.clearTimeout(timer.current);
    setPeeking(false);
    if (byKeys) {
      refocus.current = next ? "fold" : "reveal";
    }
    if (given === undefined) {
      setOwn(next);
    }
    onOpenChange?.(next);
  };

  // The fold: folds the open sidebar away, and keeps a peeking one open.
  const fold = (event: MouseEvent<HTMLButtonElement>) => {
    change(!open, event.detail === 0);
  };

  const shown = open || peeking;
  const title =
    searchShortcut !== undefined && searchShortcut !== ""
      ? `${searchLabel} (${searchShortcut})`
      : searchLabel;

  return (
    <aside
      aria-label={label}
      data-slot="sidebar"
      data-folded={open ? undefined : ""}
      {...stylex.props(styles.aside, !open && styles.asideFolded, style)}
    >
      {!open && (
        <>
          <div
            aria-hidden="true"
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") {
                peekAfter(true, PEEK_AFTER);
              }
            }}
            onPointerLeave={() => {
              if (!peeking) {
                window.clearTimeout(timer.current);
              }
            }}
            {...stylex.props(styles.edge)}
          />
          {!peeking && (
            <button
              ref={revealButton}
              type="button"
              aria-label={foldLabel}
              title={foldLabel}
              aria-expanded={false}
              aria-controls={`${id}-panel`}
              onClick={(event) => {
                change(true, event.detail === 0);
              }}
              {...stylex.props(styles.iconButton, styles.reveal, focus.ring)}
            >
              <Icon icon={SidebarToggle} />
            </button>
          )}
        </>
      )}
      <div
        id={`${id}-panel`}
        ref={panel}
        // Off the window and out of reach while it is folded and not peeking: no tab stop lands on
        // what cannot be seen.
        inert={!shown}
        {...stylex.props(
          styles.panel,
          !open && styles.panelFolded,
          !open && peeking && styles.panelPeeking
        )}
      >
        <div {...stylex.props(styles.inner)}>
          <div {...stylex.props(styles.head)}>
            {head !== undefined && (
              <div {...stylex.props(styles.mark)}>{head}</div>
            )}
            <div {...stylex.props(styles.tools)}>
              {onSearch !== undefined && (
                <button
                  type="button"
                  aria-label={searchLabel}
                  title={title}
                  onClick={() => {
                    onSearch();
                  }}
                  {...stylex.props(styles.iconButton, focus.ring)}
                >
                  <Icon icon={Search} />
                </button>
              )}
              <button
                ref={foldButton}
                type="button"
                aria-label={foldLabel}
                title={foldLabel}
                aria-expanded={open}
                aria-controls={`${id}-panel`}
                onClick={fold}
                {...stylex.props(styles.iconButton, styles.fold, focus.ring)}
              >
                <Icon icon={SidebarToggle} />
              </button>
            </div>
          </div>
          <nav aria-label={navLabel} {...stylex.props(styles.body)}>
            {groups.map((group, index) => {
              const heading =
                group.label !== undefined && group.label !== ""
                  ? `${id}-group-${index}`
                  : undefined;
              return (
                <div key={group.label ?? index} {...stylex.props(styles.group)}>
                  {heading !== undefined && (
                    <p id={heading} {...stylex.props(styles.groupLabel)}>
                      {group.label}
                    </p>
                  )}
                  <ul aria-labelledby={heading} {...stylex.props(styles.list)}>
                    {group.rows.map((row) => (
                      <Row key={`${row.label}-${row.href ?? ""}`} row={row} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </nav>
          {profile !== undefined && (
            <div {...stylex.props(styles.foot)}>
              <SidebarProfile {...profile} />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};
