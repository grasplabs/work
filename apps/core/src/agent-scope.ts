import { agentErrors } from "@grasp-os/shared/agent";
import { delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditDetailValue, AuditEntry } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { ChatId, WorkspaceId } from "@grasp-os/shared/ids";
import {
  authoritySchema,
  permissionErrors,
} from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { and, eq, gte, isNotNull, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { keepAuditEvent } from "./audit-outbox.ts";
import { permissions } from "./db/core/schema.ts";
import { workspace } from "./durable-objects.ts";
import type { WorkContext } from "./restricted.ts";

// What every API of a chat's code (agent-apis.ts) knows of the call: who
// the agent acts for and where, which code run made it, and whether that
// run is still open. Core sets it in each stub's props; the code can call
// the stub but never read or change them.

/** Whom and where an agent's code acts for, as core sets it. */
export interface AgentScope {
  /** The Workspace object that holds the chat. */
  workspaceId: WorkspaceId;
  /**
   * The agent that acts, as the chat stored it: the organization's agent
   * admins grant to, whichever object holds the chat (a person's own, say).
   */
  agentId: string;
  chatId: ChatId;
  /** The person the chat belongs to, whom the agent acts for. */
  personId: string;
  /** The code run the stub was made for: it answers only while that runs. */
  runId: string;
}

/** One typed API the agent's code can call. */
export interface AgentApi {
  /** Its name in the code's `env`: a JavaScript identifier. */
  name: string;
  /**
   * The types its declaration names, declared before `interface Env`, with
   * their doc comments: names no other API declares.
   */
  types?: string;
  /**
   * What the model sees: members of `interface Env`, with their doc
   * comments.
   */
  declaration: string;
  /** Its stub for one code run. */
  stub: (scope: AgentScope) => Fetcher;
}

/**
 * An agent's ID: letters, digits and `-` only (as the organization's ID,
 * every chat's agent, is), so it reads the same in a permission, an audit
 * event and a memory path (`agents/<id>/AGENTS.md`), and never reaches
 * into another's.
 */
export const workspaceAgentIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/u);

/**
 * The chat's agent, acting for the chat's person: the one acting on every
 * call its code makes, in the audit log and in every permission check. One
 * agent for the whole organization (`chatAgentId` in chats-rpc.ts), so
 * what an admin grants it holds in everyone's chats, whichever person's
 * Workspace object holds them; each chat still keeps
 * its own sources, restricted mode and code runs (the chat is the context,
 * `chatContext`). Its permissions are the agent's own, and every one
 * reaches only as far as the person may go themselves.
 */
export const chatAuthority = ({
  agentId: stored,
  personId,
}: Pick<AgentScope, "agentId" | "personId">): Authority => {
  const agentId = workspaceAgentIdSchema.safeParse(stored);
  if (!agentId.success) {
    // No agent core names: nowhere an agent can work.
    throw permissionErrors.create("permission.context_invalid");
  }
  return authoritySchema.parse({
    subject: { type: "agent", agentId: agentId.data },
    onBehalfOf: personId,
    mode: "interactive",
  });
};

/** The chat, as the context an agent works in and keeps restricted mode. */
export const chatContext = ({
  workspaceId,
  chatId,
}: Pick<AgentScope, "workspaceId" | "chatId">): Extract<
  WorkContext,
  { type: "chat" }
> => ({ type: "chat", workspaceId, chatId });

/**
 * What the Workspace object says of one API call of a code run: it may go
 * on (with when the run opened), the run has made all the calls it may, a
 * revocation closed it, or it has ended; and whether it is the run's first
 * call refused so, which alone is audited.
 */
export type CodeRunCall =
  | { call: "open"; first: boolean; openedAt: number }
  | { call: "spent" | "ended" | "revoked"; first: boolean };

/**
 * Whether a code run may have a write admitted now (`admitFromCodeRun`):
 * open, with when it opened, or closed, and why.
 */
export type CodeRunAdmission =
  | { call: "open"; openedAt: number }
  | { call: "ended" | "revoked" };

/** Why a call or write from a run that isn't open is refused. */
const refusalCodes = {
  spent: "agent.run_calls_spent",
  ended: "agent.run_ended",
  revoked: "agent.run_revoked",
} as const;

