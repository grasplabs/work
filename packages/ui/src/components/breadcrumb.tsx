// Breadcrumb: the path from the top of a site to the page you are on, in StyleX. Small type in muted
// words, each step a link, the page you are on in ink, a chevron between them that turns round in
// right-to-left text.
//
//   <Breadcrumb>
//     <BreadcrumbList>
//       <BreadcrumbItem><BreadcrumbLink href="/projects">Projects</BreadcrumbLink></BreadcrumbItem>
//       <BreadcrumbSeparator />
//       <BreadcrumbItem>
//         <BreadcrumbEllipsis>
//           <DropdownMenuItem asChild><a href="/projects/atlas">Atlas</a></DropdownMenuItem>
//         </BreadcrumbEllipsis>
//       </BreadcrumbItem>
//       <BreadcrumbSeparator />
//       <BreadcrumbItem><BreadcrumbPage>Settings</BreadcrumbPage></BreadcrumbItem>
//     </BreadcrumbList>
//   </Breadcrumb>
//
// The parts render what they say: the caller writes the separators and, for a long path, the "…"
// that holds the levels between in a Dropdown menu (an icon-only Button, so its tooltip shows its
// name). It knows no router: a router's link comes in as
// BreadcrumbLink's child, with `asChild`, and so does a button for a step that acts in place.
//
// It holds one line. When the path is wider than its room the page's name gives way first, cut off
// with an ellipsis down to a few letters, then the links; a cut-off name takes keyboard focus and its
// tooltip shows it whole. Under 640px (`auto`), or always (`back`), only the parent stays, as a back
// link. A step pressed in place that turns into the page hands its focus to the page.
"use client";

import * as stylex from "@stylexjs/stylex";
import { mergeProps, renderElement } from "@ui-sdk/react/primitive";
import { TooltipTrigger as TriggerPrimitive } from "@ui-sdk/react/tooltip";
import {
  createContext,
  createElement,
  isValidElement,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  EllipsisIcon,
  Icon,
} from "../lib/icons";
import { focusRingText } from "../lib/styles";
import {
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars, ringInsetMarker } from "../lib/vars.stylex";
import { breadcrumbVars } from "./breadcrumb.stylex";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Tooltip, TooltipContent } from "./tooltip";

// Every prop is documented once, here; the props on the docs page are read from these types.

/** Every prop a Breadcrumb takes. */
export interface BreadcrumbProps {
  /** Its BreadcrumbList. */
  children: ReactNode;
  /**
   * `auto` shows the path, and under 640px only the parent as a back link. `back` always shows the
   * back link, for a header as narrow as a phone's.
   * @default "auto"
   */
  variant?: "auto" | "back";
  /**
   * The name of the path, as a screen reader and an agent say it.
   * @default "Breadcrumb"
   */
  "aria-label"?: string;
  /** Layout only: margins and alignment. The look belongs to the breadcrumb. */
  style?: LayoutStyle;
}

