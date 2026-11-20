// Target: the page picker behind the Ask bar's plus menu (Shopify Sidekick's target). While it
// picks, the pointer is a crosshair over the page and the part under it carries one outline; a
// click picks that part (the page's own control is not pressed) and Escape stops. The host keeps
// what was picked and shows it in the bar (AskBar `target`), so a question can be about it.
//
//   const picker = useTargetPicker({ onPick: ({ label }) => setTarget({ label }) });
//   <AskBar ... onTarget={picker.start} target={target} onClearTarget={() => setTarget(undefined)} />
//   {picker.outline}
//
// The Ask bar and its panel are never picked: a click on them stops picking. Every value is a
// token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useEffectEvent, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

import { announce } from "../announce/announce";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { askBarWords } from "./words";
import type { AskBarWords } from "./words";

/** What was picked: the element, and a few words that name it. */
export interface TargetPick {
  /** The element picked on the page. */
  element: Element;
  /** A short name for it: its accessible name, else its first 60 characters of text, else its tag. */
  label: string;
}

/** What useTargetPicker takes. */
export interface UseTargetPickerOptions {
  /** Called with what was picked. Picking has stopped by then. */
  onPick: (pick: TargetPick) => void;
  /** Only parts inside this element can be picked. The whole page when it is not given. */
  root?: RefObject<Element | null>;
  /**
   * The words said to a screen reader when picking starts.
   * @default "Pick a part of the page. Escape to stop."
   */
  startLabel?: string;
  /**
   * This picker's own words, over the catalogue's (GraspWords), key by key (`{ pick: "Pick a card. Escape to stop." }`). Any left out
   * are the catalogue's, else English. A flat text prop given beside it still wins until the
   * release's step 5.
   */
  words?: Partial<AskBarWords>;
}

/** What useTargetPicker gives back. */
export interface TargetPicker {
  /** The page is being picked from. */
  picking: boolean;
  /** Starts picking: give it to the AskBar's `onTarget`. */
  start: () => void;
  /** Stops picking without a pick. */
  stop: () => void;
  /** The crosshair layer and the outline: render it anywhere, it draws over the page. */
  outline: ReactNode;
}

/** Where the outline stands, in the window's pixels. */
interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const styles = stylex.create({
  // Over the whole window, above the shell's own layers, so the pointer is a crosshair everywhere.
  catcher: {
    position: "fixed",
    inset: 0,
    zIndex: grasp.shellLayer,
    cursor: "crosshair",
  },
  // The one outline round the part under the pointer: the focus colour, twice a hairline thick.
  outline: {
    position: "fixed",
    zIndex: grasp.shellLayer,
    boxSizing: "border-box",
    pointerEvents: "none",
    borderRadius: grasp.cornerMark,
    outline: {
      default: `calc(2 * ${grasp.hairline}) solid ${grasp.ring}`,
      [media.forced]: `calc(2 * ${grasp.hairline}) solid Highlight`,
    },
    // A step outside the part, so the line never touches its words (it stood flush on them).
    outlineOffset: grasp.space1,
    transitionProperty: "top, left, width, height",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
  },
  box: (top: string, left: string, width: string, height: string) => ({
    top,
    left,
    width,
    height,
  }),
});

/** The Ask parts themselves, which are never picked. */
const ASK_PARTS = '[data-slot="ask-bar"], [data-slot="ask-panel"]';
/** The picker's own layers, which every hit test looks through. */
const OWN = "[data-target-picker]";
/** How many characters of text name a part that has no name of its own. */
const TEXT_LENGTH = 60;

const squeeze = (text: string | null | undefined) =>
  (text ?? "").replaceAll(/\s+/gu, " ").trim();

/** A few words for an element: its accessible name, its text cut short, or its tag. */
export const labelOf = (element: Element): string => {
  const named = squeeze(element.getAttribute("aria-label"));
  if (named !== "") {
    return named;
  }
  const ids = squeeze(element.getAttribute("aria-labelledby"));
  const labelled = squeeze(
    ids
      .split(" ")
      .map((id) =>
        id === ""
          ? ""
          : (document.querySelector(`#${CSS.escape(id)}`)?.textContent ?? "")
      )
      .join(" ")
  );
  if (labelled !== "") {
    return labelled;
  }
  const alt = squeeze(
    element.getAttribute("alt") ?? element.getAttribute("title")
  );
  if (alt !== "") {
    return alt;
  }
  const text = squeeze(element.textContent);
  if (text !== "") {
    return text.length > TEXT_LENGTH
      ? `${text.slice(0, TEXT_LENGTH).trimEnd()}…`
      : text;
  }
  return element.tagName.toLowerCase();
};

/** The part of the page under a point, or null where nothing can be picked. */
const partAt = (x: number, y: number, root: Element | null): Element | null => {
  const part = document
    .elementsFromPoint(x, y)
    .find((element) => element.closest(OWN) === null);
  if (
    part === undefined ||
    part === document.body ||
    part === document.documentElement
  ) {
    return null;
  }
  if (
    part.closest(ASK_PARTS) !== null ||
    (root !== null && !root.contains(part))
  ) {
    return null;
  }
  return part;
};

