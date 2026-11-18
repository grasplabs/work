// DataTable: a Table (src/components/table) that sorts, searches, chooses rows and pages through
// them, on TanStack Table (engine.ts) as shadcn's data table is, made Grasp's and given a data API:
// columns and rows as data, so the same table is known to the server, an agent and a person.
// It is made of the finished parts: Table, TableHead's sort, Checkbox, InputGroup, Pagination,
// the Filter builder, Button, Dropdown menu, Alert dialog, Toast, Empty and Skeleton. Sorting
// takes several columns (Shift and a column's name adds it); choosing rows takes a range (Shift
// and a checkbox). The rest comes in pieces (pieces.ts), each opt-in. Every word is a prop
// (`words`), with English defaults.
//
//   <DataTable
//     label="Reports"
//     rows={reports}
//     rowKey={(report) => report.id}
//     columns={[
//       { key: "name", header: "Report", value: (report) => report.name, sortable: true },
//       { key: "pages", header: "Pages", value: (report) => report.pages, align: "end", sortable: true },
//     ]}
//     searchable
//     selectable
//     pageSize={10}
//   />
//
// Parts: use-data-table.ts (the model), bar.tsx, head-row.tsx, body.tsx and rows.tsx (what it
// draws), use-view.ts (the view in a link), use-end.ts (endless loading). Every value is a token.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { RowData } from "@tanstack/react-table";
import { usePart, usePrimitive } from "@ui-sdk/react/primitive";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { visuallyHidden } from "../hidden/hidden";
import {
  Pagination,
  PaginationRange,
  PaginationContent,
  PaginationItem,
  PaginationPrevious,
  PaginationNext,
} from "../pagination";
import { Table, TableBody, TableHeader } from "../table";
import { toast as pageToast } from "../toast";
import { useWords, withGiven } from "../words/words";
import { dataTableAgent } from "./agent";
import { Bar } from "./bar";
import { Body } from "./body";
import { Confirm } from "./confirm";
import { save, toCsv } from "./csv";
import { fieldsFor } from "./filters";
import { HeadRow } from "./head-row";
import { styles } from "./styles";
import { toolsFor } from "./tools";
import type { DataTableAction, DataTableProps } from "./types";
import { useDataTable } from "./use-data-table";
import { useEnd } from "./use-end";
import { useView } from "./use-view";
import { dataTableNotices, dataTableWords, englishFilterWords } from "./words";
import type { DataTableWords } from "./words";

/** Says so, once, when the table toasts and the page has no Toaster to draw it. */
let warned = false;
const warnWithoutToaster = () => {
  if (!warned && document.querySelector("[data-slot=toast-region]") === null) {
    warned = true;
    console.warn(dataTableNotices.noToaster);
  }
};

/** What holds focus now, when it is an element that can take it back. */
const focused = () =>
  document.activeElement instanceof HTMLElement &&
  document.activeElement !== document.body
    ? document.activeElement
    : null;

/**
 * Rows that replace their placeholders fade in; rows there from the first paint do not. Kept as
 * state, compared while rendering, so no ref is read in render.
 */
const useArrived = (loading: boolean) => {
  const [was, setWas] = useState(loading);
  const [arrived, setArrived] = useState(false);
  if (was !== loading) {
    setWas(loading);
    if (was) {
      setArrived(true);
    }
  }
  return arrived && !loading;
};

/**
 * While rows are on their way the table stands as tall as it last did, so nothing under it moves
 * when placeholders of one line take the place of rows that ran to two (a phone). Measured after
 * each draw with rows; held from the draw that starts loading until the rows are back.
 */
const useKeptHeight = (
  holder: RefObject<HTMLElement | null>,
  loading: boolean
) => {
  const last = useRef(0);
  const [kept, setKept] = useState<number | null>(null);
  // After every draw with rows: how tall the table stands now.
  useLayoutEffect(() => {
    if (!loading) {
      last.current =
        holder.current?.querySelector<HTMLElement>(
          "[data-slot=table-container]"
        )?.offsetHeight ?? 0;
    }
  });
  // As loading starts, before it is painted: hold that height. As it ends: let go.
  useLayoutEffect(() => {
    setKept(loading && last.current > 0 ? last.current : null);
  }, [loading]);
  return kept;
};

/** Whether the bar above the table holds anything. */
const barShown = <Row,>(props: DataTableProps<Row>, hiding: boolean) =>
  props.searchable === true ||
  props.selectable === true ||
  props.filterable === true ||
  props.exportable !== undefined ||
  hiding;

/** What is said once, to a screen reader, while rows are on their way. */
const statusOf = <Row,>(
  props: DataTableProps<Row>,
  words: DataTableWords,
  many: string
) => {
  if (props.loading === true) {
    return words.loading(many);
  }
  return props.loadingMore === true ? words.loadingMore(many) : "";
};

