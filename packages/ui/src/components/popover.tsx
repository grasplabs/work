// Popover: a small task beside the control that opened it,
// in StyleX, built on UI SDK's Popover: a raised panel with
// the one corner, placed beside its trigger and kept inside the window, named by its title. It
// never takes the page: the page still scrolls and can be pressed, and focus is not trapped.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Popover>
//     <PopoverTrigger asChild><Button variant="outline">Share</Button></PopoverTrigger>
//     <PopoverContent>
//       <PopoverHeader>
//         <PopoverTitle>Share this report</PopoverTitle>
//         <PopoverDescription>People you add can read it and comment.</PopoverDescription>
//       </PopoverHeader>
//       <Field>…</Field>
//       <PopoverFooter>
//         <PopoverClose asChild><Button variant="outline">Cancel</Button></PopoverClose>
//         <Button {...send.props}>Send invite</Button>
//       </PopoverFooter>
//     </PopoverContent>
//   </Popover>
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Popover as PopoverPrimitive,
  PopoverClose as ClosePrimitive,
  PopoverContent as ContentPrimitive,
  PopoverDescription as DescriptionPrimitive,
  PopoverTitle as TitlePrimitive,
  PopoverTrigger as TriggerPrimitive,
} from "@ui-sdk/react/popover";
import type {
  PopoverController,
  PopoverDismissReason,
} from "@ui-sdk/react/popover";
import { renderElement } from "@ui-sdk/react/primitive";
import { createContext, use, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { watchBody } from "../lib/layer";
import { scrollbarHidden } from "../lib/styles";
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
import { popup } from "../lib/tokens.values";
import { className, slotProps } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { motionVars, toastRegionMarker } from "../lib/vars.stylex";
import { popoverMarker } from "./popover.stylex";

type RootProps = ComponentProps<typeof PopoverPrimitive>;
type OpenChangeDetails = Parameters<NonNullable<RootProps["onOpenChange"]>>[1];
type TriggerPrimitiveProps = ComponentProps<typeof TriggerPrimitive>;
type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;
type ClosePrimitiveProps = ComponentProps<typeof ClosePrimitive>;

// A handle opens and closes a popover from anywhere, and connects a trigger outside it: Base UI's
// name for UI SDK's controller.
export { createPopoverController as createPopoverHandle } from "@ui-sdk/react/popover";
export type { PopoverController as PopoverHandle } from "@ui-sdk/react/popover";

/** The element PopoverAnchor marks, which the content stands against instead of the trigger. */
interface AnchorValue {
  anchor: HTMLElement | null;
  setAnchor: (element: HTMLElement | null) => void;
}
const AnchorContext = createContext<AnchorValue | null>(null);

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the types below, so they cannot drift from what the code accepts.

/** Every prop a Popover takes: these, and the rest of UI SDK's Popover. */
export interface PopoverProps extends Omit<
  RootProps,
  | "children"
  | "modal"
  | "presentation"
  | "openOnHover"
  | "delay"
  | "closeDelay"
  | "controller"
> {
  /** The trigger and the content. */
  children: ReactNode;
  /** Open now. Pass it with `onOpenChange` to open and close the popover yourself. */
  open?: boolean;
  /**
   * Open when the page loads.
   * @default false
   */
  defaultOpen?: boolean;
  /**
   * Runs when the popover wants to open or close; `details.reason` says why, such as
   * `"escape-key"`, `"outside-press"` or `"focus-out"`.
   */
  onOpenChange?: (open: boolean, details: OpenChangeDetails) => void;
  /**
   * Whether Escape, a press outside and Tab out of it close it. Pass `false` while it holds
   * unsaved work, and ask in `onDismissAttempt`. The trigger and PopoverClose still close it.
   * @default true
   */
  dismissible?: boolean;
  /** Runs when Escape or a press outside was refused, because it is not dismissible. */
  onDismissAttempt?: (details: { reason: PopoverDismissReason }) => void;
  /** Opens and closes it from anywhere, and connects a trigger outside it. Make one with `createPopoverHandle()`. */
  handle?: PopoverController;
}

// The Toaster's region, by the marker it carries.
const TOASTER = `.${className(toastRegionMarker) ?? ""}`;

/**
 * Whether the popover is asked to close because focus went into the Toaster: a toast's action
 * (Undo) pressed while it is open. The action runs and the popover stays.
 */
const focusedIntoToaster = (details: OpenChangeDetails) =>
  details.reason === "focus-out" &&
  details.event?.target instanceof Element &&
  details.event.target.closest(TOASTER) !== null;

/** The root: holds the trigger and the content, and renders nothing of its own. */
export const Popover = ({
  children,
  handle,
  onOpenChange,
  ...rest
}: PopoverProps) => {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const change = (open: boolean, details: OpenChangeDetails) => {
    if (!open && focusedIntoToaster(details)) {
      details.cancel();
      return;
    }
    onOpenChange?.(open, details);
  };
  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <AnchorContext.Provider value={{ anchor, setAnchor }}>
      <PopoverPrimitive {...rest} controller={handle} onOpenChange={change}>
        {children}
      </PopoverPrimitive>
    </AnchorContext.Provider>
  );
};

