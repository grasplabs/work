// InputOTP: a one-time code, one square per character,
// in StyleX, built on UI SDK's OTPInput.
// One native input holds the code, so paste, autofill from a text message, undo and the form all
// work as they do for any field; the squares only draw it. Each square has Input's look, and the
// one typing goes to takes the focus edge.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <InputOTP maxLength={6} onComplete={verify} aria-label="Verification code">
//     <InputOTPGroup>
//       <InputOTPSlot index={0} /><InputOTPSlot index={1} /><InputOTPSlot index={2} />
//     </InputOTPGroup>
//     <InputOTPSeparator />
//     <InputOTPGroup>
//       <InputOTPSlot index={3} /><InputOTPSlot index={4} /><InputOTPSlot index={5} />
//     </InputOTPGroup>
//   </InputOTP>
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  OTPInput as OTPPrimitive,
  OTPInputGroup,
  OTPInputSeparator,
  OTPInputSlot,
} from "@ui-sdk/react/otp-input";
import type { OTPInputSlotState, OTPInputState } from "@ui-sdk/react/otp-input";
import { createContext, useContext } from "react";
import type { ComponentProps, ReactNode } from "react";

import { Icon, MinusIcon } from "../lib/icons";
import { focusField } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { className } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { focusMarker, iconVars } from "../lib/vars.stylex";
import { otpMarker } from "./input-otp.stylex";

type PrimitiveProps = ComponentProps<typeof OTPPrimitive>;

/** The square: `default` 36px, `lg` 44px for the one thing a screen asks for. */
export type InputOTPSize = "default" | "lg";

