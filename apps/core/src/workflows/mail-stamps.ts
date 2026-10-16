import { connectErrors } from "@grasp-os/shared/connect";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { DeliveredConnectorEvent } from "@grasp-os/shared/workflows";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { connectionOwnersOf } from "../connections.ts";
import {
  mailDomains,
  runMailCalls,
  runMailStampClaims,
  runMailStamps,
} from "../db/core/schema.ts";

// The runs a run's own mail starts, as its descendants. A run that mails
// an address of the deployment's mail domain, which an email trigger
// receives (inbound-email.ts), starts a run without starting it itself:
// each would be a new root, with quotas of its own, so a workflow that
// mails itself, or two that mail each other, would run without end. So
// when a run's step sends mail (or makes a draft) through a native mail
// connector, core puts a token on each recipient of the mail domain in
// the call's `to`, `cc` and `bcc` (`local+<token>@domain`), recorded for
// the run before the call leaves (`run_mail_stamps`) with the address it
// went to and who sent it: the mailbox the call names and its
// connection's account. Mail back to a tokened address starts its runs
// under the run (runs.ts, `startRun`'s `parent`), admitted against its
// lineage's nesting and descendant limits (quotas.ts, `admitChild`), only
// when it is that mail: to the address the token was put on, its envelope
// sender one of the run's senders. Anything else is mail like any other,
// a root.
//
// From the threat model, each way a run could launder its lineage, or
// anyone attach a run to another's, and what closes it:
//
// - A forged token: a token counts only as core recorded it, and is 104
//   random bits: no sender guesses one. One core didn't record is part
//   of an address, which no one receives at.
// - A recorded token on another address (M1): it starts nothing under
//   the run; the message goes to the address it was sent to, a root.
// - A reply: a customer answering the run's mail, to all or to its
//   Reply-To (never tokened), sends from their own address, not the
//   run's: a root, keyed by its own Message-ID, so a second reply is a
//   second run, never taken for the first (H1).
// - A forged sender: only the envelope sender counts, which the sending
//   domain's SPF vouches for, never the From a message says. Mail from
//   the run's sender is keyed by the token and its Message-ID
//   (inbound-email.ts): the same message delivered again is one run, and
//   a new message from that mailbox (a person answering all from it) is
//   another run in the lineage, never swallowed by the first.
// - A run carrying another run's token: core puts its own on every
//   address it stamps, replacing any token it recorded already. A token
//   is the step's for one connection, mailbox and address: another
//   mailbox or connection in the step gets its own, with its own senders.
// - Mail sent to self, or two workflows mailing each other: each hop is a
//   run's send, stamped, so each run sits one deeper than the last, and
//   the lineage's nesting or descendant limit ends it. A run refused is
//   bounced, never left to be retried without end.
// - A provider's delay: a token outlives it, as long as its run's details
//   are kept (retention.ts); a lineage grown too old refuses the run.
// - A repeat after core learned more: a call's decision (which of its
//   recipients carry which token, none at all included) is recorded the
//   first time (`run_mail_calls`), and the same call made again under its
//   key sends the same input, so connect answers it as that call.
// - A call core can't read in full: there is no cap a call can hide
//   recipients past. Recipients past the most core stamps in one call
//   (`maxStampedAddresses`) refuse the call.
//
//
// A run's mail to a mailbox a connection watches (`m365.mail.received`,
// `google.mail.received`, connector-events.ts) reaches it under an ID of
// its own, through no address core reads. So each such call carries a
// stamp of its own too (`run_mail_calls`' `stamp`, 128 random bits),
// recorded before the call leaves with every recipient the call names and
// its senders, and handed to connect beside the call (`ConnectCall`'s
// `stamp`), never in the input App code writes. Connect gives it to the
// native connector only, whose mail tool puts it on the message as a
// header (`stampHeader`), and its mail events read it back. A message that
// carries it starts its runs under the run (`stampedEventRun`) only when
// it is that mail:
//
// - A forged stamp: one core didn't record is nothing.
// - A recorded stamp, which every recipient of the run's mail can read,
//   taken to another mailbox: it counts only at a mailbox the call named
//   among its recipients, and only from one of the call's senders.
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
//   one may receive in another mailbox. Read with the connection's token, from the account's own
//   profile: no App sets them, and an unverified send-as address isn't
//   one. A lookup that failed, or an alias added since, is no address of
//   its own: mail to it is a root, as before. Another mailbox's aliases
//   (a shared mailbox's, a list's) need directory access, and aren't
//   known.
// - Mail to several watched mailboxes, or one mailbox two connections
//   watch: each source claims for itself, so every copy is a child, and
//   none escapes as a root.
// - Another owner's App: a run's own mail starts its runs under the run in
//   every App that watches the mailbox, whoever owns it. A run whose
//   lineage is spent mailing another person has that person's watching
//   workflow refused, audited against their App. That is what bounds two
//   Apps of different owners mailing each other; a root there would
//   restart the loop with fresh limits.
// - A run sending its mail without the stamp: App code never sees the
//   header, the tools' input takes none, and a held send keeps its stamp
//   until its person confirms it (connect's pending.ts).
// - Another client's mail: a stamp is only this deployment's record.
//
// What it doesn't see, each a root still, bounded by each workflow's
// hourly limit (runs.ts): mail through a Composio toolkit (core can't
// tell its sends from its reads), mail to a domain Email Routing hasn't
// delivered for yet (a fresh deployment's first hop), mail a mailbox's
// own rules forward, mail a distribution list delivers to a watched
// mailbox (not a recipient the call names), mail to an alias of a mailbox
// other than the connection's own account's, a watched source naming
// another user's mailbox by its ID rather than an address, and events of
// other things a run made (files: connector events).

