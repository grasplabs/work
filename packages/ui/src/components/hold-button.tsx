// HoldButton: press and hold to confirm, for what cannot be undone but is not grave (delete a
// draft). A press kept down for the hold's time runs `onConfirm` once; letting go early, moving off
// or a touch that turns into a scroll cancels it. A fill crosses the button while it is held: a layer
// of the button itself (its ::before), so the button's own shape cuts it and its size never changes.
//
//   <HoldButton variant="destructive" onConfirm={deleteDraft}>Delete draft</HoldButton>
//
// Someone who cannot hold (a screen reader, a switch, voice control, a quick tap) gets a Popover
// instead, with the button's own words and Cancel: the button is that popover's trigger. An agent
// presses the popover's action, which waits for the person's yes (UI SDK's agent bridge).
//
//   pointer    down starts it; up before the end, leaving the button, Escape and a touch that turns
//              into a scroll cancel it
//   keyboard   Enter or Space held down starts it, and key repeat never starts it again
//   a tap      released within a quarter of the hold: opens the confirmation and runs nothing
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ButtonActionDetails } from "@ui-sdk/react/button";
import { PopoverTrigger as TriggerPrimitive } from "@ui-sdk/react/popover";
import { mergeProps } from "@ui-sdk/react/primitive";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type {
  ComponentProps,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactNode,
} from "react";

import { useAction } from "../hooks/use-action";
import { useI18n } from "../lib/i18n";
import { colors, duration, media, size as sizes } from "../lib/tokens.stylex";
import { durations } from "../lib/tokens.values";
import { isIconSize, isInvalid, isThenable, textOf } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { motionVars } from "../lib/vars.stylex";
import { Button } from "./button";
import type { ButtonSize, ButtonVariant } from "./button";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverFooter,
  PopoverTitle,
  createPopoverHandle,
} from "./popover";

/** The words a hold says, so the product can say them in its own language. */
export interface HoldButtonLabels {
  /** The button's name: "Hold to delete draft", from its own words. */
  holdTo: (words: string) => string;
  /** The confirmation's title, from the button's words: "Delete draft?". */
  ask: (words: string) => string;
  /** The confirmation's title when the button has no words. */
  confirm: string;
  /** The confirmation's way out. */
  cancel: string;
}

/** Every prop a HoldButton takes: these, and the rest of a <button>. */
export interface HoldButtonProps extends Omit<
  ComponentProps<"button">,
  "onClick" | "children" | "className" | "style" | "type"