/** Every prop an InputOTP takes. */
export interface InputOTPProps {
  /** Its squares: InputOTPGroup runs of InputOTPSlot, with an InputOTPSeparator between them. */
  children: ReactNode;
  /** How many characters the code has: one InputOTPSlot each. */
  maxLength: number;
  /**
   * Which characters it takes: `numeric`, `alphabetic` or `alphanumeric`. Anything else typed or
   * pasted is ignored, and a phone shows the matching keyboard.
   * @default "numeric"
   */
  pattern?: "numeric" | "alphabetic" | "alphanumeric";
  /**
   * The square: `default` 36px, `lg` 44px for the one thing a screen asks for.
   * @default "default"
   */
  size?: InputOTPSize;
  /** The code it starts with. A form reset returns here. */
  defaultValue?: string;
  /** The code, when you keep it in state. Pair it with `onValueChange`. */
  value?: string;
  /**
   * Called with the code and why it changed: typing (`input-change`), a paste (`paste`), undo, a
   * form reset or an agent. `details.cancel()` keeps the code as it was.
   */
  onValueChange?: PrimitiveProps["onValueChange"];
  /**
   * Called when every square is filled, with the whole code: the moment to check it. Called again
   * if a full code changes.
   */
  onComplete?: (code: string) => void;
  /** The name the code is sent under in a form. Inside a Field, the Field's `name` serves. */
  name?: string;
  /**
   * Needs a whole code before the form is sent. A part of one is too short either way.
   * @default false
   */
  required?: boolean;
  /**
   * Can be read and copied, not changed. The squares take a quieter fill.
   * @default false
   */
  readOnly?: boolean;
  /**
   * Out of use: not focusable, not sent, half strength.
   * @default false
   */
  disabled?: boolean;
  /**
   * Marks the code wrong when it stands outside a Field. Inside one, the Field says so.
   * @default false
   */
  "aria-invalid"?: boolean;
  /** Its name when no label names it ("Verification code"). */
  "aria-label"?: string;
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/** Every prop an InputOTPGroup takes: one run of squares. */
export interface InputOTPGroupProps {
  /** Its InputOTPSlot squares, in order. */
  children: ReactNode;
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/** Every prop an InputOTPSlot takes: one square. */
export interface InputOTPSlotProps {
  /** Which character it shows, from 0. */
  index: number;
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/** Every prop an InputOTPSeparator takes: the dash between two runs. */
export interface InputOTPSeparatorProps {
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

const HOVER = media.hover;
const FORCED = media.forcedColors;
const REDUCED = media.reducedMotion;

const edge = `inset 0 0 0 1px ${colors.input}, ${shadow.inputShadow}`;
// A browser without corner-shape (Safari, Firefox) draws the radius as a plain round corner, and
// the squircle's radius would close a square into a circle: there a square takes the round corner
// a squircle of that size looks like, about three tenths of its side.
const ROUND = "@supports not (corner-shape: squircle)";

const styles = stylex.create({
  root: {
    // UI SDK lays its one native input over the squares, so a press anywhere reaches it.
    position: "relative",
    display: "flex",
    // One row always, the dash between its runs: a code too wide for its room (eight squares at
    // phone width) shrinks its squares together (group, below) rather than break the code in two.
    flexWrap: "nowrap",
    alignItems: "center",
    gap: space[2],
    width: "fit-content",
    maxWidth: "100%",
    cursor: "text",
    // A finger needs 44px: on a touch screen the root is at least that tall, round squares that
    // may have shrunk to fit a narrow screen.
    minHeight: { default: null, [media.pointerCoarse]: sizes.tapTarget },
  },
  rootDisabled: {
    opacity: sizes.opacityDisabled,
    cursor: "not-allowed",
  },
  // A run wider than the whole room (one long run, or a very narrow screen) shrinks its squares
  // together, staying square, rather than overflow.
  group: {
    display: "flex",
    flexShrink: 1,
    minWidth: 0,
    gap: space[2],
  },
  slot: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    boxSizing: "border-box",
    flexShrink: 1,
    minWidth: 0,
    aspectRatio: "1",
    // No border: Input's hairline drawn inside. In forced colours a real one appears, dashed when
    // the code is wrong (the same 1px, so a wrong slot is no bigger), as the tint is dropped there.
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: {
      default: "solid",
      [FORCED]: {
        default: "solid",
        [stylex.when.ancestor(":has(input[aria-invalid=true])", otpMarker)]:
          "dashed",
      },
    },
    borderColor: "currentColor",
    cornerShape: radius.shape,
    backgroundColor: colors.inputBg,
    boxShadow: {
      default: edge,
      // Only a code open for typing hovers, so a wrong one stays red under a pointer.
      [stylex.when.ancestor(
        ":hover:not(:has(input[aria-invalid=true], input:read-only))",
        otpMarker
      )]: {
        default: null,
        [HOVER]: `inset 0 0 0 1px ${colors.inputBorderHover}, ${shadow.inputShadow}`,
      },
      [stylex.when.ancestor(":has(input[aria-invalid=true])", otpMarker)]:
        sizes.inputInvalid,
    },
    color: colors.foreground,
    fontFamily: font.sans,
    fontWeight: font.weightMedium,
    fontVariantNumeric: "tabular-nums",
    transitionProperty: {
      default: "box-shadow, background-color",
      [REDUCED]: "none",
    },
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  default: {
    width: sizes.controlDefault,
    borderRadius: {
      default: `min(${radius.base}, calc(${sizes.controlDefault} / 2))`,
      [ROUND]: `calc(${sizes.controlDefault} * 0.3)`,
    },
    fontSize: font.textBase,
  },
  lg: {
    width: sizes.controlLg,
    borderRadius: {
      default: `min(${radius.base}, calc(${sizes.controlLg} / 2))`,
      [ROUND]: `calc(${sizes.controlLg} * 0.3)`,
    },
    fontSize: font.textLg,
  },
  // Settled, as Input's: the soft ground, a hairline, no lift, its characters a step quieter.
  readOnly: {
    backgroundColor: colors.inputBgRead,
    color: colors.inputForegroundRead,
    boxShadow: `inset 0 0 0 1px ${colors.input}`,
  },
  // Where typing goes: the focus edge and halo, red when the code is wrong, whether a press or the
  // keyboard brought focus; an outline in forced colours (focusField.slot).
  active: {
    boxShadow: {
      default: sizes.inputFocus,
      [stylex.when.ancestor(":has(input[aria-invalid=true])", otpMarker)]:
        sizes.inputFocusInvalid,
    },
  },
  separator: {
    flexShrink: 0,
    [iconVars.size]: sizes.iconSm,
    [iconVars.stroke]: sizes.iconStroke,
    display: "flex",
    color: colors.mutedForeground,
  },
});

// UI SDK's names for the characters a code takes, and the keyboard a phone shows for them.
const patterns = {
  numeric: { pattern: "digits", inputMode: "numeric" },
  alphabetic: { pattern: "letters", inputMode: "text" },
  alphanumeric: { pattern: "alphanumeric", inputMode: "text" },
} as const;

// The squares' size, and whether the code can only be read, from the InputOTP.
const SlotSize = createContext<InputOTPSize>("default");
const SlotReadOnly = createContext(false);

/** A one-time code, one square per character, on one native input. */
export const InputOTP = ({
  children,
  maxLength,
  pattern = "numeric",
  size = "default",
  onComplete,
  readOnly,
  disabled,
  style,
  ...rest
}: InputOTPProps) => (
  <OTPPrimitive
    {...rest}
    data-slot="input-otp"
    maxLength={maxLength}
    pattern={patterns[pattern].pattern}
    inputMode={patterns[pattern].inputMode}
    textAlign="center"
    autoComplete="one-time-code"
    readOnly={readOnly}
    disabled={disabled}
    onValueCommit={
      onComplete &&
      ((code: string) => {
        onComplete(code);
      })
    }
    // Disabled by its own prop, its Field or a <fieldset>: UI SDK's state knows which.
    className={(state: OTPInputState) =>
      className(
        otpMarker,
        focusMarker,
        styles.root,
        state.disabled && styles.rootDisabled,
        style
      ) ?? ""
    }
  >
    <SlotSize value={size}>
      <SlotReadOnly value={readOnly === true}>{children}</SlotReadOnly>
    </SlotSize>
  </OTPPrimitive>
);

/** One run of squares, drawn together. */
export const InputOTPGroup = ({ children, style }: InputOTPGroupProps) => (
  <OTPInputGroup
    data-slot="input-otp-group"
    {...stylex.props(styles.group, style)}
  >
    {children}
  </OTPInputGroup>
);

/** A square's look: its size, read only unless it is out of use, and the one being typed in. */
const slotClass = (
  size: InputOTPSize,
  readOnly: boolean,
  state: OTPInputSlotState,
  style: LayoutStyle | undefined
) =>
  className(
    styles.slot,
    size === "lg" ? styles.lg : styles.default,
    readOnly && !state.disabled && styles.readOnly,
    state.active && styles.active,
    state.active && focusField.slot,
    style
  ) ?? "";

/** One square: the character at `index`, and the focus edge when typing goes there. */
export const InputOTPSlot = ({ index, style }: InputOTPSlotProps) => {
  const size = useContext(SlotSize);
  const readOnly = useContext(SlotReadOnly);
  return (
    <OTPInputSlot
      index={index}
      data-slot="input-otp-slot"
      className={(state: OTPInputSlotState) =>
        slotClass(size, readOnly, state, style)
      }
    />
  );
};

/** The dash between two runs. */
export const InputOTPSeparator = ({ style }: InputOTPSeparatorProps) => (
  <OTPInputSeparator
    data-slot="input-otp-separator"
    {...stylex.props(styles.separator, style)}
  >
    <Icon icon={MinusIcon} />
  </OTPInputSeparator>
);