/** What a plain wrapper part takes: `asChild`, its children and a layout. */
interface WrapperProps {
  /**
   * Draw the one element given as the child (a Button) as this part, with the part's behaviour;
   * it keeps its own look and name.
   * @default false
   */
  asChild?: boolean;
  /** The element, with `asChild`; else the words of a plain button. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PopoverTrigger takes: these, and the rest of UI SDK's PopoverTrigger. */
export interface PopoverTriggerProps
  extends
    Omit<
      TriggerPrimitiveProps,
      "render" | "children" | "className" | "style" | "controller"
    >,
    WrapperProps {
  /** Connects a trigger outside its Popover, by the Popover's handle. */
  handle?: PopoverController;
}

/** The control that opens the popover. It says whether it is open (`aria-expanded`) and which one it opens. */
export const PopoverTrigger = ({
  asChild,
  children,
  handle,
  style,
  ...rest
}: PopoverTriggerProps) => (
  <TriggerPrimitive
    {...rest}
    controller={handle}
    className={className(style)}
    {...slotProps(asChild, children)}
  />
);

/** Every prop a PopoverAnchor takes. */
export interface PopoverAnchorProps {
  /**
   * Mark the one element given as the child as the anchor, instead of wrapping it in a `<div>`.
   * @default false
   */
  asChild?: boolean;
  /** What the content stands against: a field, a row, the trigger's surroundings. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** The element the content stands against, when it is not the trigger (a field the trigger sits in). */
export const PopoverAnchor = ({
  asChild,
  children,
  style,
}: PopoverAnchorProps) => {
  const value = use(AnchorContext);
  const slot = slotProps(asChild, children);
  return renderElement(
    "div",
    {
      ref: value?.setAnchor,
      "data-slot": "popover-anchor",
      className: className(style),
      children: slot.children,
    },
    slot.render
  );
};

// ---- The look ------------------------------------------------------------------------------------

const PHONE = media.maxSm;
const FORCED = media.forcedColors;
// The gap between the panel's rows: the header, the fields, the footer. The description stands
// closer under its title.
const ROW = space["4"];
const RING_LINE = `${size.ringWidth} solid ${colors.ring}`;
const RING_FORCED = `calc(2 * ${size.lineStrong}) solid Highlight`;
// Where it stands while it opens and as it closes: a little smaller and clear, growing from
// `--transform-origin`, the point on the trigger UI SDK placed it against.
const moving = ":is([data-starting-style], [data-ending-style])";

// The body's ends fade while there is more past them, running on through the padding as a faint
// tail, so a line cut on the panel's edge reads as more to come and is never a crisp slice.
const FADE = space["6"];
const INSET = space.popoverPadding;
const TAIL = "rgb(0 0 0 / 30%)";
const fadeBelow = `linear-gradient(to bottom, black calc(100% - ${INSET} - ${FADE}), ${TAIL} calc(100% - ${INSET}), transparent)`;
const fadeBoth = `linear-gradient(to bottom, transparent, ${TAIL} ${INSET}, black calc(${INSET} + ${FADE}), black calc(100% - ${INSET} - ${FADE}), ${TAIL} calc(100% - ${INSET}), transparent)`;
const fadeAbove = `linear-gradient(to bottom, transparent, ${TAIL} ${INSET}, black calc(${INSET} + ${FADE}))`;
const ends = stylex.keyframes({
  "0%": { maskImage: fadeBelow },
  "1%, 99%": { maskImage: fadeBoth },
  "100%": { maskImage: fadeAbove },
});
const SCROLLS = "@supports (animation-timeline: scroll())";

const styles = stylex.create({
  // The panel: raised, lifted, the one corner, beside its trigger and never wider than the window
  // less the gutter; under 640px that whole width. No taller than popup-height, and less when the
  // window has less room beside the trigger.
  panel: {
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    color: colors.bodyForeground,
    backgroundColor: colors.popover,
    boxShadow: shadow.popupShadow,
    borderRadius: radius.base,
    cornerShape: radius.shape,
    fontFamily: font.sans,
    // Opened inside its trigger's parent (it is not portalled), it would take that parent's text:
    // it sets its own, and keeps only the direction, which follows the page.
    textAlign: "start",
    whiteSpace: "normal",
    fontWeight: "normal",
    fontStyle: "normal",
    textTransform: "none",
    letterSpacing: "normal",
    wordSpacing: "normal",
    textIndent: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    overflowWrap: "anywhere",
    hyphens: "manual",
    width: {
      default: `min(${size.popoverWidth}, 100vw - 2 * ${space.popupGutter})`,
      [PHONE]: `calc(100vw - 2 * ${space.popupGutter})`,
    },
    maxWidth: "none",
    height: "fit-content",
    maxHeight: `min(${size.popupHeight}, var(--available-height, ${size.popupHeight}))`,
    overflow: "hidden",
    transformOrigin: "var(--transform-origin)",
    // Its ring stands whole round the rounded edge: when it holds focus itself, and when its body
    // does (a body that scrolls takes focus).
    outline: {
      default: "none",
      ":focus-visible": { default: RING_LINE, [FORCED]: RING_FORCED },
      ':has(> [data-slot="popover-body"]:focus-visible)': {
        default: RING_LINE,
        [FORCED]: RING_FORCED,
      },
    },
    outlineOffset: { default: size.ringOffset, [FORCED]: size.ringOffsetMark },
    // In and out from the trigger's side; leaving is faster. With reduced motion, at once.
    opacity: { default: 1, [moving]: 0 },
    transform: { default: "none", [moving]: `scale(${size.popupFromScale})` },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: motionVars.popup,
      ":is([data-ending-style])": motionVars.leave,
    },
    transitionTimingFunction: duration.ease,
  },
  // The rows, one column. The one part that scrolls; when it holds more than it shows it takes
  // focus, so the keys can scroll it. The panel draws its ring.
  body: {
    boxSizing: "border-box",
    display: "grid",
    alignContent: "start",
    rowGap: ROW,
    minHeight: 0,
    padding: space.popoverPadding,
    scrollPaddingBlock: space.popoverPadding,
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "contain",
    borderRadius: "inherit",
    cornerShape: "inherit",
    outline: "none",
    // Only where the browser drives an animation by scroll, and never while the panel leaves: a
    // scroll-driven animation does not end, and the close may wait for its animations to end.
    animationName: {
      default: null,
      [SCROLLS]: {
        default: ends,
        [stylex.when.ancestor(
          ":is([data-ending-style], [data-closed])",
          popoverMarker
        )]: "none",
      },
    },
    animationDuration: { default: null, [SCROLLS]: "auto" },
    animationTimingFunction: { default: null, [SCROLLS]: "linear" },
    animationFillMode: { default: null, [SCROLLS]: "both" },
    animationTimeline: { default: null, [SCROLLS]: "scroll(self)" },
  },
  // The title and its description, as one row.
  header: {
    display: "grid",
    rowGap: ROW,
  },
  // The title names the popover: the interface's own type, a step up from its text.
  title: {
    letterSpacing: font.trackingUi,
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
    textWrap: "balance",
  },
  // Close under its title, not a whole row away.
  description: {
    margin: 0,
    marginBlockStart: `calc(${space["2"]} - ${ROW})`,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
    textWrap: "pretty",
  },
  // The actions, at the end of the line, the main one last.
  footer: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: space["2"],
  },
});

