import type { ConnectResult } from "@grasp-os/shared/connect";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import type { Json } from "@grasp-os/shared/json";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  mailDomains,
  runEffectStamps,
  workflowRuns,
} from "../db/core/schema.ts";

// The runs a run's own effects start, as its descendants. A run can start
// runs without starting them itself: it mails an address of the
// deployment's mail domain, which an email trigger receives
// (inbound-email.ts), or it makes something through a connection (a
// message, a file) that a connection then reports as an event, which an
// event trigger hears (connector-events.ts). Each would be a new root,
// with quotas of its own, so a workflow that mails itself, or two that
// mail each other, would run without end. So every connection call a
// run's step makes, through its own connections, its App's or a
// connector resource, leaves a stamp naming the run (`run_effect_stamps`),
// and the run its effect starts is started under that run (runs.ts,
// `startRun`'s `parent`), admitted against its lineage's nesting and
// descendant limits (quotas.ts, `admitChild`).
//
// - Mail to the deployment's mail domain: core puts a token on each such
//   address in the call's input (`local+<token>@domain`), recorded for
//   the run before the call leaves. Email Routing hands the message to
//   core with that recipient, which no one but its sender chose.
// - What a call made: the ID its provider answered (the output's `id`),
//   recorded for the run once the call returns. A connection reports an
//   event of it under that ID.
//
// From the threat model, each way a run could launder its lineage, or
// anyone attach a run to another's, and what closes it:
//
// - A forged stamp: nothing a message or an event says is trusted on its
//   own. A token counts only as core recorded it, and is 104 random bits:
//   no sender guesses one. An item's ID is the provider's, of something
//   the run made: no one else can make another thing with it.
// - A token copied from mail a run sent (a recipient replying to, or
//   resending, the tokened address): the run its token starts is keyed by
//   the token (inbound-email.ts), so however many messages carry it, it
//   starts one run of each workflow, in the lineage of the run that sent
//   it: the one the run's own mail would have started. A copy can't add a
//   run to a lineage, nor take one out of it.
// - A run carrying another run's token: core puts its own on every
//   address it stamps, replacing any token it recorded already, so a run
//   that forwards to a tokened address starts its runs in its own lineage.
// - Mail sent to self, or two workflows mailing each other: each hop is a
//   run's call, stamped, so each run sits one deeper than the last, and
//   the lineage's nesting or descendant limit ends it.
// - A provider's delay: a stamp outlives it, as long as its run's details
//   are kept (retention.ts); a run started under a lineage that has grown
//   too old is refused, as any of its work is.
// - A lineage's limit reached: the trigger's delivery is settled, the run
//   refused and audited, never left to be retried without end.
// - An outside sender: unstamped mail and events stay roots, as before,
//   and mail that says it was sent automatically, or comes from the
//   deployment's own domain, still starts nothing (inbound-email.ts).
//
// What it doesn't see, each a root still: an address core can't recognise
// (inside raw MIME, a list in one string, mail to a domain Email Routing
// hasn't delivered for yet), mail through a connection to a mailbox a
// connection watches when the provider answers no ID of it (Microsoft
// Graph's sendMail), and mail a mailbox's own rules forward. Triggered
// starts stay bounded by each workflow's hourly limit (runs.ts).
//
// Core can't tell a call that sends from one that reads: connect knows
// which actions change something. So an address of the mail domain is
// stamped in any call's input, a search for it included. Every address
// there is core's own (Email Routing's catch-all), so outside core it is
// only ever a recipient, and mailboxes hold mail to it only in their sent
// items. Likewise a call's output `id` is recorded unless its provenance
// says the call read it.

/** The run a stamp names: its ID, and the step key the call was made under. */
export interface StampingRun {
  run: string;
  stepKey: string;
}

/** Random bytes in a mail token: 26 hex digits. */
const tokenBytes = 13;

/** A local part ending in a token: `<base>+<token>`. */
const tokenedLocal = /^(?<base>.+)\+(?<token>[0-9a-f]{26})$/u;

