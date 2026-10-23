import {
  defineTool,
  invalidCode,
  ToolError,
} from "@grasp-os/connector-kit/connector";
import type { Effect } from "@grasp-os/connector-kit/connector";
import { jsonBody, segment } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

import {
  driveSchema,
  graphHost,
  graphJson,
  graphUrl,
  idSchema,
  v1,
} from "./graph.ts";

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

const table = `${v1}/drives/{drive}/items/{workbook}/workbook/tables/{table}`;

const get = (path: string) =>
  ({ method: "GET", host: graphHost, path: `${table}${path}` }) as const;

const headerRoute = get("/headerRowRange");
const bodyRoute = get("/dataBodyRange");
const rowRoute = "/rows/itemAt(index={row})/range";

/**
 * A table's name, as Excel allows it: a letter or underscore, then
 * letters, digits, underscores and periods. Never a table's `{...}` ID or
 * anything else Graph would take in its place.
 */
const tableSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\p{L}_][\p{L}\p{N}_.]*$/u);

/** Most characters a cell holds, as Excel allows. */
const maxCellChars = 32_767;

/** Most columns a row of a register may have here. */
const maxColumns = 200;

/**
 * A day, as a cell holds it: `{ date: "2026-10-21" }`. By a pattern, not
 * zod's `iso.date()`: a generated contract checks patterns, and a `date`
 * format it doesn't know would leave the action out of App bindings.
 */
const daySchema = z.strictObject({
  date: z
    .string()
    .regex(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u)
    .refine(
      (date) => new Date(`${date}T00:00:00Z`).toISOString().startsWith(date),
      "Not a day"
    ),
});

/** The cells a row is read as: text, a number, true or false, a day, or empty. */
const readCells = [
  z.string().max(maxCellChars),
  z.number(),
  z.boolean(),
  z.null(),
  daySchema,
] as const;

/** A cell as it is read. */
const readCellSchema = z.union(readCells);
type ReadCell = z.infer<typeof readCellSchema>;

/** A cell as it is written: as it is read, or a formula. */
const cellSchema = z.union([
  ...readCells,
  z.strictObject({
    formula: z.string().min(2).max(8192).regex(/^=/u),
  }),
]);
type Cell = z.infer<typeof cellSchema>;

const columnSchema = z.string().min(1).max(255);

/** A row as read: each of the table's columns, with its cell. */
const readRowSchema = z
  .array(z.strictObject({ column: columnSchema, value: readCellSchema }))
  .min(1)
  .max(maxColumns);
type ReadRow = z.infer<typeof readRowSchema>;

/** A row as it will stand: each of the table's columns, with its cell. */
const rowSchema = z
  .array(z.strictObject({ column: columnSchema, value: cellSchema }))
  .min(1)
  .max(maxColumns);
type Row = z.infer<typeof rowSchema>;

const graphValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** A range as Graph answers it: its values, and how each is shown. */
const graphRange = z.object({
  values: z.array(z.array(graphValue)),
  numberFormat: z.array(z.array(z.string().nullable())).nullish(),
  formulas: z.array(z.array(graphValue)).nullish(),
});
type GraphRange = z.infer<typeof graphRange>;

