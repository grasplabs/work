// What the layers share: dialog, alert dialog, command, drawer, sheet, popover and the pickers. A
// panel that always finishes closing, a shade that lets the next press through as it leaves, the
// look of a panel, its title, its description and its scrolling body, a body that knows its title
// and whether it scrolls, a popup that grows from the trigger that opened it, and the row of a
// surface's top-end actions.
"use client";

import * as stylex from "@stylexjs/stylex";
import { createElement, useState } from "react";

import {
  colors,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "./tokens.stylex";
import { durations } from "./tokens.values";

// ---- Grow from the trigger ----------------------------------------------------------------------
//
// Every trigger-based part animates from its trigger, never its centre. Most popups get this from
// their positioner's --transform-origin. These are for the ones placed without one (a dialog stands
// centred in the window), or placed against something other than the control pressed (a date
// picker lines up with its field, opened from the calendar button at its end): the origin is the
// trigger's centre, in the popup's own untransformed box.
//
//   <Popup ref={transformOriginFromTrigger} />    as a ref callback; React runs its cleanup

/** The cleanup of a ref that started nothing. */
const keep = () => {
  // Nothing was started, so nothing stops.
};

/** The control that opened `popup`: the one whose aria-controls names it. */
const triggerOf = (popup: HTMLElement): HTMLElement | null =>
  popup.id === ""
    ? null
    : document.querySelector<HTMLElement>(
        `[aria-controls="${CSS.escape(popup.id)}"]`
      );

/** The popup's untransformed box on the screen: its layout place, before any scale or shift. */
const boxOf = (popup: HTMLElement) => {
  const style = getComputedStyle(popup);
  // A fixed popup placed by its positioner (an inline left and top) is where they say; a scale
  // moves only its picture, never these.
  if (
    style.position === "fixed" &&
    popup.style.length > 0 &&
    (popup.style.left !== "" || popup.style.inset !== "")
  ) {
    // Computed in px ("480px"): the number before the unit.
    return {
      left: Number(style.left.slice(0, -2)),
      top: Number(style.top.slice(0, -2)),
    };
  }
  let left = popup.offsetLeft;
  let top = popup.offsetTop;
  // A fixed popup's offsets are the window's; any other adds its offset parents' places.
  const parent = popup.offsetParent;
  if (parent instanceof HTMLElement && style.position !== "fixed") {
    const box = parent.getBoundingClientRect();
    left += box.left + parent.clientLeft;
    top += box.top + parent.clientTop;
  }
  return { left, top };
};

/**
 * A ref that sets a popup's transform-origin to the centre of the trigger `findTrigger` gives, and
 * again whenever the popup is placed anew. With no trigger nothing is set, and the popup keeps its
 * positioner's origin or its own centre. For a popup whose pressed control does not name it (a
 * combobox's chevron button). It marks the popup `data-from-trigger`, so its motion can drop what
 * would fight the origin (a dialog's rise).
 */
export const transformOriginFrom =
  (findTrigger: (popup: HTMLElement) => HTMLElement | null) =>
  (popup: HTMLElement | null) => {
    if (popup === null) {
      return keep;
    }
    const place = () => {
      const trigger = findTrigger(popup);
      if (trigger === null) {
        return;
      }
      const at = trigger.getBoundingClientRect();
      const box = boxOf(popup);
      const value = `${Math.round(at.left + at.width / 2 - box.left)}px ${Math.round(at.top + at.height / 2 - box.top)}px`;
      // Only when it changes: setting it is itself a change to the style the watch below reads.
      if (popup.style.transformOrigin !== value) {
        popup.style.transformOrigin = value;
      }
      popup.dataset.fromTrigger ??= "";
    };
    place();
    // A positioned popup is placed by its inline style, which may come after this first look.
    const watch = new MutationObserver(place);
    watch.observe(popup, {
      attributes: true,
      attributeFilter: ["style", "data-side", "data-align"],
    });
    return () => {
      watch.disconnect();
    };
  };

/** Sets a popup's transform-origin to its trigger's centre: the control whose aria-controls names it. */
export const transformOriginFromTrigger = transformOriginFrom(triggerOf);

/** Whether a press at `at` (Date.now()) came just now: a popup that opens on it grows from what was pressed. */
export const pressedJustNow = (at: number) =>
  Date.now() - at < durations.justPressed;

// ---- A close that always ends -------------------------------------------------------------------
//
// UI SDK takes a panel away once every animation in it has finished; one that cannot finish
// (Firefox runs a scroll-driven hairline as an animation that never ends) would leave the panel and
// its shade over the page, catching every press. So once the panel starts to leave, it gets its
// leave time and a margin, and then whatever still runs in it is cancelled.

/** Milliseconds from a computed list of times ("0.2s, 150ms"); one that cannot be read is 0. */
const times = (value: string) =>
  value.split(",").map((part) => {
    const text = part.trim();
    const time = text.endsWith("ms")
      ? Number(text.slice(0, -2))
      : Number(text.slice(0, -1)) * 1000;
    return Number.isNaN(time) ? 0 : time;
  });

const leaveTime = (element: Element) => {
  const style = getComputedStyle(element);
  const lengths = times(style.transitionDuration);
  const delays = times(style.transitionDelay);
  return Math.max(
    0,
    ...lengths.map(
      (length, index) => length + (delays[index % delays.length] ?? 0)
    )
  );
};

const leaving = (element: HTMLElement) =>
  element.dataset.endingStyle !== undefined;

const watchClose = (element: HTMLElement) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watch = () => {
    clearTimeout(timer);
    if (!leaving(element)) {
      return;
    }
    timer = setTimeout(
      () => {
        if (!leaving(element)) {
          return;
        }
        for (const animation of element.getAnimations({ subtree: true })) {
          animation.cancel();
        }
      },
      leaveTime(element) + durations.leaveMargin
    );
  };
  const observer = new MutationObserver(watch);
  observer.observe(element, {
    attributes: true,
    attributeFilter: ["data-ending-style"],
  });
  // Attached again while it already leaves: the wait starts now.
  watch();
  return () => {
    observer.disconnect();
    clearTimeout(timer);
  };
};