/** The refusal of a call or write from a run that isn't open. */
export const runRefusal = (call: keyof typeof refusalCodes) =>
  agentErrors.create(refusalCodes[call]);

/**
 * Records with the chat what a call read from (collections, a
 * connection), before the call hands over what it read: every later model
 * request of the chat carries them as provenance, so the client's model
 * rules judge it by them (workspace.ts). A run that ended since the call
 * began records nothing, and the call is refused: what it read never
 * reaches code that can no longer be followed.
 */
export const recordSources = async (
  env: Env,
  { workspaceId, chatId, runId }: AgentScope,
  sources: readonly string[]
): Promise<void> => {
  const recorded = await workspace(env, workspaceId).recordSources(
    chatId,
    runId,
    sources
  );
  if (recorded !== "open") {
    throw runRefusal(recorded);
  }
};

/** One call of a chat's code, as the audit log records it. */
export interface AgentCall {
  /** The API and method, such as `connections.list`. */
  method: string;
  target?: AuditEntry["target"];
  /** Identifiers and counts, never what was read. */
  detail?: Record<string, AuditDetailValue>;
}

/** How a call ended: done, refused (an expected error), or failed. */
type CallOutcome = "ok" | "refused" | "failed";

/**
 * Records a call of the chat's code as `agent.call`, by the workspace's
 * agent acting for the chat's person, in the chat: for the calls nothing
 * below records (a Knowledge read, a connection call and a model request
 * record themselves). Through core's outbox, which never fails the call
 * (`keepAuditEvent`).
 */
export const auditAgentCall = async (
  env: Env,
  scope: Omit<AgentScope, "runId">,
  { method, target, detail = {} }: AgentCall,
  ended?: { outcome: CallOutcome; reason: string | null }
): Promise<void> => {
  await keepAuditEvent(env, drizzle(env.DB), {
    actor: delegateActorOf(chatAuthority(scope)),
    action: "agent.call",
    target,
    // The actor is the organization's agent, in everyone's chats: which chat
    // called.
    detail: {
      ...detail,
      method,
      chat: scope.chatId,
      outcome: ended?.outcome ?? "ok",
      reason: ended?.reason ?? null,
    },
  });
};

/**
 * Whether a permission the agent was granted, holding where this chat's
 * runs act, was revoked since `since`: one that held everywhere, or in
 * this chat alone. Not a request that was never granted (a person
 * declining a chat's request revokes one), nor another chat's: neither
 * gave the run authority, so neither ends it. A run open since before acts
 * on authority it no longer has, so its lease closes. One read of the
 * subject's index (`permissions_revoked_idx`).
 */
export const revokedSince = async (
  env: Env,
  { agentId, chatId }: Pick<AgentScope, "agentId" | "chatId">,
  since: number
): Promise<boolean> => {
  const [revoked] = await drizzle(env.DB)
    .select({ id: permissions.id })
    .from(permissions)
    .where(
      and(
        eq(permissions.subjectType, "agent"),
        eq(permissions.subjectId, agentId),
        eq(permissions.status, "revoked"),
        // From the millisecond the run opened, that one included. No
        // margin before it: a revocation just before a run opened is in
        // the grants the run's calls read, and a margin would end the
        // next run after any revoke. The accepted residual is clock skew
        // between machines: the Workspace object's clock and the one of
        // the request that revoked may differ by a few milliseconds.
        gte(permissions.revokedAt, new Date(since)),
        // Granted once: both ways a permission becomes active set
        // granted_at with it (`grantPermission`, and a person's own
        // decision in chat-connections.ts), so only a request declined
        // before anyone granted it is revoked without one.
        isNotNull(permissions.grantedAt),
        or(isNull(permissions.chatId), eq(permissions.chatId, chatId))
      )
    )
    .limit(1);
  return revoked !== undefined;
};

/**
 * Closes the run's lease as revoked when a permission of its agent was
 * revoked since it opened (`revokedSince`): `closed` when this call closed
 * it (and alone records it), `closedBefore` when another got there first,
 * `open` when nothing was revoked.
 */
const revocationOf = async (
  env: Env,
  scope: AgentScope,
  openedAt: number
): Promise<"open" | "closed" | "closedBefore"> => {
  if (!(await revokedSince(env, scope, openedAt))) {
    return "open";
  }
  const closed = await workspace(env, scope.workspaceId).revokeCodeRun(
    scope.chatId,
    scope.runId
  );
  return closed ? "closed" : "closedBefore";
};

