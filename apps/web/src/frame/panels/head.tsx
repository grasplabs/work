import { Button } from "@grasp-os/ui/components/button";
import { DropdownMenuMore } from "@grasp-os/ui/components/dropdown-menu";
import type { DropdownMenuMoreItem } from "@grasp-os/ui/components/dropdown-menu";
import { Input } from "@grasp-os/ui/components/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverFooter,
  PopoverTitle,
} from "@grasp-os/ui/components/popover";
import {
  Icon,
  Maximize2Icon,
  PanelRightIcon,
  PencilIcon,
  XIcon,
} from "@grasp-os/ui/lib/icons";
import { focusRing, visuallyHidden } from "@grasp-os/ui/lib/styles";
import {
  colors,
  font,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
// Damsko's icon module has no window, exit full screen or leave-for-a-page
// arrow: Hugeicons' own drawings, as #2503 drew them, through Damsko's Icon.
import {
  AppWindowIcon,
  ArrowShrink01Icon,
  ArrowUpRight01Icon,
} from "@hugeicons/core-free-icons";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  createContext,
  isValidElement,
  use,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type {
  KeyboardEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
  SubmitEvent,
} from "react";

import { PanelPlaceContext } from "./float-window.tsx";
import type { PanelPlacement } from "./float-window.tsx";
import { SHELL } from "./shell.ts";

// Below this the shell is a phone's: the panels lie over the page, so there is no placement to switch.
const NARROW_REM = 40;
// The panel's words and its Composer stand in one column: the page's room in from the panel's sides,
// and, where the panel is wider than a chat's column (full screen), that column centred, the
// Composer's width, as a chat's own page lays it out (patterns/chat-page). `cqi` is the panels'
// card, a size container (panels.tsx `panels`).
const COLUMN = `max(${size.appShellPageInline}, calc((100cqi - ${size.promptInputWidth}) / 2))`;

const styles = stylex.create({
  // One bar's height (shellBar), the name where the page's words begin and the last button's glyph
  // the same room from the card's end (FRESH.md F63), as the page's bar.
  head: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space["1"],
    flexShrink: 0,
    minWidth: 0,
    minHeight: size.appShellBar,
    paddingInlineStart: size.appShellPageInline,
    paddingInlineEnd: `calc(${size.appShellPageInline} - (${size.controlSm} - ${size.iconSm}) / 2)`,
    color: colors.sidebarForeground,
  },
  // Floating: the head's ground is the window's handle, a control under the name and the buttons. It
  // takes a finger's drag (no scrolling from it), and no words are selected while it moves.
  move: {
    position: "absolute",
    inset: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    cursor: { default: "grab", ":active": "grabbing" },
    touchAction: "none",
    userSelect: "none",
  },
  dragging: { cursor: "grabbing" },
  // While the head is the window's handle, a finger on any of it (the name too) drags it: the browser
  // never takes it as a pan of the page, which would cancel the drag.
  handle: { touchAction: "none" },
  // Its focus ring inside its own box: the window clips what stands outside it.
  ring: { outlineOffset: `calc(-1 * ${size.ringWidth})` },
  // The name and the buttons over the handle.
  above: { position: "relative" },
  // Floating, a press on the name's room (not on its words) goes through to the handle under it.
  passThrough: { pointerEvents: "none" },
  title: { display: "flex", flexGrow: 1, minWidth: 0 },
  // The name itself takes presses again inside the room that passes them through.
  takesPresses: { pointerEvents: "auto" },
  // The name: one line, never wrapped, faded out at its end when it runs past its room.
  name: {
    display: "block",
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    borderRadius: radius.sm,
  },
  fades: {
    maskImage: {
      default: `linear-gradient(to right, black calc(100% - ${space["8"]}), transparent)`,
      ":dir(rtl)": `linear-gradient(to left, black calc(100% - ${space["8"]}), transparent)`,
    },
  },
  // As a button, with no look of one: the name's own words, where they stood.
  renamable: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    textAlign: "start",
    cursor: "text",
  },
  // The words at their own width, so the name's box can tell when they outgrow it.
  words: { display: "inline-block" },
  field: { display: "flex", flexDirection: "column", gap: space["3"] },
  // The panel's body: the page's room under the head's line (the page's own padding above its words
  // under the bar), so the hairline keeps clear space on both sides, and the page's room at its sides.
  // It scrolls with no bar of its own (the product's rule), its words going under the line, cut at
  // its foot, never over it.
  body: {
    minHeight: 0,
    flexGrow: 1,
    overflowY: "auto",
    scrollbarWidth: "none",
    paddingInline: COLUMN,
    paddingBlockStart: space["7"],
  },
  // The head's buttons: one gap apart, never a line between (#2503's bar actions).
  actions: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
  },
  // Floating, the window is a layer over the page: its scroll keeps the wheel (PRODUCT-RULES 5).
  contained: { overscrollBehavior: "contain" },
  // Filled by one thing that scrolls itself (a Thread): no scroll of its own, and that one thing the
  // body's whole height, so its own scroll has a height to work in. The same room round it.
  fill: {
    display: "grid",
    gridTemplateRows: "minmax(0, 1fr)",
    overflowY: "hidden",
  },
});

