import { page, tool, ToolError, v } from "@grasp-os/sdk/connector";
import type { Api, Infer, ToolCall } from "@grasp-os/sdk/connector";

import { checkDrive, checkIds, drive, graphId, next } from "./graph-sdk.ts";

// Rows of a named table in an Excel workbook: a register a company keeps
// in SharePoint or OneDrive, read and changed through the person's own
// connection, within their own rights there. The workbook is the
// resource: a call's capability binds `{workbook}`, its drive item ID, in
// every route. Graph mints an item's ID from the file's own unique ID, so
// no other drive's file has it, and Graph answers a workbook asked for in
// a drive it isn't in as not found.
//
// Only a named table is reached, `tables/{table}`, never a sheet or a
// named range: a named range can point anywhere in the workbook, at any
// sheet, so a call for one register could reach another. A row is
// addressed by its index in the table's body, which moves when rows are
// added, removed or sorted above it: a change names the row as it was
// read (`before`), and goes ahead only while the row still holds it.
// Graph's workbook API takes no condition (`If-Match`) on a range's
// write, so the check is a read just before the write: a change someone
// makes in Excel between the two, a round trip apart, isn't seen.
//
// Excel answers a day as a serial number (46316 is 2026-10-21), and runs
// a cell typed as `=...`, `@...`, or `+` or `-` before a letter, as a
// formula. A day is read and written here as `{ date }`, never a number;
// text that would run as a formula is refused, and a formula is written
// only as `{ formula }`, in a call its person confirmed on a card that
// showed it. A row reads a formula's cell as its value, so a change that
// gave that value back would write it over the formula: a cell holding a
// formula is changed only as `{ formula }`, and keeping the one it holds
// needs no confirming again.

const tableRoute = "/drives/{drive}/items/{workbook}/workbook/tables/{table}";
const headerRoute = `${tableRoute}/headerRowRange`;
const bodyRoute = `${tableRoute}/dataBodyRange`;
const rowsRoute = `${tableRoute}/rows`;
const rowRoute = `${tableRoute}/rows/itemAt(index={index})/range`;

/**
 * A table's name, as Excel allows it: a letter or underscore, then
 * letters, digits, underscores and periods. Never a table's `{...}` ID or
 * anything else Graph would take in its place. `checkTable` holds it to that.
 */
const table = v.string().min(1).max(255);

const tablePattern = /^[\p{L}_][\p{L}\p{N}_.]*$/u;

/** Most characters a cell holds, as Excel allows. */
const maxCellChars = 32_767;

/** Most columns a row of a register may have here. */
const maxColumns = 200;

/** A day, as a cell holds it: `{ date: "2026-10-21" }`. `checkCells` holds it to a day. */
const Day = v.object({ date: v.string().min(10).max(10) });

const dayPattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;

/** A formula, as a cell is written: `{ formula: "=SUM(A1:A9)" }`. */
const Formula = v.object({ formula: v.string().min(2).max(8192) });

/** A cell as it is read: text, a number, true or false, a day, or empty. */
const ReadCell = v.union(
  v.string().max(maxCellChars),
  v.number(),
  v.boolean(),
  v.null(),
  Day
);
type ReadCellValue = Infer<typeof ReadCell>;

/** A cell as it is written: as it is read, or a formula. */
const Cell = v.union(
  v.string().max(maxCellChars),
  v.number(),
  v.boolean(),
  v.null(),
  Day,
  Formula
);
type CellValue = Infer<typeof Cell>;

const column = v.string().min(1).max(255);

/** A row as read: each of the table's columns, with its cell. */
const ReadRow = v
  .array(v.object({ column, value: ReadCell }))
  .min(1)
  .max(maxColumns);
type ReadRowValue = Infer<typeof ReadRow>;

/** A row as it will stand: each of the table's columns, with its cell. */
const Row = v
  .array(v.object({ column, value: Cell }))
  .min(1)
  .max(maxColumns);
type RowValue = Infer<typeof Row>;

/** A table's row (Graph's workbookTableRow): its index, and its cells by column. */
const TableRow = v.object({
  index: v.number().integer(),
  values: Row,
});

const graphValue = v.union(v.string(), v.number(), v.boolean(), v.null());
type GraphValue = Infer<typeof graphValue>;

/** A range as Graph answers it: its values, and how each is shown. */
const graphRange = v.object({
  values: v.array(v.array(graphValue)),
  numberFormat: v.array(v.array(v.string().nullable())).nullable().optional(),
  formulas: v.array(v.array(graphValue)).nullable().optional(),
});
type GraphRange = Infer<typeof graphRange>;

const graphTableRow = v.object({
  index: v.number().integer().min(0),
  values: v.array(v.array(graphValue)),
});

