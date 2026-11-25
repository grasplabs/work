// Tooltip: a short hint for a control,
// in StyleX, built on UI SDK's Tooltip: a dark capsule with the one corner, a
// little off its trigger, with no arrow. It opens when the pointer rests on the trigger for
// tooltip-delay, and at once when keyboard focus reaches it. It closes on Escape, when the pointer
// leaves and when focus moves on. It describes its trigger, and holds nothing to press.
//
//   <Tooltip shortcut="mod+d">
//     <TooltipTrigger asChild>
//       <Button variant="ghost" size="icon" aria-label="Download"><Icon icon={DownloadIcon} /></Button>
//     </TooltipTrigger>
//     <TooltipContent>Download as PDF <Kbd>⌘D</Kbd></TooltipContent>
//   </Tooltip>
//
// ControlTooltip is what a Button, Toggle and ToggleGroupItem draw themselves in for their
// `tooltip` prop: an icon-only one shows its name by default, so no caller wraps it by hand.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Tooltip as TooltipPrimitive,
  TooltipContent as ContentPrimitive,
  TooltipTrigger as TriggerPrimitive,
} from "@ui-sdk/react/tooltip";
import type {
  TooltipController,
  TooltipOpenChangeReason,
} from "@ui-sdk/react/tooltip";
import { createContext, use, useEffect, useRef, useState } from "react";
import type { ComponentProps, ReactElement, ReactNode, Ref } from "react";

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
import { durations, popup } from "../lib/tokens.values";
import { assignRef, className, slotProps } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { motionVars } from "../lib/vars.stylex";

type RootProps = ComponentProps<typeof TooltipPrimitive>;
type TriggerPrimitiveProps = ComponentProps<typeof TriggerPrimitive>;
type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;

// A handle opens and closes a tooltip from anywhere, and connects a trigger outside it: Base UI's
// name for UI SDK's controller.
export { createTooltipController as createTooltipHandle } from "@ui-sdk/react/tooltip";
export type { TooltipController as TooltipHandle } from "@ui-sdk/react/tooltip";

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the types below, so they cannot drift from what the code accepts.

/** Every prop a TooltipProvider takes. */
export interface TooltipProviderProps {
  /** The tooltips that share the delay. */
  children: ReactNode;
  /**
   * How long the pointer rests on a trigger before its tooltip opens, in milliseconds, for every
   * Tooltip inside that does not set its own.
   * @default tooltip-delay
   */
  delay?: number;
}

const DelayContext = createContext<number>(durations.tooltipDelay);

/** Sets one delay for the tooltips inside it. Renders nothing of its own. */
export const TooltipProvider = ({
  children,
  delay = durations.tooltipDelay,
}: TooltipProviderProps) => (
  <DelayContext.Provider value={delay}>{children}</DelayContext.Provider>
);

/** Every prop a Tooltip takes: these, and the rest of UI SDK's Tooltip. */
export interface TooltipProps extends Omit<
  RootProps,
  "children" | "type" | "toggleable" | "onOpenChange" | "controller"
> {
  /** The trigger and the content. */
  children: ReactNode;
  /**
   * A press on the trigger opens and closes it too, so a tap on a touch screen shows it: for an
   * info mark (a small button that is only there to say more), never for a control that does
   * something of its own. What it says is announced as a press opens it.
   * @default false
   */
  toggleable?: boolean;
  /** Open now. Pass it with `onOpenChange` to open and close the tooltip yourself. */
  open?: boolean;
  /**
   * Runs when the tooltip wants to open or close; `reason` says why, such as `"trigger-hover"`,
   * `"trigger-focus"` or `"escape-key"`.
   */
  onOpenChange?: (
    open: boolean,
    details: { reason: TooltipOpenChangeReason; cancel: () => void }
  ) => void;
  /**
   * How long the pointer rests on the trigger before it opens, in milliseconds.
   * @default the TooltipProvider's, else tooltip-delay
   */
  delay?: number;
  /**
   * The keys of what the trigger does, such as `"mod+d"`. It names them on the trigger
   * (`aria-keyshortcuts`) but does not bind them; show them with a `<Kbd>` in the content.
   */
  shortcut?: string;
  /**
   * Stops it from opening. The trigger keeps working.
   * @default false
   */
  disabled?: boolean;
  /** Opens and closes it from anywhere. Make one with `createTooltipHandle()`. */
  handle?: TooltipController;
}

