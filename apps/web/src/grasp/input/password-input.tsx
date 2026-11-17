// PasswordInput: a password with a button that shows and hides it, on UI SDK's PasswordInput, with
// Input's look (input.tsx). The button keeps the caret where it was, the field hides itself again
// when its form is sent, and an agent may fill it but never read it back.
//
//   <Field>
//     <FieldLabel>Password</FieldLabel>
//     <PasswordInput autoComplete="current-password" />
//   </Field>
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  PasswordInput as PasswordInputPrimitive,
  PasswordInputControl,
  PasswordInputToggle,
} from "@ui-sdk/react/password-input";
import type { PasswordInputState } from "@ui-sdk/react/password-input";
import type { ComponentProps } from "react";

import { focus } from "../focus/focus";
import { Hide, Icon, Show } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { inputStyles, isInvalid, sizeStyles, targetStyles } from "./input";
import type { InputLayoutStyle, InputSize } from "./input";

type PrimitiveProps = ComponentProps<typeof PasswordInputPrimitive>;

/** Every prop a PasswordInput takes. */
export interface PasswordInputProps {
  /**
   * What a password manager fills in: `current-password` to sign in, `new-password` to choose
   * one.
   * @default "current-password"
   */
  autoComplete?: "current-password" | "new-password" | "off";
  /** The value it starts with. A form reset returns here. */
  defaultValue?: string;
  /** The value, when you keep it in state. Pair it with `onValueChange`. */
  value?: string;
  /** Called with the new value and why it changed. */
  onValueChange?: PrimitiveProps["onValueChange"];
  /** The height, as Input's: `sm` 32px, `md` 36px, `lg` 44px. @default "md" */
  size?: InputSize;
  /** The name it is sent under in a form. Inside a Field, the Field's `name` serves. */
  name?: string;
  /** Needs a value before the form is sent. @default false */
  required?: boolean;
  /** Can be shown but not changed. @default false */
  readOnly?: boolean;
  /** The name of the button that shows the password. @default "Show password" */
  showLabel?: string;
  /** The name of the button that hides it again. @default "Hide password" */
  hideLabel?: string;
  /** Out of use: not focusable, not sent, half strength. @default false */
  disabled?: boolean;
  /** A hint while it is empty, such as what length it needs. Never the only place a rule is said. */
  placeholder?: string;
  /** Its name when no FieldLabel names it. */
  "aria-label"?: string;
  /** Layout only: margins, alignment and width. */
  style?: InputLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: InputLayoutStyle;
}

const COARSE = media.coarse;
const HOVER = media.hover;

const styles = stylex.create({
  box: {
    position: "relative",
    display: "flex",
    alignItems: "stretch",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
  },
  // Room at the end for the button, so the words never run under it.
  roomSm: { paddingInlineEnd: `calc(${grasp.controlSm} + ${grasp.space1})` },
  roomMd: { paddingInlineEnd: `calc(${grasp.controlMd} + ${grasp.space1})` },
  roomLg: { paddingInlineEnd: `calc(${grasp.controlLg} + ${grasp.space1})` },
  // The button: a square at the end, set in from the field's edge by space-1 on every side, so its
  // focus ring stands inside the field and never steps over its edge (third look A3-text-02). Its
  // icon stays where it was, centred in the field's end square. In muted, ink under a pointer.
  toggle: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "absolute",
    zIndex: 1,
    insetBlock: grasp.space1,
    insetInlineEnd: grasp.space1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    // Its corner nests inside the field's, space-1 in.
    borderRadius: `max(0px, calc(${grasp.corner} - ${grasp.space1}))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: "transparent",
    color: {
      default: grasp.muted,
      ":hover": { default: null, [HOVER]: grasp.ink },
    },
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    transitionProperty: "color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  toggleSm: { width: `calc(${grasp.controlSm} - 2 * ${grasp.space1})` },
  toggleMd: { width: `calc(${grasp.controlMd} - 2 * ${grasp.space1})` },
  toggleLg: { width: `calc(${grasp.controlLg} - 2 * ${grasp.space1})` },
  // A finger needs 44px around the button too, centred on it as the button is set in.
  toggleTarget: {
    position: "absolute",
    inset: {
      default: `calc(-1 * ${grasp.space1})`,
      [COARSE]: `calc((100% - ${grasp.tap}) / 2)`,
    },
  },
});

const room = {
  sm: styles.roomSm,
  md: styles.roomMd,
  lg: styles.roomLg,
} as const;
const square = {
  sm: styles.toggleSm,
  md: styles.toggleMd,
  lg: styles.toggleLg,
} as const;

export const PasswordInput = ({
  size = "md",
  autoComplete = "current-password",
  style: styleProp,
  layout,
  "aria-label": ariaLabel,
  placeholder,
  showLabel = "Show password",
  hideLabel = "Hide password",
  ...options
}: PasswordInputProps) => (
  <PasswordInputPrimitive
    {...options}
    autoComplete={autoComplete}
    {...stylex.props(styles.box, layout ?? styleProp)}
  >
    <span
      aria-hidden="true"
      {...stylex.props(inputStyles.target, targetStyles[size])}
    />
    <PasswordInputControl
      aria-label={ariaLabel}
      placeholder={placeholder}
      render={(props: Record<string, unknown>, state: PasswordInputState) => (
        <input
          {...props}
          {...stylex.props(
            inputStyles.input,
            sizeStyles[size],
            room[size],
            !(state.disabled || state.readOnly) && inputStyles.live,
            state.readOnly && inputStyles.readOnly,
            state.disabled && inputStyles.disabled,
            isInvalid(props["aria-invalid"]) && inputStyles.invalid,
            focus.field
          )}
        />
      )}
    />
    <PasswordInputToggle
      className={(state: PasswordInputState) =>
        stylex.props(
          styles.toggle,
          square[size],
          focus.ring,
          state.disabled && inputStyles.disabled
        ).className
      }
    >
      {(state: PasswordInputState) => (
        <>
          <span aria-hidden="true" {...stylex.props(styles.toggleTarget)} />
          <Icon
            icon={state.visible ? Hide : Show}
            label={state.visible ? hideLabel : showLabel}
          />
        </>
      )}
    </PasswordInputToggle>
  </PasswordInputPrimitive>
);
