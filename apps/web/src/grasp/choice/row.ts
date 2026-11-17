// The choice row's layout and wiring, shared by the choice row (choice.tsx, the older shape) and
// Field's horizontal orientation (the parts shape of release step 6). Its own file so Field can
// read it without importing choice.tsx, which imports Field.
//
// In the parts shape a row is
//
//   <Field orientation="horizontal">
//     <Checkbox />
//     <FieldContent><FieldLabel>Weekly summary</FieldLabel></FieldContent>
//   </Field>
//
// The row hands its control and its words one id (`ChoiceBox`): the control takes it, the label
// names it by `<id>-label`, the description and the error say it by `<id>-description` and
// `<id>-error`. In a CheckboxGroup or RadioGroup (`ChoiceGrouped`), the group's field holds the
// validity, so the row is no field of its own and wires its words by those ids alone.
import * as stylex from "@stylexjs/stylex";
import { createContext } from "react";

import { grasp } from "../tokens/tokens.stylex";

export const rowStyles = stylex.create({
  row: {
    position: "relative",
    isolation: "isolate",
    display: "grid",
    alignItems: "start",
    minWidth: 0,
    margin: 0,
    paddingBlock: `calc((${grasp.tap} - ${grasp.textSmLine}) / 2)`,
  },
  // The control first, then its words: a checkbox, a radio.
  start: {
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: grasp.space3,
  },
  // The words first, then the control at the end: a switch, as in a list of settings.
  end: {
    gridTemplateColumns: "minmax(0, 1fr) auto",
    columnGap: grasp.space4,
  },
  words: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: grasp.space1,
    minWidth: 0,
  },
});

/** Inside a CheckboxGroup or RadioGroup, whose field holds the validity of every row in it. */
export const ChoiceGrouped = createContext(false);

/** The id a horizontal Field hands the control in it and its words. Unset outside such a row. */
export const ChoiceBox = createContext<string | undefined>(undefined);

/** A grouped row out of use: its words dim, its control is disabled. */
export const ChoiceOff = createContext(false);

/** A grouped row shown as wrong: its control says `aria-invalid`. */
export const ChoiceWrong = createContext(false);

/** The ids a row's words take, from the row's one id. */
export const choiceIds = (box: string) => ({
  label: `${box}-label`,
  description: `${box}-description`,
  error: `${box}-error`,
});