/** The trigger's element, so the root can tell whether what it opens is open. */
const TriggerContext = createContext<
  ((element: HTMLElement | null) => void) | undefined
>(undefined);

/**
 * Whether the trigger opens a layer (a popover's, a menu's trigger) that is open now: the tooltip
 * would stand over it, so it does not open.
 */
const layerOpen = (element: HTMLElement | null) => {
  const opens = element?.getAttribute("aria-haspopup");
  return (
    element?.getAttribute("aria-expanded") === "true" &&
    opens !== null &&
    opens !== undefined &&
    opens !== "false"
  );
};

/** Whether this stands inside a Tooltip: a control there shows that Tooltip, never one of its own. */
const InTooltip = createContext(false);

/** The root: holds the trigger and the content, and renders nothing of its own. */
export const Tooltip = ({
  children,
  delay,
  handle,
  onOpenChange,
  ...rest
}: TooltipProps) => {
  const shared = use(DelayContext);
  const trigger = useRef<HTMLElement | null>(null);
  const keep = (element: HTMLElement | null) => {
    trigger.current = element;
  };
  const change: RootProps["onOpenChange"] = (open, details) => {
    if (open && layerOpen(trigger.current)) {
      details.cancel();
      return;
    }
    onOpenChange?.(open, details);
  };
  // It always describes its trigger: an icon-only button keeps its own `aria-label` as its name.
  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <TriggerContext.Provider value={keep}>
      <TooltipPrimitive
        {...rest}
        controller={handle}
        delay={delay ?? shared}
        type="description"
        onOpenChange={change}
      >
        <InTooltip value>{children}</InTooltip>
      </TooltipPrimitive>
    </TriggerContext.Provider>
  );
};

/** Every prop a TooltipTrigger takes: these, and the rest of UI SDK's TooltipTrigger. */
export interface TooltipTriggerProps extends Omit<
  TriggerPrimitiveProps,
  "render" | "children" | "className" | "style" | "controller"
> {
  /**
   * Draw the one element given as the child (a Button, a link) as the trigger, with the trigger's
   * behaviour; it keeps its own look and name, and the tooltip describes it.
   * @default false
   */
  asChild?: boolean;
  /** The element, with `asChild`; else the words of a plain button. */
  children: ReactNode;
  /** Connects a trigger outside its Tooltip, by the Tooltip's handle. */
  handle?: TooltipController;
  /** Layout only. */
  style?: LayoutStyle;
}

/** The control the tooltip describes. It carries the tooltip's words as its description (`aria-describedby`). */
export const TooltipTrigger = ({
  asChild,
  children,
  handle,
  style,
  ref,
  ...rest
}: TooltipTriggerProps) => {
  const keep = use(TriggerContext);
  // The root's look at the element, and the caller's own ref. UI SDK gives its trigger
  // `type="button"`; a child that draws no button (a router's link) keeps no such type, which on a
  // link names the kind of file it points to.
  const both = (element: HTMLElement | null) => {
    if (
      asChild === true &&
      element !== null &&
      !(element instanceof HTMLButtonElement) &&
      element.getAttribute("type") === "button"
    ) {
      element.removeAttribute("type");
    }
    keep?.(element);
    assignRef(ref, element);
  };
  return (
    <TriggerPrimitive
      // Says a Tooltip has this control: an icon-only Button then adds no tooltip of its own.
      data-tooltip-trigger=""
      {...rest}
      ref={both}
      controller={handle}
      className={className(style)}
      {...slotProps(asChild, children)}
    />
  );
};

// ---- The look ------------------------------------------------------------------------------------

