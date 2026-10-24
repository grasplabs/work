import { defineTool, ToolError } from "@grasp-os/connector-kit/connector";
import { segment } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

import { driveSchema, fileIn, fileRoute } from "./drive.ts";
import { googleJson, googleUrl, idSchema, sheetsHost } from "./google.ts";

// Sheets: a spreadsheet's cells, read as values, from a shared drive. A
// spreadsheet is a Drive file, addressed by its ID alone (`/v4/
// spreadsheets/{id}`), so the egress can't bind a request to the drive:
// the tool reads the file's Drive metadata first (`fileIn`) and asks
// Sheets for nothing unless Google says it is a spreadsheet in the bound
// drive, as `files.read` does. Reading needs `drive.readonly`, which the
// connector holds already: Sheets takes it for reads.
//
// The range goes in the query of the spreadsheet's own read
// (`ranges=...&includeGridData=true`), never in a path: A1 notation needs
// `:`, which the egress refuses in a path's value. Without cells, it reads
// the sheet's first rows only, one more than asked for to say there are
// more, so a read is always bounded.
//
// A cell comes as its value (a number as a number) but for days and times,
// which come as the sheet shows them: their value is a serial number
// nobody reads right. An error (`#DIV/0!`) comes as it shows.

const spreadsheetMimeType = "application/vnd.google-apps.spreadsheet";

const spreadsheets = "/v4/spreadsheets";

/** Most rows one read returns, and those it returns when asked for none. */
const maxRows = 1000;
const defaultRows = 200;

/** A sheet's name: any text Sheets allows, but no control characters. */
const sheetNameSchema = z
  .string()
  .min(1)
  .max(100)
  // oxlint-disable-next-line no-control-regex -- control characters are refused
  .regex(/^[^\u0000-\u001F\u007F]+$/u);

/** Cells in A1 notation, without a sheet: `A1:F200`, `B:B`, `3:10`, `C4`. */
const cellsSchema = z
  .string()
  .max(32)
  .regex(/^(?:[A-Z]{1,3}\d{0,7}|\d{1,7})(?::(?:[A-Z]{1,3}\d{0,7}|\d{1,7}))?$/u);

/** A cell's value as the tool gives it: text, a number, a yes or no, or empty. */
const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const sheetPropertiesSchema = z.object({
  title: z.string(),
  index: z.number(),
});

const metadataSchema = z.object({
  spreadsheetId: z.string(),
  properties: z.object({ title: z.string() }),
  sheets: z.array(z.object({ properties: sheetPropertiesSchema })).nullish(),
});

/** Number formats whose value reads right only as the sheet shows it. */
const shownAsFormatted: ReadonlySet<string> = new Set([
  "DATE",
  "TIME",
  "DATE_TIME",
]);

const gridCellSchema = z.object({
  formattedValue: z.string().nullish(),
  effectiveValue: z
    .object({
      numberValue: z.number().nullish(),
      stringValue: z.string().nullish(),
      boolValue: z.boolean().nullish(),
      errorValue: z.object({}).loose().nullish(),
    })
    .nullish(),
  effectiveFormat: z
    .object({
      numberFormat: z.object({ type: z.string().nullish() }).nullish(),
    })
    .nullish(),
});
type GridCell = z.infer<typeof gridCellSchema>;

const gridSchema = z.object({
  sheets: z
    .array(
      z.object({
        properties: sheetPropertiesSchema,
        data: z
          .array(
            z.object({
              rowData: z
                .array(z.object({ values: z.array(gridCellSchema).nullish() }))
                .nullish(),
            })
          )
          .nullish(),
      })
    )
    .nullish(),
});

const cellFields =
  "formattedValue,effectiveValue,effectiveFormat/numberFormat/type";

