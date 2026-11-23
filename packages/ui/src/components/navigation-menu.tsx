// NavigationMenu: a site's main links, grouped into panels that open from a row of triggers,
// in StyleX, built on UI SDK's NavigationMenu: triggers drawn as a list's items with a chevron that turns
// over, and each panel the list popup Select and Command share, its links a title with a quiet line
// under it.
//
//   <NavigationMenu aria-label="Main">
//     <NavigationMenuList>
//       <NavigationMenuItem>
//         <NavigationMenuTrigger>Product</NavigationMenuTrigger>
//         <NavigationMenuContent>
//           <NavigationMenuLink href="/reports" description="…">Reports</NavigationMenuLink>
//         </NavigationMenuContent>
//       </NavigationMenuItem>
//       <NavigationMenuItem>
//         <NavigationMenuLink href="/pricing">Pricing</NavigationMenuLink>
//       </NavigationMenuItem>
//     </NavigationMenuList>
//   </NavigationMenu>
//
// It follows the disclosure navigation pattern: buttons show groups of ordinary links. For
// actions, use a Menubar or a Context menu.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ChangeDetails } from "@ui-sdk/core";
import {
  NavigationMenu as NavigationMenuPrimitive,
  NavigationMenuContent as ContentPrimitive,
  NavigationMenuIndicator as IndicatorPrimitive,
  NavigationMenuItem as ItemPrimitive,
  NavigationMenuLink as LinkPrimitive,
  NavigationMenuLinkIcon,
  NavigationMenuList as ListPrimitive,
  NavigationMenuTrigger as TriggerPrimitive,
  NavigationMenuViewport as ViewportPrimitive,
} from "@ui-sdk/react/navigation-menu";
import type {
  NavigationMenuOrientation,
  NavigationMenuTriggerState,
  NavigationMenuValueChangeReason,
} from "@ui-sdk/react/navigation-menu";
import { createContext, isValidElement, use, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";

import { ChevronDownIcon, Icon } from "../lib/icons";
import type { IconData } from "../lib/icons";
import { focusRing, focusRingInset, listStyles } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import { popup } from "../lib/tokens.values";
import { className, listOf, slotProps, slotWords } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";

// Every prop is documented once, here; the props on the docs page are read from these types.

/** Every prop a NavigationMenu takes. */
export interface NavigationMenuProps {
  /** The navigation's name, as a screen reader and an agent say it ("Main"). */
  "aria-label": string;
  /** Its NavigationMenuList, and an optional NavigationMenuIndicator or NavigationMenuViewport. */
  children: ReactNode;
  /** The open item's value, when you keep it in state. `null` is every panel closed. */
  value?: string | null;
  /** The item open at first. */
  defaultValue?: string | null;
  /** Runs when a panel opens or closes, with the open item's value (or `null`) and why. */
  onValueChange?: (
    value: string | null,
    details: ChangeDetails<NavigationMenuValueChangeReason>
  ) => void;
  /**
   * Which way the row runs, which picks the arrow keys that move along it.
   * @default "horizontal"
   */
  orientation?: NavigationMenuOrientation;
  /**
   * Resting the pointer on a trigger opens its panel. Pass `false` for one that opens only on a press.
   * @default true
   */
  openOnHover?: boolean;
  /** Layout only: margins and alignment. */
  style?: LayoutStyle;
}

/** Every prop a NavigationMenuList takes. */
export interface NavigationMenuListProps {
  /** The items of the row. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a NavigationMenuItem takes. */
export interface NavigationMenuItemProps {
  /** A trigger and its NavigationMenuContent, or a NavigationMenuLink straight in the row. */
  children: ReactNode;
  /** Names the item, for the panel that is open. Its trigger's words serve when it is left out. */
  value?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a NavigationMenuTrigger takes. */
export interface NavigationMenuTriggerProps {
  /**
   * The trigger's words, one or two ("Product", "Resources"); with `asChild`, the one element that
   * is the trigger, holding them.
   */
  children: ReactNode;
  /**
   * Draws the one element given as the child as the trigger: it takes the trigger's props and look,
   * and holds its words with the chevron after them.
   * @default false
   */
  asChild?: boolean;
  /**
   * Out of use: the trigger stays in the row but opens nothing.
   * @default false
   */
  disabled?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a NavigationMenuContent takes. */
export interface NavigationMenuContentProps {
  /** The panel's links (none, for a group out of use). More than three stand in two columns. */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a NavigationMenuLink takes. */
export interface NavigationMenuLinkProps {
  /** Where it goes. Leave it out when `asChild` gives a router's link that carries the address. */
  href?: string;
  /**
   * The page's name ("Reports"), or the link's words straight in the row ("Pricing"). With
   * `asChild`, the one link element, holding them.
   */
  children: ReactNode;
  /** In a panel: one quiet line on what is there. */
  description?: string;
  /** In a panel: an icon before the name. */
  icon?: IconData;
  /**
   * It is the page you are on: `aria-current="page"`.
   * @default false
   */
  active?: boolean;
  /**
   * Draws the one element given as the child, a router's link, as this link, with its look.
   * @default false
   */
  asChild?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a NavigationMenuIndicator takes. */
export interface NavigationMenuIndicatorProps {
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a NavigationMenuViewport takes. */
export interface NavigationMenuViewportProps {
  /** Layout only. */
  style?: LayoutStyle;
}

const HOVER = media.hover;
const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;

const styles = stylex.create({
  // The root holds the indicator, which is placed against it.
  root: {
    position: "relative",
  },
  list: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: {
      default: space[1],
      [COARSE]: `calc(${size.tapTarget} - ${size.controlSm}) ${space[1]}`,
    },
    margin: 0,
    padding: 0,
    listStyle: "none",
    fontFamily: font.sans,
  },
  item: {
    position: "relative",
  },
  // A trigger, or a link in the row: a list's item, lit under the pointer and while open.
  trigger: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    gap: space[1],
    minHeight: size.controlSm,
    boxSizing: "border-box",
    margin: 0,
    paddingInline: space[3],
    paddingBlock: 0,
    borderWidth: 0,
    borderRadius: `min(${radius.xl}, calc(${size.controlSm} / 2))`,
    cornerShape: radius.shape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accentHighlight },
    },
    color: colors.foreground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    textDecoration: "none",
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    transitionProperty: "background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // A finger needs 44px: an unseen area round the trigger makes up the difference. The row's gap
  // on a touch screen leaves room for it.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${size.controlSm} - ${size.tapTarget}) / 2)`,
    },
  },
  open: {
    backgroundColor: {
      default: colors.accentHighlight,
      [FORCED]: "Highlight",
    },
    color: { default: colors.foreground, [FORCED]: "HighlightText" },
  },
  disabled: {
    opacity: size.opacityDisabled,
    backgroundColor: "transparent",
    cursor: "not-allowed",
  },
  chevron: {
    display: "inline-flex",
    color: colors.mutedForeground,
    transitionProperty: "transform",
    transitionDuration: motionVars.leave,
    transitionTimingFunction: duration.ease,
  },
  chevronOpen: {
    transform: "rotate(0.5turn)",
    transitionDuration: motionVars.popup,
  },
  // The page you are on, or the group that holds it: underlined in the text colour, so it reads
  // apart from a hover, and in forced colours too.
  active: {
    textDecorationLine: "underline",
    textDecorationThickness: size.hairline,
    textUnderlineOffset: size.linkUnderlineOffset,
  },

  // The panel: the popup, one column of links, or two when there are more than three.
  panel: {
    display: "grid",
    gap: space[1],
    width: `min(${size.popoverWidth}, 100vw - 2 * ${space.popupGutter})`,
    marginBlock: 0,
  },
  panelWide: {
    gridTemplateColumns: { default: "1fr 1fr", [media.maxSm]: "1fr" },
    width: `min(calc(${size.popoverWidth} * 1.6), 100vw - 2 * ${space.popupGutter})`,
    maxWidth: `calc(100vw - 2 * ${space.popupGutter})`,
  },
  // A link in a panel: its name, and a quiet line under it.
  link: {
    display: "grid",
    // With no icon in the panel the words start at the link's edge; with one, every link keeps
    // its slot (linkIcons), so the column of names stays one edge.
    gridTemplateColumns: "0 minmax(0, 1fr)",
    columnGap: 0,
    alignContent: "start",
    height: "100%",
    boxSizing: "border-box",
    minHeight: { default: size.controlDefault, [COARSE]: size.tapTarget },
    paddingBlock: space[2],
    paddingInline: space[3],
    borderRadius: `min(${radius.lg}, calc(${size.controlLg} / 2))`,
    cornerShape: radius.shape,
    color: colors.foreground,
    textDecoration: "none",
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accentHighlight },
      ":focus-visible": colors.accentHighlight,
    },
    transitionProperty: "background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  linkIcons: {
    gridTemplateColumns: `${size.iconSm} minmax(0, 1fr)`,
    columnGap: space[2],
  },
  linkIcon: {
    display: "inline-flex",
    gridRow: "1 / span 2",
    paddingBlockStart: `calc((${font.textSmLine} - ${size.iconSm}) / 2)`,
    color: colors.mutedForeground,
  },
  linkTitle: {
    gridColumn: 2,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
  },
  linkDescription: {
    gridColumn: 2,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
    textWrap: "pretty",
  },

  // The line under the open trigger, or under the link of the page you are on while every panel
  // is closed. UI SDK places it and shows it.
  indicator: {
    position: "absolute",
    // UI SDK measures the active item in physical pixels from the root's corner, in either direction.
    left: 0,
    top: 0,
    width: "var(--active-item-width)",
    height: `calc(2 * ${size.hairline})`,
    transform: `translate(var(--active-item-left), calc(var(--active-item-bottom) - 2 * ${size.hairline}))`,
    backgroundColor: { default: colors.foreground, [FORCED]: "CanvasText" },
    opacity: { default: 0, ":is([data-visible])": 1 },
    pointerEvents: "none",
    transitionProperty: "transform, width, opacity",
    transitionDuration: motionVars.popup,
    transitionTimingFunction: duration.ease,
  },
  // The one frame every panel opens in, when there is one: as large as the open panel, which draws
  // its own surface inside it.
  viewport: {
    width: "var(--viewport-width)",
    height: "var(--viewport-height)",
    transitionProperty: "width, height",
    transitionDuration: motionVars.popup,
    transitionTimingFunction: duration.ease,
  },
});

