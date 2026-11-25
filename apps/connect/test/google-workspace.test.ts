import { connectorManifestSchema } from "@grasp-os/runtime/connector";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { z } from "zod";

import { nativeConnector } from "../src/bundled-connectors.ts";
import { connections } from "../src/db/schema.ts";
import { accessTokenFor } from "../src/tokens.ts";
import {
  auditEvents,
  connectAccount,
  outcome,
  ownAccount,
  someone,
} from "./connect.ts";
import {
  cancelledOccurrenceId,
  ceo,
  detachedBody,
  docText,
  draftId,
  eventId,
  eventPageToken,
  fileIds,
  filePageToken,
  financeDrive,
  holidayCalendar,
  htmlBody,
  incompleteEventId,
  invoices,
  messageId,
  messagePageToken,
  otherDrive,
  partIds,
  plainBody,
  reportText,
  sentId,
  sheetCsv,
  sheetGrid,
  sheetNames,
  signaturePng,
  teamCalendar,
  threadId,
} from "./fixtures/google.ts";
import { base64, invoicePdf, pdfBase64 } from "./fixtures/graph.ts";
import {
  deletedMessageId,
  fakeGoogle,
  spoofedMessageId,
} from "./google-api.ts";
import { fakeProviders } from "./oauth-provider.ts";
import {
  callTool as call,
  claimedAgo,
  outputOf,
  parsedRequests,
  refusalsFor,
  resultOf,
  retryable,
  toolError,
} from "./tool-calls.ts";
import type { Connection, Input } from "./tool-calls.ts";

// The Google Workspace connector against Google's recorded answers,
// through connect's real call path: capability, policy, a fresh isolate,
// the egress (which adds the token and holds each call to its routes),
// and back. Scoping comes first: a call for one mailbox, calendar or
// shared drive reaches only that one.

const providers = fakeProviders();
// A person's own calendar is the one of the address their token was
// issued to.
const google = fakeGoogle((token) => providers.state.holders.get(token)?.email);
const audit = auditEvents();

/** Someone's Google Workspace connection, made through OAuth. */
const connected = async (): Promise<Connection> => {
  const person = someone();
  const id = await connectAccount(
    providers,
    person,
    ownAccount(person, "google")
  );
  return { id, person };
};

/** What left connect, each request with its query and JSON body parsed. */
const requests = () => parsedRequests(google.sent);

const paths = (): string[] => requests().map(({ path }) => path);

/** UTF-8 text from base64 (MIME's, folded or not). */
const utf8 = (encoded: string): string =>
  new TextDecoder().decode(
    Uint8Array.from(
      atob(encoded.replaceAll("\r\n", "")),
      (character) => character.codePointAt(0) ?? 0
    )
  );

const mailboxPath = `/gmail/v1/users/${encodeURIComponent(invoices)}`;
const calendarPath = `/calendar/v3/calendars/${encodeURIComponent(teamCalendar)}`;

const manifest = connectorManifestSchema.parse(
  nativeConnector("google-workspace")?.manifest
);

/** Input for each Gmail tool, but its mailbox. */
const mailboxInputs: Record<string, Input> = {
  "gmail.users.messages.list": {},
  "gmail.users.messages.get": { id: messageId(ceo, 1) },
  "gmail.users.messages.attachments.get": {
    messageId: messageId(ceo, 1),
    partId: "1",
  },
  "gmail.users.labels.list": {},
  "gmail.users.messages.modify.create": {
    id: messageId(ceo, 1),
    removeLabelIds: ["INBOX"],
  },
  "gmail.users.messages.send.create": {
    subject: "Hi",
    body: "Hi",
    to: ["a@example.com"],
  },
  "gmail.users.drafts.create": {
    subject: "Hi",
    body: "Hi",
    to: ["a@example.com"],
  },
};

/** Input for each Calendar tool, but its calendar. */
const calendarInputs: Record<string, Input> = {
  "calendar.calendars.events.list": {
    timeMin: "2026-09-28T00:00:00Z",
    timeMax: "2026-10-05T00:00:00Z",
  },
  "calendar.calendars.events.get": { eventId: eventId(teamCalendar, 1) },
  "calendar.calendars.events.create": {
    summary: "Focus time",
    start: { dateTime: "2026-10-26T14:00", timeZone: "Europe/Amsterdam" },
    end: { dateTime: "2026-10-26T15:00", timeZone: "Europe/Amsterdam" },
  },
};

/** Input for each Drive tool, but its drive. */
const driveInputs: Record<string, Input> = {
  "drive.files.list": {},
  "drive.files.get": { fileId: fileIds.report },
  "spreadsheets.get": { spreadsheetId: fileIds.sheet },
};

describe("the Google Workspace connector's scoping", () => {
  it("binds every Gmail and Calendar route to its mailbox or calendar", () => {
    const routes = Object.entries(manifest.actions).flatMap(
      ([name, { resource, routes: declared }]) =>
        declared.map((route) => ({ name, resource, ...route }))
    );
    // Drive and Sheets have no path per drive: their tools hold a call to
    // the drive themselves (tested below). Drafts name no resource: they go
    // in the person's own Drive, under `drive.file` (tested below).
    const unbound = routes
      .filter(
        ({ name, resource, path }) =>
          !(
            (name === "upload.drive.files.create" && resource === null) ||
            (resource === "userId" &&
              path.startsWith("/gmail/v1/users/{userId}/")) ||
            (resource === "calendarId" &&
              (path.startsWith("/calendar/v3/calendars/{calendarId}/") ||
                // The person's own entry for that same calendar.
                path === "/calendar/v3/users/me/calendarList/{calendarId}")) ||
            (resource === "driveId" &&
              (path.startsWith("/drive/v3/files") ||
                path.startsWith("/v4/spreadsheets/{spreadsheetId}")))
          )
      )
      .map(({ name, path }) => `${name} ${path}`);
    expect(unbound).toStrictEqual([]);
    expect(
      Object.keys(manifest.actions).toSorted(),
      "every tool is tested for scoping below"
    ).toStrictEqual(
      [
        ...Object.keys(mailboxInputs),
        ...Object.keys(calendarInputs),
        ...Object.keys(driveInputs),
        "upload.drive.files.create",
      ].toSorted()
    );
    expect(manifest.hosts).toStrictEqual([
      "gmail.googleapis.com",
      "www.googleapis.com",
      "sheets.googleapis.com",
      "openidconnect.googleapis.com",
    ]);
    // No batch endpoint, and no redirect is ever followed.
    expect(
      routes.filter(
        ({ path, redirects }) => /batch/iu.test(path) || redirects !== undefined
      )
    ).toStrictEqual([]);
  });

  it("keeps a call for one mailbox out of every other, for every Gmail tool", async () => {
    const connection = await connected();
    // The capability is for invoices@; each call names ceo@, Google's
    // alias for the person's own, or a spelling Gmail would take for
    // invoices@ that isn't exactly it.
    await expect(
      refusalsFor(connection, mailboxInputs, "userId", invoices, [
        ceo,
        "me",
        "Invoices@example.com",
        `${invoices} `,
      ])
    ).resolves.toStrictEqual(new Set(["connect.resource_out_of_scope"]));
    expect(google.sent).toStrictEqual([]);
    await call(
      connection,
      "gmail.users.labels.list",
      { userId: invoices },
      { resource: invoices }
    );
    expect(paths()).toStrictEqual([`${mailboxPath}/labels`]);
  });

  it("keeps a call for one calendar out of every other", async () => {
    const connection = await connected();
    await expect(
      refusalsFor(connection, calendarInputs, "calendarId", teamCalendar, [
        invoices,
        "primary",
        holidayCalendar,
      ])
    ).resolves.toStrictEqual(new Set(["connect.resource_out_of_scope"]));
    expect(google.sent).toStrictEqual([]);
  });

  it("keeps a call for one shared drive out of every other", async () => {
    const connection = await connected();
    await expect(
      refusalsFor(connection, driveInputs, "driveId", financeDrive, [
        otherDrive,
        financeDrive.toLowerCase(),
      ])
    ).resolves.toStrictEqual(new Set(["connect.resource_out_of_scope"]));
    expect(google.sent).toStrictEqual([]);
  });

  it("never takes Google's aliases, or a calendar ID a path can't hold, as a resource", async () => {
    const connection = await connected();
    // Even when a permission names one, the tool refuses it before
    // anything goes out.
    const event = eventId(invoices, 1);
    const refusals = await Promise.all(
      [
        {
          action: "gmail.users.labels.list",
          resource: "me",
          input: { userId: "me" },
        },
        ...["primary", holidayCalendar].map((calendarId) => ({
          action: "calendar.calendars.events.get",
          resource: calendarId,
          input: { calendarId, eventId: event },
        })),
      ].map(
        async ({ action, resource, input }) =>
          await toolError(call(connection, action, input, { resource }))
      )
    );
    const [mailbox, primary, holiday] = refusals;
    expect([mailbox, primary]).toStrictEqual([
      "Invalid input: value.invalid_email at userId",
      "Invalid input: value.invalid_email at calendarId",
    ]);
    // An address, but with a `#`, which no path parameter may hold.
    expect(holiday).toMatchObject({ error: { code: "egress_refused" } });
    expect(google.sent).toStrictEqual([]);
  });
});

