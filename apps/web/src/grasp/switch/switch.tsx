// Switch: Grasp's switch, from shadcn's (registry/bases/base/ui/switch.tsx, on Base UI), converted
// from Tailwind to StyleX and rebuilt on UI SDK's Switch, which draws a button with the switch role
// beside a hidden native input, so a form sends it and an agent can turn it on by name. Grasp's
// adds the label and a description, a row at least 44px tall that a press beside the words turns,
// and the life of a setting that saves at once: working while it saves, failed if it could not.
//
// It moves as Apple's does, as measured on iOS 27 in the simulator, frame by frame: the
// thumb is a pill with a soft shadow; pressed, it stretches towards the side it will travel to; it
// travels on a spring, can be stopped and turned back mid-way, and can be dragged, the release
// deciding the side. The green crosses with the travel, and is Approve's: mint deepened towards pine,
// with its bevel. Inside it a light rests behind the thumb and follows it a little later, leaning in
// under a pointer as Approve's does. Only transform and opacity move; with reduced motion, nothing does.
//
//   <Switch label="Weekly summary" />
//   <Switch label="Weekly summary" description="The week's changes, every Monday morning." />
//   <Switch label="Weekly summary" onSave={saveSetting} failedLabel="Could not save" />
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  Switch as SwitchPrimitive,
  SwitchThumb,
  createSwitchController,
} from "@ui-sdk/react/switch";
import { useEffect, useId, useReducer, useRef, useState } from "react";
import type {
  ComponentProps,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";

import { announce } from "../announce/announce";
import { ChoiceRow, reachStyles } from "../choice/choice";
import type { ChoiceWiring } from "../choice/choice";
import { choiceMarker } from "../choice/choice.stylex";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { Icon, Spinner } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

/** Where a switch's save is: at rest, saving, or failed to save. */
export type SaveState = "idle" | "working" | "failed";

/** What a caller may style: where the switch sits. Never its look. */
export type SwitchLayoutStyle = LayoutStyle;

type SwitchPrimitiveProps = ComponentProps<typeof SwitchPrimitive>;

/** What `onCheckedChange` is called with: the new state, and why it changed. */
export type SwitchChange = NonNullable<SwitchPrimitiveProps["onCheckedChange"]>;

/** What every switch takes, besides UI SDK's own options. */
interface SwitchBase {
  /**
   * Its name: the setting, in sentence case, the same whether it is on or off ("Weekly
   * summary"). A screen reader and an agent find it by these words.
   */
  label: ReactNode;
  /**
   * Draws the switch alone, its label not shown: where something beside it already names it, as a
   * Setting row does. A screen reader still hears its name once: from the caller's `<label for>`
   * when an `id` is given (a Setting row's `field`), else from the label, kept as hidden words.
   * @default false
   */
  labelHidden?: boolean;
  /** One sentence under the label: what turning it on does. A screen reader says it after the name. */
  description?: ReactNode;
  /** On now, for a switch your code holds. Pass `onCheckedChange` with it. */
  checked?: boolean;
  /**
   * On at first, when the switch holds its own state. A form reset returns to it.
   * @default false
   */
  defaultChecked?: boolean;
  /**
   * Runs when it turns on or off, with the new state and why (`details.reason`,
   * `details.source`). With `onSave`, only once the save worked. `details.cancel()` refuses it.
   */
  onCheckedChange?: SwitchChange;
  /**
   * Out of use: no press, no focus, half strength, and not sent with a form. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /**
   * Shown as it is and still sent, but a press does not change it: a setting someone else owns.
   * @default false
   */
  readOnly?: boolean;
  /** @deprecated Use `layout`. */
  style?: SwitchLayoutStyle;
  /** Layout only: margins and alignment. The look belongs to the switch. */
  layout?: SwitchLayoutStyle;
}

/** A switch whose setting your code saves elsewhere, or a form sends. */
interface WithoutSave {
  onSave?: undefined;
  failedLabel?: never;
  status?: never;
  /** @deprecated Use `status`. */
  state?: never;
}

/**
 * A switch that saves its setting as it turns: it holds still with a spinner while it saves,
 * turns once the save worked, and says so in words when it failed.
 */
interface WithSave {
  /** Saves the new setting. The switch turns when its promise resolves; a rejection is a failure. */
  onSave: (checked: boolean) => Promise<unknown>;
  /** What did not happen, said under the label and to a screen reader ("Could not save"). */
  failedLabel: string;
  /**
   * Where the save is: `idle`, `working` or `failed`. Leave it out: `onSave` keeps it. Set it to
   * show one state standing still.
   */
  status?: SaveState;
  /** @deprecated Use `status`. */
  state?: SaveState;
}

/** Every prop a Switch takes: the ones above, and the rest of UI SDK's Switch and a <button>. */
export type SwitchProps = SwitchBase &
  (WithoutSave | WithSave) &
  Omit<
    SwitchPrimitiveProps,
    | keyof SwitchBase
    | "className"
    | "children"
    | "render"
    | "aria-label"
    | "aria-labelledby"
  >;

// ---- The look --------------------------------------------------------------------------------------

const HOVER = media.hover;
const REDUCED = media.reduced;
const FORCED = media.forced;

// How far the thumb travels: the track, less the thumb, less the inset at both ends.
const INSET = `calc((${grasp.switchHeight} - ${grasp.switchThumb}) / 2)`;
const TRAVEL = `calc(${grasp.switchWidth} - ${grasp.switchThumbWidth} - 2 * ${INSET})`;
// A move shorter than this is a tap, not a drag.
const SLOP = 3;

const spin = stylex.keyframes({
  from: { transform: "rotate(0turn)" },
  to: { transform: "rotate(1turn)" },
});
const breathe = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.4 },
});

