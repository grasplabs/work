// RadioGroup: one answer from a few choices, under one name, in StyleX, built
// on UI SDK's RadioGroup and Radio: one value, one tab stop, arrow keys between its radios (the
// other way round in right to left), a hidden native radio under each so a form sends the value,
// and an agent can choose by name. In a Field, its FieldLabel names the group and its FieldError
// says the group's error. Each RadioGroupItem draws its circle only; its words are Field's parts,
// on a row at least 44px tall that a press on the circle, its label or the space around them
// chooses:
//
//   <Field>
//     <FieldLabel>Summary email</FieldLabel>
//     <RadioGroup name="summary" defaultValue="weekly">
//       <Field orientation="horizontal">
//         <RadioGroupItem value="daily" />
//         <FieldLabel>Daily</FieldLabel>
//       </Field>
//       <Field orientation="horizontal">
//         <RadioGroupItem value="weekly" />
//         <FieldLabel>Weekly</FieldLabel>
//       </Field>
//     </RadioGroup>
//   </Field>
//
// The circle looks and answers as Checkbox's box does (choiceBoxStyles in lib/styles), so the two
// stand in one column.
// A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { renderElement } from "@ui-sdk/react/primitive";
import {
  RadioGroup as RadioGroupPrimitive,
  Radio as RadioPrimitive,
  RadioIndicator,
} from "@ui-sdk/react/radio";
import type { RadioState } from "@ui-sdk/react/radio";
import { use } from "react";
import type { ComponentProps, ReactNode } from "react";

import { choiceBoxStyles, choiceHitArea, focusRingOffset } from "../lib/styles";
import { font, media, radius, size, space } from "../lib/tokens.stylex";
import { ChoiceGroupContext, className, rowWiring } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { useFieldControl } from "./field";

const styles = stylex.create({
  // The radios, one under the other. The first row's words as far from the group's description
  // as the rows' words stand from each other: every row keeps the 44px a finger needs.
  group: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
    marginBlockStart: space[1],
  },
  // Named by `aria-label` (no FieldLabel above it): it does not reach up into a gap.
  flush: {
    marginBlockStart: 0,
  },
  // The button: as large as a checkbox's box, on the first line of the words.
  circle: {
    width: size.radioSize,
    height: size.radioSize,
    marginTop: `calc((${font.textSmLine} - ${size.radioSize}) / 2)`,
    borderRadius: radius.circle,
  },
  // The dot, in the mark's motion.
  dot: {
    width: size.radioDot,
    height: size.radioDot,
    borderRadius: radius.circle,
    backgroundColor: {
      default: "currentColor",
      [media.forcedColors]: "CanvasText",
    },
  },
});

// ---- RadioGroup ---------------------------------------------------------------------------------

type RadioGroupPrimitiveProps = ComponentProps<
  typeof RadioGroupPrimitive<string>
>;

/** Every prop a RadioGroup takes: these, and the rest of UI SDK's RadioGroup and a <div>. */
export interface RadioGroupProps extends Omit<
  RadioGroupPrimitiveProps,
  | "className"
  | "style"
  | "children"
  | "render"
  | "value"
  | "defaultValue"
  | "onValueChange"
  | "name"
  | "disabled"
  | "required"
  | "readOnly"
> {
  /**
   * Its name, when no FieldLabel shows one: only where the words around the group already name it,
   * like a table's column. A screen reader and an agent say it.
   */
  "aria-label"?: string;
  /** The value chosen now, for a group your code holds; `null` for none. Pass `onValueChange`. */
  value?: string | null;
  /** The value chosen at first, when the group holds its own. A form reset returns to it. */
  defaultValue?: string | null;
  /**
   * Runs when the choice changes, with the new value and why (`details.reason`,
   * `details.source`). `details.cancel()` refuses it.
   */
  onValueChange?: RadioGroupPrimitiveProps["onValueChange"];
  /** The name its value is sent under. Its Field's `name` when it has none. */
  name?: string;
  /**
   * A form will not send until one is chosen; a FieldError in its Field says so.
   * @default false
   */
  required?: boolean;
  /**
   * Out of use: every radio in it at half strength. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /**
   * Shown as it is and still sent, but nothing changes the choice.
   * @default false
   */
  readOnly?: boolean;
  /** Its radios, each a RadioGroupItem in a horizontal Field, in the order they are read. */
  children: ReactNode;
  /** Layout only: margins and alignment. The look belongs to the group. */
  style?: LayoutStyle;
}