/**
 * Where a panel opens: under its trigger's start, and under the whole row, so a row that wrapped
 * onto a second line is never covered by the panel of a trigger on the first. Read on every check.
 */
const underRow = (trigger: HTMLElement, row: HTMLElement) => ({
  getBoundingClientRect: () => {
    const own = trigger.getBoundingClientRect();
    const all = row.getBoundingClientRect();
    return {
      x: own.x,
      y: own.y,
      width: own.width,
      height: Math.max(own.height, all.bottom - own.top),
    };
  },
});

// What the parts read: the row (so a panel opens under all of it), an item's trigger, whether its
// panel holds the page you are on, and inside a panel whether any link has an icon.
const Row = createContext<HTMLElement | null>(null);
const Trigger = createContext<HTMLElement | null>(null);
const SetTrigger = createContext<
  Dispatch<SetStateAction<HTMLElement | null>> | undefined
>(undefined);
const Here = createContext(false);
const InPanel = createContext(false);
const Icons = createContext(false);

const propsOf = (child: ReactNode) =>
  isValidElement<{ children?: ReactNode; active?: boolean; icon?: IconData }>(
    child
  )
    ? child.props
    : undefined;

/** A link: in a panel, a page's name with a quiet line under it; in the row, a link drawn as a trigger. */
export const NavigationMenuLink = ({
  href,
  children,
  description,
  icon,
  active = false,
  asChild = false,
  style,
}: NavigationMenuLinkProps) => {
  const inPanel = use(InPanel);
  const icons = use(Icons);
  const slot = slotProps(asChild, children);
  if (!inPanel) {
    return (
      <LinkPrimitive
        href={href}
        current={active}
        render={slot.render}
        {...stylex.props(
          styles.trigger,
          active && styles.active,
          focusRing,
          style
        )}
      >
        <span aria-hidden="true" {...stylex.props(styles.target)} />
        {slot.children}
      </LinkPrimitive>
    );
  }
  return (
    <LinkPrimitive
      href={href}
      current={active}
      render={slot.render}
      {...stylex.props(
        styles.link,
        icons && styles.linkIcons,
        focusRingInset,
        style
      )}
    >
      {icon && (
        <NavigationMenuLinkIcon {...stylex.props(styles.linkIcon)}>
          <Icon icon={icon} />
        </NavigationMenuLinkIcon>
      )}
      <span {...stylex.props(styles.linkTitle, active && styles.active)}>
        {slot.children}
      </span>
      {description !== undefined && description !== "" && (
        <span {...stylex.props(styles.linkDescription)}>{description}</span>
      )}
    </LinkPrimitive>
  );
};