/** An address alone, or a name and an address in angle brackets. */
const addressText =
  /^(?<name>[^<>]*<)?(?<local>[A-Za-z0-9._'+-]{1,128})@(?<domain>[A-Za-z0-9.-]{1,253})(?<close>>)?$/u;

/** The most strings of an input core looks at for addresses. */
const maxScanned = 10_000;

/** The longest ID core records of what a call made. */
const maxItemIdLength = 1024;

/** The key of the item stamp of `id`. */
const itemKey = async (id: string): Promise<string> =>
  `item:${await sha256Hex(id)}`;

/** The key of the mail stamp of `token`. */
const mailKey = (token: string): string => `mail:${token}`;

// `Array.isArray` doesn't narrow a readonly array type.
const isJsonArray = (value: Json): value is readonly Json[] =>
  Array.isArray(value);

/** The values of `value`, an array's items or an object's. */
const childrenOf = (value: Json): Json[] => {
  if (isJsonArray(value)) {
    return [...value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).filter((item) => item !== undefined);
  }
  return [];
};

/** Every string of `value`, at most {@link maxScanned}. */
const stringsOf = (value: Json, found: string[] = []): string[] => {
  if (found.length >= maxScanned) {
    return found;
  }
  if (typeof value === "string") {
    found.push(value);
  }
  for (const item of childrenOf(value)) {
    stringsOf(item, found);
  }
  return found;
};

/** An address, as `addressOf` reads it. */
interface ReadAddress {
  /** The name before it and its `<`, when it has them. */
  name: string | undefined;
  local: string;
  domain: string;
}

/** The parts of `text` as an address, if it is one, lower case. */
const addressOf = (text: string): ReadAddress | undefined => {
  const groups = addressText.exec(text.trim())?.groups;
  // Brackets come in pairs, or not at all.
  const paired = (groups?.name === undefined) === (groups?.close === undefined);
  return groups?.local === undefined || groups.domain === undefined || !paired
    ? undefined
    : {
        name: groups.name,
        local: groups.local.toLowerCase(),
        domain: groups.domain.toLowerCase(),
      };
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
    .select({ key: runEffectStamps.key })
    .from(runEffectStamps)
    .where(inArray(runEffectStamps.key, tokens.map(mailKey)));
  return new Set(rows.map(({ key }) => key.slice("mail:".length)));
};

/** `local` without a token core recorded, of those `recorded`. */
const baseOf = (local: string, recorded: ReadonlySet<string>): string => {
  const groups = tokenedLocal.exec(local)?.groups;
  return groups?.base !== undefined &&
    groups.token !== undefined &&
    recorded.has(groups.token)
    ? groups.base
    : local;
};

/**
 * The token of `run`'s mail to `address` (a base, at a mail domain): the
 * same each time its step calls with it, recorded before it is used.
 */
const tokenFor = async (
  env: Pick<Env, "DB">,
  { run, stepKey }: StampingRun,
  address: string
): Promise<string> => {
  const db = drizzle(env.DB);
  const origin = await sha256Hex(JSON.stringify([stepKey, address]));
  const token = toHex(crypto.getRandomValues(new Uint8Array(tokenBytes)));
  await db
    .insert(runEffectStamps)
    .values({ key: mailKey(token), runId: run, origin, createdAt: new Date() })
    .onConflictDoNothing();
  const recorded = await db
    .select({ key: runEffectStamps.key })
    .from(runEffectStamps)
    .where(
      and(eq(runEffectStamps.origin, origin), eq(runEffectStamps.runId, run))
    )
    .get();
  if (recorded === undefined) {
    throw new Error(`No mail stamp of run ${run}`);
  }
  return recorded.key.slice("mail:".length);
};

/**
 * `input` as `run`'s call sends it: each string that is an address at a
 * domain Email Routing delivered for, or a name and one, carrying the
 * run's token (`local+<token>@domain`), any token core recorded on it
 * before replaced. Anything else unchanged; `input` itself when nothing
 * is.
 */
export const stampedInput = async (
  env: Pick<Env, "DB">,
  stamping: StampingRun,
  input: Json
): Promise<Json> => {
  const candidates = stringsOf(input).flatMap((text) => {
    const address = addressOf(text);
    return address === undefined ? [] : [{ text, address }];
  });
  if (candidates.length === 0) {
    return input;
  }
  const db = drizzle(env.DB);
  const domains = await db
    .select({ domain: mailDomains.domain })
    .from(mailDomains)
    .where(
      inArray(mailDomains.domain, [
        ...new Set(candidates.map(({ address }) => address.domain)),
      ])
    );
  const ours = new Set(domains.map(({ domain }) => domain));
  const stamped = candidates.filter(({ address }) => ours.has(address.domain));
  if (stamped.length === 0) {
    return input;
  }
  const recorded = await recordedTokens(
    env,
    stamped.flatMap(({ address }) => {
      const token = tokenedLocal.exec(address.local)?.groups?.token;
      return token === undefined ? [] : [token];
    })
  );
  const replaced = new Map<string, string>();
  for (const { text, address } of stamped) {
    const local = baseOf(address.local, recorded);
    // oxlint-disable-next-line no-await-in-loop -- one address at a time, few
    const token = await tokenFor(env, stamping, `${local}@${address.domain}`);
    const tokened = `${local}+${token}@${address.domain}`;
    replaced.set(
      text,
      address.name === undefined ? tokened : `${address.name}${tokened}>`
    );
  }
  const rewrite = (value: Json): Json => {
    if (typeof value === "string") {
      return replaced.get(value) ?? value;
    }
    if (isJsonArray(value)) {
      return value.map(rewrite);
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, item]): [string, Json][] =>
          item === undefined ? [] : [[key, rewrite(item)]]
        )
      );
    }
    return value;
  };
  return rewrite(input);
};

