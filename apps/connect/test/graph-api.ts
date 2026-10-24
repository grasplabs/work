/**
 * Microsoft Graph and the tenant's SharePoint, as the Microsoft 365
 * connector reaches them through connect's egress, serving the recorded
 * answers in test/fixtures/graph.ts. Any other host takes whatever it is
 * sent, as an attacker's would. `throttle` makes Graph answer the next
 * request with a 429, `throttleWrite` the next write; `failWrite` answers
 * the next write with an error, and `loseWriteAnswer` carries the next
 * write out and loses its answer. Events it makes or changes it keeps for
 * the test, and holds a change to the `If-Match` etag it is sent. Excel's
 * workbooks in the finance drive hold their named tables in memory, typed
 * as Excel types what it is sent, afresh for each test.
 */
import { egressHeader } from "@grasp-os/connector-kit/manifest";
import {
  effectPropertyId,
  graphHost,
} from "@grasp-os/connector-microsoft-365/graph";
import { beforeEach } from "vite-plus/test";
import { z } from "zod";

import {
  accessDenied,
  attachment,
  attachmentPage,
  childrenPage,
  contract,
  contractCount,
  contractsList,
  conversationPage,
  downloadUrl,
  draft,
  eventDetail,
  eventPage,
  financeSite,
  hrSite,
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
  replyDraft,
  notIndexed,
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

const sites = String.raw`^/v1\.0/sites/(?<site>[^/]+)`;

const parts = [
  "mailbox",
  "drive",
  "site",
  "list",
  "id",
  "table",
  "row",
] as const;

type Part = (typeof parts)[number];

/** One condition of a list's `$filter`. */
interface Condition {
  column: string;
  is: string;
  value: string | number;
}

/** One condition of a list's `$filter`, read where the last one ended. */
const conditionPattern =
  /fields\/(?<column>\w+) (?<is>eq|ne|gt|ge|lt|le) (?<literal>'(?:[^']|'')*'|-?\d+(?:\.\d+)?)(?: and |$)/uy;

/** A list `$filter`'s conditions, or undefined where Graph can't read it. */
const conditionsOf = (filter: string): Condition[] | undefined => {
  conditionPattern.lastIndex = 0;
  const conditions: Condition[] = [];
  while (conditionPattern.lastIndex < filter.length) {
    const { column, is, literal } = conditionPattern.exec(filter)?.groups ?? {};
    if (column === undefined || is === undefined || literal === undefined) {
      return undefined;
    }
    const value = literal.startsWith("'")
      ? literal.slice(1, -1).replaceAll("''", "'")
      : Number(literal);
    conditions.push({ column, is, value });
  }
  return conditions;
};

/** Whether a column's value meets a condition. */
const meets = (actual: unknown, { is, value }: Condition): boolean => {
  if (typeof actual !== typeof value) {
    return is === "ne";
  }
  const order =
    typeof value === "number"
      ? Number(actual) - value
      : String(actual).localeCompare(value);
  const outcomes: Record<string, boolean> = {
    eq: order === 0,
    ne: order !== 0,
    gt: order > 0,
    ge: order >= 0,
    lt: order < 0,
    le: order <= 0,
  };
  return outcomes[is] ?? false;
};

/** The columns `$expand=fields($select=...)` asks for. */
const selectedColumns = /^fields\(\$select=(?<columns>[\w,]+)\)$/u;

/**
 * Graph's page of the contracts register, as the query asks for it: the
 * items that meet every condition, with only the columns asked for (and
 * the two Graph always gives), `$top` of them after the `$skiptoken`'s.
 */
const contractPage = (
  site: string,
  list: string,
  query: URLSearchParams,
  conditions: readonly Condition[]
) => {
  const top = Number(query.get("$top") ?? 200);
  const after = Number(
    new URLSearchParams(query.get("$skiptoken") ?? "").get("p_ID") ?? 0
  );
  const columns = selectedColumns.exec(query.get("$expand") ?? "")?.groups
    ?.columns;
  const kept = new Set(["@odata.etag", "id", ...(columns?.split(",") ?? [])]);
  const rest = Array.from({ length: contractCount }, (_, index) =>
    contract(index + 1)
  ).filter(({ id, fields }) => {
    const values = new Map(Object.entries(fields));
    return (
      Number(id) > after &&
      conditions.every((condition) =>
        meets(values.get(condition.column), condition)
      )
    );
  });
  const page = rest.slice(0, top).map((listItem) => ({
    ...listItem,
    fields:
      columns === undefined
        ? listItem.fields
        : Object.fromEntries(
            Object.entries(listItem.fields).filter(([name]) => kept.has(name))
          ),
  }));
  const last = page.at(-1)?.id;
  const skipToken = encodeURIComponent(`Paged=TRUE&p_ID=${last}`);
  return {
    "@odata.context": `https://graph.microsoft.com/v1.0/$metadata#sites('${site}')/lists('${list}')/items`,
    value: page,
    ...(rest.length > top
      ? {
          "@odata.nextLink": `https://graph.microsoft.com/v1.0/sites/${site}/lists/${list}/items?%24expand=fields&%24top=${top}&%24skiptoken=${skipToken}`,
        }
      : {}),
  };
};

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

