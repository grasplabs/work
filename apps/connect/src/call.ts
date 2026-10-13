import {
  effectKeyMetaKey,
  findMetaKey,
  maxRetryAfterSeconds,
} from "@grasp-os/connector-kit/manifest";
import type { RecoveryMode } from "@grasp-os/connector-kit/manifest";
import type { CapabilityClaims } from "@grasp-os/shared/capability";
import { connectErrors } from "@grasp-os/shared/connect";
import type {
  ConnectCall,
  HeldOutcome,
  PendingReference,
} from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";
import { log } from "@grasp-os/shared/log";
import { redact } from "@grasp-os/shared/redact";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";

import {
  allowedTool,
  composioServer,
  usableConnection,
} from "./connections.ts";
import type { Connection } from "./connections.ts";
import { nativeAction, nativeRelease, nativeServer } from "./connectors.ts";
import {
  effectKeyOf,
  hashCall,
  idempotencyStore,
  recoveryWaitMs,
  replay,
} from "./idempotency.ts";
import type {
  IdempotencyScope,
  Repeat,
  Row,
  StoredAnswer,
} from "./idempotency.ts";
import { McpError } from "./mcp.ts";
import type {
  McpServer,
  McpServerTool,
  McpTool,
  McpToolResult,
} from "./mcp.ts";
import { hold, waitingUnder } from "./pending.ts";
import type { HeldAction } from "./pending.ts";
import {
  checkResourceScope,
  composioTool,
  didNothing,
  hasSideEffect,
  uncertainFailure,
  withProvenance,
} from "./policy.ts";

const retryAfterSchema = z.object({
  error: z.object({
    retryAfterSeconds: z.number().int().nonnegative().max(maxRetryAfterSeconds),
  }),
});

/**
 * `connect.server_unavailable` for a call its tool says did nothing, with
 * the wait the tool passed on, if it did (`{ error: { retryAfterSeconds } }`,
 * as the connector kit reports a provider's `retry-after`).
 */
const notPerformed = ({ output }: McpToolResult): Error => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = undefined;
  }
  const wait = retryAfterSchema.safeParse(parsed).data?.error.retryAfterSeconds;
  return connectErrors.create(
    "connect.server_unavailable",
    wait === undefined ? undefined : { retryAfterSeconds: wait }
  );
};

/** Most characters of a tool's error text connect logs. */
const maxLoggedErrorChars = 500;

/**
 * What a tool's error said, as the server sent it: each text block's own
 * text, or its structured content as JSON. Never the output as connect
 * stores it, where text is JSON-quoted once more and a credential's name
 * and quotes come escaped (`\"password\"`). Content other than text (an
 * image, a resource) is left out, and only noted.
 */
const errorParts = (output: string): string[] => {
  let said: unknown;
  try {
    said = JSON.parse(output);
  } catch {
    return [output];
  }
  if (typeof said === "string") {
    return [said];
  }
  if (!Array.isArray(said)) {
    return [output];
  }
  // Blocks as `resultOf` keeps them when not every one is text.
  const texts = said.flatMap((block: unknown) =>
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    block.type === "text" &&
    "text" in block &&
    typeof block.text === "string"
      ? [block.text]
      : []
  );
  return texts.length < said.length
    ? [...texts, "(content other than text)"]
    : texts;
};

/**
 * A tool's error as connect logs it: what it said ({@link errorParts}),
 * credentials redacted, then cut to {@link maxLoggedErrorChars}, so
 * neither a secret it echoed nor its size reaches the log.
 */
const loggedError = (output: string): string => {
  const redacted = redact(errorParts(output).join("\n"));
  return redacted.length > maxLoggedErrorChars
    ? `${redacted.slice(0, maxLoggedErrorChars)}…`
    : redacted;
};

/**
 * A call connect carried out, or answered from its stored answer: its
 * result, or the tool's error (`failed`), which goes back to the caller as
 * `connect.action_failed` once it is audited.
 */
export interface CallDone extends StoredAnswer {
  sideEffect: boolean;
  replayed: boolean;
  /** Stores a side effect's answer, in one batch with its audit events. */
  commit?: BatchItem<"sqlite">;
  /** Spends the key if that batch fails: the effect happened, unrecorded. */
  spend?: () => Promise<void>;
  /** Held for the person to confirm, not carried out. */
  pending?: PendingReference;
  /** How a call of unknown outcome was recovered, if it was. */
  recovery?: RecoveryMode;
  /** Its effect was found (recovery `find`): the answer is the original's. */
  reconciled?: boolean;
}