export const RadioGroup = ({ children, style, ...rest }: RadioGroupProps) => {
  const field = useFieldControl();
  return (
    <RadioGroupPrimitive
      {...rest}
      {...stylex.props(
        styles.group,
        rest["aria-label"] !== undefined && styles.flush,
        style
      )}
    >
      <ChoiceGroupContext value={field?.id ?? ""}>
        {children}
      </ChoiceGroupContext>
    </RadioGroupPrimitive>
  );
};

// ---- RadioGroupItem -----------------------------------------------------------------------------

type RadioPrimitiveProps = ComponentProps<typeof RadioPrimitive>;

/** Every prop a RadioGroupItem takes: these, and the rest of UI SDK's Radio and a <button>. */
export interface RadioGroupItemProps extends Omit<
  RadioPrimitiveProps,
  "className" | "style" | "children" | "render" | "value" | "disabled"
> {
  /** What the group's value becomes when this one is chosen. */
  value: string;
  /** Its name, when no FieldLabel names it: a choice in a table's row. */
  "aria-label"?: string;
  /**
   * Out of use: arrow keys pass it, it cannot be chosen, at half strength.
   * @default false
   */
  disabled?: boolean;
  /** Layout only: margins and alignment. The look belongs to the radio. */
  style?: LayoutStyle;
}

// The circle's class from its state. Out here, not inline: the React Compiler cannot lower the
// chained conditions inside a render prop.
const controlClass = (state: RadioState, style: LayoutStyle | undefined) =>
  className(
    choiceBoxStyles.control,
    styles.circle,
    state.disabled && choiceBoxStyles.disabled,
    state.readOnly && !state.disabled && choiceBoxStyles.readOnly,
    focusRingOffset,
    style
  ) ?? "";

// The face's look from its state.
const faceProps = (state: RadioState) => {
  const live = !(state.disabled || state.readOnly);
  return stylex.props(
    choiceBoxStyles.face,
    state.checked ? choiceBoxStyles.full : choiceBoxStyles.empty,
    live &&
      (state.checked ? choiceBoxStyles.fullLive : choiceBoxStyles.emptyLive),
    live && choiceBoxStyles.pressable
  );
};

/** The circle inside the button: the hit area, the face and the dot. */
const Face = ({ state }: { state: RadioState }) => (
  <>
    <span
      aria-hidden="true"
      data-slot="radio-group-item-hit-area"
      {...stylex.props(choiceHitArea)}
    />
    <span aria-hidden="true" {...faceProps(state)}>
      <RadioIndicator {...stylex.props(styles.dot, choiceBoxStyles.mark)} />
    </span>
  </>
);

// UI SDK names the button after its own part (radio); here it is RadioGroupItem.
const radioButton = (props: Record<string, unknown>) =>
  renderElement("button", { ...props, "data-slot": "radio-group-item" });

/**
 * One choice in a RadioGroup. In a horizontal Field, that row's FieldLabel names it and its
 * FieldDescription describes it.
 */
export const RadioGroupItem = ({
  style,
  disabled,
  ...rest
}: RadioGroupItemProps) => {
  const group = use(ChoiceGroupContext);
  const field = useFieldControl();
  // A row of the group (a horizontal Field inside it) names and describes its radio by id; the
  // group's own Field names the group, not the radio.
  const row = rowWiring(group, field);
  return (
    <RadioPrimitive
      {...row.props}
      {...rest}
      disabled={disabled ?? row.disabled}
      render={radioButton}
      className={(state: RadioState) => controlClass(state, style)}
    >
      {(state: RadioState) => <Face state={state} />}
    </RadioPrimitive>
  );
};
