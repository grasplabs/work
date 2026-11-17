// A column's menu: sort, hold, move and hide, as far as the table's pieces reach. A plain sortable
// table has none: Shift and a column's name (or Shift and Enter) add it to the sort.
"use client";

import type { RowData } from "@tanstack/react-table";

import {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { More } from "../icons";
import type { Model, TableColumn } from "./use-data-table";
import type { DataTableWords } from "./words";

interface ColumnMenuProps<Row extends RowData> {
  model: Model<Row>;
  column: TableColumn<Row>;
  header: string;
  words: DataTableWords;
}

const SortItems = <Row extends RowData>({
  model,
  column,
  words,
}: Omit<ColumnMenuProps<Row>, "header">) => (
  <>
    <DropdownMenuItem
      onSelect={() => {
        column.toggleSorting(false, false);
      }}
    >
      {words.sortUp}
    </DropdownMenuItem>
    <DropdownMenuItem
      onSelect={() => {
        column.toggleSorting(true, false);
      }}
    >
      {words.sortDown}
    </DropdownMenuItem>
    {model.own.sort.length > 0 && model.sortOf(column.id) === undefined && (
      <DropdownMenuItem
        onSelect={() => {
          column.toggleSorting(false, true);
        }}
      >
        {words.sortNext}
      </DropdownMenuItem>
    )}
  </>
);

const PinItems = <Row extends RowData>({
  model,
  column,
  words,
}: Omit<ColumnMenuProps<Row>, "header">) => {
  const at = model.pinnedAt(column.id);
  return (
    <>
      <DropdownMenuSeparator />
      {at !== "start" && (
        <DropdownMenuItem
          onSelect={() => {
            column.pin("start");
          }}
        >
          {words.pinStart}
        </DropdownMenuItem>
      )}
      {at !== "end" && (
        <DropdownMenuItem
          onSelect={() => {
            column.pin("end");
          }}
        >
          {words.pinEnd}
        </DropdownMenuItem>
      )}
      {at !== false && (
        <DropdownMenuItem
          onSelect={() => {
            column.pin(false);
          }}
        >
          {words.unpin}
        </DropdownMenuItem>
      )}
    </>
  );
};

const MoveItems = <Row extends RowData>({
  model,
  column,
  words,
}: Omit<ColumnMenuProps<Row>, "header">) => {
  const index = model.own.order.indexOf(column.id);
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={index <= 0}
        onSelect={() => {
          model.move(column.id, -1);
        }}
      >
        {words.moveEarlier}
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={index >= model.own.order.length - 1}
        onSelect={() => {
          model.move(column.id, 1);
        }}
      >
        {words.moveLater}
      </DropdownMenuItem>
    </>
  );
};

export const ColumnMenu = <Row extends RowData>({
  model,
  column,
  header,
  words,
}: ColumnMenuProps<Row>) => {
  const canHide = model.flags.hiding && column.getCanHide();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        variant="ghost"
        size="xs"
        icon={More}
        aria-label={words.columnMenu(header)}
      />
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{header}</DropdownMenuLabel>
          {column.getCanSort() && (
            <SortItems model={model} column={column} words={words} />
          )}
        </DropdownMenuGroup>
        {model.flags.pinning && (
          <PinItems model={model} column={column} words={words} />
        )}
        {model.flags.ordering && (
          <MoveItems model={model} column={column} words={words} />
        )}
        {canHide && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                column.toggleVisibility(false);
              }}
            >
              {words.hide}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
