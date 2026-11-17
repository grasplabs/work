// The Data table's head: the checkboxes' column, then each column shown, with its sort, its
// place in a sort by several, its menu, its resize handle, and dragging to move it.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { RowData } from "@tanstack/react-table";
import { useRef, useState } from "react";
import type { DragEvent } from "react";

import { TableHead, TableRow } from "../table";
import { ChooseAll } from "./choose";
import { ColumnMenu } from "./column-menu";
import { ResizeHandle } from "./resize-handle";
import { styles } from "./styles";
import type { Model, TableColumn } from "./use-data-table";
import type { DataTableWords } from "./words";

type Side = "before" | "after";

const sideOf = (event: DragEvent<HTMLTableCellElement>): Side => {
  const box = event.currentTarget.getBoundingClientRect();
  const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
  const firstHalf = event.clientX < box.left + box.width / 2;
  return firstHalf === rtl ? "after" : "before";
};

interface HeadProps<Row extends RowData> {
  model: Model<Row>;
  column: TableColumn<Row>;
  words: DataTableWords;
  dropAt: { key: string; side: Side } | null;
  onDropAt: (at: { key: string; side: Side } | null) => void;
  onDragFrom: (key: string | null) => void;
  onDropOn: (key: string, side: Side) => void;
}

const Head = <Row extends RowData>({
  model,
  column,
  words,
  dropAt,
  onDropAt,
  onDragFrom,
  onDropOn,
}: HeadProps<Row>) => {
  const meta = model.metaOf(column.id);
  const header = meta?.header ?? column.id;
  const sortable = column.getCanSort();
  const at = model.sortOf(column.id);
  const sortedCount = model.own.sort.length;
  const hasMenu =
    model.flags.hiding || model.flags.ordering || model.flags.pinning;
  const hasHandle = model.flags.resizing && model.sized;
  const after =
    hasMenu || hasHandle ? (
      <>
        {hasMenu && (
          <span {...stylex.props(styles.after)}>
            <ColumnMenu
              model={model}
              column={column}
              header={header}
              words={words}
            />
          </span>
        )}
        {hasHandle && (
          <ResizeHandle
            model={model}
            column={column}
            label={words.width(header)}
          />
        )}
      </>
    ) : undefined;
  const drag = model.flags.ordering
    ? {
        draggable: true,
        onDragStart: (event: DragEvent<HTMLTableCellElement>) => {
          onDragFrom(column.id);
          event.dataTransfer.effectAllowed = "move";
        },
        onDragOver: (event: DragEvent<HTMLTableCellElement>) => {
          event.preventDefault();
          const side = sideOf(event);
          if (dropAt?.key !== column.id || dropAt.side !== side) {
            onDropAt({ key: column.id, side });
          }
        },
        onDragLeave: () => {
          onDropAt(null);
        },
        onDrop: (event: DragEvent<HTMLTableCellElement>) => {
          event.preventDefault();
          onDropOn(column.id, sideOf(event));
        },
        onDragEnd: () => {
          onDropAt(null);
          onDragFrom(null);
        },
        "data-drop": dropAt?.key === column.id ? dropAt.side : undefined,
      }
    : undefined;
  return (
    <TableHead
      align={meta?.align}
      sort={sortable ? (at ?? "none") : undefined}
      order={
        sortedCount > 1 && at !== undefined
          ? model.sortPlace(column.id)
          : undefined
      }
      orderWords={words.sortedPlace}
      onSort={
        sortable
          ? (event) => {
              column.toggleSorting(
                undefined,
                event.shiftKey && sortedCount > 0 && column.getCanMultiSort()
              );
            }
          : undefined
      }
      pin={model.pinOf(column.id)}
      width={model.sized ? model.widthOf(column.id) : undefined}
      end={after}
      column={column.id}
      drag={drag}
    >
      {header}
    </TableHead>
  );
};

interface HeadRowProps<Row extends RowData> {
  model: Model<Row>;
  words: DataTableWords;
  selectable: boolean;
  one: string;
  hasActions: boolean;
}

// The checkbox's column where the table lays itself out: a width it cannot fit, so it is as narrow
// as its box. Left to share the table's spare room it grew wide, and the box stood far from the
// first words of its row.
const NARROW = 1;

export const HeadRow = <Row extends RowData>({
  model,
  words,
  selectable,
  one,
  hasActions,
}: HeadRowProps<Row>) => {
  const [dropAt, setDropAt] = useState<{ key: string; side: Side } | null>(
    null
  );
  const fromRef = useRef<string | null>(null);
  return (
    <TableRow>
      {selectable && (
        <TableHead
          aria-label={words.chooseColumn}
          pin={model.choosePin}
          width={model.sized ? model.chooseWidth : NARROW}
        >
          <ChooseAll model={model} label={words.chooseAll(one)} />
        </TableHead>
      )}
      {model.shown.map((column) => (
        <Head
          key={column.id}
          model={model}
          column={column}
          words={words}
          dropAt={dropAt}
          onDropAt={setDropAt}
          onDragFrom={(key) => {
            fromRef.current = key;
          }}
          onDropOn={(key, side) => {
            if (fromRef.current !== null) {
              model.drop(fromRef.current, key, side);
            }
            fromRef.current = null;
            setDropAt(null);
          }}
        />
      ))}
      {hasActions && <TableHead aria-label={words.actions} />}
    </TableRow>
  );
};
