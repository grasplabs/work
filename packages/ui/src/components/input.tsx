// Input: one line of text,
// in StyleX, built on UI SDK's Input, with the field box every text field shares
// (lib/styles' inputStyles, as Textarea and InputGroup draw it): a white fill, a hairline that can
// be found on every ground, one corner, and the heights of Button, so a field and a button stand
// level in one row. With it, PasswordInput, a password with a show button, and SecretInput, a key
// pasted once.
//
//   <Field>
//     <FieldLabel>Work email</FieldLabel>
//     <Input type="email" autoComplete="email" required />
//   </Field>
//   <Input aria-label="Search projects" type="search" />       no visible label: aria-label names it
//   <Input secret />                                             an agent may fill it, never read it
//   <PasswordInput autoComplete="new-password" />
//   <SecretInput maskedValue="9c1e" onReplace={…} />             a saved key: its last four, and Replace
//
// A Field round any of them names it, describes it and says when it is wrong; the field needs no
// ids and no spread. A caller may set layout and width only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  InputGroup as BoxPrimitive,
  Input as InputPrimitive,
} from "@ui-sdk/react/input";
import type { InputState } from "@ui-sdk/react/input";
import {
  PasswordInput as PasswordInputPrimitive,
  PasswordInputControl,
  PasswordInputToggle,
} from "@ui-sdk/react/password-input";
import type { PasswordInputState } from "@ui-sdk/react/password-input";
import { useEffect, useRef } from "react";
import type { ClipboardEvent, ComponentProps, Ref } from "react";

import { useRunsLong } from "../hooks/use-runs-long";
import { useI18n } from "../lib/i18n";
import { EyeIcon, EyeOffIcon, Icon } from "../lib/icons";
import type { IconData } from "../lib/icons";
import {
  focusField,
  focusRing,
  inputStyles,
  tapTarget,
  valueFade,
  valueFits,
} from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { assignRef, className, isInvalid, warnUnnamed } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars } from "../lib/vars.stylex";
import { InputGroup, InputGroupButton, InputGroupInput } from "./input-group";

/** The height: the same as Button's. */
export type InputSize = "sm" | "default" | "lg";

type PrimitiveProps = ComponentProps<typeof InputPrimitive>;

/** Every prop an Input takes: these, and the rest of UI SDK's Input and an <input>. */
export interface InputProps extends Omit<
  PrimitiveProps,
  "className" | "style" | "render" | "size" | "children" | "width" | "height"
> {
  /**
   * The height, the same as Button's: `sm` 32px, `default` 36px, `lg` 44px. On a touch screen
   * every size has a 44px target and 16px words.
   * @default "default"
   */
  size?: InputSize;
  /**
   * What kind of text: `text`, `email`, `password`, `search`, `tel` or `url`. It brings the right
   * keyboard on a phone and the browser's own check. `time` is a time of day in the field's look:
   * typed or stepped with the arrow keys, a phone's own picker on a tap; its value is `HH:mm`.
   * @default "text"
   */
  type?: "text" | "email" | "password" | "search" | "tel" | "url" | "time";
  /**
   * Words a machine reads, in the system's mono face: a cron line, an id, a key. A step smaller,
   * on the same line, so the field keeps its height; 16px on a touch screen as every field is.
   * @default false
   */
  mono?: boolean;
  /**
   * The value it starts with. A form reset returns here. For a value you keep in state, pass
   * `value` and `onValueChange` instead.
   */
  defaultValue?: string;
  /** The value, when you keep it in state. Pair it with `onValueChange`. */
  value?: string;
  /**
   * Called with the new value and why it changed: typing (`input-change`), a form reset (`reset`),
   * or code and agents (`imperative`). `details.source` is `"agent"` when an agent changed it, and
   * `details.cancel()` keeps the value as it was.
   */
  onValueChange?: PrimitiveProps["onValueChange"];
  /**
   * An example of what goes in, never the label or an instruction ("name@example.com"). It goes
   * when typing starts, so what the field is for belongs in its label.
   */
  placeholder?: string;
  /**
   * Needs a value before the form is sent. Inside a Field, its label shows the required mark.
   * @default false
   */
  required?: boolean;
  /**
   * Can be read, selected and copied, and is sent with the form, but not changed. Drawn on a
   * quieter fill, with no hover, caret or focus ring, so it does not invite typing; focus from the
   * keys darkens its hairline, with no halo.
   * @default false
   */
  readOnly?: boolean;
  /**
   * Out of use: not focusable, not sent, half strength. Say why near it. Prefer `readOnly` for a
   * value someone may still want to copy.
   * @default false
   */
  disabled?: boolean;
  /**
   * An agent may fill it in but never read it back: a key, a token, a tax number. Passwords are
   * secret without it.
   * @default false
   */
  secret?: boolean;
  /** An icon at the start, when it says what goes in faster than the label alone: SearchIcon, from lib/icons. */
  icon?: IconData;
  /** Layout only: margins, alignment and width. Colours, heights and corners belong to the input. */
  style?: LayoutStyle;
  /** The <input> itself, to focus it or read it. */
  ref?: Ref<HTMLInputElement>;
}

