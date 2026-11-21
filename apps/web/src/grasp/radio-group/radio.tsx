// Radio: one choice in a RadioGroup (radio-group.tsx), from shadcn's RadioGroupItem
// (registry/bases/base/ui/radio-group.tsx, on Base UI), converted from Tailwind to StyleX and rebuilt
// on UI SDK's Radio, which draws a button with the radio role beside a hidden native radio. Grasp's
// adds the label, a description, and a row at least 44px tall that a press beside the words
// chooses. The row is Checkbox's, so a radio and a checkbox stand in one column.
//
// Since release step 6 the words are Field's parts, as in shadcn, and the radio draws its circle only:
//
//   <Field orientation="horizontal">
//     <RadioGroupItem value="weekly" />
//     <FieldLabel>Weekly</FieldLabel>
//   </Field>
//
// The older shape below keeps working until step 9:
//
//   <Radio value="weekly" label="Weekly" />
//   <Radio value="weekly" label="Weekly" description="Every Monday morning." />
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { Radio as RadioPrimitive, RadioIndicator } from "@ui-sdk/react/radio";
import type { RadioState } from "@ui-sdk/react/radio";
import { createContext, useContext, useId } from "react";
import type { ComponentProps, ReactNode } from "react";

import { ChoiceRow, boxStyles, reachStyles } from "../choice/choice";
import { ChoiceBox, ChoiceOff, choiceIds } from "../choice/row";
import { focus } from "../focus/focus";
import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";

/** What a caller may style: where the radio or the group sits. Never its look. */
export type RadioLayoutStyle = LayoutStyle;

type RadioPrimitiveProps = ComponentProps<typeof RadioPrimitive>;

/** What a radio takes, besides UI SDK's own options. */
interface RadioOwnProps {
  /** What the group's value becomes when this one is chosen. */
  value: string;
  /** @deprecated Use `FieldLabel`, in a Field with `orientation="horizontal"`. */
  label?: ReactNode;
  /** @deprecated Use `FieldDescription`, in the same Field. */
  description?: ReactNode;
  /** Its name, when no FieldLabel names it: a choice in a table's row. */
  "aria-label"?: string;
  /**
   * Out of use: arrow keys pass it, it cannot be chosen, at half strength.
   * @default false
   */
  disabled?: boolean;
  /** @deprecated Use `layout`. */
  style?: RadioLayoutStyle;
  /** Layout only: margins and alignment. The look belongs to the radio. */
  layout?: RadioLayoutStyle;
}

/** Every prop a Radio takes: the ones above, and the rest of UI SDK's Radio and a <button>. */
export type RadioGroupItemProps = RadioOwnProps &
  Omit<
    RadioPrimitiveProps,
    | keyof RadioOwnProps
    | "className"
    | "children"
    | "render"
    | "aria-label"
    | "aria-labelledby"
  >;

/** What a RadioGroup hands its radios: whether it is out of use, or wrong. */
export const RadioGroupContext = createContext<{
  disabled?: boolean;
  invalid?: boolean;
}>({});

// ---- The look --------------------------------------------------------------------------------------

const styles = stylex.create({
  // The circle: as large as a checkbox's box, on the first line of the words. The rest of its look
  // is the choice row's (src/choice), so a radio and a checkbox answer alike.
  circle: {
    width: grasp.radioSize,
    height: grasp.radioSize,
    marginTop: `calc((${grasp.textSmLine} - ${grasp.radioSize}) / 2)`,
    borderRadius: grasp.cornerCircle,
  },
  dot: {
    width: grasp.radioDot,
    height: grasp.radioDot,
    borderRadius: grasp.cornerCircle,
    backgroundColor: { default: "currentColor", [media.forced]: "CanvasText" },
  },
});

// The circle's class from its state. Out here, not inline: the React Compiler cannot lower the
// chained conditions inside a render prop.
const controlClass = (state: RadioState) =>
  stylex.props(
    boxStyles.control,
    styles.circle,
    !(state.disabled || state.readOnly) && boxStyles.controlLive,
    state.disabled && boxStyles.disabled,
    state.readOnly && !state.disabled && boxStyles.readOnly,
    focus.mark
  ).className ?? "";

// ---- The parts ---------------------------------------------------------------------------------------

/** The circle inside the button: the face, the dot, and, in a row, the reach. */
const Face = ({ state, reach }: { state: RadioState; reach: boolean }) => {
  const live = !(state.disabled || state.readOnly);
  return (
    <>
      {reach && (
        <span
          aria-hidden="true"
          data-slot="radio-reach"
          {...stylex.props(reachStyles.reach)}
        />
      )}
      <span
        aria-hidden="true"
        {...stylex.props(
          boxStyles.face,
          state.checked ? boxStyles.full : boxStyles.empty,
          live && (state.checked ? boxStyles.fullLive : boxStyles.emptyLive),
          live && boxStyles.pressable
        )}
      >
        <RadioIndicator {...stylex.props(styles.dot, boxStyles.mark)} />
      </span>
    </>
  );
};

/** The ids a circle in a row is named and described by. A radio's row is always in a group. */
const rowWiring = (box: string | undefined) => {
  if (box === undefined) {
    return {};
  }
  const ids = choiceIds(box);
  return {
    "aria-labelledby": ids.label,
    "aria-describedby": `${ids.description} ${ids.error}`,
  };
};

export const RadioGroupItem = ({
  value,
  label,
  description,
  disabled: own,
  style: styleProp,
  layout,
  id,
  "aria-label": ariaLabel,
  ...rest
}: RadioGroupItemProps) => {
  const group = useContext(RadioGroupContext);
  const box = useContext(ChoiceBox);
  const off = useContext(ChoiceOff);
  // An id of its own, so the label names the circle in the first paint too.
  const made = useId();
  const disabled = own ?? (off ? true : group.disabled);

  // The parts shape: the circle only. A horizontal Field around it draws the row and its words.
  if (label === undefined) {
    const placed = stylex.props(layout ?? styleProp).className ?? "";
    return (
      <RadioPrimitive
        {...rest}
        {...rowWiring(box)}
        aria-label={ariaLabel}
        value={value}
        id={id ?? box ?? `radio${made}`}
        disabled={disabled}
        className={(state: RadioState) => `${controlClass(state)} ${placed}`}
      >
        {(state) => <Face state={state} reach={box !== undefined} />}
      </RadioPrimitive>
    );
  }

  const ownBox = id ?? `radio${made}`;
  return (
    // A radio is always in a group, whose field holds the validity: the row wires its words by id.
    <ChoiceRow
      box={ownBox}
      label={label}
      description={description}
      disabled={disabled}
      grouped
      layout={[layout ?? styleProp]}
    >
      {(wiring) => (
        <RadioPrimitive
          {...rest}
          {...wiring}
          value={value}
          id={ownBox}
          disabled={disabled}
          className={controlClass}
        >
          {(state) => <Face state={state} reach />}
        </RadioPrimitive>
      )}
    </ChoiceRow>
  );
};

/** @deprecated Use `RadioGroupItem`. */
export const Radio = RadioGroupItem;
/** @deprecated Use `RadioGroupItemProps`. */
export type RadioProps = RadioGroupItemProps;
