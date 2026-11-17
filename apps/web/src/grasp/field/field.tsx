// Field: a control with its label, its description and the error it shows, from shadcn's
// (registry/bases/base/ui/field.tsx), converted from Tailwind to StyleX and rebuilt on UI SDK's
// Field, which wires the `for`, `aria-labelledby`, `aria-describedby` and `aria-invalid` itself.
//
//   <Field name="email">
//     <FieldLabel>Work email</FieldLabel>
//     <Input type="email" autoComplete="email" required />
//     <FieldDescription>We send the invite here.</FieldDescription>
//     <FieldError match="valueMissing">Enter your work email.</FieldError>
//   </Field>
//
// The label shows the required mark when its control is `required`. An error shows after a submit
// finds the control wrong, or at once with `invalid` on the Field (an error from the server).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  Field as FieldPrimitive,
  FieldDescription as FieldDescriptionPrimitive,
  FieldLabel as FieldLabelPrimitive,
} from "@ui-sdk/react/field";
import { Label as LabelPrimitive } from "@ui-sdk/react/label";
import { createContext, useContext, useId } from "react";
import type { ComponentProps, ReactNode } from "react";

import { choiceMarker } from "../choice/choice.stylex";
import {
  ChoiceBox,
  ChoiceGrouped,
  ChoiceOff,
  ChoiceWrong,
  choiceIds,
  rowStyles,
} from "../choice/row";
import { RequiredMark, labelStyles } from "../label/label";
import type { LayoutStyle } from "../layout/layout";
import { grasp } from "../tokens/tokens.stylex";
import { fieldMarker } from "./field.stylex";

/** What a caller may style: where the field sits, and how wide it is. Never its look. */
export type FieldLayoutStyle = LayoutStyle;

const styles = stylex.create({
  // Label, control, description and error, one under the other, 8px apart.
  field: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    alignContent: "start",
    rowGap: grasp.space2,
    minWidth: 0,
    margin: 0,
  },
  // The required mark shows when the field holds a required control. Read from the page itself
  // (:has), so it is there before any script runs and with none.
  mark: {
    display: {
      default: "none",
      [stylex.when.ancestor(":has(:required)", fieldMarker)]: "inline",
    },
  },
});

// The sentences under the control: the description here, the error in field-error.tsx.
export const noteStyles = stylex.create({
  // A sentence under the control: what it is for, or what goes in it.
  note: {
    margin: 0,
    minWidth: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightRegular,
    overflowWrap: "anywhere",
    hyphens: "auto",
    // No word left alone on a last line.
    textWrap: "pretty",
  },
  description: {
    color: grasp.muted,
    opacity: { default: 1, ":is([data-disabled])": grasp.dim },
  },
  // What is wrong, in words, in danger. The control's hairline turns danger with it.
  error: {
    color: grasp.danger,
  },
});

/** Every prop a Field takes: these, and the rest of UI SDK's Field and a <div>. */
export interface FieldProps extends Omit<
  ComponentProps<typeof FieldPrimitive>,
  "className" | "style" | "render"
> {
  /** The label, the control, its description and its error, in that order. */
  children: ReactNode;
  /** The name the control is sent under in a form, when the control has no `name` of its own. */
  name?: string;
  /**
   * Out of use: the control, its label and its description, at half strength. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /**
   * Shows the field as wrong now, for an error your code decides (the server said no). Leave it
   * out and the field shows the browser's own check after a submit.
   */
  invalid?: boolean;
  /**
   * How its parts stand. `vertical`: label, control, description and error, one under the other.
   * `horizontal`: a Checkbox or a Radio first, then its words (a FieldContent), on one row at least
   * 44px tall that a press anywhere on works.
   * @default "vertical"
   */
  orientation?: FieldOrientation;
  /** @deprecated Use `layout`. */
  style?: FieldLayoutStyle;
  /** Layout only: margins, alignment and width. The look belongs to the field. */
  layout?: FieldLayoutStyle;
}

/** How a Field's parts stand: one under the other, or a control and its words on one row. */
export type FieldOrientation = "vertical" | "horizontal";

// The field's name, for a control that must render its own native input before the script runs
// (File upload): UI SDK keeps its own field context to itself.
const FieldName = createContext<string | undefined>(undefined);

/** The name of the Field around a control, if it has one. */
export const useFieldName = () => useContext(FieldName);

/**
 * A Checkbox or Radio and its words on one row (release step 6: the parts shape of the choice row,
 * src/choice). Alone it is its own field; in a CheckboxGroup or RadioGroup the group's field holds
 * the validity, so the row is a plain row and wires its words by id.
 */
