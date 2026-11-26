import {
  attachedFiles,
  attachments,
  contentAs,
  page,
  stampHeader,
  tool,
  ToolError,
  v,
} from "@grasp-os/sdk/connector";
import type { Api, ToolCall } from "@grasp-os/sdk/connector";

import {
  checkIds,
  effectFilter,
  effectTag,
  graphId,
  graphPage,
  mailbox,
  next,
  nextOf,
  positionOf,
  top,
} from "./graph-sdk.ts";

// Mail, in one mailbox per call: a person's own or a shared one (such as
// invoices@), always as `/users/{mailbox}`, so a call's permission binds
// every request to its mailbox. Reading and drafting stay in the mailbox,
// but the mailbox may be a shared one or a colleague's the connection may
// open (`Mail.ReadWrite.Shared`), so they reach `company`; sending reaches
// whoever the message goes to (`others`). Moving, flagging and
// categorising work only in the person's own mailbox, under `/me`
// (mail-sorting.ts).

export const messagesRoute = "/users/{mailbox}/messages";
const folderMessagesRoute = "/users/{mailbox}/mailFolders/{folder}/messages";
export const messageRoute = "/users/{mailbox}/messages/{message}";
const attachmentRoute =
  "/users/{mailbox}/messages/{message}/attachments/{attachment}";
const sendRoute = "/users/{mailbox}/sendMail";

