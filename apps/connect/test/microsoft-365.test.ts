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
  outcome,
  ownAccount,
  someone,
} from "./connect.ts";
import {
  archiveFolderId,
  attachmentsSkipToken,
  endlessAttachments,
  foreignFolderId,
  bigAttachmentId,
  childrenSkipToken,
  ceo,
  financeDrive,
  invoicePdf,
  invoices,
  itemAttachmentId,
  itemIds,
  messageId,
  movedId,
  eventId,
  pdfAttachmentId,
  pdfBase64,
  personalDrive,
  reportText,
  spoofedId,
  supplierColumns,
  supplierTable,
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
const graph = fakeGraph();
const audit = auditEvents();

/** Someone's Microsoft 365 connection, made through OAuth. */
const connected = async (): Promise<Connection> => {
  const person = someone();
  const id = await connectAccount(providers, person, ownAccount(person));
  return { id, person };
};

/** What left connect, each request with its query and JSON body parsed. */
const requests = () => parsedRequests(graph.sent);

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
  "mail.get": { message: messageId(ceo, 1) },
  "mail.readAttachment": {
    message: messageId(ceo, 1),
    attachment: pdfAttachmentId,
  },
  "mail.move": { message: messageId(ceo, 1), destination: "archive" },
  "mail.send": { subject: "Hi", body: "Hi", to: ["a@example.com"] },
  "mail.createDraft": { subject: "Hi", body: "Hi", to: ["a@example.com"] },
  "calendar.list": {
    start: "2026-09-28T00:00:00Z",
    end: "2026-10-05T00:00:00Z",
  },
  "calendar.get": { event: eventId(ceo, 1) },
};

/** Input for each file tool, but its drive. */
const driveInputs: Record<string, Input> = {
  "files.list": {},
  "files.search": { query: "invoice" },
  "files.read": { item: itemIds.report },
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

describe("the Microsoft 365 connector's scoping", () => {
  it("binds every route of every tool to its mailbox, drive or workbook's named table, never /me", () => {
    const unbound = Object.entries(manifest.actions).flatMap(
      ([name, { resource, routes }]) =>
        routes
          .filter(
            ({ path }) =>
              !(
                (resource === "mailbox" &&
                  path.startsWith("/v1.0/users/{mailbox}/")) ||
                (resource === "drive" &&
                  path.startsWith("/v1.0/drives/{drive}/")) ||
                (resource === "workbook" &&
                  path.startsWith(
                    "/v1.0/drives/{drive}/items/{workbook}/workbook/tables/{table}/"
                  ))
              )
          )
          .map(({ path }) => `${name} ${path}`)
    );
    expect(unbound).toStrictEqual([]);
    expect(
      Object.keys(manifest.actions).toSorted(),
      "every tool is tested for scoping below"
    ).toStrictEqual(
      [
        ...Object.keys(mailboxInputs),
        ...Object.keys(driveInputs),
        ...Object.keys(workbookInputs),
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

  it("move a message once for its idempotency key, to a folder of its own mailbox", async () => {
    const connection = await connected();
    const move = async (destination: string, idempotencyKey: string) =>
      await outputOf(
        call(
          connection,
          "mail.move",
          { mailbox: invoices, message: messageId(invoices, 1), destination },
          { resource: invoices, idempotencyKey }
        )
      );
    const first = await move("archive", "run-7:move-invoice");
    expect(first).toStrictEqual({
      mailbox: invoices,
      previousId: messageId(invoices, 1),
      id: movedId(invoices, 1),
      folderId: archiveFolderId,
    });
    await expect(move("archive", "run-7:move-invoice")).resolves.toStrictEqual(
      first
    );
    // The destination is looked up in the bound mailbox, and the message
    // moved to the folder it names there.
    expect(requests()).toMatchObject([
      { method: "GET", path: `${mailboxPath}/mailFolders/archive` },
      {
        method: "POST",
        path: `${mailboxPath}/messages/${encodeURIComponent(messageId(invoices, 1))}/move`,
        body: { destinationId: archiveFolderId },
      },
    ]);
    // Another mailbox's folder isn't one of this mailbox's: nothing moves.
    await expect(
      toolError(move(foreignFolderId, "run-7:move-away"))
    ).resolves.toMatchObject({ error: { code: "not_found" } });
    expect(requests().filter(({ method }) => method === "POST")).toHaveLength(
      1
    );
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

// Excel registers, as company records: the ways it can fail come first. A
// call for one register reaches another (scoping, above), or a named
// range that points at any sheet; a change lands on a row that moved or
// changed since it was read; a cell from an email runs as a formula; a day
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
    expect({
      amount: valuesHeld()[0]?.[3]?.value,
      patches: sentAs("PATCH"),
    }).toStrictEqual({ amount: 1350, patches: 1 });
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

describe("the Microsoft 365 connector's answers", () => {
  it("free a move's key when its folder lookup is throttled, so a retry moves once", async () => {
    const connection = await connected();
    const move = async () =>
      await outcome(
        call(
          connection,
          "mail.move",
          {
            mailbox: invoices,
            message: messageId(invoices, 1),
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

  it("free a throttled move's key after its folder lookup, a read", async () => {
    const connection = await connected();
    const move = async () =>
      await outcome(
        call(
          connection,
          "mail.move",
          {
            mailbox: invoices,
            message: messageId(invoices, 1),
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
