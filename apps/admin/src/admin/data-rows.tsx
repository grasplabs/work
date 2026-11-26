/**
 * A list of things as Grasp Work draws one (apps/web's Workflows): one
 * table across the page, each row opening its thing by its name's link,
 * whose press area stretches over the row; below 84rem, where the columns
 * no longer fit, each thing stacks as a card with the same facts, the
 * whole card its link. Every admin page that lists things with several
 * facts each draws them through this.
 */
import {
  Item,
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
import type { ReactElement, ReactNode } from "react";

import { rowTarget } from "./row-target.ts";

const STACKED = "@media (width < 84rem)";

const styles = stylex.create({
  table: { display: { default: "block", [STACKED]: "none" } },
  cards: { display: { default: "none", [STACKED]: "block" } },
  card: {
    display: "grid",
    justifyItems: "start",
    rowGap: space["2"],
    marginBlockStart: space["1"],
  },
  facts: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: space["4"],
    rowGap: space["1"],
    color: colors.foreground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  label: { color: colors.mutedForeground },
});

/** What a row's link is given: its words, and, in a table, the look that stretches it over the row. */
export interface RowLook {
  children: ReactNode;
  className?: string;
  style?: Record<string, string | number>;
  "data-row-target"?: "";
}

/** One column of the table, and the same fact on a card. */
export interface DataColumn<Row> {
  id: string;
  head: string;
  cell: (row: Row) => ReactNode;
  /** Let the cell's words wrap: for a sentence, never for a figure. */
  wrap?: boolean;
  /**
   * The fact on a card, after its quiet label (`head`); null leaves it
   * off the card. The cell itself where not given.
   */
  fact?: (row: Row) => ReactNode | null;
}

export interface DataRowsProps<Row> {
  /** The table's and the cards' accessible name. */
  label: string;
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** The first column's head, over each row's name. */
  nameHead: string;
  name: (row: Row) => string;
  /** Under the name on a card: how it stands, before its facts. */
  lead?: (row: Row) => ReactNode;
  /** The link a row and a card open by, given its words and look: a router `Link` with `{...look}`. */
  link: (row: Row, look: RowLook) => ReactElement;
  columns: readonly DataColumn<Row>[];
}

/** One fact on a card: its quiet label, then its value. */
const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <span>
    <span {...stylex.props(styles.label)}>{label}</span> {children}
  </span>
);

/** Things in a table, as cards below 84rem: see the top of this file. */
export const DataRows = <Row,>({
  label,
  rows,
  rowKey,
  nameHead,
  name,
  lead,
  link,
  columns,
}: DataRowsProps<Row>) => (
  <>
    <div {...stylex.props(styles.table)}>
      <Table aria-label={label} density="comfortable">
        <TableHeader>
          <TableRow>
            <TableHead>{nameHead}</TableHead>
            {columns.map((column) => (
              <TableHead key={column.id}>{column.head}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow interactive key={rowKey(row)}>
              <TableCell rowHeader wrap>
                {link(row, {
                  children: name(row),
                  "data-row-target": "",
                  ...stylex.props(rowTarget),
                })}
              </TableCell>
              {columns.map((column) => (
                <TableCell key={column.id} wrap={column.wrap}>
                  {column.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
    <div {...stylex.props(styles.cards)}>
      <ItemGroup aria-label={label} separated>
        {rows.map((row) => (
          <Item asChild key={rowKey(row)}>
            {link(row, {
              children: (
                <ItemContent>
                  <ItemTitle>{name(row)}</ItemTitle>
                  {/* Its facts describe its link for a screen reader. */}
                  <ItemDescription>
                    <span {...stylex.props(styles.card)}>
                      {lead?.(row)}
                      <span {...stylex.props(styles.facts)}>
                        {columns.map((column) => {
                          const fact = (column.fact ?? column.cell)(row);
                          return fact === null ? null : (
                            <Fact key={column.id} label={column.head}>
                              {fact}
                            </Fact>
                          );
                        })}
                      </span>
                    </span>
                  </ItemDescription>
                </ItemContent>
              ),
            })}
          </Item>
        ))}
      </ItemGroup>
    </div>
  </>
);
