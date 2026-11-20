// The grid's head row: each column's name with its kind's icon, a button where it sorts, and the
// handle that makes it wider or narrower.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { RowData } from "@tanstack/react-table";
import { useRef } from "react";
import type {
  ChangeEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
} from "react";

import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { Icon, SortDown, SortUp } from "../icons";
import { linesAt } from "./lines";
import type { Drawn, Lines } from "./lines";
import { styles } from "./styles";
import type { DataGridColumn, DataGridHeaderLook } from "./types";
import type { GridModel } from "./use-data-grid";
import { isFigure, kindIcon } from "./values";

const headRowStyle = {
  quiet: styles.headRowQuiet,
  lifted: styles.headRowLifted,
  chip: styles.headRowChip,
};
const kindStyle = {
  quiet: styles.kindQuiet,
  lifted: styles.kindLifted,
  chip: styles.kindChip,
};

/** The edge's colour on a cell's lines: pine, or mint for the firmer range. */
export const edgeStyles = (lines: Lines, mint: boolean) => [
  lines.end && (mint ? styles.edgeEndMint : styles.edgeEndPine),
  lines.below && (mint ? styles.edgeBelowMint : styles.edgeBelowPine),
];

// A token's length in pixels, read from the page.
const lengthOf = (element: Element, name: string, fallback: number) => {
  const value = Number(
    getComputedStyle(element).getPropertyValue(name).replace("px", "")
  );
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const widthOf = (handle: Element) =>
  Math.round(handle.closest("th")?.getBoundingClientRect().width ?? 0);
// The widest a column can be made with the keys.
const widest = 1200;

interface HandleProps {
  label: string;
  width: number | undefined;
  onResize: (width: number) => void;
  onAutoFit: () => void;
}

// A range input, so it is a real control a screen reader and the keys know: dragged, it follows
// the pointer; with the arrow keys it moves a step at a time; pressed twice, the column fits its
// words again.
const Handle = ({ label, width, onResize, onAutoFit }: HandleProps) => {
  const drag = useRef<{
    x: number;
    width: number;
    least: number;
    rtl: boolean;
  } | null>(null);
  const handleDown = (event: PointerEvent<HTMLInputElement>) => {
    // The pointer resizes by how far it has gone, not as a range would slide.
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    drag.current = {
      x: event.clientX,
      width: widthOf(handle),
      least: lengthOf(handle, "--grasp-table-column-min", 64),
      rtl: getComputedStyle(handle).direction === "rtl",
    };
  };
  const handleMove = (event: PointerEvent<HTMLInputElement>) => {
    const from = drag.current;
    if (from !== null) {
      const gone = (event.clientX - from.x) * (from.rtl ? -1 : 1);
      onResize(Math.max(from.least, from.width + gone));
    }
  };
  const handleUp = () => {
    drag.current = null;
  };
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onResize(
      Math.max(
        lengthOf(event.currentTarget, "--grasp-table-column-min", 64),
        Number(event.currentTarget.value)
      )
    );
  };
  // The arrow keys step from the width the column has now, measured, whether or not it was ever
  // given one: toward the column's end widens it, in either reading direction.
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const handle = event.currentTarget;
    const rtl = getComputedStyle(handle).direction === "rtl";
    const steps: Partial<Record<string, number>> = {
      ArrowRight: rtl ? -1 : 1,
      ArrowLeft: rtl ? 1 : -1,
      ArrowUp: 1,
      ArrowDown: -1,
    };
    const by = steps[event.key];
    if (by === undefined) {
      return;
    }
    event.preventDefault();
    const least = lengthOf(handle, "--grasp-table-column-min", 64);
    const step = lengthOf(handle, "--grasp-table-resize-step", 16);
    onResize(Math.max(least, widthOf(handle) + by * step));
  };
  return (
    <input
      type="range"
      aria-label={label}
      min={64}
      max={Math.max(widest, width ?? 0)}
      step={16}
      value={width ?? 64}
      onChange={handleChange}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onDoubleClick={onAutoFit}
      onKeyDown={handleKeyDown}
      {...stylex.props(styles.handle, focus.inside)}
    />
  );
};

const sortIcon = { ascending: SortUp, descending: SortDown };