/** What a held call answers: nothing done yet. */
const heldAnswer: StoredAnswer = {
  result: { output: "null", provenance: [] },
  failed: false,
};

/**
 * How far a call got: whether its action has a side effect (once found),
 * whether it was answered as a repeat of an earlier call (`replayed`), and
 * whether it claimed its key to go out (`claimed`): from then on, an error
 * leaves its outcome unknown.
 */
export interface CallProgress extends Repeat {
  sideEffect?: boolean;
  claimed?: boolean;
  /** Set once a call of unknown outcome was taken up again to recover it. */
  recovery?: RecoveryMode;
}

type Input = Record<string, Json>;

/** Largest input a call may carry, in bytes of JSON. */
const maxInputBytes = 64 * 1024;

const isInput = (input: Json): input is Input =>
  typeof input === "object" && input !== null && !Array.isArray(input);

/** The tool's answer, as connect stores and returns it. */
const answerOf = ({
  output,
  provenance,
  isError,
}: McpToolResult): StoredAnswer => ({
  result: { output, provenance },
  failed: isError,
});

/** Finds the action's tool, exactly as named. */
const toolFor = async (
  server: McpServer,
  action: string
): Promise<McpServerTool> => {
  let tool: McpServerTool | undefined;
  try {
    tool = await server.tool(action);
  } catch (error) {
    if (error instanceof McpError) {
      throw connectErrors.create("connect.server_unavailable");
    }
    throw error;
  }
  if (tool === undefined) {
    throw connectErrors.create("connect.action_not_found");
  }
  return tool;
};

/**
 * The tool a call names, and how to reach its server. A native connector's
 * tool comes from its manifest, and its server (an isolate, with the
 * connection's token for its egress) is only opened once the call passed
 * every check. A Composio server is asked for its tools, and only for one
 * its admin allowed, which is what the admin's rule says it is.
 */
const actionFor = async (
  env: Env,
  connection: Connection,
  claims: CapabilityClaims,
  action: string
): Promise<{
  tool: McpTool;
  recovery: RecoveryMode;
  /** The native connector build that serves it (`nativeRelease`). */
  release: string | null;
  open: () => Promise<McpServer>;
  openLookup: () => Promise<McpServer>;
}> => {
  if (connection.serverKind === "native") {
    const native = nativeAction(connection, action);
    return {
      tool: native.tool,
      recovery: native.declared.recovery,
      release: await nativeRelease(native.connector),
      open: async () => await nativeServer(env, connection, native, claims),
      openLookup: async () =>
        await nativeServer(
          env,
          connection,
          native,
          claims,
          native.declared.routes.filter(({ method }) => method === "GET")
        ),
    };
  }
  // Only a tool the admin allowed, asked for before anything goes out,
  // and taken to be what the admin said it is.
  const rule = allowedTool(connection, action);
  if (rule === undefined) {
    throw connectErrors.create("connect.action_not_found");
  }
  const server = composioServer(env, connection);
  const tool = composioTool(await toolFor(server, action), rule);
  // A remote server's call of unknown outcome is never recovered: we
  // can't know what its tools do with a key, or whether a lookup is true.
  return {
    tool,
    recovery: "none",
    release: null,
    open: async () => await Promise.resolve(server),
    openLookup: async () => await Promise.resolve(server),
  };
};

/**
 * Whether a side effect waits for its person. One a person is there for
 * (`interactive`) waits for them to confirm it on a view of the exact
 * input (R7). So does every one of a context that read restricted data
 * (R12), whatever it is: what it sends may carry that data, so the person
 * it acts for decides, warned. Its reads of a native connector go on; on
 * Composio every call of such a context is a side effect (policy.ts). A
 * workflow run's other side effects come
 * from reviewed code or pass a decision, and run. The held action a
 * person just confirmed (`held`) runs.
 */
const mustHold = (
  { restricted, authority }: CapabilityClaims,
  held: HeldAction | undefined
): boolean =>
  held === undefined && (restricted || authority.mode === "interactive");

