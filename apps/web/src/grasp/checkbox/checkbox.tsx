// Checkbox: Grasp's checkbox, from shadcn's (registry/bases/base/ui/checkbox.tsx, on Base UI),
// converted from Tailwind to StyleX and rebuilt on UI SDK's Checkbox, which draws a button with the
// checkbox role beside a hidden native input, so a form sends it and an agent can check it by name.
// Grasp's adds what shadcn's leaves to the page: the label, a description, the error, and a row
// at least 44px tall that a press on the box, the label or the space around them checks.
//
// Since release step 6 the words are Field's parts, as in shadcn, and the checkbox draws its box only:
//
//   <Field orientation="horizontal">
//     <Checkbox />
//     <FieldContent>
//       <FieldLabel>Send me a weekly summary</FieldLabel>
//       <FieldDescription>Every Monday, the week in one email.</FieldDescription>
//     </FieldContent>
//   </Field>
//
// The older shape below keeps working until step 9:
//
//   <Checkbox label="Send me a weekly summary" />
//   <Checkbox label="Send me a weekly summary" description="Every Monday, the week in one email." />
//   <Checkbox label="Accept the terms" required error="Accept the terms to go on." />
//   <CheckboxGroup label="Notifications" defaultValue={["email"]} allValues={["email", "sms"]}>
//     <Checkbox parent label="Select all" />
//     <Checkbox nested value="email" label="Email" />
//     <Checkbox nested value="sms" label="Text message" />
//   </CheckboxGroup>
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  Checkbox as CheckboxPrimitive,
  CheckboxIndicator,
} from "@ui-sdk/react/checkbox";
import type { CheckboxState, CheckedState } from "@ui-sdk/react/checkbox";
import { createContext, useContext, useId } from "react";
import type { ComponentProps, ReactNode } from "react";

import { ChoiceRow, boxStyles, reachStyles } from "../choice/choice";
import {
  ChoiceBox,
  ChoiceGrouped,
  ChoiceOff,
  ChoiceWrong,
  choiceIds,
} from "../choice/row";
import { focus } from "../focus/focus";
import { Icon, Minus, Tick } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { grasp } from "../tokens/tokens.stylex";

export type { CheckedState } from "@ui-sdk/react/checkbox";

/** What a caller may style: where the checkbox or the group sits. Never its look. */
export type CheckboxLayoutStyle = LayoutStyle;

/** What a checkbox takes, besides UI SDK's own options. */
interface CheckboxOwnProps {
  /** @deprecated Use `FieldLabel`, in a Field with `orientation="horizontal"`. */
  label?: ReactNode;
  /** @deprecated Use `FieldDescription`, in the same Field. */
  description?: ReactNode;
  /** @deprecated Use `FieldError`, in the same Field. */
  error?: string;
  /**
   * Its name, when no FieldLabel names it: a checkbox in a table row ("Select Noordkade"). A screen
   * reader and an agent find it by these words.
   */
  "aria-label"?: string;
  /**
   * Shows it as wrong now, for an error your code decides. Leave it out and the browser's own check
   * shows after a submit. Give it an `error` too: words say what is wrong, never the colour alone.
   */
  invalid?: boolean;
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
  onCheckedChange?: CheckboxChange;
  /**
   * The "Select all" of its group: checked when every checkbox is, empty when none is, and
   * `"indeterminate"`, a dash, in between. A press checks them all, or empties them.
   * @default false
   */
  parent?: boolean;
  /** What it sends while checked, and its value in a CheckboxGroup. */
  value?: string;
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
   * A form will not send until it is checked. Its label shows the mark, and `error` says why.
   * @default false
   */
  required?: boolean;
  /**
   * Sits under a parent checkbox: moved in by one box and its gap, so its box stands under the
   * parent's words.
   * @default false
   */
  nested?: boolean;
  /** @deprecated Use `layout`. */
  style?: CheckboxLayoutStyle;
  /** Layout only: margins and alignment. The look belongs to the checkbox. */
  layout?: CheckboxLayoutStyle;
}

type CheckboxPrimitiveProps = ComponentProps<typeof CheckboxPrimitive>;

/** What `onCheckedChange` is called with: the new state, and why it changed. */
export type CheckboxChange = NonNullable<
  CheckboxPrimitiveProps["onCheckedChange"]
>;

/** Every prop a Checkbox takes: the ones above, and the rest of UI SDK's Checkbox and a <button>. */
export type CheckboxProps = CheckboxOwnProps &
  Omit<
    CheckboxPrimitiveProps,
    | "className"
    | "style"
    | "children"
    | "render"
    | "aria-label"
    | "aria-labelledby"
  >;

/** What a CheckboxGroup hands its checkboxes: whether it is out of use, or wrong. */
/** What a CheckboxGroup hands its checkboxes: that they are in one, out of use, or wrong. */
export const CheckboxGroupContext = createContext<{
  grouped?: boolean;
  disabled?: boolean;
  invalid?: boolean;
}>({});

// ---- The look --------------------------------------------------------------------------------------

