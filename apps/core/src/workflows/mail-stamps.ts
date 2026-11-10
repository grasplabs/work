import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import { canonicalJson, isRecord } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import type { DeliveredConnectorEvent } from "@grasp-os/shared/workflows";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { connectionOwnersOf } from "../connections.ts";
import { resourceRunMailCalls, runMailStampClaims } from "../db/core/schema.ts";

// The runs a run's own mail starts, as its descendants. A run that mails
// an address an email trigger receives (inbound-email.ts), or a mailbox a
// connection watches (`m365.mail.received`, `google.mail.received`,
// connector-events.ts), starts a run without starting it itself: each
// would be a new root, with quotas of its own, so a workflow that mails
// itself, or two that mail each other, would run without end. So when a
// run's step sends mail (or makes a draft) through a native mail
// connector, the call carries a stamp of its own (128 random bits),
// recorded before the call leaves with every recipient the call names and
// its senders, the mailbox the call names and its connection's account
// (`resource_run_mail_calls`), and handed to connect beside the call
// (`ConnectCall`'s `stamp`), never in the input workflow code writes.
// Connect gives it to the native connector only, whose mail tool puts it
// on the message as a header (`stampHeader`), and both inbound mail and
// mail events read it back. A message that carries it starts its runs
// under the run (`stampedMessageRun`, `stampedEventRun`), admitted against
// its lineage's nesting and descendant limits (quotas.ts,
// `admitInLineage`), only when it is that mail. Anything else is mail like
// any other, a root.
//
// From the threat model, each way a run could launder its lineage, or
// anyone attach a run to another's, and what closes it:
//
// - A forged stamp: one core didn't record is nothing.
// - A recorded stamp, which every recipient of the run's mail can read,
//   taken to another address or mailbox: it counts only at one the call
//   named among its recipients, and only from one of the call's senders:
//   the envelope sender for inbound mail, which the sending domain's SPF
//   vouches for, never the From a message says.
// - A copy of it sent on by a recipient, its From forged, to a mailbox
//   the run mailed too (L2): it may be read with the run's own copy, in
//   the same read, and ahead of it. So up to `maxClaimsPerSource`
//   messages claim the stamp at each source (`run_mail_stamp_claims`),
//   each a child: a forged copy charges the run's lineage, never its
//   owner's escape, and the run's own copy is a child however the read
//   orders them. Past the bound a copy is a root, as anyone's mail is; a
//   sender who gets that many forged copies ahead of the run's own within
//   one read can still push it out, one hop, the residual case.
// - A plus-address (L1): a run that mails `watched+1@corp.com` mails the
//   watched mailbox, which Exchange Online and Google Workspace both
//   deliver it to. Recipients and the watched mailbox are compared without
//   a `+tag` (`mailboxOf`).
// - An SMTP alias (GRA-654): the account's own other addresses (its
//   primary address, `smtp:` proxy addresses), as its provider said when
//   it was connected (connect's account-addresses.ts), count as its
//   mailbox and as its senders. Addresses it may only send as (Google's
//   verified send-as addresses) count as its senders, never its mailbox:
//   one may receive in another mailbox. Read with the connection's token,
//   from the account's own profile: no workflow sets them, and an
//   unverified send-as address isn't one. A lookup that failed, or an alias added since, is no
//   address of its own: mail to it is a root, as before. Another
//   mailbox's aliases (a shared mailbox's, a list's) need directory
//   access, and aren't known.
// - Mail to several watched mailboxes, or one mailbox two connections
//   watch: each source claims for itself, so every copy is a child, and
//   none escapes as a root.
// - Another person's workflow: a run's own mail starts its runs under the
//   run in every workflow that watches the mailbox, whoever owns it. A run
//   whose lineage is spent mailing another person has that person's
//   watching workflow refused, audited against it. That is what bounds two
//   workflows of different owners mailing each other; a root there would
//   restart the loop with fresh limits.
// - A run sending its mail without the stamp: workflow code never sees the
//   header, the tools' input takes none, and a held send keeps its stamp
//   until its person confirms it (connect's pending.ts).
// - A repeat: a call's stamp is recorded the first time, and the same call
//   made again under its key carries the same stamp, so connect answers it
//   as that call.
// - A provider's delay: a stamp outlives it, as long as its run's details
//   are kept (retention.ts); a lineage grown too old refuses the run.
// - Another client's mail: a stamp is only this deployment's record.
//
// What it doesn't see, each a root still, bounded by each workflow's
// hourly limit (runs.ts): mail through a Composio toolkit (core can't
// tell its sends from its reads), mail a mailbox's own rules forward,
// mail a distribution list delivers to a watched mailbox (not a recipient
// the call names), mail to an alias of a mailbox other than the
// connection's own account's, a watched source naming another user's
// mailbox by its ID rather than an address, and events of other things a
// run made (files: connector events).

