// Switch: turns a setting on or off at once,
// in StyleX, built on UI SDK's Switch, which draws a button with
// the switch role beside a hidden native input, so a form sends it and an agent can turn it on by
// name. It draws itself only; its words are Field's parts, on a row at least 44px tall that a press
// on the switch, its label or the space around them turns:
//
//   <Field orientation="horizontal">
//     <FieldContent>
//       <FieldLabel>Weekly summary</FieldLabel>
//       <FieldDescription>The week's changes, every Monday morning.</FieldDescription>
//     </FieldContent>
//     <Switch onSave={saveSetting} />
//   </Field>
//
// With `onSave` it is a setting that saves as it turns: it holds still with a spinner while it
// saves (`loading`), turns once the save worked, and says its `errorText` in the row, under the
// words, when it failed (`error`). Where something beside it already names it,
// `<Switch aria-label="Weekly summary" />` alone.
//
// It moves as Apple's does, as measured on iOS 27 in the simulator, frame by frame: the thumb is a
// pill with a soft shadow; pressed, it stretches towards the side it will travel to; it travels on
// a spring, can be stopped and turned back mid-way, and can be dragged, the release deciding the
// side. The success green crosses with the travel, with its bevel. Inside it a light rests behind
// the thumb and follows it a little later, leaning in under a pointer. Only transform and opacity
// move; with reduced motion, nothing does.
//
// A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Switch as SwitchPrimitive,
  SwitchThumb,
  createSwitchController,
} from "@ui-sdk/react/switch";
import type { SwitchState } from "@ui-sdk/react/switch";
import { useEffect, useReducer, useRef, useState } from "react";
import type {
  ComponentProps,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import type { ActionStatus } from "../hooks/use-action";
import { useI18n } from "../lib/i18n";
import { Icon, LoaderIcon } from "../lib/icons";
import { choiceHitArea, focusRingOffset } from "../lib/styles";
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
import { announce, className } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { fieldControlMarker, iconVars, motionVars } from "../lib/vars.stylex";
import { FieldError, useFieldControl } from "./field";

type SwitchPrimitiveProps = ComponentProps<typeof SwitchPrimitive>;

/** What every switch takes, besides UI SDK's own options. */
interface SwitchBase {
  /**
   * Its name, when no FieldLabel names it: where something beside it already says what it turns
   * ("Weekly summary"). A screen reader and an agent find it by these words.
   */
  "aria-label"?: string;
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
  onCheckedChange?: SwitchPrimitiveProps["onCheckedChange"];
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
  /** Layout only: margins and alignment. The look belongs to the switch. */
  style?: LayoutStyle;
}

/** A switch whose setting your code saves elsewhere, or a form sends. */
interface WithoutSave {
  onSave?: undefined;
  errorText?: never;
  status?: never;
}

/**
 * A switch that saves its setting as it turns: it holds still with a spinner while it saves,
 * turns once the save worked, and says so in words when it failed.
 * @when with onSave
 */
interface WithSave {
  /** Saves the new setting. The switch turns when its promise resolves; a rejection is a failure. */
  onSave: (checked: boolean) => Promise<unknown>;
  /**
   * What did not happen, said under the label and to a screen reader.
   * @default "Could not save"
   */
  errorText?: string;
  /**
   * Where the save is: `idle`, `loading`, `success` (at rest, turned) or `error`. Leave it out:
   * `onSave` keeps it. Set it to show one state standing still.
   */
  status?: ActionStatus;
}

/** Every prop a Switch takes: the ones above, and the rest of UI SDK's Switch and a <button>. */
export type SwitchProps = SwitchBase &
  (WithoutSave | WithSave) &
  Omit<
    SwitchPrimitiveProps,
    keyof SwitchBase | "className" | "children" | "render" | "aria-labelledby"
  >;

// ---- The look -----------------------------------------------------------------------------------
//
// A pointer anywhere on its horizontal Field's row lights and presses the switch: the row is the
// nearest Field marked with fieldControlMarker whose orientation is horizontal, read through
// stylex.when.ancestor. Each call is written inline in its style: one hoisted into a constant
// stays in the built module and throws there, as StyleX only compiles it inside stylex.create.

const HOVER = media.hover;
const REDUCED = media.reducedMotion;
const FORCED = media.forcedColors;

// How far the thumb travels: the track, less the thumb, less the inset at both ends.
const INSET = `calc((${size.switchHeight} - ${size.switchThumb}) / 2)`;
const TRAVEL = `calc(${size.switchWidth} - ${size.switchThumbWidth} - 2 * ${INSET})`;
// A move shorter than this is a tap, not a drag.
const SLOP = 3;
// How far a press stretches the thumb, read from the page while dragging (size.switchStretch).
const STRETCH = "--damsko-switch-stretch";

const spin = stylex.keyframes({
  from: { transform: "rotate(0turn)" },
  to: { transform: "rotate(1turn)" },
});
const breathe = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.4 },
});