const styles = stylex.create({
  // The switch alone (labelHidden): only its control, on the line it stands in.
  alone: {
    display: "inline-flex",
    alignItems: "center",
    verticalAlign: "middle",
  },
  control: {
    appearance: "none",
    display: "grid",
    boxSizing: "border-box",
    width: grasp.switchWidth,
    height: grasp.switchHeight,
    margin: 0,
    marginTop: `calc((${grasp.textSmLine} - ${grasp.switchHeight}) / 2)`,
    padding: 0,
    borderWidth: 0,
    borderRadius: grasp.cornerPill,
    backgroundColor: "transparent",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    cursor: "pointer",
  },
  disabled: { opacity: grasp.dim, cursor: "not-allowed" },
  still: { cursor: "default" },
  busy: { cursor: "progress" },

  // The track. Off is its own soft grey; on is a layer of Approve's green over it, which fades in
  // with the travel. A press scales it from the end the thumb is at.
  track: {
    position: "relative",
    isolation: "isolate",
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    padding: INSET,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: "inherit",
    backgroundColor: grasp.switchTrack,
    // Vertical scrolling stays with the page; a sideways move is a drag.
    touchAction: "pan-y",
    transformOrigin: { default: "0% 50%", ":dir(rtl)": "100% 50%" },
    transitionProperty: "transform, background-color, box-shadow",
    transitionDuration: `${simply.press}, ${grasp.durationHover}, ${grasp.durationHover}`,
    transitionTimingFunction: grasp.ease,
  },
  trackAtEnd: {
    transformOrigin: { default: "100% 50%", ":dir(rtl)": "0% 50%" },
  },
  offLive: {
    backgroundColor: {
      default: grasp.switchTrack,
      [stylex.when.ancestor(":hover", choiceMarker)]: {
        default: null,
        [HOVER]: grasp.switchTrackHover,
      },
      [stylex.when.ancestor(":active", choiceMarker)]: grasp.switchTrackHover,
    },
  },
  pressable: {
    transform: {
      default: null,
      [stylex.when.ancestor(":active", choiceMarker)]:
        `scale(${grasp.pressScale})`,
    },
  },
  failed: { boxShadow: grasp.failedEdge },
  // In forced colours the green is hidden, so on is the system's Highlight fill, as a toggle there
  // is: on and off then differ by more than the thumb's side.
  trackOnForced: {
    backgroundColor: { default: null, [FORCED]: "Highlight" },
    borderColor: { default: null, [FORCED]: "Highlight" },
  },

  // On: Approve's green, mint deepened towards pine, its light at the top and its bevel inside.
  green: {
    position: "absolute",
    inset: 0,
    zIndex: 0,
    overflow: "hidden",
    borderRadius: "inherit",
    backgroundColor: grasp.approveFill,
    backgroundImage: grasp.approveLight,
    backgroundSize: grasp.approveLightSize,
    backgroundPosition: grasp.approveLightRest,
    boxShadow: grasp.bevelApproveFace,
    opacity: 0,
    pointerEvents: "none",
    // It crosses with the thumb's travel, not after it.
    transitionProperty: "opacity",
    transitionDuration: simply.travel,
    transitionTimingFunction: grasp.ease,
    display: { default: "block", [FORCED]: "none" },
  },
  greenShown: { opacity: 1 },
  greenFailed: { boxShadow: grasp.failedEdge },
  sheen: {
    position: "absolute",
    inset: 0,
    borderRadius: "inherit",
    backgroundImage: `linear-gradient(${grasp.sheen}, transparent)`,
    opacity: 0.6,
    transitionProperty: "opacity",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
  },
  sheenLive: {
    opacity: {
      default: 0.6,
      [stylex.when.ancestor(":hover", choiceMarker)]: {
        default: null,
        [HOVER]: 1,
      },
      [stylex.when.ancestor(":active", choiceMarker)]: 0.3,
    },
  },

  // Mirrors its contents in right to left, so a light or a stretch runs the other way.
  mirror: {
    position: "absolute",
    inset: 0,
    transform: { default: null, ":dir(rtl)": "scaleX(-1)" },
  },

  // The light. It rests behind the thumb, follows it on the spring a little later than
  // the thumb arrives, leans in under a pointer and draws back under a press, as Approve's light.
  light: {
    position: "absolute",
    top: "-50%",
    left: 0,
    width: "100%",
    height: "200%",
    backgroundImage: grasp.switchLight,
    mixBlendMode: "screen",
    opacity: 0.7,
    transform: "translateX(-75%)",
    transitionProperty: "transform",
    transitionDuration: simply.trail,
    transitionTimingFunction: grasp.switchSpring,
  },
  lightOn: {
    transform: "translateX(18%)",
  },
  lightLive: {
    transform: {
      default: "translateX(18%)",
      [stylex.when.ancestor(":hover", choiceMarker)]: {
        default: null,
        [HOVER]: "translateX(26%)",
      },
      [stylex.when.ancestor(":active", choiceMarker)]: "translateX(10%)",
    },
  },
  lightAt: (x: string) => ({ transform: x, transitionDuration: "0s" }),

  // The thumb: a pill with a soft shadow round its whole shape. It travels on the spring.
  thumb: {
    [iconVars.size]: `calc(${grasp.switchThumb} - ${grasp.space1})`,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    zIndex: 1,
    flexShrink: 0,
    width: grasp.switchThumbWidth,
    height: grasp.switchThumb,
    color: { default: grasp.muted, [FORCED]: "Canvas" },
    filter: { default: grasp.switchThumbShadow, [FORCED]: "none" },
    transitionProperty: "transform",
    transitionDuration: simply.travel,
    transitionTimingFunction: grasp.switchSpring,
  },
  thumbOn: {
    color: { default: grasp.approveFill, [FORCED]: "Highlight" },
    transform: {
      default: `translateX(${TRAVEL})`,
      ":dir(rtl)": `translateX(calc(-1 * ${TRAVEL}))`,
    },
  },
  thumbAt: (x: string) => ({ transform: x, transitionDuration: "0s" }),
  // The pill, and a second pill of the same size behind it that slides out to stretch it. Two
  // pills of one height make one longer pill, so the ends never squash.
  pill: {
    position: "absolute",
    inset: 0,
    borderRadius: grasp.cornerPill,
    backgroundColor: { default: grasp.onFill, [FORCED]: "CanvasText" },
  },
  pillOnForced: {
    backgroundColor: { default: grasp.onFill, [FORCED]: "HighlightText" },
  },
  stretch: {
    transform: "translateX(0)",
    // Back on the spring, so the trailing end catches up and settles.
    transitionProperty: "transform",
    transitionDuration: simply.travel,
    transitionTimingFunction: grasp.switchSpring,
  },
  stretchLiveEnd: {
    transform: {
      default: null,
      [stylex.when.ancestor(":active", choiceMarker)]:
        `translateX(${grasp.switchStretch})`,
    },
    transitionDuration: {
      default: null,
      [stylex.when.ancestor(":active", choiceMarker)]: simply.press,
    },
    transitionTimingFunction: {
      default: null,
      [stylex.when.ancestor(":active", choiceMarker)]: grasp.ease,
    },
  },
  stretchLiveStart: {
    transform: {
      default: null,
      [stylex.when.ancestor(":active", choiceMarker)]:
        `translateX(calc(-1 * ${grasp.switchStretch}))`,
    },
    transitionDuration: {
      default: null,
      [stylex.when.ancestor(":active", choiceMarker)]: simply.press,
    },
    transitionTimingFunction: {
      default: null,
      [stylex.when.ancestor(":active", choiceMarker)]: grasp.ease,
    },
  },
  // While dragged: stretched towards the side it would land on, and less as it nears that end, so
  // it is back to its own width when it arrives and never leaves the track.
  stretchedAt: (x: string) => ({
    transform: x,
    transitionDuration: simply.press,
    transitionTimingFunction: grasp.ease,
  }),
  spinner: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
  },
  turning: {
    display: "grid",
    animationName: { default: spin, [REDUCED]: breathe },
    animationDuration: {
      default: grasp.durationSpin,
      [REDUCED]: `calc(${grasp.durationSpin} * 2)`,
    },
    animationTimingFunction: { default: "linear", [REDUCED]: grasp.easeInOut },
    animationIterationCount: "infinite",
  },
});

