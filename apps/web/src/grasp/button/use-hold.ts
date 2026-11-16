// useHold: hold to confirm, for a Button with `hold` (hold.tsx). A press kept down for the hold's
// time runs the action once; letting go early or moving off cancels it. A press too short to be a
// hold, or a click with no press behind it (a screen reader, a switch, voice control, an agent),
// asks instead: it opens the confirmation beside the button, which says the same words.
//
//   pointer    down starts it, up before the end cancels it, leaving the button cancels it, and a
//              touch that turns into a scroll cancels it
//   keyboard   Enter or Space held down starts it, and key repeat never starts it again
//   a tap      released within a quarter of the hold: opens the confirmation and does not fire
//
// It draws nothing itself: the Button inside reads `holding` from HoldContext and draws the fill.
"use client";

import type { ButtonActionDetails } from "@ui-sdk/react/button";
import {
  createContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent, Ref } from "react";

import { ms } from "../tokens/tokens.values";

/** `true` for the hold-duration token, or `{ ms }` for a hold of another length. */
export type HoldSetting = boolean | { ms: number };

/** The words a hold says, so the product can say them in its own language. */
export interface ButtonHoldLabels {
  /** The button's name while it holds: "Hold to delete draft", from its own words. */
  holdTo: (words: string) => string;
  /** The confirmation's title, from the button's words: "Delete draft?". */
  ask: (words: string) => string;
  /** The confirmation's title when the button has no words. */
  confirm: string;
  /** The confirmation's way out. */
  cancel: string;
}

/** A hold's words in English: replace any of them through Button's `holdLabels`. */
export const englishHoldLabels: ButtonHoldLabels = {
  holdTo: (words) =>
    `Hold to ${words.charAt(0).toLowerCase()}${words.slice(1)}`,
  ask: (words) => `${words}?`,
  confirm: "Confirm",
  cancel: "Cancel",
};

/** What the Button inside a hold draws from: whether it is held now, for how long, and its name. */
export interface HoldLook {
  holding: boolean;
  ms: number;
  name: string | undefined;
}

/** Set by the hold around its Button, so that Button draws the fill rather than holding again. */
export const HoldContext = createContext<HoldLook | null>(null);

/** How long a hold lasts, in milliseconds. */
export const holdTime = (setting: HoldSetting | undefined): number =>
  typeof setting === "object" ? setting.ms : ms.holdDuration;

// A press let go within this share of the hold is a tap, from someone who may not be able to hold:
// it asks. A longer press let go early was a hold that was given up: it does nothing.
const TAP_SHARE = 0.25;

/**
 * Waits on what the hold's own press started. A failed action rejects to tell UI SDK it failed;
 * this press is the hold's, not UI SDK's, so nothing else would catch it. The failure is shown on
 * the button by its own state.
 */
const settled = async (result: unknown) => {
  try {
    await result;
  } catch {
    // Shown by the button: nothing more to do here.
  }
};

/** What a plain click says it was, when it comes with no details of its own. */
const pointerPress: ButtonActionDetails = { source: "mouse" };

type Click = (
  event: MouseEvent<HTMLElement>,
  details: ButtonActionDetails
) => unknown;

/** Sets a ref, whichever kind it is: the caller's, the trigger's. */
export const assignRef = (
  ref: Ref<HTMLElement> | undefined,
  node: HTMLElement | null
) => {
  if (typeof ref === "function") {
    ref(node);
  } else if (ref) {
    ref.current = node;
  }
};

/** Clicks the button with `firing` set, so its click handler knows the hold itself pressed it. */
const clickFiring = (button: HTMLElement, firing: { current: boolean }) => {
  firing.current = true;
  try {
    button.click();
  } finally {
    firing.current = false;
  }
};

const isKey = (event: KeyboardEvent) =>
  event.key === "Enter" || event.key === " ";

