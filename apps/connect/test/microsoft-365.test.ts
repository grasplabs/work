import { connectorManifestSchema } from "@grasp-os/connector-kit/manifest";
import { signCapability } from "@grasp-os/shared/capability";
import type { PendingAction } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { nativeConnector } from "../src/bundled-connectors.ts";
import {
  callChanges,
  connections,
  connectionTokens,
} from "../src/db/schema.ts";
import { accessTokenFor } from "../src/tokens.ts";
import {
  agentFor,
  auditEvents,
  callAs,
  chatOrigin,
  connectAccount,
  mailboxAccount,
  outcome,
  ownAccount,
  someone,
} from "./connect.ts";
import {
  meetingPage,
  planIds,
  sectionIds,
  suppliersList,
} from "./fixtures/graph-apps.ts";
import { chatIds, eventIds } from "./fixtures/graph-teams.ts";
import {
  archiveFolderId,
  attachmentsSkipToken,
  categoriesSkipToken,
  endlessAttachments,
  foreignFolderId,
  bigAttachmentId,
  childrenSkipToken,
  ceo,
  contractCount,
  contractsList,
  financeDrive,
  financeSite,
  hrSite,
  flaggedMessage,
  invoicePdf,
  longBody,
  longConversationId,
  longThreadLength,
  threadConversationId,
  invoices,
  itemAttachmentId,
  itemIds,
  messageId,
  movedId,
  eventId,
  pdfAttachmentId,
  pdfBase64,
  personalDrive,
  procedureTexts,
  replyDraft,
  reportText,
  spoofedId,
  supplierColumns,
  supplierTable,
  todoListIds,
  totalsRange,
  workbookIds,
} from "./fixtures/graph.ts";
import { fakeGraph } from "./graph-api.ts";
import { fakeProviders } from "./oauth-provider.ts";
import {
  callTool as call,
  claimedAgo,
  outputOf,
  parsedRequests,
  refusalsFor,
  resultOf,
  toolError,
} from "./tool-calls.ts";
import type { Connection, Input } from "./tool-calls.ts";

// The Microsoft 365 connector against Graph's recorded answers, through
// connect's real call path: capability, policy, a fresh isolate, the
// egress (which adds the token and holds each call to its routes), and
// back. Scoping comes first: a call for one mailbox or drive reaches only
// that one, by construction.

const providers = fakeProviders();
const graph = fakeGraph(providers);
const audit = auditEvents();

/** Someone's Microsoft 365 connection, made through OAuth. */
const connected = async (): Promise<Connection> => {
  const person = someone();
  const id = await connectAccount(providers, person, ownAccount(person));
  return { id, person };
};

/**
 * Someone's connection, with their own mailbox: the address they sign in
 * with, which Graph's `/me` names, and any aliases it lists besides.
 */
