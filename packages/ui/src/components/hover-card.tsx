// HoverCard: a preview of where a link goes, for someone who rests on it,
// in StyleX, built on UI SDK's
// HoverCard: the popup's raised surface with the one corner, placed beside the link and kept inside
// the window. The link stays a link: a press or a tap follows it.
//
//   <HoverCard>
//     <HoverCardTrigger href="/people/amara">Amara Okafor</HoverCardTrigger>
//     <HoverCardContent>
//       <HoverCardTitle>Amara Okafor</HoverCardTitle>
//       <HoverCardDescription>Leads research on the payments team.</HoverCardDescription>
//     </HoverCardContent>
//   </HoverCard>
//
// A touch screen has no hover, and a screen reader may never open it: everything in the card is
// also on the page the link goes to.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  HoverCard as HoverCardPrimitive,
  HoverCardContent as ContentPrimitive,
  HoverCardTrigger as TriggerPrimitive,
} from "@ui-sdk/react/hover-card";
import type { HoverCardTriggerState } from "@ui-sdk/react/hover-card";
import { useId, useState, useSyncExternalStore } from "react";
import type { ComponentProps, ReactNode } from "react";

import { focusRingText } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../lib/tokens.stylex";
import { popup, px } from "../lib/tokens.values";
import { className, slotProps } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { motionVars } from "../lib/vars.stylex";

type RootProps = ComponentProps<typeof HoverCardPrimitive>;
type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;

// ---- One open at a time ----------------------------------------------------------------------------
//
// When the pointer moves from one link to the next, the card that opens closes the one before it at
// once, instead of drawing over it while the first waits out its close delay. A store outside
// React, read with useSyncExternalStore, so every card on the page sees the same answer.

let current: string | null = null;
const listeners = new Set<() => void>();

const watchOpen = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const openNow = () => current;
const openOnServer = (): string | null => null;

/** A card opened or closed: an opening card becomes the one open; a closing one lets it go. */
const noteOpen = (id: string, open: boolean) => {
  if (open ? current === id : current !== id) {
    return;
  }
  current = open ? id : null;
  for (const listener of listeners) {
    listener();
  }
};

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the types below, so they cannot drift from what the code accepts.

/** Every prop a HoverCard takes. */
export interface HoverCardProps {
  /** The link and its card. */
  children: ReactNode;
  /** Open now. Pass it with `onOpenChange` to open and close it yourself. */
  open?: boolean;
  /**
   * Open when the page loads.
   * @default false
   */
  defaultOpen?: boolean;
  /** Runs when the card wants to open or close; `details.reason` says why, such as `"trigger-hover"`. */
  onOpenChange?: RootProps["onOpenChange"];
  /**
   * How long the pointer rests on the link, or keyboard focus stays on it, before the card opens,
   * in milliseconds. Long enough that passing over a page of links shows nothing.
   * @default 600
   */
  openDelay?: number;
  /**
   * How long the card stays once the pointer leaves the link and the card, in milliseconds. The
   * pointer can cross the gap into the card.
   * @default 300
   */
  closeDelay?: number;
  /**
   * The card never opens, and the link stays a plain link.
   * @default false
   */
  disabled?: boolean;
}

/**
 * The root: holds the link and the card, and renders nothing of its own. One card is open at a
 * time: a card that keeps its own state closes as soon as another opens. A card whose `open` the
 * host keeps is left as the host says.
 */
export const HoverCard = ({
  children,
  open,
  defaultOpen = false,
  onOpenChange,
  openDelay,
  ...rest
}: HoverCardProps) => {
  const id = useId();
  const [own, setOwn] = useState(defaultOpen);
  // Whether it has opened or closed since the page loaded: before that, only `defaultOpen` says.
  const [moved, setMoved] = useState(false);
  const shownNow = useSyncExternalStore(watchOpen, openNow, openOnServer);
  const shown = own && (shownNow === id || (shownNow === null && !moved));
  return (
    <HoverCardPrimitive
      {...rest}
      delay={openDelay}
      open={open ?? shown}
      onOpenChange={(next, details) => {
        setOwn(next);
        setMoved(true);
        noteOpen(id, next);
        onOpenChange?.(next, details);
      }}
    >
      {children}
    </HoverCardPrimitive>
  );
};

