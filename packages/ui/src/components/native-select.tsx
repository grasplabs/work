// Native select: the browser's own <select>, in the field box every field shares,
// in StyleX, wired to the Field round it by UI SDK's FieldControl. Closed it is Select's trigger to
// the pixel (Input's fill, hairline, lift, heights, corner and focus edge, the chevron at its end);
// open it is the system's own list: the wheel on a phone, the platform's menu on a computer.
//
//   <Field>
//     <FieldLabel>Release channel</FieldLabel>
//     <NativeSelect name="channel" defaultValue="stable">
//       <NativeSelectOption value="stable">Stable</NativeSelectOption>
//       <NativeSelectOption value="beta">Beta</NativeSelectOption>
//     </NativeSelect>
//   </Field>
//
// For a form that posts as it is, a long list on a phone, and anything a test or a script sets
// with a select's own value: it is a <select>, so `name`, `value`, `onChange`, `required`, a form's
// reset and `selectOption` work as they do on any. Select draws its own list instead (a
// description under an item, a ghost look, the agent bridge); Combobox finds an item by typing.
// A first option with the value "" and words is its placeholder, shown muted while chosen.
"use client";

import * as stylex from "@stylexjs/stylex";
import { FieldControl } from "@ui-sdk/react/field";
import type { FieldState } from "@ui-sdk/react/field";
import { mergeProps } from "@ui-sdk/react/primitive";
import { useEffect, useRef } from "react";
import type { ComponentProps, ReactNode, Ref } from "react";

import { ChevronDownIcon, Icon } from "../lib/icons";
import { focusField, inputStyles, tapTarget } from "../lib/styles";
import { colors, size, space } from "../lib/tokens.stylex";
import { assignRef, isInvalid, warnUnnamed } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars } from "../lib/vars.stylex";

/** The height: Input's, Select's and Button's. */
export type NativeSelectSize = "sm" | "default" | "lg";

/** Every prop a NativeSelect takes: these, and the rest of a <select>'s. */
export interface NativeSelectProps extends Omit<
  ComponentProps<"select">,
  "className" | "style" | "size" | "multiple" | "children" | "ref"
> {
  /** Its NativeSelectOptions, perhaps in NativeSelectOptGroups. */
  children: ReactNode;
  /**
   * The height, the same as Input's, Select's and Button's: `sm` 32px, `default` 36px, `lg` 44px.
   * Words are 16px on a phone or a touch screen at every size, so the phone does not zoom in.
   * @default "default"
   */
  size?: NativeSelectSize;
  /** The value chosen at first, when the select holds its own. A form reset returns here. */
  defaultValue?: string;
  /** The value, when you keep it in state. Pair it with `onChange`. */
  value?: string;
  /** The name the value is sent under in a form. Inside a Field, the Field's `name` serves. */
  name?: string;
  /**
   * Needs a value other than "" before the form is sent. Inside a Field, its label shows the
   * required mark and its FieldError says why.
   * @default false
   */
  required?: boolean;
  /**
   * Out of use: not focusable, not sent, half strength. Say why near it. Inside a Field, the
   * Field's `disabled` serves.
   * @default false
   */
  disabled?: boolean;
  /** Its name when no FieldLabel names it, as a screen reader says it ("Sort by"). */
  "aria-label"?: string;
  /** Layout only: margins, alignment and width. Colours, heights and corners belong to the select. */
  style?: LayoutStyle;
  /** The <select> itself, to focus it or read it. */
  ref?: Ref<HTMLSelectElement>;
}

/** Every prop a NativeSelectOption takes: one choice, an <option>. */
export interface NativeSelectOptionProps extends Omit<
  ComponentProps<"option">,
  "className" | "style" | "children"
> {
  /** What the select's value becomes when it is chosen. "" for the placeholder. */
  value: string;
  /** Its words. */
  children: string;
  /**
   * Cannot be chosen; shown, greyed, in the list.
   * @default false
   */
  disabled?: boolean;
}

/** Every prop a NativeSelectOptGroup takes: a run of options under a name, an <optgroup>. */
export interface NativeSelectOptGroupProps extends Omit<
  ComponentProps<"optgroup">,
  "className" | "style" | "children" | "label"
> {
  /**
   * The group's name ("Europe"), shown above its options and never chosen: the <optgroup>'s
   * `label`, the one way the browser names a group, as CommandGroup's `heading` names its own.
   */
  heading: string;
  /** Its NativeSelectOptions. */
  children: ReactNode;
  /**
   * Every option in it out of use.
   * @default false
   */
  disabled?: boolean;
}

// ---- The look --------------------------------------------------------------------------------------

// The placeholder chosen: the first option, with the value "".
const PLACEHOLDER = ':has(> option[value=""]:checked)';

