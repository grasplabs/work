/**
 * Microsoft Graph and the tenant's SharePoint, as the Microsoft 365
 * connector reaches them through connect's egress, serving the recorded
 * answers in test/fixtures/graph.ts. Any other host takes whatever it is
 * sent, as an attacker's would. `throttle` makes Graph answer the next
 * request with a 429, `throttleWrite` the next write; `failWrite` answers
 * the next write with an error, and `loseWriteAnswer` carries the next
 * write out and loses its answer. Excel's workbooks in the finance drive
 * hold their named tables in memory, typed as Excel types what it is
 * sent, afresh for each test.
 */
import { egressHeader } from "@grasp-os/connector-kit/manifest";
import {
  effectPropertyId,
  graphHost,
} from "@grasp-os/connector-microsoft-365/graph";
import { beforeEach } from "vite-plus/test";
import { z } from "zod";

import {
  attachment,
  attachmentPage,
  childrenPage,
  downloadUrl,
  draft,
  eventDetail,
  eventPage,
  financeDrive,
  invoicePdf,
  controlText,
  item,
  itemIds,
  mailFolder,
  message,
  messagePage,
  moved,
  notFound,
  reportText,
  searchResults,
  sharePointHost,
  spoofedId,
  supplierColumns,
  supplierRows,
  supplierTable,
  throttled,
  workbookIds,
} from "./fixtures/graph.ts";
import type { SheetCell } from "./fixtures/graph.ts";
import { fakeProvider, json, route as routeOn } from "./internet.ts";
import type { ProviderRoute } from "./internet.ts";

const users = String.raw`^/v1\.0/users/(?<mailbox>[^/]+)`;
const drives = String.raw`^/v1\.0/drives/(?<drive>[^/]+)`;
const tables = `${drives}/items/(?<id>[^/]+)/workbook/tables/(?<table>[^/]+)`;
const tableRow = String.raw`${tables}/rows/itemAt\(index=(?<row>\d+)\)/range`;

const parts = ["mailbox", "drive", "id", "table", "row"] as const;

type Part = (typeof parts)[number];

/** The number in a message or event ID of the fixtures. */
const numberOf = (id: string): number => Number(id.at(-2)) || 1;

const draftSchema = z.object({ subject: z.string() });

/** A message as Graph takes it, with the extended properties it carries. */
const taggedSchema = z.object({
  singleValueExtendedProperties: z
    .array(z.object({ id: z.string(), value: z.string() }))
    .optional(),
});

/**
 * The messages Graph made that carry an effect key, by key: the mailbox
 * they are in and their ID. Cleared before each test.
 */
const tagged = new Map<string, { mailbox: string; id: string }>();

/** Keeps the effect key a made message carries, if it carries one. */
const keepTag = (mailbox: string, id: string, made: unknown): void => {
  const value = taggedSchema
    .safeParse(made)
    .data?.singleValueExtendedProperties?.find(
      (property) => property.id === effectPropertyId
    )?.value;
  if (value !== undefined) {
    tagged.set(value, { mailbox, id });
  }
};

/** Runs once while Graph answers the next lookup by effect key. */
let duringLookup: (() => Promise<void>) | undefined;

