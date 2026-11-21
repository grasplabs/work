// The handle at a sized column's head: a range input, so it is a real control a screen reader and
// the keys know. Dragged with a pointer it resizes the column as TanStack measures; with the arrow
// keys it moves a step at a time; a double press puts the column back to its first width.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { RowData } from "@tanstack/react-table";
import type { ChangeEvent, MouseEvent, TouchEvent } from "react";

import { focus } from "../focus/focus";
import { styles } from "./styles";
import type { Model, TableColumn } from "./use-data-table";

interface ResizeHandleProps<Row extends RowData> {
  model: Model<Row>;
  column: TableColumn<Row>;
  /** Its name: "Width of Owner". */
  label: string;
}

// The widest a column can be made with the keys, in steps from its narrowest.
const widest = 1200;

export const ResizeHandle = <Row extends RowData>({
  model,
  column,
  label,
}: ResizeHandleProps<Row>) => {
  const width = model.widthOf(column.id);
  const handleStart = (
    event: MouseEvent<HTMLInputElement> | TouchEvent<HTMLInputElement>
  ) => {
    // The pointer resizes as TanStack measures it, not as a range would slide.
    event.preventDefault();
    const header = model.table
      .getFlatHeaders()
      .find((each) => each.column.id === column.id);
    header?.getResizeHandler()(event);
  };
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = Math.max(model.narrowest, Number(event.currentTarget.value));
    model.own.setWidths((now) => ({ ...now, [column.id]: next }));
  };
  const handleDoubleClick = () => {
    model.own.setWidths((now) => ({
      ...now,
      [column.id]: model.firstWidths[column.id] ?? width,
    }));
  };
  return (
    <input
      type="range"
      aria-label={label}
      min={model.narrowest}
      max={Math.max(widest, width)}
      step={model.step}
      value={width}
      onChange={handleChange}
      onMouseDown={handleStart}
      onTouchStart={handleStart}
      onDoubleClick={handleDoubleClick}
      {...stylex.props(
        styles.handle,
        model.resizing === column.id && styles.held,
        focus.inside
      )}
    />
  );
};