const styles = stylex.create({
  // In a horizontal Field: the switch stands beside the words and the failure under them, so the
  // words' height alone sets where the failure starts.
  inRow: {
    gridRow: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal])",
        fieldControlMarker
      )]: "span 2",
    },
  },
  // A failed save's words: in a horizontal Field under the row's words (the switch comes after
  // them), in their column, the words' own gap above; in any other Field, the Field's own error.
  failure: {
    display: {
      default: "contents",
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal])",
        fieldControlMarker
      )]: "block",
    },
    gridRow: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal])",
        fieldControlMarker
      )]: 2,
    },
    gridColumn: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal])",
        fieldControlMarker
      )]: 1,
    },
    marginTop: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal])",
        fieldControlMarker
      )]: space[1],
    },
    minWidth: 0,
  },
  // The switch outside a Field, named by `aria-label`: on the line it stands in.
  alone: {
    position: "relative",
    isolation: "isolate",
    display: "inline-flex",
    alignItems: "center",
    verticalAlign: "middle",
  },
  control: {
    appearance: "none",
    display: "grid",
    boxSizing: "border-box",
    width: size.switchWidth,
    height: size.switchHeight,
    margin: 0,
    marginTop: `calc((${font.textSmLine} - ${size.switchHeight}) / 2)`,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: "transparent",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    cursor: "pointer",
  },
  disabled: { opacity: size.opacityDisabled, cursor: "not-allowed" },
  still: { cursor: "default" },
  busy: { cursor: "progress" },
  // The track. Off is its own soft grey; on is a layer of the success green over it, which fades
  // in with the travel. A press scales it from the end the thumb is at.
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
    backgroundColor: colors.switchTrack,
    // Vertical scrolling stays with the page; a sideways move is a drag.
    touchAction: "pan-y",
    transformOrigin: { default: "0% 50%", ":dir(rtl)": "100% 50%" },
    transitionProperty: "transform, background-color, box-shadow",
    transitionDuration: `${motionVars.press}, ${duration.hover}, ${duration.hover}`,
    transitionTimingFunction: duration.ease,
  },
  trackAtEnd: {
    transformOrigin: { default: "100% 50%", ":dir(rtl)": "0% 50%" },
  },
  offLive: {
    backgroundColor: {
      default: colors.switchTrack,
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal]):hover",
        fieldControlMarker
      )]: {
        default: null,
        [HOVER]: colors.switchTrackHover,
      },
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal]):active",
        fieldControlMarker
      )]: colors.switchTrackHover,
    },
  },
  pressable: {
    transform: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal]):active",
        fieldControlMarker
      )]: `scale(${size.buttonPressScale})`,
    },
  },
  failed: { boxShadow: size.errorBorder },
  // In forced colours the green is hidden, so on is the system's Highlight fill, as a toggle there
  // is: on and off then differ by more than the thumb's side.
  trackOnForced: {
    backgroundColor: { default: null, [FORCED]: "Highlight" },
    borderColor: { default: null, [FORCED]: "Highlight" },
  },

  // On: the success green, its light at the top and its bevel inside.
  success: {
    position: "absolute",
    inset: 0,
    zIndex: 0,
    overflow: "hidden",
    borderRadius: "inherit",
    backgroundColor: colors.successFill,
    backgroundImage: colors.successLight,
    backgroundSize: size.successLightSize,
    backgroundPosition: size.successLightRest,
    boxShadow: shadow.bevelSuccessFace,
    opacity: 0,
    pointerEvents: "none",
    // It crosses with the thumb's travel, not after it.
    transitionProperty: "opacity",
    transitionDuration: motionVars.travel,
    transitionTimingFunction: duration.ease,
    display: { default: "block", [FORCED]: "none" },
  },
  successShown: { opacity: 1 },
  successFailed: { boxShadow: size.errorBorder },
  sheen: {
    position: "absolute",
    inset: 0,
    borderRadius: "inherit",
    backgroundImage: `linear-gradient(${colors.buttonSheen}, transparent)`,
    opacity: 0.6,
    transitionProperty: "opacity",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
  },
  sheenLive: {
    opacity: {
      default: 0.6,
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal]):hover",
        fieldControlMarker
      )]: {
        default: null,
        [HOVER]: 1,
      },
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal]):active",
        fieldControlMarker
      )]: 0.3,
    },
  },

  // Mirrors its contents in right to left, so a light or a stretch runs the other way.
  mirror: {
    position: "absolute",
    inset: 0,
    transform: { default: null, ":dir(rtl)": "scaleX(-1)" },
  },

  // The light. It rests behind the thumb, follows it on the spring a little later than the thumb
  // arrives, leans in under a pointer and draws back under a press.
  light: {
    position: "absolute",
    top: "-50%",
    left: 0,
    width: "100%",
    height: "200%",
    backgroundImage: colors.switchLight,
    mixBlendMode: "screen",
    opacity: 0.7,
    transform: "translateX(-75%)",
    transitionProperty: "transform",
    transitionDuration: motionVars.trail,
    transitionTimingFunction: duration.switchSpring,
  },
  lightOn: {
    transform: "translateX(18%)",
  },
  lightLive: {
    transform: {
      default: "translateX(18%)",
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal]):hover",
        fieldControlMarker
      )]: {
        default: null,
        [HOVER]: "translateX(26%)",
      },
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal]):active",
        fieldControlMarker
      )]: "translateX(10%)",
    },
  },
  lightAt: (x: string) => ({ transform: x, transitionDuration: "0s" }),

  // The thumb: a pill with a soft shadow round its whole shape. It travels on the spring.
  thumb: {
    [iconVars.size]: `calc(${size.switchThumb} - ${space[1]})`,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    zIndex: 1,
    flexShrink: 0,
    width: size.switchThumbWidth,
    height: size.switchThumb,
    color: { default: colors.mutedForeground, [FORCED]: "Canvas" },
    filter: { default: shadow.switchThumbShadow, [FORCED]: "none" },
    transitionProperty: "transform",
    transitionDuration: motionVars.travel,
    transitionTimingFunction: duration.switchSpring,
  },
  thumbOn: {
    color: { default: colors.successFill, [FORCED]: "Highlight" },
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
    borderRadius: radius.full,
    backgroundColor: {
      default: colors.primaryForegroundOnColor,
      [FORCED]: "CanvasText",
    },
  },
  pillOnForced: {
    backgroundColor: {
      default: colors.primaryForegroundOnColor,
      [FORCED]: "HighlightText",
    },
  },
  stretch: {
    transform: "translateX(0)",
    // Back on the spring, so the trailing end catches up and settles.
    transitionProperty: "transform",
    transitionDuration: motionVars.travel,
    transitionTimingFunction: duration.switchSpring,
  },
  // Pressed anywhere on its row: stretched by `to`, towards the side it will travel to.
  stretchLive: (to: string) => ({
    transform: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal]):active",
        fieldControlMarker
      )]: `translateX(${to})`,
    },
    transitionDuration: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal]):active",
        fieldControlMarker
      )]: motionVars.press,
    },
    transitionTimingFunction: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal]):active",
        fieldControlMarker
      )]: duration.ease,
    },
  }),
  // While dragged: stretched towards the side it would land on, and less as it nears that end, so
  // it is back to its own width when it arrives and never leaves the track.
  stretchedAt: (x: string) => ({
    transform: x,
    transitionDuration: motionVars.press,
    transitionTimingFunction: duration.ease,
  }),
  // While it saves: a loader on the thumb, turning; with reduced motion it stands still and
  // breathes. Its own, not a Spinner: the thumb is smaller than a Spinner's smallest size.
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
      default: duration.spin,
      [REDUCED]: `calc(${duration.spin} * 2)`,
    },
    animationTimingFunction: {
      default: "linear",
      [REDUCED]: duration.easeInOut,
    },
    animationIterationCount: "infinite",
  },
});

