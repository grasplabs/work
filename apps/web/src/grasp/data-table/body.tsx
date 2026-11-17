// What the Data table's body holds: why there are no rows (failed, loading, none yet, none
// found), or the rows, with placeholders after them while more come.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";

import { Button } from "../button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "../empty";
import { TableCell, TableRow } from "../table";
import { DataRow, GroupRow, Placeholders } from "./rows";
import { styles } from "./styles";
import type { DataTableEmpty, DataTableProps } from "./types";
import { noCondition } from "./use-data-table";
import type { Model } from "./use-data-table";
import type { DataTableWords } from "./words";

interface BodyProps<Row extends RowData> {
  model: Model<Row>;
  props: DataTableProps<Row>;
  words: DataTableWords;
  many: string;
}

// A row that speaks for the whole table. Its words stand in what the box shows and stay there
// while the table scrolls sideways (they were cut at both ends, the head scrolled to "…wner").
const Across = <Row extends RowData>({
  model,
  children,
}: {
  model: Model<Row>;
  children: ReactNode;
}) => (
  <TableRow>
    <TableCell colSpan={model.span}>
      <div {...stylex.props(styles.across)}>{children}</div>
    </TableCell>
  </TableRow>
);

/** An Empty from what a page gave: its words, its picture, its way on. */
const Said = ({ state }: { state: DataTableEmpty }) => (
  <Empty shape={state.shape}>
    <EmptyHeader>
      <EmptyMedia icon={state.icon} picture={state.picture} />
      <EmptyTitle>{state.title}</EmptyTitle>
      <EmptyDescription>{state.description}</EmptyDescription>
    </EmptyHeader>
    <EmptyContent>{state.action}</EmptyContent>
  </Empty>
);

/** The page's own words for nothing found, told what was asked so they can name it. */
const NoMatch = <Row extends RowData>({
  model,
  props,
  noMatch,
}: {
  model: Model<Row>;
  props: DataTableProps<Row>;
  noMatch: NonNullable<DataTableProps<Row>["noMatch"]>;
}) => {
  const { fieldId, operatorId, value } = model.own.condition;
  const filter =
    model.filtered && fieldId !== null
      ? {
          column: fieldId,
          header:
            props.columns.find((column) => column.key === fieldId)?.header ??
            fieldId,
          operator: operatorId ?? "",
          value: value === null ? "" : String(value),
        }
      : null;
  const found = noMatch({
    query: model.own.query,
    filter,
    clear: () => {
      model.own.setQuery("");
      model.own.setCondition(noCondition);
    },
  });
  return (
    <Across model={model}>
      <Said state={found} />
    </Across>
  );
};

/** Why there are no rows, when there are none to show; nothing when there are. */
const Outcome = <Row extends RowData>({
  model,
  props,
  words,
  many,
}: BodyProps<Row>) => {
  const selectable = props.selectable === true;
  const hasActions = props.rowActions !== undefined;
  if (props.failed !== undefined) {
    const { onRetry } = props.failed;
    return (
      <Across model={model}>
        <div {...stylex.props(styles.state)}>
          <Empty tone="danger">
            <EmptyHeader>
              <EmptyMedia />
              <EmptyTitle>
                {props.failed.title ?? words.failed(many)}
              </EmptyTitle>
              <EmptyDescription>
                {props.failed.description ?? words.failedDetail}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
          {onRetry !== undefined && (
            <Button
              size="sm"
              variant="quiet"
              onClick={() => {
                onRetry();
              }}
            >
              {words.tryAgain}
            </Button>
          )}
        </div>
      </Across>
    );
  }
  if (props.loading === true) {
    return (
      <Placeholders
        model={model}
        count={props.pageSize ?? 5}
        selectable={selectable}
        hasActions={hasActions}
      />
    );
  }
  if (model.table.getRowModel().rows.length > 0) {
    return null;
  }
  if (model.own.query === "" && !model.filtered) {
    return (
      <Across model={model}>
        <Said state={props.empty ?? { description: words.noneYet(many) }} />
      </Across>
    );
  }
  if (props.noMatch !== undefined) {
    return <NoMatch model={model} props={props} noMatch={props.noMatch} />;
  }
  return (
    <Across model={model}>
      <span {...stylex.props(styles.empty)}>
        {model.own.query === ""
          ? words.noneMeet(many)
          : words.noMatch(many, model.own.query)}
      </span>
    </Across>
  );
};

export const Body = <Row extends RowData>({
  model,
  props,
  words,
  many,
}: BodyProps<Row>) => {
  const outcome = (
    <Outcome model={model} props={props} words={words} many={many} />
  );
  const asked = model.own.query !== "" || model.filtered;
  if (
    props.failed === undefined &&
    props.loading !== true &&
    model.table.getRowModel().rows.length === 0 &&
    asked
  ) {
    // Nothing matches: the rows stay, collapsed, so the columns keep the widths they had and the
    // head does not jump as the search is typed ("Team" moved 210px when the last match went).
    return (
      <>
        {outcome}
        {model.table
          .getCoreRowModel()
          .rows.slice(0, props.pageSize ?? 20)
          .map((row) => (
            <DataRow
              key={row.id}
              model={model}
              row={row}
              words={words}
              selectable={props.selectable === true}
              rowActions={props.rowActions}
              kept
            />
          ))}
      </>
    );
  }
  if (
    props.failed !== undefined ||
    props.loading === true ||
    model.table.getRowModel().rows.length === 0
  ) {
    return outcome;
  }
  const selectable = props.selectable === true;
  const { groupBy } = props;
  return (
    <>
      {model.table.getRowModel().rows.map((row) =>
        // A piece's API exists only while the table holds the piece: grouping's is asked only then.
        model.flags.grouping && groupBy !== undefined && row.getIsGrouped() ? (
          <GroupRow
            key={row.id}
            model={model}
            row={row}
            groupBy={groupBy}
            words={words}
          />
        ) : (
          <DataRow
            key={row.id}
            model={model}
            row={row}
            words={words}
            selectable={selectable}
            rowActions={props.rowActions}
            detail={props.detail}
          />
        )
      )}
      {props.loadingMore === true && (
        <Placeholders
          model={model}
          count={3}
          selectable={selectable}
          hasActions={props.rowActions !== undefined}
        />
      )}
    </>
  );
};
