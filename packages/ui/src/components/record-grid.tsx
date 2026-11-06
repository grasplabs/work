import { cssVars } from "@grasp-os/ui/lib/css-vars";
import { cn } from "@grasp-os/ui/lib/utils";
import {
  columnSizingFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import type { ColumnDef } from "@tanstack/react-table";
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import type { Rect, Virtualizer } from "@tanstack/react-virtual";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { useEffect, useEffectEvent, useRef } from "react";
import type * as React from "react";

/*
 * A dense grid of records, as a database's studio shows a table: a sticky
 * row of column headers (each the page's to fill: a field's kind, name and
 * whether it is required), then the records, a row each. TanStack Table
 * keeps the columns, their widths and the rows; TanStack Virtual draws
 * only the rows and columns in view, so a table of a million rows and
 * dozens of fields scrolls as one of ten. Nearing the last row it has, the
 * grid asks for more (`onEndReached`), so the page loads the next one as
 * people scroll. It reads as an ARIA grid: rows and cells by role, with the
 * table's whole size given (`aria-rowcount`, `aria-colcount`).
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

/** How near its last row the grid asks for more, in rows. */
const endReachedWithin = 20;

/** A laptop's screen: the grid's size until it is laid out. */
const unmeasured: Rect = { width: 1280, height: 720 };

/**
 * The grid's size as it shows, kept as it changes; a size of nothing (not
 * laid out yet, or a test's page, which lays out nothing) keeps the last.
 */
const observeShown = (
  instance: Virtualizer<HTMLDivElement, Element>,
  heard: (rect: Rect) => void
) =>
  observeElementRect(instance, (rect) => {
    if (rect.width > 0 || rect.height > 0) {
      heard(rect);
    }
  });

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
  // Left to React as it is: the React Compiler lists `useVirtualizer` as
  // incompatible (it returns functions whose results change while the
  // functions stay the same, so memoized output would go stale), and
  // TanStack's own advice is to opt the component out.
  "use no memo";
  const scroller = useRef<HTMLDivElement>(null);
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
  const rowWindow = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 8,
    initialRect: unmeasured,
    observeElementRect: observeShown,
  });
  const columnWindow = useVirtualizer({
    horizontal: true,
    count: leaves.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => leaves[index]?.getSize() ?? defaultWidth,
    overscan: 2,
    initialRect: unmeasured,
    observeElementRect: observeShown,
  });
  const shownRows = rowWindow.getVirtualItems();
  const shownColumns = columnWindow.getVirtualItems();
  const before = shownColumns[0]?.start ?? 0;
  const after = columnWindow.getTotalSize() - (shownColumns.at(-1)?.end ?? 0);
  const count = tableRows.length;
  const nearEnd =
    count > 0 && (shownRows.at(-1)?.index ?? 0) >= count - endReachedWithin;
  const reachEnd = useEffectEvent(() => {
    onEndReached?.();
  });
  // Each time the rows near their end, once per count of rows: a page
  // that loaded nothing more isn't asked again until it has.
  useEffect(() => {
    if (nearEnd) {
      reachEnd();
    }
  }, [nearEnd, count]);
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
        const column = columns[item.index];
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
            ref={cssVars({ "--height": `${rowWindow.getTotalSize()}px` })}
          >
            {shownRows.map((item) => {
              const tableRow = tableRows[item.index];
              return tableRow === undefined ? null : (
                <div
                  aria-rowindex={item.index + 2}
                  className="absolute inset-x-0 top-(--top) flex h-9"
                  key={tableRow.id}
                  ref={cssVars({ "--top": `${item.start}px` })}
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