// ---- The save -----------------------------------------------------------------------------------

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

// ---- The drag -----------------------------------------------------------------------------------

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
      stretch: pixels(style.getPropertyValue(STRETCH)),
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

// ---- The parts ----------------------------------------------------------------------------------

interface SuccessProps {
  checked: boolean;
  live: boolean;
  failed: boolean;
  at: Held | null;
}

/** The success green, which fades in with the travel, and the light inside it. */
const Success = ({ checked, live, failed, at }: SuccessProps) => {
  const shown = sideOf(at, checked);
  const settled = live && checked && at === null;
  const lit = live && shown;
  return (
    <span
      data-slot="switch-success"
      {...stylex.props(
        styles.success,
        shown && styles.successShown,
        failed && styles.successFailed
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
  loading: boolean;
  at: Held | null;
}

/** The thumb: a pill, and a second pill behind it that slides out to stretch it. */
const Thumb = ({ checked, live, loading, at }: ThumbProps) => {
  // The side a press stretches towards: where it will travel to.
  const towardsEnd = at === null ? !checked : sideOf(at, checked);
  const stretchLive = styles.stretchLive(
    towardsEnd ? size.switchStretch : `calc(-1 * ${size.switchStretch})`
  );
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
      {loading && (
        <span {...stylex.props(styles.spinner)}>
          <span {...stylex.props(styles.turning)}>
            <Icon icon={LoaderIcon} />
          </span>
        </span>
      )}
    </SwitchThumb>
  );
};

interface TrackProps {
  checked: boolean;
  live: boolean;
  loading: boolean;
  failed: boolean;
  drag: Omit<ReturnType<typeof useDrag>, "handleClickCapture">;
}

/** The track, which a pointer can drag the thumb along. */
const Track = ({ checked, live, loading, failed, drag }: TrackProps) => {
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
      <Success checked={checked} live={live} failed={failed} at={at} />
      <Thumb checked={checked} live={live} loading={loading} at={at} />
    </span>
  );
};

// The button's class from its state and the save's. Out here, not inline: the React Compiler
// cannot lower the chained conditions inside a render prop.
const controlClass = (
  state: SwitchState,
  life: ActionStatus,
  style: LayoutStyle | undefined
) =>
  className(
    styles.control,
    state.disabled && styles.disabled,
    state.readOnly && !state.disabled && styles.still,
    life === "loading" && !state.disabled && styles.busy,
    focusRingOffset,
    styles.inRow,
    style
  ) ?? "";

export const Switch = (allProps: SwitchProps) => {
  // SAFETY: SwitchProps is this shape in each of its two branches; the cast lets one destructure
  // read the save props, which are undefined in the branch without a save.
  const {
    style,
    onSave,
    errorText,
    status,
    onCheckedChange,
    controller: given,
    ...rest
  } = allProps as SwitchBase &
    Omit<
      SwitchPrimitiveProps,
      keyof SwitchBase | "className" | "children" | "render"
    > & {
      onSave?: (checked: boolean) => Promise<unknown>;
      errorText?: string;
      status?: ActionStatus;
    };
  const field = useFieldControl();
  const words = useI18n().switch;
  const failure = errorText ?? words.error;
  const [made] = useReducer(keepController, undefined, createSwitchController);
  const controller = given ?? made;
  const [saving, setSaving] = useState<ActionStatus>("idle");
  const life = status ?? saving;
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
    setSaving("loading");
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
    setSaving("error");
    announce(failure);
  };

  const handleCheckedChange: NonNullable<
    SwitchPrimitiveProps["onCheckedChange"]
  > = (next, details) => {
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
    // It turns only once the save worked; a press while it saves does nothing. With `status`
    // given, the switch shows that status standing still and saves nothing.
    details.cancel();
    if (running.current || status !== undefined) {
      return;
    }
    void save(onSave, next);
  };

  const failed = life === "error";
  const control = (
    <SwitchPrimitive
      {...rest}
      {...(failed && { "aria-invalid": true })}
      aria-busy={life === "loading" || undefined}
      data-state={life === "idle" ? undefined : life}
      controller={controller}
      onCheckedChange={handleCheckedChange}
      onClickCapture={handleClickCapture}
      className={(state: SwitchState) =>
        controlClass(state, life, field === null ? undefined : style)
      }
    >
      {(state: SwitchState) => (
        <>
          <span
            aria-hidden="true"
            data-slot="switch-hit-area"
            {...stylex.props(choiceHitArea)}
          />
          <Track
            checked={state.checked}
            live={!(state.disabled || state.readOnly || life === "loading")}
            loading={life === "loading"}
            failed={failed}
            drag={drag}
          />
        </>
      )}
    </SwitchPrimitive>
  );

  // Outside a Field: named by `aria-label`, where the words around it already say what it is.
  if (field === null) {
    return <span {...stylex.props(styles.alone, style)}>{control}</span>;
  }

  // In a Field, which names and describes it: a failed save says its words under the row's.
  return (
    <>
      {control}
      {failed && (
        <div {...stylex.props(styles.failure)}>
          <FieldError match>{failure}</FieldError>
        </div>
      )}
    </>
  );
};