const ChoiceField = ({
  layout,
  children,
  ...rest
}: Omit<FieldProps, "style" | "orientation">) => {
  const grouped = useContext(ChoiceGrouped);
  // A disabled group's rows are out of use too, their words dimmed with them.
  const groupOff = useContext(ChoiceOff);
  const own = useId();
  const box = `choice${own}`;
  const row = stylex.props(
    choiceMarker,
    fieldMarker,
    rowStyles.row,
    rowStyles.start,
    layout
  );
  if (grouped) {
    return (
      <ChoiceBox value={box}>
        <ChoiceOff value={rest.disabled === true || groupOff}>
          <ChoiceWrong value={rest.invalid === true}>
            <div {...row}>{children}</div>
          </ChoiceWrong>
        </ChoiceOff>
      </ChoiceBox>
    );
  }
  return (
    <ChoiceBox value={box}>
      <FieldName.Provider value={rest.name}>
        <FieldPrimitive {...rest} {...row}>
          {children}
        </FieldPrimitive>
      </FieldName.Provider>
    </ChoiceBox>
  );
};

export const Field = ({
  style: styleProp,
  layout,
  orientation = "vertical",
  ...rest
}: FieldProps) =>
  orientation === "horizontal" ? (
    <ChoiceField {...rest} layout={layout ?? styleProp} />
  ) : (
    <FieldName.Provider value={rest.name}>
      <FieldPrimitive
        {...rest}
        {...stylex.props(fieldMarker, styles.field, layout ?? styleProp)}
      />
    </FieldName.Provider>
  );

/** Every prop a FieldContent takes. */
export interface FieldContentProps {
  /** The words beside a control in a horizontal Field: its FieldLabel, FieldDescription and FieldError. */
  children: ReactNode;
}

/** The words beside a Checkbox or Radio in a horizontal Field, one under the other. */
export const FieldContent = ({ children }: FieldContentProps) => (
  <div {...stylex.props(rowStyles.words)}>{children}</div>
);

/** Every prop a FieldLabel takes. */
export interface FieldLabelProps extends Omit<
  ComponentProps<typeof FieldLabelPrimitive>,
  "className" | "style" | "children" | "render"
> {
  /** The words: what goes in the control, in sentence case ("Work email"). Never a question. */
  children: ReactNode;
}

/** The field's label. It names the control, and shows the required mark when it is `required`. */
export const FieldLabel = ({ children, ...rest }: FieldLabelProps) => {
  const box = useContext(ChoiceBox);
  const grouped = useContext(ChoiceGrouped);
  const off = useContext(ChoiceOff);
  // In a grouped row: a plain label, named by id, as the group's field holds the rest.
  if (box !== undefined && grouped) {
    return (
      <LabelPrimitive
        id={choiceIds(box).label}
        htmlFor={rest.htmlFor ?? box}
        data-disabled={off ? true : undefined}
        {...stylex.props(labelStyles.label)}
      >
        {children}
      </LabelPrimitive>
    );
  }
  const row =
    box === undefined
      ? {}
      : { id: choiceIds(box).label, htmlFor: rest.htmlFor ?? box };
  return (
    <FieldLabelPrimitive
      {...rest}
      {...row}
      {...stylex.props(labelStyles.label)}
    >
      {children}
      <RequiredMark layout={styles.mark} />
    </FieldLabelPrimitive>
  );
};

/** Every prop a FieldDescription takes. */
export interface FieldDescriptionProps extends Omit<
  ComponentProps<typeof FieldDescriptionPrimitive>,
  "className" | "style" | "children" | "render"
> {
  /** One sentence: what the field is for. A screen reader says it after the control's name. */
  children: ReactNode;
}

/** A sentence under the control. A screen reader says it after the control's name. */
export const FieldDescription = ({
  children,
  ...rest
}: FieldDescriptionProps) => {
  const box = useContext(ChoiceBox);
  const grouped = useContext(ChoiceGrouped);
  const off = useContext(ChoiceOff);
  // In a grouped row: a plain sentence the control names by id.
  if (box !== undefined && grouped) {
    return (
      <p
        id={choiceIds(box).description}
        data-disabled={off ? true : undefined}
        {...stylex.props(noteStyles.note, noteStyles.description)}
      >
        {children}
      </p>
    );
  }
  return (
    <FieldDescriptionPrimitive
      {...rest}
      {...stylex.props(noteStyles.note, noteStyles.description)}
    >
      {children}
    </FieldDescriptionPrimitive>
  );
};
