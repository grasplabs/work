import {
  attachedFiles,
  attachments,
  checkReadable,
  contentAs,
  fromBase64,
  page,
  tool,
  ToolError,
  v,
} from "@grasp-os/sdk/connector";
import type {
  Api,
  ConnectorTool,
  Infer,
  ToolArgs,
  ToolCall,
} from "@grasp-os/sdk/connector";

import { gmailHost, googleScope, nextOf } from "./google.ts";
import {
  attachmentsOf,
  bodyPartOf,
  headerSchema,
  partSchema,
  rawMessage,
  textOf,
} from "./mime.ts";
import type { Part } from "./mime.ts";

// Gmail, one mailbox per call, always as `/gmail/v1/users/{userId}` with
// the mailbox's address, never `me`, so a call's capability binds every
// request to its mailbox. Google lets a person's token reach their own
// mailbox only; the binding still holds each call to the one a permission
// names. Labels aren't a scope: a permission is for a whole mailbox.
// Reading, labelling and drafting stay in the person's own mailbox
// (`own`), unlike Microsoft's shared mailboxes; sending reaches whoever the
// message goes to (`others`).

const users = `${gmailHost}/gmail/v1/users/{userId}`;
const messages = `${users}/messages`;
const message = `${messages}/{id}`;
const attachment = `${messages}/{messageId}/attachments/{id}`;
const labels = `${users}/labels`;
const modify = `${message}/modify`;
const send = `${messages}/send`;
const drafts = `${users}/drafts`;

/** A mailbox: its address. Google's `me` alias isn't one. */
const userIdArg = v.string().max(256).email();

/** An ID Gmail gives a message. */
const idArg = v.string().min(1).max(1024);

/** Label IDs: system ones (`INBOX`, `UNREAD`) or the mailbox's own (`Label_12`). */
const labelIdsArg = v.array(v.string().min(1).max(128)).max(100).optional();

/** The headers a message's metadata is read with. */
const summaryHeaders = ["Subject", "From", "To", "Cc", "Message-ID"];

/** The headers a read of a whole message passes on. */
const messageHeaders = new Set(
  [...summaryHeaders, "Bcc", "Reply-To"].map((name) => name.toLowerCase())
);

/** A message as Gmail gives it, narrowed to what a summary says. */
const listedMessage = v.object({
  id: v.string(),
  threadId: v.string().optional(),
  labelIds: v.array(v.string()).optional(),
  snippet: v.string().optional(),
  internalDate: v.string().optional(),
  payload: v
    .object({
      mimeType: v.string().optional(),
      headers: v.array(headerSchema).optional(),
    })
    .optional(),
});
type ListedMessage = Infer<typeof listedMessage>;

/** A message as Gmail gives it with all its parts. */
const fullMessage = v.object({
  id: v.string(),
  threadId: v.string().optional(),
  labelIds: v.array(v.string()).optional(),
  snippet: v.string().optional(),
  internalDate: v.string().optional(),
  payload: partSchema.optional(),
});

/** How a message's body comes back: as its text part, or its HTML part. */
const bodyType = v.enum(["text", "html"]);

/** Messages a list returns unless asked for more. */
const defaultMaxResults = 10;

/** Message reads a list sends at once. */
const concurrentReads = 5;

/** A message's metadata, or `null` if it's gone since it was listed. */
const metadataOf = async (
  api: Api,
  userId: string,
  id: string
): Promise<ListedMessage | null> => {
  try {
    return await api.get(message, {
      path: { userId, id },
      query: { format: "metadata", metadataHeaders: summaryHeaders },
      returns: listedMessage,
    });
  } catch (error) {
    if (error instanceof ToolError && error.details?.code === "not_found") {
      return null;
    }
    throw error;
  }
};

/**
 * A part's bytes: inline, or fetched by the attachment ID this read of the
 * message gave it. Within the read limit by the size Gmail reports before
 * a fetch, and by the size of what came after it: the report is Gmail's
 * word, not the content.
 */
