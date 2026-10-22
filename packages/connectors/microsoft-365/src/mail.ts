import {
  attachedFiles,
  attachmentsInput,
  defineTool,
  invalidCode,
  ToolError,
} from "@grasp-os/connector-kit/connector";
import type { Effect } from "@grasp-os/connector-kit/connector";
import {
  checkReadable,
  contentAs,
  fromBase64,
  readAsSchema,
  toBase64,
} from "@grasp-os/connector-kit/content";
import { stampHeader } from "@grasp-os/connector-kit/manifest";
import { jsonBody, segment } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

import {
  atPage,
  effectPropertyId,
  graphFetch,
  graphHost,
  graphJson,
  graphUrl,
  idSchema,
  mailboxSchema,
  nextPageOf,
  pageOf,
  pageSchema,
  topSchema,
  v1,
} from "./graph.ts";

// Mail, in one mailbox per call: a person's own or a shared one (such as
// invoices@), always as `/users/{mailbox}`, so a call's capability binds
// every request to its mailbox. Each result names its mailbox and the IDs
// of the messages it came from.

const users = `${v1}/users/{mailbox}`;

const get = (path: string) =>
  ({ method: "GET", host: graphHost, path: `${users}${path}` }) as const;
const post = (path: string) =>
  ({ method: "POST", host: graphHost, path: `${users}${path}` }) as const;

const graphAddress = z.object({
  emailAddress: z
    .object({
      name: z.string().nullish(),
      address: z.string().nullish(),
    })
    .nullish(),
});

const graphMessage = z.object({
  id: z.string(),
  subject: z.string().nullish(),
  bodyPreview: z.string().nullish(),
  body: z.object({ contentType: z.string(), content: z.string() }).nullish(),
  from: graphAddress.nullish(),
  toRecipients: z.array(graphAddress).nullish(),
  ccRecipients: z.array(graphAddress).nullish(),
  bccRecipients: z.array(graphAddress).nullish(),
  replyTo: z.array(graphAddress).nullish(),
  receivedDateTime: z.string().nullish(),
  sentDateTime: z.string().nullish(),
  isRead: z.boolean().nullish(),
  isDraft: z.boolean().nullish(),
  hasAttachments: z.boolean().nullish(),
  importance: z.string().nullish(),
  parentFolderId: z.string().nullish(),
  conversationId: z.string().nullish(),
  internetMessageId: z.string().nullish(),
  webLink: z.string().nullish(),
});
type GraphMessage = z.infer<typeof graphMessage>;

/** The message fields a summary asks Graph for. */
const summaryFields = [
  "id",
  "subject",
  "bodyPreview",
  "from",
  "toRecipients",
  "ccRecipients",
  "receivedDateTime",
  "sentDateTime",
  "isRead",
  "isDraft",
  "hasAttachments",
  "importance",
  "parentFolderId",
  "conversationId",
  "internetMessageId",
  "webLink",
].join(",");

const addressSchema = z.strictObject({
  name: z.string().nullable(),
  address: z.string().nullable(),
});

const summarySchema = z.strictObject({
  mailbox: z.string(),
  id: z.string(),
  folderId: z.string().nullable(),
  conversationId: z.string().nullable(),
  internetMessageId: z.string().nullable(),
  subject: z.string().nullable(),
  bodyPreview: z.string().nullable(),
  from: addressSchema.nullable(),
  to: z.array(addressSchema),
  cc: z.array(addressSchema),
  receivedAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  isRead: z.boolean(),
  isDraft: z.boolean(),
  hasAttachments: z.boolean(),
  importance: z.string().nullable(),
  webLink: z.string().nullable(),
});

const addressOf = (
  value: z.infer<typeof graphAddress>
): z.infer<typeof addressSchema> => ({
  name: value.emailAddress?.name ?? null,
  address: value.emailAddress?.address ?? null,
});

const addressesOf = (
  values: z.infer<typeof graphAddress>[] | null | undefined
): z.infer<typeof addressSchema>[] => (values ?? []).map(addressOf);

