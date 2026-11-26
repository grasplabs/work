import { tool, ToolError, v } from "@grasp-os/sdk/connector";

import { checkIds, effectTag, graphId, mailbox } from "./graph-sdk.ts";
import {
  Draft,
  findByEffect,
  messageRoute,
  messagesRoute,
  recipients,
  stampOf,
} from "./mail.ts";

// Reply drafts: a reply to one message of a mailbox, made in its
// conversation by Graph's `createReply` and left in the mailbox's Drafts
// for the person to send. Nothing here sends: the person does, from
// Outlook. Like users.messages.create, it stays in the mailbox, which may
// be a shared one the connection opens, so it reaches `company`.
//
// Whom it goes to is the call's args, so the person confirming the call
// sees it, and it can only be someone on the message replied to: its
// sender (or the address it asks replies to go to), and with `replyAll`
// also its To and Cc. The recipients are set on the draft as given, never
// left to Graph, so the draft goes to exactly whom the person was shown.

const replyRoute = "/users/{mailbox}/messages/{message}/createReply";

const Recipient = v.object({
  emailAddress: v
    .object({ address: v.string().nullable().optional() })
    .nullable()
    .optional(),
});

/** The people on the message replied to. */
const Original = v.object({
  from: Recipient.nullable().optional(),
  replyTo: v.array(Recipient).nullable().optional(),
  toRecipients: v.array(Recipient).nullable().optional(),
  ccRecipients: v.array(Recipient).nullable().optional(),
});

type Address = { emailAddress?: { address?: string | null } | null } | null;

/** Addresses as they compare: Exchange matches them case-insensitively. */
const addressesOf = (values: readonly (Address | undefined)[]): Set<string> =>
  new Set(
    values.flatMap((value) => {
      const address = value?.emailAddress?.address ?? "";
      return address === "" ? [] : [address.toLowerCase()];
    })
  );

/** A mailbox's reply drafts, by name, named from their route. */
export const mailReplyTools = {
  "users.messages.createReply.create": tool({
    description:
      "Creates a draft reply to one message of a mailbox, in its conversation, for a person to review and send from Outlook; it never sends. toRecipients is the message's sender (or its reply-to address); with replyAll, toRecipients and ccRecipients may also hold the message's other recipients. The comment goes above the quoted message.",
    readOnly: false,
    reach: "company",
    scopes: ["Mail.ReadWrite", "Mail.ReadWrite.Shared"],
    resource: "mailbox",
    mail: { recipients: ["toRecipients", "ccRecipients"] },
    // One write, and no send: Graph's `send` routes are never declared, so
    // the egress lets no call of this tool send anything. `createReply` with
    // the recipients set serves reply-all too, as one tool has one write.
    routes: [
      `POST ${replyRoute}`,
      `GET ${messageRoute}`,
      `GET ${messagesRoute}`,
    ],
    describe: {
      title: "Draft a reply to an email",
      fields: [
        { label: "From", arg: "mailbox" },
        { label: "In reply to", arg: "message" },
        { label: "Reply all", arg: "replyAll" },
        { label: "To", arg: "toRecipients" },
        { label: "Cc", arg: "ccRecipients" },
        { label: "Subject", arg: "subject" },
        { label: "Body", arg: "comment" },
      ],
    },
    args: {
      mailbox,
      message: graphId,
      replyAll: v.boolean().optional(),
      toRecipients: recipients.min(1),
      ccRecipients: recipients.optional(),
      subject: v.string().max(1024),
      comment: v.string().max(1024 * 1024),
    },
    returns: Draft,
    handler: async (
      {
        mailbox: mailboxId,
        message,
        replyAll,
        toRecipients,
        ccRecipients,
        subject,
        comment,
      },
      api,
      call
    ) => {
      checkIds({ message });
      const path = { mailbox: mailboxId, message };
      // The message replied to is read first, in this mailbox, to hold the
      // recipients to the people on it.
      const original = await api.get(messageRoute, {
        path,
        query: { $select: "from,replyTo,toRecipients,ccRecipients" },
        returns: Original,
      });
      const sender = addressesOf([original.from, ...(original.replyTo ?? [])]);
      const everyone = new Set([
        ...sender,
        ...addressesOf(original.toRecipients ?? []),
        ...addressesOf(original.ccRecipients ?? []),
      ]);
      const allowed = replyAll === true ? everyone : sender;
      const strangers = [...toRecipients, ...(ccRecipients ?? [])].filter(
        ({ emailAddress }) => !allowed.has(emailAddress.address.toLowerCase())
      );
      if (replyAll !== true && (ccRecipients ?? []).length > 0) {
        throw new ToolError("A reply has no Cc: reply to all for one", {
          code: "invalid",
        });
      }
      if (strangers.length > 0) {
        throw new ToolError(
          replyAll === true
            ? "A reply goes only to people on the message it replies to"
            : "A reply goes only to the message's sender: reply to all for its other recipients",
          { code: "invalid" }
        );
      }
      // Graph puts the comment above the quoted message; the draft carries
      // the call's effect key, as users.messages.create's does, so `find`
      // can look it up, and the run's stamp, so a watched mailbox's copy
      // names the run.
      return await api.post(replyRoute, {
        path,
        body: {
          comment,
          message: {
            subject,
            toRecipients,
            ccRecipients: ccRecipients ?? [],
            ...stampOf(call.stamp),
            ...effectTag(call.key),
          },
        },
        returns: Draft,
      });
    },
    // Made, if a message with its key is in the mailbox: the draft, or the
    // message it became once the person sent it.
    find: async ({ mailbox: mailboxId }, api, call) =>
      await findByEffect(api, mailboxId, call.key),
  }),
};