// ---- The look --------------------------------------------------------------------------------------

const HOVER = media.hover;
const TYPING = media.maxSmOrCoarse;
// Focus from the keys, never after a press (lib/styles marks a pointer's focus).
const KEYBOARD = ":focus-visible:not([data-focus-pointer])";

const styles = stylex.create({
  // An icon at the start: it stands over the input, in muted, and lets presses through to it.
  icon: {
    [iconVars.size]: sizes.iconSm,
    [iconVars.stroke]: sizes.iconStroke,
    position: "absolute",
    zIndex: 1,
    insetBlock: 0,
    insetInlineStart: space[3],
    display: "flex",
    alignItems: "center",
    color: colors.mutedForeground,
    pointerEvents: "none",
  },
  // The words start after the icon and the gap beside it.
  iconStart: {
    paddingInlineStart: `calc(${space[3]} + ${sizes.iconSm} + ${space[2]})`,
  },
  // Over inputStyles.control, which sets it above its touch target (so a press on the words puts
  // the caret where it lands), its fill, edge and words.
  input: {
    flexGrow: 1,
    caretColor: colors.foreground,
    letterSpacing: "normal",
    // A placeholder too long for the field ends in an ellipsis, never mid-word: Chromium reads the
    // input's own text-overflow for its placeholder, so it is set while the placeholder shows. A
    // typed value fades instead (below).
    textOverflow: { default: "clip", ":placeholder-shown": "ellipsis" },
    paddingInline: space[3],
    // A value longer than the field fades out at its end (valueFade, lib/styles).
    // One look for clearing a field in the library: InputGroupClear. A search field shows no cross
    // of the browser's; Escape still empties it where the browser does that. display: none, not
    // appearance: none: WebKit draws its own cross with appearance none too.
    "::-webkit-search-cancel-button": { display: "none" },
    // A time field in one look in every engine: Chromium's clock button goes (Firefox and Safari
    // draw none on a computer); its parts sit on the field's own line.
    "::-webkit-calendar-picker-indicator": { display: "none" },
    "::-webkit-datetime-edit": { padding: 0 },
    // Selected words in the system's own tone, never the browser's blue.
    "::selection": {
      backgroundColor: colors.inputSelection,
      color: colors.foreground,
    },
    "::placeholder": {
      color: colors.mutedForeground,
      // Its own colour, not the transparent fill the value's fade sets on the input.
      WebkitTextFillColor: colors.mutedForeground,
      opacity: 1,
      textOverflow: "ellipsis",
    },
  },

  // Words a machine reads: the mono face a step smaller, on the same line.
  mono: {
    fontFamily: font.mono,
    fontSize: { default: font.textXs, [TYPING]: sizes.inputTextTouch },
  },
  // Can be read and copied, not changed: settled. The soft ground, a hairline and no lift or hover,
  // its words a step quieter; disabled is the weaker look. Nothing says type here: no caret, the
  // default cursor, no focus ring. Focus from the keys shows as the hairline one step stronger.
  readOnly: {
    backgroundColor: colors.inputBgRead,
    boxShadow: {
      default: `inset 0 0 0 1px ${colors.input}`,
      [KEYBOARD]: sizes.inputFocusRead,
    },
    color: colors.inputForegroundRead,
    caretColor: "transparent",
    cursor: "default",
  },
});