// ---- The save --------------------------------------------------------------------------------------

type Controller = ReturnType<typeof createSwitchController>;

/** Keeps the switch's own controller: made once, never replaced. */
const keepController = (controller: Controller): Controller => controller;

/** Whether a save worked: its promise resolved. Out here, so the component holds no try. */
const saved = async (save: Promise<unknown>): Promise<boolean> => {
  try {
    await save;
    return true;
  } catch {
    return false;
  }
};

// ---- The drag --------------------------------------------------------------------------------------

/** A pointer holding the thumb: where it started, and where the thumb is now. */
interface Drag {
  id: number;
  from: number;
  base: number;
  x: number;
  travel: number;
  stretch: number;
  dir: 1 | -1;
  scale: number;
  moved: boolean;
  checked: boolean;
}

/** Where the thumb is drawn while dragged: px from the off end, with what is needed to draw it. */
interface Held {
  x: number;
  travel: number;
  stretch: number;
  dir: 1 | -1;
}

const pixels = (value: string): number => {
  const number = Number(value.trim().replace(/px$/u, ""));
  return Number.isNaN(number) ? 0 : number;
};

// Where the thumb would be for this pointer, in px from the off end; null until it is a drag.
const place = (held: Drag, clientX: number): number | null => {
  const moved = ((clientX - held.from) * held.dir) / held.scale;
  if (!held.moved && Math.abs(moved) < SLOP) {
    return null;
  }
  held.moved = true;
  return Math.min(held.travel, Math.max(0, held.base + moved));
};