/** Refuses, before anything is sent, a name that isn't a table's. */
const checkTable = (name: string): void => {
  if (!tablePattern.test(name)) {
    throw new ToolError("Invalid input: table isn't an Excel table's name", {
      code: "invalid",
    });
  }
};

/** Whether `date` is a day of the calendar (no 30 February). */
const isDay = (date: string): boolean =>
  dayPattern.test(date) &&
  new Date(`${date}T00:00:00Z`).toISOString().startsWith(date);

/**
 * Refuses, before anything is sent, a day that isn't one and a formula
 * that doesn't start with `=`.
 */
const checkCells = (
  name: string,
  row: readonly { value: CellValue }[]
): void => {
  for (const { value } of row) {
    if (
      value !== null &&
      typeof value === "object" &&
      ("date" in value ? !isDay(value.date) : !value.formula.startsWith("="))
    ) {
      throw new ToolError(
        `Invalid input: ${name} holds ${JSON.stringify(value)}, which isn't a day or a formula`,
        { code: "invalid" }
      );
    }
  }
};

/** What a number format shows besides its codes: quoted text, `[...]`, `\x`. */
const formatLiterals = /"[^"]*"|\[[^\]]*\]|\\./gu;

/** A day's or a year's code in a number format: it shows a date. */
const dayCodes = /[dy]/iu;

/** Whether a number format shows a date, such as `yyyy-mm-dd`. */
const showsDate = (format: string | null | undefined): boolean =>
  format !== null &&
  format !== undefined &&
  dayCodes.test(format.replaceAll(formatLiterals, ""));

const dayMs = 86_400_000;

/** Excel's day 0, as its serial numbers count from 1 March 1900 on. */
const excelEpoch = Date.UTC(1899, 11, 30);

/**
 * The first serial number that counts days right: Excel takes 1900 for a
 * leap year, so the days before 1 March 1900 are off by one.
 */
const firstSerial = 61;

/** The last: 31 December 9999. */
const lastSerial = 2_958_465;

/** A serial number as the day it is, when it is a whole day Excel counts right. */
const dayOf = (serial: number): string | undefined =>
  Number.isInteger(serial) && serial >= firstSerial && serial <= lastSerial
    ? new Date(excelEpoch + serial * dayMs).toISOString().slice(0, 10)
    : undefined;

/**
 * One cell of a range as read: a date-formatted day as `{ date }`, empty
 * as null. Without its format (as Graph answers an added row), a number.
 */
const cellOf = (value: GraphValue, format?: string | null): ReadCellValue => {
  if (value === "" || value === null) {
    return null;
  }
  if (typeof value === "number" && showsDate(format)) {
    const date = dayOf(value);
    return date === undefined ? value : { date };
  }
  return value;
};

/** The cells of row `index` of a range, as read. */
const cellsOf = (range: GraphRange, index: number): ReadCellValue[] =>
  (range.values[index] ?? []).map((value, at) =>
    cellOf(value, range.numberFormat?.[index]?.[at])
  );

/** A row's cells under the table's columns. */
const rowOf = (
  columns: readonly string[],
  cells: readonly ReadCellValue[]
): ReadRowValue =>
  columns.map((name, index) => ({ column: name, value: cells[index] ?? null }));

/** Two cells as the same value, a day's as its date. */
const sameCell = (a: CellValue, b: CellValue): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether a cell as read now stands as `wanted`, as it would once written:
 * the same value; empty, for `""`, which reads as an empty cell; text
 * Excel took for a number when it was typed (`"12"` and 12); or, for a
 * formula, the formula Excel holds there.
 */
const stands = (
  now: ReadCellValue,
  formula: GraphValue | undefined,
  wanted: CellValue
): boolean => {
  if (wanted !== null && typeof wanted === "object" && "formula" in wanted) {
    return formula === wanted.formula;
  }
  if (wanted === "") {
    return now === null;
  }
  if (typeof wanted === "string" && typeof now === "number") {
    return String(now) === wanted;
  }
  return sameCell(now, wanted);
};

/** What Excel runs as a formula when it is typed. */
const runsAsFormula = /^(?:[=@]|[+-]\p{L})/u;

/**
 * A row's cells in the table's column order: refused unless it gives
 * each column once, and no other.
 */
const inColumnOrder = <Value>(
  columns: readonly string[],
  row: readonly { column: string; value: Value }[]
): (Value | null)[] => {
  const byColumn = new Map(row.map(({ column: name, value }) => [name, value]));
  if (
    byColumn.size !== row.length ||
    row.length !== columns.length ||
    !columns.every((name) => byColumn.has(name))
  ) {
    throw new ToolError(
      `A row gives each of the table's columns once: ${columns.join(", ")}`,
      { code: "invalid" }
    );
  }
  return columns.map((name) => byColumn.get(name) ?? null);
};

