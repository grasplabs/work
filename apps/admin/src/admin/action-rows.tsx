/**
 * A list of things that open nothing of their own, as Grasp Work draws a
 * list: one table across the page, and below 84rem, where the columns no
 * longer fit, each thing as a row with the same facts in a line. In place
 * of a link, each holds what Grasp can do for it, at its end. Things that
 * each open a page of their own go through DataRows (data-rows.tsx).
 */
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

const STACKED = "@media (width < 84rem)";

const styles = stylex.create({
  table: { display: { default: "block", [STACKED]: "none" } },
  rows: { display: { default: "none", [STACKED]: "block" } },
  facts: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: space["4"],
    rowGap: space["1"],
    marginBlockStart: space["1"],
    color: colors.foreground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  label: { color: colors.mutedForeground },
});

/** One column of the table, and the same fact in a row's line. */
export interface ActionColumn<Row> {
  id: string;
  head: string;
  cell: (row: Row) => ReactNode;
  /** A figure: at the column's end. */
  figure?: boolean;
  /** Let the cell's words wrap: for a sentence, never for a figure. */
  wrap?: boolean;
  /** The fact in a row's line, after its quiet label; null leaves it out. The cell itself where not given. */
  fact?: (row: Row) => ReactNode;
}

export interface ActionRowsProps<Row> {
  /** The table's and the rows' accessible name. */
  label: string;
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** The first column's head, over each row's name. */
  nameHead: string;
  name: (row: Row) => ReactNode;
  columns: readonly ActionColumn<Row>[];
  /** What Grasp can do for one, at its end. */
  actions: (row: Row) => ReactNode;
  /** What a screen reader calls the column of actions. */
  actionsHead: string;
}

/** Things in a table, as rows below 84rem, each with its actions: see the top of this file. */
export const ActionRows = <Row,>({
  label,
  rows,
  rowKey,
  nameHead,
  name,
  columns,
  actions,
  actionsHead,
}: ActionRowsProps<Row>) => (
  <>
    <div {...stylex.props(styles.table)}>
      <Table aria-label={label} density="comfortable">
        <TableHeader>
          <TableRow>
            <TableHead>{nameHead}</TableHead>
            {columns.map((column) => (
              <TableHead
                align={column.figure === true ? "end" : "start"}
                key={column.id}
              >
                {column.head}
              </TableHead>
            ))}
            <TableHead aria-label={actionsHead} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={rowKey(row)}>
              <TableCell rowHeader wrap>
                {name(row)}
              </TableCell>
              {columns.map((column) => (
                <TableCell
                  align={column.figure === true ? "end" : "start"}
                  key={column.id}
                  wrap={column.wrap}
                >
                  {column.cell(row)}
                </TableCell>
              ))}
              <TableCell align="end">{actions(row)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
    <div {...stylex.props(styles.rows)}>
      <ItemGroup aria-label={label} separated>
        {rows.map((row) => (
          <Item key={rowKey(row)}>
            <ItemContent>
              <ItemTitle>{name(row)}</ItemTitle>
              <ItemDescription>
                <span {...stylex.props(styles.facts)}>
                  {columns.map((column) => {
                    const fact = (column.fact ?? column.cell)(row);
                    return fact === null ? null : (
                      <span key={column.id}>
                        <span {...stylex.props(styles.label)}>
                          {column.head}
                        </span>{" "}
                        {fact}
                      </span>
                    );
                  })}
                </span>
              </ItemDescription>
            </ItemContent>
            <ItemActions>{actions(row)}</ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </div>
  </>
);
