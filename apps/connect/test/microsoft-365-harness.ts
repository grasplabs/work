import { connectorManifestSchema } from "@grasp-os/runtime/connector";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { nativeConnector } from "../src/bundled-connectors.ts";
import { connections, connectionTokens } from "../src/db/schema.ts";
import {
  agentFor,
  auditEvents,
  callAs,
  connectAccount,
  outcome,
  ownAccount,
  someone,
} from "./connect.ts";
import { suppliersList } from "./fixtures/graph-apps.ts";
import {
  ceo,
  contractsList,
  financeDrive,
  invoices,
  itemIds,
  messageId,
  eventId,
  pdfAttachmentId,
  procedureTexts,
  supplierTable,
} from "./fixtures/graph.ts";
import { fakeGraph } from "./graph-api.ts";
import { fakeProviders } from "./oauth-provider.ts";
import { callTool as call, outputOf, parsedRequests } from "./tool-calls.ts";
import type { Connection, Input } from "./tool-calls.ts";

// What microsoft-365*.test.ts share: the fake Graph and the connections
// that reach it, the mailboxes, drives, sites, plans and workbooks they
// name, and how they call the connector's tools.

export const providers = fakeProviders();
export const graph = fakeGraph(providers);
export const audit = auditEvents();

/** Someone's Microsoft 365 connection, made through OAuth. */
export const connected = async (): Promise<Connection> => {
  const person = someone();
  const id = await connectAccount(providers, person, ownAccount(person));
  return { id, person };
};

/**
 * Someone's connection, with their own mailbox: the address they sign in
 * with, which Graph's `/me` names, and any aliases it lists besides.
 */
export const connectedOwn = async (aliases: string[] = []) => {
  const person = someone();
  const id = await connectAccount(providers, person, {
    ...ownAccount(person),
    aliases,
  });
  return {
    connection: { id, person },
    own: person.email,
    ownPath: `/v1.0/users/${encodeURIComponent(person.email)}`,
  };
};

export const invoiceSubject = "Invoice 2026-0041 from Northwind Supplies";

/** An email in `mailbox`, as a card shows it: as Graph has it. */
export const shownEmail = (mailbox: string) => ({
  message: messageId(mailbox, 1),
  from: "billing@northwind.example.org",
  subject: invoiceSubject,
});

/** What left connect, each request with its query and JSON body parsed. */
export const requests = () => parsedRequests(graph.sent);

/** The requests with `method` that reached Graph. */
export const writesOf = (method: string) =>
  requests().filter((request) => request.method === method);

/** Graph's requests' paths. */
export const graphPaths = (): string[] =>
  requests()
    .filter(({ host }) => host === "graph.microsoft.com")
    .map(({ path }) => path);

export const mailboxPath = `/v1.0/users/${encodeURIComponent(invoices)}`;
export const drivePath = `/v1.0/drives/${financeDrive}`;

export const manifest = connectorManifestSchema.parse(
  nativeConnector("microsoft-365")?.manifest
);

/** Addresses as Graph takes a message's recipients. */
export const recipientsOf = (...addresses: string[]) =>
  addresses.map((address) => ({ emailAddress: { address } }));

/** Input for each mail and calendar tool, but its mailbox. */
export const mailboxInputs: Record<string, Input> = {
  "users.messages.list": {},
  "users.mailFolders.messages.list": { folder: "inbox" },
  "users.messages.get": { message: messageId(ceo, 1) },
  "users.messages.attachments.get": {
    message: messageId(ceo, 1),
    attachment: pdfAttachmentId,
  },
  "users.sendMail.create": {
    subject: "Hi",
    body: { content: "Hi" },
    toRecipients: recipientsOf("a@example.com"),
  },
  "users.messages.create": {
    subject: "Hi",
    body: { content: "Hi" },
    toRecipients: recipientsOf("a@example.com"),
  },
  "users.messages.createReply.create": {
    message: messageId(ceo, 1),
    subject: "RE: Hi",
    comment: "Hi",
    toRecipients: recipientsOf("billing@northwind.example.org"),
  },
  "users.calendarView.list": {
    startDateTime: "2026-09-28T00:00:00Z",
    endDateTime: "2026-10-05T00:00:00Z",
  },
  "users.events.get": { event: eventId(ceo, 1) },
  "users.events.create": {
    subject: "Focus time",
    start: { dateTime: "2026-10-26T14:00", timeZone: "Europe/Amsterdam" },
    end: { dateTime: "2026-10-26T15:00", timeZone: "Europe/Amsterdam" },
  },
  "users.events.update": { event: eventId(ceo, 1), subject: "Focus time" },
};