const summaryOf = (
  mailbox: string,
  message: GraphMessage
): z.infer<typeof summarySchema> => ({
  mailbox,
  id: message.id,
  folderId: message.parentFolderId ?? null,
  conversationId: message.conversationId ?? null,
  internetMessageId: message.internetMessageId ?? null,
  subject: message.subject ?? null,
  bodyPreview: message.bodyPreview ?? null,
  from: message.from ? addressOf(message.from) : null,
  to: addressesOf(message.toRecipients),
  cc: addressesOf(message.ccRecipients),
  receivedAt: message.receivedDateTime ?? null,
  sentAt: message.sentDateTime ?? null,
  isRead: message.isRead ?? false,
  isDraft: message.isDraft ?? false,
  hasAttachments: message.hasAttachments ?? false,
  importance: message.importance ?? null,
  webLink: message.webLink ?? null,
});

/** How a message's body comes back: as text, or as Graph has it (HTML). */
const bodyTypeSchema = z.enum(["text", "html"]);

/** Asks Graph for bodies of one type. */
const preferBody = (type: z.infer<typeof bodyTypeSchema>): HeadersInit => ({
  prefer: `outlook.body-content-type="${type}"`,
});

/** A search term for Graph's `$search`: no quote to end it early. */
const searchSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^"\\]*$/u);

const listMessages = defineTool({
  name: "mail.list",
  description:
    "Lists messages in a mailbox, newest first, or in one of its folders (a folder ID, or a well-known name such as inbox or archive), optionally filtered or searched.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    folder: idSchema.optional(),
    search: searchSchema.optional(),
    unreadOnly: z.boolean().optional(),
    receivedAfter: z.iso.datetime({ offset: true }).optional(),
    top: topSchema,
    page: pageSchema,
  }),
  output: z.strictObject({
    mailbox: z.string(),
    messages: z.array(summarySchema),
    nextPage: z.string().nullable(),
  }),
  readOnly: true,
  resource: "mailbox",
  routes: [get("/messages"), get("/mailFolders/{folder}/messages")],
  run: async ({
    mailbox,
    folder,
    search,
    unreadOnly,
    receivedAfter,
    top,
    page,
  }) => {
    const filtered = unreadOnly === true || receivedAfter !== undefined;
    if (search !== undefined && filtered) {
      throw new ToolError(
        "Microsoft 365 can't search and filter at once: search, or filter",
        { code: invalidCode }
      );
    }
    // Graph sorts by a filtered property only once it leads the filter.
    const filter = filtered
      ? [
          `receivedDateTime ge ${receivedAfter ?? "1900-01-01T00:00:00Z"}`,
          ...(unreadOnly === true ? ["isRead eq false"] : []),
        ].join(" and ")
      : undefined;
    const path =
      folder === undefined
        ? `/users/${segment(mailbox)}/messages`
        : `/users/${segment(mailbox)}/mailFolders/${segment(folder)}/messages`;
    const url = atPage(
      graphUrl(path, {
        $select: summaryFields,
        $top: String(top ?? 25),
        // Search results come by relevance, and can't be sorted.
        $orderby: search === undefined ? "receivedDateTime desc" : undefined,
        $filter: filter,
        $search: search === undefined ? undefined : `"${search}"`,
      }),
      page
    );
    const { value, "@odata.nextLink": nextLink } = await graphJson(
      url,
      pageOf(graphMessage)
    );
    return {
      output: {
        mailbox,
        messages: value.map((message) => summaryOf(mailbox, message)),
        nextPage: nextPageOf(nextLink),
      },
      provenance: value.map(({ id }) => id),
    };
  },
});

const graphAttachment = z.object({
  "@odata.type": z.string(),
  id: z.string(),
  name: z.string().nullish(),
  contentType: z.string().nullish(),
  size: z.number().int().nonnegative(),
  isInline: z.boolean().nullish(),
  contentBytes: z.string().nullish(),
});

/** What kind of attachment Graph says it is: a file, an item or a link. */
const kindOf = (odataType: string): "file" | "item" | "reference" | "other" => {
  switch (odataType) {
    case "#microsoft.graph.fileAttachment": {
      return "file";
    }
    case "#microsoft.graph.itemAttachment": {
      return "item";
    }
    case "#microsoft.graph.referenceAttachment": {
      return "reference";
    }
    default: {
      return "other";
    }
  }
};

const attachmentSchema = z.strictObject({
  id: z.string(),
  name: z.string().nullable(),
  contentType: z.string().nullable(),
  size: z.number(),
  isInline: z.boolean(),
  kind: z.enum(["file", "item", "reference", "other"]),
});