const styles = stylex.create({
  // Closed: Select's trigger, as Input draws a field (lib/styles' inputStyles: the box, the
  // control's base, the height, corner, hover, focus edge, wrong and out of use).
  select: {
    flexGrow: 1,
    color: {
      default: colors.foreground,
      [PLACEHOLDER]: colors.mutedForeground,
    },
    // The chosen words stay on one line and end in an ellipsis before the chevron.
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    // The words where Select's stand; at the end, room for the chevron where Select draws it.
    paddingInlineStart: space[3],
    paddingInlineEnd: `calc(${space[2]} + ${size.iconSm} + ${space[2]})`,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
  },
  // The list is the system's: its rows in the ink on the raised ground, in light and dark (a
  // computer that draws the list from the page's colours), whatever the closed control shows. An
  // option out of use is not coloured, so it keeps the browser's own grey.
  option: {
    backgroundColor: colors.popover,
    color: { default: null, ":enabled": colors.foreground },
  },
  // Select's chevron: at the end, space-2 in, in muted. It lets presses through to the select.
  chevron: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "absolute",
    insetBlock: 0,
    insetInlineEnd: space[2],
    display: "flex",
    alignItems: "center",
    color: colors.mutedForeground,
    pointerEvents: "none",
  },
  chevronDisabled: { opacity: size.opacityDisabled },
});

/**
 * The finger's 44px round the select on a touch screen (tapTarget) opens it as a press on
 * the select does: the system's list where the browser can open it from code, focus elsewhere,
 * which on a phone brings the same wheel. A pointer's extension of a control the keys reach already.
 */
const opener =
  (select: () => HTMLSelectElement | null) =>
  (target: HTMLSpanElement | null) => {
    const open = () => {
      const control = select();
      if (control === null || control.disabled) {
        return;
      }
      control.focus();
      try {
        control.showPicker();
      } catch {
        // Refused (no list from code here, or no press behind it): focused, as a tap leaves it.
      }
    };
    const listening = new AbortController();
    target?.addEventListener("click", open, { signal: listening.signal });
    return () => {
      listening.abort();
    };
  };

const sizeStyles = {
  sm: inputStyles.sm,
  default: inputStyles.default,
  lg: inputStyles.lg,
} as const;

/** A native <select> in the field box, with Select's chevron at its end. */
export const NativeSelect = ({
  children,
  size: scale = "default",
  id,
  name,
  disabled,
  required,
  "aria-describedby": describedBy,
  style,
  ref,
  ...rest
}: NativeSelectProps) => {
  // The <select>, found in the box once it is there: FieldControl's own ref is typed for an input.
  const own = useRef<HTMLSelectElement | null>(null);
  const attach = (box: HTMLDivElement | null) => {
    own.current = box?.querySelector("select") ?? null;
    assignRef(ref, own.current);
  };
  // In development, say so when nothing names it: no Field label, no aria-label.
  useEffect(() => {
    warnUnnamed("NativeSelect", own.current);
  }, []);

  return (
    <div
      ref={attach}
      data-slot="native-select-wrapper"
      {...stylex.props(inputStyles.box, style)}
    >
      <span
        aria-hidden="true"
        ref={opener(() => own.current)}
        {...stylex.props(tapTarget)}
      />
      <FieldControl
        // What the Field merges with its own: its id wins, its description joins the caller's.
        id={id}
        name={name}
        disabled={disabled}
        required={required}
        aria-describedby={describedBy}
        // The Field's wiring and state go on our own <select>, with the caller's other props (a
        // caller's handler runs before the Field's), styled from them.
        render={(props: Record<string, unknown>, state: FieldState) => {
          const off = state.disabled || props.disabled === true;
          return (
            <>
              <select
                {...mergeProps(props, rest)}
                data-slot="native-select"
                {...stylex.props(
                  inputStyles.control,
                  styles.select,
                  sizeStyles[scale],
                  !off && inputStyles.enabled,
                  off && inputStyles.disabled,
                  isInvalid(props["aria-invalid"]) && inputStyles.invalid,
                  focusField.default
                )}
              >
                {children}
              </select>
              <span
                aria-hidden="true"
                data-slot="native-select-icon"
                {...stylex.props(styles.chevron, off && styles.chevronDisabled)}
              >
                <Icon icon={ChevronDownIcon} />
              </span>
            </>
          );
        }}
      />
    </div>
  );
};

/** One choice: an <option>, in the list's ink on its ground. */
export const NativeSelectOption = ({
  children,
  ...rest
}: NativeSelectOptionProps) => (
  <option
    {...rest}
    data-slot="native-select-option"
    {...stylex.props(styles.option)}
  >
    {children}
  </option>
);

/** A run of options under a name: an <optgroup>. */
export const NativeSelectOptGroup = ({
  heading,
  children,
  ...rest
}: NativeSelectOptGroupProps) => (
  <optgroup
    {...rest}
    label={heading}
    data-slot="native-select-optgroup"
    {...stylex.props(styles.option)}
  >
    {children}
  </optgroup>
);