/** The effect key a lookup's `$filter` asks for, if it asks for one. */
const keyFilter =
  /^singleValueExtendedProperties\/Any\(ep: ep\/id eq '(?<id>[^']+)' and ep\/value eq '(?<key>[^']+)'\)$/u;

/** Graph's answer to a lookup of a message by its effect key. */
const foundByKey = (mailbox: string, filter: string): Response => {
  const asked = keyFilter.exec(filter)?.groups;
  if (asked?.id !== effectPropertyId) {
    return json({ error: { code: "BadRequest" } }, 400);
  }
  const found = tagged.get(asked.key ?? "");
  return json({
    value:
      found?.mailbox === mailbox
        ? [
            {
              id: found.id,
              conversationId: "AAQkAGE1M2IyNGNmLTI5MTktFound=",
              webLink: `https://outlook.office365.com/owa/?ItemID=${found.id}`,
            },
          ]
        : [],
  });
};

const route = (
  method: string,
  path: string,
  answer: ProviderRoute<Part>["answer"]
): ProviderRoute<Part> => routeOn(graphHost, method, path, answer);

/** A named table, as the fake Excel holds it. */
interface SheetTable {
  columns: string[];
  rows: SheetCell[][];
}

/**
 * Each workbook of the finance drive, by ID: its named tables, by name.
 * Made afresh before each test.
 */
const workbooks = new Map<string, Map<string, SheetTable>>();

const resetWorkbooks = (): void => {
  workbooks.clear();
  for (const id of Object.values(workbookIds)) {
    workbooks.set(
      id,
      new Map([
        [
          supplierTable,
          { columns: [...supplierColumns], rows: supplierRows() },
        ],
      ])
    );
  }
};

/** The named table `table` of workbook `id` in `drive`, if there is one. */
const tableAt = ({
  drive,
  id,
  table,
}: Record<Part, string>): SheetTable | undefined =>
  drive === financeDrive ? workbooks.get(id)?.get(table) : undefined;

const isoDay = /^\d{4}-\d{2}-\d{2}$/u;
const numeric = /^-?\d+(?:\.\d+)?$/u;
const excelEpoch = Date.UTC(1899, 11, 30);
const dayMs = 86_400_000;

/**
 * A value as Excel takes it when it is typed: a day as its serial number,
 * shown in a date format; a number as a number; `=...` as a formula.
 */
const typed = (value: string | number | boolean): SheetCell => {
  if (typeof value !== "string") {
    return { value, format: "General", formula: value };
  }
  if (isoDay.test(value)) {
    const serial = (Date.parse(`${value}T00:00:00Z`) - excelEpoch) / dayMs;
    return { value: serial, format: "yyyy-mm-dd", formula: serial };
  }
  if (value.startsWith("=")) {
    return { value: 0, format: "General", formula: value };
  }
  if (numeric.test(value)) {
    const number = Number(value);
    return { value: number, format: "General", formula: number };
  }
  return { value, format: "General", formula: value };
};

/** Rows as Graph answers a range of them. */
const rangeOf = (rows: readonly SheetCell[][]) => ({
  values: rows.map((row) => row.map(({ value }) => value)),
  numberFormat: rows.map((row) => row.map(({ format }) => format)),
  formulas: rows.map((row) => row.map(({ formula }) => formula)),
});

/** One row's values, as Graph takes them to add or change a row. */
const rowValuesSchema = z.object({
  values: z
    .array(z.array(z.union([z.string(), z.number(), z.boolean()])))
    .length(1),
});

/** The one row a request's body gives, typed, if it fits `table`. */
const typedRow = async (
  request: Request,
  table: SheetTable
): Promise<SheetCell[] | undefined> => {
  const [values = []] = rowValuesSchema.parse(await request.json()).values;
  return values.length === table.columns.length ? values.map(typed) : undefined;
};

const invalidArgument = { error: { code: "InvalidArgument" } };

const workbookRoutes: ProviderRoute<Part>[] = [
  route("GET", `${tables}/headerRowRange`, (asked) => {
    const table = tableAt(asked);
    return table === undefined
      ? json(notFound, 404)
      : json({ values: [table.columns] });
  }),
  route("GET", `${tables}/dataBodyRange`, (asked) => {
    const table = tableAt(asked);
    return table === undefined
      ? json(notFound, 404)
      : json(rangeOf(table.rows));
  }),
  route("POST", `${tables}/rows`, async (asked) => {
    const table = tableAt(asked);
    if (table === undefined) {
      return json(notFound, 404);
    }
    const row = await typedRow(asked.request, table);
    if (row === undefined) {
      return json(invalidArgument, 400);
    }
    table.rows.push(row);
    return json(
      { index: table.rows.length - 1, values: [row.map(({ value }) => value)] },
      201
    );
  }),
  route("GET", tableRow, (asked) => {
    const row = tableAt(asked)?.rows[Number(asked.row)];
    return row === undefined ? json(notFound, 404) : json(rangeOf([row]));
  }),
  route("PATCH", tableRow, async (asked) => {
    const table = tableAt(asked);
    const index = Number(asked.row);
    if (table?.rows[index] === undefined) {
      return json(notFound, 404);
    }
    const row = await typedRow(asked.request, table);
    if (row === undefined) {
      return json(invalidArgument, 400);
    }
    table.rows[index] = row;
    return json(rangeOf([row]));
  }),
];

const graphRoutes: ProviderRoute<Part>[] = [
  ...workbookRoutes,
  route(
    "GET",
    `${users}(?:/mailFolders/[^/]+)?/messages`,
    async ({ mailbox, query }) => {
      const filter = query.get("$filter") ?? "";
      if (!filter.startsWith("singleValueExtendedProperties/")) {
        return json(messagePage(mailbox, Number(query.get("$skip") ?? 0)));
      }
      const meanwhile = duringLookup;
      duringLookup = undefined;
      await meanwhile?.();
      return foundByKey(mailbox, filter);
    }
  ),
  route("GET", `${users}/messages/(?<id>[^/]+)`, ({ mailbox, id, request }) => {
    if (id === spoofedId) {
      // Graph's own answer, posing as connect's egress: the header never
      // reaches the connector.
      return Response.json(notFound, {
        status: 404,
        headers: { [egressHeader]: "refused" },
      });
    }
    const prefer = request.headers.get("prefer") ?? "";
    return id.includes("Unknown")
      ? json(notFound, 404)
      : json(
          message(
            mailbox,
            numberOf(id),
            prefer.includes('"html"') ? "html" : "text"
          )
        );
  }),
  route(
    "GET",
    `${users}/messages/(?<id>[^/]+)/attachments`,
    ({ mailbox, id, query }) =>
      json(attachmentPage(mailbox, numberOf(id), query.get("$skiptoken")))
  ),
  route("GET", `${users}/mailFolders/(?<id>[^/]+)`, ({ id }) => {
    const folder = mailFolder(id);
    return folder === undefined ? json(notFound, 404) : json(folder);
  }),
  route(
    "GET",
    `${users}/messages/[^/]+/attachments/(?<id>[^/]+)`,
    ({ id, query }) => json(attachment(id, query.has("$select")))
  ),
  route("POST", `${users}/messages/(?<id>[^/]+)/move`, ({ mailbox, id }) =>
    json(moved(mailbox, numberOf(id)), 201)
  ),
  route("POST", `${users}/sendMail`, async ({ mailbox, request }) => {
    const sent = z.object({ message: z.unknown() }).parse(await request.json());
    keepTag(mailbox, `sent-${crypto.randomUUID()}`, sent.message);
    return new Response(null, { status: 202 });
  }),
  route("POST", `${users}/messages`, async ({ mailbox, request }) => {
    const body: unknown = await request.json();
    const { subject } = draftSchema.parse(body);
    const made = draft(mailbox, subject);
    keepTag(mailbox, made.id, body);
    return json(made, 201);
  }),
  route("GET", `${users}/calendarView`, ({ mailbox, query }) =>
    json(eventPage(mailbox, query.get("$skiptoken")))
  ),
  route("GET", `${users}/events/(?<id>[^/]+)`, ({ mailbox, id }) =>
    json(eventDetail(mailbox, numberOf(id)))
  ),
  route("GET", `${drives}/(?:root|items/[^/]+)/children`, ({ drive, query }) =>
    json(childrenPage(drive, query.get("$skiptoken")))
  ),
  route("GET", String.raw`${drives}/root/search\(q='.*'\)`, ({ drive }) =>
    json(searchResults(drive))
  ),
  route("GET", `${drives}/items/(?<id>[^/]+)`, ({ drive, id }) =>
    json(item(drive, id))
  ),
  route(
    "GET",
    `${drives}/items/(?<id>[^/]+)/content`,
    ({ id }) =>
      new Response(null, {
        status: 302,
        headers: { location: downloadUrl(id) },
      })
  ),
];

/** SharePoint's answer to a download: the file, or a second redirect. */
const sharePointAnswer = (url: URL): Response => {
  const id = url.searchParams.get("UniqueId");
  if (id === itemIds.twice) {
    return Response.redirect(downloadUrl(itemIds.report), 302);
  }
  const content = {
    [itemIds.pdf]: invoicePdf,
    [itemIds.controls]: new TextEncoder().encode(controlText),
  }[id ?? ""];
  return new Response(content ?? new TextEncoder().encode(reportText), {
    headers: { "content-type": "application/octet-stream" },
  });
};

/** Graph, SharePoint and the rest of the internet, for each test in the file. */
export const fakeGraph = () => {
  beforeEach(() => {
    tagged.clear();
    duringLookup = undefined;
    resetWorkbooks();
  });
  const { sent, writesDone, fail } = fakeProvider({
    hosts: [graphHost],
    parts,
    routes: graphRoutes,
    unmatched: () =>
      json(
        { error: { code: "BadRequest", message: "Unsupported request" } },
        400
      ),
    elsewhere: (url) =>
      url.hostname.endsWith(".sharepoint.com")
        ? sharePointAnswer(url)
        : new Response("Taken"),
  });
  return {
    sent,
    /** The writes Graph carried out. */
    writesDone,
    /** Makes Graph throttle the next request. */
    throttle: () => {
      fail({ status: 429, body: throttled, headers: { "retry-after": "7" } });
    },
    /** Makes Graph throttle the next write, and only it. */
    throttleWrite: () => {
      fail({
        status: 429,
        body: throttled,
        headers: { "retry-after": "7" },
        writesOnly: true,
      });
    },
    /** Makes Graph answer the next write with `status`, without acting. */
    failWrite: (status: number, body?: unknown) => {
      fail({
        status,
        body: body ?? { error: { code: "Failed" } },
        writesOnly: true,
      });
    },
    /**
     * Makes Graph throttle the next write, and only it, running
     * `meanwhile` while the write is with it.
     */
    throttleWriteWhile: (meanwhile: () => Promise<void>) => {
      fail({
        status: 429,
        body: throttled,
        headers: { "retry-after": "7" },
        writesOnly: true,
        meanwhile,
      });
    },
    /** Runs `meanwhile` while Graph answers the next lookup by effect key. */
    whileLookingUp: (meanwhile: () => Promise<void>) => {
      duringLookup = meanwhile;
    },
    /** Makes Graph answer the next request, a read too, with `status`. */
    failNext: (status: number) => {
      fail({ status, body: { error: { code: "Failed" } } });
    },
    /** Makes Graph carry out the next write, then lose its answer. */
    loseWriteAnswer: () => {
      fail({ lost: true, writesOnly: true });
    },
    /** The rows of workbook `id`'s supplier table, as Excel holds them. */
    supplierRowsOf: (id: string): readonly SheetCell[][] =>
      workbooks.get(id)?.get(supplierTable)?.rows ?? [],
    sharePointHost,
  };
};