/** The stamp headers of the raw message a Gmail request carried. */
const stampsOf = (body: unknown): string[] => {
  const { raw } = z
    .object({ raw: z.string() })
    .or(
      z
        .object({ message: z.object({ raw: z.string() }) })
        .transform(({ message }) => message)
    )
    .parse(body);
  const mime = atob(raw.replaceAll("-", "+").replaceAll("_", "/"));
  const [head = ""] = mime.split("\r\n\r\n");
  return head.split("\r\n").filter((line) => line.startsWith("X-Grasp-Stamp:"));
};

describe("the Google Workspace connector's Gmail tools", () => {
  it("list a mailbox's messages with their metadata and the IDs they came from", async () => {
    const connection = await connected();
    const token = await accessTokenFor(env, connection.id);
    const result = await resultOf(
      call(connection, "gmail.users.messages.list", {
        userId: invoices,
        maxResults: 2,
      })
    );
    expect(result).toStrictEqual({
      output: {
        items: [
          {
            id: messageId(invoices, 1),
            threadId: threadId(invoices, 1),
            labelIds: ["UNREAD", "IMPORTANT", "INBOX", "Label_7"],
            snippet:
              "Dear customer, please find attached invoice 2026-0041 for EUR 1,250.00",
            internalDate: String(Date.parse("2026-09-24T08:11:00.000Z")),
            payload: {
              mimeType: "multipart/mixed",
              headers: [
                {
                  name: "Subject",
                  value: "Invoice 2026-0041 from Northwind Supplies",
                },
                {
                  name: "From",
                  value: '"Northwind Billing" <billing@northwind.example.org>',
                },
                {
                  name: "To",
                  value: `Invoices <${invoices}>, "Doe, Jane" <jane@example.com>`,
                },
                { name: "Cc", value: "controller@example.com" },
                {
                  name: "Message-ID",
                  value: "<CAF1x9Yq@mail.northwind.example.org>",
                },
              ],
            },
          },
          expect.objectContaining({
            id: messageId(invoices, 2),
            labelIds: ["INBOX"],
          }),
        ],
        next: messagePageToken,
      },
      provenance: [messageId(invoices, 1), messageId(invoices, 2)],
    });
    const [list, ...reads] = requests();
    expect(list).toMatchObject({
      method: "GET",
      host: "gmail.googleapis.com",
      path: `${mailboxPath}/messages`,
      query: { maxResults: "2" },
      headers: { authorization: `Bearer ${token}` },
    });
    // Gmail lists IDs only: each message's metadata, and nothing more. The
    // reads go out together, in no set order.
    expect(
      reads
        .map(({ path, query, search }) => ({
          path,
          format: query.format,
          headers: search.getAll("metadataHeaders"),
        }))
        .toSorted((one, other) => one.path.localeCompare(other.path))
    ).toStrictEqual(
      [1, 2].map((n) => ({
        path: `${mailboxPath}/messages/${messageId(invoices, n)}`,
        format: "metadata",
        headers: ["Subject", "From", "To", "Cc", "Message-ID"],
      }))
    );
  });

  it("page through Gmail's page token on their own route", async () => {
    const connection = await connected();
    const first = await outputOf(
      call(connection, "gmail.users.messages.list", {
        userId: invoices,
        maxResults: 2,
      })
    );
    const pageToken = z.object({ next: z.string() }).parse(first).next;
    await expect(
      outputOf(
        call(connection, "gmail.users.messages.list", {
          userId: invoices,
          maxResults: 2,
          pageToken,
        })
      )
    ).resolves.toMatchObject({
      items: [{ id: messageId(invoices, 3) }],
      next: null,
    });
    expect(requests()[3]).toMatchObject({
      path: `${mailboxPath}/messages`,
      query: { maxResults: "2", pageToken: messagePageToken },
    });
    // A page token is one query value, whatever it holds: it can't carry
    // a request.
    await call(connection, "gmail.users.messages.list", {
      userId: invoices,
      pageToken: "08 &q=from:ceo",
    });
    const carried = requests().find(
      ({ path, query }) =>
        path === `${mailboxPath}/messages` &&
        query.pageToken === "08 &q=from:ceo"
    );
    expect(carried?.search.getAll("q")).toStrictEqual([]);
  });

  it("list no more than a page, and leave out a message deleted since it was listed", async () => {
    const connection = await connected();
    await expect(
      resultOf(
        call(connection, "gmail.users.messages.list", {
          userId: invoices,
          q: "deleted",
          maxResults: 2,
        })
      )
    ).resolves.toMatchObject({
      output: { items: [{ id: messageId(invoices, 1) }] },
      provenance: [messageId(invoices, 1)],
    });
    expect(paths().toSorted()).toStrictEqual(
      [
        `${mailboxPath}/messages`,
        `${mailboxPath}/messages/${messageId(invoices, 1)}`,
        `${mailboxPath}/messages/${deletedMessageId}`,
      ].toSorted()
    );
  });

  it("filter by labels and search, in one request", async () => {
    const connection = await connected();
    await call(connection, "gmail.users.messages.list", {
      userId: invoices,
      labelIds: ["Label_7", "UNREAD"],
      q: "has:attachment invoice after:1788213600",
    });
    const [list] = requests();
    expect(list?.search.getAll("labelIds")).toStrictEqual([
      "Label_7",
      "UNREAD",
    ]);
    expect(list?.query).toMatchObject({
      q: "has:attachment invoice after:1788213600",
      maxResults: "10",
    });
  });

  it("get a message with its text or HTML body, and its attachments by part", async () => {
    const connection = await connected();
    const input = { userId: invoices, id: messageId(invoices, 1) };
    const result = await resultOf(
      call(connection, "gmail.users.messages.get", input)
    );
    expect(result).toMatchObject({
      output: {
        id: messageId(invoices, 1),
        // The headers it was sent with, and nothing of its route.
        payload: {
          headers: [
            {
              name: "Subject",
              value: "Invoice 2026-0041 from Northwind Supplies",
            },
            {
              name: "From",
              value: '"Northwind Billing" <billing@northwind.example.org>',
            },
            {
              name: "To",
              value: `Invoices <${invoices}>, "Doe, Jane" <jane@example.com>`,
            },
            { name: "Cc", value: "controller@example.com" },
            {
              name: "Message-ID",
              value: "<CAF1x9Yq@mail.northwind.example.org>",
            },
            { name: "Bcc", value: "audit@example.com" },
            {
              name: "Reply-To",
              value: "Accounts <accounts@northwind.example.org>",
            },
          ],
        },
        body: { contentType: "text", content: plainBody },
        attachments: [
          {
            partId: partIds.pdf,
            filename: "Invoice-2026-0041.pdf",
            mimeType: "application/pdf",
            size: invoicePdf.byteLength,
            isInline: false,
          },
          { partId: partIds.big, filename: "scans.zip" },
          { partId: partIds.inline, filename: "signature.png", isInline: true },
        ],
      },
      provenance: [messageId(invoices, 1)],
    });
    await expect(
      outputOf(
        call(connection, "gmail.users.messages.get", {
          ...input,
          bodyType: "html",
        })
      )
    ).resolves.toMatchObject({
      body: { contentType: "html", content: htmlBody },
    });
    expect(requests().map(({ query }) => query.format)).toStrictEqual([
      "full",
      "full",
    ]);
    await expect(
      toolError(
        call(connection, "gmail.users.messages.get", {
          userId: invoices,
          id: "19a0f00df00df00d",
        })
      )
    ).resolves.toStrictEqual({
      error: {
        code: "not_found",
        message: "Google Workspace has no such item (notFound)",
      },
    });
  });

  it("get a message's body that Gmail doesn't send inline by its attachment ID", async () => {
    const connection = await connected();
    const id = messageId(invoices, detachedBody.readable);
    const input = { userId: invoices, id };
    await expect(
      outputOf(call(connection, "gmail.users.messages.get", input))
    ).resolves.toMatchObject({
      body: { contentType: "text", content: plainBody },
      attachments: [{ partId: "9", filename: "Invoice-2026-0041.pdf" }],
    });
    await expect(
      outputOf(
        call(connection, "gmail.users.messages.get", {
          ...input,
          bodyType: "html",
        })
      )
    ).resolves.toMatchObject({
      body: { contentType: "html", content: htmlBody },
    });
    // Each read fetches only the body asked for, on the attachments route.
    const messagePath = `${mailboxPath}/messages/${id}`;
    expect(
      paths().map((path) =>
        path.startsWith(`${messagePath}/attachments/`)
          ? `attachment ${path.slice(-4)}`
          : path
      )
    ).toStrictEqual([
      messagePath,
      "attachment text",
      messagePath,
      "attachment html",
    ]);
  });

  it("read no body past the limit", async () => {
    const connection = await connected();
    await expect(
      toolError(
        call(connection, "gmail.users.messages.get", {
          userId: invoices,
          id: messageId(invoices, detachedBody.tooLarge),
        })
      )
    ).resolves.toMatchObject({ error: { code: "too_large" } });
    expect(paths()).toStrictEqual([
      `${mailboxPath}/messages/${messageId(invoices, detachedBody.tooLarge)}`,
    ]);
  });

  it("read no body or attachment past the limit that Gmail said was small", async () => {
    const connection = await connected();
    const message = messageId(invoices, detachedBody.understated);
    const refused = await Promise.all([
      toolError(
        call(connection, "gmail.users.messages.get", {
          userId: invoices,
          id: message,
        })
      ),
      toolError(
        call(connection, "gmail.users.messages.attachments.get", {
          userId: invoices,
          messageId: message,
          partId: "9",
        })
      ),
    ]);
    expect(refused).toMatchObject([
      { error: { code: "too_large" } },
      { error: { code: "too_large" } },
    ]);
  });

  it("get a message with no body part as one without a body", async () => {
    const connection = await connected();
    await expect(
      outputOf(
        call(connection, "gmail.users.messages.get", {
          userId: invoices,
          id: messageId(invoices, detachedBody.none),
        })
      )
    ).resolves.toMatchObject({ body: null, attachments: [{ partId: "9" }] });
    expect(paths()).toHaveLength(1);
  });

  it("read an attachment by its part, with the ID Gmail gives it on that read", async () => {
    const connection = await connected();
    const input = {
      userId: invoices,
      messageId: messageId(invoices, 1),
      partId: partIds.pdf,
    };
    await expect(
      resultOf(call(connection, "gmail.users.messages.attachments.get", input))
    ).resolves.toStrictEqual({
      output: {
        // A part of the message, named apart from it.
        id: `${messageId(invoices, 1)}/${partIds.pdf}`,
        messageId: messageId(invoices, 1),
        partId: partIds.pdf,
        name: "Invoice-2026-0041.pdf",
        contentType: "application/pdf",
        size: invoicePdf.byteLength,
        encoding: "base64",
        content: pdfBase64,
      },
      provenance: [`${messageId(invoices, 1)}/${partIds.pdf}`],
    });
    // One inline in its part needs no second request.
    await expect(
      outputOf(
        call(connection, "gmail.users.messages.attachments.get", {
          ...input,
          partId: partIds.inline,
        })
      )
    ).resolves.toMatchObject({
      content: base64(signaturePng),
    });
    expect(paths()).toStrictEqual([
      `${mailboxPath}/messages/${messageId(invoices, 1)}`,
      expect.stringMatching(
        new RegExp(
          `^${mailboxPath}/messages/${messageId(invoices, 1)}/attachments/ANGjdJ_`,
          "u"
        )
      ),
      `${mailboxPath}/messages/${messageId(invoices, 1)}`,
    ]);
    google.sent.length = 0;
    const refusals = await Promise.all(
      [
        { ...input, as: "text" },
        { ...input, partId: partIds.big },
        { ...input, partId: "9" },
      ].map(
        async (each) =>
          await toolError(
            call(connection, "gmail.users.messages.attachments.get", each)
          )
      )
    );
    expect(refusals).toMatchObject([
      { error: { code: "not_text" } },
      { error: { code: "too_large" } },
      { error: { code: "not_found" } },
    ]);
    // Too large, or no such part: refused before any content was asked for.
    expect(
      paths().filter((path) => path.includes("/attachments/"))
    ).toHaveLength(1);
  });

  it("list a mailbox's labels", async () => {
    const connection = await connected();
    await expect(
      outputOf(
        call(connection, "gmail.users.labels.list", { userId: invoices })
      )
    ).resolves.toStrictEqual({
      items: [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "UNREAD", name: "UNREAD", type: "system" },
        { id: "Label_7", name: "Invoices/2026", type: "user" },
      ],
      next: null,
    });
  });

  it("label a message, once for its idempotency key", async () => {
    const connection = await connected();
    const label = async (idempotencyKey: string, input = {}) =>
      await outputOf(
        call(
          connection,
          "gmail.users.messages.modify.create",
          {
            userId: invoices,
            id: messageId(invoices, 1),
            addLabelIds: ["Label_7"],
            removeLabelIds: ["INBOX", "UNREAD"],
            ...input,
          },
          { resource: invoices, idempotencyKey }
        )
      );
    const first = await label("run-7:archive");
    expect(first).toStrictEqual({
      id: messageId(invoices, 1),
      threadId: threadId(invoices, 1),
      labelIds: ["IMPORTANT", "Label_7"],
    });
    await expect(label("run-7:archive")).resolves.toStrictEqual(first);
    expect(requests()).toMatchObject([
      {
        method: "POST",
        path: `${mailboxPath}/messages/${messageId(invoices, 1)}/modify`,
        body: { addLabelIds: ["Label_7"], removeLabelIds: ["INBOX", "UNREAD"] },
      },
    ]);
    await expect(
      toolError(label("run-7:nothing", { addLabelIds: [], removeLabelIds: [] }))
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    expect(google.writesDone()).toBe(1);
  });

  it("send mail from the mailbox, as one MIME message nothing in the input can add a header to", async () => {
    const connection = await connected();
    const token = await accessTokenFor(env, connection.id);
    await expect(
      outputOf(
        call(
          connection,
          "gmail.users.messages.send.create",
          {
            userId: invoices,
            subject: "Payment of invoice 2026-0041\r\nBcc: thief@evil.test",
            body: "Paid today, € 1.250.\n\nKind regards",
            to: ["billing@northwind.example.org"],
            cc: ["controller@example.com"],
          },
          { resource: invoices, idempotencyKey: "run-7:send-receipt" }
        )
      )
    ).resolves.toStrictEqual({
      id: sentId(invoices),
      threadId: threadId(invoices, 1),
      labelIds: ["SENT"],
    });
    const [sent] = requests();
    expect(sent).toMatchObject({
      method: "POST",
      path: `${mailboxPath}/messages/send`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
    const { raw } = z.object({ raw: z.string() }).parse(sent?.body);
    const mime = atob(raw.replaceAll("-", "+").replaceAll("_", "/"));
    const [head = "", body = ""] = mime.split("\r\n\r\n");
    const lines = head.split("\r\n");
    // The subject's encoded words are folded onto lines of their own,
    // never a header of their own.
    expect(
      lines
        .filter((line) => !line.startsWith(" "))
        .map((line) => line.split(":")[0])
    ).toStrictEqual([
      "From",
      "To",
      "Cc",
      "Subject",
      "MIME-Version",
      "Content-Type",
      "Content-Transfer-Encoding",
    ]);
    const subject = [...head.matchAll(/[=]\?UTF-8\?B\?(?<word>[^?]*)\?=/gu)]
      .map(({ groups }) => utf8(groups?.word ?? ""))
      .join("");
    expect({ from: lines[0], subject, body: utf8(body) }).toStrictEqual({
      from: `From: ${invoices}`,
      subject: "Payment of invoice 2026-0041\r\nBcc: thief@evil.test",
      body: "Paid today, € 1.250.\r\n\r\nKind regards",
    });
  });

  it("send and draft a workflow run's mail with its stamp as a header, which no call without one carries", async () => {
    const connection = await connected();
    const stamp = "5a".repeat(16);
    const mail = {
      userId: invoices,
      subject: "Payment of invoice 2026-0041",
      body: "Paid today.",
      to: ["billing@northwind.example.org"],
    };
    await call(connection, "gmail.users.messages.send.create", mail, {
      resource: invoices,
      idempotencyKey: "run-7:send-stamped",
      stamp,
    });
    await call(connection, "gmail.users.drafts.create", mail, {
      resource: invoices,
      idempotencyKey: "run-7:draft-stamped",
      stamp,
    });
    await call(connection, "gmail.users.messages.send.create", mail, {
      resource: invoices,
      idempotencyKey: "run-7:send-plain",
    });

    expect(requests().map(({ body }) => stampsOf(body))).toStrictEqual([
      [`X-Grasp-Stamp: ${stamp}`],
      [`X-Grasp-Stamp: ${stamp}`],
      [],
    ]);
  });

  it("send nothing to an address that would carry a header", async () => {
    const connection = await connected();
    await expect(
      toolError(
        call(
          connection,
          "gmail.users.messages.send.create",
          {
            userId: invoices,
            subject: "Hi",
            body: "Hi",
            to: ["a@example.com\r\nBcc: thief@evil.test"],
          },
          { idempotencyKey: "run-7:inject" }
        )
      )
    ).resolves.toMatch(/^Invalid input: value\.invalid_email at to/u);
    expect(google.sent).toStrictEqual([]);
  });

  it("create a draft", async () => {
    const connection = await connected();
    await expect(
      outputOf(
        call(
          connection,
          "gmail.users.drafts.create",
          {
            userId: invoices,
            subject: "Question about invoice 2026-0041",
            body: "<p>Could you send the order number?</p>",
            bodyType: "html",
            to: ["billing@northwind.example.org"],
          },
          { idempotencyKey: "run-7:draft" }
        )
      )
    ).resolves.toStrictEqual({
      id: draftId,
      message: {
        id: sentId(invoices),
        threadId: threadId(invoices, 1),
        labelIds: ["DRAFT"],
      },
    });
    const [created] = requests();
    expect(created).toMatchObject({
      method: "POST",
      path: `${mailboxPath}/drafts`,
    });
    const { message } = z
      .object({ message: z.object({ raw: z.string() }) })
      .parse(created?.body);
    expect(atob(message.raw.replaceAll("-", "+").replaceAll("_", "/"))).toMatch(
      /Content-Type: text\/html; charset="UTF-8"/u
    );
  });
});

describe("the Google Workspace connector's Calendar tools", () => {
  it("list a range of events in UTC, page by page", async () => {
    const connection = await connected();
    const range = {
      calendarId: teamCalendar,
      timeMin: "2026-09-28T00:00:00Z",
      timeMax: "2026-10-05T00:00:00Z",
      maxResults: 1,
    };
    await expect(
      resultOf(call(connection, "calendar.calendars.events.list", range))
    ).resolves.toStrictEqual({
      output: {
        items: [
          {
            id: eventId(teamCalendar, 1),
            status: "confirmed",
            htmlLink: `https://www.google.com/calendar/event?eid=${eventId(teamCalendar, 1)}`,
            summary: "Month-end close",
            location: "Room 4.12",
            start: { dateTime: "2026-09-29T09:00:00Z", timeZone: "UTC" },
            end: { dateTime: "2026-09-29T10:00:00Z", timeZone: "UTC" },
            organizer: {
              email: "controller@example.com",
              displayName: "Controller",
            },
          },
        ],
        next: eventPageToken,
      },
      provenance: [eventId(teamCalendar, 1)],
    });
    await expect(
      outputOf(
        call(connection, "calendar.calendars.events.list", {
          ...range,
          pageToken: eventPageToken,
        })
      )
    ).resolves.toMatchObject({
      items: [{ id: eventId(teamCalendar, 2) }],
      next: null,
    });
    expect(requests()).toMatchObject([
      {
        host: "www.googleapis.com",
        path: `${calendarPath}/events`,
        query: {
          timeMin: range.timeMin,
          timeMax: range.timeMax,
          singleEvents: "true",
          orderBy: "startTime",
          timeZone: "UTC",
          maxResults: "1",
        },
      },
      {
        path: `${calendarPath}/events`,
        query: { maxResults: "1", pageToken: eventPageToken },
      },
    ]);
    await expect(
      toolError(
        call(connection, "calendar.calendars.events.list", {
          ...range,
          timeMax: range.timeMin,
        })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
  });

  it("get an event with its description and attendees, and an all-day one", async () => {
    const connection = await connected();
    await expect(
      resultOf(
        call(connection, "calendar.calendars.events.get", {
          calendarId: teamCalendar,
          eventId: eventId(teamCalendar, 1),
        })
      )
    ).resolves.toMatchObject({
      output: {
        id: eventId(teamCalendar, 1),
        description: "Agenda: open invoices over EUR 10,000.",
        attendees: [
          {
            email: "controller@example.com",
            displayName: "Controller",
            responseStatus: "accepted",
          },
          {
            email: "jane@example.com",
            responseStatus: "needsAction",
            optional: true,
          },
        ],
        hangoutLink: "https://meet.google.com/abc-defg-hij",
      },
      provenance: [eventId(teamCalendar, 1)],
    });
    await expect(
      outputOf(
        call(connection, "calendar.calendars.events.get", {
          calendarId: teamCalendar,
          eventId: eventId(teamCalendar, 3),
        })
      )
    ).resolves.toMatchObject({
      start: { date: "2026-10-01" },
      end: { date: "2026-10-02" },
    });
    expect(paths()[0]).toBe(
      `${calendarPath}/events/${eventId(teamCalendar, 1)}`
    );
  });

  it("get a cancelled occurrence without a start or end, and no other event", async () => {
    const connection = await connected();
    // A cancelled occurrence has only the start it had, and no end.
    await expect(
      outputOf(
        call(connection, "calendar.calendars.events.get", {
          calendarId: teamCalendar,
          eventId: cancelledOccurrenceId(teamCalendar),
        })
      )
    ).resolves.toStrictEqual({
      id: cancelledOccurrenceId(teamCalendar),
      status: "cancelled",
      recurringEventId: eventId(teamCalendar, 1),
      originalStartTime: { dateTime: "2026-10-06T09:00:00Z", timeZone: "UTC" },
    });
    await expect(
      outcome(
        call(connection, "calendar.calendars.events.get", {
          calendarId: teamCalendar,
          eventId: incompleteEventId(teamCalendar),
        })
      )
    ).resolves.toBe("connect.action_failed");
  });
});

const amsterdam = "Europe/Amsterdam";

/** An hour of focus time in `calendar`, in Amsterdam's wall-clock time. */
const focusTime = (calendarId: string) => ({
  calendarId,
  summary: "Focus time: Q4 forecast",
  start: { dateTime: "2026-10-26T14:00", timeZone: amsterdam },
  end: { dateTime: "2026-10-26T15:00", timeZone: amsterdam },
  location: "Home",
  description: "No meetings.",
});

/** Makes an event in the person's own calendar, under the key `key`. */
const createFocusTime = async (
  connection: Connection,
  key: string,
  input: Input & { calendarId: string } = focusTime(connection.person.email)
) =>
  await call(connection, "calendar.calendars.events.create", input, {
    resource: input.calendarId,
    idempotencyKey: key,
  });

/** The connection's status. */
const statusOf = async (connection: Connection) => {
  const row = await drizzle(env.DB)
    .select({ status: connections.status })
    .from(connections)
    .where(eq(connections.id, connection.id))
    .get();
  return row?.status;
};

/** What a connection made before the connector wrote events was granted. */
const readOnlyCalendar = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");

describe("the Google Workspace connector's calendar writes", () => {
  it("put an event in the person's own calendar, with nobody invited or told", async () => {
    const connection = await connected();
    const own = connection.person.email;
    const output = await outputOf(createFocusTime(connection, "run-1:focus"));
    const [checked, written] = requests();
    expect(output).toMatchObject({
      summary: "Focus time: Q4 forecast",
      start: { dateTime: "2026-10-26T14:00:00", timeZone: amsterdam },
      location: "Home",
      status: "confirmed",
      organizer: { email: own },
    });
    const { id, ...body } = z
      .object({ id: z.string() })
      .loose()
      .parse(written?.body);
    expect({
      // The call's effect key: the same call can't make a second event.
      id: /^[0-9a-f]{64}$/u.test(id),
      checked: checked?.path,
      written: {
        path: written?.path,
        sendUpdates: written?.query.sendUpdates,
        body,
      },
      made: google.made().map(({ attendees }) => attendees),
    }).toStrictEqual({
      id: true,
      // Google says it is their primary calendar first.
      checked: `/calendar/v3/users/me/calendarList/${encodeURIComponent(own)}`,
      written: {
        path: `/calendar/v3/calendars/${encodeURIComponent(own)}/events`,
        sendUpdates: "none",
        body: {
          summary: "Focus time: Q4 forecast",
          start: { dateTime: "2026-10-26T14:00:00", timeZone: amsterdam },
          end: { dateTime: "2026-10-26T15:00:00", timeZone: amsterdam },
          location: "Home",
          description: "No meetings.",
          transparency: "opaque",
          attendees: [],
          guestsCanInviteOthers: false,
        },
      },
      made: [[]],
    });
  });

  it("write nothing in a calendar that isn't the person's own, though it is shared with them", async () => {
    const connection = await connected();
    await expect(
      toolError(
        createFocusTime(connection, "run-2:team", focusTime(teamCalendar))
      )
    ).resolves.toMatchObject({ error: { code: "access_denied" } });
    expect({
      writes: requests().filter(({ method }) => method !== "GET").length,
      status: await statusOf(connection),
    }).toStrictEqual({ writes: 0, status: "active" });
  });

  it("refuse guests, times with an offset, unknown time zones and an event that ends before it starts, before anything goes out", async () => {
    const connection = await connected();
    const own = focusTime(connection.person.email);
    // A guest: no such input, which connect refuses before the tool runs.
    const guests = await outcome(
      createFocusTime(connection, "run-3:guests", {
        ...own,
        attendees: [{ email: "ben@example.com" }],
      })
    );
    const refusals = await Promise.all(
      [
        { ...own, start: { ...own.start, dateTime: "2026-10-26T14:00:00Z" } },
        {
          ...own,
          start: { ...own.start, dateTime: "2026-10-26T14:00+01:00" },
        },
        {
          ...own,
          start: { ...own.start, timeZone: "Mars/Olympus" },
          end: { ...own.end, timeZone: "Mars/Olympus" },
        },
        { ...own, end: { ...own.end, dateTime: "2026-10-26T13:00" } },
        { ...own, start: { ...own.start, dateTime: "2026-02-30T14:00" } },
      ].map(
        async (input, index) =>
          await toolError(createFocusTime(connection, `run-3:${index}`, input))
      )
    );
    // Each refused as invalid: by its input's schema, or by the tool.
    expect(
      refusals.map((refusal) =>
        typeof refusal === "string"
          ? refusal.startsWith("Invalid input")
          : JSON.stringify(refusal).includes('"code":"invalid"')
      )
    ).toStrictEqual(Array.from({ length: 5 }, () => true));
    expect({ guests, sent: google.sent }).toStrictEqual({
      guests: "connect.resource_out_of_scope",
      sent: [],
    });
  });

  it("find an event whose answer was lost by its ID, and never make it twice", async () => {
    const connection = await connected();
    google.loseWriteAnswer();
    await expect(
      outcome(createFocusTime(connection, "run-4:hold"))
    ).resolves.toBe("connect.outcome_unknown");
    await claimedAgo(connection);
    const found = await outputOf(createFocusTime(connection, "run-4:hold"));
    const [made] = google.made();
    expect({
      found,
      writesDone: google.writesDone(),
      lookup: requests().at(-1)?.path,
    }).toMatchObject({
      found: { id: made?.id, summary: "Focus time: Q4 forecast" },
      writesDone: 1,
      lookup: `/calendar/v3/calendars/${encodeURIComponent(connection.person.email)}/events/${String(made?.id)}`,
    });
  });

  it("report a connection made before it could write events for reconnecting, in place, and go through once it is", async () => {
    const person = someone();
    const id = await connectAccount(providers, person, {
      ...ownAccount(person, "google"),
      granted: readOnlyCalendar,
    });
    const connection = { id, person };
    // Google refuses the calendar list a grant without its right.
    google.failNext(403, {
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        errors: [{ reason: "insufficientPermissions" }],
      },
    });
    const refused = await outcome(createFocusTime(connection, "run-5:hold"));
    const status = await statusOf(connection);
    const events = await audit.events();
    const marked = events
      .filter(({ action }) => action === "connection.needs_reauth")
      .map(({ detail }) => detail);
    // Its grant is still valid: revoked as owed, should they not come back
    // (src/revocations.ts).
    const owed = await env.DB.prepare(
      "SELECT reason FROM token_revocations WHERE connection_id = ?"
    )
      .bind(id)
      .all<{ reason: string }>();
    const reconnected = await connectAccount(providers, person, {
      ...ownAccount(person, "google"),
      granted: `${readOnlyCalendar} https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly`,
    });
    const again = await outcome(createFocusTime(connection, "run-5:hold"));
    expect({
      refused,
      status,
      marked,
      owed: owed.results.map(({ reason }) => reason),
      sameConnection: reconnected === id,
      again,
      made: google.made().length,
    }).toStrictEqual({
      refused: "connect.connection_inactive",
      status: "needs_reauth",
      marked: [{ provider: "google", reason: "scopes_missing" }],
      owed: ["needs_reauth"],
      sameConnection: true,
      again: "ok",
      made: 1,
    });
  });
});

/** A reply Stephen drafts. */
const reply: Input = {
  name: "Reply to Northwind",
  mimeType: "application/vnd.google-apps.document",
  text: "Dear Ben,\n\nThank you for the invoice.",
};

/** A draft in the person's own Drive, under the key `key`. */
const writeDraft = async (
  connection: Connection,
  key: string,
  input: Input = reply
) =>
  await call(connection, "upload.drive.files.create", input, {
    idempotencyKey: key,
  });

describe("the Google Workspace connector's drafts", () => {
  it("write a Google Doc or a text file at the top of the person's own Drive, tagged with the call's key", async () => {
    const connection = await connected();
    const first = await outputOf(writeDraft(connection, "run-1:draft"));
    await writeDraft(connection, "run-1:notes", {
      name: "Notes",
      mimeType: "text/plain",
      text: "Chase 0041 on Friday.",
    });
    expect({
      first,
      drafts: google
        .madeFiles()
        .map(({ name, mimeType, parents, text, appProperties }) => ({
          name,
          mimeType,
          parents,
          text,
          tagged: /^[0-9a-f]{64}$/u.test(appProperties.graspEffect ?? ""),
        })),
      // One upload each, nothing else written.
      writes: requests()
        .filter(({ method }) => method !== "GET")
        .map(
          ({ path, query }) => `${path}?uploadType=${query.uploadType ?? ""}`
        ),
    }).toStrictEqual({
      first: {
        id: "file-1",
        name: "Draft from Stephen: Reply to Northwind",
        mimeType: "application/vnd.google-apps.document",
        webViewLink: "https://docs.google.com/document/d/file-1/edit",
      },
      drafts: [
        {
          name: "Draft from Stephen: Reply to Northwind",
          mimeType: "application/vnd.google-apps.document",
          parents: ["root"],
          text: "Dear Ben,\n\nThank you for the invoice.",
          tagged: true,
        },
        {
          name: "Draft from Stephen: Notes",
          mimeType: "text/plain",
          parents: ["root"],
          text: "Chase 0041 on Friday.",
          tagged: true,
        },
      ],
      writes: [
        "/upload/drive/v3/files?uploadType=multipart",
        "/upload/drive/v3/files?uploadType=multipart",
      ],
    });
  });

  it("refuse a drive, a folder, a name with controls and an unknown format before anything goes out", async () => {
    const connection = await connected();
    const draft = {
      name: "Reply",
      mimeType: "application/vnd.google-apps.document",
      text: "Hi",
    };
    const outcomes = await Promise.all(
      [
        { ...draft, drive: financeDrive },
        { ...draft, folder: fileIds.folder },
        { ...draft, name: "Reply\u0000" },
        { ...draft, name: " Reply" },
        { ...draft, mimeType: "application/pdf" },
      ].map(
        async (input, index) =>
          await outcome(writeDraft(connection, `run-2:${index}`, input))
      )
    );
    expect({
      ran: outcomes.filter((each) => each === "ok"),
      sent: google.sent,
    }).toStrictEqual({ ran: [], sent: [] });
  });

  it("find a draft whose answer was lost by its key, and never make it twice", async () => {
    const connection = await connected();
    google.loseWriteAnswer();
    await expect(outcome(writeDraft(connection, "run-3:draft"))).resolves.toBe(
      "connect.outcome_unknown"
    );
    await claimedAgo(connection);
    const found = await outputOf(writeDraft(connection, "run-3:draft"));
    const lookup = requests().at(-1)?.query.q ?? "";
    expect({
      found,
      made: google.madeFiles().length,
      byKey:
        /^appProperties has \{ key='graspEffect' and value='[0-9a-f]{64}' \} and trashed = false$/u.test(
          lookup
        ),
    }).toMatchObject({
      found: { id: "file-1", name: "Draft from Stephen: Reply to Northwind" },
      made: 1,
      byKey: true,
    });
  });

  it("report a connection made before it could write drafts for reconnecting, in place, and go through once it is", async () => {
    const person = someone();
    const before = readOnlyCalendar.replace(
      "calendar.events.readonly",
      "calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly"
    );
    const id = await connectAccount(providers, person, {
      ...ownAccount(person, "google"),
      granted: before,
    });
    const connection = { id, person };
    google.failNextWrite(403, {
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        errors: [{ reason: "insufficientPermissions" }],
      },
    });
    const refused = await outcome(writeDraft(connection, "run-4:draft"));
    const status = await statusOf(connection);
    await connectAccount(providers, person, {
      ...ownAccount(person, "google"),
      granted: `${before} https://www.googleapis.com/auth/drive.file`,
    });
    const again = await outcome(writeDraft(connection, "run-4:draft"));
    expect({
      refused,
      status,
      again,
      made: google.madeFiles().length,
    }).toStrictEqual({
      refused: "connect.connection_inactive",
      status: "needs_reauth",
      again: "ok",
      made: 1,
    });
  });
});

describe("the Google Workspace connector's Drive tools", () => {
  it("list a shared drive's folder, without its trash, page by page", async () => {
    const connection = await connected();
    await expect(
      resultOf(
        call(connection, "drive.files.list", {
          driveId: financeDrive,
          q: `'${financeDrive}' in parents`,
        })
      )
    ).resolves.toStrictEqual({
      output: {
        items: [
          expect.objectContaining({
            id: fileIds.folder,
            mimeType: "application/vnd.google-apps.folder",
          }),
          {
            id: fileIds.report,
            name: "Month-end report.txt",
            mimeType: "text/plain",
            size: String(new TextEncoder().encode(reportText).byteLength),
            modifiedTime: "2026-09-24T16:02:11.000Z",
            webViewLink: `https://drive.google.com/file/d/${fileIds.report}/view?usp=drivesdk`,
            parents: [financeDrive],
            driveId: financeDrive,
          },
        ],
        next: filePageToken,
      },
      provenance: [fileIds.folder, fileIds.report],
    });
    await call(connection, "drive.files.list", {
      driveId: financeDrive,
      q: `'${fileIds.folder}' in parents`,
      orderBy: "folder,name",
      pageToken: filePageToken,
    });
    expect(requests()).toMatchObject([
      {
        host: "www.googleapis.com",
        path: "/drive/v3/files",
        query: {
          corpora: "drive",
          driveId: financeDrive,
          includeItemsFromAllDrives: "true",
          supportsAllDrives: "true",
          q: `('${financeDrive}' in parents) and trashed = false`,
          pageSize: "50",
        },
      },
      {
        query: {
          corpora: "drive",
          driveId: financeDrive,
          q: `('${fileIds.folder}' in parents) and trashed = false`,
          orderBy: "folder,name",
          pageToken: filePageToken,
        },
      },
    ]);
    expect(requests()[0]?.query).not.toHaveProperty("orderBy");
  });

  it("search a shared drive, and pass on its own items only", async () => {
    const connection = await connected();
    const q = String.raw`fullText contains 'Northwind\'s \\invoice'`;
    // Google adds an item of another drive: it's left out.
    await expect(
      resultOf(
        call(connection, "drive.files.list", { driveId: financeDrive, q })
      )
    ).resolves.toStrictEqual({
      output: {
        items: [expect.objectContaining({ id: fileIds.pdf })],
        next: null,
      },
      provenance: [fileIds.pdf],
    });
    expect(requests()[0]?.query).toMatchObject({
      corpora: "drive",
      driveId: financeDrive,
      q: `(${q}) and trashed = false`,
    });
  });

  it("read a file's own content from Google itself", async () => {
    const connection = await connected();
    await expect(
      resultOf(
        call(
          connection,
          "drive.files.get",
          { driveId: financeDrive, fileId: fileIds.report },
          { resource: financeDrive }
        )
      )
    ).resolves.toStrictEqual({
      output: {
        id: fileIds.report,
        name: "Month-end report.txt",
        mimeType: "text/plain",
        contentType: "text/plain",
        size: String(new TextEncoder().encode(reportText).byteLength),
        encoding: "text",
        content: reportText,
      },
      provenance: [fileIds.report],
    });
    // Its metadata first, which says its drive, then its content.
    const sent = requests();
    expect(sent.map(({ query }) => query.alt ?? "metadata")).toStrictEqual([
      "metadata",
      "media",
    ]);
    expect(
      sent.every(({ path }) => path === `/drive/v3/files/${fileIds.report}`)
    ).toBeTruthy();
    const pdf = { driveId: financeDrive, fileId: fileIds.pdf };
    await expect(
      outputOf(call(connection, "drive.files.get", { ...pdf, as: "base64" }))
    ).resolves.toMatchObject({ encoding: "base64", content: pdfBase64 });
    await expect(
      toolError(call(connection, "drive.files.get", { ...pdf, as: "text" }))
    ).resolves.toMatchObject({ error: { code: "not_text" } });
  });

  it("read Google's own documents as text and spreadsheets as CSV, by export", async () => {
    const connection = await connected();
    const [doc, sheet] = await Promise.all(
      [fileIds.doc, fileIds.sheet].map(
        async (fileId) =>
          await outputOf(
            call(connection, "drive.files.get", {
              driveId: financeDrive,
              fileId,
            })
          )
      )
    );
    expect({ doc, sheet }).toMatchObject({
      // The export's byte-order mark isn't content.
      doc: {
        mimeType: "application/vnd.google-apps.document",
        contentType: "text/plain",
        content: docText.slice(1),
      },
      sheet: { contentType: "text/csv", content: sheetCsv },
    });
    expect(
      requests()
        .filter(({ path }) => path.endsWith("/export"))
        .map(({ path, query }) => `${path}?mimeType=${query.mimeType ?? ""}`)
        .toSorted()
    ).toStrictEqual(
      [
        `/drive/v3/files/${fileIds.doc}/export?mimeType=text/plain`,
        `/drive/v3/files/${fileIds.sheet}/export?mimeType=text/csv`,
      ].toSorted()
    );
  });

  it("read nothing of another drive's file, a My Drive file, a trashed file, a folder, a form, a shortcut or a file past the limit", async () => {
    const connection = await connected();
    const refusals = await Promise.all(
      [
        fileIds.foreign,
        fileIds.myDrive,
        fileIds.alias,
        fileIds.trashed,
        fileIds.folder,
        fileIds.form,
        fileIds.shortcut,
        fileIds.big,
      ].map(
        async (fileId) =>
          await toolError(
            call(
              connection,
              "drive.files.get",
              { driveId: financeDrive, fileId },
              { resource: financeDrive }
            )
          )
      )
    );
    expect(refusals).toMatchObject([
      // Google says it is in another drive, or none: the tool refuses.
      { error: { code: "not_found" } },
      { error: { code: "not_found" } },
      // Google answered with another file of the drive: the tool refuses.
      { error: { code: "not_found" } },
      { error: { code: "not_found" } },
      { error: { code: "not_a_file" } },
      { error: { code: "not_a_file" } },
      { error: { code: "not_a_file" } },
      { error: { code: "too_large" } },
    ]);
    // Each was refused on its drive or its metadata: no content was asked
    // for.
    expect(
      requests().filter(
        ({ path, query }) => query.alt === "media" || path.endsWith("/export")
      )
    ).toStrictEqual([]);
  });
});

describe("the Google Workspace connector's Sheets tools", () => {
  it("list a spreadsheet's sheets and no cells, after Drive says it is in the drive", async () => {
    const connection = await connected();
    await expect(
      resultOf(
        call(
          connection,
          "spreadsheets.get",
          { driveId: financeDrive, spreadsheetId: fileIds.sheet },
          { resource: financeDrive }
        )
      )
    ).resolves.toStrictEqual({
      output: {
        spreadsheetId: fileIds.sheet,
        properties: { title: "Invoice register" },
        sheets: [
          { properties: { title: sheetNames[1], index: 1 } },
          { properties: { title: sheetNames[0], index: 0 } },
        ],
      },
      provenance: [fileIds.sheet],
    });
    // Drive's metadata first, which says its drive; then Sheets, with a
    // field mask that holds no cells.
    expect(
      requests().map(({ host, path, query }) => ({
        host,
        path,
        ranges: query.ranges,
        grid: query.includeGridData,
        cells: query.fields?.includes("rowData"),
      }))
    ).toStrictEqual([
      {
        host: "www.googleapis.com",
        path: `/drive/v3/files/${fileIds.sheet}`,
        ranges: undefined,
        grid: undefined,
        cells: false,
      },
      {
        host: "sheets.googleapis.com",
        path: `/v4/spreadsheets/${fileIds.sheet}`,
        ranges: undefined,
        grid: undefined,
        cells: false,
      },
    ]);
  });

  it("read the cells of each range asked for, as Sheets gives them", async () => {
    const connection = await connected();
    const [register, notes] = sheetNames;
    const ranges = [`'${register}'!A1:D3`, "'Ben''s notes'!1:201"];
    await expect(
      outputOf(
        call(connection, "spreadsheets.get", {
          driveId: financeDrive,
          spreadsheetId: fileIds.sheet,
          ranges,
        })
      )
    ).resolves.toStrictEqual({
      spreadsheetId: fileIds.sheet,
      properties: { title: "Invoice register" },
      sheets: [
        {
          properties: { title: register, index: 0 },
          data: [
            {
              rowData: (sheetGrid[register] ?? []).map((values) => ({
                values,
              })),
            },
          ],
        },
        {
          properties: { title: notes, index: 1 },
          data: [
            {
              rowData: (sheetGrid[notes] ?? []).map((values) => ({ values })),
            },
          ],
        },
      ],
    });
    const [, read] = requests();
    expect(read?.search.getAll("ranges")).toStrictEqual(ranges);
    expect(read?.query.includeGridData).toBe("true");
  });

  it("read nothing of another drive's file, or a file that isn't a spreadsheet, and pass on a range Sheets can't read as invalid", async () => {
    const connection = await connected();
    const inputs: Input[] = [
      { spreadsheetId: fileIds.foreign },
      { spreadsheetId: fileIds.myDrive },
      { spreadsheetId: fileIds.trashed },
      { spreadsheetId: fileIds.report },
      { spreadsheetId: fileIds.sheet, ranges: ["'Salaries'!A1:B2"] },
      ...["A1:B2'!Z", "Sheet1!A1", "a1", "A1:B2:C3"].map((range) => ({
        spreadsheetId: fileIds.sheet,
        ranges: [range],
      })),
    ];
    const refusals = await Promise.all(
      inputs.map(
        async (input) =>
          await toolError(
            call(
              connection,
              "spreadsheets.get",
              { driveId: financeDrive, ...input },
              { resource: financeDrive }
            )
          )
      )
    );
    expect(refusals).toMatchObject([
      { error: { code: "not_found" } },
      { error: { code: "not_found" } },
      { error: { code: "not_found" } },
      { error: { code: "not_a_file" } },
      { error: { code: "invalid" } },
      { error: { code: "invalid" } },
      { error: { code: "invalid" } },
      { error: { code: "invalid" } },
      { error: { code: "invalid" } },
    ]);
    // Only the spreadsheet in the drive reached Sheets.
    expect(
      new Set(
        requests()
          .filter(({ host }) => host === "sheets.googleapis.com")
          .map(({ path }) => path)
      )
    ).toStrictEqual(new Set([`/v4/spreadsheets/${fileIds.sheet}`]));
  });
});

describe("the Google Workspace connector's answers", () => {
  it("say a read Drive refused with a rate limit's reason did nothing, so it may be retried once the connection's pause ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const connection = await connected();
    // Calendar and Drive rate limit with a 403 as often as a 429.
    google.rateLimit403();
    const list = async () =>
      await retryable(
        call(connection, "drive.files.list", { driveId: financeDrive })
      );
    const throttled = await list();
    // The connector's `isThrottled` said so: every caller waits with it.
    const paused = await list();
    expect({ throttled, paused, sent: google.sent.length }).toStrictEqual({
      throttled: { code: "connect.server_unavailable", retryAfterSeconds: 60 },
      paused: { code: "connect.rate_limited", retryAfterSeconds: 60 },
      sent: 1,
    });
  });

  it("say an email Gmail sent is of unknown outcome when its answer was lost, and never send it again", async () => {
    const connection = await connected();
    const send = async () =>
      await outcome(
        call(
          connection,
          "gmail.users.messages.send.create",
          {
            userId: invoices,
            subject: "Payment of invoice 2026-0041",
            body: "Paid today.",
            to: ["billing@northwind.example.org"],
          },
          { resource: invoices, idempotencyKey: "run-9:send-receipt" }
        )
      );
    google.loseWriteAnswer();
    const outcomes = [await send(), await send()];
    expect(outcomes).toStrictEqual([
      "connect.outcome_unknown",
      "connect.outcome_unknown",
    ]);
    expect(google.writesDone()).toBe(1);
    expect(google.sent).toHaveLength(1);
  });

  it("send a label change of unknown outcome again once its call can no longer be out: it sets the same labels", async () => {
    const connection = await connected();
    const label = async () =>
      await outcome(
        call(
          connection,
          "gmail.users.messages.modify.create",
          {
            userId: invoices,
            id: messageId(invoices, 1),
            addLabelIds: ["Label_7"],
            removeLabelIds: ["INBOX"],
          },
          { resource: invoices, idempotencyKey: "run-8:label" }
        )
      );
    google.loseWriteAnswer();
    const lost = await label();
    const early = await label();
    await claimedAgo(connection);
    const recovered = await label();
    const modified = parsedRequests(google.sent).map(({ method, body }) => ({
      method,
      body,
    }));
    expect({
      lost,
      early,
      recovered,
      writesDone: google.writesDone(),
      sameWrite:
        modified.length === 2 &&
        JSON.stringify(modified[0]) === JSON.stringify(modified[1]),
    }).toStrictEqual({
      lost: "connect.outcome_unknown",
      early: "connect.outcome_unknown",
      recovered: "ok",
      writesDone: 2,
      sameWrite: true,
    });
  });

  it("leave a Gmail send of unknown outcome unknown: nothing finds or repeats it", async () => {
    const connection = await connected();
    const send = async () =>
      await outcome(
        call(
          connection,
          "gmail.users.messages.send.create",
          {
            userId: invoices,
            subject: "Payment of invoice 2026-0041",
            body: "Paid today.",
            to: ["billing@northwind.example.org"],
          },
          { resource: invoices, idempotencyKey: "run-8:send" }
        )
      );
    google.loseWriteAnswer();
    await send();
    await claimedAgo(connection);
    await expect(send()).resolves.toBe("connect.outcome_unknown");
    expect(google.sent).toHaveLength(1);
  });

  it("never take a provider's answer for connect's egress's own", async () => {
    const connection = await connected();
    // Google's 404 carries `grasp-egress: refused`: the egress drops it,
    // and the connector reports Google's answer.
    await expect(
      toolError(
        call(connection, "gmail.users.messages.get", {
          userId: invoices,
          id: spoofedMessageId,
        })
      )
    ).resolves.toMatchObject({ error: { code: "not_found" } });
  });
});