// ---- The look ------------------------------------------------------------------------------------

const HOVER = media.hover;
const FORCED = media.forcedColors;
const REDUCED = media.reducedMotion;
const PHONE = media.maxSm;
const moving = ":is([data-starting-style], [data-ending-style])";

const styles = stylex.create({
  // The link: the words of the page around it, underlined, a little stronger under a pointer. On a
  // touch screen an unseen area makes it 44px each way, so a link on its own can be hit.
  trigger: {
    position: "relative",
    "::after": {
      content: '""',
      position: "absolute",
      insetInline: {
        default: 0,
        [media.pointerCoarse]: `min(0px, calc((100% - ${size.tapTarget}) / 2))`,
      },
      insetBlock: {
        default: 0,
        [media.pointerCoarse]: `min(0px, calc((100% - ${size.tapTarget}) / 2))`,
      },
    },
    color: "inherit",
    fontWeight: font.weightMedium,
    textDecorationLine: "underline",
    textDecorationThickness: size.linkUnderlineWidth,
    textUnderlineOffset: size.linkUnderlineOffset,
    textDecorationColor: {
      default: colors.linkUnderline,
      ":hover": { default: null, [HOVER]: "currentColor" },
    },
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    transitionProperty: "text-decoration-color",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
  },
  open: {
    textDecorationColor: "currentColor",
  },
  // The card: beside its link, as wide as popover-width or the window less the gutter. A preview
  // is short, so it never scrolls.
  panel: {
    boxSizing: "border-box",
    display: "grid",
    alignContent: "start",
    rowGap: space["1"],
    width: {
      default: `min(${size.popoverWidth}, 100vw - 2 * ${space.popupGutter})`,
      [PHONE]: `calc(100vw - 2 * ${space.popupGutter})`,
    },
    margin: 0,
    padding: space.popoverPadding,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.popover,
    boxShadow: shadow.popupShadow,
    color: colors.bodyForeground,
    fontFamily: font.sans,
    // Opened inside its trigger's parent (it is not portalled), it would take that parent's text:
    // it sets its own, and keeps only the direction, which follows the page.
    textAlign: "start",
    whiteSpace: "normal",
    fontStyle: "normal",
    textTransform: "none",
    letterSpacing: "normal",
    wordSpacing: "normal",
    textIndent: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightNormal,
    overflowWrap: "anywhere",
    hyphens: "manual",
    transformOrigin: "var(--transform-origin)",
    opacity: { default: 1, [moving]: 0 },
    transform: {
      default: "none",
      [moving]: { default: `scale(${size.popupFromScale})`, [REDUCED]: "none" },
    },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: motionVars.popup,
      ":is([data-ending-style])": motionVars.leave,
    },
    transitionTimingFunction: duration.ease,
  },
  // Sized to what it holds, between the least and the most width, and inside the window.
  fit: {
    width: "max-content",
    minWidth: `min(${size.hoverCardMinWidth}, 100vw - 2 * ${space.popupGutter})`,
    maxWidth: `min(${size.hoverCardMaxWidth}, 100vw - 2 * ${space.popupGutter})`,
  },
  // What the link leads to: the interface's own type, a step up from its text.
  title: {
    margin: 0,
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
    textWrap: "balance",
  },
  description: {
    margin: 0,
    color: colors.bodyForeground,
    textWrap: "pretty",
  },
  // A quiet fact, after the line about it.
  muted: {
    margin: 0,
    marginBlockStart: space["1"],
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
});

/**
 * Every prop a HoverCardTrigger takes. It needs `href` or, with `asChild`, an element of its own:
 * an `<a>` with no address could not take focus, and so would never open the card from the keyboard.
 */