/** The run a stamp names: its ID, and the step key the call was made under. */
export interface StampingRun {
  run: string;
  stepKey: string;
}

/** The run a stamped message or event is the mail of. */
export interface StampedRun {
  runId: string;
}

/** A connection call, as core sends it to connect. */
export interface StampedCall {
  connectionId: string;
  action: string;
  input: Json;
}

/** The native mail connectors' actions that send mail, or draft it to send. */
const mailActions = new Set(["mail.send", "mail.createDraft"]);

/** The native connectors whose mail actions core stamps. */
const mailProviders = new Set(["microsoft", "google"]);

/** The recipient fields of those actions' input, each a list of addresses. */
const recipientFields = ["to", "cc", "bcc"] as const;

/** An address, alone. */
const addressText =
  /^(?<local>[A-Za-z0-9._'+-]{1,128})@(?<domain>[A-Za-z0-9.-]{1,253})$/u;

// `Array.isArray` doesn't narrow a readonly array type.
const isJsonArray = (value: Json | undefined): value is readonly Json[] =>
  Array.isArray(value);

/** `text` as an address, lower case; none if it isn't one. */
const addressOf = (text: string) => {
  const groups = addressText.exec(text.trim())?.groups;
  return groups?.local === undefined || groups.domain === undefined
    ? undefined
    : {
        local: groups.local.toLowerCase(),
        domain: groups.domain.toLowerCase(),
      };
};

/**
 * Who sends the mail of a call on `connectionId` naming `mailbox`: the
 * mailbox (the provider sends from it, or refuses the call), the
 * connection's account, that account's email address (for Microsoft 365
 * the primary address it sends from, which may differ from its sign-in
 * name: M-new-2), the other addresses it receives mail at (its SMTP
 * aliases) and those it may send as (Google's verified send-as
 * addresses), as its provider said when it was connected (GRA-654); none
 * for a connection that isn't a native mail connector's.
 *
 * Known gap: Microsoft 365 also takes another user's ID or UPN as the
 * mailbox (a shared mailbox named so), and sends from that mailbox's
 * primary address, which is none of these. A run's mail from such a
 * mailbox matches no sender and starts roots, bounded by each workflow's
 * hourly limit only: knowing another mailbox's addresses needs directory
 * access the connector doesn't ask for.
 */
const sendersOf = async (
  env: Env,
  connectionId: string,
  mailbox: Json | undefined
): Promise<string[] | undefined> => {
  const [owner] = await connectionOwnersOf(env, [connectionId]);
  if (
    owner === undefined ||
    owner.source !== "native" ||
    !mailProviders.has(owner.provider)
  ) {
    return undefined;
  }
  const senders = [
    typeof mailbox === "string" ? mailbox : null,
    owner.accountName,
    owner.accountEmail,
    // Those it receives at among them: Microsoft 365 lists each as both.
    // None from a connect deployed behind this core, which lacks the field.
    ...(owner.accountSenders ?? []),
  ].flatMap((sender) =>
    sender === null || sender.trim() === "" ? [] : [sender.trim().toLowerCase()]
  );
  return [...new Set(senders)];
};

/** A call as `run` sends it: its input, and the stamp it carries, if any. */
export interface StampedMail {
  input: Json;
  /** The call's stamp, for connect (`ConnectCall`'s `stamp`). */
  stamp?: string;
}

/** Random bytes in a call's stamp: 32 hex digits. */
const stampBytes = 16;

/**
 * `call` as `run` sends it. For a native mail connector's send or draft
 * naming any address in its `to`, `cc` or `bcc`: a stamp recorded with
 * those recipients and its senders before the call leaves, the same one
 * each time its step calls again, which its message carries as a header
 * (`ConnectCall`'s `stamp`). Its input unchanged, always.
 */
export const stampedMail = async (
  env: Env,
  stamping: StampingRun,
  call: StampedCall
): Promise<StampedMail> => {
  const { input } = call;
  if (!mailActions.has(call.action) || !isRecord(input)) {
    return { input };
  }
  const addresses = recipientFields.flatMap((field) => {
    const value = input[field];
    return isJsonArray(value)
      ? value.flatMap((item) => {
          const address =
            typeof item === "string" ? addressOf(item) : undefined;
          return address === undefined
            ? []
            : [`${address.local}@${address.domain}`];
        })
      : [];
  });
  if (addresses.length === 0) {
    return { input };
  }
  const db = drizzle(env.DB);
  const origin = await sha256Hex(
    JSON.stringify([
      stamping.stepKey,
      call.connectionId,
      call.action,
      canonicalJson(input),
    ])
  );
  const decidedOf = async () =>
    await db
      .select({ stamp: resourceRunMailCalls.stamp })
      .from(resourceRunMailCalls)
      .where(eq(resourceRunMailCalls.origin, origin))
      .get();
  let decided = await decidedOf();
  if (decided === undefined) {
    const senders = await sendersOf(env, call.connectionId, input.mailbox);
    if (senders === undefined) {
      // Not a native mail connector's: its tool puts no stamp on mail.
      return { input };
    }
    await db
      .insert(resourceRunMailCalls)
      .values({
        origin,
        runId: stamping.run,
        createdAt: new Date(),
        stamp: toHex(crypto.getRandomValues(new Uint8Array(stampBytes))),
        recipients: [...new Set(addresses)],
        senders,
      })
      .onConflictDoNothing();
    decided = await decidedOf();
  }
  if (decided === undefined) {
    throw new Error(`No mail decision of run ${stamping.run}`);
  }
  return { input, stamp: decided.stamp };
};

/**
 * The most messages that may claim one stamp at one source
 * (`run_mail_stamp_claims`), each then a child of the stamp's run. More
 * than one, so a copy a recipient sends on with its From forged, read
 * ahead of the run's own copy, can't push that copy out as a root; few,
 * so forged copies charge the run's lineage little. Past it a copy is a
 * root, as mail from anyone else is. Five covers a run's own copy read
 * behind four forged ones; a sender who gets five ahead of it within one
 * read is the residual case (GRA-550).
 */
const maxClaimsPerSource = 5;

/**
 * `address` as a mailbox receives it: lower case, without the `+tag` on
 * its local part, which Exchange Online and Google Workspace both deliver
 * to the mailbox itself. So a run that mails `watched+1@corp.com` mails
 * `watched@corp.com`, and its copy there is still its own.
 */
const mailboxOf = (address: string): string => {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at === -1) {
    return lower;
  }
  const local = lower.slice(0, at);
  const plus = local.indexOf("+");
  return `${plus <= 0 ? local : local.slice(0, plus)}${lower.slice(at)}`;
};

/** What a mail event's payload says of who sent it. */
const mailEventFrom = z.object({
  from: z.object({ address: z.string().max(256) }).nullish(),
});

/**
 * The addresses of the mailbox a connector event comes from: the one its
 * source names (`resource`); or, for a source on the whole connection or
 * one naming the account's own mailbox (by its name, one of its addresses
 * or its ID at the provider), all of the account's own: its name (for
 * Microsoft 365 its UPN), its email address and the other addresses it
 * receives mail at, its SMTP aliases (GRA-654).
 */
const mailboxAddressesOf = async (
  env: Env,
  event: DeliveredConnectorEvent
): Promise<string[]> => {
  const [owner] = await connectionOwnersOf(env, [event.connection]);
  const own = [
    owner?.accountName,
    owner?.accountEmail,
    ...(owner?.accountAddresses ?? []),
  ].flatMap((address) =>
    typeof address === "string" && address !== "" ? [address.toLowerCase()] : []
  );
  if (event.resource === undefined) {
    return own;
  }
  const resource = event.resource.toLowerCase();
  const isOwnId =
    typeof owner?.accountId === "string" &&
    owner.accountId.toLowerCase() === resource;
  return isOwnId || own.includes(resource) ? own : [resource];
};

/**
 * The mail call core recorded stamp `stamp` for
 * (`resource_run_mail_calls`), with every recipient it named and its
 * senders; none for a stamp core didn't record.
 */
const stampedCallOf = async (
  env: Pick<Env, "DB">,
  stamp: string
): Promise<
  (StampedRun & { recipients: string[]; senders: string[] }) | undefined
> => {
  const call = await drizzle(env.DB)
    .select({
      runId: resourceRunMailCalls.runId,
      recipients: resourceRunMailCalls.recipients,
      senders: resourceRunMailCalls.senders,
    })
    .from(resourceRunMailCalls)
    .where(eq(resourceRunMailCalls.stamp, stamp))
    .get();
  return call === undefined
    ? undefined
    : {
        runId: call.runId,
        recipients: call.recipients,
        senders: call.senders,
      };
};

/**
 * Whether message `eventKey` claims `stamp` at `source`: one of the first
 * {@link maxClaimsPerSource} messages there to name it
 * (`run_mail_stamp_claims`), the same message again included. Only while
 * the stamp's call is still recorded (one its run's retention removed
 * meanwhile leaves no claim behind that nothing would remove), and only
 * while the source has room: in the one statement, so of messages
 * delivered at once no more than the bound claim.
 */
const claimsStamp = async (
  env: Pick<Env, "DB">,
  stamp: string,
  source: string,
  eventKey: string
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const claimed = and(
    eq(runMailStampClaims.stamp, stamp),
    eq(runMailStampClaims.source, source)
  );
  const recorded = sql`EXISTS (SELECT 1 FROM ${resourceRunMailCalls} WHERE ${resourceRunMailCalls.stamp} = ${stamp})`;
  await db
    .insert(runMailStampClaims)
    .select(
      sql`SELECT ${stamp}, ${source}, ${eventKey}, ${Date.now()}
        WHERE ${recorded}
          AND (SELECT count(*) FROM ${runMailStampClaims} WHERE ${claimed}) < ${maxClaimsPerSource}`
    )
    .onConflictDoNothing();
  const claim = await db
    .select({ eventKey: runMailStampClaims.eventKey })
    .from(runMailStampClaims)
    .where(and(claimed, eq(runMailStampClaims.eventKey, eventKey)))
    .get();
  return claim !== undefined;
};

/**
 * The run whose own mail message `messageKey` to `address` is, by the
 * stamp it carries (`stamp`, its `stampHeader`), from the envelope sender
 * `from`: only when core recorded the stamp for a call that named
 * `address` among its recipients and `from` among its senders (which SPF
 * vouches for, unlike its From), and it is one of the first
 * {@link maxClaimsPerSource} messages at the address to name the stamp,
 * as at a watched mailbox (`stampedEventRun`). None otherwise: mail like
 * any other. So an independent workflow's mail to an email trigger's
 * address is a run of its own; a forged copy of a recorded stamp, from
 * one of its senders, charges that run's lineage, never escapes it, and
 * only so many do.
 */
export const stampedMessageRun = async (
  env: Pick<Env, "DB">,
  stamp: string | undefined,
  address: string,
  from: string,
  messageKey: string
): Promise<StampedRun | undefined> => {
  const call =
    stamp === undefined ? undefined : await stampedCallOf(env, stamp);
  if (
    stamp === undefined ||
    call === undefined ||
    !call.recipients.includes(address.toLowerCase()) ||
    !call.senders.includes(from.toLowerCase())
  ) {
    return undefined;
  }
  const source = JSON.stringify(["email", address.toLowerCase()]);
  return (await claimsStamp(env, stamp, source, messageKey))
    ? { runId: call.runId }
    : undefined;
};

/**
 * The run whose own mail a connector event is, if it is: a message that
 * reached a watched mailbox carrying the stamp core recorded for the run's
 * call (`stamp`, read from its header by connect), only when
 * - the mailbox is one the call named among its recipients: a stamp taken
 *   to any other mailbox is mail like any other;
 * - its From is one of the call's senders;
 * - it is one of the first {@link maxClaimsPerSource} messages at its
 *   source (connection and mailbox) to name the stamp
 *   (`run_mail_stamp_claims`): the same event delivered again is the same
 *   message, and any past the bound is mail like any other.
 * None otherwise: the event's runs are roots.
 */
export const stampedEventRun = async (
  env: Env,
  event: DeliveredConnectorEvent
): Promise<StampedRun | undefined> => {
  if (event.stamp === undefined) {
    return undefined;
  }
  const call = await stampedCallOf(env, event.stamp);
  if (call === undefined) {
    return undefined;
  }
  const { recipients, senders } = call;
  const from = mailEventFrom
    .safeParse(event.payload)
    .data?.from?.address.trim()
    .toLowerCase();
  if (from === undefined || !senders.includes(from)) {
    return undefined;
  }
  // By mailbox, plus-tags gone on both sides: a run that mails a
  // plus-address of a watched mailbox mails that mailbox (L1).
  const mailed = new Set(recipients.map(mailboxOf));
  const mailboxes = await mailboxAddressesOf(env, event);
  if (!mailboxes.some((mailbox) => mailed.has(mailboxOf(mailbox)))) {
    return undefined;
  }
  const source = JSON.stringify([event.connection, event.resource ?? ""]);
  const eventKey = await sha256Hex(
    JSON.stringify([event.connection, event.id])
  );
  return (await claimsStamp(env, event.stamp, source, eventKey))
    ? { runId: call.runId }
    : undefined;
};
