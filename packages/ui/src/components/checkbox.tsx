// Checkbox: a box you tick,
// in StyleX, built on UI SDK's Checkbox, which draws a button with the
// checkbox role beside a hidden native input, so a form sends it and an agent can check it by name.
// The checkbox draws its box only; its words are Field's parts, on a row at least 44px tall that a
// press on the box, its label or the space around them checks:
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Field orientation="horizontal">
//     <Checkbox />
//     <FieldContent>
//       <FieldLabel>Send me a weekly summary</FieldLabel>
//       <FieldDescription>Every Monday, the week in one email.</FieldDescription>
//     </FieldContent>
//   </Field>
//
// Checkboxes that make one answer share a CheckboxGroup, in a Field that names it; a `parent` box
// selects them all:
//
//   <Field>
//     <FieldLabel>Notifications</FieldLabel>
//     <CheckboxGroup defaultValue={["email"]} allValues={["email", "sms"]}>
//       <Field orientation="horizontal"><Checkbox parent /><FieldLabel>Select all</FieldLabel></Field>
//       <Field orientation="horizontal"><Checkbox nested value="email" /><FieldLabel>Email</FieldLabel></Field>
//       <Field orientation="horizontal"><Checkbox nested value="sms" /><FieldLabel>Text message</FieldLabel></Field>
//     </CheckboxGroup>
//   </Field>
//
// A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  CheckboxGroup as CheckboxGroupPrimitive,
  Checkbox as CheckboxPrimitive,
  CheckboxIndicator,
} from "@ui-sdk/react/checkbox";
import type { CheckboxState, CheckedState } from "@ui-sdk/react/checkbox";
import { use } from "react";
import type { ComponentProps, ReactNode } from "react";

import { CheckIcon, Icon, MinusIcon } from "../lib/icons";
import { choiceBoxStyles, choiceHitArea, focusRingOffset } from "../lib/styles";
import { font, radius, size, space } from "../lib/tokens.stylex";
import {
  ChoiceGroupContext,
  className,
  isInvalid,
  rowWiring,
} from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars } from "../lib/vars.stylex";
import { useFieldControl } from "./field";

export type { CheckedState } from "@ui-sdk/react/checkbox";

// ---- The box ------------------------------------------------------------------------------------
//
// The box looks and answers as RadioGroupItem's circle does (choiceBoxStyles in lib/styles), so the
// two stand in one column.

const styles = stylex.create({
  // An 18px square with the mark corner, on the first line of the words.
  box: {
    // The tick inside follows these.
    [iconVars.size]: size.checkboxMark,
    [iconVars.stroke]: size.checkboxMarkStroke,
    width: size.checkboxBox,
    height: size.checkboxBox,
    marginTop: `calc((${font.textSmLine} - ${size.checkboxBox}) / 2)`,
    borderRadius: radius.mark,
    cornerShape: radius.shape,
  },
  mark: {
    display: "grid",
    placeItems: "center",
  },
  // Under a parent checkbox: in by one box and its gap, so its box stands under the parent's words.
  nested: {
    marginInlineStart: `calc(${size.checkboxBox} + ${space[3]})`,
  },
  // A group: its checkboxes one under the other. The first row's words as far from the group's
  // description as the rows' words stand from each other: every row keeps the 44px a finger
  // needs, so the rows set the step and the first one keeps it too.
  group: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
    marginBlockStart: space[1],
  },
});

// ---- Checkbox -----------------------------------------------------------------------------------

type CheckboxPrimitiveProps = ComponentProps<typeof CheckboxPrimitive>;

/** Every prop a Checkbox takes: these, and the rest of UI SDK's Checkbox and a <button>. */
export interface CheckboxProps extends Omit<
  CheckboxPrimitiveProps,
  | "className"
  | "style"
  | "children"
  | "render"
  | "checked"
  | "defaultChecked"
  | "onCheckedChange"
  | "parent"
  | "value"
  | "disabled"
  | "readOnly"
  | "required"
> {
  /**
   * Its name, when no FieldLabel names it: a checkbox in a table row ("Select Contoso"). A screen
   * reader and an agent find it by these words.
   */
  "aria-label"?: string;
  /**
   * Checked now, for a checkbox your code holds: `true`, `false` or `"indeterminate"`. Pass
   * `onCheckedChange` with it.
   */
  checked?: CheckedState;
  /**
   * Checked at first, when the checkbox holds its own state. A form reset returns to it.
   * @default false
   */
  defaultChecked?: CheckedState;
  /**
   * Runs when a person, an agent or a form reset changes it, with the new state and why
   * (`details.reason`, `details.source`). `details.cancel()` refuses the change.
   */
  onCheckedChange?: CheckboxPrimitiveProps["onCheckedChange"];
  /**
   * The "Select all" of its group: checked when every checkbox is, empty when none is, and
   * `"indeterminate"`, a dash, in between. A press checks them all, or empties them.
   * @default false
   */
  parent?: boolean;
  /** What it sends while checked, and its value in a CheckboxGroup. */
  value?: string;
  /**
   * Shows it as wrong now, for an error your code decides; a FieldError beside it says what is
   * wrong, never the colour alone. Leave it out and its Field shows the browser's own check after a
   * submit.
   */
  "aria-invalid"?: boolean | "true" | "false";
  /**
   * Out of use: no press, no focus, half strength, and not sent with the form. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /**
   * Shown as it is and still sent, but a press does not change it: a setting someone else owns.
   * @default false
   */
  readOnly?: boolean;
  /**
   * A form will not send until it is checked. Its FieldLabel shows the mark; a FieldError says why.
   * @default false
   */
  required?: boolean;
  /**
   * Sits under a parent checkbox: moved in by one box and its gap, so its box stands under the
   * parent's words.
   * @default false
   */
  nested?: boolean;
  /** Layout only: margins and alignment. The look belongs to the checkbox. */
  style?: LayoutStyle;
}

