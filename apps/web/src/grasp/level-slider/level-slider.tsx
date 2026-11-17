// LevelSlider: one of a short, named scale (two to seven levels), chosen along a track of dots.
// Built for effort (Low, Medium, High, Extra high, Max), and for any scale whose steps are words.
//
//   <LevelSlider label="Effort" levels={levels} defaultValue="medium" />
//   <LevelSlider label="Effort" labelHidden size="compact" levels={levels} value={effort} onValueChange={setEffort} />
//
// A soft round track filled with a halftone of dots (field.ts). Up to the thumb the dots are lit,
// the ink and its deeper green, growing further along so more reads as more; the last few before
// the thumb glow warm, the light's leading edge. Past the thumb they rest, small and faint. The
// thumb is a round tab of the card's surface, snapping to a level's place. The scale's two ends
// are named under it ("Low", "Max"); the chosen level is said in words to a screen reader. The top
// level (`top`) is its own state: the dots take the working light, a wave runs along them, and the
// thumb glows; with reduced motion the wave stands still.
//
// The keyboard and a screen reader move a native range input in the thumb: arrow keys step, Home
// and End jump, and its value is said in words (`aria-valuetext`, the level's label). The whole
// row takes a press or a drag, 44px tall. In forced colours: a bordered track, the part up to the
// thumb in Highlight, the thumb bordered. Every value is a token (src/tokens); every word is a prop.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";
import type {
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from "react";

import { visuallyHidden } from "../hidden/hidden";
import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";
import { startLevelField } from "./field";
import type { LevelField } from "./field";
import { levelSliderMarker } from "./level-slider.stylex";

/** What a caller may style: where the slider sits, and how wide it is. Never its look. */
export type LevelSliderLayoutStyle = LayoutStyle;

/** One level of the scale. */
export interface LevelSliderLevel {
  /** What `onValueChange` receives ("medium"). */
  id: string;
  /** Its name ("Medium"): the ends' names stand under the track; each is said to a screen reader. */
  label: string;
  /** One line on what it means, shown under the slider while it is chosen. */
  description?: string;
}

/** compact: inside a popup or a menu. regular: on a page or in a form. */
export type LevelSliderSize = "compact" | "regular";

/** Every prop a LevelSlider takes. */
export interface LevelSliderProps {
  /** The levels, lowest first: two to seven. Fewer than two shows `emptyLabel` and no control. */
  levels: readonly LevelSliderLevel[];
  /** The chosen level's id, for a slider your code holds. */
  value?: string | undefined;
  /** The level at first, when the slider holds its own. Left out, the first. */
  defaultValue?: string | undefined;
  /** Runs when the level changes, by a drag, a press or a key, with the new level's id. */
  onValueChange?: ((value: string) => void) | undefined;
  /** What it sets, in sentence case ("Effort"): its accessible name, shown as a quiet word above it. */
  label: string;
  /**
   * Hides `label` from the eye (a screen reader still says it), when the words round it name it.
   * @default false
   */
  labelHidden?: boolean;
  /**
   * The last level is its own state while chosen (the working light in the dots, a wave, the thumb
   * aglow): `true`, `false`, or `"auto"`, on for four levels or more (a short scale's last step is
   * not extra).
   * @default "auto"
   */
  top?: boolean | "auto";
  /**
   * compact (a 24px track) inside a popup or a menu, regular (32px) on a page.
   * @default "regular"
   */
  size?: LevelSliderSize;
  /**
   * Out of use: no drag, no focus, half strength. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /** The line shown instead of the control when there are fewer than two levels. */
  emptyLabel?: ReactNode;
  /** Layout only: margins, alignment and width. The look belongs to the slider. */
  style?: LevelSliderLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: LevelSliderLayoutStyle;
}

const styles = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
    fontFamily: grasp.fontSans,
  },
  label: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  labelRegular: {
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  // Where a press lands: 44px tall round the track, so a finger finds it.
  control: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    height: grasp.tap,
    touchAction: "none",
    cursor: "pointer",
    userSelect: "none",
    WebkitTapHighlightColor: "transparent",
  },
  still: {
    cursor: "default",
    pointerEvents: "none",
  },
  // The track: soft and round, the dots drawn over it.
  track: {
    position: "relative",
    flexGrow: 1,
    minWidth: 0,
    height: grasp.levelSliderTrack,
    borderRadius: grasp.cornerPill,
    backgroundColor: {
      default: grasp.levelSliderRest,
      [media.forced]: "Canvas",
    },
    borderStyle: { default: "none", [media.forced]: "solid" },
    borderWidth: { default: 0, [media.forced]: 1 },
    borderColor: { default: null, [media.forced]: "CanvasText" },
  },
  trackRegular: {
    height: grasp.levelSliderTrackRegular,
  },
  canvas: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    color: grasp.ink,
    display: { default: "block", [media.forced]: "none" },
  },
  // In forced colours the part up to the thumb, plainly.
  forcedFill: {
    position: "absolute",
    insetBlock: 0,
    insetInlineStart: 0,
    borderRadius: "inherit",
    display: { default: "none", [media.forced]: "block" },
    backgroundColor: "Highlight",
  },
  fillTo: (place: string) => ({
    width: place,
  }),
  // The thumb: a round tab of the card's surface, standing just inside the track.
  thumb: {
    position: "absolute",
    top: grasp.levelSliderThumbInset,
    bottom: grasp.levelSliderThumbInset,
    aspectRatio: "1",
    // Centred on its place: inset-inline-start measures from the right in right to left, and a
    // translate is physical, so it goes the other way there.
    translate: { default: "-50% 0", ":dir(rtl)": "50% 0" },
    boxSizing: "border-box",
    borderRadius: grasp.cornerCircle,
    backgroundColor: {
      default: grasp.levelSliderThumb,
      [media.forced]: "Canvas",
    },
    boxShadow: {
      default: `0 0 0 ${grasp.hairline} ${grasp.choiceEdgeHover}, ${grasp.liftLow}`,
      [stylex.when.ancestor(":hover", levelSliderMarker)]:
        `0 0 0 ${grasp.hairline} ${grasp.muted}, ${grasp.liftMedium}`,
      [stylex.when.ancestor(":active", levelSliderMarker)]:
        `0 0 0 ${grasp.hairline} ${grasp.muted}, ${grasp.liftLow}`,
    },
    borderStyle: { default: "none", [media.forced]: "solid" },
    borderWidth: { default: 0, [media.forced]: 2 },
    borderColor: { default: null, [media.forced]: "CanvasText" },
    // The focus is on the range input inside it: the shared ring, standing off the thumb.
    outline: {
      default: "none",
      ":has(:focus-visible)": {
        default: `${grasp.ringWidth} solid ${grasp.ring}`,
        [media.forced]: `calc(2 * ${grasp.ringWidth}) solid Highlight`,
      },
    },
    outlineOffset: grasp.ringOffsetMark,
    // Under a pointer anywhere on the row the thumb grows a touch and lifts, to be taken hold of;
    // pressed, it gives a little and settles, as every control presses.
    scale: {
      default: null,
      [stylex.when.ancestor(":hover", levelSliderMarker)]:
        grasp.levelSliderHover,
      [stylex.when.ancestor(":active", levelSliderMarker)]: grasp.pressScale,
    },
    transitionProperty: "inset-inline-start, scale, box-shadow",
    transitionDuration: {
      default: grasp.levelSliderSnap,
      [media.reduced]: "0s",
    },
    transitionTimingFunction: grasp.ease,
  },
  // At the top level the thumb glows with the working light, so Max is felt, not only read.
  thumbTop: {
    boxShadow: {
      default: `0 0 0 ${grasp.hairline} ${grasp.mintDeep}, 0 0 ${grasp.space3} ${grasp.mint}, ${grasp.liftLow}`,
      [media.forced]: "none",
    },
  },
  // A thumb follows a dragging pointer at once.
  thumbHeld: {
    transitionDuration: "0s",
    scale: grasp.pressScale,
  },
  thumbAt: (place: string) => ({
    insetInlineStart: place,
  }),
  // The range input that the keyboard, a screen reader and an agent move: unseen, in the thumb.
  // As large as a finger's reach, centred on the thumb, as the row round it is.
  input: {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: grasp.tap,
    height: grasp.tap,
    translate: "-50% -50%",
    margin: 0,
    opacity: 0,
    pointerEvents: "none",
    appearance: "none",
  },
  // The scale's two ends, named under the track, each under its end of the thumb's run.
  ends: {
    display: "flex",
    justifyContent: "space-between",
    gap: grasp.space3,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  endOn: {
    color: grasp.ink,
    fontWeight: grasp.weightMedium,
  },
  description: {
    margin: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  empty: {
    margin: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  disabled: {
    opacity: grasp.dim,
  },
});

/** The pointer's place along the track, 0 to 1, in reading order. */
const placeOf = (event: ReactPointerEvent, track: HTMLElement) => {
  const box = track.getBoundingClientRect();
  const style = getComputedStyle(track);
  const rtl = style.direction === "rtl";
  const x = rtl ? box.right - event.clientX : event.clientX - box.left;
  // The thumb runs between the two round ends: half the track's height in from each, and the
  // run's own inset (level-slider-run-inset), as the field and the thumb's place have it.
  const end =
    box.height / 2 +
    (Number(
      style
        .getPropertyValue("--grasp-level-slider-run-inset")
        .trim()
        .replace("px", "")
    ) || 0);
  return Math.min(1, Math.max(0, (x - end) / Math.max(1, box.width - 2 * end)));
};

/** The level nearest a place along the run. */
const levelAt = (place: number, count: number) =>
  Math.min(count - 1, Math.max(0, Math.round(place * (count - 1))));

/** Whether the last level carries the light. */
const topOn = (top: boolean | "auto", count: number) =>
  top === "auto" ? count >= 4 : top;

/** Where the thumb's centre stands, as CSS: between the round ends, kept a little short of them, by its share of the run. */
const thumbPlace = (share: number, regular: boolean) => {
  const height = regular
    ? grasp.levelSliderTrackRegular
    : grasp.levelSliderTrack;
  return `calc(${height} / 2 + ${grasp.levelSliderRunInset} + (100% - ${height} - 2 * ${grasp.levelSliderRunInset}) * ${share.toFixed(4)})`;
};

/** An effect with nothing to undo. */
const holdNothing = () => {
  // Nothing was started.
};

/** The halftone over the track: started once it is laid out, told of every change. */
const useField = (
  canvas: RefObject<HTMLCanvasElement | null>,
  track: RefObject<HTMLDivElement | null>,
  fill: number,
  top: boolean
) => {
  const field = useRef<LevelField | null>(null);
  useEffect(() => {
    if (canvas.current === null || track.current === null) {
      return holdNothing;
    }
    const started = startLevelField(canvas.current, track.current);
    field.current = started;
    return () => {
      started.stop();
      field.current = null;
    };
  }, [canvas, track]);
  useEffect(() => {
    field.current?.set({ fill, top });
  }, [fill, top]);
};

/** The level chosen, held here unless the caller holds it. */
const useLevel = (
  levels: readonly LevelSliderLevel[],
  value: string | undefined,
  defaultValue: string | undefined,
  onValueChange: ((value: string) => void) | undefined,
  disabled: boolean
) => {
  const [own, setOwn] = useState(defaultValue ?? levels[0]?.id ?? "");
  const chosen = value ?? own;
  const at = Math.max(
    0,
    levels.findIndex((level) => level.id === chosen)
  );
  const pick = (index: number) => {
    const level = levels[index];
    if (disabled || level === undefined || index === at) {
      return;
    }
    setOwn(level.id);
    onValueChange?.(level.id);
  };
  return { at, pick };
};

/** The track and its thumb: the row that takes a press or a drag, 44px tall. */
const Track = ({
  levels,
  at,
  pick,
  disabled,
  regular,
  lit,
  id,
  input,
  describedBy,
}: {
  levels: readonly LevelSliderLevel[];
  at: number;
  pick: (index: number) => void;
  disabled: boolean;
  regular: boolean;
  lit: boolean;
  id: string;
  input: RefObject<HTMLInputElement | null>;
  describedBy: string | undefined;
}) => {
  const [dragging, setDragging] = useState<number>();
  const track = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const count = levels.length;
  const share = dragging ?? at / (count - 1);
  useField(canvas, track, share, lit);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0 || track.current === null) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const place = placeOf(event, track.current);
    setDragging(place);
    pick(levelAt(place, count));
    input.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging === undefined || track.current === null) {
      return;
    }
    const place = placeOf(event, track.current);
    setDragging(place);
    pick(levelAt(place, count));
  };
  const onPointerEnd = () => {
    setDragging(undefined);
  };

  return (
    <div
      data-slot="level-slider-control"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      {...stylex.props(
        levelSliderMarker,
        styles.control,
        disabled && styles.still
      )}
    >
      <div
        ref={track}
        data-slot="level-slider-track"
        {...stylex.props(styles.track, regular && styles.trackRegular)}
      >
        <canvas
          ref={canvas}
          aria-hidden="true"
          data-slot="level-slider-dots"
          {...stylex.props(styles.canvas)}
        />
        <span
          aria-hidden="true"
          {...stylex.props(
            styles.forcedFill,
            styles.fillTo(thumbPlace(share, regular))
          )}
        />
        <span
          data-slot="level-slider-thumb"
          data-held={dragging === undefined ? undefined : ""}
          {...stylex.props(
            styles.thumb,
            lit && styles.thumbTop,
            dragging !== undefined && styles.thumbHeld,
            styles.thumbAt(thumbPlace(share, regular))
          )}
        >
          <input
            ref={input}
            id={id}
            type="range"
            min={0}
            max={count - 1}
            step={1}
            value={at}
            disabled={disabled}
            aria-valuetext={levels[at]?.label}
            aria-describedby={describedBy}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              pick(Number(event.currentTarget.value));
            }}
            {...stylex.props(styles.input)}
          />
        </span>
      </div>
    </div>
  );
};