const noItems: readonly DropdownMenuMoreItem[] = [];

/** Every prop a PanelHead takes. */
export interface PanelHeadProps {
  /** The panel's name: a `PanelTitle`, or words of your own. */
  title: ReactNode;
  /**
   * Your own items in the head's "…" menu, after its own (a new chat, delete): a host's extra
   * actions are menu items, not icons, so the head keeps three buttons at most.
   */
  menu?: readonly DropdownMenuMoreItem[];
  /** Closes the panel: the head's last button. Without it, no close button. */
  onClose?: () => void;
  /** The panel's own page: a link to it, "Open as a page", where you give one. */
  pageHref?: string;
  /**
   * The element that link is drawn as, for a router's link (`pageRender={<Link to="/chat/42" />}`),
   * so opening the page does not load the whole app again. It takes the item's look and its
   * name, and keeps its own props. Without it, an `<a href={pageHref}>`.
   */
  pageRender?: ReactElement<Record<string, unknown>>;
  /**
   * Whether the panel is full screen: keep it with `onExpandedChange` and give it to the panels'
   * `covered`. Docked or floating, it goes full screen and comes back to where it was, in one move.
   */
  expanded?: boolean;
  /** Runs when the person takes the panel full screen or back; without it, no full-screen control. */
  onExpandedChange?: (expanded: boolean) => void;
}

/** A press on the head's Rename item: the title's rename opens (a count, so each press is new). */
const RenameAsked = createContext(0);

/** Whether the title can be renamed: a PanelTitle (or a name of the host's) given `onRename`. */
const renamable = (title: ReactNode) =>
  isValidElement<{ onRename?: unknown }>(title) &&
  typeof title.props.onRename === "function";

/** Whether the shell round the head is a phone's (under 40rem), where there is no placement to switch. */
const useNarrow = (head: HTMLElement | null) => {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const watch = (shell: HTMLElement) => {
      const rem =
        Number(
          getComputedStyle(document.documentElement).fontSize.replace("px", "")
        ) || 16;
      const observer = new ResizeObserver(() => {
        setNarrow(shell.getBoundingClientRect().width < NARROW_REM * rem);
      });
      observer.observe(shell);
      return () => {
        observer.disconnect();
      };
    };
    const shell = head?.closest<HTMLElement>(SHELL);
    return shell === null ||
      shell === undefined ||
      typeof ResizeObserver === "undefined"
      ? undefined
      : watch(shell);
  }, [head]);
  return narrow;
};

/** The "…" menu's items: the placement switch, the page's link, rename, then the host's own. */
const menuOf = ({
  placement,
  page,
  rename,
  own,
}: {
  placement: DropdownMenuMoreItem | undefined;
  page: DropdownMenuMoreItem | undefined;
  rename: DropdownMenuMoreItem | undefined;
  own: readonly DropdownMenuMoreItem[];
}) =>
  [placement, page, rename, ...own].filter(
    (item): item is DropdownMenuMoreItem => item !== undefined
  );