export type HoverCardTriggerProps = {
  /** Where the link goes: the page that holds everything the card shows, and more. */
  href?: string;
  /**
   * Draw the one element given as the child (a router's link, or with `variant="default"` a Button
   * or a badge) as the trigger, with the card's behaviour. Leave `href` out when the router's link
   * carries the address.
   * @default false
   */
  asChild?: boolean;
  /** The link's words: the name of what it leads to ("Amara Okafor"), or the element, with `asChild`. */
  children: ReactNode;
  /**
   * `link`: words in the sentence, underlined, a little stronger under a pointer. `default`: no
   * look of its own (no underline, colour, weight or focus ring added), for an element that is
   * already a control with its own.
   * @default "link"
   */
  variant?: "link" | "default";
  /** Layout only. */
  style?: LayoutStyle;
} & ({ href: string } | { asChild: true });

/** The link. Its words take the text around them, underlined; or, `default`, the element it draws in its own look. */
export const HoverCardTrigger = ({
  href,
  asChild,
  children,
  variant = "link",
  style,
}: HoverCardTriggerProps) => (
  <TriggerPrimitive
    href={href}
    className={(state: HoverCardTriggerState) =>
      className(
        variant === "link" && [
          styles.trigger,
          state.open && styles.open,
          focusRingText,
        ],
        style
      )
    }
    {...slotProps(asChild, children)}
  />
);

/** Every prop a HoverCardContent takes. */
export interface HoverCardContentProps {
  /** The title, a line about it, and a quiet fact. Nothing to press: the link's page has the actions. */
  children: ReactNode;
  /**
   * The side of the link it opens on. It flips to the other side when there is no room.
   * @default "bottom"
   */
  side?: ContentPrimitiveProps["side"];
  /**
   * How it lines up with the link: `start` and `end` follow the reading direction.
   * @default "center"
   */
  align?: ContentPrimitiveProps["align"];
  /**
   * `fixed`: the popover's width, whatever it holds. `content`: as wide as what it holds, from
   * hover-card-min-width to hover-card-max-width, and never wider than the window less the gutter.
   * @default "fixed"
   */
  width?: "fixed" | "content";
  /** Layout only. */
  style?: LayoutStyle;
}

// Under the phone breakpoint the card takes the window's width less the gutter, so beside its link
// it never fits: there it opens under or over the link, whichever has the room. On the server there
// is no window, and the card is placed as asked.
const PHONE_QUERY = `(width < ${px.sm}px)`;
const watchPhone = (change: () => void) => {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", change);
  return () => {
    query.removeEventListener("change", change);
  };
};
const onPhone = () => window.matchMedia(PHONE_QUERY).matches;
const notOnPhone = () => false;
const across = new Set<HoverCardContentProps["side"]>([
  "left",
  "right",
  "start",
  "end",
]);

/** The card, beside its link; under 640px under or over it, the window's width less the gutter. */
export const HoverCardContent = ({
  children,
  side,
  align,
  width = "fixed",
  style,
}: HoverCardContentProps) => {
  const phone = useSyncExternalStore(watchPhone, onPhone, notOnPhone);
  return (
    <ContentPrimitive
      side={phone && across.has(side) ? "bottom" : side}
      align={align}
      sideOffset={popup.popoverGap}
      collisionPadding={popup.gutter}
      data-slot="hover-card-content"
      {...stylex.props(styles.panel, width === "content" && styles.fit, style)}
    >
      {children}
    </ContentPrimitive>
  );
};

/** Every prop a HoverCardTitle takes. */
export interface HoverCardTitleProps {
  /** The name of what the link leads to, in sentence case. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** The title: a step up from the card's text. */
export const HoverCardTitle = ({ children, style }: HoverCardTitleProps) => (
  <p data-slot="hover-card-title" {...stylex.props(styles.title, style)}>
    {children}
  </p>
);

/** Every prop a HoverCardDescription takes. */
export interface HoverCardDescriptionProps {
  /** A line or two about it, in plain words. */
  children: ReactNode;
  /**
   * `muted`: a quiet fact instead, smaller and muted, such as when it last changed.
   * @default "default"
   */
  variant?: "default" | "muted";
  /** Layout only. */
  style?: LayoutStyle;
}

/** A line about what the link leads to, or, `muted`, a quiet fact. */
export const HoverCardDescription = ({
  children,
  variant = "default",
  style,
}: HoverCardDescriptionProps) => (
  <p
    data-slot="hover-card-description"
    {...stylex.props(
      variant === "muted" ? styles.muted : styles.description,
      style
    )}
  >
    {children}
  </p>
);
