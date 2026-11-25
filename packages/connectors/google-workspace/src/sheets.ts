import { tool, ToolError, v } from "@grasp-os/sdk/connector";
import type { ConnectorTool } from "@grasp-os/sdk/connector";

import { driveIdArg, fileIn, fileRoute } from "./drive.ts";
import { googleScope, sheetsHost } from "./google.ts";

// Sheets: a spreadsheet's cells, from a shared drive. A spreadsheet is a
// Drive file, addressed by its ID alone (`/v4/spreadsheets/{spreadsheetId}`), so the
// egress can't bind a request to the drive: the tool reads the file's
// Drive metadata first (`fileIn`) and asks Sheets for nothing unless
// Google says it is a spreadsheet in the bound drive. Reading needs
// `drive.readonly`, which the connector holds already: Sheets takes it for
// reads.
//
// The ranges go in the query (`ranges=...`), never in a path: A1 notation
// needs `:`, which the egress refuses in a path's value. Without ranges
// the read asks for no cells at all, only the spreadsheet's sheets: Sheets
// answers the field mask, which overrides `includeGridData`, so a mask
// with grid data and no ranges would read every cell of every sheet.

const spreadsheet = `${sheetsHost}/v4/spreadsheets/{spreadsheetId}`;

const spreadsheetMimeType = "application/vnd.google-apps.spreadsheet";

const sheetsFields =
  "spreadsheetId,properties.title,sheets.properties(title,index)";
const gridFields =
  "spreadsheetId,properties.title,sheets(properties(title,index),data(startRow,startColumn,rowData(values(formattedValue,effectiveValue,effectiveFormat/numberFormat/type))))";

/**
 * A cell: its value (`effectiveValue`), what the sheet shows
 * (`formattedValue`, which a day or a time reads right as, its value
 * being a serial number) and its number format's type (`DATE`).
 */
const cell = v.object({
  formattedValue: v.string().optional(),
  effectiveValue: v
    .object({
      numberValue: v.number().optional(),
      stringValue: v.string().optional(),
      boolValue: v.boolean().optional(),
      errorValue: v
        .object({
          type: v.string().optional(),
          message: v.string().optional(),
        })
        .optional(),
    })
    .optional(),
  effectiveFormat: v
    .object({
      numberFormat: v.object({ type: v.string().optional() }).optional(),
    })
    .optional(),
});

const spreadsheetAnswer = v.object({
  spreadsheetId: v.string(),
  properties: v.object({ title: v.string() }),
  sheets: v
    .array(
      v.object({
        properties: v.object({
          title: v.string(),
          index: v.number().integer().optional(),
        }),
        data: v
          .array(
            v.object({
              startRow: v.number().integer().optional(),
              startColumn: v.number().integer().optional(),
              rowData: v
                .array(v.object({ values: v.array(cell).optional() }))
                .optional(),
            })
          )
          .optional(),
      })
    )
    .optional(),
});

export const sheetsTools: Readonly<Record<string, ConnectorTool>> = {
  "spreadsheets.get": tool({
    description:
      "Reads a Google spreadsheet in a shared drive: its sheets, and with ranges the cells they hold, row by row. A range is A1 notation with its sheet's name in single quotes (a quote in it doubled): 'Invoices'!A1:F200. Ask for the rows you need. A cell gives its value (effectiveValue) and what the sheet shows (formattedValue), which is how a day or a time reads right.",
    args: {
      driveId: driveIdArg,
      spreadsheetId: v.string().min(1).max(1024),
      ranges: v.array(v.string().min(1).max(256)).min(1).max(20).optional(),
    },
    returns: spreadsheetAnswer,
    readOnly: true,
    reach: "company",
    idField: "spreadsheetId",
    resource: "driveId",
    scopes: [googleScope("drive.readonly")],
    // A spreadsheet has no drive in its path: the handler checks its Drive
    // metadata first.
    routes: [`GET ${spreadsheet}`, fileRoute],
    handler: async ({ driveId, spreadsheetId, ranges }, api) => {
      const found = await fileIn(api, driveId, spreadsheetId);
      if (found.mimeType !== spreadsheetMimeType) {
        throw new ToolError("This isn't a Google spreadsheet", {
          code: "not_a_file",
        });
      }
      const answered = await api.get(spreadsheet, {
        path: { spreadsheetId },
        query:
          ranges === undefined
            ? { fields: sheetsFields }
            : { ranges, includeGridData: true, fields: gridFields },
        returns: spreadsheetAnswer,
      });
      if (answered.spreadsheetId !== spreadsheetId) {
        throw new ToolError("This drive has no such spreadsheet", {
          code: "not_found",
        });
      }
      return answered;
    },
  }),
};