interface HoldOptions {
  /** How long the press must last, in milliseconds. */
  ms: number;
  /** False while disabled, working or showing a result: a press then starts nothing. */
  pressable: boolean;
  /** The button's own action: runs once a hold completes, or once the confirmation says yes. */
  act: Click | undefined;
  /** Runs when a hold starts: the confirmation closes, so the action cannot run twice. */
  onStart?: () => void;
}

export const useHold = ({ ms: time, pressable, act, onStart }: HoldOptions) => {
  const [holding, setHolding] = useState(false);
  const element = useRef<HTMLElement | null>(null);
  // 0 while no hold is timed.
  const timer = useRef(0);
  const started = useRef(0);
  // How the current press began, so only its own end finishes it.
  const by = useRef<"pointer" | "key" | null>(null);
  // The click that follows a hold (fired or given up) is swallowed. Set at the release and cleared
  // by that click, by the next press, or after a moment (a touch's click comes a task later), so a
  // click with no press behind it always asks.
  const swallow = useRef(false);
  const swallowTimer = useRef(0);
  const touch = useRef(false);
  const pointer = useRef<number | null>(null);
  // Set while the hold itself clicks the button, so that click runs the action.
  const firing = useRef(false);
  // A hold cancelled while the press is still down (moved off, a scroll, focus left): the click
  // its release may still cause is swallowed too.
  const given = useRef(false);
  const latest = useRef({ act, pressable, onStart });
  useEffect(() => {
    latest.current = { act, pressable, onStart };
  });

  const arm = (on: boolean) => {
    clearTimeout(swallowTimer.current);
    swallow.current = on;
    if (on) {
      swallowTimer.current = window.setTimeout(() => {
        swallow.current = false;
      }, 600);
    }
  };

  const stop = () => {
    clearTimeout(timer.current);
    timer.current = 0;
    by.current = null;
    pointer.current = null;
    setHolding(false);
  };

  /** Runs the action through a real click on the button, so a form's submit button submits. */
  const fire = () => {
    const button = element.current;
    if (button) {
      clickFiring(button, firing);
    }
  };

  const start = (source: "pointer" | "key") => {
    arm(false);
    by.current = source;
    latest.current.onStart?.();
    started.current = performance.now();
    setHolding(true);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      setHolding(false);
      // The press is still down: its release must not click again.
      arm(true);
      fire();
    }, time);
  };

  /**
   * The press ended. Returns whether it was a tap, which asks. A finished hold and a hold given up
   * both swallow the click that follows. `clicks`: whether a click follows this release (a
   * pointer's up, Space's keyup); Enter's does not.
   */
  const release = (clicks: boolean) => {
    const wasHolding = by.current !== null;
    const finished = wasHolding && timer.current === 0;
    const tap =
      wasHolding &&
      !finished &&
      performance.now() - started.current < time * TAP_SHARE;
    stop();
    if (wasHolding && !tap) {
      arm(clicks);
    }
    return tap;
  };

  /** Cancels a hold whose press is still down: its release's click, if any, is swallowed too. */
  const giveUp = () => {
    if (by.current === null) {
      return;
    }
    stop();
    given.current = true;
  };

  // The effects below give up through this, so they run only when what they watch changes.
  const giveUpNow = useEffectEvent(giveUp);

  /** The press ended after its hold was cancelled. */
  const ended = (clicks: boolean) => {
    if (!given.current) {
      return;
    }
    given.current = false;
    arm(clicks);
  };

  // A touch that turns into a scroll of something round the button cancels the hold. Scrolls
  // elsewhere (a log that follows its end) do not. Listened for only while it holds.
  useEffect(() => {
    const scrolled = (event: Event) => {
      const button = element.current;
      const { target } = event;
      if (!touch.current || !button) {
        return;
      }
      if (
        target === document ||
        (target instanceof Node && target.contains(button))
      ) {
        giveUpNow();
      }
    };
    if (holding) {
      window.addEventListener("scroll", scrolled, {
        capture: true,
        passive: true,
      });
    }
    return () => {
      window.removeEventListener("scroll", scrolled, { capture: true });
    };
  }, [holding]);

  // Disabled, or busy, while held: the hold stops.
  useEffect(() => {
    if (!pressable) {
      giveUpNow();
    }
  }, [pressable]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(swallowTimer.current);
    },
    []
  );

  /**
   * The handlers for the Button inside the hold. Its own click (the popover trigger's) opens the
   * confirmation; the trigger's other handlers run after these.
   */
  const handlers = (theirs: Record<string, unknown>) => {
    const call = (name: string, ...args: unknown[]) => {
      const handler = theirs[name];
      if (typeof handler === "function") {
        Reflect.apply(handler, null, args);
      }
    };
    return {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        element.current = event.currentTarget;
        given.current = false;
        if (
          latest.current.pressable &&
          event.button === 0 &&
          by.current === null
        ) {
          // A finger is held by the button it touched; let go of it, so sliding off cancels.
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          pointer.current = event.pointerId;
          touch.current = event.pointerType === "touch";
          start("pointer");
        }
        call("onPointerDown", event);
      },
      onPointerUp: (event: PointerEvent<HTMLElement>) => {
        if (by.current === "pointer" && event.pointerId === pointer.current) {
          release(true);
        } else {
          ended(true);
        }
        call("onPointerUp", event);
      },
      onPointerLeave: (event: PointerEvent<HTMLElement>) => {
        if (by.current === "pointer" && event.pointerId === pointer.current) {
          giveUp();
        }
        call("onPointerLeave", event);
      },
      onPointerCancel: (event: PointerEvent<HTMLElement>) => {
        if (by.current === "pointer" && event.pointerId === pointer.current) {
          giveUp();
        }
        call("onPointerCancel", event);
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (!isKey(event)) {
          call("onKeyDown", event);
          return;
        }
        element.current = event.currentTarget;
        if (!event.repeat) {
          given.current = false;
        }
        // Enter clicks on keydown, and again on each repeat: never here. Space clicks on keyup.
        if (event.key === "Enter") {
          event.preventDefault();
        }
        if (!event.repeat && by.current === null && latest.current.pressable) {
          start("key");
        }
      },
      onKeyUp: (event: KeyboardEvent<HTMLElement>) => {
        if (!isKey(event)) {
          call("onKeyUp", event);
          return;
        }
        const clicks = event.key === " ";
        if (by.current !== "key") {
          ended(clicks);
          return;
        }
        const tap = release(clicks);
        // Space's own click follows this keyup and asks or is swallowed; Enter's was stopped, so a
        // tap of Enter asks here.
        if (tap && event.key === "Enter") {
          event.currentTarget.click();
        }
      },
      onBlur: (event: unknown) => {
        if (by.current !== null) {
          giveUp();
        }
        call("onBlur", event);
      },
      // A long press on a touch screen opens no menu or callout while it holds.
      onContextMenu: (event: MouseEvent<HTMLElement>) => {
        if (by.current !== null) {
          event.preventDefault();
        }
        call("onContextMenu", event);
      },
      // The hold's own click (it clicks the button once when held long enough) comes with no
      // details: a person's pointer.
      onClick: (
        event: MouseEvent<HTMLElement>,
        passed?: ButtonActionDetails
      ) => {
        const details = passed ?? pointerPress;
        element.current = event.currentTarget;
        if (firing.current) {
          void settled(latest.current.act?.(event, details));
          return;
        }
        if (swallow.current) {
          arm(false);
          event.preventDefault();
          return;
        }
        // A tap, or a click with no press behind it: ask. A submit button submits only on the yes.
        call("onClick", event, details);
        event.preventDefault();
      },
    };
  };

  // The button's element is also the hold's ref, for the confirmation's anchor.
  return { holding, ms: time, handlers, handleYes: fire, ref: element };
};