const partBytes = async (
  api: Api,
  userId: string,
  messageId: string,
  part: Part
): Promise<Uint8Array> => {
  const { attachmentId = "", data, size } = part.body ?? {};
  let encoded = data;
  if (encoded === undefined) {
    checkReadable(size ?? 0);
    ({ data: encoded } = await api.get(attachment, {
      path: { userId, messageId, id: attachmentId },
      returns: v.object({ data: v.string() }),
    }));
  }
  const bytes = fromBase64(encoded);
  checkReadable(bytes.byteLength);
  return bytes;
};

/** A message Gmail sent, made or relabelled, as it answers. */
const writtenMessage = v.object({
  id: v.string(),
  threadId: v.string().optional(),
  labelIds: v.array(v.string()).optional(),
});

const draft = v.object({ id: v.string(), message: writtenMessage });

const recipients = v.array(v.string().max(256).email()).max(100);

/** A message to send or keep as a draft. */
const outgoingArgs = {
  userId: userIdArg,
  subject: v.string().max(1024),
  body: v.string().max(1024 * 1024),
  bodyType: bodyType.optional(),
  to: recipients.min(1),
  cc: recipients.optional(),
  bcc: recipients.optional(),
  replyTo: recipients.optional(),
  attachments,
};

/**
 * A message as the person asked to confirm it reads it: every one of
 * {@link outgoingArgs}, so nothing it sends goes unshown.
 */
const outgoingFields = [
  { label: "From", arg: "userId" },
  { label: "To", arg: "to" },
  { label: "Cc", arg: "cc" },
  { label: "Bcc", arg: "bcc" },
  { label: "Reply to", arg: "replyTo" },
  { label: "Subject", arg: "subject" },
  { label: "Body", arg: "body" },
  { label: "Body format", arg: "bodyType" },
  { label: "Attachments", arg: "attachments" },
] as const;

/** Who a message goes to: what core records with a run's stamp. */
const outgoingMail = { recipients: ["to", "cc", "bcc"] } as const;

/**
 * The message as Gmail's `raw` takes it, from the mailbox itself, with
 * the call's stamp as a header if it has one: each copy Gmail delivers
 * keeps it, so the copy a watched mailbox receives names the run that sent
 * it (core's workflows/mail-stamps.ts).
 */
const rawOf = (
  args: ToolArgs<typeof outgoingArgs>,
  call: Pick<ToolCall, "stamp" | "files">
): string =>
  rawMessage({
    from: args.userId,
    subject: args.subject,
    body: args.body,
    bodyType: args.bodyType ?? "text",
    to: args.to,
    cc: args.cc ?? [],
    bcc: args.bcc ?? [],
    replyTo: args.replyTo ?? [],
    stamp: call.stamp,
    attachments: attachedFiles(args.attachments, call),
  });