/**
 * The connection a call may use, as `usableConnection` says; for a held
 * action, only while it reaches the account it reached when the action was
 * held (CN15).
 */
export const connectionFor = async (
  env: Env,
  claims: CapabilityClaims,
  connectionId: string,
  held?: HeldAction
): Promise<Connection> => {
  const connection = await usableConnection(
    env.DB,
    connectionId,
    claims.authority.onBehalfOf
  );
  if (held !== undefined && connection.accountId !== held.accountId) {
    throw connectErrors.create("connect.connection_changed");
  }
  return connection;
};

/**
 * How the held call `claims` name ended, for a caller whose capability for
 * that call is verified: authorised now as the call itself would be, on a
 * connection it may use now, and for the resource the call was for.
 * Throws `connect.pending_not_found` when no such call was held or stored. `pendingActionId` is the held action, while it
 * waits.
 */
export const heldOutcome = async (
  env: Env,
  claims: CapabilityClaims
): Promise<{ outcome: HeldOutcome; pendingActionId?: string }> => {
  const { authority, connectionId, resource, action, idempotencyKey } = claims;
  if (idempotencyKey === null) {
    throw connectErrors.create("connect.invalid");
  }
  await connectionFor(env, claims, connectionId);
  const pendingActionId = await waitingUnder(env, claims);
  if (pendingActionId !== undefined) {
    return { outcome: { state: "waiting" }, pendingActionId };
  }
  const row = await idempotencyStore(
    env.DB,
    {
      subject: authority.subject,
      onBehalfOf: authority.onBehalfOf,
      connectionId,
      action,
      idempotencyKey,
      resource,
    },
    ""
  ).find();
  // Only the call for the resource this capability was checked for.
  if (row === undefined || row.resource !== resource) {
    throw connectErrors.create("connect.pending_not_found");
  }
  let answer: StoredAnswer;
  try {
    answer = replay(row, row.inputHash, Date.now());
  } catch (error) {
    const reason = connectErrors.codeOf(error);
    if (reason === "connect.declined") {
      return { outcome: { state: "declined" } };
    }
    // Confirmed, and being carried out now.
    if (reason === "connect.call_in_progress") {
      return { outcome: { state: "waiting" } };
    }
    if (reason === undefined) {
      throw error;
    }
    // Sent, and nobody can tell whether it took effect: never "failed",
    // which would read as "not done".
    if (reason === "connect.outcome_unknown") {
      return { outcome: { state: "unknown", reason } };
    }
    // Its answer is no longer kept.
    return { outcome: { state: "failed", reason, output: null } };
  }
  return {
    outcome: answer.failed
      ? {
          state: "failed",
          reason: "connect.action_failed",
          output: answer.result.output,
        }
      : { state: "done", result: answer.result },
  };
};

/**
 * Where a side effect's result is kept under its idempotency key, for a
 * call that has one. Work that may only read (`readOnly`) has no side
 * effects, so it has no stored results of one either: none is replayed to
 * it, whatever key it names.
 */
const scopeOf = (
  { authority, resource, idempotencyKey, readOnly }: CapabilityClaims,
  call: Omit<ConnectCall, "capability">
): IdempotencyScope | undefined =>
  idempotencyKey === null || readOnly
    ? undefined
    : {
        subject: authority.subject,
        onBehalfOf: authority.onBehalfOf,
        connectionId: call.connectionId,
        action: call.action,
        idempotencyKey,
        resource,
      };

type Store = ReturnType<typeof idempotencyStore>;

/**
 * When `replay` found the call of unknown outcome (`refusal` says so), the
 * row read again: its answer, if another call stored one in between (a
 * recovery that finished), as any repeat gets it; the row itself, for
 * recovery, only while it is still of unknown outcome. Undefined when
 * `refusal` says otherwise, or the row went.
 */
const unknownRow = async (
  store: Store | undefined,
  refusal: unknown,
  progress: CallProgress
): Promise<{ stored?: StoredAnswer; recovering?: Row } | undefined> => {
  if (
    store === undefined ||
    connectErrors.codeOf(refusal) !== "connect.outcome_unknown"
  ) {
    return undefined;
  }
  const row = await store.find();
  if (row === undefined) {
    return undefined;
  }
  try {
    return { stored: store.replayRow(row, progress) };
  } catch (error) {
    if (connectErrors.codeOf(error) === "connect.outcome_unknown") {
      return { recovering: row };
    }
    throw error;
  }
};