/** Whether a cell's formula, as Graph answers it, is one, not a constant. */
const isFormula = (formula: GraphValue | undefined): formula is string =>
  typeof formula === "string" && formula.startsWith("=");

/**
 * Cells as Graph takes them, typed as a person would type them: a day as
 * `2026-10-21`, which Excel stores as a date, never its serial number;
 * text that would run as a formula refused; a formula only once its
 * person confirmed it, or as the cell already holds it (`held`).
 */
const valuesOf = (
  cells: readonly CellValue[],
  { confirmed }: Pick<ToolCall, "confirmed">,
  held: readonly GraphValue[] = []
): (string | number | boolean)[] =>
  cells.map((cell, index) => {
    if (cell === null) {
      return "";
    }
    if (typeof cell === "object") {
      if ("date" in cell) {
        return cell.date;
      }
      if (!confirmed && cell.formula !== held[index]) {
        throw new ToolError(
          "A formula is written only once its person confirmed it",
          { code: "invalid" }
        );
      }
      return cell.formula;
    }
    if (typeof cell === "string" && runsAsFormula.test(cell)) {
      throw new ToolError(
        "This text would run as a formula: write a formula as { formula }, for its person to confirm",
        { code: "invalid" }
      );
    }
    return cell;
  });

/**
 * A row as it stands after a write: each cell as Graph answers it, but a
 * day or a formula as written, since Graph answers those as a number and
 * a formula's value.
 */
const writtenRow = (
  columns: readonly string[],
  written: readonly CellValue[],
  answered: readonly ReadCellValue[]
): RowValue =>
  columns.map((name, index) => {
    const cell = written[index] ?? null;
    const value =
      cell !== null && typeof cell === "object"
        ? cell
        : (answered[index] ?? null);
    return { column: name, value };
  });

interface TablePath {
  drive: string;
  workbook: string;
  table: string;
}

/** Refuses, before anything is sent, a table that isn't one by ID and name. */
const checkTablePath = ({
  drive: driveId,
  workbook,
  table: name,
}: TablePath): void => {
  checkDrive(driveId);
  checkIds({ workbook });
  checkTable(name);
};

/** The table's columns, by its header row. */
const columnsOf = async (api: Api, path: TablePath): Promise<string[]> => {
  const header = await api.get(headerRoute, {
    path: { ...path },
    query: { $select: "values" },
    returns: graphRange,
  });
  return (header.values[0] ?? []).map(String);
};

const tableArgs = { drive, workbook: graphId, table };

/** Most rows one page holds. */
const maxPageRows = 200;

/** The row a page starts at: a `next` this tool handed out, else 0. */
const startOf = (at: string | undefined): number => {
  if (at === undefined) {
    return 0;
  }
  if (!/^\d{1,7}$/u.test(at)) {
    throw new ToolError("That isn't a page this tool handed out", {
      code: "invalid",
    });
  }
  return Number(at);
};

/**
 * Excel table tools, by name: each named from its route
 * (`POST /drives/{drive}/items/{workbook}/workbook/tables/{table}/rows` is
 * `drives.items.workbook.tables.rows.create`).
 */
