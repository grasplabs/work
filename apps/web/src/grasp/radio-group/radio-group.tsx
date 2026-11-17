// RadioGroup: one answer from a few choices, under one name, from shadcn's RadioGroup
// (registry/bases/base/ui/radio-group.tsx, on Base UI), converted from Tailwind to StyleX and
// rebuilt on UI SDK's RadioGroup in a Field: one value, one tab stop, arrow keys between its
// radios, and its name, description and error wired to it.
//
//   <RadioGroup label="Summary email" defaultValue="weekly" name="summary">
//     <Radio value="daily" label="Daily" />
//     <Radio value="weekly" label="Weekly" />
//     <Radio value="never" label="Never" />
//   </RadioGroup>
"use client";

import * as stylex from "@stylexjs/stylex";
import { RadioGroup as RadioGroupPrimitive } from "@ui-sdk/react/radio";
import type { ComponentProps, ReactNode } from "react";

import { Field, FieldDescription, FieldError, FieldLabel } from "../field";
import { visuallyHidden } from "../hidden/hidden";
import { grasp } from "../tokens/tokens.stylex";
import { RadioGroupContext } from "./radio";
import type { RadioLayoutStyle } from "./radio";

type RadioGroupPrimitiveProps<T extends string> = ComponentProps<
  typeof RadioGroupPrimitive<T>
>;

/** What a group takes, besides UI SDK's own options. */
interface RadioGroupOwnProps {
  /** The group's name, above it: the question its choices answer ("Summary email"). */
  label: ReactNode;
  /**
   * Hides the name, but keeps it for a screen reader and an agent: only where the words around
   * the group already name it, like a table's column.
   * @default false
   */
  labelHidden?: boolean;
  /** One sentence under the group's name. */
  description?: ReactNode;
  /** What is wrong and how to put it right ("Choose how often to hear from us"). */
  error?: string;
  /** Shows the group as wrong now, for an error your code decides. Give it an `error` too. */
  invalid?: boolean;
  /** The value chosen now, for a group your code holds; `null` for none. Pass `onValueChange`. */
  value?: string | null;
  /** The value chosen at first, when the group holds its own. A form reset returns to it. */
  defaultValue?: string | null;
  /**
   * Runs when the choice changes, with the new value and why (`details.reason`,
   * `details.source`). `details.cancel()` refuses it.
   */
  onValueChange?: (
    value: string | null,
    details: Parameters<
      NonNullable<RadioGroupPrimitiveProps<string>["onValueChange"]>
    >[1]
  ) => void;
  /** The name its value is sent under. */
  name?: string;
  /**
   * A form will not send until one is chosen; give `error` the words that say so.
   * @default false
   */
  required?: boolean;
  /**
   * Out of use: every radio in it, and its words, at half strength.
   * @default false
   */
  disabled?: boolean;
  /**
   * Shown as it is and still sent, but nothing changes the choice.
   * @default false
   */
  readOnly?: boolean;
  /** Its radios, in the order they are read. */
  children: ReactNode;
  /** Layout only: margins and alignment. The look belongs to the group. */
  style?: RadioLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: RadioLayoutStyle;
}

/** Every prop a RadioGroup takes: the ones above, and UI SDK's RadioGroup options. */
export type RadioGroupProps = RadioGroupOwnProps &
  Omit<
    RadioGroupPrimitiveProps<string>,
    keyof RadioGroupOwnProps | "className" | "render"
  >;

const styles = stylex.create({
  // The radios, one under the other.
  list: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
    // The first row's words as far from the description as the rows' words stand from each other
    // (24px): every row keeps the 44px a finger needs, so the rows set the step and the first one
    // keeps it too, rather than standing closer to the name than to the next row.
    marginBlockStart: grasp.space1,
  },
  // With its name hidden, the list does not reach up into the gap above it.
  flush: {
    marginBlockStart: 0,
  },
});

export const RadioGroup = ({
  label,
  labelHidden = false,
  description,
  error,
  invalid,
  children,
  style: styleProp,
  layout,
  disabled,
  ...rest
}: RadioGroupProps) => (
  <Field invalid={invalid} disabled={disabled} layout={layout ?? styleProp}>
    {labelHidden ? (
      <span {...stylex.props(visuallyHidden)}>
        <FieldLabel>{label}</FieldLabel>
      </span>
    ) : (
      <FieldLabel>{label}</FieldLabel>
    )}
    {description !== undefined && (
      <FieldDescription>{description}</FieldDescription>
    )}
    <RadioGroupPrimitive
      {...rest}
      disabled={disabled}
      {...stylex.props(styles.list, labelHidden && styles.flush)}
    >
      <RadioGroupContext value={{ disabled, invalid }}>
        {children}
      </RadioGroupContext>
    </RadioGroupPrimitive>
    {/* Only when there is something to say: an empty error would still take its gap. */}
    {error !== undefined && error !== "" && <FieldError>{error}</FieldError>}
  </Field>
);