/** A Table that sorts, searches, chooses rows and pages through them. */
export const DataTable = <Row extends RowData>(props: DataTableProps<Row>) => {
  const { label, caption, pageSize, toaster } = props;
  // Its words: the product's, by its catalogue, else English; the caller's `words`, `filterWords`
  // and `unit` still win.
  const { rows: rowsUnit, ...catalogued } = useWords(
    "dataTable",
    dataTableWords
  );
  const unit = props.unit ?? rowsUnit;
  const words = withGiven(catalogued, props.words ?? {});
  const filterWords = withGiven(
    useWords("dataTableFilters", englishFilterWords),
    props.filterWords ?? {}
  );
  const { model, holder } = useDataTable(props);
  // The page's Toaster draws the table's toasts (the shared `toast`), or the host's own (`toaster`).
  const toast = toaster ?? pageToast;
  const [asking, setAsking] = useState<DataTableAction | null>(null);
  // Focus never falls back to the page after an action. What held focus when an action was asked
  // or done takes it back once the change is drawn; if that is gone (the bar leaves when nothing
  // is chosen any more), the head's checkbox takes it, the nearest control that is always there.
  const back = useRef<HTMLElement | null>(null);
  const settle = useRef(false);
  useEffect(() => {
    if (settle.current) {
      settle.current = false;
      const was = back.current;
      back.current = null;
      const next =
        was !== null && was.isConnected
          ? was
          : holder.current?.querySelector<HTMLElement>("thead [role=checkbox]");
      next?.focus({ preventScroll: true });
    }
  });
  const arrived = useArrived(props.loading === true);
  const kept = useKeptHeight(holder, props.loading === true);
  useView(model, props);
  const endRef = useEnd({
    onEndReached: props.onEndReached,
    watching:
      props.hasMore === true &&
      props.loadingMore !== true &&
      props.loading !== true,
    inBox: props.height !== undefined,
    count: props.rows.length,
  });

  const fields = fieldsFor(props.columns, filterWords);
  // The table as the page's agent bridge knows it: named by its label, with actions of its own.
  const agentHandle = usePrimitive(dataTableAgent, {
    tools: toolsFor(model, props, fields),
  });

  const count = model.own.chosen.length;
  const unitFor = (number: number) => (number === 1 ? unit.one : unit.other);
  // Does an action to the chosen rows; an undoable one says so with Undo in a Toast.
  const handleAct = (action: DataTableAction) => {
    // Asked first (a grave action): what asked keeps its claim. Done at once: what was pressed.
    const asked = back.current;
    back.current = asked ?? focused();
    settle.current = true;
    const keys = [...model.own.chosen];
    const undo = action.run(keys);
    model.table.resetRowSelection(true);
    const said = words.done(action.label, keys.length, unitFor(keys.length));
    warnWithoutToaster();
    if (undo === undefined) {
      toast(said);
    } else {
      toast(said, { action: { label: words.undo, onAction: undo } });
    }
  };
  // Export: the rows found, every page, in the columns shown.
  const handleExport = () => {
    const metas = model.shownKeys
      .map((key) => model.metaOf(key))
      .filter((meta) => meta !== undefined);
    const rows = model.table
      .getPrePaginatedRowModel()
      .flatRows.filter((row) => !model.flags.grouping || !row.getIsGrouped())
      .map((row) => metas.map((meta) => meta.value(row.original)));
    save(
      toCsv(
        metas.map((meta) => meta.header),
        rows
      ),
      props.exportable ?? label
    );
  };

  const hasBar = barShown(props, model.flags.hiding);
  const found =
    props.server === undefined
      ? model.table.getPrePaginatedRowModel().rows.length
      : (model.total ?? 0);
  const status = statusOf(props, words, unit.other);

  // Named for scripts and styles that find it; given as a value, since a part's props name no data
  // attributes.
  const slot = { "data-slot": "data-table" };
  return usePart(
    agentHandle,
    "root",
    {},
    {
      ...slot,
      ref: holder,
      "aria-label": label,
      "aria-busy": props.loading === true ? true : undefined,
      ...stylex.props(styles.table),
      children: (
        <>
          <output {...stylex.props(visuallyHidden)}>{status}</output>
          {hasBar && (
            <Bar
              model={model}
              props={props}
              words={words}
              fields={fields}
              many={unit.other}
              onAct={handleAct}
              onAsk={(action) => {
                back.current = focused();
                setAsking(action);
              }}
              onExport={handleExport}
            />
          )}
          <div
            {...stylex.props(
              styles.hold,
              kept !== null && styles.keeps(`${String(kept)}px`)
            )}
          >
            <Table
              caption={caption}
              aria-label={caption === undefined ? label : undefined}
              density={props.density}
              height={props.height}
              width={model.tableWidth}
              fade={!model.holds}
              rangeLook={(props.appearance ?? props.look)?.range}
              headLook={(props.appearance ?? props.look)?.head}
              end={<div ref={endRef} aria-hidden="true" />}
            >
              <TableHeader>
                <HeadRow
                  model={model}
                  words={words}
                  selectable={props.selectable === true}
                  one={unit.one}
                  hasActions={props.rowActions !== undefined}
                />
              </TableHeader>
              <TableBody arrived={arrived}>
                <Body
                  model={model}
                  props={props}
                  words={words}
                  many={unit.other}
                />
              </TableBody>
            </Table>
          </div>
          {pageSize !== undefined && found > pageSize && (
            <Pagination
              total={found}
              pageSize={pageSize}
              page={model.pageNow}
              onPageChange={(next) => {
                model.table.setPageIndex(next - 1);
              }}
              unit={unit}
              aria-label={words.pages(label)}
            >
              <PaginationRange />
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious />
                </PaginationItem>
                <PaginationItem>
                  <PaginationNext />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
          <Confirm
            asking={asking}
            count={count}
            unit={unitFor(count)}
            words={words}
            onAnswer={(yes) => {
              if (yes && asking !== null) {
                handleAct(asking);
              }
              // Cancelled: focus goes back to the button that asked.
              settle.current = true;
              setAsking(null);
            }}
          />
        </>
      ),
    }
  );
};