/**
 * A ref for a panel: its close finishes at the latest a little after its leave time. One function
 * for every panel, so React attaches it once per element.
 */
const sureClose = (element: HTMLElement | null) =>
  element === null ? undefined : watchClose(element);

/**
 * A dialog panel's ref: it closes for sure once its leave has run, and grows from its trigger, with
 * no rise then (`--dialog-shift: 0px`; a rise would fight the origin). With no trigger it grows from
 * its own centre and keeps the rise.
 */
export const watchPanel = (element: HTMLElement | null) => {
  const stopClose = sureClose(element);
  const stopOrigin = transformOriginFromTrigger(element);
  if (element?.dataset.fromTrigger !== undefined) {
    element.style.setProperty("--dialog-shift", "0px");
  }
  return () => {
    stopClose?.();
    stopOrigin();
  };
};

// ---- The shade ----------------------------------------------------------------------------------
//
// While a modal layer leaves, UI SDK takes any press over its shade as the shade's (layers.js: an
// exiting layer's `overBackdrop`). Closed by anything but a press on its shade (Escape, Cancel,
// the close button, a close from code, a command chosen), that swallowed the person's next press
// for the whole leave. UI SDK reads the shade's own box, so a shade that was not pressed leaves
// with none: its scrim is drawn by its ::before, over the window whatever its box, and the next
// press goes through. A shade whose press closed its layer keeps its box as it leaves, so a second
// press there goes where it always went.
//
// The fix belongs in UI SDK: layers.js should record why a layer closed and swallow a press during
// its leave only when an outside press closed it. Once it does, this whole section goes and every
// shade is a plain fixed box again.