const connectedOwn = async (aliases: string[] = []) => {
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

const invoiceSubject = "Invoice 2026-0041 from Northwind Supplies";

/** An email in `mailbox`, as a card shows it: as Graph has it. */
const shownEmail = (mailbox: string) => ({
  mailbox,
  message: messageId(mailbox, 1),
  from: "billing@northwind.example.org",
  subject: invoiceSubject,
});

/** What left connect, each request with its query and JSON body parsed. */
const requests = () => parsedRequests(graph.sent);

/** The requests with `method` that reached Graph. */
const writesOf = (method: string) =>
  requests().filter((request) => request.method === method);

/** Graph's requests' paths. */
const graphPaths = (): string[] =>
  requests()
    .filter(({ host }) => host === "graph.microsoft.com")
    .map(({ path }) => path);

const mailboxPath = `/v1.0/users/${encodeURIComponent(invoices)}`;
const drivePath = `/v1.0/drives/${financeDrive}`;

const manifest = connectorManifestSchema.parse(
  nativeConnector("microsoft-365")?.manifest
);

/** Input for each mail and calendar tool, but its mailbox. */
const mailboxInputs: Record<string, Input> = {
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
const driveInputs: Record<string, Input> = {
  "files.list": {},
  "files.search": { query: "invoice" },
  "files.versions": { item: itemIds.procedure },
  "files.read": { item: itemIds.report },
  "word.read": { item: itemIds.contract },
};

/** A row of the supplier table, as its cells are read and written. */
type SupplierRow = { column: string; value: Input[string] }[];

/** The supplier register's first row, as read. */
const northwind: SupplierRow = [
  { column: "Supplier", value: "Northwind Supplies" },
  { column: "IBAN", value: "NL91ABNA0417164300" },
  { column: "Since", value: { date: "2024-01-01" } },
  { column: "Amount", value: 1200 },
];

/** Its second row, as read: a day in another date format, an empty cell. */
const contoso: SupplierRow = [
  { column: "Supplier", value: "Contoso Paper" },
  { column: "IBAN", value: "NL02RABO0123456789" },
  { column: "Since", value: { date: "2025-06-15" } },
  { column: "Amount", value: null },
];

/** A supplier to add, since a day given as a date. */
const fabrikam: SupplierRow = [
  { column: "Supplier", value: "Fabrikam Metals" },
  { column: "IBAN", value: "NL55INGB0001234567" },
  { column: "Since", value: { date: "2026-10-21" } },
  { column: "Amount", value: null },
];

/** `row` with its amount as `amount`. */
const withAmount = (row: SupplierRow, amount: Input[string]): SupplierRow =>
  row.map((cell) =>
    cell.column === "Amount" ? { ...cell, value: amount } : cell
  );

/** `row` with its IBAN as `iban`. */
const withIban = (row: SupplierRow, iban: string): SupplierRow =>
  row.map((cell) => (cell.column === "IBAN" ? { ...cell, value: iban } : cell));

/** Where each Excel tool's call goes: the register's supplier table. */
const supplierTableOf = { drive: financeDrive, table: supplierTable };

/** Input for each Excel tool, but its workbook. */
const workbookInputs: Record<string, Input> = {
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
const siteInputs: Record<string, Input> = {
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
const planInputs: Record<string, Input> = {
  "planner.tasks": {},
  "planner.create": { title: "Reconcile Fabrikam's statement" },
};

describe("the Microsoft 365 connector's scoping", () => {
  it("binds every route of every tool to its mailbox, drive, site, plan or workbook's named table, reads /me only to know whose a mailbox is, and writes under /me only for drafts in the person's own OneDrive", () => {
    const unbound = Object.entries(manifest.actions).flatMap(
      ([name, { resource, routes }]) =>
        routes
          .filter(
            ({ method, path }) =>
              !(
                (resource === "mailbox" &&
                  path.startsWith("/v1.0/users/{mailbox}/")) ||
                (resource === "drive" &&
                  path.startsWith("/v1.0/drives/{drive}/")) ||
                (resource === "site" &&
                  path.startsWith("/v1.0/sites/{site}/")) ||
                (resource === "plan" &&
                  (path === "/v1.0/planner/plans/{plan}" ||
                    path.startsWith("/v1.0/planner/plans/{plan}/"))) ||
                // Planner names a new task's plan in its body: the tool puts
                // its bound plan there, after reading that plan.
                (name === "planner.create" &&
                  method === "POST" &&
                  path === "/v1.0/planner/tasks") ||
                (resource === "workbook" &&
                  path.startsWith(
                    "/v1.0/drives/{drive}/items/{workbook}/workbook/tables/{table}/"
                  )) ||
                (method === "GET" && path === "/v1.0/me") ||
                (name === "files.createDraft" &&
                  resource === null &&
                  path.startsWith("/v1.0/me/drive/root:/{folder}/{name}"))
              )
          )
          .map(({ path }) => `${name} ${path}`)
    );
    expect(unbound).toStrictEqual([]);
    // Only the tools that work in the person's own mailbox or OneDrive go
    // to /me: the mail tools, calendar.freeTime and the chat and meeting
    // tools to ask whose the token is, files.createDraft to write its draft.
    const askWho = Object.entries(manifest.actions)
      .filter(([, { routes }]) =>
        routes.some(({ path }) => path.startsWith("/v1.0/me"))
      )
      .map(([name, { reach }]) => `${name} ${reach}`);
    expect(askWho.toSorted()).toStrictEqual([
      "calendar.freeTime own",
      "chats.list conversations",
      "chats.messages conversations",
      "files.createDraft own",
      "mail.categorise own",
      "mail.flag own",
      "mail.move own",
      "meetings.list conversations",
      "meetings.transcript conversations",
    ]);
    expect(
      Object.keys(manifest.actions).toSorted(),
      "every tool is tested for scoping below"
    ).toStrictEqual(
      [
        ...Object.keys(mailboxInputs),
        ...Object.keys(driveInputs),
        ...Object.keys(siteInputs),
        ...Object.keys(planInputs),
        ...Object.keys(workbookInputs),
        "files.createDraft",
      ].toSorted()
    );
    expect(manifest.hosts).toStrictEqual(["graph.microsoft.com"]);
  });

  it("keeps a call for one mailbox out of every other, for every mail and calendar tool", async () => {
    const connection = await connected();
    // The capability is for invoices@; each call names ceo@, or a spelling
    // Graph would take for invoices@ but that isn't exactly it.
    await expect(
      refusalsFor(connection, mailboxInputs, "mailbox", invoices, [
        ceo,
        "Invoices@example.com",
        `${invoices} `,
      ])
    ).resolves.toStrictEqual(new Set(["connect.resource_out_of_scope"]));
    expect(graph.sent).toStrictEqual([]);
    // The same capability reads its own mailbox, and only its paths.
    await call(
      connection,
      "mail.list",
      { mailbox: invoices },
      { resource: invoices }
    );
    expect(graphPaths()).toStrictEqual([`${mailboxPath}/messages`]);
  });

  it("keeps a call for one drive out of every other", async () => {
    const connection = await connected();
    await expect(
      refusalsFor(connection, driveInputs, "drive", financeDrive, [
        personalDrive,
      ])
    ).resolves.toStrictEqual(new Set(["connect.resource_out_of_scope"]));
    expect(graph.sent).toStrictEqual([]);
  });

  it("keeps a call for one site out of every other", async () => {
    const connection = await connected();
    await expect(
      refusalsFor(connection, siteInputs, "site", financeSite, [
        hrSite,
        financeSite.toUpperCase(),
      ])
    ).resolves.toStrictEqual(new Set(["connect.resource_out_of_scope"]));
    expect(graph.sent).toStrictEqual([]);
  });

  it("keeps a call for one plan out of every other", async () => {
    const connection = await connected();
    await expect(
      refusalsFor(connection, planInputs, "plan", planIds.finance, [planIds.hr])
    ).resolves.toStrictEqual(new Set(["connect.resource_out_of_scope"]));
    expect(graph.sent).toStrictEqual([]);
  });

  it("keeps a call for one workbook out of every other", async () => {
    const connection = await connected();
    await expect(
      refusalsFor(
        connection,
        workbookInputs,
        "workbook",
        workbookIds.register,
        [workbookIds.other]
      )
    ).resolves.toStrictEqual(new Set(["connect.resource_out_of_scope"]));
    expect(graph.sent).toStrictEqual([]);
  });
});

/** The `internetMessageHeaders` a sent mail or draft carried, or null. */
const headersOf = (body: unknown): unknown => {
  const message = z
    .object({ message: z.record(z.string(), z.unknown()) })
    .transform(({ message: sent }) => sent)
    .or(z.record(z.string(), z.unknown()))
    .parse(body);
  return message.internetMessageHeaders ?? null;
};

describe("the Microsoft 365 connector's mail tools", () => {
  it("list a mailbox's messages, newest first, with the IDs they came from", async () => {
    const connection = await connected();
    const token = await accessTokenFor(env, connection.id);
    const result = await resultOf(
      call(connection, "mail.list", { mailbox: invoices })
    );
    expect(result).toMatchObject({
      output: {
        mailbox: invoices,
        messages: [
          {
            mailbox: invoices,
            id: messageId(invoices, 1),
            subject: "Invoice 2026-0041 from Northwind Supplies",
            from: {
              name: "Northwind Billing",
              address: "billing@northwind.example.org",
            },
            to: [{ name: "Invoices", address: invoices }],
            isRead: false,
            hasAttachments: true,
          },
          { mailbox: invoices, id: messageId(invoices, 2) },
        ],
      },
      provenance: [messageId(invoices, 1), messageId(invoices, 2)],
    });
    expect(requests()).toMatchObject([
      {
        method: "GET",
        path: `${mailboxPath}/messages`,
        query: { $top: "25", $orderby: "receivedDateTime desc" },
        headers: { authorization: `Bearer ${token}` },
      },
    ]);
  });

  it("page through Graph's next link on their own route, never following it", async () => {
    const connection = await connected();
    const first = await outputOf(
      call(connection, "mail.list", { mailbox: invoices, top: 2 })
    );
    expect(first).toMatchObject({ nextPage: "%24skip=2" });
    const page = z.object({ nextPage: z.string() }).parse(first).nextPage;
    await expect(
      outputOf(
        call(connection, "mail.list", { mailbox: invoices, top: 2, page })
      )
    ).resolves.toMatchObject({
      messages: [{ id: messageId(invoices, 3) }],
      nextPage: null,
    });
    // Graph's link names `users('invoices%40example.com')`: not followed.
    expect(requests()[1]).toMatchObject({
      path: `${mailboxPath}/messages`,
      query: { $top: "2", $skip: "2" },
    });
    // A page is only a position: anything else in one is ignored, and one
    // without a position is refused.
    await call(connection, "mail.list", {
      mailbox: invoices,
      page: "%24skip=2&%24select=body",
    });
    expect(requests()[2]?.query.$select).not.toBe("body");
    await expect(
      toolError(
        call(connection, "mail.list", {
          mailbox: invoices,
          page: "$select=body",
        })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
  });

  it("search a folder, filter, but not both at once", async () => {
    const connection = await connected();
    await call(connection, "mail.list", {
      mailbox: invoices,
      folder: "inbox",
      search: "invoice 2026",
    });
    await call(connection, "mail.list", {
      mailbox: invoices,
      unreadOnly: true,
    });
    const [searched, filtered] = requests();
    expect({ searched, filtered }).toMatchObject({
      searched: {
        path: `${mailboxPath}/mailFolders/inbox/messages`,
        query: { $search: '"invoice 2026"' },
      },
      filtered: {
        query: {
          $filter:
            "receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false",
          $orderby: "receivedDateTime desc",
        },
      },
    });
    // Search results come by relevance: no order is asked for.
    expect(searched?.query).not.toHaveProperty("$orderby");
    await expect(
      toolError(
        call(connection, "mail.list", {
          mailbox: invoices,
          search: "invoice",
          unreadOnly: true,
        })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    expect(graph.sent).toHaveLength(2);
  });

  it("list the flagged messages only, each with its flag and conversation", async () => {
    const connection = await connected();
    await expect(
      outputOf(
        call(connection, "mail.list", { mailbox: invoices, flaggedOnly: true })
      )
    ).resolves.toMatchObject({
      messages: [
        {
          id: messageId(invoices, flaggedMessage),
          flagStatus: "flagged",
          conversationId:
            "AAQkAGE1M2IyNGNmLTI5MTktNDUyZi1iOTVjLTc2ZjI5ZmNmZmQ2MwAQAC3Ym9A=",
        },
      ],
      nextPage: null,
    });
    expect(requests()).toMatchObject([
      {
        path: `${mailboxPath}/messages`,
        query: {
          $filter:
            "receivedDateTime ge 1900-01-01T00:00:00Z and flag/flagStatus eq 'flagged'",
          $orderby: "receivedDateTime desc",
        },
      },
    ]);
    await expect(
      toolError(
        call(connection, "mail.list", {
          mailbox: invoices,
          search: "invoice",
          flaggedOnly: true,
        })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    expect(graph.sent).toHaveLength(1);
  });

  it("read a conversation oldest first, Sent Items included, so the last word shows who waits", async () => {
    const connection = await connected();
    const result = await resultOf(
      call(connection, "mail.thread", {
        mailbox: invoices,
        conversation: threadConversationId,
      })
    );
    const billing = {
      name: "Northwind Billing",
      address: "billing@northwind.example.org",
    };
    expect(result).toMatchObject({
      output: {
        mailbox: invoices,
        conversationId: threadConversationId,
        messages: [
          { id: messageId(invoices, 101), from: billing },
          {
            id: messageId(invoices, 102),
            from: { address: invoices },
            to: [billing],
          },
          {
            mailbox: invoices,
            id: messageId(invoices, 103),
            conversationId: threadConversationId,
            from: billing,
            isRead: false,
            body: "Message 3 of the conversation about invoice 2026-0041.",
            bodyCut: false,
          },
        ],
        earlierMessages: false,
      },
      provenance: [101, 102, 103].map((n) => messageId(invoices, n)),
    });
    // The whole mailbox, not a folder, so the person's own replies count;
    // each message's own text only, as text.
    expect(requests()).toMatchObject([
      {
        path: `${mailboxPath}/messages`,
        query: {
          $filter: `receivedDateTime ge 1900-01-01T00:00:00Z and conversationId eq '${threadConversationId}'`,
          $orderby: "receivedDateTime desc",
        },
        headers: { prefer: 'outlook.body-content-type="text"' },
      },
    ]);
    expect(requests()[0]?.query.$select?.split(",")).toContain("uniqueBody");
    // A conversation ID can't end the filter's string literal: refused as
    // input, before anything goes out.
    await expect(
      toolError(
        call(connection, "mail.thread", {
          mailbox: invoices,
          conversation: "x' or isRead eq false or id eq 'y",
        })
      )
    ).resolves.toBe("Invalid input: invalid_format at conversation");
    expect(graph.sent).toHaveLength(1);
  });

  it("cut a long conversation to its newest messages, and a long body to its bound", async () => {
    const connection = await connected();
    const output = z
      .object({
        messages: z.array(
          z.object({
            id: z.string(),
            body: z.string().nullable(),
            bodyCut: z.boolean(),
          })
        ),
        earlierMessages: z.boolean(),
      })
      .parse(
        await outputOf(
          call(connection, "mail.thread", {
            mailbox: invoices,
            conversation: longConversationId,
          })
        )
      );
    const bound = 25;
    expect(output.earlierMessages).toBeTruthy();
    expect(output.messages.map(({ id }) => id)).toStrictEqual(
      Array.from({ length: bound }, (_, at) =>
        messageId(invoices, 100 + longThreadLength - bound + 1 + at)
      )
    );
    const last = output.messages.at(-1);
    expect(last).toMatchObject({ bodyCut: true });
    // Cut before the emoji whose halves straddle the bound, never between them.
    expect({
      straddling: String.fromCodePoint(longBody.codePointAt(7999) ?? 0),
      body: last?.body,
    }).toStrictEqual({ straddling: "🧾", body: longBody.slice(0, 7999) });
    expect(
      output.messages.slice(0, -1).filter(({ bodyCut }) => bodyCut)
    ).toStrictEqual([]);
  });

  it("get a message with its body as text, and its attachments' metadata", async () => {
    const connection = await connected();
    const result = await resultOf(
      call(connection, "mail.get", {
        mailbox: invoices,
        message: messageId(invoices, 1),
      })
    );
    expect(result).toMatchObject({
      output: {
        message: {
          mailbox: invoices,
          id: messageId(invoices, 1),
          body: {
            contentType: "text",
            content:
              "Dear customer,\r\n\r\nPlease find attached invoice 2026-0041 for EUR 1,250.00.\r\n",
          },
          attachments: [
            {
              id: pdfAttachmentId,
              name: "Invoice-2026-0041.pdf",
              contentType: "application/pdf",
              size: invoicePdf.byteLength,
              kind: "file",
            },
            { id: itemAttachmentId, kind: "item" },
          ],
          moreAttachments: false,
        },
      },
      provenance: [messageId(invoices, 1)],
    });
    // Attachments are listed without their content, every page on the
    // tool's own route: Graph's next link, naming the user and message its
    // own way, is never followed.
    const attachmentsPath = `${mailboxPath}/messages/${encodeURIComponent(messageId(invoices, 1))}/attachments`;
    const [got, first, second, ...rest] = requests();
    expect({ got, first, second, rest }).toMatchObject({
      got: { headers: { prefer: 'outlook.body-content-type="text"' } },
      first: { path: attachmentsPath },
      second: { path: attachmentsPath },
      rest: [],
    });
    expect([first?.query, second?.query]).toStrictEqual([
      { $select: "id,name,contentType,size,isInline" },
      {
        $select: "id,name,contentType,size,isInline",
        $skiptoken: attachmentsSkipToken,
      },
    ]);
    await expect(
      toolError(
        call(connection, "mail.get", {
          mailbox: invoices,
          message: "AAMkUnknown=",
        })
      )
    ).resolves.toStrictEqual({
      error: {
        code: "not_found",
        message: "Microsoft 365 has no such item (ErrorItemNotFound)",
      },
    });
  });

  it("list a message's attachments up to a bound, and say there are more", async () => {
    const connection = await connected();
    await expect(
      outputOf(
        call(connection, "mail.get", {
          mailbox: invoices,
          message: messageId(invoices, endlessAttachments),
        })
      )
    ).resolves.toMatchObject({ message: { moreAttachments: true } });
    expect(
      graphPaths().filter((path) => path.endsWith("/attachments"))
    ).toHaveLength(10);
  });

  it("read a file attachment as base64, and only a file", async () => {
    const connection = await connected();
    const input = {
      mailbox: invoices,
      message: messageId(invoices, 1),
      attachment: pdfAttachmentId,
    };
    await expect(
      resultOf(call(connection, "mail.readAttachment", input))
    ).resolves.toStrictEqual({
      output: {
        mailbox: invoices,
        messageId: messageId(invoices, 1),
        id: pdfAttachmentId,
        name: "Invoice-2026-0041.pdf",
        contentType: "application/pdf",
        size: invoicePdf.byteLength,
        encoding: "base64",
        content: pdfBase64,
      },
      provenance: [messageId(invoices, 1)],
    });
    const refusals = await Promise.all(
      [
        { ...input, as: "text" },
        { ...input, attachment: itemAttachmentId },
        { ...input, attachment: bigAttachmentId },
      ].map(
        async (each) =>
          await toolError(call(connection, "mail.readAttachment", each))
      )
    );
    expect(refusals).toMatchObject([
      { error: { code: "not_text" } },
      { error: { code: "not_a_file" } },
      { error: { code: "too_large" } },
    ]);
    // Too large: refused on its size, before its content was fetched.
    const big = requests().filter(({ path }) =>
      path.endsWith(encodeURIComponent(bigAttachmentId))
    );
    expect(big).toMatchObject([
      { query: { $select: "id,name,contentType,size,isInline" } },
    ]);
  });

  it("move an email once for its idempotency key, to a folder of the person's own mailbox", async () => {
    const { connection, own, ownPath } = await connectedOwn();
    const move = async (destination: string, idempotencyKey: string) =>
      await outputOf(
        call(
          connection,
          "mail.move",
          { mailbox: own, message: messageId(own, 1), destination },
          { resource: own, idempotencyKey }
        )
      );
    const first = await move("archive", "run-7:move-invoice");
    expect(first).toStrictEqual({
      mailbox: own,
      previousId: messageId(own, 1),
      id: movedId(own, 1),
      folderId: archiveFolderId,
    });
    await expect(move("archive", "run-7:move-invoice")).resolves.toStrictEqual(
      first
    );
    // The destination is looked up in the bound mailbox (once Graph's
    // `/me` said it is the person's own), and the message moved to the
    // folder it names there.
    expect(requests()).toMatchObject([
      { method: "GET", path: `${ownPath}/mailFolders/archive` },
      {
        method: "POST",
        path: `${ownPath}/messages/${encodeURIComponent(messageId(own, 1))}/move`,
        body: { destinationId: archiveFolderId },
      },
    ]);
    // Another mailbox's folder isn't one of this mailbox's: nothing moves.
    await expect(
      toolError(move(foreignFolderId, "run-7:move-away"))
    ).resolves.toMatchObject({ error: { code: "not_found" } });
    expect(writesOf("POST")).toHaveLength(1);
  });

  it("move an email only when it and its folder are the ones the card shows", async () => {
    const { connection, own } = await connectedOwn();
    const move = async (shown: Input, idempotencyKey: string) =>
      await outcome(
        call(
          connection,
          "mail.move",
          {
            mailbox: own,
            message: messageId(own, 1),
            destination: "archive",
            ...shown,
          },
          { resource: own, idempotencyKey }
        )
      );
    const outcomes = [
      await move({ from: "someone@example.org" }, "run-7:move-from"),
      await move({ subject: "Invoice 2026-0042" }, "run-7:move-subject"),
      await move({ folderName: "Deleted Items" }, "run-7:move-folder"),
      // As Graph has them, the sender in any case: it moves.
      await move(
        {
          from: "Billing@Northwind.example.org",
          subject: invoiceSubject,
          folderName: "Archive",
        },
        "run-7:move-shown"
      ),
    ];
    expect(outcomes).toStrictEqual([
      "connect.action_failed",
      "connect.action_failed",
      "connect.action_failed",
      "ok",
    ]);
    expect(writesOf("POST")).toHaveLength(1);
  });

  it("flag an email in the person's own mailbox, checked against the card first", async () => {
    const { connection, own, ownPath } = await connectedOwn();
    await expect(
      outputOf(
        call(
          connection,
          "mail.flag",
          { ...shownEmail(own), flag: "flagged" },
          { resource: own, idempotencyKey: "run-3:flag" }
        )
      )
    ).resolves.toStrictEqual({
      mailbox: own,
      id: messageId(own, 1),
      flag: "flagged",
    });
    const path = `${ownPath}/messages/${encodeURIComponent(messageId(own, 1))}`;
    expect(requests()).toMatchObject([
      { method: "GET", path, query: { $select: "id,from,subject" } },
      {
        method: "PATCH",
        path,
        body: { flag: { flagStatus: "flagged" } },
      },
    ]);
  });

  it("set a flag of unknown outcome again once its call can no longer be out: it sets the same flag", async () => {
    const { connection, own } = await connectedOwn();
    const complete = async () =>
      await outcome(
        call(
          connection,
          "mail.flag",
          { ...shownEmail(own), flag: "complete" },
          { resource: own, idempotencyKey: "run-3:complete" }
        )
      );
    graph.loseWriteAnswer();
    const lost = await complete();
    const early = await complete();
    await claimedAgo(connection);
    const recovered = await complete();
    const patches = writesOf("PATCH").map(({ body }) => JSON.stringify(body));
    expect({ lost, early, recovered, patches }).toStrictEqual({
      lost: "connect.outcome_unknown",
      early: "connect.outcome_unknown",
      recovered: "ok",
      patches: Array.from({ length: 2 }, () =>
        JSON.stringify({ flag: { flagStatus: "complete" } })
      ),
    });
  });

  // "Waiting on others" is on the second page of the person's categories.
  it("set an email's categories to exactly those asked, and the same again when its answer was lost", async () => {
    const { connection, own } = await connectedOwn();
    const categorise = async (idempotencyKey: string) =>
      await outcome(
        call(
          connection,
          "mail.categorise",
          {
            ...shownEmail(own),
            categories: ["Finance", "Waiting on others", "Finance"],
          },
          { resource: own, idempotencyKey }
        )
      );
    await expect(categorise("run-3:categorise")).resolves.toBe("ok");
    graph.loseWriteAnswer();
    const lost = await categorise("run-3:categorise-again");
    await claimedAgo(connection);
    const recovered = await categorise("run-3:categorise-again");
    const patches = writesOf("PATCH").map(({ body }) => JSON.stringify(body));
    expect({ lost, recovered, patches }).toStrictEqual({
      lost: "connect.outcome_unknown",
      recovered: "ok",
      patches: Array.from({ length: 3 }, () =>
        JSON.stringify({ categories: ["Finance", "Waiting on others"] })
      ),
    });
  });

  it("refuse a category the person doesn't have, before anything changes", async () => {
    const { connection, own, ownPath } = await connectedOwn();
    await expect(
      toolError(
        call(
          connection,
          "mail.categorise",
          { ...shownEmail(own), categories: ["Finance", "Board only"] },
          { resource: own, idempotencyKey: "run-3:new-category" }
        )
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    // Every page of their categories was read, the next on the tool's own
    // route, before it was refused.
    const categories = `${ownPath}/outlook/masterCategories`;
    expect(requests()).toMatchObject([
      { method: "GET", path: categories },
      {
        method: "GET",
        path: categories,
        query: { $skiptoken: categoriesSkipToken },
      },
    ]);
    expect(graph.writesDone()).toBe(0);
  });

  it("flag or categorise only an email that is the one the card shows", async () => {
    const { connection, own } = await connectedOwn();
    const shown = [
      { from: "someone@example.org" },
      { subject: "Invoice 2026-0042 from Northwind Supplies" },
      { subject: "invoice 2026-0041 from northwind supplies" },
    ];
    const outcomes = await Promise.all(
      shown.flatMap((differs) => [
        outcome(
          call(
            connection,
            "mail.flag",
            { ...shownEmail(own), ...differs, flag: "flagged" },
            { resource: own, idempotencyKey: crypto.randomUUID() }
          )
        ),
        outcome(
          call(
            connection,
            "mail.categorise",
            { ...shownEmail(own), ...differs, categories: ["Finance"] },
            { resource: own, idempotencyKey: crypto.randomUUID() }
          )
        ),
      ])
    );
    expect(new Set(outcomes)).toStrictEqual(new Set(["connect.action_failed"]));
    expect(graph.writesDone()).toBe(0);
  });

  it("work only in the person's own mailbox, by any of their addresses, asking only whose the token is", async () => {
    const alias = "the.person@acme.test";
    const { connection } = await connectedOwn([alias]);
    // invoices@ is a mailbox the token opens, but not the person's own.
    const inputs: Record<string, Input> = {
      "mail.flag": { flag: "flagged" },
      "mail.categorise": { categories: ["Finance"] },
      "mail.move": { destination: "archive" },
    };
    const elsewhere = await Promise.all(
      Object.entries(inputs).map(
        async ([action, input]) =>
          await toolError(
            call(
              connection,
              action,
              { ...shownEmail(invoices), ...input },
              { resource: invoices, idempotencyKey: crypto.randomUUID() }
            )
          )
      )
    );
    expect(elsewhere).toMatchObject(
      Array.from({ length: 3 }, () => ({ error: { code: "invalid" } }))
    );
    // Only `/me` was asked: nothing reached the mailbox.
    expect(graph.sent).toStrictEqual([]);
    // An alias of theirs, in another case, is their own mailbox.
    const shouted = alias.toUpperCase();
    await expect(
      outcome(
        call(
          connection,
          "mail.flag",
          { ...shownEmail(shouted), flag: "flagged" },
          { resource: shouted, idempotencyKey: "run-3:alias" }
        )
      )
    ).resolves.toBe("ok");
  });

  it("send mail from a shared mailbox", async () => {
    const connection = await connected();
    const token = await accessTokenFor(env, connection.id);
    await expect(
      outputOf(
        call(
          connection,
          "mail.send",
          {
            mailbox: invoices,
            subject: "Payment of invoice 2026-0041",
            body: "Paid today.",
            to: ["billing@northwind.example.org"],
            cc: ["controller@example.com"],
          },
          { resource: invoices, idempotencyKey: "run-7:send-receipt" }
        )
      )
    ).resolves.toStrictEqual({ mailbox: invoices, sent: true });
    expect(requests()).toMatchObject([
      {
        method: "POST",
        path: `${mailboxPath}/sendMail`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: {
          message: {
            subject: "Payment of invoice 2026-0041",
            body: { contentType: "text", content: "Paid today." },
            toRecipients: [
              { emailAddress: { address: "billing@northwind.example.org" } },
            ],
            ccRecipients: [
              { emailAddress: { address: "controller@example.com" } },
            ],
            bccRecipients: [],
            replyTo: [],
          },
          saveToSentItems: true,
        },
      },
    ]);
  });

  it("send and draft a workflow run's mail with its stamp as a header, which no call without one carries", async () => {
    const connection = await connected();
    const stamp = "5a".repeat(16);
    const mail = {
      mailbox: invoices,
      subject: "Payment of invoice 2026-0041",
      body: "Paid today.",
      to: ["billing@northwind.example.org"],
    };
    await call(connection, "mail.send", mail, {
      resource: invoices,
      idempotencyKey: "run-7:send-stamped",
      stamp,
    });
    await call(connection, "mail.createDraft", mail, {
      resource: invoices,
      idempotencyKey: "run-7:draft-stamped",
      stamp,
    });
    await call(connection, "mail.send", mail, {
      resource: invoices,
      idempotencyKey: "run-7:send-plain",
    });

    expect(
      requests()
        .filter(({ method }) => method === "POST")
        .map(({ body }) => headersOf(body))
    ).toStrictEqual([
      [{ name: "X-Grasp-Stamp", value: stamp }],
      [{ name: "X-Grasp-Stamp", value: stamp }],
      null,
    ]);
  });

  it("create a draft", async () => {
    const connection = await connected();
    await expect(
      outputOf(
        call(
          connection,
          "mail.createDraft",
          {
            mailbox: invoices,
            subject: "Question about invoice 2026-0041",
            body: "<p>Could you send the order number?</p>",
            bodyType: "html",
            to: ["billing@northwind.example.org"],
          },
          { idempotencyKey: "run-7:draft" }
        )
      )
    ).resolves.toMatchObject({ mailbox: invoices, id: messageId(invoices, 9) });
    expect(requests()).toMatchObject([
      {
        method: "POST",
        path: `${mailboxPath}/messages`,
        body: {
          subject: "Question about invoice 2026-0041",
          body: { contentType: "html" },
        },
      },
    ]);
  });
});

/** The write requests that reached Graph. */
const writes = () => requests().filter(({ method }) => method !== "GET");

const draftReply = async (
  connection: Connection,
  input: Input,
  idempotencyKey: string
) =>
  await call(connection, "mail.createReplyDraft", input, {
    resource: invoices,
    idempotencyKey,
  });

describe("the Microsoft 365 connector's reply drafts", () => {
  const sender = "billing@northwind.example.org";
  const reply = {
    mailbox: invoices,
    message: messageId(invoices, 1),
    subject: "RE: Invoice 2026-0041 from Northwind Supplies",
    body: "Thanks, we'll pay it this week.",
    to: [sender],
  };
  const replyPath = `${mailboxPath}/messages/${encodeURIComponent(messageId(invoices, 1))}`;
  const made = replyDraft(invoices, 1, reply.subject);
  const drafted = {
    mailbox: invoices,
    inReplyTo: messageId(invoices, 1),
    id: made.id,
    conversationId: made.conversationId,
    webLink: made.webLink,
  };

  it("draft a reply to a message's sender in its conversation, and never send it", async () => {
    const connection = await connected();
    await expect(
      outputOf(draftReply(connection, reply, "run-8:reply"))
    ).resolves.toStrictEqual(drafted);
    // The message replied to is read in the bound mailbox, then the draft
    // made with the recipients and subject the call holds, the person's
    // text above the quoted message.
    expect(requests()).toMatchObject([
      { method: "GET", path: replyPath },
      {
        method: "POST",
        path: `${replyPath}/createReply`,
        body: {
          comment: reply.body,
          message: {
            subject: reply.subject,
            toRecipients: [{ emailAddress: { address: sender } }],
            ccRecipients: [],
          },
        },
      },
    ]);
    // Its only write makes a draft: no call of it can send.
    expect(
      manifest.actions["mail.createReplyDraft"]?.routes
        .filter(({ method }) => method !== "GET")
        .map(({ path }) => path)
    ).toStrictEqual(["/v1.0/users/{mailbox}/messages/{message}/createReply"]);
  });

  it("reply to the message's other recipients only when replying to all, and to no one else", async () => {
    const connection = await connected();
    const refusals = await Promise.all(
      [
        { ...reply, to: ["someone@elsewhere.example.com"] },
        { ...reply, to: [sender, invoices] },
        { ...reply, cc: [invoices] },
        { ...reply, replyAll: true, cc: ["someone@elsewhere.example.com"] },
      ].map(
        async (input, index) =>
          await toolError(
            draftReply(connection, input, `run-8:refused-${index}`)
          )
      )
    );
    expect(refusals).toMatchObject(
      Array.from({ length: 4 }, () => ({ error: { code: "invalid" } }))
    );
    expect(writes()).toStrictEqual([]);
    // Replying to all, the message's To may be on it, in any case.
    await outputOf(
      draftReply(
        connection,
        {
          ...reply,
          replyAll: true,
          to: ["Billing@Northwind.example.org"],
          cc: [invoices],
        },
        "run-8:reply-all"
      )
    );
    expect(writes()).toMatchObject([
      {
        path: `${replyPath}/createReply`,
        body: {
          message: {
            toRecipients: [
              { emailAddress: { address: "Billing@Northwind.example.org" } },
            ],
            ccRecipients: [{ emailAddress: { address: invoices } }],
          },
        },
      },
    ]);
  });

  it("reply to the address a message asks replies to go to, and to all with its Cc", async () => {
    const connection = await connected();
    const second = {
      ...reply,
      message: messageId(invoices, 2),
      to: ["accounts@northwind.example.org"],
    };
    // Its Cc is someone the message was only copied to: not a reply's.
    await expect(
      toolError(
        draftReply(
          connection,
          { ...second, to: ["controller@example.com"] },
          "run-8:cc-only"
        )
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    await outputOf(draftReply(connection, second, "run-8:reply-to"));
    await outputOf(
      draftReply(
        connection,
        { ...second, replyAll: true, cc: ["controller@example.com"] },
        "run-8:reply-all-cc"
      )
    );
    const secondPath = `${mailboxPath}/messages/${encodeURIComponent(messageId(invoices, 2))}`;
    expect(writes()).toMatchObject([
      {
        path: `${secondPath}/createReply`,
        body: {
          message: {
            toRecipients: [
              { emailAddress: { address: "accounts@northwind.example.org" } },
            ],
            ccRecipients: [],
          },
        },
      },
      {
        path: `${secondPath}/createReply`,
        body: {
          message: {
            toRecipients: [
              { emailAddress: { address: "accounts@northwind.example.org" } },
            ],
            ccRecipients: [
              { emailAddress: { address: "controller@example.com" } },
            ],
          },
        },
      },
    ]);
  });

  it("find a reply draft whose answer was lost, and never make it twice", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await expect(
      outcome(draftReply(connection, reply, "run-8:reply-lost"))
    ).resolves.toBe("connect.outcome_unknown");
    await claimedAgo(connection);
    const found = await outputOf(
      draftReply(connection, reply, "run-8:reply-lost")
    );
    const repeat = await outputOf(
      draftReply(connection, reply, "run-8:reply-lost")
    );
    // The draft found by its key is the one the lost answer made.
    expect(found).toMatchObject({
      mailbox: invoices,
      inReplyTo: messageId(invoices, 1),
      id: drafted.id,
    });
    expect({
      repeat,
      writesDone: graph.writesDone(),
      writes: writes().length,
    }).toStrictEqual({ repeat: found, writesDone: 1, writes: 1 });
  });
});

describe("the Microsoft 365 connector's calendar tools", () => {
  it("list a range of events in UTC, page by page", async () => {
    const connection = await connected();
    const range = {
      mailbox: invoices,
      start: "2026-09-28T00:00:00Z",
      end: "2026-10-05T00:00:00Z",
      top: 1,
    };
    const skipToken = "d2c7f1a0-5b9e-4d1c-8e6a-3f2b7c9d0e1f";
    const first = await resultOf(call(connection, "calendar.list", range));
    expect(first).toMatchObject({
      output: {
        mailbox: invoices,
        events: [
          {
            mailbox: invoices,
            id: eventId(invoices, 1),
            subject: "Month-end close",
            start: { dateTime: "2026-09-29T09:00:00.0000000", timeZone: "UTC" },
            location: "Room 4.12",
          },
        ],
        nextPage: `%24skiptoken=${skipToken}`,
      },
      provenance: [eventId(invoices, 1)],
    });
    await expect(
      outputOf(
        call(connection, "calendar.list", {
          ...range,
          page: `%24skiptoken=${skipToken}`,
        })
      )
    ).resolves.toMatchObject({
      events: [{ id: eventId(invoices, 2) }],
      nextPage: null,
    });
    expect(requests()).toMatchObject([
      {
        path: `${mailboxPath}/calendarView`,
        query: { startDateTime: range.start, endDateTime: range.end },
        headers: { prefer: 'outlook.timezone="UTC"' },
      },
      { path: `${mailboxPath}/calendarView`, query: { $skiptoken: skipToken } },
    ]);
    await expect(
      toolError(
        call(connection, "calendar.list", { ...range, end: range.start })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
  });

  it("get an event with its body and attendees", async () => {
    const connection = await connected();
    await expect(
      resultOf(
        call(connection, "calendar.get", {
          mailbox: invoices,
          event: eventId(invoices, 1),
        })
      )
    ).resolves.toMatchObject({
      output: {
        event: {
          mailbox: invoices,
          id: eventId(invoices, 1),
          body: { contentType: "text" },
          attendees: [
            {
              name: "Controller",
              address: "controller@example.com",
              type: "required",
              response: "accepted",
            },
          ],
        },
      },
      provenance: [eventId(invoices, 1)],
    });
    expect(graphPaths()).toStrictEqual([
      `${mailboxPath}/events/${encodeURIComponent(eventId(invoices, 1))}`,
    ]);
  });
});

/** The organization's time zone, in the calendar tools below. */
const amsterdam = "Europe/Amsterdam";

/** Looks for free time in a calendar. */
const freeTime = async (connection: Connection, input: Input) =>
  await call(connection, "calendar.freeTime", input);

describe("the Microsoft 365 connector's free time", () => {
  it("finds free stretches around a person's events in working hours, in the organization's time zone", async () => {
    const connection = await connected();
    const own = connection.person.email;
    // Monday 26 October in Amsterdam, a day after the clocks went back:
    // UTC+1, so 09:00 there is 08:00 UTC.
    graph.holdEvents(own, [
      { start: "2026-10-26T08:00:00", end: "2026-10-26T09:00:00" },
      { start: "2026-10-26T11:00:00", end: "2026-10-26T12:00:00" },
      { start: "2026-10-26T12:20:00", end: "2026-10-26T14:00:00" },
      {
        start: "2026-10-26T14:00:00",
        end: "2026-10-26T15:00:00",
        showAs: "free",
      },
      {
        start: "2026-10-26T15:00:00",
        end: "2026-10-26T15:30:00",
        isCancelled: true,
      },
    ]);
    // From Saturday, over the weekend and the change of clocks.
    await expect(
      outputOf(
        freeTime(connection, {
          mailbox: own,
          start: "2026-10-24T00:00",
          end: "2026-10-27T00:00",
          timeZone: amsterdam,
          minutes: 30,
        })
      )
    ).resolves.toStrictEqual({
      mailbox: own,
      timeZone: amsterdam,
      // 13:00 to 13:20 is too short; the free and the cancelled events
      // leave their time free.
      free: [
        { start: "2026-10-26T10:00", end: "2026-10-26T12:00", minutes: 120 },
        { start: "2026-10-26T15:00", end: "2026-10-26T17:00", minutes: 120 },
      ],
    });
    const ownPath = `/v1.0/users/${encodeURIComponent(own)}`;
    expect(requests()).toMatchObject([
      {
        path: `${ownPath}/calendarView`,
        query: {
          startDateTime: "2026-10-23T22:00:00.000Z",
          endDateTime: "2026-10-26T23:00:00.000Z",
        },
        headers: { prefer: 'outlook.timezone="UTC"' },
      },
      { path: `${ownPath}/calendarView`, query: { $skiptoken: "2" } },
      { path: `${ownPath}/calendarView`, query: { $skiptoken: "4" } },
    ]);
  });

  it("puts each event on the organization's day, not UTC's, and takes working hours as given", async () => {
    const connection = await connected();
    const own = connection.person.email;
    const auckland = "Pacific/Auckland";
    // Auckland is UTC+13 in October: its Tuesday morning is Monday evening
    // in UTC, and its Wednesday morning Tuesday evening.
    graph.holdEvents(own, [
      { start: "2026-10-26T20:00:00", end: "2026-10-26T22:30:00" },
      { start: "2026-10-27T19:00:00", end: "2026-10-27T21:00:00" },
      // All of Thursday, as the person sees it.
      {
        start: "2026-10-29T00:00:00",
        end: "2026-10-30T00:00:00",
        isAllDay: true,
      },
    ]);
    await expect(
      outputOf(
        freeTime(connection, {
          mailbox: own,
          start: "2026-10-27T00:00",
          end: "2026-10-30T00:00",
          timeZone: auckland,
          minutes: 60,
          workingHours: {
            from: "08:00",
            to: "12:00",
            days: ["tuesday", "wednesday", "thursday"],
          },
        })
      )
    ).resolves.toMatchObject({
      free: [
        { start: "2026-10-27T08:00", end: "2026-10-27T09:00", minutes: 60 },
        { start: "2026-10-28T10:00", end: "2026-10-28T12:00", minutes: 120 },
      ],
    });
  });

  it("refuses another person's calendar, a shared one, and a range it can't read", async () => {
    const connection = await connected();
    const range = {
      start: "2026-10-26T00:00",
      end: "2026-10-27T00:00",
      timeZone: amsterdam,
      minutes: 30,
    };
    for (const mailbox of [ceo, invoices]) {
      // oxlint-disable-next-line no-await-in-loop -- one calendar at a time
      await expect(
        toolError(freeTime(connection, { ...range, mailbox }))
      ).resolves.toMatchObject({ error: { code: "invalid" } });
    }
    // Neither calendar's events were read: only whose the token is.
    expect(graphPaths()).toStrictEqual([]);
    const own = connection.person.email;
    const wrongs: Input[] = [
      { end: range.start },
      { end: "2026-12-01T00:00" },
      { workingHours: { from: "17:00", to: "09:00", days: ["monday"] } },
    ];
    for (const wrong of wrongs) {
      // oxlint-disable-next-line no-await-in-loop -- one input at a time
      await expect(
        toolError(freeTime(connection, { ...range, mailbox: own, ...wrong }))
      ).resolves.toMatchObject({ error: { code: "invalid" } });
    }
  });
});

/** An hour of focus time in `mailbox`'s calendar, in Amsterdam time. */
const focusTime = (mailbox: string) => ({
  mailbox,
  subject: "Focus time: Q4 forecast",
  start: "2026-10-26T14:00",
  end: "2026-10-26T15:00",
  timeZone: amsterdam,
});

/** Puts an event in the person's own calendar, under `key`. */
const createEvent = async (
  connection: Connection,
  input: Input,
  key: string = crypto.randomUUID()
) =>
  await call(connection, "calendar.create", input, {
    resource: connection.person.email,
    idempotencyKey: key,
  });

/** Changes an event in the person's own calendar. */
const updateEvent = async (connection: Connection, input: Input) =>
  await call(connection, "calendar.update", input, {
    resource: connection.person.email,
    idempotencyKey: crypto.randomUUID(),
  });

/** The event, as calendar.get reads it from the person's own calendar. */
const readEvent = async (connection: Connection, event: string) =>
  await outputOf(
    call(connection, "calendar.get", {
      mailbox: connection.person.email,
      event,
    })
  );

/** The ID of the event a calendar write answered with. */
const madeId = z
  .object({ event: z.object({ id: z.string() }) })
  .transform(({ event }) => event.id);

describe("the Microsoft 365 connector's calendar writes", () => {
  it("put an event in a person's own calendar with nobody invited, its times in the organization's time zone", async () => {
    const connection = await connected();
    const own = connection.person.email;
    const made = await outputOf(createEvent(connection, focusTime(own)));
    expect(made).toMatchObject({
      event: {
        mailbox: own,
        subject: "Focus time: Q4 forecast",
        start: { dateTime: "2026-10-26T14:00:00.0000000", timeZone: amsterdam },
        end: { dateTime: "2026-10-26T15:00:00.0000000", timeZone: amsterdam },
        showAs: "busy",
      },
    });
    // What Graph was asked to make: these fields, nobody invited, and the
    // call's tag; nothing else.
    const [sent] = requests();
    expect(sent).toMatchObject({
      method: "POST",
      path: `/v1.0/users/${encodeURIComponent(own)}/events`,
      headers: { prefer: `outlook.timezone="${amsterdam}"` },
    });
    expect(
      Object.keys(
        z.record(z.string(), z.unknown()).parse(sent?.body)
      ).toSorted()
    ).toStrictEqual(
      [
        "subject",
        "start",
        "end",
        "showAs",
        "attendees",
        "singleValueExtendedProperties",
      ].toSorted()
    );
    expect(sent?.body).toMatchObject({
      start: { dateTime: "2026-10-26T14:00", timeZone: amsterdam },
      attendees: [],
    });
    await expect(
      readEvent(connection, madeId.parse(made))
    ).resolves.toMatchObject({
      event: { subject: "Focus time: Q4 forecast", attendees: [] },
    });
  });

  it("refuse guests, and times that aren't wall-clock times in a time zone, before anything goes out", async () => {
    const connection = await connected();
    const own = connection.person.email;
    const changes: Input[] = [
      { attendees: [{ emailAddress: { address: "guest@example.org" } }] },
      { requiredAttendees: ["guest@example.org"] },
      { start: "2026-10-26T14:00:00Z" },
      { start: "2026-10-26T14:00+01:00" },
      // A day that doesn't exist, which Date.parse would move on.
      { start: "2026-02-30T10:00" },
      { timeZone: "Mars/Olympus_Mons" },
      { timeZone: 'UTC", outlook.body-content-type="html' },
      { end: "2026-10-26T13:00" },
    ];
    const refusals = await Promise.all(
      changes.map(
        async (change) =>
          await outcome(
            createEvent(connection, { ...focusTime(own), ...change })
          )
      )
    );
    // Guests are input the tool doesn't have: connect refuses them before
    // the tool does. The tool refuses the rest.
    expect(refusals).toStrictEqual([
      "connect.resource_out_of_scope",
      "connect.resource_out_of_scope",
      ...Array.from({ length: 6 }, () => "connect.action_failed"),
    ]);
    expect(graph.sent).toStrictEqual([]);
  });

  it("are shown for the person to confirm as the card will show them, and made once confirmed", async () => {
    const connection = await connected();
    const { person } = connection;
    const input = { ...focusTime(person.email), location: "Desk 3" };
    const inChat = agentFor(person.userId, "agent-chat", "interactive");
    const asked = {
      connectionId: connection.id,
      action: "calendar.create",
      input,
      resource: person.email,
      idempotencyKey: `chat-1:${crypto.randomUUID()}`,
    };
    await callAs(inChat, asked);
    const [held] = await exports.default.listPendingActions(person);
    expect({ held: held?.description, sent: graph.sent }).toStrictEqual({
      held: {
        title: "Put an event in your calendar",
        fields: [
          { input: "mailbox", label: "Calendar", value: person.email },
          { input: "subject", label: "Title", value: input.subject },
          { input: "start", label: "Starts", value: "2026-10-26T14:00" },
          { input: "end", label: "Ends", value: "2026-10-26T15:00" },
          { input: "timeZone", label: "Time zone", value: amsterdam },
          { input: "location", label: "Where", value: "Desk 3" },
        ],
        complete: true,
      },
      sent: [],
    });
    const confirmed = await exports.default.confirmAction({
      person,
      id: held?.id ?? "",
      inputHash: held?.inputHash ?? "",
      capability: await signCapability(env.CAPABILITY_SIGNING_KEY, inChat, {
        ...asked,
        origin: chatOrigin,
        decision: { kind: "confirm", pendingActionId: held?.id ?? "" },
      }),
    });
    const made = madeId.parse(JSON.parse(confirmed.output));
    await expect(readEvent(connection, made)).resolves.toMatchObject({
      event: { location: "Desk 3", attendees: [] },
    });
  });

  it("move an event the person organised alone, in the organization's time zone", async () => {
    const connection = await connected();
    const own = connection.person.email;
    const made = madeId.parse(
      await outputOf(createEvent(connection, focusTime(own)))
    );
    const moved = await outputOf(
      updateEvent(connection, {
        mailbox: own,
        event: made,
        timeZone: amsterdam,
        start: "2026-10-27T09:30",
        end: "2026-10-27T10:30",
      })
    );
    expect(moved).toMatchObject({
      event: {
        id: made,
        start: { dateTime: "2026-10-27T09:30:00.0000000", timeZone: amsterdam },
        subject: "Focus time: Q4 forecast",
      },
    });
    const patch = requests().find(({ method }) => method === "PATCH");
    expect(patch?.body).toStrictEqual({
      start: { dateTime: "2026-10-27T09:30", timeZone: amsterdam },
      end: { dateTime: "2026-10-27T10:30", timeZone: amsterdam },
    });
  });

  it("refuse to change an event with guests, or one someone else organised, and change nothing", async () => {
    const connection = await connected();
    const own = connection.person.email;
    const errors = await Promise.all(
      // The first has a guest; the CEO organised the second, and hides
      // its guests.
      [eventId(own, 1), eventId(own, 2)].map(
        async (event) =>
          await toolError(
            updateEvent(connection, {
              mailbox: own,
              event,
              timeZone: amsterdam,
              subject: "Moved",
            })
          )
      )
    );
    expect(errors).toMatchObject([
      { error: { code: "invalid" } },
      { error: { code: "invalid" } },
    ]);
    expect(graph.writesDone()).toBe(0);
  });

  it("refuse a change when Graph's answer doesn't say who is invited", async () => {
    const connection = await connected();
    const own = connection.person.email;
    const made = madeId.parse(
      await outputOf(createEvent(connection, focusTime(own)))
    );
    const outcomes: string[] = [];
    for (const how of ["missing", "null"] as const) {
      graph.leaveOutAttendees(how);
      outcomes.push(
        // oxlint-disable-next-line no-await-in-loop -- one read left out at a time
        await outcome(
          updateEvent(connection, {
            mailbox: own,
            event: made,
            timeZone: amsterdam,
            subject: "Moved",
          })
        )
      );
    }
    expect(outcomes).toStrictEqual([
      "connect.action_failed",
      "connect.action_failed",
    ]);
    expect(graph.writesDone()).toBe(1);
  });

  it("refuse a change once a guest was invited after the event was checked", async () => {
    const connection = await connected();
    const own = connection.person.email;
    const made = madeId.parse(
      await outputOf(createEvent(connection, focusTime(own)))
    );
    graph.inviteDuringRead();
    await expect(
      outcome(
        updateEvent(connection, {
          mailbox: own,
          event: made,
          timeZone: amsterdam,
          subject: "Moved",
        })
      )
    ).resolves.toBe("connect.action_failed");
    await expect(readEvent(connection, made)).resolves.toMatchObject({
      event: {
        subject: "Focus time: Q4 forecast",
        attendees: [{ address: "guest@example.org" }],
      },
    });
  });
});

/** The size of the procedure's text at `version`, in bytes. */
const versionSize = (version: string): number =>
  new TextEncoder().encode(procedureTexts[version]).byteLength;

describe("the Microsoft 365 connector's file tools", () => {
  it("list a drive's top folder or a folder in it, page by page", async () => {
    const connection = await connected();
    const first = await resultOf(
      call(connection, "files.list", { drive: financeDrive })
    );
    expect(first).toMatchObject({
      output: {
        drive: financeDrive,
        items: [
          { drive: financeDrive, id: itemIds.folder, kind: "folder" },
          {
            drive: financeDrive,
            id: itemIds.report,
            kind: "file",
            mimeType: "text/plain",
          },
        ],
        nextPage: `%24skiptoken=${childrenSkipToken}`,
      },
      provenance: [itemIds.folder, itemIds.report],
    });
    await call(connection, "files.list", {
      drive: financeDrive,
      folder: itemIds.folder,
      page: `%24skiptoken=${childrenSkipToken}`,
    });
    expect(requests()).toMatchObject([
      { path: `${drivePath}/root/children` },
      {
        path: `${drivePath}/items/${itemIds.folder}/children`,
        query: { $skiptoken: childrenSkipToken },
      },
    ]);
  });

  it("search a drive, quoting the query as OData does, and pass on its own items only", async () => {
    const connection = await connected();
    // Graph finds an item shared from another drive too: it's left out.
    await expect(
      resultOf(
        call(connection, "files.search", {
          drive: financeDrive,
          query: "Northwind's invoice",
        })
      )
    ).resolves.toStrictEqual({
      output: {
        drive: financeDrive,
        items: [expect.objectContaining({ id: itemIds.pdf })],
        nextPage: null,
      },
      provenance: [itemIds.pdf],
    });
    expect(graph.sent[0]?.path).toMatch(
      new RegExp(
        String.raw`^${drivePath}/root/search\(q='Northwind''s%20invoice'\)\?`,
        "u"
      )
    );
    // A query the egress would refuse in a path is refused before it.
    await expect(
      toolError(
        call(connection, "files.search", {
          drive: financeDrive,
          query: "../../me",
        })
      )
    ).resolves.toBe("Invalid input: invalid_format at query");
    expect(graph.sent).toHaveLength(1);
  });

  it("read a file through SharePoint's download, without the token going there", async () => {
    const connection = await connected();
    await expect(
      resultOf(
        call(connection, "files.read", {
          drive: financeDrive,
          item: itemIds.report,
        })
      )
    ).resolves.toStrictEqual({
      output: {
        drive: financeDrive,
        id: itemIds.report,
        name: "Month-end report.txt",
        version: null,
        mimeType: "text/plain",
        size: new TextEncoder().encode(reportText).byteLength,
        encoding: "text",
        content: reportText,
      },
      provenance: [itemIds.report],
    });
    expect(requests()).toMatchObject([
      {
        host: "graph.microsoft.com",
        path: `${drivePath}/items/${itemIds.report}`,
      },
      {
        host: "graph.microsoft.com",
        path: `${drivePath}/items/${itemIds.report}/content`,
      },
      {
        host: graph.sharePointHost,
        path: "/sites/Finance/_layouts/15/download.aspx",
        query: { UniqueId: itemIds.report },
      },
    ]);
    expect(graph.sent[2]?.headers).not.toHaveProperty("authorization");
    const pdf = { drive: financeDrive, item: itemIds.pdf };
    await expect(
      outputOf(call(connection, "files.read", { ...pdf, as: "base64" }))
    ).resolves.toMatchObject({ encoding: "base64", content: pdfBase64 });
    await expect(
      toolError(call(connection, "files.read", { ...pdf, as: "text" }))
    ).resolves.toMatchObject({ error: { code: "not_text" } });
  });

  it("read no folder, no other drive's file, and no file past the size limit", async () => {
    const connection = await connected();
    const refusals = await Promise.all(
      [itemIds.folder, itemIds.foreign, itemIds.big, itemIds.controls].map(
        async (item) =>
          await toolError(
            call(connection, "files.read", { drive: financeDrive, item })
          )
      )
    );
    // A text file whose escaped content would pass the answer's limit is
    // refused once read; the others before their content is asked for.
    expect(refusals).toMatchObject([
      { error: { code: "not_a_file" } },
      { error: { code: "not_found" } },
      { error: { code: "too_large" } },
      { error: { code: "too_large" } },
    ]);
    expect(
      graphPaths().filter((path) => path.endsWith("/content"))
    ).toStrictEqual([`${drivePath}/items/${itemIds.controls}/content`]);
  });

  it("list a file's versions newest first, each with when and by whom it was saved", async () => {
    const connection = await connected();
    const sanne = { name: "Sanne Visser", email: "sanne.visser@example.com" };
    // Graph's pre-authenticated download link of each isn't passed on.
    await expect(
      resultOf(
        call(connection, "files.versions", {
          drive: financeDrive,
          item: itemIds.procedure,
        })
      )
    ).resolves.toStrictEqual({
      output: {
        drive: financeDrive,
        id: itemIds.procedure,
        name: "Advice procedure.txt",
        versions: [
          {
            id: "3.0",
            current: true,
            savedAt: "2026-10-12T09:41:07Z",
            savedBy: sanne,
            size: versionSize("3.0"),
          },
          {
            id: "2.0",
            current: false,
            savedAt: "2026-06-03T14:20:55Z",
            savedBy: {
              name: "Daan Bakker",
              email: "daan.bakker@example.com",
            },
            size: versionSize("2.0"),
          },
          {
            id: "1.0",
            current: false,
            savedAt: "2025-11-18T08:05:30Z",
            savedBy: sanne,
            size: versionSize("1.0"),
          },
        ],
        nextPage: null,
      },
      provenance: [itemIds.procedure],
    });
    expect(graphPaths()).toStrictEqual([
      `${drivePath}/items/${itemIds.procedure}`,
      `${drivePath}/items/${itemIds.procedure}/versions`,
    ]);
  });

  it("page through a file's versions, the newest alone current", async () => {
    const connection = await connected();
    const pageSchema = z.object({
      versions: z.array(z.object({ id: z.string(), current: z.boolean() })),
      nextPage: z.string().nullable(),
    });
    const seen: { id: string; current: boolean }[] = [];
    let page: string | undefined;
    do {
      const read = pageSchema.parse(
        // oxlint-disable-next-line no-await-in-loop -- each page follows the last
        await outputOf(
          call(connection, "files.versions", {
            drive: financeDrive,
            item: itemIds.procedure,
            top: 1,
            ...(page === undefined ? {} : { page }),
          })
        )
      );
      seen.push(...read.versions);
      page = read.nextPage ?? undefined;
    } while (page !== undefined);
    expect(seen).toStrictEqual([
      { id: "3.0", current: true },
      { id: "2.0", current: false },
      { id: "1.0", current: false },
    ]);
  });

  it("refuse an older version too big to read before asking for its content", async () => {
    const connection = await connected();
    graph.oversizeVersion("1.0");
    await expect(
      toolError(
        call(connection, "files.read", {
          drive: financeDrive,
          item: itemIds.procedure,
          version: "1.0",
        })
      )
    ).resolves.toMatchObject({ error: { code: "too_large" } });
    expect(graphPaths()).not.toContain(
      `${drivePath}/items/${itemIds.procedure}/versions/1.0/content`
    );
  });

  it("read an older version of a file, to compare it with the current one", async () => {
    const connection = await connected();
    const procedure = { drive: financeDrive, item: itemIds.procedure };
    const [current, older] = await Promise.all([
      outputOf(call(connection, "files.read", procedure)),
      outputOf(
        call(connection, "files.read", { ...procedure, version: "1.0" })
      ),
    ]);
    expect([current, older]).toMatchObject([
      { version: null, content: procedureTexts["3.0"] },
      {
        id: itemIds.procedure,
        name: "Advice procedure.txt",
        version: "1.0",
        size: versionSize("1.0"),
        content: procedureTexts["1.0"],
      },
    ]);
    const versionPath = `${drivePath}/items/${itemIds.procedure}/versions/1.0`;
    expect(graphPaths()).toContain(`${versionPath}/content`);
    const download = graph.sent.find(({ path }) =>
      path.includes("/_vti_history/")
    );
    expect(download?.host).toBe(graph.sharePointHost);
    expect(download?.headers).not.toHaveProperty("authorization");
    // A version the file doesn't have is Graph's to refuse.
    await expect(
      toolError(
        call(connection, "files.read", { ...procedure, version: "9.0" })
      )
    ).resolves.toMatchObject({ error: { code: "not_found" } });
  });

  it("give no versions of a file the person may not open, of a folder or of another drive's file", async () => {
    const connection = await connected();
    const refusals = await Promise.all(
      (
        [
          ["files.versions", { item: itemIds.locked }],
          ["files.read", { item: itemIds.locked, version: "1.0" }],
          ["files.versions", { item: itemIds.folder }],
          ["files.versions", { item: itemIds.foreign }],
        ] satisfies [string, Input][]
      ).map(
        async ([tool, input]) =>
          await toolError(
            call(connection, tool, { drive: financeDrive, ...input })
          )
      )
    );
    expect(refusals).toMatchObject([
      { error: { code: "access_denied" } },
      { error: { code: "access_denied" } },
      { error: { code: "not_a_file" } },
      { error: { code: "not_found" } },
    ]);
    // Each was refused on the file itself, before its versions were asked for.
    expect(
      graphPaths().filter((path) => path.includes("/versions"))
    ).toStrictEqual([]);
  });

  it("follow a download's redirect only to SharePoint over HTTPS, once", async () => {
    const connection = await connected();
    const outcomes = await Promise.all(
      [itemIds.elsewhere, itemIds.plain, itemIds.nested, itemIds.twice].map(
        async (item) =>
          await toolError(
            call(connection, "files.read", { drive: financeDrive, item })
          )
      )
    );
    // The egress withholds each answer, and says so.
    expect(outcomes).toMatchObject(
      Array.from({ length: 4 }, () => ({ error: { code: "egress_failed" } }))
    );
    // Only the one redirect to SharePoint itself was followed; its own
    // redirect was not.
    expect(
      graph.sent
        .map(({ host }) => host)
        .filter((host) => host !== "graph.microsoft.com")
    ).toStrictEqual([graph.sharePointHost]);
  });
});

describe("the Microsoft 365 connector's list tools", () => {
  const contracts = { site: financeSite, list: contractsList };

  it("read the items of a list that meet every condition, with only their own columns", async () => {
    const connection = await connected();
    const result = await resultOf(
      call(connection, "lists.items", {
        ...contracts,
        where: [
          { column: "Supplier", is: "eq", value: "O'Brien & Sons" },
          { column: "Amount", is: "ge", value: 5000 },
        ],
      })
    );
    // Items 3, 7, 11... are O'Brien's; from 20 on they're worth 5,000.
    const ids = Array.from({ length: contractCount }, (_, index) => index + 1)
      .filter((n) => n % 4 === 3 && n >= 20)
      .map(String);
    expect(result.provenance).toStrictEqual(ids);
    expect(result.output).toMatchObject({
      site: financeSite,
      list: contractsList,
      nextPage: null,
    });
    expect(
      z
        .object({ items: z.array(z.unknown()) })
        .parse(result.output)
        .items.at(0)
    ).toStrictEqual({
      id: "23",
      fields: {
        id: "23",
        Title: "Contract 23",
        Supplier: "O'Brien & Sons",
        Status: "Open",
        Amount: 5750,
        Renewal_x0020_date: "2027-06-01T00:00:00Z",
        _x0032_nd_x0020_signatory: "Legal",
        Regions: ["EU", "UK"],
        Website: JSON.stringify({
          Description: "Supplier portal",
          Url: "https://suppliers.example.com/23",
        }),
        Modified: "2026-06-13T09:30:00Z",
        Created: "2026-01-05T08:00:00Z",
        AuthorLookupId: "11",
        EditorLookupId: "11",
        Attachments: false,
      },
      createdAt: "2026-01-05T08:00:00Z",
      lastModifiedAt: "2026-06-13T09:30:00Z",
      webUrl: `https://${graph.sharePointHost}/sites/Finance/Lists/Contracts/23_.000`,
    });
    // The filter is built from the conditions, its quote doubled as OData
    // does, and Graph is told it may filter on columns that aren't indexed.
    const [sent] = requests();
    expect(sent).toMatchObject({
      path: `/v1.0/sites/${encodeURIComponent(financeSite)}/lists/${contractsList}/items`,
      query: {
        $filter:
          "fields/Supplier eq 'O''Brien & Sons' and fields/Amount ge 5000",
      },
    });
    expect(graph.sent[0]?.headers).toMatchObject({
      prefer: "HonorNonIndexedQueriesWarningMayFailRandomly",
    });
  });

  it("read only the columns asked for, one of SharePoint's own too", async () => {
    const connection = await connected();
    const output = await outputOf(
      call(connection, "lists.items", {
        ...contracts,
        columns: ["Title", "Status", "ContentType"],
        top: 1,
      })
    );
    expect(output).toMatchObject({
      items: [
        {
          id: "1",
          fields: {
            id: "1",
            Title: "Contract 1",
            Status: "Open",
            ContentType: "Item",
          },
        },
      ],
    });
    expect(requests()[0]?.query).toMatchObject({
      $expand: "fields($select=Title,Status,ContentType)",
    });
  });

  it("take no condition that could be anything but a literal on a column", async () => {
    const connection = await connected();
    const refusals = await Promise.all(
      [
        { column: "Status eq 'Open' or Amount", is: "gt", value: 0 },
        { column: "Status", is: "eq or", value: "Open" },
      ].map(
        async (condition) =>
          await toolError(
            call(connection, "lists.items", {
              ...contracts,
              where: [condition],
            })
          )
      )
    );
    expect(refusals).toStrictEqual([
      "Invalid input: invalid_format at where.0.column",
      "Invalid input: invalid_value at where.0.is",
    ]);
    expect(graph.sent).toStrictEqual([]);
  });

  it("refuse a list in a site the person can't open, as Graph does", async () => {
    const connection = await connected();
    await expect(
      toolError(
        call(
          connection,
          "lists.items",
          { site: hrSite, list: contractsList },
          { resource: hrSite }
        )
      )
    ).resolves.toMatchObject({ error: { code: "access_denied" } });
  });

  it("cut a long list at its bound, and go on from there page by page", async () => {
    const connection = await connected();
    const pageSchema = z.object({
      items: z.array(z.object({ id: z.string() })),
      nextPage: z.string().nullable(),
    });
    const first = pageSchema.parse(
      await outputOf(call(connection, "lists.items", contracts))
    );
    expect({
      read: first.items.length,
      nextPage: first.nextPage,
    }).toStrictEqual({
      read: 50,
      nextPage: `%24skiptoken=${encodeURIComponent("Paged=TRUE&p_ID=50")}`,
    });
    const second = pageSchema.parse(
      await outputOf(
        call(connection, "lists.items", {
          ...contracts,
          page: first.nextPage ?? "",
        })
      )
    );
    // The rest, from where the first page ended.
    expect({
      read: second.items.map(({ id }) => Number(id)),
      nextPage: second.nextPage,
    }).toStrictEqual({
      read: Array.from(
        { length: contractCount - 50 },
        (_, index) => index + 51
      ),
      nextPage: null,
    });
    // Never more than a page's bound, whatever is asked.
    await expect(
      toolError(call(connection, "lists.items", { ...contracts, top: 500 }))
    ).resolves.toBe("Invalid input: too_big at top");
    expect(requests().map(({ query }) => query.$top)).toStrictEqual([
      "50",
      "50",
    ]);
  });
});

describe("the Microsoft 365 connector's list pages", () => {
  const contracts = { site: financeSite, list: contractsList };

  it("keep a page's conditions and columns on the next page", async () => {
    const connection = await connected();
    const asked = {
      ...contracts,
      where: [{ column: "Status", is: "eq", value: "Open" }],
      columns: ["Title", "Status"],
      top: 10,
    };
    const pageSchema = z.object({
      items: z.array(
        z.object({ id: z.string(), fields: z.record(z.string(), z.unknown()) })
      ),
      nextPage: z.string().nullable(),
    });
    const first = pageSchema.parse(
      await outputOf(call(connection, "lists.items", asked))
    );
    const second = pageSchema.parse(
      await outputOf(
        call(connection, "lists.items", {
          ...asked,
          page: first.nextPage ?? "",
        })
      )
    );
    const items = [...first.items, ...second.items];
    // Open contracts are those whose number isn't a multiple of 3.
    const open = Array.from({ length: contractCount }, (_, index) => index + 1)
      .filter((n) => n % 3 !== 0)
      .slice(0, 20)
      .map(String);
    expect({
      ids: items.map(({ id }) => id),
      columns: [
        ...new Set(items.flatMap(({ fields }) => Object.keys(fields))),
      ].toSorted(),
      statuses: [...new Set(items.map(({ fields }) => fields.Status))],
    }).toStrictEqual({
      ids: open,
      columns: ["Status", "Title", "id"],
      statuses: ["Open"],
    });
    const [, again] = requests();
    expect(again?.query).toMatchObject({
      $filter: "fields/Status eq 'Open'",
      $expand: "fields($select=Title,Status)",
      $top: "10",
    });
  });
});

// Excel registers, as company records: the ways it can fail come first. A
// call for one register reaches another (scoping, above), or a named
// range that points at any sheet; a change lands on a row that moved or
// changed since it was read; a cell from an email runs as a formula; a
// formula's value, as a row reads it, is written back over it; a day
// is written as a number nobody can read; a change leaves no record of
// what the row held; a lost answer makes it run twice.
describe("the Microsoft 365 connector's Excel tools", () => {
  const { register } = workbookIds;
  const tablePath = `${drivePath}/items/${register}/workbook/tables/${supplierTable}`;

  /** A call of `action` on the register, in a workflow run. */
  const onRegister = async (
    connection: Connection,
    action: string,
    input: Input,
    idempotencyKey?: string
  ) =>
    await call(
      connection,
      action,
      { ...supplierTableOf, workbook: register, ...input },
      { resource: register, idempotencyKey }
    );

  /** The requests that reached Graph with `method`. */
  const sentAs = (method: string): number =>
    requests().filter((request) => request.method === method).length;

  /** The register's supplier rows as Excel holds them, each cell's value. */
  const valuesHeld = () =>
    graph
      .supplierRowsOf(register)
      .map((row) => row.map(({ value, format }) => ({ value, format })));

  it("list a named table's rows under its columns, a day as its date, page by page", async () => {
    const connection = await connected();
    await expect(
      resultOf(onRegister(connection, "excel.listRows", { top: 1 }))
    ).resolves.toStrictEqual({
      output: {
        drive: financeDrive,
        workbook: register,
        table: supplierTable,
        columns: supplierColumns,
        rows: [{ row: 0, values: northwind }],
        nextStart: 1,
      },
      provenance: [register],
    });
    await expect(
      outputOf(onRegister(connection, "excel.listRows", { start: 1 }))
    ).resolves.toMatchObject({
      rows: [{ row: 1, values: contoso }],
      nextStart: null,
    });
    // Only the named table, never a sheet or a range of one.
    expect(new Set(graphPaths())).toStrictEqual(
      new Set([`${tablePath}/headerRowRange`, `${tablePath}/dataBodyRange`])
    );
  });

  it("reach only a named table: never a named range, a table the workbook doesn't have, or another name for one", async () => {
    const connection = await connected();
    const list = async (table: string) =>
      await call(
        connection,
        "excel.listRows",
        { drive: financeDrive, workbook: register, table },
        { resource: register }
      );
    const notTables = await Promise.all(
      [totalsRange, "Invoices"].map(
        async (table) => await toolError(list(table))
      )
    );
    expect(notTables).toMatchObject([
      { error: { code: "not_found" } },
      { error: { code: "not_found" } },
    ]);
    // A range's address, a table's ID or a sheet: refused before anything
    // goes out.
    const sent = graph.sent.length;
    const others = await Promise.all(
      [
        "Suppliers!A1:D3",
        "{2C0F9E1A-7A39-4E8B-9C1D-0E5F6A7B8C9D}",
        "Sheet1/range",
      ].map(async (table) => await outcome(list(table)))
    );
    expect({ others: new Set(others), sent: graph.sent.length }).toStrictEqual({
      others: new Set(["connect.action_failed"]),
      sent,
    });
  });

  it("add a row at the end of a named table once for its key, a day stored as a date, never its serial number", async () => {
    const connection = await connected();
    const add = async () =>
      await outputOf(
        onRegister(
          connection,
          "excel.addRow",
          { values: fabrikam },
          "run-3:add"
        )
      );
    const added = await add();
    expect(added).toStrictEqual({
      drive: financeDrive,
      workbook: register,
      table: supplierTable,
      row: 2,
      values: fabrikam,
    });
    // Excel holds the day as a date: its serial number, shown as a date.
    expect(valuesHeld()[2]).toStrictEqual([
      { value: "Fabrikam Metals", format: "General" },
      { value: "NL55INGB0001234567", format: "General" },
      { value: 46_316, format: "yyyy-mm-dd" },
      { value: "", format: "General" },
    ]);
    await expect(
      outputOf(onRegister(connection, "excel.listRows", { start: 2 }))
    ).resolves.toMatchObject({ rows: [{ row: 2, values: fabrikam }] });
    // The same call again, under its key, adds nothing.
    await expect(add()).resolves.toStrictEqual(added);
    expect({ rows: valuesHeld().length, posts: sentAs("POST") }).toStrictEqual({
      rows: 3,
      posts: 1,
    });
  });

  it("refuse a row that doesn't give each of the table's columns once", async () => {
    const connection = await connected();
    const outcomes = await Promise.all(
      [
        fabrikam.slice(1),
        [...fabrikam, { column: "Notes", value: "New" }],
        [...fabrikam.slice(1), ...fabrikam.slice(1, 2)],
      ].map(
        async (values) =>
          await toolError(
            onRegister(
              connection,
              "excel.addRow",
              { values },
              crypto.randomUUID()
            )
          )
      )
    );
    expect(outcomes).toMatchObject([
      { error: { code: "invalid" } },
      { error: { code: "invalid" } },
      { error: { code: "invalid" } },
    ]);
    expect(sentAs("POST")).toBe(0);
  });

  it("refuse text that would run as a formula, and a formula its person didn't confirm", async () => {
    const connection = await connected();
    const supplierNamed = (value: Input[string]) =>
      fabrikam.map((cell) =>
        cell.column === "Supplier" ? { ...cell, value } : cell
      );
    const refused = await Promise.all(
      [
        '=HYPERLINK("https://pay.example.net","Pay now")',
        "@SUM(A1:A9)",
        "+cmd",
        "-Contoso",
        { formula: "=SUM(1,2)" },
      ].map(
        async (value) =>
          await toolError(
            onRegister(
              connection,
              "excel.addRow",
              { values: supplierNamed(value) },
              crypto.randomUUID()
            )
          )
      )
    );
    expect(refused).toMatchObject(
      Array.from({ length: 5 }, () => ({ error: { code: "invalid" } }))
    );
    expect(sentAs("POST")).toBe(0);
    // A minus before a number is a number, as Excel takes it.
    await expect(
      outputOf(
        onRegister(
          connection,
          "excel.addRow",
          { values: withAmount(fabrikam, "-12.5") },
          "run-3:credit"
        )
      )
    ).resolves.toMatchObject({ values: withAmount(fabrikam, -12.5) });
  });

  it("change a row only while it holds what was read, keeping its old and new values for audit", async () => {
    const connection = await connected();
    const update = async (before: SupplierRow, amount: number, key: string) =>
      await onRegister(
        connection,
        "excel.updateRow",
        { row: 0, before, after: withAmount(northwind, amount) },
        key
      );
    await expect(
      outputOf(update(northwind, 1350, "run-4:raise"))
    ).resolves.toStrictEqual({
      drive: financeDrive,
      workbook: register,
      table: supplierTable,
      row: 0,
      before: northwind,
      after: withAmount(northwind, 1350),
    });
    // The old and new values are kept, and the call's audit event vouches
    // for them by their hash.
    const kept = await drizzle(env.DB)
      .select()
      .from(callChanges)
      .where(eq(callChanges.connectionId, connection.id));
    const [change] = kept;
    const text = change?.change ?? "";
    const values: unknown = JSON.parse(text);
    expect({
      kept: kept.length,
      change: values,
      hash: change?.hash,
    }).toStrictEqual({
      kept: 1,
      change: { before: northwind, after: withAmount(northwind, 1350) },
      hash: await sha256Hex(text),
    });
    const events = await audit.events();
    expect(
      events.find(({ action }) => action === "connection.call")
    ).toMatchObject({
      requestId: change?.requestId,
      detail: { action: "excel.updateRow", changeHash: change?.hash },
    });
    // A change made from what the row held before is refused, unwritten.
    await expect(
      toolError(update(northwind, 999, "run-4:stale"))
    ).resolves.toMatchObject({ error: { code: "conflict" } });
    // One asking for what the row already holds writes nothing, and keeps
    // no change: the `before` it names was never seen in the row.
    const again = await outputOf(
      update(withAmount(northwind, 5), 1350, "run-4:again")
    );
    const keptAfter = await drizzle(env.DB)
      .select()
      .from(callChanges)
      .where(eq(callChanges.connectionId, connection.id));
    expect({
      amount: valuesHeld()[0]?.[3]?.value,
      again,
      kept: keptAfter.length,
      patches: sentAs("PATCH"),
    }).toStrictEqual({
      amount: 1350,
      again: {
        drive: financeDrive,
        workbook: register,
        table: supplierTable,
        row: 0,
        before: withAmount(northwind, 5),
        after: withAmount(northwind, 1350),
      },
      kept: 1,
      patches: 1,
    });
  });

  it("refuse a change whose read cell has since changed type, though it reads the same", async () => {
    const connection = await connected();
    // Read as text "1200", it now holds the number 1200.
    await expect(
      toolError(
        onRegister(
          connection,
          "excel.updateRow",
          {
            row: 0,
            before: withAmount(northwind, "1200"),
            after: withAmount(northwind, 1350),
          },
          "run-7:typed"
        )
      )
    ).resolves.toMatchObject({ error: { code: "conflict" } });
    expect(sentAs("PATCH")).toBe(0);
  });

  it("recover a change that empties a cell, finding the row as it was asked to stand", async () => {
    const connection = await connected();
    const iban = "NL20INGB0001234567";
    const update = async () =>
      await onRegister(
        connection,
        "excel.updateRow",
        {
          row: 0,
          before: northwind,
          after: withIban(withAmount(northwind, ""), iban),
        },
        "run-7:clear"
      );
    graph.loseWriteAnswer();
    await expect(outcome(update())).resolves.toBe("connect.outcome_unknown");
    await claimedAgo(connection);
    await expect(outputOf(update())).resolves.toMatchObject({
      after: withIban(withAmount(northwind, null), iban),
    });
    expect(sentAs("PATCH")).toBe(1);
  });

  it("never write a formula's value over it: a change keeps the formula a cell holds, unconfirmed, or is refused", async () => {
    const connection = await connected();
    graph.typeFormula(register, {
      row: 0,
      column: 3,
      formula: "=1200*1.1",
      value: 1320,
    });
    // The row reads the formula's cell as its value.
    const read = withAmount(northwind, 1320);
    await expect(
      outputOf(onRegister(connection, "excel.listRows", { top: 1 }))
    ).resolves.toMatchObject({ rows: [{ row: 0, values: read }] });
    const change = async (after: SupplierRow, key: string) =>
      await onRegister(
        connection,
        "excel.updateRow",
        { row: 0, before: read, after },
        key
      );
    const iban = "NL20INGB0001234567";
    // Given back as that value, it would be written over the formula.
    await expect(
      toolError(change(withIban(read, iban), "run-6:iban"))
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    // Given as the formula the cell holds, a run writes the row without
    // its person confirming it again.
    const kept = withIban(
      withAmount(northwind, { formula: "=1200*1.1" }),
      iban
    );
    await expect(
      outputOf(change(kept, "run-6:iban-kept"))
    ).resolves.toMatchObject({ after: kept });
    const [first] = graph.supplierRowsOf(register);
    expect({
      iban: first?.[1]?.value,
      amount: first?.[3]?.formula,
      patches: sentAs("PATCH"),
    }).toStrictEqual({ iban, amount: "=1200*1.1", patches: 1 });
  });

  it("recover a row change whose answer was lost by finding it written, never writing twice; an added row's stays unknown", async () => {
    const connection = await connected();
    const update = async () =>
      await onRegister(
        connection,
        "excel.updateRow",
        { row: 0, before: northwind, after: withAmount(northwind, 1350) },
        "run-5:raise"
      );
    graph.loseWriteAnswer();
    await expect(outcome(update())).resolves.toBe("connect.outcome_unknown");
    // Once its claim has timed out, the same call recovers it: the row
    // already stands as asked, and nothing is written again.
    await claimedAgo(connection);
    await expect(outputOf(update())).resolves.toMatchObject({
      after: withAmount(northwind, 1350),
    });
    // An added row carries nothing to find it by: it stays unknown.
    const add = async () =>
      await outcome(
        onRegister(
          connection,
          "excel.addRow",
          { values: fabrikam },
          "run-5:add"
        )
      );
    graph.loseWriteAnswer();
    const first = await add();
    await claimedAgo(connection);
    expect([first, await add()]).toStrictEqual([
      "connect.outcome_unknown",
      "connect.outcome_unknown",
    ]);
    expect({
      patches: sentAs("PATCH"),
      posts: sentAs("POST"),
      done: graph.writesDone(),
      rows: valuesHeld().length,
    }).toStrictEqual({ patches: 1, posts: 1, done: 2, rows: 3 });
  });

  it("hold a row change from chat on a card with its old and new values, and write it, a formula too, once its person confirms", async () => {
    const connection = await connected();
    const { person } = connection;
    const chat = agentFor(person.userId, "agent-chat", "interactive");
    const after = withAmount(northwind, { formula: "=1200*1.1" });
    const asked = await callAs(
      chat,
      {
        connectionId: connection.id,
        resource: register,
        action: "excel.updateRow",
        input: {
          ...supplierTableOf,
          workbook: register,
          row: 0,
          before: northwind,
          after,
        },
        idempotencyKey: `chat-1:${crypto.randomUUID()}`,
      },
      { origin: chatOrigin }
    );
    const waiting: PendingAction[] =
      await exports.default.listPendingActions(person);
    expect({
      held: asked.pending?.id,
      sent: graph.sent.length,
      descriptions: waiting.map(({ id, description }) => ({ id, description })),
    }).toStrictEqual({
      held: waiting[0]?.id,
      sent: 0,
      descriptions: [
        {
          id: asked.pending?.id,
          description: {
            title: "Change a row of an Excel table",
            fields: [
              { input: "drive", label: "Drive", value: financeDrive },
              { input: "workbook", label: "Workbook", value: register },
              { input: "table", label: "Table", value: supplierTable },
              { input: "row", label: "Row", value: "0" },
              {
                input: "before",
                label: "Now",
                value: JSON.stringify(northwind, null, 2),
              },
              {
                input: "after",
                label: "Will be",
                value: JSON.stringify(after, null, 2),
              },
            ],
            complete: true,
          },
        },
      ],
    });
    const [held] = waiting;
    if (held === undefined) {
      throw new Error("Expected the held change");
    }
    const confirm = async () =>
      await exports.default.confirmAction({
        person,
        id: held.id,
        inputHash: held.inputHash,
        capability: await signCapability(env.CAPABILITY_SIGNING_KEY, chat, {
          connectionId: connection.id,
          resource: register,
          action: held.action,
          idempotencyKey: held.idempotencyKey,
          origin: chatOrigin,
          decision: { kind: "confirm", pendingActionId: held.id },
        }),
      });
    await expect(outputOf(confirm())).resolves.toMatchObject({
      before: northwind,
      after,
    });
    await expect(outcome(confirm())).resolves.not.toBe("ok");
    // The formula its person confirmed is the cell's, written once.
    expect({
      amount: graph.supplierRowsOf(register)[0]?.[3]?.formula,
      patches: sentAs("PATCH"),
    }).toStrictEqual({ amount: "=1200*1.1", patches: 1 });
  });
});

/** Lets the connection's access token run out, so its next call renews it. */
const expire = async (connection: Connection): Promise<void> => {
  await drizzle(env.DB)
    .update(connectionTokens)
    .set({ accessExpiresAt: new Date(0) })
    .where(eq(connectionTokens.connectionId, connection.id));
};

/** The connection's status. */
const statusOf = async (connection: Connection) => {
  const row = await drizzle(env.DB)
    .select({ status: connections.status })
    .from(connections)
    .where(eq(connections.id, connection.id))
    .get();
  return row?.status;
};

describe("the Microsoft 365 connector's right to change files", () => {
  /** What Entra granted a connection made before workbooks were written. */
  const grantedBefore =
    "openid profile email User.Read Mail.ReadWrite Mail.ReadWrite.Shared Mail.Send Mail.Send.Shared Calendars.Read Calendars.Read.Shared Files.Read.All Sites.Read.All";

  const list = async (connection: Connection) =>
    await call(
      connection,
      "excel.listRows",
      { ...supplierTableOf, workbook: workbookIds.register },
      { resource: workbookIds.register }
    );

  it("keeps a connection whose renewal holds it, by Graph's full name too", async () => {
    const connection = await connected();
    providers.state.refreshGranted = `${grantedBefore} https://graph.microsoft.com/Files.ReadWrite.All`;
    await expire(connection);
    await expect(outcome(list(connection))).resolves.toBe("ok");
    await expect(statusOf(connection)).resolves.toBe("active");
  });

  it("marks a connection made without it for reconnecting, which gives it back in place", async () => {
    const connection = await connected();
    providers.state.refreshGranted = grantedBefore;
    await expire(connection);
    await expect(outcome(list(connection))).resolves.toBe(
      "connect.connection_inactive"
    );
    const events = await audit.events();
    expect({
      sent: graph.sent.length,
      status: await statusOf(connection),
      marked: events
        .filter(({ action }) => action === "connection.needs_reauth")
        .map(({ detail }) => detail),
    }).toStrictEqual({
      sent: 0,
      status: "needs_reauth",
      marked: [{ provider: "microsoft", reason: "scopes_missing" }],
    });
    // Its person connects again, consenting to the right: the same
    // connection, so every permission on it stands.
    providers.state.refreshGranted = undefined;
    await expect(
      connectAccount(
        providers,
        connection.person,
        ownAccount(connection.person)
      )
    ).resolves.toBe(connection.id);
    await expect(outcome(list(connection))).resolves.toBe("ok");
  });
});

/** The person's own mailbox, as their To Do is named. */
const ownMailbox = ({ person }: Connection): string => person.email;

/** The id of the task a To Do tool answered with. */
const taskIdOf = (created: unknown): string =>
  z.object({ task: z.object({ id: z.string() }) }).parse(created).task.id;

describe("the Microsoft 365 connector's To Do tools", () => {
  /** Calls `action` for the person's own To Do. */
  const todo = async (
    connection: Connection,
    action: string,
    input: Input,
    idempotencyKey?: string
  ) =>
    await outputOf(
      call(
        connection,
        action,
        { mailbox: ownMailbox(connection), ...input },
        {
          resource: ownMailbox(connection),
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        }
      )
    );

  const followUp = {
    list: todoListIds.tasks,
    title: "Send Northwind the signed contract",
    note: "Promised in Tuesday's call.",
    due: "2026-10-30",
  };

  it("list only the person's own To Do lists", async () => {
    const connection = await connected();
    // Only the list that is theirs alone: neither the one they shared nor
    // the one shared with them.
    await expect(todo(connection, "todo.lists", {})).resolves.toStrictEqual({
      mailbox: ownMailbox(connection),
      lists: [
        { id: todoListIds.tasks, name: "Tasks", wellknownName: "defaultList" },
      ],
      nextPage: null,
    });
  });

  it("make a task in the person's own list with its due day, and complete it", async () => {
    const connection = await connected();
    const created = await todo(
      connection,
      "todo.create",
      followUp,
      "run-3:follow-up"
    );
    expect(created).toMatchObject({
      mailbox: ownMailbox(connection),
      listId: todoListIds.tasks,
      task: {
        title: followUp.title,
        status: "notStarted",
        due: { dateTime: "2026-10-30T12:00:00", timeZone: "UTC" },
        completedAt: null,
      },
    });
    const id = taskIdOf(created);
    const open = { list: todoListIds.tasks, openOnly: true };
    await expect(todo(connection, "todo.tasks", open)).resolves.toMatchObject({
      tasks: [{ id, title: followUp.title }],
    });
    await expect(
      todo(
        connection,
        "todo.complete",
        { list: todoListIds.tasks, task: id },
        "run-3:done"
      )
    ).resolves.toMatchObject({
      task: { id, status: "completed", completedAt: { timeZone: "UTC" } },
    });
    await expect(todo(connection, "todo.tasks", open)).resolves.toMatchObject({
      tasks: [],
    });
    await expect(
      todo(connection, "todo.tasks", { list: todoListIds.tasks })
    ).resolves.toMatchObject({ tasks: [{ id, status: "completed" }] });
  });

  it("refuse another person's To Do, and lists shared with or by the person", async () => {
    const connection = await connected();
    // A capability for a colleague's mailbox: Graph opens no To Do but the
    // token's own user's.
    await expect(
      toolError(
        call(connection, "todo.lists", { mailbox: ceo }, { resource: ceo })
      )
    ).resolves.toMatchObject({ error: { code: "access_denied" } });
    await expect(
      toolError(
        call(
          connection,
          "todo.create",
          { ...followUp, mailbox: ceo },
          { resource: ceo, idempotencyKey: "run-4:theirs" }
        )
      )
    ).resolves.toMatchObject({ error: { code: "access_denied" } });
    // A list shared either way reaches someone else: nothing is read,
    // made or completed in it.
    const calls: [string, Input][] = [
      todoListIds.sharedWithThem,
      todoListIds.sharedByThem,
    ].flatMap((list): [string, Input][] => [
      ["todo.tasks", { list }],
      ["todo.create", { ...followUp, list }],
      ["todo.complete", { list, task: "AAkALgAAAAAAHYQDEapmEc2b=" }],
    ]);
    const refusals = await Promise.all(
      calls.map(
        async ([action, input]) =>
          await toolError(
            call(
              connection,
              action,
              { mailbox: ownMailbox(connection), ...input },
              {
                resource: ownMailbox(connection),
                idempotencyKey: crypto.randomUUID(),
              }
            )
          )
      )
    );
    expect(refusals).toMatchObject(
      calls.map(() => ({ error: { code: "access_denied" } }))
    );
    expect(graph.writesDone()).toBe(0);
  });

  it("find a task whose answer was lost by the tag it carries, and never make it twice", async () => {
    const connection = await connected();
    // Older tasks fill Graph's first page, so the lost one is on a later
    // page.
    await Promise.all(
      ["one", "two", "three"].map(
        async (n) =>
          await todo(
            connection,
            "todo.create",
            { ...followUp, title: `Earlier follow-up ${n}` },
            `run-5:earlier-${n}`
          )
      )
    );
    graph.loseWriteAnswer();
    await expect(
      outcome(
        call(
          connection,
          "todo.create",
          { mailbox: ownMailbox(connection), ...followUp },
          {
            resource: ownMailbox(connection),
            idempotencyKey: "run-5:follow-up",
          }
        )
      )
    ).resolves.toBe("connect.outcome_unknown");
    await claimedAgo(connection);
    const found = await todo(
      connection,
      "todo.create",
      followUp,
      "run-5:follow-up"
    );
    await expect(
      todo(connection, "todo.create", followUp, "run-5:follow-up")
    ).resolves.toStrictEqual(found);
    expect(found).toMatchObject({ task: { title: followUp.title } });
    // The three earlier tasks and the lost one, each made once.
    expect(graph.writesDone()).toBe(4);
    const { tasks } = z
      .object({
        tasks: z.array(z.object({ id: z.string(), title: z.string() })),
      })
      .parse(await todo(connection, "todo.tasks", { list: todoListIds.tasks }));
    expect(
      tasks.filter(({ title }) => title === followUp.title).map(({ id }) => id)
    ).toStrictEqual([taskIdOf(found)]);
  });

  it("refuse a due day that doesn't exist before anything goes out", async () => {
    const connection = await connected();
    const sent = graph.sent.length;
    await expect(
      toolError(
        call(
          connection,
          "todo.create",
          { mailbox: ownMailbox(connection), ...followUp, due: "2026-02-30" },
          {
            resource: ownMailbox(connection),
            idempotencyKey: "run-7:follow-up",
          }
        )
      )
    ).resolves.toBe("Invalid input: custom at due");
    expect(graph.sent).toHaveLength(sent);
  });

  it("read no task of a list the person shared after its answer was lost", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await expect(
      outcome(
        call(
          connection,
          "todo.create",
          { mailbox: ownMailbox(connection), ...followUp },
          {
            resource: ownMailbox(connection),
            idempotencyKey: "run-6:follow-up",
          }
        )
      )
    ).resolves.toBe("connect.outcome_unknown");
    await claimedAgo(connection);
    graph.shareList(todoListIds.tasks);
    const tasksRead = () =>
      graphPaths().filter((path) => path.endsWith("/tasks")).length;
    const before = tasksRead();
    await expect(
      outcome(
        call(
          connection,
          "todo.create",
          { mailbox: ownMailbox(connection), ...followUp },
          {
            resource: ownMailbox(connection),
            idempotencyKey: "run-6:follow-up",
          }
        )
      )
    ).resolves.toBe("connect.outcome_unknown");
    // The list is no longer the person's alone: the task isn't looked for
    // in it, so the outcome stays unknown. Only the POST that made the task
    // went to its tasks, before the list was shared.
    expect(tasksRead()).toBe(before);
  });
});

describe("the Microsoft 365 connector's answers", () => {
  it("free a move's key when a lookup before it is throttled, so a retry moves once", async () => {
    const { connection, own } = await connectedOwn();
    const move = async () =>
      await outcome(
        call(
          connection,
          "mail.move",
          {
            mailbox: own,
            message: messageId(own, 1),
            destination: "archive",
          },
          { idempotencyKey: "run-8:move-lookup" }
        )
      );
    // The first request, the lookup, is throttled: nothing is moved.
    graph.throttle();
    const outcomes = [await move(), await move(), await move()];
    expect(outcomes).toStrictEqual(["connect.server_unavailable", "ok", "ok"]);
    expect(graph.writesDone()).toBe(1);
  });

  it("never take a provider's answer for connect's egress's own", async () => {
    const connection = await connected();
    // Graph's 404 carries `grasp-egress: refused`: the egress drops it,
    // and the connector reports Graph's answer.
    await expect(
      toolError(
        call(connection, "mail.get", { mailbox: invoices, message: spoofedId })
      )
    ).resolves.toMatchObject({ error: { code: "not_found" } });
  });

  it("free a throttled move's key after the lookups before it, reads", async () => {
    const { connection, own } = await connectedOwn();
    const move = async () =>
      await outcome(
        call(
          connection,
          "mail.move",
          {
            mailbox: own,
            message: messageId(own, 1),
            destination: "archive",
          },
          { idempotencyKey: "run-8:move" }
        )
      );
    graph.throttleWrite();
    const outcomes = [await move(), await move(), await move()];
    expect(outcomes).toStrictEqual(["connect.server_unavailable", "ok", "ok"]);
    expect(graph.writesDone()).toBe(1);
  });

  it("refuse a mailbox that is a dot segment before anything goes out", async () => {
    const connection = await connected();
    const outcomes = await Promise.all(
      [".", ".."].map(
        async (mailbox) =>
          await toolError(call(connection, "mail.list", { mailbox }))
      )
    );

    // Refused as input, naming the mailbox.
    expect(
      outcomes.map((refusal) => JSON.stringify(refusal).includes("mailbox"))
    ).toStrictEqual([true, true]);
    expect(graph.sent).toStrictEqual([]);
  });

  it("tell a request connect's egress refused from one Graph refused", async () => {
    const connection = await connected();
    // `..` is a Graph ID's alphabet, but a dot segment in a path: the
    // request that goes out isn't one of the tool's routes.
    await expect(
      toolError(
        call(connection, "mail.get", { mailbox: invoices, message: ".." })
      )
    ).resolves.toMatchObject({ error: { code: "egress_refused" } });
    expect(graph.sent).toStrictEqual([]);
  });
});

describe("the Microsoft 365 connector's writes whose outcome can't be confirmed", () => {
  const email = {
    mailbox: invoices,
    subject: "Payment of invoice 2026-0041",
    body: "Paid today.",
    to: ["billing@northwind.example.org"],
  };

  /** The write requests that reached Graph. */
  const writesSent = (): number =>
    requests().filter(({ method }) => method !== "GET").length;

  const draft = async (connection: Connection, key: string): Promise<string> =>
    await outcome(
      call(connection, "mail.createDraft", email, {
        resource: invoices,
        idempotencyKey: key,
      })
    );

  it("say an email Graph sent is of unknown outcome when its answer was lost, and never send it again", async () => {
    const connection = await connected();
    const send = async () =>
      await outcome(
        call(connection, "mail.send", email, {
          resource: invoices,
          idempotencyKey: "run-9:send-receipt",
        })
      );
    // Graph sends it; its answer never arrives.
    graph.loseWriteAnswer();
    const outcomes = [await send(), await send(), await send()];
    expect(outcomes).toStrictEqual([
      "connect.outcome_unknown",
      "connect.outcome_unknown",
      "connect.outcome_unknown",
    ]);
    expect(graph.writesDone()).toBe(1);
    expect(writesSent()).toBe(1);
    // Recorded as of unknown outcome, never as a failure a caller could
    // take for "nothing was sent"; the repeats as repeats, not sends.
    const audited = await audit.events();
    const details = audited
      .filter(({ action }) => action === "connection.call")
      .map(({ detail }) => detail);
    expect(details).toMatchObject([
      { outcome: "unknown", reason: "connect.outcome_unknown" },
      { outcome: "unknown", reason: "connect.outcome_unknown", replayed: true },
      { outcome: "unknown", reason: "connect.outcome_unknown", replayed: true },
    ]);
    expect(details[0]?.replayed).toBeUndefined();
  });

  it("say a write Graph answered with a server error is of unknown outcome, but one it refused failed", async () => {
    const connection = await connected();
    const outcomes: string[] = [];
    for (const status of [500, 502, 503, 504]) {
      graph.failWrite(status);
      // The same key twice: Graph fails the first write only.
      outcomes.push(
        // oxlint-disable-next-line no-await-in-loop -- one write failed at a time
        await draft(connection, `run-9:draft-${status}`),
        // oxlint-disable-next-line no-await-in-loop -- one write failed at a time
        await draft(connection, `run-9:draft-${status}`)
      );
    }
    // A refusal says nothing was made: the action failed, for good.
    graph.failWrite(400, { error: { code: "ErrorInvalidRecipients" } });
    outcomes.push(
      await draft(connection, "run-9:draft-400"),
      await draft(connection, "run-9:draft-400")
    );
    expect(outcomes).toStrictEqual([
      ...Array.from({ length: 8 }, () => "connect.outcome_unknown"),
      "connect.action_failed",
      "connect.action_failed",
    ]);
    // Each key reached Graph once.
    expect(writesSent()).toBe(5);
  });

  it("say a draft Graph made is of unknown outcome when its answer can't be read", async () => {
    const connection = await connected();
    // Graph made it, and its answer isn't a draft the connector can read.
    graph.failWrite(201, { value: "not a message" });
    await expect(draft(connection, "run-9:draft-unreadable")).resolves.toBe(
      "connect.outcome_unknown"
    );
    await expect(draft(connection, "run-9:draft-unreadable")).resolves.toBe(
      "connect.outcome_unknown"
    );
    expect(writesSent()).toBe(1);
  });
});

/** An hour of focus time in the person's own calendar, under `key`. */
const createFocusTime = async (connection: Connection, key: string) =>
  await createEvent(connection, focusTime(connection.person.email), key);

/** What a connection made before the connector wrote calendars holds. */
const readOnlyCalendars = [
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

const graphScope = /^[A-Z]/u;

/** Entra's `scope` for a grant of `scopes`, Graph's by their full URI. */
const grantOf = (scopes: readonly string[]): string =>
  scopes
    .map((scope) =>
      graphScope.test(scope) ? `https://graph.microsoft.com/${scope}` : scope
    )
    .join(" ");

/** Someone's connection whose grant Entra says holds `scopes`. */
const connectedWith = async (
  scopes: readonly string[]
): Promise<Connection> => {
  const person = someone();
  const id = await connectAccount(providers, person, {
    ...ownAccount(person),
    granted: grantOf(scopes),
  });
  return { id, person };
};

const accessDenied = { error: { code: "ErrorAccessDenied" } };

describe("the Microsoft 365 connector's calendar writes, when something goes wrong", () => {
  it("find an event whose answer was lost by its tag, and never make it twice", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await expect(
      outcome(createFocusTime(connection, "run-4:hold"))
    ).resolves.toBe("connect.outcome_unknown");
    await claimedAgo(connection);
    const found = await outputOf(createFocusTime(connection, "run-4:hold"));
    expect({
      found,
      writesDone: graph.writesDone(),
      lookups: requests()
        .filter(({ method }) => method === "GET")
        .map(({ path, headers }) => ({ path, prefer: headers.prefer })),
    }).toMatchObject({
      found: {
        event: {
          subject: "Focus time: Q4 forecast",
          start: {
            dateTime: "2026-10-26T14:00:00.0000000",
            timeZone: amsterdam,
          },
        },
      },
      writesDone: 1,
      lookups: [
        {
          path: `/v1.0/users/${encodeURIComponent(connection.person.email)}/events`,
          prefer: `outlook.timezone="${amsterdam}"`,
        },
      ],
    });
  });

  it("report a connection made before it could write calendars for reconnecting, in place, and go through once it is", async () => {
    const connection = await connectedWith(readOnlyCalendars);
    graph.failWrite(403, accessDenied);
    const refused = await outcome(createFocusTime(connection, "run-5:hold"));
    const status = await statusOf(connection);
    const audited = await audit.events();
    // The person reconnects, granting the new right: the same connection,
    // and the same call goes out under its key.
    const reconnected = await connectAccount(providers, connection.person, {
      ...ownAccount(connection.person),
      granted: grantOf([...readOnlyCalendars, "Calendars.ReadWrite"]),
    });
    const again = await outcome(createFocusTime(connection, "run-5:hold"));
    expect({
      refused,
      status,
      marked: audited
        .filter(({ action }) => action === "connection.needs_reauth")
        .map(({ detail }) => detail),
      sameConnection: reconnected === connection.id,
      again,
      writesDone: graph.writesDone(),
    }).toStrictEqual({
      refused: "connect.connection_inactive",
      status: "needs_reauth",
      marked: [{ provider: "microsoft", reason: "scopes_missing" }],
      sameConnection: true,
      again: "ok",
      writesDone: 1,
    });
  });

  it("let every call Graph refused before the connection was marked go through once it is reconnected", async () => {
    const connection = await connectedWith(readOnlyCalendars);
    // A second call is refused while the first's refusal is still on its
    // way: the second marks the connection, so the first finds it marked.
    let second = "";
    graph.failWrite(403, accessDenied, async () => {
      graph.failWrite(403, accessDenied);
      second = await outcome(createFocusTime(connection, "run-7:second"));
    });
    const first = await outcome(createFocusTime(connection, "run-7:first"));
    await connectAccount(providers, connection.person, {
      ...ownAccount(connection.person),
      granted: grantOf([...readOnlyCalendars, "Calendars.ReadWrite"]),
    });
    const again = [
      await outcome(createFocusTime(connection, "run-7:first")),
      await outcome(createFocusTime(connection, "run-7:second")),
    ];
    expect({
      first,
      second,
      again,
      writesDone: graph.writesDone(),
    }).toStrictEqual({
      first: "connect.connection_inactive",
      second: "connect.connection_inactive",
      again: ["ok", "ok"],
      writesDone: 2,
    });
  });

  it("keep a connection granted every right, or whose grant isn't known, when Graph refuses it a calendar", async () => {
    const granted = await connectedWith([
      ...readOnlyCalendars,
      "Calendars.ReadWrite",
      "Notes.ReadWrite",
    ]);
    // Tokens stored before connect kept their grant.
    const unknown = await connected();
    const outcomes: string[] = [];
    for (const connection of [granted, unknown]) {
      graph.failWrite(403, accessDenied);
      outcomes.push(
        // oxlint-disable-next-line no-await-in-loop -- one write failed at a time
        await outcome(createFocusTime(connection, "run-6:hold")),
        // oxlint-disable-next-line no-await-in-loop -- one write failed at a time
        (await statusOf(connection)) ?? "none"
      );
    }
    expect(outcomes).toStrictEqual([
      "connect.action_failed",
      "active",
      "connect.action_failed",
      "active",
    ]);
  });
});

/**
 * How a chat agent's list of `mailbox` ends, with `mailboxes` signed in
 * as pointed at for its person (src/mailboxes.ts).
 */
const listAs = async (
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

describe("a chat agent's Microsoft 365 mail call", () => {
  it("reaches its person's own mailbox, and a shared one only once pointed at for them", async () => {
    const connection = await connected();
    const ends = {
      own: await listAs(connection, connection.person.email.toUpperCase(), []),
      shared: await listAs(connection, invoices, []),
      anotherPointed: await listAs(connection, invoices, [ceo]),
    };
    const reachedShared = graphPaths().some((path) =>
      path.startsWith(mailboxPath)
    );
    expect({ ...ends, reachedShared }).toStrictEqual({
      own: "ok",
      shared: "connect.mailbox_not_pointed",
      anotherPointed: "connect.mailbox_not_pointed",
      reachedShared: false,
    });
    await expect(listAs(connection, invoices, [invoices])).resolves.toBe("ok");
  });

  it("takes a shared connection's own mailbox as the company's, which needs pointing at too", async () => {
    const admin = someone("admin");
    const account = mailboxAccount();
    const id = await connectAccount(providers, admin, account, {
      scope: "shared",
    });
    const connection = { id, person: admin };
    await expect(listAs(connection, account.email, [])).resolves.toBe(
      "connect.mailbox_not_pointed"
    );
    await expect(
      listAs(connection, account.email, [account.email])
    ).resolves.toBe("ok");
  });
});