type GraphEvent = Record<string, unknown> & {
  id: string;
  "@odata.etag": string;
  attendees: unknown[];
};

/**
 * The events Graph made or changed, by mailbox and ID; any other is the
 * fixtures' as it was. Cleared before each test.
 */
const events = new Map<string, GraphEvent>();

/** The events Graph made that carry an effect key, by key. */
const taggedEvents = new Map<string, { mailbox: string; id: string }>();

const eventKey = (mailbox: string, id: string): string => `${mailbox}/${id}`;

/** An event of `mailbox` as Graph holds it now. */
const eventOf = (mailbox: string, id: string): GraphEvent =>
  events.get(eventKey(mailbox, id)) ?? eventDetail(mailbox, numberOf(id));

/** Whether a guest joins the event the next update reads, once it has read it. */
let inviteDuringRead = false;

/** How the next event read leaves out its guest list, if it does. */
let attendeesLeftOut: "missing" | "null" | undefined;

const newEtag = (): string => `W/"${crypto.randomUUID()}"`;

/** The time zone a request's `Prefer` header asks for, UTC if none. */
const zoneOf = (request: Request): string =>
  /outlook\.timezone="(?<zone>[^"]+)"/u.exec(
    request.headers.get("prefer") ?? ""
  )?.groups?.zone ?? "UTC";

const graphTimeSchema = z.object({
  dateTime: z.string(),
  timeZone: z.string(),
});

/** How long a time without its seconds is: `2026-10-26T14:30`. */
const minutesOnly = 16;

/**
 * A time as Graph answers it, in the zone it was asked in. Never
 * converted: these tests read in the zone they write in.
 */
const answeredTime = (
  { dateTime }: z.infer<typeof graphTimeSchema>,
  zone: string
): z.infer<typeof graphTimeSchema> => ({
  dateTime: `${dateTime.length === minutesOnly ? `${dateTime}:00` : dateTime.slice(0, 19)}.0000000`,
  timeZone: zone,
});

const eventChangesSchema = z.object({
  start: graphTimeSchema.optional(),
  end: graphTimeSchema.optional(),
});

/** `event` with `changes` made to it, its times as asked in `zone`. */
const changed = (
  event: GraphEvent,
  changes: Record<string, unknown>,
  zone: string
): GraphEvent => {
  const { start, end } = eventChangesSchema.parse(changes);
  return {
    ...event,
    ...changes,
    ...(start === undefined ? {} : { start: answeredTime(start, zone) }),
    ...(end === undefined ? {} : { end: answeredTime(end, zone) }),
    "@odata.etag": newEtag(),
  };
};

