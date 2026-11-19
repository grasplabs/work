// DataGrid: a spreadsheet in the page, on the Data table's engine (TanStack Table, engine.ts) and
// its look. One active cell and a range; the arrows, Tab, Enter, Home, End and the page keys move;
// typing, Enter, F2 or a double press edits in place; Space ticks a box; copy, cut and paste speak
// TSV with real spreadsheets; Delete clears; mod+Z undoes. The grid stores nothing: every edit
// leaves as a patch (`onPatch`) for you to apply to your rows (`applyPatch` does it for plain rows).
//
//   const [rows, setRows] = useState(tasks);
//   <DataGrid
//     label="Launch plan"
//     rows={rows}
//     rowKey={(task) => task.id}
//     columns={[
//       { key: "task", header: "Task", kind: "text", value: (task) => task.task, sortable: true },
//       { key: "budget", header: "Budget", kind: "currency", value: (task) => task.budget },
//       { key: "done", header: "Done", kind: "checkbox", value: (task) => task.done },
//     ]}
//     onPatch={(patch) => setRows((now) => applyPatch(now, patch, (task) => task.id))}
//   />
//
// Its looks (the active cell, a range, the head) are props with provisional defaults: `look`.
// Parts: use-data-grid.ts (the model), use-events.ts (keys, clipboard, pointer), head.tsx and
// cell.tsx (what it draws), model.ts (the spreadsheet's rules, no React). Every value is a token.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { RowData } from "@tanstack/react-table";
import { useState } from "react";
import type { FocusEvent } from "react";

import { visuallyHidden } from "../hidden/hidden";
import { scroll } from "../scroll/scroll";
import { GridCell } from "./cell";
import type { CellState } from "./cell";
import { HeadRow, edgeStyles } from "./head";
import { linesAt, sidesAt } from "./lines";
import type { Drawn } from "./lines";
import { contains } from "./model";
import { styles } from "./styles";
import type { DataGridColumn, DataGridProps } from "./types";
import { useDataGrid } from "./use-data-grid";
import type { GridModel } from "./use-data-grid";
import { useEdges } from "./use-edges";
import { useEvents } from "./use-events";
import type { GridEvents } from "./use-events";
import { shownOf } from "./values";

interface RowProps<Row extends RowData> {
  model: GridModel<Row>;
  events: GridEvents;
  drawn: Drawn;
  locale: string;
  row: number;
  data: Row;
}

const stateAt = <Row extends RowData>(
  model: GridModel<Row>,
  drawn: Drawn,
  row: number,
  col: number
): CellState => {
  const inRange = drawn.ranged && contains(drawn.rect, { row, col });
  const active =
    model.selection.active.row === row && model.selection.active.col === col;
  return {
    active,
    // A grid nobody is in shows no active cell; the cell is kept, and drawn again as focus comes back.
    lit: active && (drawn.focused || model.editing !== null),
    inRange,
    lines: linesAt(drawn, row, col),
    sides: sidesAt(drawn.rect, row, col),
    mint: drawn.ranged && drawn.range === "outline",
    lastCol: col === model.extent.cols - 1,
    lastRow: row === model.extent.rows - 1,
  };
};

interface CellAtProps<Row extends RowData> extends RowProps<Row> {
  column: DataGridColumn<Row>;
  col: number;
}

const CellAt = <Row extends RowData>({
  model,
  events,
  drawn,
  locale,
  row,
  data,
  column,
  col,
}: CellAtProps<Row>) => {
  const { words } = model;
  const value = column.value(data);
  const state = stateAt(model, drawn, row, col);
  const name = words.cell(column.header, row + 1);
  return (
    <GridCell
      cell={{ row, col }}
      index={col + (model.numbered ? 2 : 1)}
      kind={column.kind}
      text={shownOf(column, value, locale)}
      checked={value === true}
      name={name}
      boxWords={value === true ? words.ticked : words.unticked}
      editable={model.editable(col)}
      state={state}
      look={drawn}
      editing={state.active ? model.editing : null}
      editWords={words.edit(name)}
      onPress={events.handlePress}
      onEnter={events.handleEnter}
      onTick={(cell) => {
        model.tick(cell);
      }}
      onOpen={() => {
        model.startEdit();
      }}
      onType={(text) => {
        model.type(text);
      }}
      onEditorBlur={events.handleEditorBlur}
    />
  );
};