/** Every prop a BreadcrumbList takes. */
export interface BreadcrumbListProps {
  /**
   * The steps from the top of the site down to the page you are on, which comes last: a
   * BreadcrumbItem each, with a BreadcrumbSeparator between them.
   */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a BreadcrumbItem takes: one step on the path. */
export interface BreadcrumbItemProps {
  /** Its BreadcrumbLink; for the page you are on, its BreadcrumbPage; or a BreadcrumbEllipsis. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a BreadcrumbLink takes. */
export interface BreadcrumbLinkProps {
  /**
   * The page's name, as its own title says it. With `asChild`, the one element drawn as the step,
   * holding the name.
   */
  children: ReactNode;
  /**
   * Where the step goes. Without it (and without `asChild`) the step is its name alone, not a link:
   * a plain step, as each folder of a file's path is.
   */
  href?: string;
  /**
   * Draws the one element given as the child instead of an `<a>`: a router's own link, or a button
   * for a step that acts in place (a folder opened again inside a dialog). It gets the look and the
   * focus ring, and keeps its own props.
   * @default false
   */
  asChild?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a BreadcrumbPage takes: the page you are on, last on the path (`aria-current="page"`). */
export interface BreadcrumbPageProps {
  /** The page's name, as its own title says it. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a BreadcrumbSeparator takes. */
export interface BreadcrumbSeparatorProps {
  /**
   * What stands between two steps; hidden from screen readers.
   * @default a chevron, mirrored right to left
   */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a BreadcrumbEllipsis takes. */
export interface BreadcrumbEllipsisProps {
  /**
   * The levels folded away, in the order of the path: a DropdownMenuItem each, most often with
   * `asChild` and the level's link (`<DropdownMenuItem asChild><a href="/atlas">Atlas</a></DropdownMenuItem>`).
   */
  children: ReactNode;
  /**
   * The button's name.
   * @default "Show hidden levels"
   */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

const PHONE = media.maxSm;
const COARSE = media.pointerCoarse;

// A link stands a little wider than its words, into the gap round it, so its ring keeps off the
// first and last letter as it does off the line above and below.
const ROOM = size.ringOffsetText;
// Room for the focus ring at the ends of the line, which clips what does not fit.
const RING = `calc(${ROOM} + ${size.ringWidth} + ${size.ringOffsetText})`;

// The parent: the item before the last. The only item: a path of one, the page itself.
const ITEM = "[data-slot=breadcrumb-item]";
const PARENT = `:nth-last-child(2 of ${ITEM})`;
const ONLY = `:nth-child(1 of ${ITEM}):nth-last-child(1 of ${ITEM})`;
const IN_PARENT = `:is(${ITEM}${PARENT} *)`;
const PAGE = ":has(> [data-slot=breadcrumb-page])";

const styles = stylex.create({
  nav: {
    minWidth: 0,
  },
  list: {
    display: "flex",
    flexWrap: "nowrap",
    alignItems: "center",
    gap: space["1"],
    margin: 0,
    marginInline: `calc(-1 * ${RING})`,
    padding: 0,
    paddingInline: RING,
    overflowX: "clip",
    listStyle: "none",
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: breadcrumbVars.mutedForeground,
    whiteSpace: "nowrap",
  },
  // The page's name gives way first, down to a few letters; the links only once it has. Flex
  // shrinks by weight times width, so the page's weight is far past any link's.
  item: {
    display: "flex",
    alignItems: "center",
    gap: space["1"],
    flexShrink: { default: 1, [PAGE]: 100_000 },
    minWidth: { default: 0, [PAGE]: "4em" },
  },
  // The back form: only the parent, and the page in a path of one. Under 640px, or always.
  itemAuto: {
    display: {
      default: "flex",
      [PHONE]: { default: "none", [`:is(${PARENT}, ${ONLY})`]: "flex" },
    },
  },
  itemBack: {
    display: { default: "none", [`:is(${PARENT}, ${ONLY})`]: "flex" },
  },
  link: {
    position: "relative",
    display: "flex",
    minWidth: 0,
    color: {
      default: breadcrumbVars.mutedForeground,
      ":hover": { default: null, [media.hover]: breadcrumbVars.foreground },
    },
    textDecoration: "none",
    paddingInline: ROOM,
    marginInline: `calc(-1 * ${ROOM})`,
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    transitionProperty: "color",
    transitionDuration: motionVars.mark,
    transitionTimingFunction: duration.ease,
    // An unseen area makes the link 24px tall, and 44px each way on a touch screen.
    "::after": {
      content: '""',
      position: "absolute",
      insetInline: {
        default: 0,
        [COARSE]: `min(0px, calc((100% - ${size.tapTarget}) / 2))`,
      },
      insetBlock: {
        default: `calc((${font.textSmLine} - ${space["6"]}) / 2)`,
        [COARSE]: `calc((${font.textSmLine} - ${size.tapTarget}) / 2)`,
      },
    },
  },
  // A step drawn as a button: none of a button's own look, so it reads as the links beside it.
  press: {
    appearance: "none",
    paddingBlock: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    textAlign: "start",
    cursor: "pointer",
  },
  words: {
    display: "block",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // A step that leads nowhere, last on its path (a file's name in a path): where the path ends, in
  // the page's ink and weight, though it is not the page you are on.
  end: {
    color: {
      default: breadcrumbVars.mutedForeground,
      ":is(li:last-child > *)": breadcrumbVars.foreground,
    },
    fontWeight: { default: null, ":is(li:last-child > *)": font.weightMedium },
  },
  page: {
    display: "block",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: breadcrumbVars.foreground,
    fontWeight: font.weightMedium,
    borderRadius: radius.sm,
    cornerShape: radius.shape,
  },
  // The chevron between steps, quieter than the words. Right to left the icon turns round itself.
  separator: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "inline-flex",
    flexShrink: 0,
    marginInline: breadcrumbVars.separatorInset,
    color: breadcrumbVars.subtleForeground,
  },
  separatorAuto: {
    display: { default: "inline-flex", [PHONE]: "none" },
  },
  separatorBack: {
    display: "none",
  },
  // The back chevron, inside the parent's link: as far from its words as a chevron from a level's.
  // Its drawing starts 9/24 into its box, so the box is pulled back by that: the "<" itself then
  // starts on the content's edge, and the ring stands as far before it as after the words.
  backChevron: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    flexShrink: 0,
    alignItems: "center",
    color: breadcrumbVars.subtleForeground,
    marginInlineStart: `calc(-9 / 24 * ${size.iconSm})`,
    marginInlineEnd: space["1"],
  },
  backChevronAuto: {
    display: {
      default: "none",
      [PHONE]: { default: "none", [IN_PARENT]: "inline-flex" },
    },
  },
  backChevronBack: {
    display: { default: "none", [IN_PARENT]: "inline-flex" },
  },
  // The "…": Button's small ghost square. The margins round it hand back what it is taller than
  // the line, so the trail stays one line high, and what it is wider than its "…", so the "…"
  // stands as far from the chevrons as a level's words do.
  ellipsis: {
    display: "inline-flex",
    flexShrink: 0,
    marginBlock: `calc((${font.textSmLine} - ${size.controlXs}) / 2)`,
    marginInline: `calc((${size.iconSm} - ${size.controlXs}) / 2)`,
  },
});

/** Whether the back form shows at every width (`back`), or only under 640px (`auto`). */
const Back = createContext(false);

/** The path from the top of the site to the page you are on, on one line. */
export const Breadcrumb = ({
  children,
  variant = "auto",
  "aria-label": label,
  style,
}: BreadcrumbProps) => {
  const { breadcrumb } = useI18n();
  return (
    <nav
      aria-label={label ?? breadcrumb.name}
      data-slot="breadcrumb"
      data-variant={variant}
      {...stylex.props(styles.nav, style)}
    >
      <Back value={variant === "back"}>{children}</Back>
    </nav>
  );
};

const unsubscribe = () => {
  // Nothing to undo.
};

/**
 * Keeps `within` true while focus is on the path or in its open "…" menu, and false once it goes
 * anywhere else. A focused step that leaves the page takes no blur, so it stays true.
 */
const watchFocus = (
  ol: HTMLOListElement | null,
  within: { current: boolean }
) => {
  if (ol === null) {
    return unsubscribe;
  }
  const onPath = (target: EventTarget | null) => {
    if (!(target instanceof Element)) {
      return false;
    }
    const menu = ol
      .querySelector("[aria-haspopup=menu]")
      ?.getAttribute("aria-controls");
    return (
      ol.contains(target) ||
      (menu !== null &&
        menu !== undefined &&
        target.closest("[role=menu]")?.id === menu)
    );
  };
  const focusIn = (event: FocusEvent) => {
    within.current = onPath(event.target);
  };
  // Focus going nowhere: unless its step is leaving the page, which is told once the render is done.
  const focusOut = (event: FocusEvent) => {
    const { target } = event;
    if (event.relatedTarget === null && target instanceof Node) {
      queueMicrotask(() => {
        if (target.isConnected) {
          within.current = false;
        }
      });
    }
  };
  document.addEventListener("focusin", focusIn);
  document.addEventListener("focusout", focusOut);
  return () => {
    document.removeEventListener("focusin", focusIn);
    document.removeEventListener("focusout", focusOut);
  };
};

/** A step pressed in place that became the page left focus nowhere: the page takes it. */
const handFocus = (ol: HTMLOListElement | null, within: boolean) => {
  const active = document.activeElement;
  if (ol !== null && within && (active === null || active === document.body)) {
    ol.querySelector<HTMLElement>("[data-slot=breadcrumb-page]")?.focus();
  }
};

/** The steps, on one line. */
export const BreadcrumbList = ({ children, style }: BreadcrumbListProps) => {
  const list = useRef<HTMLOListElement>(null);
  const within = useRef(false);
  useEffect(() => watchFocus(list.current, within), []);
  // After every render: a step that turned into the page hands its focus on.
  useLayoutEffect(() => {
    handFocus(list.current, within.current);
  });
  return (
    <ol
      ref={list}
      data-slot="breadcrumb-list"
      {...stylex.props(styles.list, ringInsetMarker, style)}
    >
      {children}
    </ol>
  );
};

/** One step on the path. */
export const BreadcrumbItem = ({ children, style }: BreadcrumbItemProps) => {
  const back = use(Back);
  return (
    <li
      data-slot="breadcrumb-item"
      {...stylex.props(
        styles.item,
        back ? styles.itemBack : styles.itemAuto,
        style
      )}
    >
      {children}
    </li>
  );
};

/** A step's name and where it goes; in the parent's item, the back chevron before it. */
export const BreadcrumbLink = ({
  children,
  href,
  asChild = false,
  style,
}: BreadcrumbLinkProps) => {
  const back = use(Back);
  // With asChild the words are the child's own; they go inside it, with the back chevron.
  const own =
    asChild && isValidElement<{ children?: ReactNode }>(children)
      ? children
      : undefined;
  const content = (
    <>
      <span
        aria-hidden="true"
        {...stylex.props(
          styles.backChevron,
          back ? styles.backChevronBack : styles.backChevronAuto
        )}
      >
        <Icon icon={ChevronLeftIcon} />
      </span>
      <span {...stylex.props(styles.words)}>
        {own === undefined ? children : own.props.children}
      </span>
    </>
  );
  if (own === undefined && href === undefined) {
    return (
      <span
        data-slot="breadcrumb-link"
        {...stylex.props(styles.link, styles.end, style)}
      >
        {content}
      </span>
    );
  }
  const render =
    own === undefined
      ? undefined
      : (props: Record<string, unknown>) =>
          createElement(own.type, mergeProps(props, own.props), content);
  return renderElement(
    "a",
    {
      href,
      "data-slot": "breadcrumb-link",
      ...stylex.props(
        styles.link,
        own !== undefined && styles.press,
        focusRingText,
        style
      ),
      children: content,
    },
    render
  );
};

/** Whether an element's words run past its box. */
const isCut = (element: HTMLElement) =>
  element.scrollWidth > element.clientWidth;

/**
 * The page you are on: its whole name is always in the page, so a screen reader hears all of it,
 * once. Cut off, it takes keyboard focus and its tooltip shows the name whole. It stays one element
 * either way, so focus on it survives the line growing or shrinking.
 */
export const BreadcrumbPage = ({ children, style }: BreadcrumbPageProps) => {
  const [cut, setCut] = useState(false);
  // Focus already on the name keeps it there when the name stops being cut off.
  const [held, setHeld] = useState(false);
  const watchCut = (element: HTMLElement) => {
    const measure = () => {
      setCut(isCut(element));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  };
  const watch = (element: HTMLElement | null) =>
    element === null ? undefined : watchCut(element);
  return (
    <Tooltip disabled={!cut}>
      <TriggerPrimitive
        ref={watch}
        // It takes focus while cut off, so the keyboard reaches its tooltip, and keeps it after.
        // Otherwise only from script: a step pressed in place that became the page hands it focus.
        tabIndex={cut || held ? 0 : -1}
        onFocus={() => {
          setHeld(true);
        }}
        onBlur={() => {
          setHeld(false);
        }}
        // The tooltip repeats the name, which is already the element's own words: it describes
        // nothing new, so a screen reader is not told it twice.
        render={({
          type: _type,
          "aria-describedby": _description,
          ...props
        }: Record<string, unknown>) => (
          <span
            {...props}
            aria-current="page"
            data-slot="breadcrumb-page"
            {...stylex.props(styles.page, focusRingText, style)}
          >
            {children}
          </span>
        )}
      />
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
};

/** The chevron between two steps. Screen readers skip it. */
export const BreadcrumbSeparator = ({
  children,
  style,
}: BreadcrumbSeparatorProps) => {
  const back = use(Back);
  return (
    <li
      role="presentation"
      aria-hidden="true"
      data-slot="breadcrumb-separator"
      {...stylex.props(
        styles.separator,
        back ? styles.separatorBack : styles.separatorAuto,
        style
      )}
    >
      {children ?? <Icon icon={ChevronRightIcon} />}
    </li>
  );
};

/** The "…": a button that opens the levels folded away, in a Dropdown menu, in the path's order. */
export const BreadcrumbEllipsis = ({
  children,
  "aria-label": label,
  style,
}: BreadcrumbEllipsisProps) => {
  const { breadcrumb } = useI18n();
  return (
    <span {...stylex.props(styles.ellipsis, style)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label ?? breadcrumb.ellipsis}
          >
            <Icon icon={EllipsisIcon} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">{children}</DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
};
