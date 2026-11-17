// CheckboxGroup: checkboxes that make one answer, under one name: one list of checked values,
// sent under one name, and a `parent` checkbox that selects them all. UI SDK's CheckboxGroup in a
// Field, so the group is named by its label and says its description and error.
//
//   <CheckboxGroup label="Notifications" defaultValue={["email"]} allValues={["email", "sms"]}>
//     <Checkbox parent label="Select all" />
//     <Checkbox nested value="email" label="Email" />
//     <Checkbox nested value="sms" label="Text message" />
//   </CheckboxGroup>
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { CheckboxGroup as CheckboxGroupPrimitive } from "@ui-sdk/react/checkbox";
import type { ComponentProps, ReactNode } from "react";

import { ChoiceGrouped, ChoiceOff } from "../choice/row";
import { Field, FieldDescription, FieldError, FieldLabel } from "../field";
import { grasp } from "../tokens/tokens.stylex";
import { CheckboxGroupContext } from "./checkbox";
import type { CheckboxLayoutStyle } from "./checkbox";

/** What a group takes, besides UI SDK's own options. */
interface CheckboxGroupOwnProps {
  /** @deprecated Use `FieldLabel`, in a Field around the group. */
  label?: ReactNode;
  /** @deprecated Use `FieldDescription`, in the Field around the group. */
  description?: ReactNode;
  /** @deprecated Use `FieldError`, in the Field around the group. */
  error?: string;
  /** Shows the group as wrong now, for an error your code decides. */
  invalid?: boolean;
  /** The values checked now, for a group your code holds. Pass `onValueChange` with it. */
  value?: string[];
  /** The values checked at first, when the group holds its own. A form reset returns to them. */
  defaultValue?: string[];
  /** Runs when the checked values change, with the new list and why. `details.cancel()` refuses it. */
  onValueChange?: (
    value: string[],
    details: Parameters<
      NonNullable<CheckboxGroupPrimitiveProps<string>["onValueChange"]>
    >[1]
  ) => void;
  /**
   * Every value its parent checkbox checks. Pass it with a parent, so "Select all" is right on
   * the first paint, before the checkboxes are counted.
   */
  allValues?: string[];
  /** The name every checked value is sent under. */
  name?: string;
  /**
   * Out of use: every checkbox in it, and its words, at half strength. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /**
   * A form will not send until at least one is checked; `error` says so.
   * @default false
   */
  required?: boolean;
  /** Its checkboxes: a `parent` one first if it has one, then one per value. */
  children: ReactNode;
  /** @deprecated Use `layout`. */
  style?: CheckboxLayoutStyle;
  /** Layout only: margins, alignment. The look belongs to the group. */
  layout?: CheckboxLayoutStyle;
}

type CheckboxGroupPrimitiveProps<T extends string> = ComponentProps<
  typeof CheckboxGroupPrimitive<T>
>;

/** Every prop a CheckboxGroup takes: the ones above, and UI SDK's CheckboxGroup options. */
export type CheckboxGroupProps<T extends string = string> =
  CheckboxGroupOwnProps &
    Omit<
      CheckboxGroupPrimitiveProps<T>,
      "className" | "style" | "children" | "render"
    >;

const styles = stylex.create({
  // A group: its name and description, its checkboxes, then its error.
  list: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
    // The first row's words as far from the description as the rows' words stand from each other
    // (24px): every row keeps the 44px a finger needs, so the rows set the step and the first one
    // keeps it too, rather than standing closer to the name than to the next row.
    marginBlockStart: grasp.space1,
  },
});

export const CheckboxGroup = <T extends string = string>({
  label,
  description,
  error,
  invalid,
  children,
  style: styleProp,
  layout,
  disabled,
  ...rest
}: CheckboxGroupProps<T>) =>
  // The parts shape: the checkboxes only. The Field around the group names it and says its error.
  label === undefined ? (
    <CheckboxGroupPrimitive<T>
      {...rest}
      disabled={disabled}
      {...stylex.props(styles.list, layout ?? styleProp)}
    >
      <ChoiceGrouped value>
        <ChoiceOff value={disabled === true}>
          <CheckboxGroupContext value={{ grouped: true, disabled, invalid }}>
            {children}
          </CheckboxGroupContext>
        </ChoiceOff>
      </ChoiceGrouped>
    </CheckboxGroupPrimitive>
  ) : (
    <Field invalid={invalid} disabled={disabled} layout={layout ?? styleProp}>
      <FieldLabel>{label}</FieldLabel>
      {description !== undefined && (
        <FieldDescription>{description}</FieldDescription>
      )}
      <CheckboxGroupPrimitive<T>
        {...rest}
        disabled={disabled}
        {...stylex.props(styles.list)}
      >
        <ChoiceGrouped value>
          <ChoiceOff value={disabled === true}>
            <CheckboxGroupContext value={{ grouped: true, disabled, invalid }}>
              {children}
            </CheckboxGroupContext>
          </ChoiceOff>
        </ChoiceGrouped>
      </CheckboxGroupPrimitive>
      {error !== undefined && error !== "" && <FieldError>{error}</FieldError>}
    </Field>
  );