export const gmailTools: Readonly<Record<string, ConnectorTool>> = {
  "gmail.users.messages.list": tool({
    description:
      "Lists messages in a mailbox, newest first, with their metadata: those with every label in labelIds (a label ID from gmail.users.labels.list, or a system one such as INBOX or UNREAD) and matching q, a Gmail search such as 'from:billing has:attachment after:2026/09/01'.",
    args: {
      userId: userIdArg,
      labelIds: labelIdsArg,
      q: v.string().min(1).max(512).optional(),
      maxResults: v.number().integer().min(1).max(25).optional(),
      pageToken: v.string().min(1).max(4096).optional(),
    },
    returns: page(listedMessage),
    readOnly: true,
    mail: true,
    reach: "own",
    resource: "userId",
    scopes: [googleScope("gmail.readonly")],
    // Gmail lists IDs only; each message's metadata is one more request.
    routes: [`GET ${messages}`, `GET ${message}`],
    handler: async (
      { userId, labelIds, q, maxResults = defaultMaxResults, pageToken },
      api
    ) => {
      const listed = await api.get(messages, {
        path: { userId },
        query: { maxResults, q, labelIds, pageToken },
        returns: v.object({
          messages: v.array(v.object({ id: v.string() })).optional(),
          nextPageToken: v.string().optional(),
        }),
      });
      // No more than a page, a few at a time; one deleted since it was
      // listed (404) is left out.
      const ids = (listed.messages ?? [])
        .slice(0, maxResults)
        .map(({ id }) => id);
      const items: ListedMessage[] = [];
      for (let start = 0; start < ids.length; start += concurrentReads) {
        // oxlint-disable-next-line no-await-in-loop -- a few reads at a time
        const read = await Promise.all(
          ids
            .slice(start, start + concurrentReads)
            .map(async (id) => await metadataOf(api, userId, id))
        );
        items.push(...read.filter((each) => each !== null));
      }
      return { items, next: nextOf(listed.nextPageToken) };
    },
  }),
  "gmail.users.messages.get": tool({
    description:
      "Gets one message of a mailbox with its headers, its body as text (bodyType html for its HTML part), and its attachments' parts, names, types and sizes (read one with gmail.users.messages.attachments.get). The body is null when the message has no text or HTML body.",
    args: { userId: userIdArg, id: idArg, bodyType: bodyType.optional() },
    returns: listedMessage.extend({
      body: v.object({ contentType: bodyType, content: v.string() }).nullable(),
      attachments: v.array(
        v.object({
          partId: v.string(),
          filename: v.string(),
          mimeType: v.string().nullable(),
          size: v.number(),
          isInline: v.boolean(),
        })
      ),
    }),
    readOnly: true,
    // One item's content: what the Brain keeps of a person's own (GRA-1730).
    answersItem: true,
    mail: true,
    reach: "own",
    resource: "userId",
    scopes: [googleScope("gmail.readonly")],
    routes: [`GET ${message}`, `GET ${attachment}`],
    handler: async ({ userId, id, bodyType: prefer = "text" }, api) => {
      const { payload, ...read } = await api.get(message, {
        path: { userId, id },
        query: { format: "full" },
        returns: fullMessage,
      });
      // A body too large for Gmail to send inline is fetched as its
      // attachments are, up to the same limit.
      const found = bodyPartOf(payload, prefer);
      const body =
        found === null
          ? null
          : {
              contentType: found.contentType,
              content: textOf(
                found.part,
                await partBytes(api, userId, read.id, found.part)
              ),
            };
      return {
        ...read,
        payload: {
          mimeType: payload?.mimeType,
          headers: payload?.headers?.filter(({ name }) =>
            messageHeaders.has(name.toLowerCase())
          ),
        },
        body,
        attachments: attachmentsOf(payload).map(
          ({ id: partId, name, contentType, size, isInline }) => ({
            partId,
            filename: name,
            mimeType: contentType,
            size,
            isInline,
          })
        ),
      };
    },
  }),
  "gmail.users.messages.attachments.get": tool({
    description:
      "Reads an attachment of a message by its partId (from gmail.users.messages.get): as text, or as base64 to extract its content (a PDF, say). Up to 4 MiB.",
    args: {
      userId: userIdArg,
      messageId: idArg,
      partId: v.string().min(1).max(64),
      as: v.enum(["text", "base64"]).optional(),
    },
    returns: v.object({
      /** The part, named apart from its message: `<messageId>/<partId>`. */
      id: v.string(),
      messageId: v.string(),
      partId: v.string(),
      name: v.string(),
      contentType: v.string().nullable(),
      size: v.number(),
      encoding: v.enum(["text", "base64"]),
      content: v.string(),
    }),
    readOnly: true,
    // One item's content: what the Brain keeps of a person's own (GRA-1730).
    answersItem: true,
    // A workflow action may keep it as a file of its run (GRA-886).
    answersFile: true,
    mail: true,
    reach: "own",
    resource: "userId",
    scopes: [googleScope("gmail.readonly")],
    routes: [`GET ${attachment}`, `GET ${message}`],
    handler: async ({ userId, messageId, partId, as = "base64" }, api) => {
      // The message first, for the part's name, size and current attachment
      // ID: Gmail's attachment IDs change on every read, its part IDs don't.
      const read = await api.get(message, {
        path: { userId, id: messageId },
        query: { format: "full" },
        returns: fullMessage,
      });
      const found = attachmentsOf(read.payload).find(
        (each) => each.id === partId
      );
      if (found === undefined) {
        throw new ToolError("This message has no such attachment", {
          code: "not_found",
        });
      }
      checkReadable(found.size);
      const bytes = await partBytes(api, userId, read.id, found.part);
      return {
        id: `${read.id}/${found.id}`,
        messageId: read.id,
        partId: found.id,
        name: found.name,
        contentType: found.contentType,
        size: bytes.byteLength,
        ...contentAs(bytes, as),
      };
    },
  }),
  "gmail.users.labels.list": tool({
    description:
      "Lists a mailbox's labels, system ones (INBOX, UNREAD) and its own, with the IDs gmail.users.messages.list and gmail.users.messages.modify.create take.",
    args: { userId: userIdArg },
    returns: page(
      v.object({
        id: v.string(),
        name: v.string(),
        type: v.string().optional(),
      })
    ),
    readOnly: true,
    mail: true,
    reach: "own",
    resource: "userId",
    scopes: [googleScope("gmail.readonly")],
    routes: [`GET ${labels}`],
    handler: async ({ userId }, api) => {
      const listed = await api.get(labels, {
        path: { userId },
        returns: v.object({
          labels: v
            .array(
              v.object({
                id: v.string(),
                name: v.string(),
                type: v.string().optional(),
              })
            )
            .optional(),
        }),
      });
      // Gmail answers every label at once.
      return { items: listed.labels ?? [], next: null };
    },
  }),
  "gmail.users.messages.modify.create": tool({
    description:
      "Adds labels to a message of a mailbox and removes others: to label it, mark it read (remove UNREAD) or move it (add a label, remove INBOX to archive). Adding SPAM also reports the message to Google as spam.",
    args: {
      userId: userIdArg,
      id: idArg,
      addLabelIds: labelIdsArg,
      removeLabelIds: labelIdsArg,
    },
    returns: writtenMessage,
    readOnly: false,
    mail: true,
    reach: "own",
    // Adding labels a message has and removing ones it lacks changes
    // nothing: sent again, it leaves the same labels (within the recovery
    // horizon, before people relabel it).
    repeatable: true,
    resource: "userId",
    scopes: [googleScope("gmail.modify")],
    routes: [`POST ${modify}`],
    describe: {
      title: "Change an email's labels",
      fields: [
        { label: "Mailbox", arg: "userId" },
        { label: "Message", arg: "id" },
        { label: "Add labels", arg: "addLabelIds" },
        { label: "Remove labels", arg: "removeLabelIds" },
      ],
    },
    handler: async (
      { userId, id, addLabelIds = [], removeLabelIds = [] },
      api
    ) => {
      if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
        throw new ToolError("Name a label to add or to remove", {
          code: "invalid",
        });
      }
      return await api.post(modify, {
        path: { userId, id },
        body: { addLabelIds, removeLabelIds },
        returns: writtenMessage,
      });
    },
  }),
  "gmail.users.messages.send.create": tool({
    description:
      "Sends a message from a mailbox, keeping a copy in its Sent label.",
    args: outgoingArgs,
    returns: writtenMessage,
    readOnly: false,
    takesFiles: true,
    mail: outgoingMail,
    reach: "others",
    resource: "userId",
    scopes: [googleScope("gmail.send")],
    routes: [`POST ${send}`],
    describe: { title: "Send an email", fields: outgoingFields },
    handler: async (args, api, call) =>
      await api.post(send, {
        path: { userId: args.userId },
        body: { raw: rawOf(args, call) },
        returns: writtenMessage,
      }),
  }),
  "gmail.users.drafts.create": tool({
    description:
      "Creates a draft in a mailbox, for a person to review and send.",
    args: outgoingArgs,
    returns: draft,
    readOnly: false,
    takesFiles: true,
    mail: outgoingMail,
    reach: "own",
    resource: "userId",
    scopes: [googleScope("gmail.modify")],
    routes: [`POST ${drafts}`],
    describe: { title: "Create a draft email", fields: outgoingFields },
    handler: async (args, api, call) =>
      await api.post(drafts, {
        path: { userId: args.userId },
        body: { message: { raw: rawOf(args, call) } },
        returns: draft,
      }),
  }),
};
