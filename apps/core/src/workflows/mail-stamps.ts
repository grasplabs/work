import { connectErrors } from "@grasp-os/shared/connect";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { connectionOwnersOf } from "../connections.ts";
import { mailDomains, runMailCalls, runMailStamps } from "../db/core/schema.ts";

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
// What it doesn't see, each a root still, bounded by each workflow's
// hourly limit (runs.ts): mail through a Composio toolkit (core can't
// tell its sends from its reads), mail to a domain Email Routing hasn't
// delivered for yet (a fresh deployment's first hop), mail a mailbox's
// own rules forward, and events of what a run made (connector events,
// GRA-550).

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
 * mailbox (the provider sends from it, or refuses the call) and the
 * connection's account; none for a connection that isn't a native mail
 * connector's.
 *
 * Known gap (GRA-550): Microsoft 365 takes a user's ID or UPN as the
 * mailbox, and sends from their primary address, which may be neither. A
 * run's mail from such a mailbox then matches no sender and starts roots,
 * bounded by each workflow's hourly limit only, as before stamping. The
 * provider's real sending address is what to record instead.
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
  ].flatMap((sender) =>
    sender === null || sender === "" ? [] : [sender.toLowerCase()]
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
  recipients: readonly string[]
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
  const senders = await sendersOf(env, connectionId, input.mailbox);
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

/**
 * `call`'s input as `run` sends it: for a native mail connector's send or
 * draft, each address of its `to`, `cc` and `bcc` at a domain Email
 * Routing delivered for carries the run's token (`local+<token>@domain`),
 * any token core recorded on it before replaced. Every other call, and
 * every other field, unchanged: `call.input` itself when nothing is.
 * Throws `connect.invalid`, sending nothing, past
 * {@link maxStampedAddresses}.
 */
export const stampedMail = async (
  env: Env,
  stamping: StampingRun,
  call: StampedCall
): Promise<Json> => {
  const { input } = call;
  if (!mailActions.has(call.action) || !isJsonObject(input)) {
    return input;
  }
  const recipients = recipientFields.flatMap((field) => {
    const value = input[field];
    return isJsonArray(value)
      ? value.flatMap((item) => (typeof item === "string" ? [item] : []))
      : [];
  });
  if (recipients.every((item) => addressOf(item) === undefined)) {
    return input;
  }
  // The call's decision, the first time it was made: the same call made
  // again under its key sends the same input, whatever core learned since
  // (a mail domain it delivers for now), or connect refuses it as another
  // call under the key.
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
      .select({ replaced: runMailCalls.replaced })
      .from(runMailCalls)
      .where(eq(runMailCalls.origin, origin))
      .get();
  let decided = await decidedOf();
  if (decided === undefined) {
    const replaced = await replacementsOf(
      env,
      stamping,
      call,
      input,
      recipients
    );
    await db
      .insert(runMailCalls)
      .values({ origin, runId: stamping.run, replaced, createdAt: new Date() })
      .onConflictDoNothing();
    decided = await decidedOf();
  }
  if (decided === undefined) {
    throw new Error(`No mail decision of run ${stamping.run}`);
  }
  const { replaced } = decided;
  return {
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
  };
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