/** The run a stamp names: its ID, and the step key the call was made under. */
export interface StampingRun {
  run: string;
  stepKey: string;
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

/**
 * The most addresses of the mail domain one call may send to: past it the
 * call is refused, never sent with some unstamped.
 */
const maxStampedAddresses = 25;

/** Random bytes in a token: 26 hex digits. */
const tokenBytes = 13;

/** A local part ending in a token: `<base>+<token>`. */
const tokenedLocal = /^(?<base>.+)\+(?<token>[0-9a-f]{26})$/u;

/** An address, alone. */
const addressText =
  /^(?<local>[A-Za-z0-9._'+-]{1,128})@(?<domain>[A-Za-z0-9.-]{1,253})$/u;

// `Array.isArray` doesn't narrow a readonly array type.
const isJsonArray = (value: Json | undefined): value is readonly Json[] =>
  Array.isArray(value);

const isJsonObject = (
  value: Json
): value is Readonly<Record<string, Json | undefined>> =>
  typeof value === "object" && value !== null && !isJsonArray(value);

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

/** The address `local` at `domain` without a token of `recorded` on it. */
const baseOf = (
  { local, domain }: { local: string; domain: string },
  recorded: ReadonlySet<string>
): string => {
  const groups = tokenedLocal.exec(local)?.groups;
  const base =
    groups?.base !== undefined &&
    groups.token !== undefined &&
    recorded.has(groups.token)
      ? groups.base
      : local;
  return `${base}@${domain}`;
};

/** The tokens of `tokens` core recorded. */
const recordedTokens = async (
  env: Pick<Env, "DB">,
  tokens: readonly string[]
): Promise<Set<string>> => {
  if (tokens.length === 0) {
    return new Set();
  }
  const rows = await drizzle(env.DB)
    .select({ token: runMailStamps.token })
    .from(runMailStamps)
    .where(inArray(runMailStamps.token, tokens));
  return new Set(rows.map(({ token }) => token));
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

/**
 * The tokens of `run`'s mail to each of `addresses` (bases, at a mail
 * domain) through `connectionId`, by address: the same each time its step
 * calls again, recorded, in one batch, before they are used.
 */
const tokensFor = async (
  env: Pick<Env, "DB">,
  { run, stepKey }: StampingRun,
  {
    connectionId,
    mailbox,
  }: { connectionId: string; mailbox: Json | undefined },
  addresses: readonly string[],
  senders: readonly string[]
): Promise<Map<string, string>> => {
  const db = drizzle(env.DB);
  const now = new Date();
  const rows = await Promise.all(
    addresses.map(async (address) => ({
      token: toHex(crypto.getRandomValues(new Uint8Array(tokenBytes))),
      runId: run,
      origin: await sha256Hex(
        JSON.stringify([stepKey, connectionId, mailbox ?? null, address])
      ),
      address,
      senders: [...senders],
      createdAt: now,
    }))
  );
  const [first, ...rest] = rows.map((row) =>
    db.insert(runMailStamps).values(row).onConflictDoNothing()
  );
  if (first === undefined) {
    return new Map();
  }
  await db.batch([first, ...rest]);
  const recorded = await db
    .select({
      token: runMailStamps.token,
      runId: runMailStamps.runId,
      address: runMailStamps.address,
    })
    .from(runMailStamps)
    .where(
      inArray(
        runMailStamps.origin,
        rows.map(({ origin }) => origin)
      )
    );
  const tokens = new Map(
    recorded
      .filter(({ runId }) => runId === run)
      .map(({ address, token }) => [address, token])
  );
  if (addresses.some((address) => !tokens.has(address))) {
    throw new Error(`No mail stamp of run ${run}`);
  }
  return tokens;
};

/**
 * What `call`'s recipients (`recipients`) become, by each one that
 * changes: each address at a domain Email Routing delivered for carrying
 * the run's token (`local+<token>@domain`), any token core recorded on it
 * before replaced. None for a call that isn't a native mail connector's,
 * or mails no such address. Throws `connect.invalid` past
 * {@link maxStampedAddresses}.
 */
const replacementsOf = async (
  env: Env,
  stamping: StampingRun,
  { connectionId }: StampedCall,
  input: Readonly<Record<string, Json | undefined>>,
  recipients: readonly string[],
  senders: readonly string[] | undefined
): Promise<Record<string, string>> => {
  const domains = await drizzle(env.DB)
    .select({ domain: mailDomains.domain })
    .from(mailDomains);
  const ours = new Set(domains.map(({ domain }) => domain));
  const stamped = recipients.flatMap((text) => {
    const address = addressOf(text);
    return address !== undefined && ours.has(address.domain)
      ? [{ text, address }]
      : [];
  });
  if (stamped.length === 0) {
    return {};
  }
  if (
    new Set(stamped.map(({ address }) => `${address.local}@${address.domain}`))
      .size > maxStampedAddresses
  ) {
    throw connectErrors.create("connect.invalid");
  }
  if (senders === undefined) {
    return {};
  }
  const recorded = await recordedTokens(env, [
    ...new Set(
      stamped.flatMap(
        ({ address }) => tokenedLocal.exec(address.local)?.groups?.token ?? []
      )
    ),
  ]);
  const bases = [
    ...new Set(stamped.map(({ address }) => baseOf(address, recorded))),
  ];
  const tokens = await tokensFor(
    env,
    stamping,
    { connectionId, mailbox: input.mailbox },
    bases,
    senders
  );
  return Object.fromEntries(
    stamped.map(({ text, address }) => {
      const base = baseOf(address, recorded);
      const at = base.lastIndexOf("@");
      return [
        text,
        `${base.slice(0, at)}+${tokens.get(base) ?? ""}${base.slice(at)}`,
      ];
    })
  );
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
 * `call` as `run` sends it. For a native mail connector's send or draft:
 * each address of its `to`, `cc` and `bcc` at a domain Email Routing
 * delivered for carries the run's token (`local+<token>@domain`), any
 * token core recorded on it before replaced; and the call carries a stamp
 * of its own, recorded with every recipient it names and its senders,
 * which its message carries as a header (`ConnectCall`'s `stamp`). Every
 * other call, and every other field, unchanged: `call.input` itself when
 * nothing is. Throws `connect.invalid`, sending nothing, past
 * {@link maxStampedAddresses}.
 */
export const stampedMail = async (
  env: Env,
  stamping: StampingRun,
  call: StampedCall
): Promise<StampedMail> => {
  const { input } = call;
  if (!mailActions.has(call.action) || !isJsonObject(input)) {
    return { input };
  }
  const recipients = recipientFields.flatMap((field) => {
    const value = input[field];
    return isJsonArray(value)
      ? value.flatMap((item) => (typeof item === "string" ? [item] : []))
      : [];
  });
  const addresses = recipients.flatMap((item) => {
    const address = addressOf(item);
    return address === undefined ? [] : [`${address.local}@${address.domain}`];
  });
  if (addresses.length === 0) {
    return { input };
  }
  // The call's decision, the first time it was made: the same call made
  // again under its key sends the same input and stamp, whatever core
  // learned since (a mail domain it delivers for now), or connect refuses
  // it as another call under the key.
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
      .select({ replaced: runMailCalls.replaced, stamp: runMailCalls.stamp })
      .from(runMailCalls)
      .where(eq(runMailCalls.origin, origin))
      .get();
  let decided = await decidedOf();
  if (decided === undefined) {
    const senders = await sendersOf(env, call.connectionId, input.mailbox);
    const replaced = await replacementsOf(
      env,
      stamping,
      call,
      input,
      recipients,
      senders
    );
    await db
      .insert(runMailCalls)
      .values({
        origin,
        runId: stamping.run,
        replaced,
        createdAt: new Date(),
        // A stamp only for a native mail connector's call, whose tool
        // puts it on the message: core can't tell where else it goes.
        ...(senders === undefined
          ? {}
          : {
              stamp: toHex(crypto.getRandomValues(new Uint8Array(stampBytes))),
              recipients: [...new Set(addresses)],
              senders,
            }),
      })
      .onConflictDoNothing();
    decided = await decidedOf();
  }
  if (decided === undefined) {
    throw new Error(`No mail decision of run ${stamping.run}`);
  }
  const { replaced, stamp } = decided;
  return {
    input: {
      ...input,
      ...Object.fromEntries(
        recipientFields.flatMap((field) => {
          const value = input[field];
          return isJsonArray(value)
            ? [
                [
                  field,
                  value.map((item) =>
                    typeof item === "string" && Object.hasOwn(replaced, item)
                      ? (replaced[item] ?? item)
                      : item
                  ),
                ],
              ]
            : [];
        })
      ),
    },
    ...(stamp === null ? {} : { stamp }),
  };
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
): Promise<string | undefined> => {
  if (event.stamp === undefined) {
    return undefined;
  }
  const db = drizzle(env.DB);
  const call = await db
    .select({
      runId: runMailCalls.runId,
      recipients: runMailCalls.recipients,
      senders: runMailCalls.senders,
    })
    .from(runMailCalls)
    .where(eq(runMailCalls.stamp, event.stamp))
    .get();
  const recipients = call?.recipients ?? null;
  const senders = call?.senders ?? null;
  if (call === undefined || recipients === null || senders === null) {
    return undefined;
  }
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
  // Only while the call is still recorded (one its run's retention
  // removed meanwhile leaves no claim behind that nothing would remove),
  // and only while the source has room: in the one statement, so of
  // messages delivered at once no more than the bound claim.
  const claimed = and(
    eq(runMailStampClaims.stamp, event.stamp),
    eq(runMailStampClaims.source, source)
  );
  await db
    .insert(runMailStampClaims)
    .select(
      db
        .select({
          stamp: runMailCalls.stamp,
          source: sql<string>`${source}`.as("source"),
          eventKey: sql<string>`${eventKey}`.as("event_key"),
          createdAt: sql<Date>`${Date.now()}`.as("created_at"),
        })
        .from(runMailCalls)
        .where(
          and(
            eq(runMailCalls.stamp, event.stamp),
            sql`(SELECT count(*) FROM ${runMailStampClaims} WHERE ${claimed}) < ${maxClaimsPerSource}`
          )
        )
    )
    .onConflictDoNothing();
  const claim = await db
    .select({ eventKey: runMailStampClaims.eventKey })
    .from(runMailStampClaims)
    .where(and(claimed, eq(runMailStampClaims.eventKey, eventKey)))
    .get();
  return claim === undefined ? undefined : call.runId;
};

/** Records that Email Routing delivered mail for `domain`. */
export const learnMailDomain = async (
  env: Pick<Env, "DB">,
  domain: string
): Promise<void> => {
  await drizzle(env.DB)
    .insert(mailDomains)
    .values({ domain: domain.toLowerCase(), firstSeenAt: new Date() })
    .onConflictDoNothing();
};

/** A token core recorded, as mail to a tokened address names it. */
export interface MailStamp {
  token: string;
  run: string;
  /** The address the run mailed, without the token. */
  address: string;
  senders: string[];
}

/** Where mail to `local` goes, and the stamp it carries, if core recorded it. */
export interface MailRecipient {
  /** The local part that receives it: `local` without a recorded token. */
  local: string;
  stamp?: MailStamp;
}

/**
 * Where mail to `local` (a local part, lower case) goes: to the local part
 * without a token core recorded, with that token's stamp; to `local`
 * itself otherwise.
 */
export const mailRecipient = async (
  env: Pick<Env, "DB">,
  local: string
): Promise<MailRecipient> => {
  const groups = tokenedLocal.exec(local)?.groups;
  if (groups?.base === undefined || groups.token === undefined) {
    return { local };
  }
  const row = await drizzle(env.DB)
    .select({
      run: runMailStamps.runId,
      address: runMailStamps.address,
      senders: runMailStamps.senders,
    })
    .from(runMailStamps)
    .where(eq(runMailStamps.token, groups.token))
    .get();
  return row === undefined
    ? { local }
    : { local: groups.base, stamp: { token: groups.token, ...row } };
};

/**
 * `stamp` when mail to `address` from the envelope sender `from` is the
 * run's own mail it names: to the address the run mailed, from one of its
 * senders; none otherwise. Only the envelope sender, which SPF vouches
 * for: a message's From says whatever its sender wrote.
 */
export const runsOwnMail = (
  stamp: MailStamp | undefined,
  address: string,
  from: string
): MailStamp | undefined =>
  stamp !== undefined &&
  stamp.address === address.toLowerCase() &&
  stamp.senders.includes(from.toLowerCase())
    ? stamp
    : undefined;

/**
 * The lineage limit a refusal names (`workflow.lineage_limit`'s `limit`),
 * for the audit log; null for any other error.
 */
const lineageLimitOf = (error: unknown): string | null => {
  if (workflowErrors.codeOf(error) !== "workflow.lineage_limit") {
    return null;
  }
  const details =
    typeof error === "object" && error !== null && "details" in error
      ? error.details
      : undefined;
  return typeof details === "object" &&
    details !== null &&
    "limit" in details &&
    typeof details.limit === "string"
    ? details.limit
    : null;
};

/**
 * The receivers of a delivery whose start (`started`, in their order)
 * their lineage refused (`workflow.lineage_limit`), each with the limit
 * it names, for the audit log.
 */
export const lineageRefusals = <Receiver>(
  started: readonly PromiseSettledResult<unknown>[],
  receivers: readonly Receiver[]
): { receiver: Receiver; limit: string | null }[] =>
  started.flatMap((result, index) => {
    const receiver = receivers[index];
    if (result.status !== "rejected" || receiver === undefined) {
      return [];
    }
    const reason: unknown = result.reason;
    return workflowErrors.codeOf(reason) === "workflow.lineage_limit"
      ? [{ receiver, limit: lineageLimitOf(reason) }]
      : [];
  });