/** Input for each file tool, but its drive. */
export const driveInputs: Record<string, Input> = {
  "drives.root.children.list": {},
  "drives.items.children.list": { folder: itemIds.folder },
  "drives.root.search": { q: "invoice" },
  "drives.items.versions.list": { item: itemIds.procedure },
  "drives.items.content.download": { item: itemIds.report },
  "drives.items.versions.content.download": {
    item: itemIds.procedure,
    version: "1.0",
  },
};

/** A row of the supplier table, as its cells are read and written. */
export type SupplierRow = { column: string; value: Input[string] }[];

/** The supplier register's first row, as read. */
export const northwind: SupplierRow = [
  { column: "Supplier", value: "Northwind Supplies" },
  { column: "IBAN", value: "NL91ABNA0417164300" },
  { column: "Since", value: { date: "2024-01-01" } },
  { column: "Amount", value: 1200 },
];

/** Its second row, as read: a day in another date format, an empty cell. */
export const contoso: SupplierRow = [
  { column: "Supplier", value: "Contoso Paper" },
  { column: "IBAN", value: "NL02RABO0123456789" },
  { column: "Since", value: { date: "2025-06-15" } },
  { column: "Amount", value: null },
];

/** A supplier to add, since a day given as a date. */
export const fabrikam: SupplierRow = [
  { column: "Supplier", value: "Fabrikam Metals" },
  { column: "IBAN", value: "NL55INGB0001234567" },
  { column: "Since", value: { date: "2026-10-21" } },
  { column: "Amount", value: null },
];

/** `row` with its amount as `amount`. */
export const withAmount = (
  row: SupplierRow,
  amount: Input[string]
): SupplierRow =>
  row.map((cell) =>
    cell.column === "Amount" ? { ...cell, value: amount } : cell
  );

/** `row` with its IBAN as `iban`. */
export const withIban = (row: SupplierRow, iban: string): SupplierRow =>
  row.map((cell) => (cell.column === "IBAN" ? { ...cell, value: iban } : cell));

/** Where each Excel tool's call goes: the register's supplier table. */
export const supplierTableOf = { drive: financeDrive, table: supplierTable };

/** Input for each Excel tool, but its workbook. */
export const workbookInputs: Record<string, Input> = {
  "drives.items.workbook.tables.dataBodyRange": supplierTableOf,
  "drives.items.workbook.tables.rows.create": {
    ...supplierTableOf,
    values: fabrikam,
  },
  "drives.items.workbook.tables.rows.itemAt.range.update": {
    ...supplierTableOf,
    index: 0,
    before: northwind,
    values: withAmount(northwind, 1350),
  },
};

/** Input for each list tool, but its site. */
export const siteInputs: Record<string, Input> = {
  "sites.lists.items.list": { list: contractsList },
  "sites.lists.items.create": {
    list: suppliersList,
    fields: [{ column: "Title", value: "Fabrikam Metals" }],
  },
  "sites.lists.items.fields.update": {
    list: suppliersList,
    item: "1",
    before: [{ column: "CreditLimit", value: 5000 }],
    fields: [{ column: "CreditLimit", value: 7500 }],
  },
};

/** Input for each Planner tool, but its plan. */
export const planInputs: Record<string, Input> = {
  "planner.plans.tasks.list": {},
  "planner.tasks.create": { title: "Reconcile Fabrikam's statement" },
};

/** The `internetMessageHeaders` a sent mail or draft carried, or null. */
export const headersOf = (body: unknown): unknown => {
  const message = z
    .object({ message: z.record(z.string(), z.unknown()) })
    .transform(({ message: sent }) => sent)
    .or(z.record(z.string(), z.unknown()))
    .parse(body);
  return message.internetMessageHeaders ?? null;
};

/** The write requests that reached Graph. */
export const writes = () => requests().filter(({ method }) => method !== "GET");