/** The box an element takes in the window. */
const boxOf = (element: Element): Box => {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
};

/** The scroller a wheel over `element` would move: its nearest scrolling ancestor, or the page. */
const scrollerOf = (element: Element | null): Element | null => {
  for (let at = element; at !== null; at = at.parentElement) {
    const { overflowY, overflowX } = getComputedStyle(at);
    const scrolls = /auto|scroll/u.test(`${overflowY} ${overflowX}`);
    if (
      scrolls &&
      (at.scrollHeight > at.clientHeight || at.scrollWidth > at.clientWidth)
    ) {
      return at;
    }
  }
  return document.scrollingElement;
};

/** Keeps an event from the page: no default, and no one after the picker hears it. */
const hold = (event: Event) => {
  event.preventDefault();
  event.stopPropagation();
};

interface Listen {
  root: Element | null;
  onBox: (box: Box | null) => void;
  onPick: (element: Element) => void;
  onCancel: () => void;
}

// The page's events while picking, heard first (capture) so the page's own controls hear none of
// them. Returns the cleanup.
const listen = ({ root, onBox, onPick, onCancel }: Listen) => {
  let x = 0;
  let y = 0;
  // The press that chose Target may still end in a click (a menu that picks on release): clicks
  // before the next frame are held, never picks.
  let ready = false;
  const frame = requestAnimationFrame(() => {
    ready = true;
  });
  const show = () => {
    const part = partAt(x, y, root);
    onBox(part === null ? null : boxOf(part));
  };
  const move = (event: PointerEvent) => {
    x = event.clientX;
    y = event.clientY;
    show();
  };
  const click = (event: MouseEvent) => {
    hold(event);
    if (!ready) {
      return;
    }
    const part = partAt(event.clientX, event.clientY, root);
    if (part === null) {
      onCancel();
      return;
    }
    onPick(part);
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      hold(event);
      onCancel();
    }
  };
  // The crosshair layer takes the wheel: hand it to what is under it, then follow the part.
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    const under =
      document
        .elementsFromPoint(event.clientX, event.clientY)
        .find((element) => element.closest(OWN) === null) ?? null;
    scrollerOf(under)?.scrollBy({ top: event.deltaY, left: event.deltaX });
  };
  const options = { capture: true };
  const wheelOptions = { capture: true, passive: false };
  document.addEventListener("pointermove", move, options);
  document.addEventListener("pointerdown", hold, options);
  document.addEventListener("pointerup", hold, options);
  document.addEventListener("mousedown", hold, options);
  document.addEventListener("click", click, options);
  document.addEventListener("keydown", key, options);
  document.addEventListener("wheel", wheel, wheelOptions);
  document.addEventListener("scroll", show, options);
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener("pointermove", move, options);
    document.removeEventListener("pointerdown", hold, options);
    document.removeEventListener("pointerup", hold, options);
    document.removeEventListener("mousedown", hold, options);
    document.removeEventListener("click", click, options);
    document.removeEventListener("keydown", key, options);
    document.removeEventListener("wheel", wheel, wheelOptions);
    document.removeEventListener("scroll", show, options);
  };
};

const px = (value: number) => `${value}px`;

/** Picks a part of the page with the pointer: a crosshair, one outline, a click, Escape to stop. */
export const useTargetPicker = ({
  onPick,
  root,
  startLabel: startGiven,
  words,
}: UseTargetPickerOptions): TargetPicker => {
  const { pick: startLabel } = withGiven(
    useWords("askBar", askBarWords, words),
    { pick: startGiven }
  );
  const [picking, setPicking] = useState(false);
  const [box, setBox] = useState<Box | null>(null);
  const stop = () => {
    setPicking(false);
    setBox(null);
  };
  const picked = useEffectEvent((element: Element) => {
    stop();
    onPick({ element, label: labelOf(element) });
  });
  const cancelled = useEffectEvent(() => {
    stop();
  });
  // Listeners from the commit after start, so the press that started picking is not a pick.
  useEffect(
    () =>
      picking
        ? listen({
            root: root?.current ?? null,
            onBox: setBox,
            onPick: picked,
            onCancel: cancelled,
          })
        : undefined,
    [picking, root]
  );
  const start = () => {
    setPicking(true);
    announce(startLabel);
  };
  const layers = (
    <>
      <div
        data-target-picker=""
        aria-hidden="true"
        {...stylex.props(styles.catcher)}
      />
      {box !== null && (
        <div
          data-target-picker=""
          aria-hidden="true"
          {...stylex.props(
            styles.outline,
            styles.box(px(box.top), px(box.left), px(box.width), px(box.height))
          )}
        />
      )}
    </>
  );
  const outline =
    picking && typeof document !== "undefined"
      ? createPortal(layers, document.body)
      : null;
  return { picking, start, stop, outline };
};