/**
 * What an earlier call under the same key says of this one: its answer,
 * for a repeat; the row of a call of unknown outcome a native connector's
 * call may recover (`recovering`); nothing, for a first call. Any other
 * refusal of the repeat is thrown. Only a native connector's call
 * recovers: a remote server's stays unknown, and isn't even asked for its
 * tools.
 */
const earlierCall = async (
  store: Store | undefined,
  connection: Connection,
  progress: CallProgress
): Promise<{ stored?: StoredAnswer; recovering?: Row }> => {
  try {
    return { stored: await store?.replay(progress) };
  } catch (error) {
    const read =
      connection.serverKind === "native"
        ? await unknownRow(store, error, progress)
        : undefined;
    if (read === undefined) {
      throw error;
    }
    return read;
  }
};

/**
 * Whether the call `row` records may be recovered now by `recovery`, or
 * else the `connect.outcome_unknown` to answer: with the wait until it may
 * be (`retryAfterSeconds`), or without, when it never may (no recovery, a
 * call its person must confirm, one another connector release claimed,
 * past the horizon). Another release may tag, find or repeat differently:
 * one that didn't tag yet would look for a tag that isn't there, and send.
 */
const requireRecoverable = (
  row: Row,
  {
    recovery,
    release,
    mustConfirm,
  }: { recovery: RecoveryMode; release: string | null; mustConfirm: boolean }
): void => {
  const recoverable =
    recovery !== "none" &&
    !mustConfirm &&
    release !== null &&
    row.connectorVersion === release;
  const waitMs = recoverable ? recoveryWaitMs(row, Date.now()) : null;
  if (waitMs === null) {
    throw connectErrors.create("connect.outcome_unknown");
  }
  if (waitMs > 0) {
    throw connectErrors.create("connect.outcome_unknown", {
      retryAfterSeconds: Math.min(
        Math.ceil(waitMs / 1000),
        maxRetryAfterSeconds
      ),
    });
  }
};

/**
 * Refuses a side effect of work that may only read (`readOnly`), before it
 * is held or run: a read can't turn into a change further on, whatever
 * the code that called it asks.
 */
const requireAllowedEffect = (
  { readOnly }: CapabilityClaims,
  sideEffect: boolean
): void => {
  if (sideEffect && readOnly) {
    throw connectErrors.create("connect.read_only");
  }
};

/** One call of a read, its answer as the tool gave it. */
const readOnce = async (
  connection: Connection,
  tool: McpTool,
  input: Input,
  open: () => Promise<McpServer>
): Promise<Omit<CallDone, "sideEffect">> => {
  // Every refusal is behind: only now may a token be read.
  const server = await open();
  let read: McpToolResult;
  try {
    read = withProvenance(
      connection,
      tool.name,
      await server.call(tool.name, input)
    );
  } catch (error) {
    throw error instanceof McpError
      ? connectErrors.create("connect.server_unavailable")
      : error;
  }
  if (didNothing(connection.serverKind, read)) {
    throw notPerformed(read);
  }
  return { ...answerOf(read), replayed: false };
};

/** A side effect about to go out under its claimed key. */
interface Sent {
  /** The call's capability ID, for what is logged of it. */
  callId: string;
  connection: Connection;
  tool: McpTool;
  input: Input;
  /** The call's `_meta`: its effect key, for a native connector. */
  meta: Record<string, Json> | undefined;
  store: Store;
  open: () => Promise<McpServer>;
  /** Its server for a lookup (`find`): the action's GET routes only. */
  openLookup: () => Promise<McpServer>;
}

/**
 * Sends a side effect whose key this call claimed, once, and reads how it
 * ended: its answer, stored with its audit events; the key spent when the
 * outcome is unknown; freed only when the call certainly did nothing.
 */
