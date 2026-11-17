// What an agent can do with a Data table (agent.ts), made from the table's model: read its columns
// and rows, and change its view as a person can. Each answers with plain data, or `{ error }`.
import type { RowData } from "@tanstack/react-table";

import type { FilterField } from "../filter-builder";
import type { DataTableTools } from "./agent";
import type { DataTableProps } from "./types";
import type { Model } from "./use-data-table";
import { agentErrors } from "./words";

const most = 200;

export const toolsFor = <Row extends RowData>(
  model: Model<Row>,
  props: DataTableProps<Row>,
  fields: readonly FilterField[]
): DataTableTools => {
  const { table, own } = model;
  const columns = props.columns.map((column) => ({
    key: column.key,
    header: column.header,
    sortable: column.sortable === true,
    filterable: props.filterable === true && column.filter !== false,
  }));
  const found = () =>
    table
      .getPrePaginatedRowModel()
      .flatRows.filter((row) => !model.flags.grouping || !row.getIsGrouped());
  const pages = () =>
    Math.max(
      1,
      Math.ceil(
        found().length / (props.pageSize ?? Math.max(1, found().length))
      )
    );
  return {
    read: (input) => {
      const offset = Math.max(0, input?.offset ?? 0);
      const rows = found();
      return {
        label: props.label,
        columns,
        rows: rows.slice(offset, offset + most).map((row) => ({
          key: row.id,
          chosen: model.isChosen(row.id),
          values: Object.fromEntries(
            props.columns.map((column) => [
              column.key,
              column.value(row.original),
            ])
          ),
        })),
        found: model.total ?? rows.length,
        offset,
        more: offset + most < rows.length,
        view: {
          sort: own.sort,
          query: own.query,
          filter: own.condition,
          page: model.pageNow,
          pages: pages(),
        },
      };
    },
    sortBy: ({ key, order, add = false }) => {
      const column = props.columns.find((each) => each.key === key);
      if (column?.sortable !== true) {
        return {
          error: agentErrors.noSort(
            key,
            columns.filter((each) => each.sortable).map((each) => each.key)
          ),
        };
      }
      table
        .getColumn(key)
        ?.toggleSorting(
          order === undefined ? undefined : order === "descending",
          add
        );
      return { sorted: key };
    },
    search: ({ query }) => {
      if (props.searchable !== true) {
        return { error: agentErrors.noSearch };
      }
      table.setGlobalFilter(query);
      return { query };
    },
    filter: (input) => {
      if (props.filterable !== true) {
        return { error: agentErrors.noFilter };
      }
      if (input === null) {
        own.setCondition({ fieldId: null, operatorId: null, value: null });
        return { filter: null };
      }
      const field = fields.find((each) => each.id === input.field);
      if (field === undefined) {
        return {
          error: agentErrors.noField(
            input.field,
            fields.map((each) => each.id)
          ),
        };
      }
      if (!field.operators.some((each) => each.id === input.operator)) {
        return {
          error: agentErrors.noOperator(
            input.operator,
            field.id,
            field.operators.map((each) => each.id)
          ),
        };
      }
      own.setCondition({
        fieldId: input.field,
        operatorId: input.operator,
        value: input.value,
      });
      own.setPage(1);
      return { filter: input };
    },
    choose: ({ keys }) => {
      if (props.selectable !== true) {
        return { error: agentErrors.noChoosing };
      }
      const known = new Set(found().map((row) => row.id));
      const unknown = keys.filter((key) => !known.has(key));
      if (unknown.length > 0) {
        return { error: agentErrors.noRows(unknown) };
      }
      own.setChosen([...keys]);
      return { chosen: keys };
    },
    page: ({ page }) => {
      if (!Number.isInteger(page) || page < 1 || page > pages()) {
        return { error: agentErrors.pages(pages()) };
      }
      table.setPageIndex(page - 1);
      return { page };
    },
  };
};
