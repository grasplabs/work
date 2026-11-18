// The rows of a Data table: a row of data (its checkbox, its cells, its actions, its detail), a
// group's heading row, and the placeholders that stand in for rows on their way.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";

import { Badge } from "../badge";
import { Button } from "../button";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { visuallyHidden } from "../hidden/hidden";
import { ChevronDown, ChevronRight, More } from "../icons";
import { Skeleton } from "../skeleton";
import { TableCell, TableRow, tableAboveStatus } from "../table";
import { ChooseRow } from "./choose";
import { styles } from "./styles";
import type { DataTableRowAction } from "./types";
import type { Model, TableRowOf } from "./use-data-table";
import type { DataTableWords } from "./words";

const detailId = (key: string) => `${key}-detail`;

interface ToggleProps<Row extends RowData> {
  row: TableRowOf<Row>;
  /** Open now: given, not asked of the row (whose own answer a memoized part would not see change). */
  open: boolean;
  name: string;
  words: DataTableWords;
  /** The detail it opens, when it opens one. */
  controls?: string;
}

/** Opens and closes a row's detail, its own rows, or a group. */
const Toggle = <Row extends RowData>({
  row,
  open,
  name,
  words,
  controls,
}: ToggleProps<Row>) => (
  <span {...stylex.props(styles.inRow)}>
    <Button
      variant="ghost"
      size="xs"
      icon={open ? ChevronDown : ChevronRight}
      aria-label={open ? words.close(name) : words.open(name)}
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      onClick={() => {
        row.toggleExpanded();
      }}
    />
  </span>
);

interface GroupRowProps<Row extends RowData> {
  model: Model<Row>;
  row: TableRowOf<Row>;
  groupBy: string;
  words: DataTableWords;
  /** The group asks for attention: its count takes the tone, and it is said. */
  tone?: "attention";
}

/** A group's heading: its toggle, the value its rows share as a heading, and how many they are. */
export const GroupRow = <Row extends RowData>({
  model,
  row,
  groupBy,
  words,
  tone,
}: GroupRowProps<Row>) => {
  const value = String(row.getGroupingValue(groupBy));
  const header = model.metaOf(groupBy)?.header ?? groupBy;
  return (
    <TableRow>
      <TableCell colSpan={model.span} lead sticky>
        <span data-slot="data-table-group" {...stylex.props(styles.group)}>
          <Toggle
            row={row}
            open={model.isOpen(row.id)}
            name={`${header}: ${value}`}
            words={words}
          />
          <span>{value}</span>
          <Badge tone={tone ?? "neutral"} size="sm">
            <span {...stylex.props(styles.groupCount)}>
              {row.getLeafRows().length}
            </span>
          </Badge>
          {tone === "attention" && (
            <span
              {...stylex.props(visuallyHidden)}
            >{`, ${words.groupAttention}`}</span>
          )}
        </span>
      </TableCell>
    </TableRow>
  );
};

interface RowActionsProps {
  actions: readonly DataTableRowAction[];
  label: string;
}

