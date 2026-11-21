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

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { RadioGroup as RadioGroupPrimitive } from "@ui-sdk/react/radio";
import type { ComponentProps, ReactNode } from "react";

import { ChoiceGrouped, ChoiceOff } from "../choice/row";
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
  /** @deprecated Use `FieldLabel`, in a Field around the group. */
  label?: ReactNode;
  /** @deprecated Use `aria-label` on the group, where the words around it already name it. */
  labelHidden?: boolean;
  /**
   * Its name, when no FieldLabel shows one: only where the words around the group already name it,
   * like a table's column. A screen reader and an agent say it.
   */
  "aria-label"?: string;
  /** @deprecated Use `FieldDescription`, in the Field around the group. */
  description?: ReactNode;
  /** @deprecated Use `FieldError`, in the Field around the group. */
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
  /** @deprecated Use `layout`. */
  style?: RadioLayoutStyle;
  /** Layout only: margins and alignment. The look belongs to the group. */
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
}: RadioGroupProps) =>
  // The parts shape: the radios only. The Field around the group names it and says its error.
  label === undefined ? (
    <RadioGroupPrimitive
      {...rest}
      disabled={disabled}
      {...stylex.props(
        styles.list,
        rest["aria-label"] !== undefined && styles.flush,
        layout ?? styleProp
      )}
    >
      <ChoiceGrouped value>
        <ChoiceOff value={disabled === true}>
          <RadioGroupContext value={{ disabled, invalid }}>
            {children}
          </RadioGroupContext>
        </ChoiceOff>
      </ChoiceGrouped>
    </RadioGroupPrimitive>
  ) : (
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
        <ChoiceGrouped value>
          <ChoiceOff value={disabled === true}>
            <RadioGroupContext value={{ disabled, invalid }}>
              {children}
            </RadioGroupContext>
          </ChoiceOff>
        </ChoiceGrouped>
      </RadioGroupPrimitive>
      {/* Only when there is something to say: an empty error would still take its gap. */}
      {error !== undefined && error !== "" && <FieldError>{error}</FieldError>}
    </Field>
  );