// Pointer distances are on the screen; the travel is in the switch's own pixels. They differ when
// something round the switch is scaled.
const scaleOf = (control: HTMLElement | null): number => {
  if (control === null || control.offsetWidth === 0) {
    return 1;
  }
  const scale = control.getBoundingClientRect().width / control.offsetWidth;
  return scale > 0 ? scale : 1;
};

/** The drag: the thumb follows a pointer, and the release decides the side. */
const useDrag = (controller: Controller) => {
  const trackRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<Drag | null>(null);
  // A drag ends with a click on the button; that click must not turn it again.
  const swallow = useRef(false);
  const [at, setAt] = useState<Held | null>(null);

  const handlePointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const room = trackRef.current;
    const pill =
      room?.querySelector<HTMLElement>("[data-slot=switch-thumb]") ?? null;
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      room === null ||
      pill === null
    ) {
      return;
    }
    const style = getComputedStyle(room);
    const travel =
      room.offsetWidth -
      pill.offsetWidth -
      2 * pixels(style.paddingInlineStart);
    const checked = controller.getChecked();
    drag.current = {
      id: event.pointerId,
      from: event.clientX,
      base: checked ? travel : 0,
      x: checked ? travel : 0,
      travel,
      stretch: pixels(style.getPropertyValue("--grasp-switch-stretch")),
      dir: style.direction === "rtl" ? -1 : 1,
      scale: scaleOf(room.parentElement),
      moved: false,
      checked,
    };
    room.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const held = drag.current;
    if (held === null || held.id !== event.pointerId) {
      return;
    }
    const x = place(held, event.clientX);
    if (x === null) {
      return;
    }
    held.x = x;
    setAt({ x, travel: held.travel, stretch: held.stretch, dir: held.dir });
  };
  const handlePointerUp = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const held = drag.current;
    drag.current = null;
    setAt(null);
    if (held === null || held.id !== event.pointerId || !held.moved) {
      return;
    }
    // A release after a drag decides by where the thumb is. The click that follows is swallowed,
    // so it does not turn the switch a second time.
    swallow.current = true;
    setTimeout(() => {
      swallow.current = false;
    }, 0);
    const next = held.x > held.travel / 2;
    if (next !== held.checked) {
      controller.setChecked(next, { reason: "press" });
    }
  };
  const handlePointerCancel = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (drag.current?.id !== event.pointerId) {
      return;
    }
    drag.current = null;
    setAt(null);
  };
  const handleClickCapture = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!swallow.current) {
      return;
    }
    swallow.current = false;
    event.preventDefault();
  };
  return {
    trackRef,
    at,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handleClickCapture,
  };
};