const RowActions = ({ actions, label }: RowActionsProps) => (
  <DropdownMenu>
    <span {...stylex.props(styles.inRow)}>
      <DropdownMenuTrigger
        variant="ghost"
        size="xs"
        icon={More}
        aria-label={label}
      />
    </span>
    <DropdownMenuContent align="end">
      {actions.map((action) => (
        <DropdownMenuItem
          key={action.label}
          onSelect={() => {
            action.onSelect();
          }}
        >
          {action.label}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);

interface DataRowProps<Row extends RowData> {
  model: Model<Row>;
  row: TableRowOf<Row>;
  words: DataTableWords;
  selectable: boolean;
  rowActions?: (row: Row) => readonly DataTableRowAction[];
  detail?: (row: Row) => ReactNode;
  /** Kept only for the column widths it gives, while a search or a filter matches no row. */
  kept?: boolean;
  /** The row's state (`rowStatus`): drawn over the row, said after its first words. */
  status?: "pending" | "removed";
}

/** A row's state, said after its first words, for a screen reader: the look alone is not enough. */
const StatusWords = ({
  status,
  words,
}: {
  status: "pending" | "removed" | undefined;
  words: DataTableWords;
}) =>
  status === undefined ? null : (
    <span
      {...stylex.props(visuallyHidden)}
    >{`, ${status === "pending" ? words.rowPending : words.rowRemoved}`}</span>
  );

/** The lead cell's words, after a toggle when the row opens, stepped in when it is deeper. */
const Lead = <Row extends RowData>({
  model,
  row,
  words,
  content,
  detail,
}: Omit<DataRowProps<Row>, "selectable" | "rowActions"> & {
  content: ReactNode;
}) => {
  const opens =
    model.flags.expanding && !model.flags.grouping && row.getCanExpand();
  return (
    <span {...stylex.props(styles.opener, styles.depth(row.depth))}>
      {opens ? (
        <Toggle
          row={row}
          open={model.isOpen(row.id)}
          name={model.name(row)}
          words={words}
          controls={detail === undefined ? undefined : detailId(row.id)}
        />
      ) : (
        <span {...stylex.props(styles.toggleRoom)} />
      )}
      <span {...stylex.props(styles.openerWords)}>{content}</span>
    </span>
  );
};

/** A row of data, and its detail under it while it is open. */
export const DataRow = <Row extends RowData>({
  model,
  row,
  words,
  selectable,
  rowActions,
  detail,
  kept = false,
  status,
}: DataRowProps<Row>) => (
  <>
    <TableRow chosen={model.isChosen(row.id)} open={!kept} status={status}>
      {selectable && (
        <TableCell pin={model.choosePin}>
          <ChooseRow
            row={row}
            checked={model.isChosen(row.id)}
            label={words.choose(model.name(row))}
          />
        </TableCell>
      )}
      {model.shown.map((column) => {
        const meta = model.metaOf(column.id);
        if (meta === undefined) {
          return null;
        }
        const content =
          meta.cell === undefined
            ? meta.value(row.original)
            : meta.cell(row.original);
        const lead = column.id === model.flags.lead;
        // The lead cell steps in for a deeper row, and holds a toggle in a table whose rows open.
        // A group's rows stand on the columns' own lines: the group's toggle is in its heading.
        const opener =
          lead &&
          !model.flags.grouping &&
          (model.flags.expanding || row.depth > 0);
        // A control in the cell stands in a box one line tall, as the row's menu does: the row keeps its height.
        const shown =
          meta.control === true ? (
            <span {...stylex.props(styles.cellControl)}>{content}</span>
          ) : (
            content
          );
        return (
          <TableCell
            key={column.id}
            lead={lead}
            align={meta.align}
            wrap={meta.wrap === true}
            pin={model.pinOf(column.id)}
            clip={model.sized}
            title={String(meta.value(row.original))}
            hideBelow={model.hideOf(column.id)}
          >
            {opener ? (
              <Lead
                model={model}
                row={row}
                words={words}
                content={content}
                detail={detail}
              />
            ) : (
              shown
            )}
            {lead && <StatusWords status={status} words={words} />}
          </TableCell>
        );
      })}
      {rowActions !== undefined && (
        <TableCell align="end">
          {/* Above a row's state: its actions stay fully seen and usable. */}
          <span {...stylex.props(styles.cellControl, tableAboveStatus)}>
            <RowActions
              actions={rowActions(row.original)}
              label={words.actionsFor(model.name(row))}
            />
          </span>
        </TableCell>
      )}
    </TableRow>
    {detail !== undefined && model.flags.expanding && model.isOpen(row.id) && (
      <TableRow>
        <TableCell colSpan={model.span}>
          <div id={detailId(row.id)} {...stylex.props(styles.detail)}>
            {detail(row.original)}
          </div>
        </TableCell>
      </TableRow>
    )}
  </>
);

interface PlaceholdersProps<Row extends RowData> {
  model: Model<Row>;
  count: number;
  selectable: boolean;
  hasActions: boolean;
}

/** Placeholders in the rows' place, each a row's height, so nothing moves when the rows come. */
export const Placeholders = <Row extends RowData>({
  model,
  count,
  selectable,
  hasActions,
}: PlaceholdersProps<Row>) =>
  Array.from({ length: count }, (_, index) => (
    <TableRow key={`waiting-${String(index)}`}>
      {selectable && (
        <TableCell pin={model.choosePin}>
          <span {...stylex.props(styles.pick)} />
        </TableCell>
      )}
      {model.shown.map((column, at) => (
        <TableCell
          key={column.id}
          pin={model.pinOf(column.id)}
          align={model.metaOf(column.id)?.align}
          hideBelow={model.hideOf(column.id)}
        >
          <span
            {...stylex.props(at === 0 ? styles.waitingLead : styles.waiting)}
          >
            <Skeleton />
          </span>
        </TableCell>
      ))}
      {hasActions && <TableCell />}
    </TableRow>
  ));
