// The view, in a link: read from the table's location when it opens and on Back and Forward, and
// written as it changes. The first write waits for the read view to be in place.
"use client";

import type { RowData } from "@tanstack/react-table";
import { useEffect, useEffectEvent, useRef } from "react";

import { isSet } from "./filters";
import type { DataTableView } from "./location";
import type { DataTableProps } from "./types";
import { listOf } from "./use-data-table";
import type { Model } from "./use-data-table";

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

const viewOf = <Row extends RowData>(
  model: Model<Row>,
  props: DataTableProps<Row>
): DataTableView => {
  const { own, flags } = model;
  const view: DataTableView = {};
  if (own.sort.length > 0 && !same(own.sort, listOf(props.defaultSort))) {
    view.sort = [...own.sort];
  }
  if (own.query !== "") {
    view.query = own.query;
  }
  const { fieldId, operatorId, value } = own.condition;
  if (
    isSet(own.condition) &&
    fieldId !== null &&
    operatorId !== null &&
    value !== null
  ) {
    view.filter = { field: fieldId, operator: operatorId, value };
  }
  if (model.pageNow > 1) {
    view.page = model.pageNow;
  }
  const hidden = Object.entries(own.visibility)
    .filter(([, shown]) => !shown)
    .map(([key]) => key);
  const startHidden = props.columns
    .filter((column) => column.hidden === true)
    .map((column) => column.key);
  if (flags.hiding && !same(hidden, startHidden)) {
    view.hidden = hidden;
  }
  if (
    flags.ordering &&
    !same(
      own.order,
      props.columns.map((column) => column.key)
    )
  ) {
    view.order = own.order;
  }
  const start = own.pinned.start ?? [];
  const end = own.pinned.end ?? [];
  if (flags.pinning && start.length + end.length > 0) {
    view.pinned = { start, end };
  }
  return view;
};

export const useView = <Row extends RowData>(
  model: Model<Row>,
  props: DataTableProps<Row>
) => {
  const { location } = props;
  // Where the read is: none yet, read (the next write is the read view itself: skipped), or done.
  const readRef = useRef<"none" | "read" | "done">("none");
  const lastRef = useRef("");
  const { own, flags } = model;

  const apply = useEffectEvent((view: DataTableView) => {
    own.setSort(view.sort ?? [...listOf(props.defaultSort)]);
    own.setQuery(view.query ?? "");
    own.setCondition(
      view.filter === undefined
        ? { fieldId: null, operatorId: null, value: null }
        : {
            fieldId: view.filter.field,
            operatorId: view.filter.operator,
            value: view.filter.value,
          }
    );
    own.setPage(view.page ?? 1);
    if (flags.hiding) {
      const hidden =
        view.hidden ??
        props.columns
          .filter((column) => column.hidden === true)
          .map((column) => column.key);
      own.setVisibility(Object.fromEntries(hidden.map((key) => [key, false])));
    }
    if (flags.ordering) {
      const keys = props.columns.map((column) => column.key);
      const known = (view.order ?? []).filter((key) => keys.includes(key));
      own.setOrder([...known, ...keys.filter((key) => !known.includes(key))]);
    }
    if (flags.pinning && view.pinned !== undefined) {
      own.setPinned(view.pinned);
    }
  });

  useEffect(() => {
    if (location !== undefined) {
      apply(location.read());
      readRef.current = "read";
    }
    const stop = location?.listen(() => {
      apply(location.read());
    });
    return () => {
      stop?.();
    };
  }, [location]);

  // Written when what a link would hold changes, not on every render.
  const key = JSON.stringify(viewOf(model, props));
  const write = useEffectEvent(() => {
    location?.write(viewOf(model, props));
  });
  useEffect(() => {
    if (readRef.current === "read") {
      readRef.current = "done";
      lastRef.current = key;
      return;
    }
    if (readRef.current === "done" && lastRef.current !== key) {
      lastRef.current = key;
      write();
    }
  }, [key]);
};