// Where it would land: while dragged, the side the thumb is on; else its own side.
const sideOf = (at: Held | null, checked: boolean): boolean =>
  at === null ? checked : at.x > at.travel / 2;

// How far across the thumb is, from 0 (off) to 1 (on).
const progressOf = (at: Held | null, checked: boolean): number => {
  if (at !== null) {
    return at.x / at.travel;
  }
  return checked ? 1 : 0;
};

// While dragged, the stretch shrinks as the thumb nears the end it would land on, and never
// leaves the track. Negative towards the start.
const reachOf = (at: Held | null, towardsEnd: boolean): number => {
  if (at === null) {
    return 0;
  }
  return towardsEnd
    ? Math.min(at.stretch, at.travel - at.x)
    : -Math.min(at.stretch, at.x);
};

// ---- The parts ---------------------------------------------------------------------------------------

interface GreenProps {
  checked: boolean;
  live: boolean;
  failed: boolean;
  at: Held | null;
}

/** Approve's green, which fades in with the travel, and the light inside it. */
const Green = ({ checked, live, failed, at }: GreenProps) => {
  const shown = sideOf(at, checked);
  const settled = live && checked && at === null;
  const lit = live && shown;
  return (
    <span
      data-slot="switch-green"
      {...stylex.props(
        styles.green,
        shown && styles.greenShown,
        failed && styles.greenFailed
      )}
    >
      <span {...stylex.props(styles.sheen, lit && styles.sheenLive)} />
      <span {...stylex.props(styles.mirror)}>
        <span
          data-slot="switch-light"
          {...stylex.props(
            styles.light,
            checked && styles.lightOn,
            settled && styles.lightLive,
            at !== null &&
              styles.lightAt(
                `translateX(${-75 + 93 * progressOf(at, checked)}%)`
              )
          )}
        />
      </span>
    </span>
  );
};