/** The effect key a lookup's `$filter` asks for, if it asks for one. */
const keyFilter =
  /^singleValueExtendedProperties\/Any\(ep: ep\/id eq '(?<id>[^']+)' and ep\/value eq '(?<key>[^']+)'\)$/u;

/** The conversation a `$filter` asks for, if it asks for one. */
const conversationFilter = / and conversationId eq '(?<id>[^']+)'$/u;

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
    `${sites}/lists/(?<list>[^/]+)/items`,
    ({ site, list, query, request }) => {
      // Graph holds a delegated token to its person's own SharePoint
      // rights: HR's site isn't theirs to open.
      if (site === hrSite) {
        return json(accessDenied, 403);
      }
      if (site !== financeSite || list !== contractsList) {
        return json(notFound, 404);
      }
      const filter = query.get("$filter");
      const conditions = filter === null ? [] : conditionsOf(filter);
      if (conditions === undefined) {
        return json({ error: { code: "invalidRequest" } }, 400);
      }
      const prefer = request.headers.get("prefer") ?? "";
      if (
        filter !== null &&
        !prefer.includes("HonorNonIndexedQueriesWarningMayFailRandomly")
      ) {
        return json(notIndexed, 400);
      }
      return json(contractPage(site, list, query, conditions));
    }
  ),
  route(
    "GET",
    `${users}(?:/mailFolders/[^/]+)?/messages`,
    async ({ mailbox, query }) => {
      const filter = query.get("$filter") ?? "";
      const conversation = conversationFilter.exec(filter)?.groups?.id;
      if (conversation !== undefined) {
        return json(
          conversationPage(mailbox, conversation, Number(query.get("$top")))
        );
      }
      if (!filter.startsWith("singleValueExtendedProperties/")) {
        return json(
          messagePage(
            mailbox,
            Number(query.get("$skip") ?? 0),
            filter.includes("flag/flagStatus eq 'flagged'")
          )
        );
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
  route(
    "POST",
    `${users}/messages/(?<id>[^/]+)/createReply`,
    async ({ mailbox, id, request }) => {
      const body: unknown = await request.json();
      const { message: reply } = z.object({ message: z.unknown() }).parse(body);
      const { subject } = draftSchema.parse(reply);
      const made = replyDraft(mailbox, numberOf(id), subject);
      keepTag(mailbox, made.id, reply);
      return json(made, 201);
    }
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
  route("GET", `${users}/events/(?<id>[^/]+)`, ({ mailbox, id }) => {
    const event = eventOf(mailbox, id);
    if (inviteDuringRead) {
      // Someone invites a guest right after this read.
      inviteDuringRead = false;
      events.set(eventKey(mailbox, id), {
        ...event,
        attendees: [
          {
            type: "required",
            status: { response: "none" },
            emailAddress: { name: "Guest", address: "guest@example.org" },
          },
        ],
        "@odata.etag": newEtag(),
      });
    }
    if (attendeesLeftOut !== undefined) {
      const { attendees: _attendees, ...rest } = event;
      const leftOut = attendeesLeftOut;
      attendeesLeftOut = undefined;
      return json(leftOut === "null" ? { ...rest, attendees: null } : rest);
    }
    return json(event);
  }),
  route("PATCH", `${users}/events/(?<id>[^/]+)`, async (part) => {
    const { mailbox, id, request } = part;
    const event = eventOf(mailbox, id);
    if (request.headers.get("if-match") !== event["@odata.etag"]) {
      return json({ error: { code: "ErrorIrresolvableConflict" } }, 412);
    }
    const changes = z
      .record(z.string(), z.unknown())
      .parse(await request.json());
    const updated = changed(event, changes, zoneOf(request));
    events.set(eventKey(mailbox, id), updated);
    return json(updated);
  }),
  route("POST", `${users}/events`, async ({ mailbox, request }) => {
    const body = z.record(z.string(), z.unknown()).parse(await request.json());
    const id = `AAMkAGE1M2IyNGNmLTI5MTktMade${crypto.randomUUID().replaceAll("-", "")}=`;
    const { singleValueExtendedProperties, ...asked } = body;
    const made = changed(
      {
        id,
        "@odata.etag": newEtag(),
        isOrganizer: true,
        isCancelled: false,
        isAllDay: false,
        organizer: { emailAddress: { name: "Anna", address: mailbox } },
        webLink: `https://outlook.office365.com/owa/?itemid=${id}`,
        attendees: [],
      },
      asked,
      zoneOf(request)
    );
    events.set(eventKey(mailbox, id), made);
    const tag = taggedSchema
      .safeParse({ singleValueExtendedProperties })
      .data?.singleValueExtendedProperties?.find(
        (property) => property.id === effectPropertyId
      )?.value;
    if (tag !== undefined) {
      taggedEvents.set(tag, { mailbox, id });
    }
    return json(made, 201);
  }),
  route("GET", `${users}/events`, ({ mailbox, query, request }) => {
    const asked = keyFilter.exec(query.get("$filter") ?? "")?.groups;
    if (asked?.id !== effectPropertyId) {
      return json({ error: { code: "BadRequest" } }, 400);
    }
    const found = taggedEvents.get(asked.key ?? "");
    const event =
      found?.mailbox === mailbox
        ? events.get(eventKey(mailbox, found.id))
        : undefined;
    const zone = zoneOf(request);
    return json({
      value:
        event === undefined
          ? []
          : [
              {
                ...event,
                start: answeredTime(graphTimeSchema.parse(event.start), zone),
                end: answeredTime(graphTimeSchema.parse(event.end), zone),
              },
            ],
    });
  }),
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
    events.clear();
    taggedEvents.clear();
    inviteDuringRead = false;
    attendeesLeftOut = undefined;
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
    /**
     * Makes Graph answer the next write with `status`, without acting,
     * running `meanwhile` (if given) while the write is with it.
     */
    failWrite: (
      status: number,
      body?: unknown,
      meanwhile?: () => Promise<void>
    ) => {
      fail({
        status,
        body: body ?? { error: { code: "Failed" } },
        writesOnly: true,
        ...(meanwhile === undefined ? {} : { meanwhile }),
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
    /** Has someone invite a guest to the next event read, right after it. */
    inviteDuringRead: () => {
      inviteDuringRead = true;
    },
    /** Graph's next event read leaves the guest list out, or sends it as null. */
    leaveOutAttendees: (how: "missing" | "null") => {
      attendeesLeftOut = how;
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
    /**
     * Has a person type `formula` into cell `column` of row `row` of
     * workbook `id`'s supplier table, Excel showing `value` for it.
     */
    typeFormula: (
      id: string,
      {
        row,
        column,
        formula,
        value,
      }: Omit<SheetCell, "format"> & { row: number; column: number }
    ) => {
      const cells = workbooks.get(id)?.get(supplierTable)?.rows[row];
      if (cells !== undefined) {
        cells[column] = { value, format: "General", formula };
      }
    },
    /** The rows of workbook `id`'s supplier table, as Excel holds them. */
    supplierRowsOf: (id: string): readonly SheetCell[][] =>
      workbooks.get(id)?.get(supplierTable)?.rows ?? [],
    sharePointHost,
  };
};