// UI SDK marks a closing shade `data-closed` until it goes, and `data-ending-style` only while its own
// fade runs, which may end before its panel's.
const leavingUnpressed = ":is([data-closed]:not([data-shade-pressed]))";

const shadeStyles = stylex.create({
  shade: {
    position: "fixed",
    inset: { default: 0, [leavingUnpressed]: "0 auto auto 0" },
    width: { default: null, [leavingUnpressed]: 0 },
    height: { default: null, [leavingUnpressed]: 0 },
    // Closed, it is no target for a press, though its fade may have ended (and its inert with it)
    // before its panel's.
    pointerEvents: { default: null, ":is([data-closed])": "none" },
    "::before": {
      content: '""',
      position: "fixed",
      inset: 0,
      backgroundColor: colors.dialogScrim,
    },
  },
});

/**
 * Marks the shade `data-shade-pressed` as its layer closes when a press on it is what closed it, so
 * only that shade keeps its box as it leaves. A press on the shade that ends with the layer still
 * open (an alert dialog's, which a press outside never closes) is forgotten once it is over, so a
 * close that follows by any other road (a call, a screen reader's click, a phone's back) leaves no
 * box behind. Returns the clean-up, as a ref callback's.
 */
const watchShade = (element: HTMLElement | null) => {
  if (element === null) {
    return keep;
  }
  const view = element.ownerDocument.defaultView;
  let pressed = false;
  let check: ReturnType<typeof setTimeout> | undefined;
  const heard = (event: Event) => {
    pressed = event.type === "pointerdown" && event.target === element;
  };
  // UI SDK closes on the press's down, its up or (by touch) its click; React marks the shade closed
  // in a microtask after. A task later, a shade still open was pressed in vain. A touch's up comes
  // before the click that may close, so only that click tells (Chromium makes the click itself a
  // touch PointerEvent; WebKit a mouse one).
  const over = (event: Event) => {
    if (
      event.type === "pointerup" &&
      event instanceof PointerEvent &&
      event.pointerType === "touch"
    ) {
      return;
    }
    clearTimeout(check);
    check = setTimeout(() => {
      if (element.dataset.closed === undefined) {
        pressed = false;
      }
    }, 0);
  };
  const cancelled = () => {
    pressed = false;
  };
  const settle = new MutationObserver(() => {
    element.toggleAttribute(
      "data-shade-pressed",
      element.dataset.closed !== undefined && pressed
    );
  });
  settle.observe(element, {
    attributes: true,
    attributeFilter: ["data-closed"],
  });
  const listened = [
    ["pointerdown", heard],
    ["keydown", heard],
    ["pointerup", over],
    ["click", over],
    ["pointercancel", cancelled],
  ] as const;
  for (const [type, listener] of listened) {
    view?.addEventListener(type, listener, true);
  }
  return () => {
    clearTimeout(check);
    settle.disconnect();
    for (const [type, listener] of listened) {
      view?.removeEventListener(type, listener, true);
    }
  };
};

/**
 * Everything a layer's shade takes, for its Backdrop part, so no shade can have the look without
 * the watch that lets the next press through: its element (named `slot`), the scrim and the
 * caller's own styles after it (a fade).
 *
 *   <DialogBackdrop {...shadeProps("dialog-overlay", styles.fade)} />
 */
export const shadeProps = (slot: string, ...style: stylex.StyleXStyles[]) => ({
  render: createElement("div", { ref: watchShade, "data-slot": slot }),
  ...stylex.props(shadeStyles.shade, style),
});

// ---- The scrolling body -------------------------------------------------------------------------

/**
 * Watches the scrolling part of a panel whose role is `role` (a dialog's, an alert dialog's, a
 * drawer's, a popover's body): it is named by the panel's title, and says whether it holds more
 * than it shows, now and as its size or that of anything in it changes. The title is read again at
 * each look, as a panel may name itself after its body mounts. Returns the clean-up.
 */