interface ThumbProps {
  checked: boolean;
  live: boolean;
  working: boolean;
  at: Held | null;
}

/** The thumb: a pill, and a second pill behind it that slides out to stretch it. */
const Thumb = ({ checked, live, working, at }: ThumbProps) => {
  // The side a press stretches towards: where it will travel to.
  const towardsEnd = at === null ? !checked : sideOf(at, checked);
  const stretchLive = towardsEnd
    ? styles.stretchLiveEnd
    : styles.stretchLiveStart;
  const pressable = live && at === null;
  const shown = sideOf(at, checked);
  return (
    <SwitchThumb
      data-slot="switch-thumb"
      {...stylex.props(
        styles.thumb,
        checked && styles.thumbOn,
        at !== null && styles.thumbAt(`translateX(${at.x * at.dir}px)`)
      )}
    >
      <span {...stylex.props(styles.mirror)}>
        <span
          data-slot="switch-stretch"
          {...stylex.props(
            styles.pill,
            styles.stretch,
            pressable && stretchLive,
            at !== null &&
              styles.stretchedAt(`translateX(${reachOf(at, towardsEnd)}px)`),
            shown && styles.pillOnForced
          )}
        />
        <span {...stylex.props(styles.pill, shown && styles.pillOnForced)} />
      </span>
      {working && (
        <span {...stylex.props(styles.spinner)}>
          <span {...stylex.props(styles.turning)}>
            <Icon icon={Spinner} />
          </span>
        </span>
      )}
    </SwitchThumb>
  );
};

interface TrackProps {
  checked: boolean;
  live: boolean;
  working: boolean;
  failed: boolean;
  drag: Omit<ReturnType<typeof useDrag>, "handleClickCapture">;
}

/** The track, which a pointer can drag the thumb along. */
const Track = ({ checked, live, working, failed, drag }: TrackProps) => {
  const {
    trackRef,
    at,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
  } = drag;
  const hoverable = live && !checked;
  return (
    <span
      ref={trackRef}
      aria-hidden="true"
      data-slot="switch-track"
      onPointerDown={live ? handlePointerDown : undefined}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
      {...stylex.props(
        styles.track,
        checked && styles.trackAtEnd,
        hoverable && styles.offLive,
        sideOf(at, checked) && styles.trackOnForced,
        live && styles.pressable,
        failed && styles.failed
      )}
    >
      <Green checked={checked} live={live} failed={failed} at={at} />
      <Thumb checked={checked} live={live} working={working} at={at} />
    </span>
  );
};