/**
 * Counts the call with the Workspace object, and refuses it from a code
 * run that has ended (the turn moved on, or the run was cancelled or timed
 * out while its code kept running), made all the calls it may, or was
 * closed by a revocation of one of its agent's permissions, found here
 * too. Every API checks it first, on every call. A run's refusals are
 * recorded once: by the first refused call, or the one that found the
 * revocation.
 */
export const requireOpenRun = async (
  env: Env,
  scope: AgentScope,
  method: string
): Promise<void> => {
  const { workspaceId, chatId, runId } = scope;
  const counted = await workspace(env, workspaceId).callFromCodeRun(
    chatId,
    runId
  );
  const revocation =
    counted.call === "open"
      ? await revocationOf(env, scope, counted.openedAt)
      : "open";
  if (counted.call === "open" && revocation === "open") {
    return;
  }
  const refusal = runRefusal(
    counted.call === "open" ? "revoked" : counted.call
  );
  if ((counted.call !== "open" && counted.first) || revocation === "closed") {
    await auditAgentCall(
      env,
      scope,
      { method },
      { outcome: "refused", reason: refusal.code }
    );
  }
  throw refusal;
};

/**
 * Admits a write or side effect of a code run as it commits, after its
 * call was let in (`requireOpenRun`): refused once the run has closed,
 * whether it ended, was cancelled, ran out of time or lost a permission
 * meanwhile. Counts no call. The slow read of revocations comes first and
 * the lease's own check last, right before the effect. A write into the
 * Workspace object checks the lease once more in its own transaction.
 *
 * With `method`, a refusal is recorded here (for a call that nothing else
 * records): the one that found a revocation, or one from a run that had
 * ended; without, its caller records it (`auditedCall`). So a revoked
 * run's refusals are recorded per refused call, not once per run.
 */
export const admitEffect = async (
  env: Env,
  scope: AgentScope,
  method?: string
): Promise<void> => {
  const chats = workspace(env, scope.workspaceId);
  const opened = await chats.admitFromCodeRun(scope.chatId, scope.runId);
  let refused: "ended" | "revoked" | undefined;
  let record = false;
  if (opened.call === "open") {
    const revocation = await revocationOf(env, scope, opened.openedAt);
    if (revocation === "open") {
      const now = await chats.admitFromCodeRun(scope.chatId, scope.runId);
      refused = now.call === "open" ? undefined : now.call;
    } else {
      refused = "revoked";
      record = revocation === "closed";
    }
  } else {
    refused = opened.call;
  }
  if (refused === undefined) {
    return;
  }
  const refusal = runRefusal(refused);
  if (method !== undefined && (record || refused === "ended")) {
    await auditAgentCall(
      env,
      scope,
      { method },
      { outcome: "refused", reason: refusal.code }
    );
  }
  throw refusal;
};

/** How a call that threw ended, and why, as the audit log names it. */
const endedBy = (
  error: unknown
): { outcome: CallOutcome; reason: string | null } =>
  isExpectedError(error)
    ? { outcome: "refused", reason: error.code }
    : { outcome: "failed", reason: "internal.unexpected" };

/**
 * Runs one call of the chat's code and records it as `agent.call` once,
 * however it ends: with what `detailOf` says of its result when it is
 * done, and why when it is refused or fails. The error goes on as it was.
 */
export const auditedCall = async <T>(
  env: Env,
  scope: AgentScope,
  call: AgentCall & {
    detailOf?: (result: T) => Record<string, AuditDetailValue>;
  },
  run: () => Promise<T>
): Promise<T> => {
  const { detailOf, ...recorded } = call;
  let result: T;
  try {
    result = await run();
  } catch (error) {
    await auditAgentCall(env, scope, recorded, endedBy(error));
    throw error;
  }
  await auditAgentCall(env, scope, {
    ...recorded,
    detail: { ...recorded.detail, ...detailOf?.(result) },
  });
  return result;
};

/**
 * Records a call refused before it reached what records it itself (a
 * connection call before connect), and throws the refusal on.
 */
export const auditRefusal = async (
  env: Env,
  scope: AgentScope,
  call: AgentCall,
  error: unknown
): Promise<never> => {
  await auditAgentCall(env, scope, call, endedBy(error));
  throw error;
};