// The box's class from its state. Out here, not inline: the React Compiler cannot lower the chained
// conditions inside a render prop.
const controlClass = (
  state: CheckboxState,
  nested: boolean,
  style: LayoutStyle | undefined
) =>
  className(
    choiceBoxStyles.control,
    styles.box,
    state.disabled && choiceBoxStyles.disabled,
    state.readOnly && !state.disabled && choiceBoxStyles.readOnly,
    nested && styles.nested,
    focusRingOffset,
    style
  ) ?? "";

// The face's look from its state, and whether its own `aria-invalid` makes it wrong.
const faceProps = (state: CheckboxState, invalid: boolean) => {
  const on = state.checked || state.indeterminate;
  const live = !(state.disabled || state.readOnly);
  return stylex.props(
    choiceBoxStyles.face,
    on ? choiceBoxStyles.full : choiceBoxStyles.empty,
    live && (on ? choiceBoxStyles.fullLive : choiceBoxStyles.emptyLive),
    invalid &&
      (on ? choiceBoxStyles.fullInvalid : choiceBoxStyles.emptyInvalid),
    live && choiceBoxStyles.pressable
  );
};

/** The box inside the button: the hit area, the face, and the tick or the dash. */
const Face = ({
  state,
  invalid,
}: {
  state: CheckboxState;
  invalid: boolean;
}) => (
  <>
    <span
      aria-hidden="true"
      data-slot="checkbox-hit-area"
      {...stylex.props(choiceHitArea)}
    />
    <span aria-hidden="true" {...faceProps(state, invalid)}>
      <CheckboxIndicator {...stylex.props(styles.mark, choiceBoxStyles.mark)}>
        {(mark) => <Icon icon={mark.indeterminate ? MinusIcon : CheckIcon} />}
      </CheckboxIndicator>
    </span>
  </>
);

export const Checkbox = ({
  nested = false,
  disabled,
  style,
  ...rest
}: CheckboxProps) => {
  const group = use(ChoiceGroupContext);
  const field = useFieldControl();
  // In a group UI SDK leaves the Field round a checkbox alone, as the group's Field holds the
  // group's validity. The box's row (a horizontal Field inside the group, wired by id) still names
  // and describes it: its wiring is passed here. The group's own Field names the group, not a box.
  const row = rowWiring(group, field);
  return (
    <CheckboxPrimitive
      {...row.props}
      {...rest}
      disabled={disabled ?? row.disabled}
      className={(state: CheckboxState) => controlClass(state, nested, style)}
    >
      {(state: CheckboxState) => (
        <Face state={state} invalid={isInvalid(rest["aria-invalid"])} />
      )}
    </CheckboxPrimitive>
  );
};

// ---- CheckboxGroup ------------------------------------------------------------------------------

type CheckboxGroupPrimitiveProps<T extends string> = ComponentProps<
  typeof CheckboxGroupPrimitive<T>
>;

/** Every prop a CheckboxGroup takes: these, and UI SDK's CheckboxGroup options. */
export interface CheckboxGroupProps<T extends string = string> extends Omit<
  CheckboxGroupPrimitiveProps<T>,
  | "className"
  | "style"
  | "children"
  | "render"
  | "value"
  | "defaultValue"
  | "onValueChange"
  | "allValues"
  | "name"
  | "disabled"
  | "required"
> {
  /** The values checked now, for a group your code holds. Pass `onValueChange` with it. */
  value?: T[];
  /** The values checked at first, when the group holds its own. A form reset returns to them. */
  defaultValue?: T[];
  /** Runs when the checked values change, with the new list and why. `details.cancel()` refuses it. */
  onValueChange?: CheckboxGroupPrimitiveProps<T>["onValueChange"];
  /**
   * Every value its parent checkbox checks. Pass it with a parent, so "Select all" is right on the
   * first paint, before the checkboxes are counted.
   */
  allValues?: T[];
  /** The name every checked value is sent under. Its Field's `name` when it has none. */
  name?: string;
  /**
   * Out of use: every checkbox in it at half strength. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /**
   * A form will not send until at least one is checked; a FieldError in its Field says so.
   * @default false
   */
  required?: boolean;
  /** Its checkboxes, each in a horizontal Field: a `parent` one first if it has one, then one per value. */
  children: ReactNode;
  /** Layout only: margins and alignment. The look belongs to the group. */
  style?: LayoutStyle;
}

/**
 * Checkboxes that make one answer: one list of checked values, sent under one name, and a `parent`
 * checkbox that selects them all. In a Field, its FieldLabel names the group and its FieldError
 * says the group's error.
 */
export const CheckboxGroup = <T extends string = string>({
  children,
  style,
  ...rest
}: CheckboxGroupProps<T>) => {
  const field = useFieldControl();
  return (
    <CheckboxGroupPrimitive<T> {...rest} {...stylex.props(styles.group, style)}>
      <ChoiceGroupContext value={field?.id ?? ""}>
        {children}
      </ChoiceGroupContext>
    </CheckboxGroupPrimitive>
  );
};