const REDUCED = media.reducedMotion;
// Where a tooltip stands while it opens and as it closes: clear, a little smaller, and nearer its
// trigger by tooltip-rise, so it rises away from whichever side it landed on. It grows from
// `--transform-origin`, the point on the trigger UI SDK placed it against.
const moving = ":is([data-starting-style], [data-ending-style])";
const RISE = size.tooltipRise;

const styles = stylex.create({
  // A dark capsule: the one corner, so one line reads as a pill and more lines as a rounded panel.
  panel: {
    boxSizing: "border-box",
    margin: 0,
    padding: size.tooltipPadding,
    // Forced colours drop the fill and the lift, so a 1px border in the text colour draws its edge.
    borderWidth: { default: 0, [media.forcedColors]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    color: colors.tooltipForeground,
    backgroundColor: colors.tooltip,
    // Translucent, with the page softened behind it; a faint lift separates it from a dark page.
    backdropFilter: size.tooltipBlur,
    boxShadow: shadow.sm,
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    textWrap: "pretty",
    overflowWrap: "anywhere",
    hyphens: "manual",
    // As wide as its words up to tooltip-width, never wider than the window less the gutter.
    width: "max-content",
    maxWidth: `min(${size.tooltipWidth}, 100vw - 2 * ${space.popupGutter})`,
    transformOrigin: "var(--transform-origin)",
  },
  // A fade with a slight rise from the trigger's side; leaving is faster than arriving. Under
  // reduced motion only the fade is left. Opened at once (another tooltip was just open), it is
  // there and gone at once.
  motion: {
    opacity: { default: 1, [moving]: 0 },
    transform: {
      default: "none",
      [moving]: { default: `scale(${size.popupFromScale})`, [REDUCED]: "none" },
    },
    translate: {
      default: "none",
      [`${moving}:is([data-side="top"])`]: {
        default: `0 ${RISE}`,
        [REDUCED]: "none",
      },
      [`${moving}:is([data-side="bottom"])`]: {
        default: `0 calc(-1 * ${RISE})`,
        [REDUCED]: "none",
      },
      [`${moving}:is([data-side="left"])`]: {
        default: `${RISE} 0`,
        [REDUCED]: "none",
      },
      [`${moving}:is([data-side="right"])`]: {
        default: `calc(-1 * ${RISE}) 0`,
        [REDUCED]: "none",
      },
    },
    transitionProperty: {
      default: "opacity, transform, translate",
      [REDUCED]: "opacity",
    },
    transitionDuration: {
      default: motionVars.hover,
      ":is([data-ending-style])": motionVars.tooltipLeave,
      ":is([data-instant][data-ending-style], [data-instant])": "0s",
    },
    transitionTimingFunction: duration.ease,
  },
  // The words. With a shortcut (a Kbd) they are a wrapping row: the words keep their line whole and
  // the keys stand at its end, quiet (Kbd draws itself so here), or at the end of a line of their
  // own under the words when both do not fit.
  words: {
    display: { default: "block", ":has([data-slot=kbd])": "flex" },
    flexWrap: "wrap",
    alignItems: "last baseline",
    columnGap: space["2"],
  },
});

/** Every prop a TooltipContent takes: these, and the rest of UI SDK's TooltipContent. */
export interface TooltipContentProps extends Omit<
  ContentPrimitiveProps,
  | "children"
  | "className"
  | "style"
  | "render"
  | "sideOffset"
  | "collisionPadding"
  | "arrowPadding"
> {
  /** A few words that add to the trigger, and a `<Kbd>` if it has keys. Nothing to press. */
  children: ReactNode;
  /**
   * The side of the trigger it opens on. It flips when there is no room.
   * @default "top"
   */
  side?: ContentPrimitiveProps["side"];
  /**
   * How it lines up with a trigger narrower than itself.
   * @default "center"
   */
  align?: ContentPrimitiveProps["align"];
  /** Layout only. */
  style?: LayoutStyle;
}

/** The tooltip: a dark capsule beside its trigger, never wider than tooltip-width. */
export const TooltipContent = ({
  children,
  style,
  ...rest
}: TooltipContentProps) => (
  // The gap and the gutter reach UI SDK as numbers, generated from the same tokens.
  <ContentPrimitive
    {...rest}
    data-slot="tooltip-content"
    sideOffset={popup.tooltipGap}
    collisionPadding={popup.gutter}
    {...stylex.props(styles.panel, styles.motion, style)}
  >
    <span {...stylex.props(styles.words)}>{children}</span>
  </ContentPrimitive>
);

// ---- A control's own tooltip -----------------------------------------------------------------------

type Control = ReactElement<
  Record<string, unknown> & { ref?: Ref<HTMLElement> }
>;

const isHandler = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === "function";

/**
 * The control with the trigger's props on it. Its own props win, and of the trigger's it never
 * takes the slot, nor the description when the tooltip only repeats its name, which a screen
 * reader has already said. Where both handle an event the trigger's runs first and the control's
 * answer comes back: a press's Promise, which a Button follows.
 */
const TooltipControl = ({
  control,
  named,
  ref,
  ...trigger
}: {
  control: Control;
  named: boolean;
  ref?: Ref<HTMLElement>;
} & Record<string, unknown>) => {
  const { type: Element, props: own } = control;
  const merged: Record<string, unknown> = {
    ...trigger,
    "aria-describedby": named
      ? own["aria-describedby"]
      : (own["aria-describedby"] ?? trigger["aria-describedby"]),
    "data-slot": own["data-slot"],
  };
  for (const [key, value] of Object.entries(own)) {
    const theirs = trigger[key];
    if (isHandler(value) && isHandler(theirs)) {
      merged[key] = (...args: unknown[]) => {
        theirs(...args);
        return value(...args);
      };
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }
  const both = (element: HTMLElement | null) => {
    assignRef(ref, element);
    assignRef(own.ref, element);
  };
  return <Element {...merged} ref={both} />;
};

/** Whether a `tooltip` prop gives words of its own. */
const given = (tooltip: ReactNode) =>
  tooltip !== undefined &&
  tooltip !== null &&
  tooltip !== true &&
  tooltip !== false &&
  tooltip !== "";

/**
 * The tooltip a Button, Toggle or ToggleGroupItem draws itself in, for its `tooltip` prop, as
 * SidebarMenuButton's. Left out, a control that is an icon alone shows its name (`aria-label`),
 * marked `data-tooltip-trigger="name"`, and a control with words shows none; `false` shows none;
 * words or a node show those, and describe the control. Inside a Tooltip of the caller's it shows
 * nothing of its own: that one speaks. At rest it draws the control alone: the tooltip's element is
 * there only while it shows, and a moment after for its fade.
 */
export const ControlTooltip = ({
  tooltip,
  iconOnly,
  children,
}: {
  /** The control's own `tooltip` prop. */
  tooltip: ReactNode;
  /** Whether the control shows only an icon, so its name is not on it. */
  iconOnly: boolean;
  /** The one control. */
  children: Control;
}) => {
  const inside = use(InTooltip);
  const [shown, setShown] = useState(false);
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (leaving.current !== null) {
        clearTimeout(leaving.current);
      }
    },
    []
  );
  const label = children.props["aria-label"];
  const named =
    tooltip === undefined && iconOnly && typeof label === "string" ? label : "";
  if (inside || (!given(tooltip) && named === "")) {
    return children;
  }
  const change = (open: boolean) => {
    if (leaving.current !== null) {
      clearTimeout(leaving.current);
      leaving.current = null;
    }
    if (open) {
      setShown(true);
      return;
    }
    leaving.current = setTimeout(() => {
      setShown(false);
    }, durations.tooltipLeave);
  };
  return (
    <Tooltip onOpenChange={change}>
      <TooltipTrigger asChild data-tooltip-trigger={named === "" ? "" : "name"}>
        <TooltipControl control={children} named={named !== ""} />
      </TooltipTrigger>
      {shown && (
        <TooltipContent data-agent-hidden={named === "" ? undefined : ""}>
          {named === "" ? tooltip : named}
        </TooltipContent>
      )}
    </Tooltip>
  );
};