/** The head's own controls: full screen, then "…" with everything else. */
const HeadControls = ({
  setPlacement,
  next,
  pageHref,
  pageRender,
  expanded,
  onExpandedChange,
  narrow,
  onRename,
  menu,
}: {
  setPlacement?: (placement: PanelPlacement) => void;
  next: PanelPlacement;
  pageHref?: string;
  pageRender?: ReactElement<Record<string, unknown>>;
  expanded: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  narrow: boolean;
  onRename: (() => void) | undefined;
  menu: readonly DropdownMenuMoreItem[];
}) => {
  const { t } = useLingui();
  const page = pageHref !== undefined || pageRender !== undefined;
  const items = menuOf({
    // The switch has nothing to switch on a phone, where both placements are the same panels.
    placement:
      setPlacement === undefined || narrow
        ? undefined
        : {
            label:
              next === "floating"
                ? t`Float over the page`
                : t`Dock beside the page`,
            icon: next === "floating" ? AppWindowIcon : PanelRightIcon,
            onSelect: () => {
              setPlacement(next);
            },
          },
    page: page
      ? {
          label: t`Open as a page`,
          icon: ArrowUpRight01Icon,
          ...(pageHref === undefined ? {} : { href: pageHref }),
          ...(pageRender === undefined ? {} : { render: pageRender }),
        }
      : undefined,
    rename:
      onRename === undefined
        ? undefined
        : { label: t`Rename`, icon: PencilIcon, onSelect: onRename },
    own: menu,
  });
  return (
    <>
      {onExpandedChange === undefined ? null : (
        <Button
          aria-label={expanded ? t`Leave full screen` : t`Full screen`}
          aria-pressed={expanded}
          onClick={() => {
            onExpandedChange(!expanded);
          }}
          size="icon-sm"
          variant="ghost"
        >
          <Icon icon={expanded ? ArrowShrink01Icon : Maximize2Icon} />
        </Button>
      )}
      {items.length > 0 && (
        <DropdownMenuMore aria-label={t`More actions`} items={items} />
      )}
    </>
  );
};

/** The head of what stands in the panels: its name, the placement switch, and your actions. */
export const PanelHead = ({
  title,
  menu = noItems,
  onClose,
  pageHref,
  pageRender,
  expanded = false,
  onExpandedChange,
}: PanelHeadProps) => {
  const { t } = useLingui();
  const place = use(PanelPlaceContext);
  const [head, setHead] = useState<HTMLDivElement | null>(null);
  const narrow = useNarrow(head);
  const [renameAsked, setRenameAsked] = useState(0);
  const { setPlacement, handleMovePress, handleMoveKey } = place;
  const hint = useId();
  const next = place.placement === "floating" ? "docked" : "floating";
  return (
    <div
      ref={setHead}
      data-slot="app-shell-panel-head"
      data-floating={place.floating ? "" : undefined}
      {...stylex.props(
        styles.head,
        (place.floating || place.pullable) && styles.handle
      )}
    >
      {/* Floating, the head's ground is the window's handle: a control of its own under the name and
          the buttons, dragged, or focused and moved with the arrow keys. */}
      {(place.floating || place.pullable) && (
        <button
          type="button"
          aria-label={t`Move the panel`}
          aria-describedby={place.floating ? hint : undefined}
          // Docked, the handle is for a pointer's pull only: the switch does the same from the keys.
          tabIndex={place.floating ? undefined : -1}
          data-slot="app-shell-panel-move"
          onPointerDown={handleMovePress}
          onKeyDown={handleMoveKey}
          {...stylex.props(
            styles.move,
            place.dragging && styles.dragging,
            focusRing,
            styles.ring
          )}
        />
      )}
      {place.floating && (
        <span id={hint} {...stylex.props(visuallyHidden)}>
          {t`Arrow keys move it, Shift for a longer step, End docks it beside the page, Escape goes back to the page`}
        </span>
      )}
      <div
        data-head-title=""
        {...stylex.props(
          styles.title,
          styles.above,
          (place.floating || place.pullable) && styles.passThrough
        )}
      >
        <RenameAsked value={renameAsked}>{title}</RenameAsked>
      </div>
      <div {...stylex.props(styles.above, styles.actions)}>
        <HeadControls
          setPlacement={setPlacement}
          next={next}
          pageHref={pageHref}
          pageRender={pageRender}
          expanded={expanded}
          onExpandedChange={onExpandedChange}
          narrow={narrow}
          onRename={
            renamable(title)
              ? () => {
                  setRenameAsked(renameAsked + 1);
                }
              : undefined
          }
          menu={menu}
        />
        {onClose === undefined ? null : (
          <Button
            aria-label={t`Close`}
            onClick={onClose}
            size="icon-sm"
            variant="ghost"
          >
            <Icon icon={XIcon} />
          </Button>
        )}
      </div>
    </div>
  );
};

/** Every prop a PanelBody takes. */
export interface PanelBodyProps {
  /** What the panel holds under its head: a thread, a page's words. */
  children: ReactNode;
  /**
   * For one thing that scrolls itself, such as a thread: the body does not scroll, and that one thing
   * takes its whole height, so its own scroll works. Without it the body scrolls what it holds.
   * @default false
   */
  fill?: boolean;
}

/**
 * The panel's content under its head: the page's room under the head's line and at its sides, and
 * its own scroll with no bar. Put a box or a foot after it, not in it.
 */
export const PanelBody = ({ children, fill = false }: PanelBodyProps) => {
  const { floating } = use(PanelPlaceContext);
  return (
    <div
      data-slot="app-shell-panel-body"
      data-fill={fill ? "" : undefined}
      {...stylex.props(
        styles.body,
        floating && styles.contained,
        fill && styles.fill
      )}
    >
      {children}
    </div>
  );
};

