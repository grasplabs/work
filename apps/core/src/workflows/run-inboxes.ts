import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import type { EventIngressKind } from "@grasp-os/shared/workflow-resources";
import { eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";

import { signInConfig } from "../auth/config.ts";
import { runInboxes } from "../db/core/schema.ts";
import { derivedHmacKey } from "../derived-keys.ts";
import { resolveCatalogKeys } from "../workflow-catalog.ts";
import type { CallingRun } from "./resource-authority.ts";

// A run's inboxes (GRA-1560): where outsiders send its events, for an
// event binding whose pinned contract takes a type from outside
// (`ingress`): replies to mail the run sent, at `reply-<token>@<host>`
// (the deployment's own hostname, which the router already sends its mail
// to), which the workflow gives that mail as Reply-To. The workflow reads
// it as `inbox.<alias>`. What arrives is admitted as an App screen's event
// is (run-events.ts, `admitRunEvent`): through that binding, as its
// contract's type, its data checked, its authority read again. Threat
// model, written before the code, and how each is closed:
//
// - Guessing an inbox. A token is 128 bits of an HMAC under a key of
//   core's own (`derivedHmacKey`, from the deployment's auth secret), of
//   the run, the binding and its generation: nobody without that key can
//   make one, and no two runs or bindings share one.
// - A token leaking from core's database, its backups or its exports. It
//   is never stored: a row keeps its SHA-256 alone (`run_inboxes`), which
//   is looked up by its primary key (`inboxAt`), and taken only while the
//   key still derives it for its run and binding. The run's code gets it
//   recomputed from the key (`inboxOf`), never read back. Rotating the
//   auth secret changes every token, and leaves every reply address
//   already handed out dead, as it does webhook triggers' secrets; a run
//   then reads no address for that binding, never one nobody has.
// - Someone who sees a token (whoever the mail reached, a forward, a mail
//   hop's logs, the run's viewers) sending events. Accepted, as for any
//   reply, and bounded: they reach one run, through one binding, as its
//   contract's one outside type, with data checked against it and nothing
//   evaluated, and only while the run hasn't ended: its address still
//   takes mail after that, until the run's details go, but the run takes
//   no new event (below). Who may send
//   is the contract's to say (`ingress`), and the admin approving the
//   binding is told (workflow-binding-requests.ts). Each reply is
//   audited with its run and binding, and fills only its binding's share
//   of the run's inbox (`inbox:<alias>`), never an App screen's. The From
//   header is a claim: a reply carries what Email Routing found of SPF,
//   DKIM and DMARC (`emailReplyData`, authentication-results.ts), for the
//   workflow to check; core refuses none on it.
// - A reply after its run ended, or once its binding's approval went:
//   dropped and audited, never bounced (inbound-email.ts,
//   `receiveReply`), the authority read again on every reply; one the run
//   took before it ended, delivered again, is still the event it took.
// - A token guessed, or one whose run's details are gone: no inbox has
//   it, and mail to it is rejected at SMTP time, so nothing bounces.
// - A builder taking a run's replies by naming an email trigger
//   `reply-<token>` after seeing an address in a trace: that shape is
//   reserved (`replyLocalPattern`, email-addresses.ts) and no trigger may
//   take it.
// - Inboxes a run never had: rows are written only in the batch that
//   admits the run (`inboxesAdmitted`, the start's `alsoAdmitted`), for
//   the bindings its start froze, so no later call adds one; one goes
//   with the run's details (retention.ts), after which its address is
//   unknown.
// - A test run's mail reaching anyone: a test run of a draft gets
//   placeholders on `.invalid` (`inboxOf`) and no rows, as its calls are
//   answered from its fixtures and go nowhere.
// - A replay seeing other values: a token depends only on the run, the
//   binding and the generation, so every activation recomputes the same.

const tokenPurpose = "grasp-os run inbox token";

/**
 * Which token of a binding a run's code gets. A run's tokens are never
 * reissued, so each is the first; one reissued would take the next, and
 * the old one would no longer hash to its row.
 */
const tokenGeneration = 1;

/** Bytes of the HMAC a token keeps: 128 bits. */
const tokenBytes = 16;

/** A run inbox's token, as its address carries it: 128 bits, in hex. */
export const runInboxTokenPattern = /^[0-9a-f]{32}$/u;

/** What a run's reply address's local part starts with, before its token. */
export const replyPrefix = "reply-";

/**
 * A run's reply address's local part: `reply-` and its token. Reserved:
 * no email trigger takes a name of this shape (email-addresses.ts).
 */
export const replyLocalPattern = /^reply-[0-9a-f]{32}$/u;

/** The host a test run's inboxes are on: one that never resolves (RFC 6761). */
const placeholderHost = "run-inbox.invalid";

/** The token of binding `binding` of run `runId`: derived, never stored. */
const tokenOf = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  runId: string,
  binding: string
): Promise<string> => {
  const key = await derivedHmacKey(env, tokenPurpose, ["sign"]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${runId}\n${binding}\n${tokenGeneration}`)
  );
  return toHex(new Uint8Array(mac, 0, tokenBytes));
};

/** The reply address with `token`, on `host`. */
const replyAddressOf = (token: string, host: string): string =>
  `${replyPrefix}${token}@${host}`;

/** A test run's placeholder for a reply address. */
const placeholder = replyAddressOf("0".repeat(tokenBytes * 2), placeholderHost);

/**
 * The deployment's own hostname, which every reply address is on: none
 * while it has none, when no mail reaches it and no run has an inbox.
 */
const hostOf = (env: Env): string | undefined => {
  const origin = signInConfig(env)?.origin;
  return origin === undefined ? undefined : new URL(origin).hostname;
};

/** An event binding, by the contract it pinned. */
interface EventBinding {
  readonly alias: string;
  readonly kind: string;
  readonly contractId: string;
  readonly fingerprint: string;
}

/**
 * The event bindings of `bindings` whose pinned contract, by its
 * fingerprint, takes a type from outside, each with that type and where
 * from.
 */
const ingressBindings = async (
  env: Env,
  bindings: Iterable<EventBinding>
): Promise<{ alias: string; type: string; ingress: EventIngressKind }[]> => {
  const events = [...bindings].filter(({ kind }) => kind === "event");
  if (events.length === 0) {
    return [];
  }
  const contracts = await resolveCatalogKeys(
    env,
    events.map(({ contractId }) => contractId)
  );
  return events.flatMap(({ alias, contractId, fingerprint }) => {
    const contract = contracts.get(contractId);
    if (contract?.fingerprint !== fingerprint) {
      return [];
    }
    const outside = Object.entries(contract.contract.events ?? {}).find(
      ([, type]) => type.ingress !== undefined
    );
    const ingress = outside?.[1].ingress;
    return outside === undefined || ingress === undefined
      ? []
      : [{ alias, type: outside[0], ingress }];
  });
};

/**
 * The type contract `contractId`, by its fingerprint, takes from outside,
 * and where from, if it takes one: a contract takes at most one.
 */
export const ingressTypeOf = async (
  env: Env,
  binding: { contractId: string; fingerprint: string }
): Promise<{ type: string; ingress: EventIngressKind } | undefined> => {
  const [found] = await ingressBindings(env, [
    { ...binding, alias: "", kind: "event" },
  ]);
  return found === undefined
    ? undefined
    : { type: found.type, ingress: found.ingress };
};

/**
 * Where outsiders send events through contract `contractId`, by its
 * fingerprint, if any of its types is taken from outside.
 */
export const ingressOf = async (
  env: Env,
  binding: { contractId: string; fingerprint: string }
): Promise<EventIngressKind | undefined> => {
  const found = await ingressTypeOf(env, binding);
  return found?.ingress;
};

/**
 * The inboxes of run `runId` of workflow `workflowId`, as statements its
 * start's admitting batch runs (`alsoAdmitted`), each only once its run
 * is `admitted`: one for each of `bindings` (what its start froze) that
 * takes events from outside, by its token's hash.
 */
export const inboxesAdmitted = async (
  env: Env,
  run: {
    runId: string;
    workflowId: string;
    bindings: Iterable<EventBinding>;
  }
): Promise<(admitted: SQL) => BatchItem<"sqlite">[]> => {
  const inboxes =
    hostOf(env) === undefined ? [] : await ingressBindings(env, run.bindings);
  const rows = await Promise.all(
    inboxes.map(async ({ alias }) => ({
      tokenHash: await sha256Hex(await tokenOf(env, run.runId, alias)),
      binding: alias,
    }))
  );
  return (admitted) => {
    if (rows.length === 0) {
      return [];
    }
    const db = drizzle(env.DB);
    return [
      db
        .insert(runInboxes)
        .select(
          sql`SELECT json_extract(value, '$.tokenHash'), ${run.runId}, ${run.workflowId},
            json_extract(value, '$.binding'), ${Date.now()}
            FROM json_each(${JSON.stringify(rows)}) WHERE ${admitted}`
        )
        .onConflictDoNothing(),
    ];
  };
};

/**
 * What a run's code reads as `inbox`: each of its inboxes by its binding's
 * alias, its reply address, recomputed from core's key on every
 * activation, so a replay reads the same. One whose token no longer
 * hashes to its row (core's auth secret rotated since the start) is left
 * out, never handed out as an address nobody has. A test run of a draft
 * (`calling.candidate`) gets a placeholder on `.invalid` for each binding
 * that would have one, and has no rows.
 */
export const inboxOf = async (
  env: Env,
  run: { runId: string; calling: Pick<CallingRun, "candidate"> }
): Promise<Readonly<Record<string, string>>> => {
  const { candidate } = run.calling;
  if (candidate !== undefined) {
    const inboxes = await ingressBindings(
      env,
      [...candidate].map(([alias, binding]) => ({ ...binding, alias }))
    );
    return Object.freeze(
      Object.fromEntries(inboxes.map(({ alias }) => [alias, placeholder]))
    );
  }
  const host = hostOf(env);
  if (host === undefined) {
    return Object.freeze({});
  }
  const rows = await drizzle(env.DB)
    .select({ binding: runInboxes.binding, tokenHash: runInboxes.tokenHash })
    .from(runInboxes)
    .where(eq(runInboxes.runId, run.runId));
  const entries = await Promise.all(
    rows.map(async ({ binding, tokenHash }) => {
      const token = await tokenOf(env, run.runId, binding);
      if ((await sha256Hex(token)) !== tokenHash) {
        log.warn("workflow.inbox_unkeyed", { run: run.runId, binding });
        return [];
      }
      return [[binding, replyAddressOf(token, host)] as const];
    })
  );
  return Object.freeze(Object.fromEntries(entries.flat()));
};

/** Whether tokens `presented` and `derived` are the same, in constant time. */
const sameToken = (presented: string, derived: string): boolean => {
  const encoder = new TextEncoder();
  const left = encoder.encode(presented);
  const right = encoder.encode(derived);
  return (
    left.byteLength === right.byteLength &&
    crypto.subtle.timingSafeEqual(left, right)
  );
};

/** A run inbox, as a token names it. */
export interface RunInbox {
  readonly runId: string;
  readonly workflowId: string;
  readonly binding: string;
}

/**
 * The inbox `token` names, by its hash; none for a token that isn't one's
 * (never minted, or gone with its run's details), or isn't the one core's
 * key derives for it now: rotating the auth secret revokes every token
 * already handed out, as its row would still match it.
 */
export const inboxAt = async (
  env: Env,
  token: string
): Promise<RunInbox | undefined> => {
  if (!runInboxTokenPattern.test(token)) {
    return undefined;
  }
  const row = await drizzle(env.DB)
    .select({
      runId: runInboxes.runId,
      workflowId: runInboxes.workflowId,
      binding: runInboxes.binding,
    })
    .from(runInboxes)
    .where(eq(runInboxes.tokenHash, await sha256Hex(token)))
    .get();
  return row === undefined ||
    !sameToken(token, await tokenOf(env, row.runId, row.binding))
    ? undefined
    : row;
};