/**
 * Records what `run`'s call made, by the ID its provider answered: its
 * output's `id`, unless the call only read it (its provenance names it).
 * The first run to record an ID keeps it.
 */
export const stampOutput = async (
  env: Pick<Env, "DB">,
  { run }: StampingRun,
  result: ConnectResult
): Promise<void> => {
  if (result.pending !== undefined) {
    return;
  }
  let output: unknown;
  try {
    output = JSON.parse(result.output);
  } catch {
    return;
  }
  const id =
    typeof output === "object" &&
    output !== null &&
    !Array.isArray(output) &&
    "id" in output
      ? output.id
      : undefined;
  if (
    typeof id !== "string" ||
    id === "" ||
    id.length > maxItemIdLength ||
    result.provenance.includes(id)
  ) {
    return;
  }
  await drizzle(env.DB)
    .insert(runEffectStamps)
    .values({ key: await itemKey(id), runId: run, createdAt: new Date() })
    .onConflictDoNothing();
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

/** The run a stamp names, with the row it still has; none for no stamp. */
const stampedRun = async (
  env: Pick<Env, "DB">,
  key: string
): Promise<string | undefined> => {
  const row = await drizzle(env.DB)
    .select({ run: workflowRuns.id })
    .from(runEffectStamps)
    .innerJoin(workflowRuns, eq(workflowRuns.id, runEffectStamps.runId))
    .where(eq(runEffectStamps.key, key))
    .get();
  return row?.run;
};

/** Where a message to `local` goes, and the run that stamped it, if one did. */
export interface MailRecipient {
  /** The address that receives it: `local` without the token. */
  address: string;
  /** The run that sent it, and its token. */
  stamp?: { run: string; token: string };
}

/**
 * Where mail to `local` (a local part, lower case) goes: to the address
 * without a token core recorded, sent by the run that recorded it; to
 * `local` itself otherwise.
 */
export const mailRecipient = async (
  env: Pick<Env, "DB">,
  local: string
): Promise<MailRecipient> => {
  const groups = tokenedLocal.exec(local)?.groups;
  if (groups?.base === undefined || groups.token === undefined) {
    return { address: local };
  }
  const run = await stampedRun(env, mailKey(groups.token));
  return run === undefined
    ? { address: local }
    : { address: groups.base, stamp: { run, token: groups.token } };
};

/** The run that made what a provider's `id` names, if a run did. */
export const itemStampedRun = async (
  env: Pick<Env, "DB">,
  id: string
): Promise<string | undefined> =>
  id === "" || id.length > maxItemIdLength
    ? undefined
    : await stampedRun(env, await itemKey(id));

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
 * The receivers of a trigger's delivery whose start (`started`, in their
 * order) their lineage refused (`workflow.lineage_limit`), each with the
 * limit it names, for the audit log.
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
