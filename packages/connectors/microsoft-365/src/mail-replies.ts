import {
  defineTool,
  invalidCode,
  ToolError,
} from "@grasp-os/connector-kit/connector";
import { stampHeader } from "@grasp-os/connector-kit/manifest";
import { jsonBody, segment } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

import {
  effectPropertyId,
  graphHost,
  graphJson,
  graphUrl,
  idSchema,
  mailboxSchema,
  v1,
} from "./graph.ts";
import { findByEffect, recipientsSchema } from "./mail.ts";

// Reply drafts: a reply to one message of a mailbox, made in its
// conversation by Graph's `createReply` and left in the mailbox's Drafts
// for the person to send. Nothing here sends: the person does, from
// Outlook. Like mail.createDraft, it stays in the mailbox, which may be a
// shared one the connection opens, so it reaches `company`.
//
// Whom it goes to is the call's input, so the person confirming the call
// sees it, and it can only be someone on the message replied to: its
// sender (or the address it asks replies to go to), and with `replyAll`
// also its To and Cc. The recipients are set on the draft as given, never
// left to Graph, so the draft goes to exactly whom the person was shown.

const users = `${v1}/users/{mailbox}`;

const graphAddress = z.object({
  emailAddress: z.object({ address: z.string().nullish() }).nullish(),
});

/** The people on the message replied to. */
const graphOriginal = z.object({
  from: graphAddress.nullish(),
  replyTo: z.array(graphAddress).nullish(),
  toRecipients: z.array(graphAddress).nullish(),
  ccRecipients: z.array(graphAddress).nullish(),
});

const graphReply = z.object({
  id: z.string(),
  conversationId: z.string().nullish(),
  webLink: z.string().nullish(),
});

const replyInput = z.strictObject({
  mailbox: mailboxSchema,
  message: idSchema,
  replyAll: z.boolean().optional(),
  to: recipientsSchema.min(1),
  cc: recipientsSchema.optional(),
  subject: z.string().max(1024),
  body: z.string().max(1024 * 1024),
});

const replyOutput = z.strictObject({
  mailbox: z.string(),
  inReplyTo: z.string(),
  id: z.string(),
  conversationId: z.string().nullable(),
  webLink: z.string().nullable(),
});

/** Addresses as they compare: Exchange matches them case-insensitively. */
const addressesOf = (
  values: (z.infer<typeof graphAddress> | null | undefined)[]
): Set<string> =>
  new Set(
    values.flatMap((value) => {
      const address = value?.emailAddress?.address ?? "";
      return address === "" ? [] : [address.toLowerCase()];
    })
  );

/** Addresses as Graph takes them. */
const recipients = (addresses: string[] | undefined) =>
  (addresses ?? []).map((address) => ({ emailAddress: { address } }));

const createReplyDraft = defineTool({
  name: "mail.createReplyDraft",
  description:
    "Creates a draft reply to one message of a mailbox, in its conversation, for a person to review and send from Outlook; it never sends. to is the message's sender (or its reply-to address); with replyAll, to and cc may also hold the message's other recipients. The body goes above the quoted message.",
  input: replyInput,
  output: replyOutput,
  readOnly: false,
  reach: "company",
  destructive: false,
  resource: "mailbox",
  // One write, and no send: Graph's `send` routes are never declared, so
  // the egress lets no call of this tool send anything. `createReply` with
  // the recipients set serves reply-all too, as one tool has one write.
  routes: [
    { method: "GET", host: graphHost, path: `${users}/messages` },
    { method: "GET", host: graphHost, path: `${users}/messages/{message}` },
    {
      method: "POST",
      host: graphHost,
      path: `${users}/messages/{message}/createReply`,
    },
  ],
  describe: {
    title: "Draft a reply to an email",
    fields: [
      { label: "From", input: "mailbox" },
      { label: "In reply to", input: "message" },
      { label: "Reply all", input: "replyAll" },
      { label: "To", input: "to" },
      { label: "Cc", input: "cc" },
      { label: "Subject", input: "subject" },
      { label: "Body", input: "body" },
    ],
  },
  run: async (
    { mailbox, message, replyAll, to, cc, subject, body },
    { key: effectKey, stamp }
  ) => {
    const path = `/users/${segment(mailbox)}/messages/${segment(message)}`;
    // The message replied to is read first, in this mailbox, to hold the
    // recipients to the people on it.
    const original = await graphJson(
      graphUrl(path, { $select: "from,replyTo,toRecipients,ccRecipients" }),
      graphOriginal
    );
    const sender = addressesOf([original.from, ...(original.replyTo ?? [])]);
    const everyone = new Set([
      ...sender,
      ...addressesOf(original.toRecipients ?? []),
      ...addressesOf(original.ccRecipients ?? []),
    ]);
    const allowed = replyAll === true ? everyone : sender;
    const strangers = [...to, ...(cc ?? [])].filter(
      (address) => !allowed.has(address.toLowerCase())
    );
    if (replyAll !== true && (cc ?? []).length > 0) {
      throw new ToolError("A reply has no Cc: reply to all for one", {
        code: invalidCode,
      });
    }
    if (strangers.length > 0) {
      throw new ToolError(
        replyAll === true
          ? "A reply goes only to people on the message it replies to"
          : "A reply goes only to the message's sender: reply to all for its other recipients",
        { code: invalidCode }
      );
    }
    // The body is Graph's `comment`, which it puts above the quoted
    // message; the draft carries the call's effect key, as
    // mail.createDraft's does, so `find` can look it up, and the run's
    // stamp, so a watched mailbox's copy names the run.
    const draft = await graphJson(
      graphUrl(`${path}/createReply`),
      graphReply,
      jsonBody({
        comment: body,
        message: {
          subject,
          toRecipients: recipients(to),
          ccRecipients: recipients(cc),
          ...(stamp === null
            ? {}
            : {
                internetMessageHeaders: [{ name: stampHeader, value: stamp }],
              }),
          ...(effectKey === null
            ? {}
            : {
                singleValueExtendedProperties: [
                  { id: effectPropertyId, value: effectKey },
                ],
              }),
        },
      })
    );
    return {
      output: {
        mailbox,
        inReplyTo: message,
        id: draft.id,
        conversationId: draft.conversationId ?? null,
        webLink: draft.webLink ?? null,
      },
    };
  },
  // Made, if a message with its key is in the mailbox: the draft, or the
  // message it became once the person sent it.
  find: async ({ mailbox, message }, effect) => {
    const draft = await findByEffect(mailbox, effect.key);
    return draft === undefined
      ? null
      : {
          output: {
            mailbox,
            inReplyTo: message,
            id: draft.id,
            conversationId: draft.conversationId ?? null,
            webLink: draft.webLink ?? null,
          },
        };
  },
});

export const mailReplyTools = [createReplyDraft];