/** Every prop a PopoverContent takes: these, and the rest of UI SDK's PopoverContent. */
export interface PopoverContentProps extends Omit<
  ContentPrimitiveProps,
  | "children"
  | "className"
  | "style"
  | "render"
  | "sideOffset"
  | "collisionPadding"
  | "arrowPadding"
> {
  /** The header, the fields and the footer, in that order. */
  children: ReactNode;
  /**
   * The side of the trigger it opens on. It flips to the other side when there is no room.
   * @default "bottom"
   */
  side?: ContentPrimitiveProps["side"];
  /**
   * How it lines up with the trigger: `start` and `end` follow the reading direction. `end` for a
   * trigger at the end of a row or a toolbar.
   * @default "center"
   */
  align?: ContentPrimitiveProps["align"];
  /**
   * Where focus goes when it opens. By default the first field or control in it; when it holds
   * none (words only), focus stays on the trigger, so no ring frames the panel and Escape still
   * closes it. `"content"` focuses the panel itself; `"none"` always leaves focus on the trigger.
   */
  initialFocus?: ContentPrimitiveProps["initialFocus"];
  /** Layout only. */
  style?: LayoutStyle;
}

// What can take focus by Tab inside the panel: its first one, if any.
const TABBABLE =
  "button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1']), [contenteditable='true']";