export const Switch = (allProps: SwitchProps) => {
  // SAFETY: SwitchProps is this shape in each of its two branches; the cast lets one destructure
  // read the save props, which are undefined in the branch without a save.
  const {
    label,
    labelHidden = false,
    description,
    style: styleProp,
    layout,
    id,
    onSave,
    failedLabel,
    status,
    state: stateDeprecated,
    onCheckedChange,
    controller: given,
    ...rest
  } = allProps as SwitchBase &
    Omit<
      SwitchPrimitiveProps,
      keyof SwitchBase | "className" | "children" | "render"
    > & {
      onSave?: (checked: boolean) => Promise<unknown>;
      failedLabel?: string;
      status?: SaveState;
      state?: SaveState;
    };
  // The new name wins over the old one (the breaking release's step 1).
  const state = status ?? stateDeprecated;
  const own = useId();
  const box = id ?? `switch${own}`;
  const [made] = useReducer(keepController, undefined, createSwitchController);
  const controller = given ?? made;
  const [saving, setSaving] = useState<SaveState>("idle");
  const life = state ?? saving;
  // Set while the switch turns itself once a save worked, so that turn is let through.
  const committing = useRef(false);
  // The save in flight, by number: a press while one runs does nothing (read at once, not from the
  // last render, so three presses in one moment still start one save), and a reset or leaving the
  // page makes a late answer count for nothing.
  const run = useRef(0);
  const running = useRef(false);
  useEffect(
    () => () => {
      run.current += 1;
    },
    []
  );
  const { handleClickCapture, ...drag } = useDrag(controller);

  const save = async (
    saveSetting: (checked: boolean) => Promise<unknown>,
    next: boolean
  ) => {
    running.current = true;
    run.current += 1;
    const mine = run.current;
    setSaving("working");
    const worked = await saved(saveSetting(next));
    if (mine !== run.current) {
      return;
    }
    running.current = false;
    if (worked) {
      setSaving("idle");
      committing.current = true;
      controller.setChecked(next, { reason: "imperative" });
      committing.current = false;
      return;
    }
    setSaving("failed");
    if (failedLabel !== undefined && failedLabel !== "") {
      announce(failedLabel);
    }
  };

  const handleCheckedChange: SwitchChange = (next, details) => {
    if (committing.current || onSave === undefined) {
      onCheckedChange?.(next, details);
      return;
    }
    if (details.reason === "reset" || details.reason === "restore") {
      // A reset puts the setting back where the page started and saves nothing; a save in flight
      // no longer counts, and a failure no longer stands.
      run.current += 1;
      running.current = false;
      setSaving("idle");
      onCheckedChange?.(next, details);
      return;
    }
    // It turns only once the save worked; a press while it saves does nothing. With `state`
    // given, the switch shows that state standing still and saves nothing.
    details.cancel();
    if (running.current || state !== undefined) {
      return;
    }
    void save(onSave, next);
  };

  // The control itself: in the choice row with its words, or alone with labelHidden.
  const control = (wiring: Partial<ChoiceWiring>) => (
    <SwitchPrimitive
      {...rest}
      {...wiring}
      id={box}
      aria-busy={life === "working" || undefined}
      data-state={life === "idle" ? undefined : life}
      controller={controller}
      onCheckedChange={handleCheckedChange}
      onClickCapture={handleClickCapture}
      className={(on) => {
        const still = on.readOnly && !on.disabled;
        const busy = life === "working" && !on.disabled;
        const look = stylex.props(
          styles.control,
          on.disabled && styles.disabled,
          still && styles.still,
          busy && styles.busy,
          focus.mark
        );
        return look.className ?? "";
      }}
    >
      {(on) => (
        <>
          <span
            aria-hidden="true"
            data-slot="switch-reach"
            {...stylex.props(reachStyles.reach)}
          />
          <Track
            checked={on.checked}
            live={!(on.disabled || on.readOnly || life === "working")}
            working={life === "working"}
            failed={life === "failed"}
            drag={drag}
          />
        </>
      )}
    </SwitchPrimitive>
  );

  if (labelHidden) {
    // Named by the caller's <label for={id}> when it gives the id, else by the label as hidden words.
    const nameId = `${box}-name`;
    const named = id === undefined;
    return (
      <span
        data-slot="switch"
        data-label="hidden"
        {...stylex.props(styles.alone, layout ?? styleProp)}
      >
        {named && (
          <span id={nameId} {...stylex.props(visuallyHidden)}>
            {label}
          </span>
        )}
        {control({
          ...(named ? { "aria-labelledby": nameId } : {}),
          ...(life === "failed" ? { "aria-invalid": true } : {}),
        })}
      </span>
    );
  }

  return (
    // A failed save makes the field wrong, so the words under the label describe the switch and
    // it says `aria-invalid`, for a screen reader and an agent alike.
    <ChoiceRow
      box={box}
      label={label}
      description={description}
      error={failedLabel}
      invalid={life === "failed" || undefined}
      disabled={rest.disabled}
      end
      layout={[layout ?? styleProp]}
    >
      {control}
    </ChoiceRow>
  );
};