/** Graph's recipient: an emailAddress. */
const Recipient = v.object({
  emailAddress: v
    .object({
      name: v.string().nullable().optional(),
      address: v.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

/** Graph's itemBody. */
const ItemBody = v.object({ contentType: v.string(), content: v.string() });

const messageFields = {
  id: v.string(),
  subject: v.string().nullable().optional(),
  bodyPreview: v.string().nullable().optional(),
  from: Recipient.nullable().optional(),
  toRecipients: v.array(Recipient).nullable().optional(),
  ccRecipients: v.array(Recipient).nullable().optional(),
  receivedDateTime: v.string().nullable().optional(),
  sentDateTime: v.string().nullable().optional(),
  isRead: v.boolean().nullable().optional(),
  isDraft: v.boolean().nullable().optional(),
  hasAttachments: v.boolean().nullable().optional(),
  importance: v.string().nullable().optional(),
  flag: v
    .object({ flagStatus: v.string().nullable().optional() })
    .nullable()
    .optional(),
  parentFolderId: v.string().nullable().optional(),
  conversationId: v.string().nullable().optional(),
  internetMessageId: v.string().nullable().optional(),
  webLink: v.string().nullable().optional(),
};

/** A message (Graph's message), narrowed to these fields. */
const Message = v.object(messageFields);

/** A message of a conversation, with its own text (Graph's uniqueBody). */
const ConversationMessage = v.object({
  ...messageFields,
  uniqueBody: ItemBody.nullable().optional(),
});

const select = Object.keys(messageFields).join(",");

const attachmentShape = {
  "@odata.type": v.string(),
  id: v.string(),
  name: v.string().nullable().optional(),
  contentType: v.string().nullable().optional(),
  size: v.number().integer().min(0),
  isInline: v.boolean().nullable().optional(),
};

/** Graph's attachment, without its content. */
const Attachment = v.object(attachmentShape);

/** Graph's attachment, with its content if it is a file. */
const AttachmentContent = v.object({
  ...attachmentShape,
  contentBytes: v.string().nullable().optional(),
});

/** Attachment fields without their content. */
const attachmentFields = "id,name,contentType,size,isInline";

/** A message with its body, and its attachments without their content. */
const FullMessage = v.object({
  ...messageFields,
  body: ItemBody.nullable().optional(),
  bccRecipients: v.array(Recipient).nullable().optional(),
  replyTo: v.array(Recipient).nullable().optional(),
  attachments: v.array(Attachment).nullable().optional(),
});

/** How a message's body comes back: as text, or as Graph has it (HTML). */
const bodyType = v.enum(["text", "html"]);

/** Asks Graph for bodies of one type. */
const preferBody = (type: "text" | "html") => ({
  prefer: `outlook.body-content-type="${type}"`,
});

/** A search term for Graph's `$search`: no quote to end it early. */
const searchPattern = /^[^"\\]*$/u;

/**
 * A conversation's ID, as Graph gives it in a message's `conversationId`:
 * base64, so it may hold `+` and `/`. It only ever goes into a `$filter`
 * string literal, never a path, and can't hold the quote that would end
 * the literal.
 */
const conversationPattern = /^[\w=+/!.-]+$/u;

/** Graph's followupFlagStatus. */
export const flagStatus = v.enum(["notFlagged", "flagged", "complete"]);

/** The filters both message lists take, in Graph's field names. */
const listArgs = {
  mailbox,
  search: v.string().min(1).max(256).optional(),
  isRead: v.boolean().optional(),
  flag: v.object({ flagStatus }).optional(),
  receivedDateTime: v.string().datetime().optional(),
  top,
  next,
};

/**
 * How many characters of a conversation message's own text a list returns
 * at most, so a whole conversation stays a size a model reads in one go.
 */
const uniqueBodyLimit = 8000;

/** `text` cut to `limit` characters, never inside a surrogate pair. */
const cutText = (text: string, limit: number): string => {
  if (text.length <= limit) {
    return text;
  }
  const astral = (text.codePointAt(limit - 1) ?? 0) > 0xff_ff;
  return text.slice(0, astral ? limit - 1 : limit);
};

interface ListFilters {
  search?: string | undefined;
  isRead?: boolean | undefined;
  flag?: { flagStatus: string } | undefined;
  receivedDateTime?: string | undefined;
  conversationId?: string | undefined;
  top?: number | undefined;
  next?: string | undefined;
}

/** Refuses, before anything is sent, a search or a conversation ID that would end its literal. */
const checkFilters = ({ search, conversationId }: ListFilters): void => {
  if (search !== undefined && !searchPattern.test(search)) {
    throw new ToolError("Invalid input: search can't hold a quote", {
      code: "invalid",
    });
  }
  if (
    conversationId !== undefined &&
    !conversationPattern.test(conversationId)
  ) {
    throw new ToolError(
      "Invalid input: conversationId isn't a Microsoft 365 conversation ID",
      { code: "invalid" }
    );
  }
};

/**
 * Graph's `$filter` for the filters given, or undefined for none. Graph
 * sorts by a filtered property only once it leads the filter.
 */
const filterOf = ({
  isRead,
  flag,
  receivedDateTime,
  conversationId,
}: ListFilters): string | undefined => {
  if (
    isRead === undefined &&
    flag === undefined &&
    receivedDateTime === undefined &&
    conversationId === undefined
  ) {
    return undefined;
  }
  return [
    `receivedDateTime ge ${receivedDateTime ?? "1900-01-01T00:00:00Z"}`,
    ...(isRead === undefined ? [] : [`isRead eq ${String(isRead)}`]),
    ...(flag === undefined ? [] : [`flag/flagStatus eq '${flag.flagStatus}'`]),
    ...(conversationId === undefined
      ? []
      : [`conversationId eq '${conversationId}'`]),
  ].join(" and ");
};

/**
 * A page of messages at `route`: newest first, filtered or searched (not
 * both, which Graph refuses), and with each message's own text when they
 * are one conversation's.
 */
const listMessages = async (
  api: Api,
  route: string,
  path: Readonly<Record<string, string>>,
  filters: ListFilters
) => {
  checkFilters(filters);
  const { search, conversationId } = filters;
  const filter = filterOf(filters);
  if (search !== undefined && filter !== undefined) {
    throw new ToolError(
      "Microsoft 365 can't search and filter at once: search, or filter",
      { code: "invalid" }
    );
  }
  const conversation = conversationId !== undefined;
  const answer = await api.get(route, {
    path,
    query: {
      // A message's `uniqueBody` is its own text without the earlier ones
      // quoted below it, so a conversation read whole doesn't repeat itself.
      $select: conversation ? `${select},uniqueBody` : select,
      $top: filters.top ?? 25,
      // Search results come by relevance, and can't be sorted.
      $orderby: search === undefined ? "receivedDateTime desc" : undefined,
      $filter: filter,
      $search: search === undefined ? undefined : `"${search}"`,
      ...positionOf(filters.next),
    },
    ...(conversation ? { headers: preferBody("text") } : {}),
    returns: graphPage(ConversationMessage),
  });
  return {
    items: answer.value.map((message) =>
      message.uniqueBody === undefined || message.uniqueBody === null
        ? message
        : {
            ...message,
            uniqueBody: {
              ...message.uniqueBody,
              content: cutText(message.uniqueBody.content, uniqueBodyLimit),
            },
          }
    ),
    next: nextOf(answer["@odata.nextLink"]),
  };
};

const fileAttachment = "#microsoft.graph.fileAttachment";

/** Largest attachment a read returns, in bytes. */
const maxAttachmentBytes = 4 * 1024 * 1024;

/** Bytes from base64. */
const fromBase64 = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (character) => character.codePointAt(0) ?? 0);

/** Base64 of `bytes`, a chunk at a time to spare the call stack. */
const toBase64 = (bytes: Uint8Array): string => {
  const chunk = 0x80_00;
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += chunk) {
    parts.push(String.fromCodePoint(...bytes.subarray(start, start + chunk)));
  }
  return btoa(parts.join(""));
};

/** Recipients as Graph takes them, narrowed to an address each. */
export const recipients = v
  .array(
    v.object({
      emailAddress: v.object({ address: v.string().email().max(256) }),
    })
  )
  .max(100);

/** A message to send or keep as a draft, in Graph's message's terms. */
const draftArgs = {
  mailbox,
  subject: v.string().max(1024),
  body: v.object({
    contentType: bodyType.optional(),
    content: v.string().max(1024 * 1024),
  }),
  toRecipients: recipients.min(1),
  ccRecipients: recipients.optional(),
  bccRecipients: recipients.optional(),
  replyTo: recipients.optional(),
  // Run files a workflow attaches (GRA-887), each by digest; their bytes
  // come beside the args, checked before the handler runs.
  attachments,
};

/**
 * A message as the person asked to confirm it reads it: every arg of
 * {@link draftArgs}, so nothing it sends goes unshown.
 */
const draftFields = [
  { label: "From", arg: "mailbox" },
  { label: "To", arg: "toRecipients" },
  { label: "Cc", arg: "ccRecipients" },
  { label: "Bcc", arg: "bccRecipients" },
  { label: "Reply to", arg: "replyTo" },
  { label: "Subject", arg: "subject" },
  { label: "Body", arg: "body" },
  { label: "Attachments", arg: "attachments" },
] as const;

/**
 * The run's stamp as a header, if it has one: Graph keeps the header on
 * every copy it delivers, so the copy a watched mailbox receives names the
 * run that sent it (core's workflows/mail-stamps.ts), whatever new ID it
 * gets there.
 */
export const stampOf = (stamp: string | null) =>
  stamp === null
    ? {}
    : { internetMessageHeaders: [{ name: stampHeader, value: stamp }] };

type Recipients = { emailAddress: { address: string } }[];

/**
 * A message as Graph takes it, with the run's files inline, tagged with
 * the call's effect key if any and carrying its stamp if any.
 */
const graphDraft = (
  args: {
    subject: string;
    body: { contentType?: "text" | "html" | undefined; content: string };
    toRecipients: Recipients;
    ccRecipients?: Recipients | undefined;
    bccRecipients?: Recipients | undefined;
    replyTo?: Recipients | undefined;
    attachments?: Parameters<typeof attachedFiles>[0];
  },
  call: ToolCall
) => {
  const files = attachedFiles(args.attachments, call);
  return {
    subject: args.subject,
    body: {
      contentType: args.body.contentType ?? "text",
      content: args.body.content,
    },
    toRecipients: args.toRecipients,
    ccRecipients: args.ccRecipients ?? [],
    bccRecipients: args.bccRecipients ?? [],
    replyTo: args.replyTo ?? [],
    // Inline file attachments, as Graph's JSON takes them: the name and
    // type are the run file's own (a name no folder or control character
    // is in, a type from a closed list) in JSON strings, the content base64.
    ...(files.length === 0
      ? {}
      : {
          attachments: files.map(({ name, type, bytes }) => ({
            "@odata.type": fileAttachment,
            name,
            contentType: type,
            contentBytes: toBase64(bytes),
          })),
        }),
    ...stampOf(call.stamp),
    ...effectTag(call.key),
  };
};

/** What a draft Graph made tells of it. */
export const Draft = v.object({
  id: v.string(),
  conversationId: v.string().nullable().optional(),
  webLink: v.string().nullable().optional(),
});

/**
 * The message in `mailbox`, in any folder, that a call with effect key
 * `key` made, if there is one: the draft, or the message it became once a
 * person sent it. The key is 64 hex characters (connect derives it), so it
 * can't break out of the filter's string literal.
 */
export const findByEffect = async (
  api: Api,
  mailboxId: string,
  key: string
) => {
  const { value } = await api.get(messagesRoute, {
    path: { mailbox: mailboxId },
    query: {
      $filter: effectFilter(key),
      $select: "id,conversationId,webLink",
      $top: 1,
    },
    returns: graphPage(Draft),
  });
  return value[0] ?? null;
};

/**
 * Mail in one mailbox, by name: each named from its route
 * (`GET /users/{mailbox}/messages` is `users.messages.list`).
 */
export const mailTools = {
  "users.messages.list": tool({
    description:
      "Lists the messages of a mailbox in every folder, Sent Items included, newest first, a page at a time: filtered by isRead, flag, receivedDateTime (received at or after) or conversationId, or searched, but not both. With conversationId it reads one conversation, each message with its own text (uniqueBody, as text without the earlier messages quoted below it, cut at 8,000 characters).",
    readOnly: true,
    reach: "company",
    scopes: ["Mail.Read", "Mail.ReadWrite.Shared"],
    resource: "mailbox",
    mail: true,
    routes: [`GET ${messagesRoute}`],
    args: {
      ...listArgs,
      conversationId: v.string().min(1).max(512).optional(),
    },
    returns: page(ConversationMessage),
    handler: async ({ mailbox: mailboxId, ...filters }, api) =>
      await listMessages(api, messagesRoute, { mailbox: mailboxId }, filters),
  }),
  "users.mailFolders.messages.list": tool({
    description:
      "Lists the messages in one folder of a mailbox (a folder ID, or a well-known name such as inbox or archive), newest first, a page at a time: filtered by isRead, flag or receivedDateTime (received at or after), or searched, but not both.",
    readOnly: true,
    reach: "company",
    scopes: ["Mail.Read", "Mail.ReadWrite.Shared"],
    resource: "mailbox",
    mail: true,
    routes: [`GET ${folderMessagesRoute}`],
    args: { ...listArgs, folder: graphId },
    returns: page(Message),
    handler: async ({ mailbox: mailboxId, folder, ...filters }, api) => {
      checkIds({ folder });
      return await listMessages(
        api,
        folderMessagesRoute,
        { mailbox: mailboxId, folder },
        filters
      );
    },
  }),
  "users.messages.get": tool({
    description:
      "Gets one message of a mailbox with its body, as text unless bodyType is html, and its attachments' names, types and sizes without their content (read one with users.messages.attachments.get).",
    readOnly: true,
    reach: "company",
    scopes: ["Mail.Read", "Mail.ReadWrite.Shared"],
    resource: "mailbox",
    mail: true,
    routes: [`GET ${messageRoute}`],
    args: { mailbox, message: graphId, bodyType: bodyType.optional() },
    returns: FullMessage,
    handler: async ({ mailbox: mailboxId, message, ...args }, api) => {
      checkIds({ message });
      return await api.get(messageRoute, {
        path: { mailbox: mailboxId, message },
        query: {
          $select: `${select},body,bccRecipients,replyTo`,
          $expand: `attachments($select=${attachmentFields})`,
        },
        headers: preferBody(args.bodyType ?? "text"),
        returns: FullMessage,
      });
    },
  }),
  "users.messages.attachments.get": tool({
    description:
      "Reads a file attachment of a message: as text, or as base64 to extract its content (a PDF, say). Up to 4 MiB; an attached item or link is refused.",
    readOnly: true,
    reach: "company",
    scopes: ["Mail.Read", "Mail.ReadWrite.Shared"],
    resource: "mailbox",
    mail: true,
    // A workflow action may keep it as a file of its run (GRA-886).
    answersFile: true,
    routes: [`GET ${attachmentRoute}`],
    args: {
      mailbox,
      message: graphId,
      attachment: graphId,
      as: v.enum(["text", "base64"]).optional(),
    },
    returns: v.object({
      id: v.string(),
      name: v.string().nullable(),
      contentType: v.string().nullable(),
      size: v.number(),
      encoding: v.enum(["text", "base64"]),
      content: v.string(),
    }),
    handler: async ({ mailbox: mailboxId, message, attachment, as }, api) => {
      checkIds({ message, attachment });
      const path = { mailbox: mailboxId, message, attachment };
      // Its size first: Graph sends the content inline, however large.
      const found = await api.get(attachmentRoute, {
        path,
        query: { $select: attachmentFields },
        returns: Attachment,
      });
      if (found.size > maxAttachmentBytes) {
        throw new ToolError(
          `This is over ${maxAttachmentBytes / 1024 / 1024} MiB, more than a tool reads`,
          { code: "too_large" }
        );
      }
      const full = await api.get(attachmentRoute, {
        path,
        returns: AttachmentContent,
      });
      const content = full.contentBytes ?? "";
      if (full["@odata.type"] !== fileAttachment || content === "") {
        throw new ToolError("This attachment isn't a file", {
          code: "not_a_file",
        });
      }
      return {
        id: full.id,
        name: full.name ?? null,
        contentType: full.contentType ?? null,
        size: full.size,
        ...contentAs(fromBase64(content), as ?? "base64"),
      };
    },
  }),
  "users.sendMail.create": tool({
    description:
      "Sends a message from a mailbox (the person's own, or a shared one they may send as), keeping a copy in its Sent Items. The body is text unless its contentType is html.",
    readOnly: false,
    reach: "others",
    scopes: ["Mail.Send", "Mail.Send.Shared"],
    resource: "mailbox",
    mail: { recipients: ["toRecipients", "ccRecipients", "bccRecipients"] },
    takesFiles: true,
    // No recovery: a sent email of unknown outcome stays unknown. Not
    // finding its Sent Items copy doesn't prove it wasn't sent: a shared
    // mailbox's copy can land in the delegate's own mailbox, a copy can be
    // hard-deleted, Graph may not keep the tag on the copy, and `sendMail`
    // answers 202 before the copy is saved. Before this tool gets a `find`,
    // a live check (M365_SMOKE_WRITES) must show, for a person's own and a
    // shared mailbox: the copy carries the tag, it is found by it once the
    // claim timeout has passed, and where a delegate's copy lands. The tag
    // is kept on every send, so such a lookup can find it then.
    routes: [`POST ${sendRoute}`],
    describe: { title: "Send an email", fields: draftFields },
    args: draftArgs,
    // Graph answers 202, with nothing.
    returns: v.object({}),
    handler: async ({ mailbox: mailboxId, ...args }, api, call) => {
      await api.post(sendRoute, {
        path: { mailbox: mailboxId },
        body: { message: graphDraft(args, call), saveToSentItems: true },
      });
      return {};
    },
  }),
  "users.messages.create": tool({
    description:
      "Creates a draft in a mailbox's Drafts folder, for a person to review and send. The body is text unless its contentType is html.",
    readOnly: false,
    reach: "company",
    scopes: ["Mail.ReadWrite", "Mail.ReadWrite.Shared"],
    resource: "mailbox",
    mail: { recipients: ["toRecipients", "ccRecipients", "bccRecipients"] },
    takesFiles: true,
    routes: [`POST ${messagesRoute}`, `GET ${messagesRoute}`],
    describe: { title: "Create a draft email", fields: draftFields },
    args: draftArgs,
    returns: Draft,
    handler: async ({ mailbox: mailboxId, ...args }, api, call) =>
      await api.post(messagesRoute, {
        path: { mailbox: mailboxId },
        body: graphDraft(args, call),
        returns: Draft,
      }),
    // Made, if a message with its key is in the mailbox: the draft, or the
    // message it became once a person sent it.
    find: async ({ mailbox: mailboxId }, api, call) =>
      await findByEffect(api, mailboxId, call.key),
  }),
};