const graphTableRow = z.object({
  index: z.number().int().nonnegative(),
  values: z.array(z.array(graphValue)),
});

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
const cellOf = (
  value: z.infer<typeof graphValue>,
  format?: string | null
): ReadCell => {
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
const cellsOf = (range: GraphRange, index: number): ReadCell[] =>
  (range.values[index] ?? []).map((value, column) =>
    cellOf(value, range.numberFormat?.[index]?.[column])
  );

/** A row's cells under the table's columns. */
const rowOf = (
  columns: readonly string[],
  cells: readonly ReadCell[]
): ReadRow =>
  columns.map((column, index) => ({ column, value: cells[index] ?? null }));

/** Two cells as the same value, a day's as its date. */
const sameCell = (a: Cell, b: Cell): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether a cell as read now stands as `wanted`: the same value; text
 * Excel took for a number when it was typed (`"12"` and 12); or, for a
 * formula, the formula Excel holds there.
 */
const stands = (
  now: ReadCell,
  formula: z.infer<typeof graphValue> | undefined,
  wanted: Cell
): boolean => {
  if (wanted !== null && typeof wanted === "object" && "formula" in wanted) {
    return formula === wanted.formula;
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
  const byColumn = new Map(row.map(({ column, value }) => [column, value]));
  if (
    byColumn.size !== row.length ||
    row.length !== columns.length ||
    !columns.every((column) => byColumn.has(column))
  ) {
    throw new ToolError(
      `A row gives each of the table's columns once: ${columns.join(", ")}`,
      { code: invalidCode }
    );
  }
  return columns.map((column) => byColumn.get(column) ?? null);
};

/** Whether a cell's formula, as Graph answers it, is one, not a constant. */
const isFormula = (
  formula: z.infer<typeof graphValue> | undefined
): formula is string => typeof formula === "string" && formula.startsWith("=");

/**
 * Cells as Graph takes them, typed as a person would type them: a day as
 * `2026-10-21`, which Excel stores as a date, never its serial number;
 * text that would run as a formula refused; a formula only once its
 * person confirmed it, or as the cell already holds it (`held`).
 */
const valuesOf = (
  cells: readonly Cell[],
  { confirmed }: Effect,
  held: readonly z.infer<typeof graphValue>[] = []
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
          { code: invalidCode }
        );
      }
      return cell.formula;
    }
    if (typeof cell === "string" && runsAsFormula.test(cell)) {
      throw new ToolError(
        "This text would run as a formula: write a formula as { formula }, for its person to confirm",
        { code: invalidCode }
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
  written: readonly Cell[],
  answered: readonly ReadCell[]
): Row =>
  columns.map((column, index) => {
    const cell = written[index] ?? null;
    const value =
      cell !== null && typeof cell === "object"
        ? cell
        : (answered[index] ?? null);
    return { column, value };
  });

const tablePath = (drive: string, workbook: string, name: string): string =>
  `/drives/${segment(drive)}/items/${segment(workbook)}/workbook/tables/${segment(name)}`;

/** The table's columns, by its header row. */
const columnsOf = async (path: string): Promise<string[]> => {
  const header = await graphJson(
    graphUrl(`${path}/headerRowRange`, { $select: "values" }),
    graphRange
  );
  return (header.values[0] ?? []).map(String);
};

const tableInput = {
  drive: driveSchema,
  workbook: idSchema,
  table: tableSchema,
};

const tableOutput = {
  drive: z.string(),
  workbook: z.string(),
  table: z.string(),
};

/** Most rows one page holds. */
const maxPageRows = 200;

const listRows = defineTool({
  name: "excel.listRows",
  description:
    "Lists the rows of a named table in an Excel workbook (a drive item), each cell under its column: a day as { date }. Rows are numbered from 0, as excel.updateRow names them; start where a page's nextStart says.",
  input: z.strictObject({
    ...tableInput,
    start: z.number().int().nonnegative().optional(),
    top: z.number().int().min(1).max(maxPageRows).optional(),
  }),
  output: z.strictObject({
    ...tableOutput,
    columns: z.array(z.string()),
    rows: z.array(z.strictObject({ row: z.number(), values: readRowSchema })),
    nextStart: z.number().nullable(),
  }),
  readOnly: true,
  resource: "workbook",
  routes: [headerRoute, bodyRoute],
  run: async ({ drive, workbook, table: name, start = 0, top = 100 }) => {
    const path = tablePath(drive, workbook, name);
    const columns = await columnsOf(path);
    // A register is read whole and paged here: Graph can't page a range.
    const body = await graphJson(
      graphUrl(`${path}/dataBodyRange`, { $select: "values,numberFormat" }),
      graphRange
    );
    const end = Math.min(start + top, body.values.length);
    const rows: { row: number; values: ReadRow }[] = [];
    for (let index = start; index < end; index += 1) {
      rows.push({ row: index, values: rowOf(columns, cellsOf(body, index)) });
    }
    return {
      output: {
        drive,
        workbook,
        table: name,
        columns,
        rows,
        nextStart: end < body.values.length ? end : null,
      },
      provenance: [workbook],
    };
  },
});

const addRow = defineTool({
  name: "excel.addRow",
  description:
    "Adds a row at the end of a named table in an Excel workbook: a cell for each of its columns, a day as { date }, empty as null.",
  input: z.strictObject({ ...tableInput, values: rowSchema }),
  output: z.strictObject({
    ...tableOutput,
    row: z.number(),
    values: rowSchema,
  }),
  readOnly: false,
  destructive: false,
  resource: "workbook",
  // Recovery `none`: a row carries no tag to find it by, and the same
  // values may rightly be added twice, so an added row of unknown outcome
  // stays unknown, for its person to say what became of it.
  routes: [
    headerRoute,
    { method: "POST", host: graphHost, path: `${table}/rows` },
  ],
  describe: {
    title: "Add a row to an Excel table",
    fields: [
      { label: "Drive", input: "drive" },
      { label: "Workbook", input: "workbook" },
      { label: "Table", input: "table" },
      { label: "Row", input: "values" },
    ],
  },
  run: async ({ drive, workbook, table: name, values }, effect) => {
    const path = tablePath(drive, workbook, name);
    const columns = await columnsOf(path);
    const cells = inColumnOrder(columns, values);
    const added = await graphJson(
      graphUrl(`${path}/rows`),
      graphTableRow,
      jsonBody({ values: [valuesOf(cells, effect)] })
    );
    const after = writtenRow(
      columns,
      cells,
      (added.values[0] ?? []).map((value) => cellOf(value))
    );
    return {
      output: {
        drive,
        workbook,
        table: name,
        row: added.index,
        values: after,
      },
      change: { before: null, after },
    };
  },
});

const updateRow = defineTool({
  name: "excel.updateRow",
  description:
    "Changes a row of a named table in an Excel workbook: the row (numbered from 0, as excel.listRows reads it), its cells as read (before), and every cell as it will stand (after). Refused when the row no longer holds what was read.",
  input: z.strictObject({
    ...tableInput,
    row: z.number().int().nonnegative().max(1_048_575),
    before: readRowSchema,
    after: rowSchema,
  }),
  output: z.strictObject({
    ...tableOutput,
    row: z.number(),
    before: readRowSchema,
    after: rowSchema,
  }),
  readOnly: false,
  destructive: true,
  resource: "workbook",
  // Recovery `repeat`: the write sets the row's cells, and a repeat finds
  // the row already standing as asked and writes nothing. One whose row
  // someone changed meanwhile is refused as any changed row is.
  repeatable: true,
  routes: [
    headerRoute,
    get(rowRoute),
    { method: "PATCH", host: graphHost, path: `${table}${rowRoute}` },
  ],
  describe: {
    title: "Change a row of an Excel table",
    fields: [
      { label: "Drive", input: "drive" },
      { label: "Workbook", input: "workbook" },
      { label: "Table", input: "table" },
      { label: "Row", input: "row" },
      { label: "Now", input: "before" },
      { label: "Will be", input: "after" },
    ],
  },
  run: async ({ drive, workbook, table: name, row, before, after }, effect) => {
    const path = tablePath(drive, workbook, name);
    const columns = await columnsOf(path);
    const was = inColumnOrder(columns, before);
    const wanted = inColumnOrder(columns, after);
    const rowPath = `${path}/rows/itemAt(index=${row})/range`;
    const now = await graphJson(
      graphUrl(rowPath, { $select: "values,numberFormat,formulas" }),
      graphRange
    );
    const cells = cellsOf(now, 0);
    const formulas = now.formulas?.[0] ?? [];
    const output = {
      drive,
      workbook,
      table: name,
      row,
      before: rowOf(columns, was),
    };
    if (
      wanted.every((cell, index) =>
        stands(cells[index] ?? null, formulas[index], cell)
      )
    ) {
      // Already as asked: a repeat of this call, or a change to what is.
      const stood = writtenRow(columns, wanted, cells);
      return {
        output: { ...output, after: stood },
        change: { before: output.before, after: stood },
      };
    }
    if (
      !was.every((cell, index) =>
        stands(cells[index] ?? null, formulas[index], cell)
      )
    ) {
      throw new ToolError(
        "The row no longer holds what was read: read it again",
        { code: "conflict" }
      );
    }
    // A formula's cell reads as its value: written back as that value, it
    // would lose its formula.
    const overwritten = columns.flatMap((column, index) => {
      const cell = wanted[index] ?? null;
      const held = formulas[index];
      const asFormula =
        cell !== null && typeof cell === "object" && "formula" in cell;
      return isFormula(held) && !asFormula ? [`${column} holds ${held}`] : [];
    });
    if (overwritten.length > 0) {
      throw new ToolError(
        `A cell holding a formula is changed only as { formula }: ${overwritten.join(", ")}`,
        { code: invalidCode }
      );
    }
    const values = valuesOf(wanted, effect, formulas);
    const written = await graphJson(graphUrl(rowPath), graphRange, {
      ...jsonBody({ values: [values] }),
      method: "PATCH",
    });
    const stood = writtenRow(columns, wanted, cellsOf(written, 0));
    return {
      output: { ...output, after: stood },
      change: { before: output.before, after: stood },
    };
  },
});

export const workbookTools = [listRows, addRow, updateRow];