export const watchBody = (
  element: HTMLElement,
  role: "dialog" | "alertdialog",
  setTitle: (title: string | undefined) => void,
  setScrolls: (scrolls: boolean) => void
) => {
  const measure = () => {
    setTitle(
      element.closest(`[role="${role}"]`)?.getAttribute("aria-labelledby") ??
        undefined
    );
    setScrolls(element.scrollHeight > element.clientHeight + 1);
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  for (const child of element.children) {
    observer.observe(child);
  }
  // Content that comes later (a list that loads, a section that opens) is watched as it comes: a
  // body of a fixed height (a sheet's) does not change size as it fills, only its content does.
  const added = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          observer.observe(node);
        }
      }
    }
    measure();
  });
  added.observe(element, { childList: true });
  return () => {
    added.disconnect();
    observer.disconnect();
  };
};

/**
 * Keeps UI SDK's drawer (and the sheet built on it) from moving the body on its own focus, for
 * useLayerBody's `also`: the drawer keeps a focused field 16px clear of its scroll area's edge, and
 * the body that takes focus (it does when it scrolls, on opening too) is its own scroll area, so it
 * moved 16px every time. Focus on the body itself goes no further than the body; a field inside is
 * still brought into view. Returns the clean-up.
 */
export const keepBodyPut = (element: HTMLElement) => {
  const stay = (event: FocusEvent) => {
    if (event.target === element) {
      event.stopPropagation();
    }
  };
  element.addEventListener("focusin", stay);
  return () => {
    element.removeEventListener("focusin", stay);
  };
};

/** One clean-up for two watches, the second one when there is one. */
const both = (first: () => void, second: (() => void) | undefined) => () => {
  second?.();
  first();
};

/**
 * The props of a panel's scrolling body (watchBody): when it holds more than it shows, it takes
 * focus and is named by the panel's title, so the keys can scroll it too (WCAG 2.1.1); when
 * everything fits it is not a stop at all. `also` watches the same element in a way of its own
 * (a drawer's) and returns its clean-up; give a function made once, outside the component.
 *
 *   <div data-slot="dialog-body" {...useLayerBody("dialog")} {...stylex.props(layerStyles.body)}>
 */
export const useLayerBody = (
  role: "dialog" | "alertdialog",
  also?: (element: HTMLElement) => () => void
) => {
  const [scrolls, setScrolls] = useState(false);
  const [title, setTitle] = useState<string>();
  const ref = (element: HTMLDivElement | null) =>
    element === null
      ? undefined
      : both(watchBody(element, role, setTitle, setScrolls), also?.(element));
  return {
    ref,
    tabIndex: scrolls ? 0 : undefined,
    role: scrolls ? ("region" as const) : undefined,
    "aria-labelledby": scrolls ? title : undefined,
  };
};

// ---- The look of a panel ------------------------------------------------------------------------

const FORCED = media.forcedColors;
const SCROLLS = "@supports (animation-timeline: scroll())";

// The body's hairlines along its scroll: the bottom one at the top, both in between, the top one
// at the end. A body cut in a gap between paragraphs still says there is more.
const lineBelow = `inset 0 -1px 0 ${colors.border}`;
const lineAbove = `inset 0 1px 0 ${colors.border}`;
const edges = stylex.keyframes({
  "0%": { boxShadow: lineBelow },
  "1%, 99%": { boxShadow: `${lineAbove}, ${lineBelow}` },
  "100%": { boxShadow: lineAbove },
});

// While there is more below, the last of the body fades into the panel's ground just above its
// bottom hairline, so a line cut at that edge reads as more to come, not as words underlined by the
// hairline. The fade stands on its own layer (::after), not a mask: a mask would take the hairline
// with it. The hairline's own pixel is left clear. At the end it is gone.
const FADE = space["6"];
const more = stylex.keyframes({
  "0%, 99%": { opacity: 1 },
  "100%": { opacity: 0 },
});

