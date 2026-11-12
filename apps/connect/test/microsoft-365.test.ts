import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { accessTokenFor } from "../src/tokens.ts";
import { outcome } from "./connect.ts";
import { planIds } from "./fixtures/graph-apps.ts";
import {
  archiveFolderId,
  attachmentsSkipToken,
  categoriesSkipToken,
  endlessAttachments,
  foreignFolderId,
  bigAttachmentId,
  ceo,
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
  messageId,
  movedId,
  pdfAttachmentId,
  pdfBase64,
  personalDrive,
  replyDraft,
  workbookIds,
} from "./fixtures/graph.ts";
import {
  connected,
  connectedOwn,
  draftReply,
  driveInputs,
  graph,
  graphPaths,
  headersOf,
  invoiceSubject,
  mailboxInputs,
  mailboxPath,
  manifest,
  planInputs,
  requests,
  shownEmail,
  siteInputs,
  workbookInputs,
  writes,
  writesOf,
} from "./microsoft-365-harness.ts";
import {
  callTool as call,
  claimedAgo,
  outputOf,
  refusalsFor,
  resultOf,
  toolError,
} from "./tool-calls.ts";
import type { Input } from "./tool-calls.ts";

// The Microsoft 365 connector against Graph's recorded answers, through
// connect's real call path: capability, policy, a fresh isolate, the
// egress (which adds the token and holds each call to its routes), and
// back. Scoping comes first: a call for one mailbox or drive reaches only
// that one, by construction.

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
      // A part of the message, named apart from it.
      provenance: [`${messageId(invoices, 1)}/${pdfAttachmentId}`],
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