export const workbookTools = {
  "drives.items.workbook.tables.dataBodyRange": tool({
    description:
      "Reads the rows of a named table in an Excel workbook (a drive item), a page at a time: each row's index in the table's body, from 0, and its cells under the header row's columns, a day as { date }.",
    readOnly: true,
    reach: "company",
    scopes: ["Files.Read.All"],
    resource: "workbook",
    routes: [`GET ${bodyRoute}`, `GET ${headerRoute}`],
    args: {
      ...tableArgs,
      top: v.number().integer().min(1).max(maxPageRows).optional(),
      next,
    },
    returns: page(TableRow),
    handler: async ({ top, next: at, ...path }, api) => {
      checkTablePath(path);
      const start = startOf(at);
      const columns = await columnsOf(api, path);
      // A register is read whole and paged here: Graph can't page a range.
      const range = await api.get(bodyRoute, {
        path: { ...path },
        query: { $select: "values,numberFormat" },
        returns: graphRange,
      });
      const end = Math.min(start + (top ?? 100), range.values.length);
      const items: Infer<typeof TableRow>[] = [];
      for (let index = start; index < end; index += 1) {
        items.push({ index, values: rowOf(columns, cellsOf(range, index)) });
      }
      return {
        items,
        next: end < range.values.length ? String(end) : null,
      };
    },
  }),
  "drives.items.workbook.tables.rows.create": tool({
    description:
      "Adds a row at the end of a named table in an Excel workbook: a cell for each of its columns, a day as { date }, empty as null. Text that would run as a formula is refused, and a formula ({ formula }) is written only once its person confirmed it.",
    readOnly: false,
    reach: "company",
    scopes: ["Files.ReadWrite.All"],
    resource: "workbook",
    // No recovery: a row carries no tag to find it by, and the same values
    // may rightly be added twice, so an added row of unknown outcome stays
    // unknown, for its person to say what became of it.
    routes: [`POST ${rowsRoute}`, `GET ${headerRoute}`],
    args: { ...tableArgs, values: Row },
    returns: TableRow,
    describe: {
      title: "Add a row to an Excel table",
      fields: [
        { label: "Drive", arg: "drive" },
        { label: "Workbook", arg: "workbook" },
        { label: "Table", arg: "table" },
        { label: "Row", arg: "values" },
      ],
    },
    handler: async ({ values, ...path }, api, call) => {
      checkTablePath(path);
      checkCells("values", values);
      const columns = await columnsOf(api, path);
      const cells = inColumnOrder(columns, values);
      const added = await api.post(rowsRoute, {
        path: { ...path },
        body: { values: [valuesOf(cells, call)] },
        returns: graphTableRow,
      });
      const after = writtenRow(
        columns,
        cells,
        (added.values[0] ?? []).map((value) => cellOf(value))
      );
      call.changed({ before: null, after });
      return { index: added.index, values: after };
    },
  }),
  "drives.items.workbook.tables.rows.itemAt.range.update": tool({
    description:
      "Changes a row of a named table in an Excel workbook: the row's index (from 0, as the table's rows are read), its cells as read (before), and every cell as it will stand (values). Refused when the row no longer holds what was read. A cell holding a formula is changed only as { formula }, and a new formula is written only once its person confirmed it.",
    readOnly: false,
    reach: "company",
    scopes: ["Files.ReadWrite.All"],
    resource: "workbook",
    routes: [`PATCH ${rowRoute}`, `GET ${headerRoute}`, `GET ${rowRoute}`],
    args: {
      ...tableArgs,
      index: v.number().integer().min(0).max(1_048_575),
      before: ReadRow,
      values: Row,
    },
    returns: TableRow,
    // The write sets the row's cells, and a repeat finds the row already
    // standing as asked and writes nothing. One whose row someone changed
    // meanwhile is refused as any changed row is.
    repeatable: true,
    describe: {
      title: "Change a row of an Excel table",
      fields: [
        { label: "Drive", arg: "drive" },
        { label: "Workbook", arg: "workbook" },
        { label: "Table", arg: "table" },
        { label: "Row", arg: "index" },
        { label: "Now", arg: "before" },
        { label: "Will be", arg: "values" },
      ],
    },
    handler: async ({ index, before, values, ...path }, api, call) => {
      checkTablePath(path);
      checkCells("before", before);
      checkCells("values", values);
      const columns = await columnsOf(api, path);
      const was = inColumnOrder(columns, before);
      const wanted = inColumnOrder(columns, values);
      const now = await api.get(rowRoute, {
        path: { ...path, index },
        query: { $select: "values,numberFormat,formulas" },
        returns: graphRange,
      });
      const cells = cellsOf(now, 0);
      const formulas = now.formulas?.[0] ?? [];
      if (
        wanted.every((cell, at) =>
          stands(cells[at] ?? null, formulas[at], cell)
        )
      ) {
        // Already as asked: a repeat of this call, or a change to what is.
        // Nothing is written, and what the row held before isn't seen, so
        // no change is said: the caller's `before` is only what they read.
        return { index, values: writtenRow(columns, wanted, cells) };
      }
      // What was read is checked as it was read, its type too: text that
      // has since become a number is a change, the old value kept with it.
      if (!was.every((cell, at) => sameCell(cells[at] ?? null, cell))) {
        throw new ToolError(
          "The row no longer holds what was read: read it again",
          { code: "conflict" }
        );
      }
      // A formula's cell reads as its value: written back as that value, it
      // would lose its formula.
      const overwritten = columns.flatMap((name, at) => {
        const cell = wanted[at] ?? null;
        const held = formulas[at];
        const asFormula =
          cell !== null && typeof cell === "object" && "formula" in cell;
        return isFormula(held) && !asFormula ? [`${name} holds ${held}`] : [];
      });
      if (overwritten.length > 0) {
        throw new ToolError(
          `A cell holding a formula is changed only as { formula }: ${overwritten.join(", ")}`,
          { code: "invalid" }
        );
      }
      const written = await api.patch(rowRoute, {
        path: { ...path, index },
        body: { values: [valuesOf(wanted, call, formulas)] },
        returns: graphRange,
      });
      const after = writtenRow(columns, wanted, cellsOf(written, 0));
      call.changed({ before: rowOf(columns, was), after });
      return { index, values: after };
    },
  }),
};