const GridRow = <Row extends RowData>(props: RowProps<Row>) => {
  const { model, events, drawn, row } = props;
  const mint = drawn.ranged && drawn.range === "outline";
  return (
    <tr aria-rowindex={row + 2} {...stylex.props(styles.row)}>
      {model.numbered && (
        <th
          scope="row"
          aria-colindex={1}
          onPointerDown={(event) => {
            events.handleRowPress(event, row);
          }}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          {...stylex.props(
            styles.cell,
            styles.number,
            row === model.extent.rows - 1 && styles.lastRow,
            edgeStyles(linesAt(drawn, row, -1), mint)
          )}
        >
          {row + 1}
        </th>
      )}
      {model.columns.map((column, col) => (
        <CellAt key={column.key} {...props} column={column} col={col} />
      ))}
    </tr>
  );
};

/** A spreadsheet in the page. */
export const DataGrid = <Row extends RowData>(props: DataGridProps<Row>) => {
  const model = useDataGrid(props);
  const { gridRef, events } = useEvents(model);
  const { scrollerRef, edges, read } = useEdges();
  // Whether the focus is anywhere in the grid: the active cell is drawn only then.
  const [focused, setFocused] = useState(false);
  const leave = (event: FocusEvent<HTMLDivElement>) => {
    if (
      !(
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      )
    ) {
      setFocused(false);
    }
  };
  // The looks by their new name, else the deprecated old one (the breaking release's step 1).
  const looks = props.appearance ?? props.look;
  const drawn: Drawn = {
    rect: model.rect,
    cell: model.selection.active,
    ranged: model.ranged,
    active: looks?.active ?? "halo",
    range: looks?.range ?? "wash",
    focused,
  };
  const header = looks?.header ?? "quiet";
  const locale = props.locale ?? "en";
  return (
    <div
      data-slot="data-grid"
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={leave}
      {...stylex.props(styles.frame)}
    >
      <div
        ref={scrollerRef}
        onScroll={read}
        {...stylex.props(
          styles.scroller,
          model.numbered && styles.scrollerNumbered,
          scroll.bar
        )}
      >
        <table
          ref={gridRef}
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role -- a table is the element ARIA gives the grid role to: its rows and cells then are the grid's rows and cells
          role="grid"
          tabIndex={-1}
          aria-label={props.label}
          aria-multiselectable="true"
          aria-readonly={model.readOnly ? true : undefined}
          aria-rowcount={model.extent.rows + 1}
          aria-colcount={model.extent.cols + (model.numbered ? 1 : 0)}
          onKeyDown={events.handleKeyDown}
          onCopy={events.handleCopy}
          onCut={events.handleCut}
          onPaste={events.handlePaste}
          {...stylex.props(styles.grid, styles.columns(model.template))}
        >
          <thead {...stylex.props(styles.group)}>
            <HeadRow
              model={model}
              drawn={drawn}
              header={header}
              resizable={props.resizable === true}
            />
          </thead>
          <tbody {...stylex.props(styles.group)}>
            {model.shown.map((line, row) => (
              <GridRow
                key={line.id}
                model={model}
                events={events}
                drawn={drawn}
                locale={locale}
                row={row}
                data={line.data}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div
        aria-hidden="true"
        {...stylex.props(
          styles.fade,
          model.numbered ? styles.fadeStartNumbered : styles.fadeStart,
          edges.rtl ? styles.fadeToRight : styles.fadeToLeft,
          edges.start && styles.fadeShown
        )}
      />
      <div
        aria-hidden="true"
        {...stylex.props(
          styles.fade,
          styles.fadeEnd,
          edges.rtl ? styles.fadeToLeft : styles.fadeToRight,
          edges.end && styles.fadeShown
        )}
      />
      <output {...stylex.props(visuallyHidden)}>{model.said}</output>
    </div>
  );
};