const styles = stylex.create({
  // The box: an 18px square with the mark corner, on the first line of the words. The rest of its
  // look is the choice row's (src/choice).
  box: {
    // The tick inside follows these (the icons entry (`@/components/grasp/icons`)/icon.stylex.ts).
    [iconVars.size]: grasp.checkboxMark,
    [iconVars.stroke]: grasp.checkboxMarkStroke,
    width: grasp.checkboxBox,
    height: grasp.checkboxBox,
    marginTop: `calc((${grasp.textSmLine} - ${grasp.checkboxBox}) / 2)`,
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
  },
  mark: {
    display: "grid",
    placeItems: "center",
  },
  // Under a parent checkbox: in by one box and its gap, so its box stands under the parent's words.
  nested: {
    marginInlineStart: `calc(${grasp.checkboxBox} + ${grasp.space3})`,
  },
});

// The box's class from its state. Out here, not inline: the React Compiler cannot lower the chained
// conditions inside a render prop.
const controlClass = (state: CheckboxState) =>
  stylex.props(
    boxStyles.control,
    styles.box,
    !(state.disabled || state.readOnly) && boxStyles.controlLive,
    state.disabled && boxStyles.disabled,
    state.readOnly && !state.disabled && boxStyles.readOnly,
    focus.mark
  ).className ?? "";

// ---- The parts ---------------------------------------------------------------------------------------

/** The box inside the button: the face, the tick or dash, and, in a row, the reach. */
const Face = ({ state, reach }: { state: CheckboxState; reach: boolean }) => {
  const on = state.checked || state.indeterminate;
  const live = !(state.disabled || state.readOnly);
  return (
    <>
      {reach && (
        <span
          aria-hidden="true"
          data-slot="checkbox-reach"
          {...stylex.props(reachStyles.reach)}
        />
      )}
      <span
        aria-hidden="true"
        {...stylex.props(
          boxStyles.face,
          on ? boxStyles.full : boxStyles.empty,
          live && (on ? boxStyles.fullLive : boxStyles.emptyLive),
          live && boxStyles.pressable
        )}
      >
        <CheckboxIndicator {...stylex.props(styles.mark, boxStyles.mark)}>
          {(mark) => <Icon icon={mark.indeterminate ? Minus : Tick} />}
        </CheckboxIndicator>
      </span>
    </>
  );
};

// Where a bare box sits, from the caller. Out here, not inline: the React Compiler cannot lower the
// chained conditions in the component's body.
const placedClass = (
  nested: boolean,
  layout: CheckboxLayoutStyle | undefined
) => stylex.props(nested && styles.nested, layout).className ?? "";

/** The ids a box in a row is named and described by: its label's, and in a group its words'. */
const rowWiring = (
  box: string | undefined,
  grouped: boolean,
  wrong: boolean
) => {
  if (box === undefined) {
    return {};
  }
  const ids = choiceIds(box);
  return grouped
    ? {
        "aria-labelledby": ids.label,
        "aria-describedby": `${ids.description} ${ids.error}`,
        ...(wrong && { "aria-invalid": true as const }),
      }
    : { "aria-labelledby": ids.label };
};

export const Checkbox = ({
  label,
  description,
  error,
  invalid,
  nested = false,
  style: styleProp,
  layout,
  id,
  "aria-label": ariaLabel,
  ...rest
}: CheckboxProps) => {
  const group = useContext(CheckboxGroupContext);
  const box = useContext(ChoiceBox);
  const grouped = useContext(ChoiceGrouped);
  const off = useContext(ChoiceOff);
  const wrong = useContext(ChoiceWrong);
  // An id of its own, so the label names the box in the first paint too, inside a group as well.
  const own = useId();
  const disabled = rest.disabled ?? (off ? true : group.disabled);

  // The parts shape: the box only. A horizontal Field around it draws the row and its words.
  if (label === undefined) {
    // Where it sits, from the caller: on the box itself, as the row is the Field's.
    const placed = placedClass(nested, layout ?? styleProp);
    return (
      <CheckboxPrimitive
        {...rest}
        {...rowWiring(box, grouped, wrong)}
        aria-label={ariaLabel}
        id={id ?? box ?? `checkbox${own}`}
        disabled={disabled}
        className={(state: CheckboxState) => `${controlClass(state)} ${placed}`}
      >
        {(state) => <Face state={state} reach={box !== undefined} />}
      </CheckboxPrimitive>
    );
  }

  const ownBox = id ?? `checkbox${own}`;
  return (
    <ChoiceRow
      box={ownBox}
      label={label}
      description={description}
      error={error}
      required={rest.required}
      invalid={invalid ?? group.invalid}
      disabled={disabled}
      grouped={group.grouped}
      layout={[nested && styles.nested, layout ?? styleProp]}
    >
      {(wiring) => (
        <CheckboxPrimitive
          {...rest}
          {...wiring}
          id={ownBox}
          disabled={disabled}
          className={controlClass}
        >
          {(state) => <Face state={state} reach />}
        </CheckboxPrimitive>
      )}
    </ChoiceRow>
  );
};