// A panel that leaves or is closed: its body's scroll-driven lines stop, as a scroll-driven
// animation never ends, and a close may wait for its animations to end (Firefox would keep the
// panel and its shade over the page).
const GONE = ":is(:is([data-ending-style], [data-closed]) *)";

/**
 * The look a layer's panel shares (a dialog's, an alert dialog's, a drawer's): the panel itself,
 * its title, the sentence under it, and the body that scrolls between the title and the actions.
 * Each panel adds its own place, size, corners, header and footer.
 */
export const layerStyles = stylex.create({
  // Raised and lifted, header, body and footer in one column; only the body scrolls, so the title
  // and the actions stay in view. The browser's own dialog box: no border, no padding.
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
    backgroundColor: colors.card,
    boxShadow: shadow.lg,
    fontFamily: font.sans,
    // A panel that opens inside its trigger's parent (it is not portalled) would take that parent's
    // text: an end-aligned table cell would line its words up on the right. It sets its own, and
    // keeps only the direction, which follows the page.
    textAlign: "start",
    whiteSpace: "normal",
    fontWeight: "normal",
    fontStyle: "normal",
    textTransform: "none",
    letterSpacing: "normal",
    wordSpacing: "normal",
    textIndent: 0,
    outline: "none",
  },

  // The title, in the interface's own type a step up in weight.
  title: {
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
    overflowWrap: "anywhere",
    hyphens: "manual",
    textWrap: "balance",
  },
  description: {
    margin: 0,
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
    hyphens: "manual",
    textWrap: "pretty",
  },

  // The body scrolls on its own. A hairline shows at its top once it has scrolled, and at its
  // bottom while there is more below, driven by its own scroll (no script). A body that does not
  // scroll has no timeline, so it draws no line. Room above and below for a field's focus ring,
  // which the scrolling box would otherwise cut.
  body: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    marginBlockStart: `calc(${space["5"]} - ${space["2"]})`,
    marginBlockEnd: `calc(-1 * ${space["2"]})`,
    paddingBlock: space["2"],
    paddingInline: space["6"],
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "contain",
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    color: colors.bodyForeground,
    overflowWrap: "anywhere",
    hyphens: "manual",
    // Only where the browser drives an animation by scroll; elsewhere no line at all. Never once
    // the panel leaves.
    animationName: {
      default: null,
      [SCROLLS]: { default: edges, [GONE]: "none" },
    },
    animationDuration: { default: null, [SCROLLS]: "auto" },
    animationTimingFunction: { default: null, [SCROLLS]: "linear" },
    animationFillMode: { default: null, [SCROLLS]: "both" },
    animationTimeline: { default: null, [SCROLLS]: "scroll(self)" },
    // When it has more than it shows, it takes focus, so the keys can scroll it. Its ring is drawn
    // inside it, where the panel does not cut it. Square otherwise, so the hairlines run straight
    // to its sides instead of bending up at its corners.
    borderRadius: { default: 0, ":focus-visible": radius.sm },
    cornerShape: radius.shape,
    "::after": {
      content: '""',
      position: "sticky",
      insetBlockEnd: `calc(-1 * ${space["2"]})`,
      display: "block",
      height: FADE,
      marginBlockStart: `calc(-1 * ${FADE})`,
      marginInline: `calc(-1 * ${space["6"]})`,
      pointerEvents: "none",
      backgroundImage: `linear-gradient(to bottom, transparent, ${colors.card} calc(100% - ${size.hairline}), transparent calc(100% - ${size.hairline}))`,
      opacity: 0,
      animationName: {
        default: null,
        [SCROLLS]: { default: more, [GONE]: "none" },
      },
      animationDuration: { default: null, [SCROLLS]: "auto" },
      animationTimingFunction: { default: null, [SCROLLS]: "linear" },
      animationFillMode: { default: null, [SCROLLS]: "both" },
      animationTimeline: { default: null, [SCROLLS]: "scroll(nearest)" },
    },
  },
});

// ---- A surface's top-end actions ----------------------------------------------------------------