/** The scale's two ends, named under the track; a screen reader has the chosen level from the input. */
const Ends = ({
  first,
  last,
  at,
  count,
}: {
  first: string | undefined;
  last: string | undefined;
  at: number;
  count: number;
}) => (
  <div
    aria-hidden="true"
    data-slot="level-slider-ends"
    {...stylex.props(styles.ends)}
  >
    <span
      data-on={at === 0 ? "" : undefined}
      {...stylex.props(at === 0 && styles.endOn)}
    >
      {first}
    </span>
    <span
      data-on={at === count - 1 ? "" : undefined}
      {...stylex.props(at === count - 1 && styles.endOn)}
    >
      {last}
    </span>
  </div>
);

/** A short named scale, chosen along a track of dots. */
export const LevelSlider = ({
  levels,
  value,
  defaultValue,
  onValueChange,
  label,
  labelHidden = false,
  top = "auto",
  size = "regular",
  disabled = false,
  emptyLabel,
  style: styleProp,
  layout,
}: LevelSliderProps) => {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const { at, pick } = useLevel(
    levels,
    value,
    defaultValue,
    onValueChange,
    disabled
  );

  if (levels.length < 2) {
    return (
      <p
        data-slot="level-slider-empty"
        {...stylex.props(styles.empty, layout ?? styleProp)}
      >
        {emptyLabel}
      </p>
    );
  }

  const count = levels.length;
  const description = levels[at]?.description;
  return (
    <div
      data-slot="level-slider"
      data-level={levels[at]?.id}
      {...stylex.props(
        styles.root,
        disabled && styles.disabled,
        layout ?? styleProp
      )}
    >
      <label
        htmlFor={id}
        {...stylex.props(
          styles.label,
          size === "regular" && styles.labelRegular,
          labelHidden && visuallyHidden
        )}
      >
        {label}
      </label>
      <Track
        levels={levels}
        at={at}
        pick={pick}
        disabled={disabled}
        regular={size === "regular"}
        lit={topOn(top, count) && at === count - 1}
        id={id}
        input={input}
        describedBy={
          description === undefined ? undefined : `${id}-description`
        }
      />
      <Ends
        first={levels[0]?.label}
        last={levels[count - 1]?.label}
        at={at}
        count={count}
      />
      {description === undefined ? null : (
        <p id={`${id}-description`} {...stylex.props(styles.description)}>
          {description}
        </p>
      )}
    </div>
  );
};