/** Attachment fields without their content. */
const attachmentFields = "id,name,contentType,size,isInline";

/** How many pages of a message's attachments mail.get reads at most. */
const attachmentPageLimit = 10;

/**
 * The attachments of the message at `path`, without their content, page
 * by page up to `attachmentPageLimit`, and whether Graph has more past
 * that. Each next page is asked for on the tool's own route with only
 * its position taken from Graph's `@odata.nextLink`, as mail.list does:
 * the link is never followed as a URL.
 */
const attachmentsOf = async (path: string) => {
  const attachments: z.infer<typeof graphAttachment>[] = [];
  let page: string | null | undefined;
  for (let read = 0; read < attachmentPageLimit && page !== null; read += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page's position is in the one before
    const { value, "@odata.nextLink": nextLink } = await graphJson(
      atPage(
        graphUrl(`${path}/attachments`, { $select: attachmentFields }),
        page
      ),
      pageOf(graphAttachment)
    );
    attachments.push(...value);
    page = nextPageOf(nextLink);
  }
  return { attachments, moreAttachments: page !== null };
};

const getMessage = defineTool({
  name: "mail.get",
  description:
    "Gets one message of a mailbox with its body, and its attachments' names, types and sizes (read one with mail.readAttachment). moreAttachments is true when the message has more attachments than are listed.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    message: idSchema,
    bodyType: bodyTypeSchema.optional(),
  }),
  output: z.strictObject({
    message: summarySchema.extend({
      body: z
        .strictObject({ contentType: z.string(), content: z.string() })
        .nullable(),
      bcc: z.array(addressSchema),
      replyTo: z.array(addressSchema),
      attachments: z.array(attachmentSchema),
      moreAttachments: z.boolean(),
    }),
  }),
  readOnly: true,
  resource: "mailbox",
  routes: [get("/messages/{message}"), get("/messages/{message}/attachments")],
  run: async ({ mailbox, message: id, bodyType }) => {
    const path = `/users/${segment(mailbox)}/messages/${segment(id)}`;
    const message = await graphJson(
      graphUrl(path, {
        $select: `${summaryFields},body,bccRecipients,replyTo`,
      }),
      graphMessage,
      { headers: preferBody(bodyType ?? "text") }
    );
    const { attachments, moreAttachments } = await attachmentsOf(path);
    return {
      output: {
        message: {
          ...summaryOf(mailbox, message),
          body: message.body ?? { contentType: "text", content: "" },
          bcc: addressesOf(message.bccRecipients),
          replyTo: addressesOf(message.replyTo),
          attachments: attachments.map((attachment) => ({
            id: attachment.id,
            name: attachment.name ?? null,
            contentType: attachment.contentType ?? null,
            size: attachment.size,
            isInline: attachment.isInline ?? false,
            kind: kindOf(attachment["@odata.type"]),
          })),
          moreAttachments,
        },
      },
      provenance: [message.id],
    };
  },
});

const readAttachment = defineTool({
  name: "mail.readAttachment",
  description:
    "Reads a file attachment of a message: as text, or as base64 to extract its content (a PDF, say). Up to 4 MiB.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    message: idSchema,
    attachment: idSchema,
    as: readAsSchema.optional(),
  }),
  output: z.strictObject({
    mailbox: z.string(),
    messageId: z.string(),
    id: z.string(),
    name: z.string().nullable(),
    contentType: z.string().nullable(),
    size: z.number(),
    encoding: readAsSchema,
    content: z.string().nullable(),
  }),
  readOnly: true,
  // A workflow action may keep it as a file of its run (GRA-886).
  answersFile: true,
  resource: "mailbox",
  routes: [get("/messages/{message}/attachments/{attachment}")],
  run: async ({ mailbox, message, attachment, as }) => {
    const path = `/users/${segment(mailbox)}/messages/${segment(message)}/attachments/${segment(attachment)}`;
    // Its size first: Graph sends the content inline, however large.
    const found = await graphJson(
      graphUrl(path, { $select: attachmentFields }),
      graphAttachment
    );
    checkReadable(found.size);
    const full = await graphJson(graphUrl(path), graphAttachment);
    const content = full.contentBytes ?? "";
    if (kindOf(full["@odata.type"]) !== "file" || content === "") {
      throw new ToolError("This attachment isn't a file", {
        code: "not_a_file",
      });
    }
    return {
      output: {
        mailbox,
        messageId: message,
        id: full.id,
        name: full.name ?? null,
        contentType: full.contentType ?? null,
        size: full.size,
        ...contentAs(fromBase64(content), as ?? "base64"),
      },
      provenance: [message],
    };
  },
});

