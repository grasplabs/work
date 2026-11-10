import { connectorManifestSchema } from "@grasp-os/connector-kit/manifest";
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
import {
  meetingPage,
  sectionIds,
  suppliersList,
} from "./fixtures/graph-apps.ts";
import { chatIds, eventIds } from "./fixtures/graph-teams.ts";
import {
  ceo,
  contractsList,
  financeDrive,
  threadConversationId,
  invoices,
  itemIds,
  messageId,
  eventId,
  pdfAttachmentId,
  procedureTexts,
  supplierTable,
  todoListIds,
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
  mailbox,
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

/** Input for each mail and calendar tool, but its mailbox. */
export const mailboxInputs: Record<string, Input> = {
  "mail.list": {},
  "mail.thread": { conversation: threadConversationId },
  "mail.get": { message: messageId(ceo, 1) },
  "mail.readAttachment": {
    message: messageId(ceo, 1),
    attachment: pdfAttachmentId,
  },
  "mail.move": { message: messageId(ceo, 1), destination: "archive" },
  "mail.flag": {
    message: messageId(ceo, 1),
    from: "billing@northwind.example.org",
    subject: invoiceSubject,
    flag: "flagged",
  },
  "mail.categorise": {
    message: messageId(ceo, 1),
    from: "billing@northwind.example.org",
    subject: invoiceSubject,
    categories: ["Finance"],
  },
  "mail.send": { subject: "Hi", body: "Hi", to: ["a@example.com"] },
  "mail.createDraft": { subject: "Hi", body: "Hi", to: ["a@example.com"] },
  "mail.createReplyDraft": {
    message: messageId(ceo, 1),
    subject: "RE: Hi",
    body: "Hi",
    to: ["billing@northwind.example.org"],
  },
  "calendar.list": {
    start: "2026-09-28T00:00:00Z",
    end: "2026-10-05T00:00:00Z",
  },
  "calendar.get": { event: eventId(ceo, 1) },
  "todo.lists": {},
  "todo.tasks": { list: todoListIds.tasks },
  "todo.create": { list: todoListIds.tasks, title: "Send the signed contract" },
  "todo.complete": {
    list: todoListIds.tasks,
    task: "AAkALgAAAAAAHYQDEapmEc2b=",
  },
  "calendar.freeTime": {
    start: "2026-10-26T00:00",
    end: "2026-10-27T00:00",
    timeZone: "Europe/Amsterdam",
    minutes: 30,
  },
  "calendar.create": {
    subject: "Focus time",
    start: "2026-10-26T14:00",
    end: "2026-10-26T15:00",
    timeZone: "Europe/Amsterdam",
  },
  "calendar.update": {
    event: eventId(ceo, 1),
    timeZone: "Europe/Amsterdam",
    subject: "Focus time",
  },
  "onenote.sections": {},
  "onenote.pages": { section: sectionIds.own },
  "onenote.read": { page: meetingPage.id },
  "onenote.create": {
    section: sectionIds.own,
    title: "Notes",
    text: "Call Northwind back",
  },
  "chats.list": {},
  "chats.messages": { chat: chatIds.own },
  "meetings.list": {
    from: "2026-10-19T00:00:00Z",
    to: "2026-10-26T00:00:00Z",
  },
  "meetings.transcript": { event: eventIds.review },
};

/** Input for each file tool, but its drive. */
export const driveInputs: Record<string, Input> = {
  "files.list": {},
  "files.search": { query: "invoice" },
  "files.versions": { item: itemIds.procedure },
  "files.read": { item: itemIds.report },
  "word.read": { item: itemIds.contract },
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
  "excel.listRows": supplierTableOf,
  "excel.addRow": { ...supplierTableOf, values: fabrikam },
  "excel.updateRow": {
    ...supplierTableOf,
    row: 0,
    before: northwind,
    after: withAmount(northwind, 1350),
  },
};

/** Input for each list tool, but its site. */
export const siteInputs: Record<string, Input> = {
  "lists.items": { list: contractsList },
  "lists.addItem": {
    list: suppliersList,
    values: [{ column: "Title", value: "Fabrikam Metals" }],
  },
  "lists.updateItem": {
    list: suppliersList,
    item: "1",
    before: [{ column: "CreditLimit", value: 5000 }],
    after: [{ column: "CreditLimit", value: 7500 }],
  },
};

/** Input for each Planner tool, but its plan. */
export const planInputs: Record<string, Input> = {
  "planner.tasks": {},
  "planner.create": { title: "Reconcile Fabrikam's statement" },
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
  await call(connection, "mail.createReplyDraft", input, {
    resource: invoices,
    idempotencyKey,
  });

/** The organization's time zone, in the calendar tools below. */
export const amsterdam = "Europe/Amsterdam";

/** Looks for free time in a calendar. */
export const freeTime = async (connection: Connection, input: Input) =>
  await call(connection, "calendar.freeTime", input);

/** An hour of focus time in `mailbox`'s calendar, in Amsterdam time. */
export const focusTime = (mailbox: string) => ({
  mailbox,
  subject: "Focus time: Q4 forecast",
  start: "2026-10-26T14:00",
  end: "2026-10-26T15:00",
  timeZone: amsterdam,
});

/** Puts an event in the person's own calendar, under `key`. */
export const createEvent = async (
  connection: Connection,
  input: Input,
  key: string = crypto.randomUUID()
) =>
  await call(connection, "calendar.create", input, {
    resource: connection.person.email,
    idempotencyKey: key,
  });

/** Changes an event in the person's own calendar. */
export const updateEvent = async (connection: Connection, input: Input) =>
  await call(connection, "calendar.update", input, {
    resource: connection.person.email,
    idempotencyKey: crypto.randomUUID(),
  });

/** The event, as calendar.get reads it from the person's own calendar. */
export const readEvent = async (connection: Connection, event: string) =>
  await outputOf(
    call(connection, "calendar.get", {
      mailbox: connection.person.email,
      event,
    })
  );

/** The ID of the event a calendar write answered with. */
export const madeId = z
  .object({ event: z.object({ id: z.string() }) })
  .transform(({ event }) => event.id);

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

/** The person's own mailbox, as their To Do is named. */
export const ownMailbox = ({ person }: Connection): string => person.email;

/** The id of the task a To Do tool answered with. */
export const taskIdOf = (created: unknown): string =>
  z.object({ task: z.object({ id: z.string() }) }).parse(created).task.id;

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
        action: "mail.list",
        input: { mailbox },
      },
      { mailboxes }
    )
  );