const sizeStyles = {
  sm: inputStyles.sm,
  default: inputStyles.default,
  lg: inputStyles.lg,
} as const;
/** Input, with the name of its box: Input's own, or SecretInput's. */
const TextInput = ({
  slot,
  size = "default",
  type = "text",
  secret = false,
  mono = false,
  icon,
  style,
  ref,
  ...rest
}: InputProps & { slot: string }) => {
  const { setInput, long } = useRunsLong();
  // In development, say so when nothing names the input: no Field label, no aria-label.
  const own = useRef<HTMLInputElement | null>(null);
  const attach = (element: HTMLInputElement | null) => {
    own.current = element;
    setInput(element);
    assignRef(ref, element);
  };
  useEffect(() => {
    warnUnnamed("Input", own.current);
  }, []);

  return (
    <BoxPrimitive
      render={<div data-slot={slot} />}
      {...stylex.props(inputStyles.box, style)}
    >
      <span aria-hidden="true" {...stylex.props(tapTarget)} />
      {icon && (
        <span aria-hidden="true" {...stylex.props(styles.icon)}>
          <Icon icon={icon} />
        </span>
      )}
      <InputPrimitive
        {...rest}
        type={type}
        ref={attach}
        data-agent-secret={secret ? "" : undefined}
        // UI SDK's props (its ref among them) go on our own <input>, styled from its state.
        render={(props: Record<string, unknown>, state: InputState) => (
          <input
            {...props}
            data-slot="input"
            {...stylex.props(
              inputStyles.control,
              styles.input,
              valueFade,
              !long && valueFits,
              sizeStyles[size],
              mono && styles.mono,
              icon && styles.iconStart,
              !(state.disabled || state.readOnly) && inputStyles.enabled,
              state.readOnly && styles.readOnly,
              state.disabled && inputStyles.disabled,
              isInvalid(props["aria-invalid"]) && inputStyles.invalid,
              state.readOnly ? focusField.readOnly : focusField.default
            )}
          />
        )}
      />
    </BoxPrimitive>
  );
};

/** One line of text, in the field box every text field shares. */
export const Input = (props: InputProps) => (
  // UI SDK's own name for the box round the input, as it has always had.
  <TextInput {...props} slot="input-group" />
);

// ---- PasswordInput ---------------------------------------------------------------------------------

type PasswordPrimitiveProps = ComponentProps<typeof PasswordInputPrimitive>;

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
  onValueChange?: PasswordPrimitiveProps["onValueChange"];
  /** The height, as Input's: `sm` 32px, `default` 36px, `lg` 44px. @default "default" */
  size?: InputSize;
  /** The name it is sent under in a form. Inside a Field, the Field's `name` serves. */
  name?: string;
  /** Needs a value before the form is sent. @default false */
  required?: boolean;
  /** Can be shown but not changed. @default false */
  readOnly?: boolean;
  /** Out of use: not focusable, not sent, half strength. @default false */
  disabled?: boolean;
  /** A hint while it is empty, such as what length it needs. Never the only place a rule is said. */
  placeholder?: string;
  /** Its name when no FieldLabel names it. */
  "aria-label"?: string;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

