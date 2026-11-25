// NumberField: a field for a number, with a step down and a step up at its end,
// built on UI SDK's Number Input. It keeps the number while it
// shows it formatted for the page's language ("1,234.5" or "1.234,5"), and it stands level with
// Input: the same field edge, fill, focus and three heights.
//
//   <Field name="seats">
//     <FieldLabel>Seats</FieldLabel>
//     <NumberField min={1} max={50} defaultValue={5} />
//   </Field>
//   <NumberField aria-label="Weight" suffix="kg" step={0.5} />
//   <NumberField aria-label="Budget" prefix="€" format={{ maximumFractionDigits: 2 }} />
//
// ArrowUp and ArrowDown step, Page Up and Page Down (or Shift, with an arrow or a step) go a large
// step, Alt with an arrow a small one, Home and End go to the ends. A typed number past an end is
// brought to it when the field is left. The wheel never steps it. The steps stay out of the Tab
// order: the arrow keys do the same.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  NumberInput as NumberInputPrimitive,
  NumberInputControl,
  NumberInputDecrement,
  NumberInputGroup,
  NumberInputIncrement,
} from "@ui-sdk/react/number-input";
import { useId } from "react";

import { useI18n } from "../lib/i18n";
import { Icon, MinusIcon, PlusIcon } from "../lib/icons";
import { focusField, tapTarget } from "../lib/styles";
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
import type { LayoutStyle } from "../lib/utils";
import { iconVars } from "../lib/vars.stylex";

/** Every prop a NumberField takes. */
export interface NumberFieldProps {
  /** The number, or `null` for none. Pass it with `onValueChange` to control it. */
  value?: number | null;
  /** The number it starts with, when you do not control it. A form reset returns here. */
  defaultValue?: number | null;
  /** Runs with the new number as it changes: each step, and each time what is typed is a number. */
  onValueChange?: (value: number | null) => void;
  /** Runs once a change is done: the field left, Enter pressed, a step let go. For saving. */
  onValueCommitted?: (value: number | null) => void;
  /** The lowest number. A lower one typed is raised to it when the field is left. */
  min?: number;
  /** The highest number. A higher one typed is lowered to it when the field is left. */
  max?: number;
  /**
   * How far one step goes. Numbers snap to steps counted from `min`, or from 0.
   * @default 1
   */
  step?: number;
  /**
   * How far Alt (Option on a Mac) with an arrow goes, for a fine change.
   * @default a tenth of a step
   */
  smallStep?: number;
  /**
   * How far Page Up, Page Down and Shift with an arrow or a step go.
   * @default ten steps
   */
  largeStep?: number;
  /** A sign before the number, inside the field: "€", "$". A screen reader hears it with the number. */
  prefix?: string;
  /** A unit after the number, inside the field: "kg", "seats". A screen reader hears it with the number. */
  suffix?: string;
  /** How the number shows: `Intl.NumberFormat` options, like `{ maximumFractionDigits: 2 }`. */
  format?: Intl.NumberFormatOptions;
  /**
   * The language its separators follow: the page's own `lang` once it runs, English before. Set it
   * where the server's first paint should already match.
   */
  locale?: string;
  /**
   * The height: `sm` 32px, `default` 36px, `lg` 44px, as Input's.
   * @default "default"
   */
  size?: "sm" | "default" | "lg";
  /** The name it is sent under in a form, as a plain number ("1234.5"). Inside a Field, the Field's `name` serves. */
  name?: string;
  /** Needs a number before the form is sent. @default false */
  required?: boolean;
  /** Can be read and copied, not changed. @default false */
  readOnly?: boolean;
  /** Out of use: not focusable, not sent. @default false */
  disabled?: boolean;
  /** Its name when no FieldLabel names it. */
  "aria-label"?: string;
  /** A hint while it is empty, such as an example number. */
  placeholder?: string;
  /** The id of a form it belongs to, when it stands outside it. */
  form?: string;
  /** Layout only: where it sits and how wide it is. */
  style?: LayoutStyle;
}

const HOVER = media.hover;
const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;
const TYPING = media.maxSmOrCoarse;
const OFF = ":has(input:disabled)";
const READ = ":has(input:read-only:not(:disabled))";
const WRONG = ":has(input[aria-invalid=true])";

