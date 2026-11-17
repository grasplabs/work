"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  MenuItemIndicator,
  MenuRadioItem,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import type { MenuRadioItemState } from "@ui-sdk/react/menu";

import {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
} from "../dropdown-menu";
import { menuStyles } from "../dropdown-menu/styles";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { ChevronDown, Icon, Tick } from "../icons";
import { grasp, media } from "../tokens/tokens.stylex";
import { useComposerDisabled } from "./context";
import { controlStyles } from "./control";
import { stopEscape } from "./escape";

/** One level. */
export interface ComposerReasoningOption {
  /** What the change handlers receive. */
  value: string;
  /** Its word, one a person who is not an engineer understands ("Medium"). */
  label: string;
  /** One quiet line on what it means, under its name in the list ("Thinks longest"). */
  note?: string;
  /**
   * The strongest level: its row has a ground of its own, the working light dithered behind it,
   * and chosen, the light runs round the footer's control. One level at most.
   * @default false
   */
  top?: boolean;
}

// The working light travelling, as the Composer's strip does, slowly.
const travel = stylex.keyframes({
  from: { backgroundPosition: "0% 0" },
  to: { backgroundPosition: "-200% 0" },
});

const styles = stylex.create({
  // The levels' scale: a dot for each, filled up to this one, a ring beyond. Filled and ring tell
  // them apart without colour; both hold 3:1 against the menu and the footer.
  scale: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.composerScaleGap,
    flexShrink: 0,
  },
  scaleEnd: {
    marginInlineStart: "auto",
    paddingInlineStart: grasp.space4,
  },
  dot: {
    boxSizing: "border-box",
    width: grasp.composerScaleDot,
    height: grasp.composerScaleDot,
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: { default: grasp.muted, [media.forced]: "currentColor" },
    borderRadius: "50%",
  },
  dotOn: {
    borderColor: "currentColor",
    backgroundColor: "currentColor",
  },
  // The chosen level's tick, at the row's start; its room is kept on every row, so the words
  // stand in one column and the scale never moves.
  chosen: {
    display: "inline-flex",
    flexShrink: 0,
    width: grasp.iconSm,
  },
  words: {
    display: "grid",
    flexGrow: 1,
    minWidth: 0,
  },
  // A level's note, under its name: quiet and small.
  note: {
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightRegular,
  },
  // The chosen level's tick, at the row's end.
  tickEnd: {
    display: "inline-flex",
    flexShrink: 0,
    marginInlineStart: "auto",
  },
  // The strongest level's ground: the working light seen through the Composer's dither, rising
  // from the row's end. It is the row's own shape (its radius and corner shape, inherited), so it
  // fills the squircle exactly, with the plain-radius fallback where there is no corner shape.
  ground: {
    position: "absolute",
    inset: 0,
    borderRadius: "inherit",
    cornerShape: "inherit",
    pointerEvents: "none",
    display: { default: "block", [media.forced]: "none" },
    backgroundImage: grasp.composerLight,
    backgroundSize: "200% 100%",
    maskImage: `radial-gradient(circle, black ${grasp.composerDot}, transparent calc(${grasp.composerDot} + ${grasp.hairline} / 2)), linear-gradient(to left, black, transparent 75%)`,
    maskSize: `${grasp.composerDither} ${grasp.composerDither}, 100% 100%`,
    maskComposite: "intersect",
    // Faint at rest; full on the row under the pointer or the keyboard, or the chosen one.
    opacity: {
      default: 0.35,
      [stylex.when.ancestor(":is([data-highlighted], [aria-checked=true])")]: 1,
    },
    animationName: { default: travel, [media.reduced]: "none" },
    animationDuration: grasp.composerBeam,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    transitionProperty: "opacity",
    transitionDuration: { default: grasp.durationUi, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  // The row's own parts stand over its ground.
  over: {
    position: "relative",
  },
  // Chosen, the light runs round the footer's control, as round the Composer's card while it
  // answers: an edge only, so the word and the chevron stay clear. Still with reduced motion.
  edge: {
    position: "absolute",
    inset: 0,
    borderRadius: "inherit",
    cornerShape: "inherit",
    padding: grasp.hairline,
    pointerEvents: "none",
    display: { default: "block", [media.forced]: "none" },
    backgroundImage: grasp.composerLight,
    backgroundSize: "200% 100%",
    maskImage: "linear-gradient(black, black), linear-gradient(black, black)",
    maskClip: "content-box, border-box",
    maskComposite: "exclude",
    animationName: { default: travel, [media.reduced]: "none" },
    animationDuration: grasp.composerBeam,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  edgeWords: {
    color: grasp.ink,
  },
});

/**
 * A level's place among the levels, as dots: `at` of `count` filled.
 * @deprecated The level is said in a word now (Ruben, 17 November); nothing in the Composer draws
 * this. Kept until the breaking release's step 9.
 */
export const Scale = ({
  at,
  count,
  end = false,
  over = false,
}: {
  at: number;
  count: number;
  end?: boolean;
  over?: boolean;
}) => (
  <span
    aria-hidden="true"
    data-slot="composer-reasoning-scale"
    data-at={at + 1}
    {...stylex.props(styles.scale, end && styles.scaleEnd, over && styles.over)}
  >
    {Array.from({ length: count }, (_, index) => (
      <span
        key={index}
        {...stylex.props(styles.dot, index <= at && styles.dotOn)}
      />
    ))}
  </span>
);

/** The working light round a footer control, for the top level chosen (here and in model-effort.tsx). */
export const LitEdge = () => (
  <span
    aria-hidden="true"
    data-slot="composer-reasoning-edge"
    {...stylex.props(styles.edge)}
  />
);

const rowClass = (state: MenuRadioItemState) =>
  stylex.props(
    menuStyles.item,
    state.highlighted && menuStyles.highlighted,
    state.disabled && menuStyles.disabled,
    stylex.defaultMarker()
  ).className;

/** Every prop a ComposerReasoning takes. */
export interface ComposerReasoningProps {
  /** The levels, from the least effort to the most. */
  levels: ComposerReasoningOption[];
  /** The chosen level's `value`. */
  value: string;
  /** Called with the level chosen. */
  onValueChange: (value: string) => void;
  /**
   * The control's name for a screen reader, and the levels' group name in the menu.
   * @default "Reasoning"
   */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /**
   * At the strongest level (an option's `top`), the working light: behind its row in the menu, and
   * round the control while it is chosen. Off, the level's word says it alone.
   * @default false
   */
  topLight?: boolean;
}

/**
 * A level's words in a list: its name, and its note under it where it has one. A screen reader
 * hears "Low, Fastest": the comma is said, not shown. With `noteId` the note can describe a control.
 */
export const LevelWords = ({
  level,
  over = false,
  noteId,
}: {
  level: ComposerReasoningOption;
  over?: boolean;
  noteId?: string;
}) => (
  <span {...stylex.props(styles.words, over && styles.over)}>
    <span>{level.label}</span>
    {level.note !== undefined && level.note !== "" && (
      <>
        <span {...stylex.props(visuallyHidden)}>, </span>
        <span id={noteId} {...stylex.props(styles.note)}>
          {level.note}
        </span>
      </>
    )}
  </span>
);

/** How hard the agent thinks: a word in the footer and a small menu of levels. */
export const ComposerReasoning = ({
  levels,
  value,
  onValueChange,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated ?? "Reasoning",
  topLight = false,
}: ComposerReasoningProps) => {
  const disabled = useComposerDisabled();
  const current = levels.find((level) => level.value === value);
  const lit = topLight && current?.top === true;
  return (
    <DropdownMenu>
      <MenuTrigger
        disabled={disabled}
        aria-label={`${label}: ${current?.label ?? ""}`}
        render={(props: Record<string, unknown>) => (
          <button
            {...props}
            type="button"
            data-slot="composer-reasoning"
            data-top={lit || undefined}
            {...stylex.props(
              controlStyles.control,
              controlStyles.foldLast,
              focus.ring,
              lit && styles.edgeWords
            )}
          >
            <span aria-hidden="true" {...stylex.props(controlStyles.reach)} />
            {lit ? <LitEdge /> : null}
            <span key={value} {...stylex.props(controlStyles.value)}>
              <span {...stylex.props(controlStyles.words)}>
                {current?.label}
              </span>
            </span>
            <Icon icon={ChevronDown} />
          </button>
        )}
      />
      <DropdownMenuContent side="top" align="start" onKeyDown={stopEscape}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => {
              if (next !== "") {
                onValueChange(next);
              }
            }}
          >
            {levels.map((level) => (
              <MenuRadioItem
                key={level.value}
                value={level.value}
                label={level.label}
                className={rowClass}
                data-top={level.top === true || undefined}
              >
                {topLight && level.top === true ? (
                  <span
                    aria-hidden="true"
                    data-slot="composer-reasoning-ground"
                    {...stylex.props(styles.ground)}
                  />
                ) : null}
                <LevelWords level={level} over />
                <span {...stylex.props(styles.tickEnd, styles.over)}>
                  <MenuItemIndicator {...stylex.props(menuStyles.icon)}>
                    <Icon icon={Tick} />
                  </MenuItemIndicator>
                </span>
              </MenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
