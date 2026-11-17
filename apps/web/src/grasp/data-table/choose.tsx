// The checkboxes of a Data table: one in the head for every row shown, one on each row. A row's
// takes a range with Shift: the press is kept for a moment so its change can know.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { RowData } from "@tanstack/react-table";
import { useRef } from "react";

import { Checkbox } from "../checkbox";
import type { CheckedState } from "../checkbox";
import { Field, FieldLabel } from "../field";
import { styles } from "./styles";
import type { Model, TableRowOf } from "./use-data-table";

interface ChooseBoxProps {
  /** What it chooses, said to a screen reader. */
  name: string;
  checked: CheckedState;
  disabled?: boolean;
  onPress?: (event: { shiftKey: boolean }) => void;
  onChange: (checked: boolean) => void;
}

/** A Checkbox with its words hidden and its 44px reach spilling into the next cell. */
const ChooseBox = ({
  name,
  checked,
  disabled = false,
  onPress,
  onChange,
}: ChooseBoxProps) => (
  <span data-choose="" {...stylex.props(styles.pick)}>
    <span {...stylex.props(styles.reach)}>
      <span {...stylex.props(styles.lift)}>
        <Field orientation="horizontal" disabled={disabled}>
          <Checkbox
            checked={checked}
            onClick={(event) => {
              onPress?.({ shiftKey: event.shiftKey });
            }}
            onCheckedChange={(next) => {
              onChange(next === true);
            }}
          />
          <FieldLabel>
            <span {...stylex.props(styles.words)}>{name}</span>
          </FieldLabel>
        </Field>
      </span>
    </span>
  </span>
);

export const ChooseAll = <Row extends RowData>({
  model,
  label,
}: {
  model: Model<Row>;
  label: string;
}) => {
  const { rows } = model.table.getRowModel();
  const chosenHere = rows.filter((row) => model.isChosen(row.id)).length;
  let checked: CheckedState = "indeterminate";
  if (chosenHere === 0) {
    checked = false;
  } else if (chosenHere === rows.length) {
    checked = true;
  }
  return (
    <ChooseBox
      name={label}
      checked={checked}
      disabled={rows.length === 0}
      onChange={(next) => {
        model.table.toggleAllPageRowsSelected(next);
      }}
    />
  );
};

export const ChooseRow = <Row extends RowData>({
  row,
  label,
  checked,
}: {
  row: TableRowOf<Row>;
  label: string;
  checked: boolean;
}) => {
  const shiftRef = useRef(false);
  return (
    <ChooseBox
      name={label}
      checked={checked}
      onPress={(event) => {
        shiftRef.current = event.shiftKey;
      }}
      onChange={(next) => {
        row.getToggleSelectedHandler()({
          target: { checked: next },
          shiftKey: shiftRef.current,
        });
        shiftRef.current = false;
      }}
    />
  );
};