const styles = stylex.create({
  // The field: its edge, fill and focus are drawn on the box, so the affixes and the steps sit inside.
  box: {
    [iconVars.size]: sizes.iconSm,
    [iconVars.stroke]: sizes.iconStroke,
    position: "relative",
    display: "flex",
    alignItems: "stretch",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    // In forced colours a real edge; a wrong field's turns dashed, the same 1px, as the destructive
    // tint is dropped there.
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: {
      default: "solid",
      [FORCED]: { default: "solid", [WRONG]: "dashed" },
    },
    borderColor: "currentColor",
    backgroundColor: { default: colors.inputBg, [READ]: colors.inputBgRead },
    boxShadow: {
      default: `inset 0 0 0 1px ${colors.input}, ${shadow.inputShadow}`,
      // Hover only on a field open for typing and not wrong: never over invalid, read only or disabled.
      ":hover:not(:focus-within):has(input:read-write:not([aria-invalid=true]))":
        {
          default: null,
          [HOVER]: `inset 0 0 0 1px ${colors.inputBorderHover}, ${shadow.inputShadow}`,
        },
      ":focus-within": sizes.inputFocus,
      [WRONG]: {
        default: sizes.inputInvalid,
        ":focus-within": sizes.inputFocusInvalid,
      },
      // Read only: settled, its hairline and no lift; disabled the same, dimmed below.
      [READ]: {
        default: `inset 0 0 0 1px ${colors.input}`,
        ":focus-within": sizes.inputFocusRead,
      },
      [OFF]: `inset 0 0 0 1px ${colors.input}`,
    },
    opacity: { default: 1, [OFF]: sizes.opacityDisabled },
    transitionProperty: "box-shadow, background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
    fontFamily: font.sans,
    fontSize: { default: font.textSm, [TYPING]: sizes.inputTextTouch },
    lineHeight: font.textSmLine,
  },
  // Each size sets its height and its corner, which the last step's fill meets.
  sm: {
    "--number-corner": `min(${radius.xl}, calc(${sizes.controlSm} / 2))`,
    minHeight: sizes.controlSm,
    borderRadius: "var(--number-corner)",
    cornerShape: radius.shape,
  },
  default: {
    "--number-corner": `min(${radius.xl}, calc(${sizes.controlDefault} / 2))`,
    minHeight: sizes.controlDefault,
    borderRadius: "var(--number-corner)",
    cornerShape: radius.shape,
  },
  lg: {
    "--number-corner": `min(${radius.xl}, calc(${sizes.controlLg} / 2))`,
    minHeight: sizes.controlLg,
    borderRadius: "var(--number-corner)",
    cornerShape: radius.shape,
  },
  input: {
    flexGrow: 1,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    margin: 0,
    paddingBlock: 0,
    // Every size starts its words at space-3 from the edge, as Input does, so a stacked form keeps one line.
    paddingInline: space[3],
    appearance: "none",
    borderWidth: 0,
    backgroundColor: "transparent",
    outline: "none",
    // Read only: the number a step quieter, as Input's.
    color: {
      default: colors.foreground,
      ":read-only:not(:disabled)": colors.inputForegroundRead,
    },
    caretColor: colors.foreground,
    font: "inherit",
    fontVariantNumeric: "tabular-nums",
    // A number too long for the field ends in an ellipsis, never cut off without a sign.
    textOverflow: "ellipsis",
    "::selection": {
      backgroundColor: colors.inputSelection,
      color: colors.foreground,
    },
    // Above its touch area, so a press on the number puts the caret where it lands.
    position: "relative",
    cursor: { default: "text", ":disabled": "not-allowed" },
    "::placeholder": { color: colors.mutedForeground, opacity: 1 },
  },
  // A sign or a unit beside the number: the words start or end the field, in muted.
  affix: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    color: colors.mutedForeground,
    whiteSpace: "nowrap",
    userSelect: "none",
  },
  prefix: { paddingInlineStart: space[3] },
  suffix: { paddingInlineEnd: space[2] },
  // With a sign before it, the number starts close after it.
  afterPrefix: { paddingInlineStart: space[1] },
  // With a unit after it, the number ends close before it.
  beforeSuffix: { paddingInlineEnd: space[1] },
  // The steps: two columns at the end, as tall as the field, each control-sm wide at every size, so
  // stacked fields of different sizes keep their steps in one column; 44px wide on a touch screen.
  step: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: { default: sizes.controlSm, [COARSE]: sizes.tapTarget },
    margin: 0,
    padding: 0,
    borderWidth: 0,
    // Only a step that can step lights up.
    backgroundColor: {
      default: "transparent",
      ":hover:not([data-disabled])": {
        default: null,
        [HOVER]: colors.accent,
      },
      ":active:not([data-disabled])": colors.accentActive,
    },
    color: {
      default: colors.mutedForeground,
      ":is([data-disabled])": colors.subtleForeground,
      [FORCED]: { default: "ButtonText", ":is([data-disabled])": "GrayText" },
    },
    cursor: { default: "pointer", ":is([data-disabled])": "not-allowed" },
    touchAction: "manipulation",
    WebkitTapHighlightColor: "transparent",
  },
  // A read-only number cannot be stepped: its steps are as quiet as a disabled field's, with no fill
  // or pointer, so they never read as live.
  stepStill: {
    backgroundColor: "transparent",
    color: { default: colors.subtleForeground, [FORCED]: "GrayText" },
    opacity: sizes.opacityDisabled,
    cursor: "default",
  },
  // The last step meets the field's corner, so its fill does too.
  stepEnd: {
    borderStartEndRadius: "var(--number-corner)",
    borderEndEndRadius: "var(--number-corner)",
    cornerShape: radius.shape,
  },
});