/** One cell as the tool gives it (`cellSchema`). */
const valueOf = ({
  formattedValue,
  effectiveValue,
  effectiveFormat,
}: GridCell): string | number | boolean | null => {
  if (effectiveValue === undefined || effectiveValue === null) {
    return null;
  }
  const format = effectiveFormat?.numberFormat?.type ?? "";
  if (
    effectiveValue.errorValue !== undefined &&
    effectiveValue.errorValue !== null
  ) {
    return formattedValue ?? null;
  }
  if (typeof effectiveValue.numberValue === "number") {
    return shownAsFormatted.has(format)
      ? (formattedValue ?? effectiveValue.numberValue)
      : effectiveValue.numberValue;
  }
  if (typeof effectiveValue.boolValue === "boolean") {
    return effectiveValue.boolValue;
  }
  return effectiveValue.stringValue ?? formattedValue ?? null;
};

/** A sheet's name in a range: quoted, a quote in it doubled. */
const quotedSheet = (name: string): string => `'${name.replaceAll("'", "''")}'`;

const readSheet = defineTool({
  name: "sheets.read",
  description:
    "Reads the cells of a Google spreadsheet in a shared drive, row by row: one sheet (the first when none is given), from its top or a range in A1 notation (A1:F200). Numbers come as numbers, days and times as the sheet shows them. Lists the spreadsheet's sheets.",
  input: z.strictObject({
    drive: driveSchema,
    spreadsheet: idSchema,
    sheet: sheetNameSchema.optional(),
    cells: cellsSchema.optional(),
    top: z.number().int().min(1).max(maxRows).optional(),
  }),
  output: z.strictObject({
    drive: z.string(),
    id: z.string(),
    name: z.string(),
    sheets: z.array(z.string()),
    sheet: z.string(),
    /** The range read, in A1 notation with its sheet. */
    range: z.string(),
    rows: z.array(z.array(cellSchema)),
    /** Whether the range holds more rows than `top`. */
    more: z.boolean(),
  }),
  readOnly: true,
  reach: "company",
  resource: "drive",
  // A spreadsheet has no drive in its path: `run` checks it first.
  routes: [
    fileRoute,
    { method: "GET", host: sheetsHost, path: `${spreadsheets}/{spreadsheet}` },
  ],
  run: async ({ drive, spreadsheet: id, sheet, cells, top }) => {
    const file = await fileIn(drive, id);
    if (file.mimeType !== spreadsheetMimeType) {
      throw new ToolError("This isn't a Google spreadsheet", {
        code: "not_a_file",
      });
    }
    const path = `${spreadsheets}/${segment(id)}`;
    const metadata = await googleJson(
      googleUrl(sheetsHost, path, {
        fields: "spreadsheetId,properties.title,sheets.properties(title,index)",
      }),
      metadataSchema
    );
    const names = (metadata.sheets ?? [])
      .map(({ properties }) => properties)
      .toSorted((a, b) => a.index - b.index)
      .map(({ title }) => title);
    const chosen = sheet ?? names[0];
    if (metadata.spreadsheetId !== id || chosen === undefined) {
      throw new ToolError("This spreadsheet has no sheets", {
        code: "not_found",
      });
    }
    if (!names.includes(chosen)) {
      throw new ToolError("This spreadsheet has no sheet of that name", {
        code: "not_found",
      });
    }
    const limit = top ?? defaultRows;
    // Without cells, its first rows, and one more to tell there are more.
    const range = `${quotedSheet(chosen)}!${cells ?? `1:${limit + 1}`}`;
    const grid = await googleJson(
      googleUrl(sheetsHost, path, {
        ranges: range,
        includeGridData: "true",
        fields: `sheets(properties(title,index),data(rowData(values(${cellFields}))))`,
      }),
      gridSchema
    );
    // Only the sheet asked for, whatever else Google answers with.
    const read = (grid.sheets ?? []).find(
      ({ properties }) => properties.title === chosen
    );
    const all = (read?.data ?? []).flatMap(({ rowData }) =>
      (rowData ?? []).map(({ values }) => (values ?? []).map(valueOf))
    );
    return {
      output: {
        drive,
        id,
        name: metadata.properties.title,
        sheets: names,
        sheet: chosen,
        range,
        rows: all.slice(0, limit),
        more: all.length > limit,
      },
      provenance: [id],
    };
  },
});

export const sheetsTools = [readSheet];