> {
  /**
   * Button's variant: `destructive` for what deletes.
   * @default "default"
   */
  variant?: ButtonVariant;
  /**
   * Button's size; an `icon` size for a button that is only an icon, named by `aria-label`. Named
   * none, Button's own default: `sm` as a direct child of a layer's footer.
   * @default "default"
   */
  size?: ButtonSize;
  /** The words, a verb first ("Delete draft"), with an `<Icon />` if it helps. */
  children: ReactNode;
  /**
   * Runs once a hold completes, or once the confirmation's action is pressed. Left out on a form's
   * submit button, which then sends the form. Return a Promise and the button follows it, as a
   * Button follows its press: busy with a spinner, then a tick or the alert for a moment.
   */
  onConfirm?: () => unknown;
  /** Said while its work runs, and shown in place of its words ("Deleting"). */
  loadingText?: string;
  /** Said once its work is done, and shown in place of its words for a moment ("Deleted"). */
  successText?: string;
  /** Said when its work failed, and shown in place of its words for a moment ("Not deleted"). */
  errorText?: string;
  /**
   * How long the press must last, in milliseconds.
   * @default duration-press-and-hold
   */
  duration?: number;
  /** The words this hold says, any of them replaced. Each left out is the catalogue's (`holdButton`). */
  labels?: Partial<HoldButtonLabels>;
  /**
   * `submit` in a form, which is sent only once held or confirmed.
   * @default "button"
   */
  type?: "button" | "submit";
  /**
   * Out of use: a press starts nothing.
   * @default false
   */
  disabled?: boolean;
  /**
   * Keeps it in the tab order while it cannot be pressed (while its work runs).
   * @default false
   */
  focusableWhenDisabled?: boolean;
  /**
   * What an agent is told before it presses the confirmation's action, which waits for the
   * person's yes.
   * @default the button's words
   */
  agentConfirm?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

// ---- The hold ------------------------------------------------------------------------------------

// A press let go within this share of the hold is a tap, from someone who may not be able to hold:
// it asks. A longer press let go early was a hold that was given up: it does nothing.
const TAP_SHARE = 0.25;

// Kept outside the hook: the React Compiler does not compile a `try` inside one.

/**
 * Waits on what the confirmation started. Its failure is shown and said on the button (useAction);
 * this press is the hold's, not UI SDK's, so nothing else would catch it.
 */
const settled = async (result: unknown) => {
  try {
    await result;
  } catch {
    // Shown by the page: nothing more to do here.
  }
};

/** What the button waits on: the Promise `onConfirm` gave. */
const waitOn = async (work: PromiseLike<unknown>) => await work;

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
  time: number;
  /** False while disabled or working: a press then starts nothing. */
  pressable: boolean;
  /** Runs once a hold completes, or once the confirmation says yes. */
  act: (() => unknown) | undefined;
  /** Runs when a hold starts: the confirmation closes, so the action cannot run twice. */
  onStart: () => void;
}