export const draftReply = async (
  connection: Connection,
  input: Input,
  idempotencyKey: string
) =>
  await call(connection, "users.messages.createReply.create", input, {
    resource: invoices,
    idempotencyKey,
  });

/** The organization's time zone, in the calendar tools below. */
export const amsterdam = "Europe/Amsterdam";

/** An hour of focus time in `mailbox`'s calendar, in Amsterdam time. */
export const focusTime = (mailbox: string) => ({
  mailbox,
  subject: "Focus time: Q4 forecast",
  start: { dateTime: "2026-10-26T14:00", timeZone: amsterdam },
  end: { dateTime: "2026-10-26T15:00", timeZone: amsterdam },
});

/** Puts an event in the person's own calendar, under `key`. */
export const createEvent = async (
  connection: Connection,
  input: Input,
  key: string = crypto.randomUUID()
) =>
  await call(connection, "users.events.create", input, {
    resource: connection.person.email,
    idempotencyKey: key,
  });

/** Changes an event in the person's own calendar. */
export const updateEvent = async (connection: Connection, input: Input) =>
  await call(connection, "users.events.update", input, {
    resource: connection.person.email,
    idempotencyKey: crypto.randomUUID(),
  });

/** The event, as users.events.get reads it from the person's own calendar. */
export const readEvent = async (connection: Connection, event: string) =>
  await outputOf(
    call(connection, "users.events.get", {
      mailbox: connection.person.email,
      event,
    })
  );

/** The ID of the event a calendar write answered with. */
export const madeId = z.object({ id: z.string() }).transform(({ id }) => id);

/** The size of the procedure's text at `version`, in bytes. */
export const versionSize = (version: string): number =>
  new TextEncoder().encode(procedureTexts[version]).byteLength;

/** Lets the connection's access token run out, so its next call renews it. */
export const expire = async (connection: Connection): Promise<void> => {
  await drizzle(env.DB)
    .update(connectionTokens)
    .set({ accessExpiresAt: new Date(0) })
    .where(eq(connectionTokens.connectionId, connection.id));
};

/** The connection's status. */
export const statusOf = async (connection: Connection) => {
  const row = await drizzle(env.DB)
    .select({ status: connections.status })
    .from(connections)
    .where(eq(connections.id, connection.id))
    .get();
  return row?.status;
};

/** The id of the task a To Do tool answered with. */
export const taskIdOf = (created: unknown): string =>
  z.object({ id: z.string() }).parse(created).id;

/** An hour of focus time in the person's own calendar, under `key`. */
export const createFocusTime = async (connection: Connection, key: string) =>
  await createEvent(connection, focusTime(connection.person.email), key);

/** What a connection made before the connector wrote calendars holds. */
export const readOnlyCalendars = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.ReadWrite.Shared",
  "Mail.Send",
  "Mail.Send.Shared",
  "MailboxSettings.Read",
  "Calendars.Read",
  "Calendars.Read.Shared",
  "Files.Read.All",
  "Files.ReadWrite.All",
  "Sites.Read.All",
  "Tasks.ReadWrite",
];

export const graphScope = /^[A-Z]/u;

/** Entra's `scope` for a grant of `scopes`, Graph's by their full URI. */
export const grantOf = (scopes: readonly string[]): string =>
  scopes
    .map((scope) =>
      graphScope.test(scope) ? `https://graph.microsoft.com/${scope}` : scope
    )
    .join(" ");

/** Someone's connection whose grant Entra says holds `scopes`. */
export const connectedWith = async (
  scopes: readonly string[]
): Promise<Connection> => {
  const person = someone();
  const id = await connectAccount(providers, person, {
    ...ownAccount(person),
    granted: grantOf(scopes),
  });
  return { id, person };
};

export const accessDenied = { error: { code: "ErrorAccessDenied" } };

/**
 * How a chat agent's list of `mailbox` ends, with `mailboxes` signed in
 * as pointed at for its person (src/mailboxes.ts).
 */
export const listAs = async (
  connection: Connection,
  mailbox: string,
  mailboxes: string[]
) =>
  await outcome(
    callAs(
      agentFor(connection.person.userId),
      {
        connectionId: connection.id,
        action: "users.messages.list",
        input: { mailbox },
      },
      { mailboxes }
    )
  );