const firstTabbable = (body: HTMLElement): HTMLElement | null => {
  // The body itself, when it scrolls, is a stop of its own (a region the keys can scroll).
  if (body.tabIndex >= 0) {
    return body;
  }
  return (
    [...body.querySelectorAll<HTMLElement>(TABBABLE)].find(
      (element) => element.getClientRects().length > 0
    ) ?? null
  );
};

/** The panel, beside its trigger. Under 640px it takes the window's width less the gutter. */
export const PopoverContent = ({
  children,
  initialFocus,
  style,
  ...rest
}: PopoverContentProps) => {
  const anchor = use(AnchorContext)?.anchor ?? undefined;
  // When the body holds more than it shows, it joins the Tab order as a region named by the title,
  // so the keys can scroll it (WCAG 2.1.1), as a Dialog's body does.
  const [scrolls, setScrolls] = useState(false);
  const [title, setTitle] = useState<string>();
  const body = useRef<HTMLDivElement | null>(null);
  const box = (element: HTMLDivElement | null) => {
    body.current = element;
    return element === null
      ? undefined
      : watchBody(element, "dialog", setTitle, setScrolls);
  };
  // The first control in it, else the trigger, which holds focus as it opens. Where a tap left
  // focus on nothing (the page), the panel takes it, as UI SDK's own default does.
  const firstOrTrigger = () => {
    const first = body.current === null ? null : firstTabbable(body.current);
    if (first !== null) {
      return first;
    }
    const held = document.activeElement;
    return held instanceof HTMLElement && held !== document.body ? held : null;
  };
  return (
    <ContentPrimitive
      anchor={anchor}
      {...rest}
      data-slot="popover-content"
      initialFocus={initialFocus ?? firstOrTrigger}
      sideOffset={popup.popoverGap}
      collisionPadding={popup.gutter}
      {...stylex.props(popoverMarker, styles.panel, style)}
    >
      <div
        ref={box}
        data-slot="popover-body"
        tabIndex={scrolls ? 0 : undefined}
        role={scrolls ? "region" : undefined}
        aria-labelledby={scrolls ? title : undefined}
        {...stylex.props(styles.body, scrollbarHidden)}
      >
        {children}
      </div>
    </ContentPrimitive>
  );
};

/** What a popover's text parts take. */
interface TextProps {
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PopoverHeader takes. */
export interface PopoverHeaderProps extends TextProps {
  /** The title, and the description under it. */
  children: ReactNode;
}

/** The title and the description under it, as one row of the panel. */
export const PopoverHeader = ({ children, style }: PopoverHeaderProps) => (
  <div data-slot="popover-header" {...stylex.props(styles.header, style)}>
    {children}
  </div>
);

/** Every prop a PopoverTitle takes. */
export interface PopoverTitleProps extends TextProps {
  /** What the popover is for, in sentence case: it names the popover for a screen reader and an agent. */
  children: ReactNode;
}

/** The title. It names the popover. */
export const PopoverTitle = ({ children, style }: PopoverTitleProps) => (
  <TitlePrimitive
    data-slot="popover-title"
    {...stylex.props(styles.title, style)}
  >
    {children}
  </TitlePrimitive>
);

/** Every prop a PopoverDescription takes. */
export interface PopoverDescriptionProps extends TextProps {
  /** One sentence on what happens, read with the title when focus moves in. */
  children: ReactNode;
}

/** The sentence under the title. It describes the popover to a screen reader. */
export const PopoverDescription = ({
  children,
  style,
}: PopoverDescriptionProps) => (
  <DescriptionPrimitive
    data-slot="popover-description"
    {...stylex.props(styles.description, style)}
  >
    {children}
  </DescriptionPrimitive>
);

/** Every prop a PopoverFooter takes. */
export interface PopoverFooterProps extends TextProps {
  /** The actions, the main one last: Cancel, then Send invite. */
  children: ReactNode;
}

/** The actions, at the end of the line. They wrap onto a second line when the panel is narrow. */
export const PopoverFooter = ({ children, style }: PopoverFooterProps) => (
  <div data-slot="popover-footer" {...stylex.props(styles.footer, style)}>
    {children}
  </div>
);

/** Every prop a PopoverClose takes: these, and the rest of UI SDK's PopoverClose. */
export interface PopoverCloseProps
  extends
    Omit<ClosePrimitiveProps, "render" | "children" | "className" | "style">,
    WrapperProps {}

/** Closes the popover, and focus goes back to its trigger. `<PopoverClose asChild><Button variant="outline">Cancel</Button></PopoverClose>`. */
export const PopoverClose = ({
  asChild,
  children,
  style,
  ...rest
}: PopoverCloseProps) => (
  <ClosePrimitive
    {...rest}
    data-slot="popover-close"
    className={className(style)}
    {...slotProps(asChild, children)}
  />
);