const graphFolder = z.object({ id: z.string() });

const moveMessage = defineTool({
  name: "mail.move",
  description:
    "Moves a message to another folder of its mailbox (a folder ID, or a well-known name such as archive). The moved message has a new ID.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    message: idSchema,
    destination: idSchema,
  }),
  output: z.strictObject({
    mailbox: z.string(),
    previousId: z.string(),
    id: z.string(),
    folderId: z.string().nullable(),
  }),
  readOnly: false,
  destructive: true,
  resource: "mailbox",
  routes: [get("/mailFolders/{destination}"), post("/messages/{message}/move")],
  describe: {
    title: "Move an email to another folder",
    fields: [
      { label: "Mailbox", input: "mailbox" },
      { label: "Message", input: "message" },
      { label: "To folder", input: "destination" },
    ],
  },
  run: async ({ mailbox, message, destination }) => {
    // The destination is looked up in this mailbox first, on a route the
    // egress binds to it, and the message moved to the folder that names:
    // a folder of another mailbox is never a destination.
    const folder = await graphJson(
      graphUrl(
        `/users/${segment(mailbox)}/mailFolders/${segment(destination)}`,
        { $select: "id" }
      ),
      graphFolder
    );
    const moved = await graphJson(
      graphUrl(`/users/${segment(mailbox)}/messages/${segment(message)}/move`),
      graphMessage,
      jsonBody({ destinationId: folder.id })
    );
    return {
      output: {
        mailbox,
        previousId: message,
        id: moved.id,
        folderId: moved.parentFolderId ?? null,
      },
    };
  },
});

const recipientsSchema = z.array(z.email().max(256)).max(100);

/** A message to send or keep as a draft. */
const draftInput = z.strictObject({
  mailbox: mailboxSchema,
  subject: z.string().max(1024),
  body: z.string().max(1024 * 1024),
  bodyType: bodyTypeSchema.optional(),
  to: recipientsSchema.min(1),
  cc: recipientsSchema.optional(),
  bcc: recipientsSchema.optional(),
  replyTo: recipientsSchema.optional(),
  // Run files a workflow attaches (GRA-887), each by digest; their bytes
  // come beside the input, checked by the kit before the tool runs.
  attachments: attachmentsInput,
});

/**
 * A message as the person asked to confirm it reads it: every property of
 * {@link draftInput}, so nothing it sends goes unshown.
 */
const draftFields = [
  { label: "From", input: "mailbox" },
  { label: "To", input: "to" },
  { label: "Cc", input: "cc" },
  { label: "Bcc", input: "bcc" },
  { label: "Reply to", input: "replyTo" },
  { label: "Subject", input: "subject" },
  { label: "Body", input: "body" },
  { label: "Body format", input: "bodyType" },
  { label: "Attachments", input: "attachments" },
] as const;

/** Addresses as Graph takes them. */
const recipients = (addresses: string[] | undefined) =>
  (addresses ?? []).map((address) => ({ emailAddress: { address } }));

/**
 * A message as Graph takes it, tagged with the call's effect key if any,
 * and carrying its stamp as a header if any: Graph keeps the header on
 * every copy it delivers, so the copy a watched mailbox receives names the
 * run that sent it (core's workflows/mail-stamps.ts), whatever new ID it
 * gets there.
 */
const graphDraft = (
  {
    subject,
    body,
    bodyType,
    to,
    cc,
    bcc,
    replyTo,
    attachments,
  }: z.output<typeof draftInput>,
  effect: Effect
) => ({
  subject,
  body: { contentType: bodyType ?? "text", content: body },
  toRecipients: recipients(to),
  ccRecipients: recipients(cc),
  bccRecipients: recipients(bcc),
  replyTo: recipients(replyTo),
  // Inline file attachments, as Graph's JSON takes them: the name and type
  // are the run file's own (a name no folder or control character is in,
  // a type from a closed list) in JSON strings, the content base64.
  ...(attachments === undefined || attachments.length === 0
    ? {}
    : {
        attachments: attachedFiles(attachments, effect).map(
          ({ name, type, bytes }) => ({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name,
            contentType: type,
            contentBytes: toBase64(bytes),
          })
        ),
      }),
  ...(effect.stamp === null
    ? {}
    : {
        internetMessageHeaders: [{ name: stampHeader, value: effect.stamp }],
      }),
  ...(effect.key === null
    ? {}
    : {
        singleValueExtendedProperties: [
          { id: effectPropertyId, value: effect.key },
        ],
      }),
});