/** The links written in a panel's content. */
const linksOf = (children: ReactNode) =>
  listOf(children).filter(
    (child) => isValidElement(child) && child.type === NavigationMenuLink
  );

/** The panel of links an item's trigger opens, under the whole row. More than three stand in two columns. */
export const NavigationMenuContent = ({
  children,
  style,
}: NavigationMenuContentProps) => {
  const row = use(Row);
  const trigger = use(Trigger);
  const links = linksOf(children);
  const wide = links.length > 3;
  const icons = links.some((link) => propsOf(link)?.icon !== undefined);
  const anchor =
    trigger !== null && row !== null ? underRow(trigger, row) : undefined;
  return (
    <ContentPrimitive
      side="bottom"
      align="start"
      sideOffset={popup.gap}
      collisionPadding={popup.gutter}
      anchor={anchor}
      keepMounted
      {...stylex.props(
        listStyles.popup,
        styles.panel,
        wide && styles.panelWide,
        style
      )}
    >
      <InPanel value>
        <Icons value={icons}>{children}</Icons>
      </InPanel>
    </ContentPrimitive>
  );
};

/** Whether an item's panel holds the page you are on, read from the links written in it. */
const holdsActive = (children: ReactNode) =>
  listOf(children).some(
    (child) =>
      isValidElement(child) &&
      child.type === NavigationMenuContent &&
      linksOf(propsOf(child)?.children).some(
        (link) => propsOf(link)?.active === true
      )
  );