const useHold = ({ time, pressable, act, onStart }: HoldOptions) => {
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
      }, durations.releaseSwallow);
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
    latest.current.onStart();
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
  // elsewhere (a log that follows its end) do not. Escape cancels it too, and is used up by that:
  // the layer the button stands in stays open. Listened for only while it holds.
  useEffect(() => {
    const escaped = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        giveUpNow();
      }
    };
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
      window.addEventListener("keydown", escaped, { capture: true });
    }
    return () => {
      window.removeEventListener("scroll", scrolled, { capture: true });
      window.removeEventListener("keydown", escaped, { capture: true });
    };
  }, [holding]);

  // Disabled, or working, while held: the hold stops.
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
   * The handlers for the button. Its own click (the popover trigger's, in `theirs`) opens the
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
      onClick: (
        event: MouseEvent<HTMLElement>,
        details?: ButtonActionDetails
      ) => {
        element.current = event.currentTarget;
        if (firing.current) {
          void settled(latest.current.act?.());
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
  return { holding, handlers, handleYes: fire, ref: element };
};

// ---- The look ------------------------------------------------------------------------------------

const FORCED = media.forcedColors;
const REDUCED = media.reducedMotion;

// The hold's styles sit on the element Button draws, beside Button's own. Where they meet Button's
// (its press scale, its hover and press fills), they are keyed to the element's own attributes, so
// they are the more specific rule and win wherever the stylesheet puts them: three attributes beat
// Button's pseudo-classes, which StyleX doubles inside a media query (`.x.x:hover`).
const HELD = ":is([data-holding][data-slot][data-button])";
const ALWAYS = ":is([data-slot][data-button][data-variant])";

const styles = stylex.create({
  // A long press selects no text and opens no callout, and it never shrinks under the press: the
  // fill shows the press. The fill is the button's own layer, so the button's shape, its corner and
  // its size are the fill's, at every size and in a group; it lies over the button's edge and under
  // the sheen and the words. It crosses from the start to the end, at an even pace, in the hold's
  // time; let go, it runs back quickly. In forced colours it is a line at the foot.
  button: {
    "--hold-button-start": { default: "0%", ":dir(rtl)": "100%" },
    WebkitTouchCallout: "none",
    WebkitUserSelect: "none",
    transform: { default: null, [ALWAYS]: "none" },
    "::before": {
      content: '""',
      position: "absolute",
      zIndex: -2,
      inset: 0,
      borderRadius: "inherit",
      cornerShape: "inherit",
      pointerEvents: "none",
      forcedColorAdjust: "none",
      backgroundRepeat: "no-repeat",
      backgroundPosition: "var(--hold-button-start) 100%",
      backgroundSize: {
        default: "0% 100%",
        [FORCED]: `0% ${sizes.lineStrong}`,
      },
      transitionProperty: "background-size",
      // Let go, it runs back; with reduced motion it is simply empty again. While held it fills
      // over the hold's own time even then: it is the timer, as a progress bar is, not a decoration.
      transitionDuration: motionVars.leave,
      transitionTimingFunction: {
        default: duration.ease,
        [REDUCED]: "linear",
      },
    },
  },
  held: {
    "::before": {
      backgroundSize: {
        default: "100% 100%",
        [FORCED]: `100% ${sizes.lineStrong}`,
      },
      transitionDuration: "var(--hold-button-time)",
      transitionTimingFunction: "linear",
    },
  },
  time: (time: string) => ({ "--hold-button-time": time }),
});

// Each variant's look for the hold: ghost and link are bare, with no fill of their own.
const lookOf = (variant: ButtonVariant) =>
  variant === "ghost" || variant === "link" ? "bare" : variant;

// While held, the button keeps its rest fill under the pointer and the press: the fill shows it.
const heldStyles = stylex.create({
  default: { backgroundColor: { default: null, [HELD]: colors.primary } },
  outline: { backgroundColor: { default: null, [HELD]: colors.control } },
  secondary: {
    backgroundColor: { default: null, [HELD]: colors.secondary },
  },
  destructive: {
    backgroundColor: { default: null, [HELD]: colors.destructiveFill },
  },
  success: {
    backgroundColor: { default: null, [HELD]: colors.successFill },
    backgroundPosition: { default: null, [HELD]: sizes.successLightRest },
  },
  bare: { backgroundColor: { default: null, [HELD]: "transparent" } },
});

/** The fill's one colour, as the picture a layer is sized by. */
const flat = (colour: string) => `linear-gradient(${colour}, ${colour})`;

// The fill is the variant's own pressed colour.
const fillStyles = stylex.create({
  default: {
    "::before": {
      backgroundImage: {
        default: flat(colors.primaryActive),
        [FORCED]: flat("Highlight"),
      },
    },
  },
  outline: {
    "::before": {
      backgroundImage: {
        default: flat(colors.controlActive),
        [FORCED]: flat("Highlight"),
      },
    },
  },
  secondary: {
    "::before": {
      backgroundImage: {
        default: flat(colors.secondaryActive),
        [FORCED]: flat("Highlight"),
      },
    },
  },
  destructive: {
    "::before": {
      backgroundImage: {
        default: flat(colors.destructiveHold),
        [FORCED]: flat("Highlight"),
      },
    },
  },
  // The light at its deepest, as a press draws it.
  success: {
    "::before": {
      backgroundImage: {
        default: flat(`oklch(from ${colors.successFill} calc(l - 0.06) c h)`),
        [FORCED]: flat("Highlight"),
      },
    },
  },
  bare: {
    "::before": {
      backgroundImage: {
        default: flat(colors.accentActive),
        [FORCED]: flat("Highlight"),
      },
    },
  },
});

// ---- The parts -------------------------------------------------------------------------------------

/** What the confirmation says: the button's words, or its label when it is only an icon. */
const wordsOrLabel = (children: ReactNode, label: string | undefined) => {
  const text = textOf(children).trim();
  if (text !== "") {
    return text;
  }
  return label === "" ? undefined : label;
};

/** The handlers among a set of props, and the rest. */
const splitHandlers = (props: Record<string, unknown>) => {
  const handlers: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (/^on[A-Z]/u.test(key)) {
      handlers[key] = value;
    } else {
      rest[key] = value;
    }
  }
  return { handlers, rest };
};

export const HoldButton = ({
  variant = "default",
  size,
  children,
  onConfirm,
  loadingText,
  successText,
  errorText,
  duration: time = durations.pressAndHold,
  labels: given,
  type = "button",
  disabled = false,
  focusableWhenDisabled = false,
  agentConfirm,
  style,
  ref: callerRef,
  ...rest
}: HoldButtonProps) => {
  const labels = { ...useI18n().holdButton, ...given };
  const words = wordsOrLabel(children, rest["aria-label"]);
  // The work a confirmed press starts, followed as a Button follows its own press.
  const action = useAction(waitOn, { loadingText, successText, errorText });
  const busy = action.status === "loading" || isInvalid(rest["aria-busy"]);
  // While it works or shows how it went, its words (or the state's) name it, not "Hold to …".
  const resting = action.status === "idle" && !busy;
  // oxlint-disable-next-line react/hook-use-state -- made once, never set
  const [handle] = useState(() => createPopoverHandle());
  const pressing = useHold({
    time,
    pressable: !(disabled || busy),
    act:
      onConfirm === undefined
        ? undefined
        : () => {
            const result = onConfirm();
            return isThenable(result) ? action.run(result) : result;
          },
    // A hold while the confirmation is open closes it, so its yes cannot run the action again.
    onStart: () => {
      if (handle.isOpen?.()) {
        handle.close();
      }
    },
  });
  // Its name says how to press it, while it is not working: "Hold to delete draft".
  const name =
    !resting || words === undefined ? rest["aria-label"] : labels.holdTo(words);
  // The confirmation's action says the button's own words, destructive for a destructive button,
  // and an agent always needs the person's yes to press it.
  const said = words ?? labels.confirm;
  return (
    <Popover handle={handle}>
      <TriggerPrimitive
        disabled={disabled}
        render={(trigger: Record<string, unknown>) => {
          // One element takes the trigger's ref, the caller's and the hold's. The caller's props win
          // over the trigger's. The handlers go on the element Button draws, the hold's first: they
          // call the trigger's and the caller's themselves.
          const merged: Record<string, unknown> = mergeProps(
            trigger,
            rest,
            { ref: callerRef },
            { ref: pressing.ref }
          );
          const { handlers: theirs, rest: face } = splitHandlers(merged);
          return (
            <Button
              {...face}
              data-slot="hold-button"
              data-holding={pressing.holding ? "" : undefined}
              variant={variant}
              {...(isIconSize(size)
                ? { size, "aria-label": name ?? "" }
                : { size, "aria-label": name })}
              disabled={disabled}
              focusableWhenDisabled={focusableWhenDisabled}
              status={action.status}
              loadingText={loadingText}
              successText={successText}
              errorText={errorText}
              style={style}
              asChild
            >
              <button
                type={type === "submit" ? "submit" : "button"}
                {...pressing.handlers(theirs)}
                {...stylex.props(
                  styles.button,
                  heldStyles[lookOf(variant)],
                  fillStyles[lookOf(variant)],
                  pressing.holding && styles.held,
                  pressing.holding && styles.time(`${time}ms`)
                )}
              >
                {children}
              </button>
            </Button>
          );
        }}
      />
      <PopoverContent>
        <PopoverTitle>
          {words === undefined ? labels.confirm : labels.ask(words)}
        </PopoverTitle>
        <PopoverFooter>
          <PopoverClose asChild>
            <Button variant="outline" size="sm">
              {labels.cancel}
            </Button>
          </PopoverClose>
          {/* It only says yes: the work and its result show on the button, where focus returns. */}
          <PopoverClose asChild onClick={pressing.handleYes}>
            <Button
              variant={variant === "destructive" ? "destructive" : "success"}
              size="sm"
              agentConfirm={agentConfirm ?? said}
            >
              {said}
            </Button>
          </PopoverClose>
        </PopoverFooter>
      </PopoverContent>
    </Popover>
  );
};
