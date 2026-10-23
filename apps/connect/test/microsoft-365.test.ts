import { connectorManifestSchema } from "@grasp-os/connector-kit/manifest";
import { signCapability } from "@grasp-os/shared/capability";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { nativeConnector } from "../src/bundled-connectors.ts";
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
};

/** Input for each file tool, but its drive. */
const driveInputs: Record<string, Input> = {
  "files.list": {},
  "files.search": { query: "invoice" },
  "files.read": { item: itemIds.report },
};

describe("the Microsoft 365 connector's scoping", () => {
  it("binds every route of every tool to its mailbox or drive, never /me", () => {
    const unbound = Object.entries(manifest.actions).flatMap(
      ([name, { resource, routes }]) =>
        routes
          .filter(
            ({ path }) =>
              !(
                (resource === "mailbox" &&
                  path.startsWith("/v1.0/users/{mailbox}/")) ||
                (resource === "drive" &&
                  path.startsWith("/v1.0/drives/{drive}/"))
              )
          )
          .map(({ path }) => `${name} ${path}`)
    );
    expect(unbound).toStrictEqual([]);
    expect(
      Object.keys(manifest.actions).toSorted(),
      "every tool is tested for scoping below"
    ).toStrictEqual(
      [...Object.keys(mailboxInputs), ...Object.keys(driveInputs)].toSorted()
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

/** The organization's time zone, in the calendar writes below. */
const amsterdam = "Europe/Amsterdam";

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
  "Calendars.Read",
  "Calendars.Read.Shared",
  "Files.Read.All",
  "Sites.Read.All",
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

const statusOf = async ({ id }: Connection): Promise<string | undefined> => {
  const row = await env.DB.prepare(
    "SELECT status FROM connections WHERE id = ?"
  )
    .bind(id)
    .first<{ status: string }>();
  return row?.status;
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

  it("keep a connection granted every right, or whose grant isn't known, when Graph refuses it a calendar", async () => {
    const granted = await connectedWith([
      ...readOnlyCalendars,
      "Calendars.ReadWrite",
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