/** The row of triggers and links, each group opening its own panel. */
export const NavigationMenu = ({
  "aria-label": ariaLabel,
  children,
  openOnHover = true,
  style,
  ...options
}: NavigationMenuProps) => (
  <NavigationMenuPrimitive
    aria-label={ariaLabel}
    openOnHover={openOnHover}
    {...options}
    {...stylex.props(styles.root, style)}
  >
    {children}
  </NavigationMenuPrimitive>
);

/** The row of the menu's items. */
export const NavigationMenuList = ({
  children,
  style,
}: NavigationMenuListProps) => {
  const [row, setRow] = useState<HTMLElement | null>(null);
  return (
    <ListPrimitive ref={setRow} {...stylex.props(styles.list, style)}>
      <Row value={row}>{children}</Row>
    </ListPrimitive>
  );
};

/** One place in the row: a trigger and the panel it opens, or a link. */
export const NavigationMenuItem = ({
  children,
  value,
  style,
}: NavigationMenuItemProps) => {
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const here = holdsActive(children);
  return (
    <ItemPrimitive value={value} {...stylex.props(styles.item, style)}>
      <Trigger value={trigger}>
        <SetTrigger value={setTrigger}>
          <Here value={here}>{children}</Here>
        </SetTrigger>
      </Trigger>
    </ItemPrimitive>
  );
};

/** The button that opens its item's panel, with a chevron that turns over. */
export const NavigationMenuTrigger = ({
  children,
  asChild = false,
  disabled = false,
  style,
}: NavigationMenuTriggerProps) => {
  const setTrigger = use(SetTrigger);
  const here = use(Here);
  // With asChild, the element is drawn without its words, which stand inside it with the chevron.
  const { render, children: words } = slotWords(asChild, children);
  return (
    <TriggerPrimitive
      ref={setTrigger}
      disabled={disabled}
      render={render}
      className={(state: NavigationMenuTriggerState) =>
        className(
          styles.trigger,
          here && styles.active,
          state.open && styles.open,
          state.disabled && styles.disabled,
          focusRing,
          style
        )
      }
    >
      {(state: NavigationMenuTriggerState) => (
        <>
          <span aria-hidden="true" {...stylex.props(styles.target)} />
          {words}
          <span
            aria-hidden="true"
            {...stylex.props(styles.chevron, state.open && styles.chevronOpen)}
          >
            <Icon icon={ChevronDownIcon} />
          </span>
        </>
      )}
    </TriggerPrimitive>
  );
};

/** A line under the open trigger, or under the link of the page you are on. Screen readers skip it. */
export const NavigationMenuIndicator = ({
  style,
}: NavigationMenuIndicatorProps) => (
  <IndicatorPrimitive {...stylex.props(styles.indicator, style)} />
);

/** One frame every panel opens in, moving to the open trigger, instead of each panel its own popup. */
export const NavigationMenuViewport = ({
  style,
}: NavigationMenuViewportProps) => (
  <ViewportPrimitive
    sideOffset={popup.gap}
    collisionPadding={popup.gutter}
    {...stylex.props(styles.viewport, style)}
  />
);