const sendClaimed = async (
  { callId, connection, tool, input, meta, store }: Sent,
  server: McpServer,
  recovering = false
): Promise<Omit<CallDone, "sideEffect">> => {
  let done: McpToolResult;
  try {
    done = withProvenance(
      connection,
      tool.name,
      await server.call(tool.name, input, meta)
    );
  } catch {
    // However the request failed, it may have reached the tool, and the
    // tool may have acted (mcp.ts `McpError`): the key is spent. Only a
    // native connector that says it did nothing frees it (below).
    await store.spend();
    throw connectErrors.create("connect.outcome_unknown");
  }
  // Its error is kept as the answer to every repeat, unless it leaves open
  // whether the write took effect (the tool says so, or it is a Composio
  // tool's, which can't tell): then, as for an answer lost on its way to
  // connect, the key is spent, and the error isn't kept, which would tell
  // every repeat the action failed when it may have happened.
  if (uncertainFailure(connection.serverKind, tool, done)) {
    if (done.isError && connection.serverKind === "composio") {
      // Nobody is told what it said, as it would read as a failure: kept
      // for whoever looks into the call, never replayed or audited.
      log.warn("connect.composio_error_unknown", {
        callId,
        connectionId: connection.id,
        action: tool.name,
        error: loggedError(done.output),
      });
    }
    await store.spend();
    throw connectErrors.create("connect.outcome_unknown");
  }
  // ...or the tool is one connect trusts to say it did nothing: then the
  // key is free, and the caller may try again. A recovery's send leaves
  // the call as it was, unknown, instead: the earlier send may still have
  // happened, and freeing the key would start the horizon of its first
  // claim (and its connector build) afresh.
  if (didNothing(connection.serverKind, done)) {
    await (recovering ? store.spend() : store.release());
    throw notPerformed(done);
  }
  const answer = answerOf(done);
  return {
    ...answer,
    replayed: false,
    commit: store.completion(answer),
    spend: store.spend,
  };
};

/**
 * Looks up the effect of a recovered call (recovery `find`) under its
 * retaken claim: its answer if it happened; undefined if the tool says it
 * certainly didn't, so the call may go out. Anything else (no answer, an
 * error, an outcome it can't tell) spends the key again, as unknown, with
 * a new claim time, so the next recovery waits a window of its own.
 */
const findEffect = async (
  connection: Connection,
  tool: McpTool,
  input: Input,
  meta: Record<string, Json>,
  server: McpServer,
  store: Store
): Promise<StoredAnswer | undefined> => {
  let found: McpToolResult;
  try {
    found = withProvenance(
      connection,
      tool.name,
      await server.call(tool.name, input, meta)
    );
  } catch {
    await store.spend();
    throw connectErrors.create("connect.outcome_unknown");
  }
  if (!found.isError) {
    return answerOf(found);
  }
  // Only "certainly not there", never "the lookup did nothing" (a
  // throttled GET), lets the call go out again.
  if (connection.serverKind === "native" && found.effectAbsent) {
    return undefined;
  }
  await store.spend();
  throw connectErrors.create("connect.outcome_unknown");
};

/**
 * Recovers a side effect of unknown outcome that `requireRecoverable`
 * let through: takes its key again (`retake`, so of two recoveries one
 * goes out), then sends it again (`repeat`), or looks its effect up first
 * (`find`): found, its answer is the call's; certainly absent, it is sent
 * under the same claim, from a fresh isolate with an egress window of its
 * own.
 */
const recover = async (
  sent: Sent,
  row: Row,
  recovery: RecoveryMode,
  progress: CallProgress
): Promise<Omit<CallDone, "sideEffect">> => {
  // Every refusal is behind: only now may a token be read. A lookup's
  // server lets only the action's GET routes out: a `find` that tried to
  // write would be refused at the egress, before anything left.
  const server = await (recovery === "find" ? sent.openLookup() : sent.open());
  await sent.store.retake(row);
  // A recovery may go out again: no repeat answered from the stored row.
  progress.replayed = undefined;
  progress.claimed = true;
  progress.recovery = recovery;
  if (recovery === "find") {
    const found = await findEffect(
      sent.connection,
      sent.tool,
      sent.input,
      { ...sent.meta, [findMetaKey]: true },
      server,
      sent.store
    );
    if (found !== undefined) {
      return {
        ...found,
        replayed: false,
        recovery,
        reconciled: true,
        commit: sent.store.completion(found),
        spend: sent.store.spend,
      };
    }
    // Claimed anew, while this call still holds it, right before it goes
    // out: a lookup that ran long sends nothing under a claim another took.
    const fresh = await sent.open();
    await sent.store.restamp();
    return { ...(await sendClaimed(sent, fresh, true)), recovery };
  }
  return { ...(await sendClaimed(sent, server, true)), recovery };
};

