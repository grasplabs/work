import { cssVars } from "@grasp-os/ui/lib/css-vars";
import { cn } from "@grasp-os/ui/lib/utils";
import {
  columnSizingFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import type { ColumnDef } from "@tanstack/react-table";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type * as React from "react";

/*
 * A dense grid of records, as a database's studio shows a table: a sticky
 * row of column headers (each the page's to fill: a field's kind, name and
 * whether it is required), then the records, a row each. TanStack Table
 * keeps the columns, their widths and the rows. Only the rows and
 * columns in view are drawn, so a table of a million rows and dozens of
 * fields scrolls as one of ten: every row is one height and every column
 * has a width, so what is in view is arithmetic on where the grid is
 * scrolled to (`windowOf`). Not TanStack Virtual: the React Compiler
 * refuses its `useVirtualizer` (its list of known-incompatible APIs: the
 * hook's results can't be memoized), which fails the build, and every
 * component here is compiled. Nearing the last row it has,
 * the grid asks for more (`onEndReached`), so the page loads the next one
 * as people scroll. It reads as an ARIA grid: rows and cells by role, with
 * the table's whole size given (`aria-rowcount`, `aria-colcount`).
 *
 * The structure follows tablecn's data grid (https://github.com/sadmann7/
 * tablecn, MIT, (c) 2024 Sadman Sakib), redrawn in the kit's own tokens.
 */

/** A column: its header, what each row shows in it, and its width in px. */
interface RecordGridColumn<Row> {
  id: string;
  header: React.ReactNode;
  cell: (row: Row) => React.ReactElement | string | null;
  width?: number;
}

/** How tall a row is, in px: the grid's one density (`h-9`). */
const rowHeight = 36;

/** How wide a column is when the page says nothing. */
const defaultWidth = 200;

/** Rows drawn past either edge of what is in view. */
const overscanRows = 8;

/** How far past either side columns are drawn, in px. */
const overscanWidth = 400;

/** How near its last row the grid asks for more, in rows. */
const endReachedWithin = 20;

/**
 * Where the grid is scrolled to, and how large it shows: a laptop's screen
 * until it is measured (a first render, a test's page, which measures
 * nothing).
 */
interface Viewport {
  top: number;
  left: number;
  width: number;
  height: number;
}

const unmeasured: Viewport = { top: 0, left: 0, width: 1280, height: 720 };

/** The first and past-the-last index of what lies in `[from, to)`, by `ends`. */
const windowOf = (
  ends: readonly number[],
  from: number,
  to: number
): [number, number] => {
  const first = ends.findIndex((end) => end > from);
  if (first === -1) {
    return [ends.length, ends.length];
  }
  const past = ends.findIndex((end) => end >= to);
  return [first, past === -1 ? ends.length : past + 1];
};

const features = tableFeatures({ columnSizingFeature });

const cellVariants = cva(
  "flex h-9 min-w-0 shrink-0 items-center border-e border-b px-2.5 text-sm",
  {
    variants: {
      part: {
        header: "bg-muted text-muted-foreground font-medium",
        body: "bg-background",
      },
    },
    defaultVariants: { part: "body" },
  }
);

/**
 * The records `rows` in `columns`, named `label`, each row keyed by
 * `rowKey`. `empty` stands under the headers when there are none;
 * `onEndReached` hears that the last rows came into view.
 */
function RecordGrid<Row extends object>({
  label,
  columns,
  rows,
  rowKey,
  empty,
  onEndReached,
  className,
}: {
  label: string;
  columns: readonly RecordGridColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  empty?: React.ReactNode;
  onEndReached?: () => void;
  className?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(unmeasured);
  // The grid's size as it shows, kept as it changes.
  useEffect(() => {
    const element = scroller.current;
    const observer = new ResizeObserver(() => {
      setViewport((held) => ({
        ...held,
        width: element?.clientWidth ?? held.width,
        height: element?.clientHeight ?? held.height,
      }));
    });
    if (element !== null) {
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
    };
  }, []);
  const defs: ColumnDef<typeof features, Row>[] = columns.map((column) => ({
    id: column.id,
    size: column.width ?? defaultWidth,
    accessorFn: (row: Row) => rowKey(row),
  }));
  const table = useTable({
    features,
    columns: defs,
    data: [...rows],
    getRowId: (row) => rowKey(row),
  });
  const tableRows = table.getRowModel().rows;
  const leaves = table.getAllLeafColumns();
  const columnEnds: number[] = [];
  for (const leaf of leaves) {
    columnEnds.push((columnEnds.at(-1) ?? 0) + leaf.getSize());
  }
  const totalWidth = columnEnds.at(-1) ?? 0;
  const [firstColumn, pastColumn] = windowOf(
    columnEnds,
    viewport.left - overscanWidth,
    viewport.left + viewport.width + overscanWidth
  );
  const before = columnEnds[firstColumn - 1] ?? 0;
  const after = totalWidth - (columnEnds[pastColumn - 1] ?? 0);
  const firstRow = Math.max(
    0,
    Math.floor(viewport.top / rowHeight) - overscanRows
  );
  const pastRow = Math.min(
    tableRows.length,
    Math.ceil((viewport.top + viewport.height) / rowHeight) + overscanRows
  );
  const shownColumns = leaves
    .slice(firstColumn, pastColumn)
    .map((leaf, offset) => ({
      id: leaf.id,
      size: leaf.getSize(),
      index: firstColumn + offset,
    }));
  const count = tableRows.length;
  const nearEnd = count > 0 && pastRow > count - endReachedWithin;
  const reachEnd = useEffectEvent(() => {
    onEndReached?.();
  });
  // Each time the rows near their end, once per count of rows: a page
  // that loaded nothing more isn't asked again until it has.
  useEffect(() => {
    if (nearEnd && count > 0) {
      reachEnd();
    }
  }, [nearEnd, count]);
  const byId = new Map(columns.map((column) => [column.id, column]));
  // One row's cells (or the headers'), the ones in view, with room kept
  // for those left out on either side.
  const cellsOf = (row?: Row) => (
    <>
      <div
        aria-hidden
        className="w-(--gap) shrink-0"
        ref={cssVars({ "--gap": `${before}px` })}
      />
      {shownColumns.map((item) => {
        const column = byId.get(item.id);
        return column === undefined ? null : (
          <div
            aria-colindex={item.index + 1}
            className={cn(
              cellVariants({ part: row === undefined ? "header" : "body" }),
              "w-(--width)"
            )}
            key={column.id}
            ref={cssVars({ "--width": `${item.size}px` })}
            role={row === undefined ? "columnheader" : "gridcell"}
          >
            {row === undefined ? column.header : column.cell(row)}
          </div>
        );
      })}
      <div
        aria-hidden
        className="w-(--gap) shrink-0"
        ref={cssVars({ "--gap": `${after}px` })}
      />
    </>
  );
  return (
    <div
      aria-colcount={columns.length}
      aria-label={label}
      aria-rowcount={rows.length + 1}
      className={cn("min-h-0 min-w-0 flex-1 overflow-auto", className)}
      data-slot="record-grid"
      onScroll={(event) => {
        const { scrollTop, scrollLeft } = event.currentTarget;
        setViewport((held) => ({
          ...held,
          top: scrollTop,
          left: scrollLeft,
        }));
      }}
      ref={scroller}
      role="grid"
    >
      <div className="w-max min-w-full">
        <div
          aria-rowindex={1}
          className="bg-muted sticky top-0 z-10 flex"
          role="row"
        >
          {cellsOf()}
          <div aria-hidden className="flex-1 border-b" />
        </div>
        {rows.length === 0 ? (
          empty
        ) : (
          <div
            className="relative h-(--height)"
            ref={cssVars({ "--height": `${tableRows.length * rowHeight}px` })}
          >
            {tableRows.slice(firstRow, pastRow).map((tableRow, offset) => {
              const index = firstRow + offset;
              return (
                <div
                  aria-rowindex={index + 2}
                  className="absolute inset-x-0 top-(--top) flex h-9"
                  key={tableRow.id}
                  ref={cssVars({ "--top": `${index * rowHeight}px` })}
                  role="row"
                >
                  {cellsOf(tableRow.original)}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A column header: the field's kind as an icon, its name, and a mark when
 * it is required (`requiredLabel` says it to assistive technology).
 */
function RecordGridHeader({
  icon,
  required = false,
  requiredLabel,
  children,
  className,
  ...props
}: React.ComponentProps<"span"> & {
  icon?: React.ReactNode;
  required?: boolean;
  requiredLabel?: string;
}) {
  return (
    <span
      data-slot="record-grid-header"
      className={cn(
        "flex min-w-0 items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0",
        className
      )}
      {...props}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      {required ? (
        <span
          aria-label={requiredLabel}
          className="text-status-attention"
          role="img"
        >
          *
        </span>
      ) : null}
    </span>
  );
}

const recordGridValueVariants = cva("min-w-0 truncate", {
  variants: {
    tone: {
      default: "",
      muted: "text-muted-foreground",
      code: "text-muted-foreground font-mono text-xs",
    },
  },
  defaultVariants: { tone: "default" },
});

/** A cell's value, cut to its column: plain, muted, or an ID. */
function RecordGridValue({
  tone,
  className,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof recordGridValueVariants>) {
  return (
    <span
      data-slot="record-grid-value"
      className={cn(recordGridValueVariants({ tone }), className)}
      {...props}
    />
  );
}

export { RecordGrid, RecordGridHeader, RecordGridValue };
export type { RecordGridColumn };