/** What a message found by its effect key tells of it. */
const foundMessage = z.object({
  id: z.string(),
  conversationId: z.string().nullish(),
  webLink: z.string().nullish(),
});

/**
 * The message in `mailbox`, in any folder, that a call with effect key
 * `key` made, if there is one. The key is 64 hex characters (connect
 * derives it, the kit checks it), so it can't break out of the filter's
 * string literal.
 */
const findByEffect = async (
  mailbox: string,
  key: string
): Promise<z.infer<typeof foundMessage> | undefined> => {
  const { value } = await graphJson(
    graphUrl(`/users/${segment(mailbox)}/messages`, {
      $filter: `singleValueExtendedProperties/Any(ep: ep/id eq '${effectPropertyId}' and ep/value eq '${key}')`,
      $select: "id,conversationId,webLink",
      $top: "1",
    }),
    pageOf(foundMessage)
  );
  return value[0];
};

const sendMail = defineTool({
  name: "mail.send",
  description:
    "Sends a message from a mailbox (the person's own, or a shared one they may send as), keeping a copy in its Sent Items.",
  input: draftInput,
  output: z.strictObject({ mailbox: z.string(), sent: z.literal(true) }),
  readOnly: false,
  destructive: false,
  takesFiles: true,
  resource: "mailbox",
  // Recovery `none`: a sent email of unknown outcome stays unknown. Not
  // finding its Sent Items copy doesn't prove it wasn't sent: a shared
  // mailbox's copy can land in the delegate's own mailbox, a copy can be
  // hard-deleted, Graph may not keep the tag on the copy, and `sendMail`
  // answers 202 before the copy is saved. Before this tool gets a `find`,
  // a live check (M365_SMOKE_WRITES) must show, for a person's own and a
  // shared mailbox: the copy carries the tag, it is found by it once the
  // claim timeout has passed, and where a delegate's copy lands. The tag
  // is kept on every send, so such a lookup can find it then.
  routes: [post("/sendMail")],
  describe: { title: "Send an email", fields: draftFields },
  run: async (input, effect) => {
    const response = await graphFetch(
      graphUrl(`/users/${segment(input.mailbox)}/sendMail`),
      jsonBody({
        message: graphDraft(input, effect),
        saveToSentItems: true,
      })
    );
    await response.body?.cancel();
    return { output: { mailbox: input.mailbox, sent: true as const } };
  },
});

const createDraft = defineTool({
  name: "mail.createDraft",
  description:
    "Creates a draft in a mailbox's Drafts folder, for a person to review and send.",
  input: draftInput,
  output: z.strictObject({
    mailbox: z.string(),
    id: z.string(),
    conversationId: z.string().nullable(),
    webLink: z.string().nullable(),
  }),
  readOnly: false,
  destructive: false,
  takesFiles: true,
  resource: "mailbox",
  routes: [get("/messages"), post("/messages")],
  describe: { title: "Create a draft email", fields: draftFields },
  run: async (input, effect) => {
    const draft = await graphJson(
      graphUrl(`/users/${segment(input.mailbox)}/messages`),
      graphMessage,
      jsonBody(graphDraft(input, effect))
    );
    return {
      output: {
        mailbox: input.mailbox,
        id: draft.id,
        conversationId: draft.conversationId ?? null,
        webLink: draft.webLink ?? null,
      },
    };
  },
  // Made, if a message with its key is in the mailbox: the draft, or the
  // message it became once a person sent it.
  find: async (input, effect) => {
    const draft = await findByEffect(input.mailbox, effect.key);
    return draft === undefined
      ? null
      : {
          output: {
            mailbox: input.mailbox,
            id: draft.id,
            conversationId: draft.conversationId ?? null,
            webLink: draft.webLink ?? null,
          },
        };
  },
});

export const mailTools = [
  listMessages,
  getMessage,
  readAttachment,
  moveMessage,
  sendMail,
  createDraft,
];