interface NameProps<Row> {
  column: DataGridColumn<Row>;
  header: DataGridHeaderLook;
  sort: "ascending" | "descending" | undefined;
  /** The head row's one tab stop; the arrows reach the others. */
  stop: boolean;
  onSort: (event: MouseEvent<HTMLButtonElement>) => void;
}

// A box's column is as narrow as its box: its head carries the icon alone, its name kept for a
// screen reader.
const HeadName = <Row,>({
  column,
  header,
  sort,
  stop,
  onSort,
}: NameProps<Row>) => {
  const boxed = column.kind === "checkbox";
  // While a column is sorted, the sort's arrow stands in its kind's icon's place: the head keeps
  // its width, and nothing moves when the sort changes.
  const inner = (
    <>
      <span
        aria-hidden="true"
        {...stylex.props(
          kindStyle[header],
          sort !== undefined && styles.sortMark
        )}
      >
        <Icon
          icon={
            sort === undefined
              ? (column.icon ?? kindIcon[column.kind])
              : sortIcon[sort]
          }
        />
      </span>
      <span {...stylex.props(boxed ? visuallyHidden : styles.words)}>
        {column.header}
      </span>
    </>
  );
  const place = [
    styles.name,
    isFigure(column.kind) && styles.nameEnd,
    boxed && styles.nameCentre,
  ];
  if (column.sortable !== true) {
    return <span {...stylex.props(place)}>{inner}</span>;
  }
  return (
    <button
      type="button"
      tabIndex={stop ? 0 : -1}
      onClick={onSort}
      {...stylex.props(
        place,
        styles.sorts,
        styles.sortsReach,
        sort !== undefined && styles.sorted,
        focus.inside,
        styles.sortsRing
      )}
    >
      {inner}
    </button>
  );
};

interface HeadRowProps<Row extends RowData> {
  model: GridModel<Row>;
  drawn: Drawn;
  header: DataGridHeaderLook;
  resizable: boolean;
}

/** The head row. */
export const HeadRow = <Row extends RowData>({
  model,
  drawn,
  header,
  resizable,
}: HeadRowProps<Row>) => {
  const { columns, words } = model;
  const lastCol = columns.length - 1;
  const mint = drawn.ranged && drawn.range === "outline";
  const offset = model.numbered ? 2 : 1;
  // The heads are one stop: Tab reaches the first that sorts, and the arrows go along the rest.
  const stop = columns.findIndex((column) => column.sortable === true);
  return (
    <tr
      aria-rowindex={1}
      {...stylex.props(styles.row, styles.headRow, headRowStyle[header])}
    >
      {model.numbered && (
        <th
          scope="col"
          aria-colindex={1}
          {...stylex.props(
            styles.head,
            styles.numberHead,
            header === "lifted" && styles.headLifted
          )}
        >
          <span {...stylex.props(visuallyHidden)}>{words.row}</span>
        </th>
      )}
      {columns.map((column, col) => (
        <th
          key={column.key}
          scope="col"
          aria-colindex={col + offset}
          aria-sort={model.sortOf(column.key)}
          data-head={col}
          tabIndex={column.sortable === true ? undefined : -1}
          {...stylex.props(
            styles.head,
            header === "lifted" && styles.headLifted,
            col === lastCol && styles.lastCol,
            edgeStyles(linesAt(drawn, -1, col), mint),
            focus.inside
          )}
        >
          <HeadName
            column={column}
            header={header}
            sort={model.sortOf(column.key)}
            stop={col === stop}
            onSort={(event) => {
              model.sort(column.key);
              // The active cell keeps its place in the sorted rows; once they are drawn, bring it
              // clear of the fades at the grid's edges (sorted while scrolled sideways, its ring
              // stood under the start's fade).
              const grid = event.currentTarget.closest("[role=grid]");
              requestAnimationFrame(() => {
                grid
                  ?.querySelector<HTMLElement>(
                    "[data-row][data-col][tabindex='0']"
                  )
                  ?.scrollIntoView({ block: "nearest", inline: "nearest" });
              });
            }}
          />
          {resizable && (
            <Handle
              label={words.width(column.header)}
              width={model.widths[column.key]}
              onResize={(width) => {
                model.resize(column.key, width);
              }}
              onAutoFit={() => {
                model.autoFit(column.key);
              }}
            />
          )}
        </th>
      ))}
    </tr>
  );
};