/**
 * Carries out one call whose capability is verified: `claims` say exactly
 * this connection, resource, action and idempotency key, for this subject
 * and person. A side effect a person is there for, or of a restricted
 * context, is held for the person instead (`pending`), unless it is the
 * held action `held` they just confirmed.
 * Throws a `connect.*` error when it refuses the call or the call fails;
 * `progress` says how far it got.
 */
export const carryOut = async (
  env: Env,
  claims: CapabilityClaims,
  call: Omit<ConnectCall, "capability">,
  progress: CallProgress,
  held?: HeldAction
): Promise<CallDone> => {
  const { authority, resource, idempotencyKey } = claims;
  const connection = await connectionFor(env, claims, call.connectionId, held);
  const { input } = call;
  // MCP tools take an object of arguments.
  if (!isInput(input)) {
    throw connectErrors.create("connect.invalid");
  }
  if (
    new TextEncoder().encode(JSON.stringify(input)).byteLength > maxInputBytes
  ) {
    throw connectErrors.create("connect.input_too_large");
  }
  // A repeat of a side effect gets its stored result before anything goes
  // out, not even a look at the server's tools.
  const inputHash = await hashCall(resource, input);
  const scope = scopeOf(claims, call);
  const store =
    scope === undefined
      ? undefined
      : idempotencyStore(env.DB, scope, inputHash);
  // Only a side effect has a stored row: one found makes this a repeat
  // (`progress.replayed`), answered or refused as the earlier call ended.
  // One of unknown outcome may yet be recovered (`recovering`), once its
  // action says how; the same input only, as `replay` checked first.
  const { stored, recovering } = await earlierCall(store, connection, progress);
  if (stored !== undefined) {
    progress.sideEffect = true;
    return { ...stored, sideEffect: true, replayed: true };
  }

  const { tool, recovery, release, open, openLookup } = await actionFor(
    env,
    connection,
    claims,
    call.action
  );
  const sideEffect = hasSideEffect(
    tool,
    connection.serverKind,
    claims.restricted
  );
  progress.sideEffect = sideEffect;
  requireAllowedEffect(claims, sideEffect);
  checkResourceScope(resource, tool, input);
  if (recovering !== undefined) {
    // Recovered only as the call itself would run now: every check above
    // has passed again (the capability core signed for this caller now,
    // the connection, the scope), never by a call a person must confirm,
    // which would be held anew instead.
    requireRecoverable(recovering, {
      recovery: sideEffect ? recovery : "none",
      release,
      mustConfirm: mustHold(claims, held),
    });
  }
  if (sideEffect && mustHold(claims, held)) {
    // A workflow run's key is its step's and never made by connect:
    // without one its side effect is refused, not held.
    if (idempotencyKey === null && authority.mode !== "interactive") {
      throw connectErrors.create("connect.idempotency_key_required");
    }
    const pending = await hold(env, claims, connection, {
      input,
      inputHash,
      idempotencyKey,
    });
    return { ...heldAnswer, sideEffect, replayed: false, pending };
  }

  if (!sideEffect) {
    return { ...(await readOnce(connection, tool, input, open)), sideEffect };
  }
  if (store === undefined || scope === undefined) {
    throw connectErrors.create("connect.idempotency_key_required");
  }
  // Native connectors only get the effect key: a remote server's tools
  // are code we don't review, and nothing is recovered there.
  const meta: Record<string, Json> | undefined =
    connection.serverKind === "native"
      ? { [effectKeyMetaKey]: await effectKeyOf(scope) }
      : undefined;
  const sent: Sent = {
    callId: claims.jti,
    connection,
    tool,
    input,
    meta,
    store,
    open,
    openLookup,
  };
  if (recovering !== undefined) {
    return {
      ...(await recover(sent, recovering, recovery, progress)),
      sideEffect,
    };
  }
  // Every refusal is behind: only now may a token be read.
  const server = await open();
  const earlier = await store.claim(progress, release);
  if (earlier !== undefined) {
    return { ...earlier, sideEffect, replayed: true };
  }
  // Claimed: the call may go out now, so whatever fails from here on
  // (spending or freeing the key included) leaves its outcome unknown.
  progress.claimed = true;
  return { ...(await sendClaimed(sent, server)), sideEffect };
};