const passwordStyles = stylex.create({
  // Room at the end for the button, so the words never run under it.
  roomSm: { paddingInlineEnd: `calc(${sizes.controlSm} + ${space[1]})` },
  roomDefault: {
    paddingInlineEnd: `calc(${sizes.controlDefault} + ${space[1]})`,
  },
  roomLg: { paddingInlineEnd: `calc(${sizes.controlLg} + ${space[1]})` },
  // The button: a square at the end, set in from the field's edge by space-1 on every side, so its
  // focus ring stands inside the field and never steps over its edge. Its icon stays centred in
  // the field's end square. In muted, ink under a pointer.
  toggle: {
    [iconVars.size]: sizes.iconSm,
    [iconVars.stroke]: sizes.iconStroke,
    position: "absolute",
    zIndex: 1,
    insetBlock: space[1],
    insetInlineEnd: space[1],
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    // Its corner nests inside the field's, space-1 in.
    borderRadius: `max(0px, calc(${radius.xl} - ${space[1]}))`,
    cornerShape: radius.shape,
    backgroundColor: "transparent",
    color: {
      default: colors.mutedForeground,
      ":hover": { default: null, [HOVER]: colors.foreground },
    },
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    transitionProperty: "color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  toggleSm: { width: `calc(${sizes.controlSm} - 2 * ${space[1]})` },
  toggleDefault: { width: `calc(${sizes.controlDefault} - 2 * ${space[1]})` },
  toggleLg: { width: `calc(${sizes.controlLg} - 2 * ${space[1]})` },
  // With a pointer, a press anywhere in the end square presses the button set in it. On a touch
  // screen it keeps to its own box (tapTarget): it stands inside the field's, and a target past it
  // would take the field's presses.
  toggleTarget: {
    "--tap-rest-inline": `calc(-1 * ${space[1]})`,
    "--tap-rest-block": `calc(-1 * ${space[1]})`,
    "--tap-reach": "0px",
  },
});

const roomStyles = {
  sm: passwordStyles.roomSm,
  default: passwordStyles.roomDefault,
  lg: passwordStyles.roomLg,
} as const;
const squareStyles = {
  sm: passwordStyles.toggleSm,
  default: passwordStyles.toggleDefault,
  lg: passwordStyles.toggleLg,
} as const;

/**
 * A password with a button that shows and hides it, on UI SDK's PasswordInput. The button keeps
 * the caret where it was, the field hides itself again when its form is sent, and an agent may
 * fill it but never read it back.
 */
export const PasswordInput = ({
  size = "default",
  autoComplete = "current-password",
  style,
  "aria-label": ariaLabel,
  placeholder,
  ...options
}: PasswordInputProps) => {
  const words = useI18n().input;
  return (
    <PasswordInputPrimitive
      {...options}
      autoComplete={autoComplete}
      {...stylex.props(inputStyles.box, style)}
    >
      <span aria-hidden="true" {...stylex.props(tapTarget)} />
      <PasswordInputControl
        aria-label={ariaLabel}
        placeholder={placeholder}
        render={(props: Record<string, unknown>, state: PasswordInputState) => (
          <input
            {...props}
            {...stylex.props(
              inputStyles.control,
              styles.input,
              valueFade,
              sizeStyles[size],
              roomStyles[size],
              !(state.disabled || state.readOnly) && inputStyles.enabled,
              state.readOnly && styles.readOnly,
              state.disabled && inputStyles.disabled,
              isInvalid(props["aria-invalid"]) && inputStyles.invalid,
              state.readOnly ? focusField.readOnly : focusField.default
            )}
          />
        )}
      />
      <PasswordInputToggle
        className={(state: PasswordInputState) =>
          className(
            passwordStyles.toggle,
            squareStyles[size],
            focusRing,
            state.disabled && inputStyles.disabled
          )
        }
      >
        {(state: PasswordInputState) => (
          <>
            <span
              aria-hidden="true"
              {...stylex.props(tapTarget, passwordStyles.toggleTarget)}
            />
            <Icon
              icon={state.visible ? EyeOffIcon : EyeIcon}
              label={state.visible ? words.hidePassword : words.showPassword}
            />
          </>
        )}
      </PasswordInputToggle>
    </PasswordInputPrimitive>
  );
};

// ---- SecretInput -----------------------------------------------------------------------------------

/** Every prop a SecretInput takes: an Input's, but never its type, its secret or its autoComplete. */
export type SecretInputProps = Omit<
  InputProps,
  "type" | "secret" | "autoComplete"
> & {
  /**
   * The last characters of the key already saved ("9c1e"): the field then shows only them, read
   * only, with Replace. Never the key itself; the host keeps that.
   */
  maskedValue?: string;
  /** Runs when Replace is pressed: the host clears `maskedValue`, and the field is empty and focused. */
  onReplace?: () => void;
};

// Each password manager's own mark for a field it must leave alone: 1Password, LastPass,
// Bitwarden, Dashlane.
const unmanaged = {
  "data-1p-ignore": "",
  "data-lpignore": "true",
  "data-bwignore": "",
  "data-form-type": "other",
} as const;

/** Pastes the clipboard's words whole, the spaces and line breaks round them taken off. */
const pasteTrimmed = (event: ClipboardEvent<HTMLInputElement>) => {
  const pasted = event.clipboardData.getData("text");
  const trimmed = pasted.trim();
  if (trimmed === pasted) {
    return;
  }
  event.preventDefault();
  const field = event.currentTarget;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  field.setRangeText(trimmed, start, end, "end");
  // Told as typing is, so the form and the host's state hear it.
  field.dispatchEvent(new Event("input", { bubbles: true }));
};

/**
 * A key, a token, a secret someone pastes once: masked, never offered to a password manager, never
 * read back by an agent, and pasted whole. Once it is saved the field never holds it again: it shows
 * only its last four, read only, with Replace, which empties it and puts the caret in it.
 */
export const SecretInput = ({
  maskedValue,
  onReplace,
  ref,
  ...rest
}: SecretInputProps) => {
  const words = useI18n().input;
  // Replace unmounts its own button: the new, empty field takes the caret once it is there.
  const replaced = useRef(false);
  const attach = (element: HTMLInputElement | null) => {
    assignRef(ref, element);
    if (element !== null && replaced.current) {
      replaced.current = false;
      element.focus();
    }
  };
  if (maskedValue !== undefined && maskedValue !== "") {
    return (
      <InputGroup style={rest.style}>
        <InputGroupInput
          readOnly
          dir="ltr"
          value={`…${maskedValue}`}
          aria-label={rest["aria-label"]}
        />
        <InputGroupButton
          onClick={() => {
            replaced.current = true;
            onReplace?.();
          }}
        >
          {words.replace}
        </InputGroupButton>
      </InputGroup>
    );
  }
  // A key reads left to right in every language: the field does too, in a right-to-left page.
  return (
    <TextInput
      {...rest}
      {...unmanaged}
      ref={attach}
      slot="secret-input"
      dir="ltr"
      type="password"
      secret
      autoComplete="off"
      spellCheck={false}
      onPaste={pasteTrimmed}
    />
  );
};