/** The ids of the words that describe the field, the sign and the unit, for those it has. */
const describedBy = (parts: [string | undefined, string][]) => {
  const ids = parts
    .filter(([words]) => words !== undefined && words !== "")
    .map(([, id]) => id);
  return ids.length > 0 ? ids.join(" ") : undefined;
};

/** A number, typed or stepped, formatted for the page's language and kept between its ends. */
export const NumberField = ({
  value,
  defaultValue,
  onValueChange,
  onValueCommitted,
  min,
  max,
  step,
  smallStep,
  largeStep,
  prefix,
  suffix,
  format,
  locale,
  size = "default",
  name,
  required,
  readOnly,
  disabled,
  "aria-label": ariaLabel,
  placeholder,
  form,
  style,
}: NumberFieldProps) => {
  const words = useI18n().numberField;
  // The sign and the unit are said with the number: they describe the field, beside its own words.
  const prefixId = useId();
  const suffixId = useId();
  const described = describedBy([
    [prefix, prefixId],
    [suffix, suffixId],
  ]);
  return (
    <NumberInputPrimitive
      value={value}
      defaultValue={defaultValue}
      onValueChange={
        onValueChange
          ? (next: number | null) => {
              onValueChange(next);
            }
          : undefined
      }
      onValueCommit={
        onValueCommitted
          ? (next: number | null) => {
              onValueCommitted(next);
            }
          : undefined
      }
      min={min}
      max={max}
      step={step}
      smallStep={smallStep}
      largeStep={largeStep}
      format={format}
      locale={locale}
      name={name}
      required={required}
      readOnly={readOnly}
      disabled={disabled}
      form={form}
      render={<div data-slot="number-field" />}
      {...stylex.props(style)}
    >
      {/* The group needs no name of its own: the field's label names the number. */}
      <NumberInputGroup
        role="none"
        render={<div data-slot="number-field-group" />}
        {...stylex.props(styles.box, styles[size], focusField.within)}
      >
        <span aria-hidden="true" {...stylex.props(tapTarget)} />
        {prefix !== undefined && prefix !== "" ? (
          <span id={prefixId} {...stylex.props(styles.affix, styles.prefix)}>
            {prefix}
          </span>
        ) : null}
        <NumberInputControl
          aria-label={ariaLabel}
          aria-describedby={described}
          placeholder={placeholder}
          render={<input data-slot="number-field-input" />}
          {...stylex.props(
            styles.input,
            Boolean(prefix) && styles.afterPrefix,
            Boolean(suffix) && styles.beforeSuffix
          )}
        />
        {suffix !== undefined && suffix !== "" ? (
          <span id={suffixId} {...stylex.props(styles.affix, styles.suffix)}>
            {suffix}
          </span>
        ) : null}
        <NumberInputDecrement
          aria-label={words.decrement}
          render={
            <button
              type="button"
              aria-label={words.decrement}
              data-slot="number-field-decrement"
            />
          }
          {...stylex.props(styles.step, readOnly === true && styles.stepStill)}
        >
          <span aria-hidden="true" {...stylex.props(tapTarget)} />
          <Icon icon={MinusIcon} />
        </NumberInputDecrement>
        <NumberInputIncrement
          aria-label={words.increment}
          render={
            <button
              type="button"
              aria-label={words.increment}
              data-slot="number-field-increment"
            />
          }
          {...stylex.props(
            styles.step,
            styles.stepEnd,
            readOnly === true && styles.stepStill
          )}
        >
          <span aria-hidden="true" {...stylex.props(tapTarget)} />
          <Icon icon={PlusIcon} />
        </NumberInputIncrement>
      </NumberInputGroup>
    </NumberInputPrimitive>
  );
};