/** Every prop a PanelTitle takes. */
export interface PanelTitleProps {
  /** The panel's name, as it stands now ("New chat"). */
  children: string;
  /** Runs with the new name when the person renames it; without it, the name cannot be renamed. */
  onRename?: (name: string) => void;
}

/** Watches whether the name runs past its room: its box, and its words, which grow with a new name.
 * Returns the clean-up. */
const watchFit = (element: HTMLElement, setOver: (over: boolean) => void) => {
  const observer = new ResizeObserver(() => {
    setOver(element.scrollWidth > element.clientWidth + 1);
  });
  observer.observe(element);
  if (element.firstElementChild !== null) {
    observer.observe(element.firstElementChild);
  }
  return () => {
    observer.disconnect();
  };
};

/** How far a press may travel and still be a press, not a move: a few pixels. */
const MOVED = 4;

/** Whether a key on the name opens the rename: F2, or Enter as on any button. */
const opensRename = (event: KeyboardEvent<HTMLElement>) =>
  event.key === "F2" || event.key === "Enter";

/** The panel's name in its head: one line, faded at its end, renamed in a small popup. */
export const PanelTitle = ({ children, onRename }: PanelTitleProps) => {
  const { t } = useLingui();
  const { handleMovePress } = use(PanelPlaceContext);
  const hint = useId();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const setButton = (button: HTMLButtonElement | null) => {
    setElement(button);
  };
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(children);
  useEffect(
    () =>
      element === null || typeof ResizeObserver === "undefined"
        ? undefined
        : watchFit(element, setOver),
    [element]
  );
  const canRename = onRename !== undefined;
  const start = () => {
    setDraft(children);
    setOpen(true);
  };
  // The head's Rename item: each press of it opens the field once.
  const asked = use(RenameAsked);
  const [seenAsk, setSeenAsk] = useState(asked);
  if (asked !== seenAsk) {
    setSeenAsk(asked);
    if (canRename) {
      setDraft(children);
      setOpen(true);
    }
  }
  // A press renames, unless it moved a floating window: where it went down, to tell the two apart.
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    pressedAt.current = { x: event.clientX, y: event.clientY };
    handleMovePress?.(event);
  };
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    const from = pressedAt.current;
    pressedAt.current = null;
    // A key's click (Enter) is the key handler's; only a pointer's press that stayed put renames here.
    if (
      from === null ||
      Math.hypot(event.clientX - from.x, event.clientY - from.y) > MOVED
    ) {
      return;
    }
    start();
  };
  const save = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = draft.trim();
    if (name !== "" && name !== children) {
      onRename?.(name);
    }
    setOpen(false);
  };
  const look = stylex.props(
    styles.name,
    over && styles.fades,
    canRename && styles.renamable,
    canRename && styles.takesPresses,
    canRename && focusRing
  );
  const words = <span {...stylex.props(styles.words)}>{children}</span>;
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (opensRename(event)) {
      event.preventDefault();
      event.stopPropagation();
      start();
    }
  };
  if (!canRename) {
    return (
      <span
        ref={setElement}
        data-slot="app-shell-panel-title"
        title={over ? children : undefined}
        {...look}
      >
        {words}
      </span>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* A press on the name renames it, unless the press moved a floating window (the head's
          handle lies under it); so do a double-click, F2 and Enter. */}
      <PopoverAnchor asChild>
        <button
          ref={setButton}
          type="button"
          data-slot="app-shell-panel-title"
          title={over ? children : undefined}
          aria-haspopup="dialog"
          aria-describedby={hint}
          onClick={handleClick}
          onDoubleClick={start}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          {...look}
        >
          {words}
        </button>
      </PopoverAnchor>
      <span id={hint} {...stylex.props(visuallyHidden)}>
        {t`Press or press F2 to rename`}
      </span>
      <PopoverContent align="start" side="bottom">
        <form onSubmit={save} {...stylex.props(styles.field)}>
          <PopoverTitle>{t`Rename`}</PopoverTitle>
          <Input aria-label={t`Name`} onValueChange={setDraft} value={draft} />
          <PopoverFooter>
            <Button
              onClick={() => {
                setOpen(false);
              }}
              size="sm"
              variant="ghost"
            >
              {t`Cancel`}
            </Button>
            <Button size="sm" type="submit">
              {t`Save`}
            </Button>
          </PopoverFooter>
        </form>
      </PopoverContent>
    </Popover>
  );
};
