import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { accessTokenFor } from "../src/tokens.ts";
import { outcome } from "./connect.ts";
import { planIds } from "./fixtures/graph-apps.ts";
import {
  archiveFolderId,
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
  recipientsOf,
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

/**
 * Where the tools that name no resource reach under /me: me.drive.root.content.upload
 * the person's own OneDrive, and the To Do and OneNote tools their own To
 * Do and notebooks.
 */
const underMe = [
  ["me.drive.root.content.upload", "/v1.0/me/drive/root:/{folder}/{name}"],
  ["me.todo.", "/v1.0/me/todo/lists"],
  ["me.onenote.", "/v1.0/me/onenote/"],
  ["me.messages.", "/v1.0/me/"],
  ["me.calendarView.", "/v1.0/me/calendarView"],
  ["me.chats.", "/v1.0/me/chats"],
  ["me.onlineMeetings.", "/v1.0/me/onlineMeetings"],
  ["me.onlineMeetings.", "/v1.0/me/events/"],
] as const;

describe("the Microsoft 365 connector's scoping", () => {
  it("binds every route of every tool to its mailbox, drive, site, plan or workbook's named table, reads /me only to know whose a mailbox is, and reaches under /me only for drafts in the person's own OneDrive and their own To Do", () => {
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
                (name === "planner.tasks.create" &&
                  method === "POST" &&
                  path === "/v1.0/planner/tasks") ||
                (resource === "workbook" &&
                  path.startsWith(
                    "/v1.0/drives/{drive}/items/{workbook}/workbook/tables/{table}/"
                  )) ||
                (method === "GET" && path === "/v1.0/me") ||
                (resource === null &&
                  underMe.some(
                    ([tool, under]) =>
                      name.startsWith(tool) && path.startsWith(under)
                  ))
              )
          )
          .map(({ path }) => `${name} ${path}`)
    );
    expect(unbound).toStrictEqual([]);
    // Only the tools that work in the person's own mailbox, OneDrive or To
    // Do go to /me: the mail tools that sort their own inbox, and the
    // person's own calendar view, chats (whose messages also ask whose the
    // token is) and meetings, me.drive.root.content.upload to write
    // its draft, and the To Do tools for the person's own lists.
    const askWho = Object.entries(manifest.actions)
      .filter(([, { routes }]) =>
        routes.some(({ path }) => path.startsWith("/v1.0/me"))
      )
      .map(([name, { reach }]) => `${name} ${reach}`);
    expect(askWho.toSorted()).toStrictEqual([
      "me.calendarView.list conversations",
      "me.chats.list conversations",
      "me.chats.messages.list conversations",
      "me.drive.root.content.upload own",
      "me.messages.move.create own",
      "me.messages.update own",
      "me.onenote.pages.get own",
      "me.onenote.sections.list own",
      "me.onenote.sections.pages.create own",
      "me.onenote.sections.pages.list own",
      "me.onlineMeetings.transcripts.content.getContent conversations",
      "me.todo.lists.list own",
      "me.todo.lists.tasks.create own",
      "me.todo.lists.tasks.list own",
      "me.todo.lists.tasks.update own",
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
        "me.calendarView.list",
        "me.chats.list",
        "me.chats.messages.list",
        "me.drive.root.content.upload",
        "me.messages.move.create",
        "me.messages.update",
        "me.onenote.pages.get",
        "me.onenote.sections.list",
        "me.onenote.sections.pages.create",
        "me.onenote.sections.pages.list",
        "me.todo.lists.list",
        "me.todo.lists.tasks.create",
        "me.todo.lists.tasks.list",
        "me.onlineMeetings.transcripts.content.getContent",
        "me.todo.lists.tasks.update",
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
      "users.messages.list",
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
      call(connection, "users.messages.list", { mailbox: invoices })
    );
    expect(result).toMatchObject({
      output: {
        items: [
          {
            id: messageId(invoices, 1),
            subject: "Invoice 2026-0041 from Northwind Supplies",
            from: {
              emailAddress: {
                name: "Northwind Billing",
                address: "billing@northwind.example.org",
              },
            },
            toRecipients: [
              { emailAddress: { name: "Invoices", address: invoices } },
            ],
            isRead: false,
            hasAttachments: true,
          },
          { id: messageId(invoices, 2) },
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
      call(connection, "users.messages.list", { mailbox: invoices, top: 2 })
    );
    expect(first).toMatchObject({ next: "%24skip=2" });
    const { next } = z.object({ next: z.string() }).parse(first);
    await expect(
      outputOf(
        call(connection, "users.messages.list", {
          mailbox: invoices,
          top: 2,
          next,
        })
      )
    ).resolves.toMatchObject({
      items: [{ id: messageId(invoices, 3) }],
      next: null,
    });
    // Graph's link names `users('invoices%40example.com')`: not followed.
    expect(requests()[1]).toMatchObject({
      path: `${mailboxPath}/messages`,
      query: { $top: "2", $skip: "2" },
    });
    // A page is only a position: anything else in one is ignored, and one
    // without a position is refused.
    await call(connection, "users.messages.list", {
      mailbox: invoices,
      next: "%24skip=2&%24select=body",
    });
    expect(requests()[2]?.query.$select).not.toBe("body");
    await expect(
      toolError(
        call(connection, "users.messages.list", {
          mailbox: invoices,
          next: "$select=body",
        })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
  });

  it("search a folder, filter, but not both at once", async () => {
    const connection = await connected();
    await call(connection, "users.mailFolders.messages.list", {
      mailbox: invoices,
      folder: "inbox",
      search: "invoice 2026",
    });
    await call(connection, "users.messages.list", {
      mailbox: invoices,
      isRead: false,
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
        call(connection, "users.messages.list", {
          mailbox: invoices,
          search: "invoice",
          isRead: false,
        })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    expect(graph.sent).toHaveLength(2);
  });

  it("list the flagged messages only, each with its flag and conversation", async () => {
    const connection = await connected();
    await expect(
      outputOf(
        call(connection, "users.messages.list", {
          mailbox: invoices,
          flag: { flagStatus: "flagged" },
        })
      )
    ).resolves.toMatchObject({
      items: [
        {
          id: messageId(invoices, flaggedMessage),
          flag: { flagStatus: "flagged" },
          conversationId:
            "AAQkAGE1M2IyNGNmLTI5MTktNDUyZi1iOTVjLTc2ZjI5ZmNmZmQ2MwAQAC3Ym9A=",
        },
      ],
      next: null,
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
        call(connection, "users.messages.list", {
          mailbox: invoices,
          search: "invoice",
          flag: { flagStatus: "flagged" },
        })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    expect(graph.sent).toHaveLength(1);
  });

  it("read a conversation newest first, Sent Items included, so the last word shows who waits", async () => {
    const connection = await connected();
    const result = await resultOf(
      call(connection, "users.messages.list", {
        mailbox: invoices,
        conversationId: threadConversationId,
      })
    );
    const billing = {
      emailAddress: {
        name: "Northwind Billing",
        address: "billing@northwind.example.org",
      },
    };
    expect(result).toMatchObject({
      output: {
        items: [
          {
            id: messageId(invoices, 103),
            conversationId: threadConversationId,
            from: billing,
            isRead: false,
            uniqueBody: {
              contentType: "text",
              content: "Message 3 of the conversation about invoice 2026-0041.",
            },
          },
          {
            id: messageId(invoices, 102),
            from: { emailAddress: { address: invoices } },
            toRecipients: [billing],
          },
          { id: messageId(invoices, 101), from: billing },
        ],
        next: null,
      },
      provenance: [103, 102, 101].map((n) => messageId(invoices, n)),
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
    // A conversation ID can't end the filter's string literal: refused
    // before anything goes out.
    await expect(
      toolError(
        call(connection, "users.messages.list", {
          mailbox: invoices,
          conversationId: "x' or isRead eq false or id eq 'y",
        })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    expect(graph.sent).toHaveLength(1);
  });

  it("cut a long conversation to a page of its newest messages, and a long body to its bound", async () => {
    const connection = await connected();
    const output = z
      .object({
        items: z.array(
          z.object({
            id: z.string(),
            uniqueBody: z.object({ content: z.string() }),
          })
        ),
        next: z.string().nullable(),
      })
      .parse(
        await outputOf(
          call(connection, "users.messages.list", {
            mailbox: invoices,
            conversationId: longConversationId,
          })
        )
      );
    const bound = 25;
    expect(output.next).not.toBeNull();
    expect(output.items.map(({ id }) => id)).toStrictEqual(
      Array.from({ length: bound }, (_, at) =>
        messageId(invoices, 100 + longThreadLength - at)
      )
    );
    const [newest, ...rest] = output.items;
    // Cut before the emoji whose halves straddle the bound, never between them.
    expect({
      straddling: String.fromCodePoint(longBody.codePointAt(7999) ?? 0),
      body: newest?.uniqueBody.content,
    }).toStrictEqual({ straddling: "🧾", body: longBody.slice(0, 7999) });
    expect(
      rest.filter(({ uniqueBody }) => uniqueBody.content.length >= 7999)
    ).toStrictEqual([]);
  });

  it("get a message with its body as text, and its attachments' metadata", async () => {
    const connection = await connected();
    const result = await resultOf(
      call(connection, "users.messages.get", {
        mailbox: invoices,
        message: messageId(invoices, 1),
      })
    );
    expect(result).toMatchObject({
      output: {
        id: messageId(invoices, 1),
        body: {
          contentType: "text",
          content:
            "Dear customer,\r\n\r\nPlease find attached invoice 2026-0041 for EUR 1,250.00.\r\n",
        },
        attachments: [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: pdfAttachmentId,
            name: "Invoice-2026-0041.pdf",
            contentType: "application/pdf",
            size: invoicePdf.byteLength,
          },
          {
            "@odata.type": "#microsoft.graph.itemAttachment",
            id: itemAttachmentId,
          },
        ],
      },
      provenance: [messageId(invoices, 1)],
    });
    // Its attachments come with it, without their content, in the one
    // request: no page of them is followed.
    expect(requests()).toMatchObject([
      {
        path: `${mailboxPath}/messages/${encodeURIComponent(messageId(invoices, 1))}`,
        query: {
          $expand: "attachments($select=id,name,contentType,size,isInline)",
        },
        headers: { prefer: 'outlook.body-content-type="text"' },
      },
    ]);
    expect(graph.sent).toHaveLength(1);
    await expect(
      toolError(
        call(connection, "users.messages.get", {
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

  it("read a message's attachments with it, never paging through them", async () => {
    const connection = await connected();
    await outputOf(
      call(connection, "users.messages.get", {
        mailbox: invoices,
        message: messageId(invoices, endlessAttachments),
      })
    );
    expect(graphPaths()).toStrictEqual([
      `${mailboxPath}/messages/${encodeURIComponent(messageId(invoices, endlessAttachments))}`,
    ]);
  });

  it("read a file attachment as base64, and only a file", async () => {
    const connection = await connected();
    const input = {
      mailbox: invoices,
      message: messageId(invoices, 1),
      attachment: pdfAttachmentId,
    };
    await expect(
      resultOf(call(connection, "users.messages.attachments.get", input))
    ).resolves.toStrictEqual({
      output: {
        id: pdfAttachmentId,
        name: "Invoice-2026-0041.pdf",
        contentType: "application/pdf",
        size: invoicePdf.byteLength,
        encoding: "base64",
        content: pdfBase64,
      },
      provenance: [pdfAttachmentId],
    });
    const refusals = await Promise.all(
      [
        { ...input, as: "text" },
        { ...input, attachment: itemAttachmentId },
        { ...input, attachment: bigAttachmentId },
      ].map(
        async (each) =>
          await toolError(
            call(connection, "users.messages.attachments.get", each)
          )
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
    const { connection, own } = await connectedOwn();
    const move = async (destinationId: string, idempotencyKey: string) =>
      await outputOf(
        call(
          connection,
          "me.messages.move.create",
          { message: messageId(own, 1), destinationId },
          { idempotencyKey }
        )
      );
    const first = await move("archive", "run-7:move-invoice");
    expect(first).toStrictEqual({
      id: movedId(own, 1),
      parentFolderId: archiveFolderId,
    });
    await expect(move("archive", "run-7:move-invoice")).resolves.toStrictEqual(
      first
    );
    // The destination is looked up in the person's own mailbox, and the
    // message moved to the folder it names there.
    expect(requests()).toMatchObject([
      { method: "GET", path: "/v1.0/me/mailFolders/archive" },
      {
        method: "POST",
        path: `/v1.0/me/messages/${encodeURIComponent(messageId(own, 1))}/move`,
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
          "me.messages.move.create",
          { message: messageId(own, 1), destinationId: "archive", ...shown },
          { idempotencyKey }
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
    const { connection, own } = await connectedOwn();
    await expect(
      outputOf(
        call(
          connection,
          "me.messages.update",
          { ...shownEmail(own), flag: { flagStatus: "flagged" } },
          { idempotencyKey: "run-3:flag" }
        )
      )
    ).resolves.toStrictEqual({
      id: messageId(own, 1),
      flag: { flagStatus: "flagged" },
      categories: [],
    });
    const path = `/v1.0/me/messages/${encodeURIComponent(messageId(own, 1))}`;
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
          "me.messages.update",
          { ...shownEmail(own), flag: { flagStatus: "complete" } },
          { idempotencyKey: "run-3:complete" }
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
          "me.messages.update",
          {
            ...shownEmail(own),
            categories: ["Finance", "Waiting on others", "Finance"],
          },
          { idempotencyKey }
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
    const { connection, own } = await connectedOwn();
    await expect(
      toolError(
        call(
          connection,
          "me.messages.update",
          { ...shownEmail(own), categories: ["Finance", "Board only"] },
          { idempotencyKey: "run-3:new-category" }
        )
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    // Every page of their categories was read, the next on the tool's own
    // route, before it was refused.
    const categories = "/v1.0/me/outlook/masterCategories";
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
            "me.messages.update",
            {
              ...shownEmail(own),
              ...differs,
              flag: { flagStatus: "flagged" },
            },
            { idempotencyKey: crypto.randomUUID() }
          )
        ),
        outcome(
          call(
            connection,
            "me.messages.update",
            { ...shownEmail(own), ...differs, categories: ["Finance"] },
            { idempotencyKey: crypto.randomUUID() }
          )
        ),
      ])
    );
    expect(new Set(outcomes)).toStrictEqual(new Set(["connect.action_failed"]));
    expect(graph.writesDone()).toBe(0);
  });

  it("work only in the person's own mailbox, under /me: a call can't name another", async () => {
    const { connection } = await connectedOwn();
    // invoices@ is a mailbox the token opens, but not the person's own.
    const inputs: Record<string, Input> = {
      "me.messages.update": {
        ...shownEmail(invoices),
        flag: { flagStatus: "flagged" },
      },
      "me.messages.move.create": {
        message: messageId(invoices, 1),
        destinationId: "archive",
      },
    };
    const elsewhere = await Promise.all(
      Object.entries(inputs).map(
        async ([action, input]) =>
          await toolError(
            call(
              connection,
              action,
              { mailbox: invoices, ...input },
              { idempotencyKey: crypto.randomUUID() }
            )
          )
      )
    );
    expect(elsewhere).toStrictEqual([
      expect.stringMatching(/^Invalid input/u),
      expect.stringMatching(/^Invalid input/u),
    ]);
    expect(graph.sent).toStrictEqual([]);
  });

  it("send mail from a shared mailbox", async () => {
    const connection = await connected();
    const token = await accessTokenFor(env, connection.id);
    await expect(
      outputOf(
        call(
          connection,
          "users.sendMail.create",
          {
            mailbox: invoices,
            subject: "Payment of invoice 2026-0041",
            body: { content: "Paid today." },
            toRecipients: recipientsOf("billing@northwind.example.org"),
            ccRecipients: recipientsOf("controller@example.com"),
          },
          { resource: invoices, idempotencyKey: "run-7:send-receipt" }
        )
      )
    ).resolves.toStrictEqual({});
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
      body: { content: "Paid today." },
      toRecipients: recipientsOf("billing@northwind.example.org"),
    };
    await call(connection, "users.sendMail.create", mail, {
      resource: invoices,
      idempotencyKey: "run-7:send-stamped",
      stamp,
    });
    await call(connection, "users.messages.create", mail, {
      resource: invoices,
      idempotencyKey: "run-7:draft-stamped",
      stamp,
    });
    await call(connection, "users.sendMail.create", mail, {
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
          "users.messages.create",
          {
            mailbox: invoices,
            subject: "Question about invoice 2026-0041",
            body: {
              contentType: "html",
              content: "<p>Could you send the order number?</p>",
            },
            toRecipients: recipientsOf("billing@northwind.example.org"),
          },
          { idempotencyKey: "run-7:draft" }
        )
      )
    ).resolves.toMatchObject({ id: messageId(invoices, 9) });
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
    comment: "Thanks, we'll pay it this week.",
    toRecipients: recipientsOf(sender),
  };
  const replyPath = `${mailboxPath}/messages/${encodeURIComponent(messageId(invoices, 1))}`;
  const made = replyDraft(invoices, 1, reply.subject);
  const drafted = {
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
          comment: reply.comment,
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
      manifest.actions["users.messages.createReply.create"]?.routes
        .filter(({ method }) => method !== "GET")
        .map(({ path }) => path)
    ).toStrictEqual(["/v1.0/users/{mailbox}/messages/{message}/createReply"]);
  });

  it("reply to the message's other recipients only when replying to all, and to no one else", async () => {
    const connection = await connected();
    const refusals = await Promise.all(
      [
        {
          ...reply,
          toRecipients: recipientsOf("someone@elsewhere.example.com"),
        },
        { ...reply, toRecipients: recipientsOf(sender, invoices) },
        { ...reply, ccRecipients: recipientsOf(invoices) },
        {
          ...reply,
          replyAll: true,
          ccRecipients: recipientsOf("someone@elsewhere.example.com"),
        },
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
          toRecipients: recipientsOf("Billing@Northwind.example.org"),
          ccRecipients: recipientsOf(invoices),
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
      toRecipients: recipientsOf("accounts@northwind.example.org"),
    };
    // Its Cc is someone the message was only copied to: not a reply's.
    await expect(
      toolError(
        draftReply(
          connection,
          { ...second, toRecipients: recipientsOf("controller@example.com") },
          "run-8:cc-only"
        )
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    await outputOf(draftReply(connection, second, "run-8:reply-to"));
    await outputOf(
      draftReply(
        connection,
        {
          ...second,
          replyAll: true,
          ccRecipients: recipientsOf("controller@example.com"),
        },
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
    expect(found).toMatchObject({ id: drafted.id });
    expect({
      repeat,
      writesDone: graph.writesDone(),
      writes: writes().length,
    }).toStrictEqual({ repeat: found, writesDone: 1, writes: 1 });
  });
});
