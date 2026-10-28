import { actorOf, delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { ConfirmedStart, HeldStart } from "@grasp-os/shared/held-starts";
import { chatIdSchema, workspaceIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  coreStartKeyPrefix,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { chatAuthority, chatContext } from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import type { Member } from "./auth/identity.ts";
import {
  agentHeldStarts,
  workflowResources,
  workflowStartReceipts,
} from "./db/core/schema.ts";
import { requireWorkflowRole } from "./workflow-resources.ts";
import {
  decideWorkflowStart,
  isStaleRefusal,
  receiptOf,
  startWorkflow,
} from "./workflow-starts.ts";
import type { StartInvoker } from "./workflow-starts.ts";
import { startResourceRun } from "./workflows/resource-runs.ts";

// Starts of independent workflows a chat's agent asks for (agent-
// workflows.ts, `start`), held until the person it acts for confirms them
// in Grasp, as an agent's writes to outside systems are (GRA-51): a start
// runs with its workflow's own grants, so nothing the agent read, however
// it was steered, starts one without its person. Threat model, and how
// each is closed:
//
// - A start without its person: the agent's start only holds; the run
//   starts when the person it acts for confirms it, through their own
//   session (`confirmHeldStart`), never the agent's. Nobody else sees or
//   decides it.
// - A confirmation of something other than what was shown: the person
//   confirms the input's SHA-256 as they saw it; the held input never
//   changes after it is held.
// - Authority lost between asking and confirming: holding checks the
//   agent's grant, the person's role and the input as a start would
//   (`decideWorkflowStart`), so a start that couldn't run is refused at
//   once; confirming starts it through `startWorkflow` as the agent acting
//   for the person, all of it read again as it is admitted, and a chat
//   that read restricted data meanwhile starts a restricted run.
// - A start held twice, or confirmed twice: one per chat and key, decided
//   once, in the statement that decides it; the start it makes is keyed as
//   the agent's (`chat:<chat>:<key>`), so a confirmation sent again is the
//   same start.
// - A held start waiting for ever: it lapses after `heldStartMs`, and is
//   neither listed nor confirmable after.
// - A decision nobody can trace: holding is audited as the agent's
//   (`workflow.start.held`), confirming and declining as the person's
//   (`workflow.start.confirmed`, `workflow.start.declined`), with the
//   start's own `workflow.start.admitted` as the agent's for its person.

/** How long a held start waits for its person before it lapses. */
export const heldStartMs = 24 * 60 * 60 * 1000;

/** Longest key an agent names for a start. */
export const maxStartKeyLength = 128;

/** The start key of the agent's `key` in `chatId`, which the run is admitted under. */
const startKeyOf = (chatId: string, key: string): string =>
  `chat:${chatId}:${key}`;

/** The agent of `row` acting for its person, in its chat. */
const invokerOf = (row: {
  agentId: string;
  personId: string;
  workspaceId: string;
  chatId: string;
}): StartInvoker => ({
  type: "agent",
  authority: chatAuthority({ agentId: row.agentId, personId: row.personId }),
  context: chatContext({
    workspaceId: workspaceIdSchema.parse(row.workspaceId),
    chatId: chatIdSchema.parse(row.chatId),
  }),
});

/** Where an agent's start stands, as the agent is told. */
export type AgentStart =
  | {
      status: "waiting";
      held: string;
      workflow: string;
      version: number;
      expiresAt: string;
    }
  | {
      status: "started";
      held: string;
      workflow: string;
      version: number;
      start: string;
    }
  | {
      status: "refused";
      held: string;
      workflow: string;
      version: number;
      /** Why it was refused as it started: the agent's grant or the person's role gone, say. */
      code: string;
    }
  | {
      status: "declined" | "lapsed";
      held: string;
      workflow: string;
      version: number;
    };

type Row = typeof agentHeldStarts.$inferSelect;

/**
 * `row`, with the start it made once confirmed, read from the start's own
 * receipt where it stopped before noting it.
 */
const withStart = async (env: Env, row: Row): Promise<Row> => {
  if (row.decision !== "confirmed" || row.startId !== null) {
    return row;
  }
  const receipt = await receiptOf(
    env,
    { type: "agent", id: row.agentId },
    row.personId,
    startKeyOf(row.chatId, row.key)
  );
  if (receipt === undefined) {
    return row;
  }
  await drizzle(env.DB)
    .update(agentHeldStarts)
    .set({ startId: receipt.id })
    .where(eq(agentHeldStarts.id, row.id));
  return { ...row, startId: receipt.id };
};

/**
 * That a held start is open to its person, as SQL: undecided, or
 * confirmed and stopped before it started, neither started nor refused;
 * and not lapsed.
 */
const openSql = () =>
  and(
    or(
      isNull(agentHeldStarts.decision),
      and(
        eq(agentHeldStarts.decision, "confirmed"),
        isNull(agentHeldStarts.startId),
        isNull(agentHeldStarts.refusal)
      )
    ),
    gt(agentHeldStarts.expiresAt, new Date())
  );

/** Where held start `row` stands, as of `now`. */
const standingOf = (row: Row, now: number): AgentStart => {
  const base = {
    held: row.id,
    workflow: row.workflowResourceId,
    version: row.workflowResourceVersion,
  };
  if (row.decision === "confirmed" && row.startId !== null) {
    return { status: "started", ...base, start: row.startId };
  }
  if (row.refusal !== null) {
    return { status: "refused", ...base, code: row.refusal };
  }
  if (row.decision === "declined") {
    return { status: "declined", ...base };
  }
  if (row.expiresAt.getTime() <= now) {
    return { status: "lapsed", ...base };
  }
  return {
    status: "waiting",
    ...base,
    expiresAt: row.expiresAt.toISOString(),
  };
};

/**
 * Holds a start of workflow `workflowId` with `input` that the agent of
 * `scope` asks for under `key`, for `person` (its person) to confirm, at
 * the workflow's current version: checked first as the start would be,
 * so one that couldn't run is refused now. The same key in the chat
 * answers where that start stands.
 */
export const holdStart = async (
  env: Env,
  scope: AgentScope,
  person: Member,
  workflowId: unknown,
  input: unknown,
  key: unknown
): Promise<AgentStart> => {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > maxStartKeyLength ||
    key.startsWith(coreStartKeyPrefix)
  ) {
    throw workflowResourceErrors.create("workflow.start_invalid", {
      issues: [`key: A key of 1 to ${maxStartKeyLength} characters.`],
    });
  }
  const db = drizzle(env.DB);
  const now = Date.now();
  const byKey = and(
    eq(agentHeldStarts.chatId, scope.chatId),
    eq(agentHeldStarts.key, key)
  );
  const before = await db.select().from(agentHeldStarts).where(byKey).get();
  if (before !== undefined) {
    return standingOf(await withStart(env, before), now);
  }
  // What the person sees, as they'd see it: a workflow they have no role
  // in is one that doesn't exist.
  const workflow = await requireWorkflowRole(env, person, workflowId, "user");
  if (workflow.currentVersion === null) {
    throw workflowResourceErrors.create("workflow.version_not_found");
  }
  const version = workflow.currentVersion;
  const invoker = invokerOf({
    agentId: scope.agentId,
    personId: scope.personId,
    workspaceId: scope.workspaceId,
    chatId: scope.chatId,
  });
  // As the start would be decided, admitting nothing: its grant, its
  // person's role, its input as the version takes it.
  const decided = await decideWorkflowStart(env, invoker, workflow.id, {
    version,
    input,
    key: startKeyOf(scope.chatId, key),
  });
  const accepted =
    "authorization" in decided ? decided.authorization.input : undefined;
  const text = accepted ?? canonicalJson(z.json().parse(input));
  const id = crypto.randomUUID();
  const entry: AuditEntry = {
    actor: delegateActorOf(chatAuthority(scope)),
    action: "workflow.start.held",
    target: { type: "workflow_resource", id: workflow.id },
    detail: { held: id, version, chat: scope.chatId },
  };
  await auditedBatch(env, db, [
    db
      .insert(agentHeldStarts)
      .values({
        id,
        workspaceId: scope.workspaceId,
        chatId: scope.chatId,
        agentId: scope.agentId,
        personId: scope.personId,
        workflowResourceId: workflow.id,
        workflowResourceVersion: version,
        input: text,
        inputHash: await sha256Hex(text),
        key,
        createdAt: new Date(now),
        expiresAt: new Date(now + heldStartMs),
      })
      .onConflictDoNothing(),
    outboxedIfChanged(db, entry),
  ]);
  const held = await db.select().from(agentHeldStarts).where(byKey).get();
  if (held === undefined) {
    throw new Error(`No held start under chat ${scope.chatId}'s key`);
  }
  return standingOf(held, now);
};

/** The starts waiting for `by`, oldest first. */
export const heldStartsOf = async (
  env: Env,
  by: Identity
): Promise<HeldStart[]> => {
  const rows = await drizzle(env.DB)
    .select({
      row: agentHeldStarts,
      workflowName: workflowResources.name,
    })
    .from(agentHeldStarts)
    .innerJoin(
      workflowResources,
      eq(workflowResources.id, agentHeldStarts.workflowResourceId)
    )
    .where(
      and(
        eq(agentHeldStarts.personId, by.userId),
        openSql(),
        isNull(workflowResources.deletedAt)
      )
    )
    .orderBy(asc(agentHeldStarts.createdAt));
  return rows.map(({ row, workflowName }) => ({
    id: row.id,
    workflow: row.workflowResourceId,
    workflowName,
    version: row.workflowResourceVersion,
    input: z.json().parse(JSON.parse(row.input)),
    inputHash: row.inputHash,
    chatId: row.chatId,
    requestedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }));
};

/** Held start `id` of `by`'s that is still open to them, or `workflow.start_held_gone`. */
const waitingFor = async (env: Env, by: Identity, id: unknown) => {
  if (typeof id !== "string") {
    throw workflowResourceErrors.create("workflow.start_held_gone");
  }
  const row = await drizzle(env.DB)
    .select()
    .from(agentHeldStarts)
    .where(
      and(
        eq(agentHeldStarts.id, id),
        eq(agentHeldStarts.personId, by.userId),
        openSql()
      )
    )
    .get();
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.start_held_gone");
  }
  return row;
};

/** That held start `id` still waits undecided, as SQL. */
const stillWaiting = (id: string) =>
  and(
    eq(agentHeldStarts.id, id),
    isNull(agentHeldStarts.decision),
    gt(agentHeldStarts.expiresAt, new Date())
  );

/** That held start `id` is still open to its person, as SQL. */
const stillOpen = (id: string) => and(eq(agentHeldStarts.id, id), openSql());

/**
 * Starts `by`'s held start `id`, with exactly the input of `inputHash`, as
 * its agent acting for them: decided once, then started through
 * `startWorkflow`, everything read again as it is admitted. A start
 * refused for good then is noted with why (`refusal`), which its agent is
 * told; one that stopped on the way (a failure of core's) stays open, and
 * confirming it again starts it under the same key: the same start if it
 * had been admitted.
 */
export const confirmHeldStart = async (
  env: Env,
  by: Identity,
  id: unknown,
  inputHash: unknown
): Promise<ConfirmedStart> => {
  const row = await waitingFor(env, by, id);
  if (inputHash !== row.inputHash) {
    throw workflowResourceErrors.create("workflow.start_held_changed");
  }
  const db = drizzle(env.DB);
  if (row.decision === null) {
    const [decided] = await auditedBatch(env, db, [
      db
        .update(agentHeldStarts)
        .set({ decision: "confirmed", decidedAt: new Date() })
        .where(stillWaiting(row.id))
        .returning({ id: agentHeldStarts.id }),
      outboxedIfChanged(db, {
        actor: actorOf(by),
        action: "workflow.start.confirmed",
        target: { type: "workflow_resource", id: row.workflowResourceId },
        detail: { held: row.id, version: row.workflowResourceVersion },
      }),
    ]);
    if (decided.length === 0) {
      // Decided meanwhile: only a confirmation still open goes on.
      await waitingFor(env, by, row.id);
    }
  }
  // Admitted only while it is still confirmed: a decline that lands first
  // starts nothing (`declineHeldStart` declines only before admission).
  const stillConfirmed = sql`EXISTS (SELECT 1 FROM ${agentHeldStarts} WHERE ${agentHeldStarts.id} = ${row.id} AND ${agentHeldStarts.decision} = 'confirmed')`;
  let started: Awaited<ReturnType<typeof startWorkflow>>;
  try {
    started = await startWorkflow(
      env,
      invokerOf(row),
      row.workflowResourceId,
      {
        version: row.workflowResourceVersion,
        input: z.json().parse(JSON.parse(row.input)),
        key: startKeyOf(row.chatId, row.key),
      },
      stillConfirmed,
      { chat: row.chatId, workspace: row.workspaceId, held: row.id }
    );
  } catch (error) {
    // Admitted before, where core stopped before noting it: that start
    // stands, whatever refuses a new one now.
    const receipt = await receiptOf(
      env,
      { type: "agent", id: row.agentId },
      row.personId,
      startKeyOf(row.chatId, row.key)
    );
    if (receipt !== undefined) {
      await db
        .update(agentHeldStarts)
        .set({ startId: receipt.id })
        .where(eq(agentHeldStarts.id, row.id));
      return {
        start: receipt.id,
        run: await startResourceRun(env, receipt.id),
      };
    }
    // Declined as it was admitted: it never starts.
    const now = await db
      .select({ decision: agentHeldStarts.decision })
      .from(agentHeldStarts)
      .where(eq(agentHeldStarts.id, row.id))
      .get();
    if (now?.decision === "declined") {
      throw workflowResourceErrors.create("workflow.start_held_gone");
    }
    if (isExpectedError(error) && !isStaleRefusal(error)) {
      // Refused for good: it never starts, and its agent is told why.
      await db
        .update(agentHeldStarts)
        .set({ refusal: error.code })
        .where(
          and(eq(agentHeldStarts.id, row.id), isNull(agentHeldStarts.startId))
        );
    }
    throw error;
  }
  await db
    .update(agentHeldStarts)
    .set({ startId: started.id })
    .where(eq(agentHeldStarts.id, row.id));
  return { start: started.id, run: started.runId };
};

/** Declines `by`'s held start `id`: it never starts. */
export const declineHeldStart = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<void> => {
  const row = await waitingFor(env, by, id);
  const db = drizzle(env.DB);
  // Never once its start is admitted, noted yet or not: the start stands.
  const notAdmitted = sql`NOT EXISTS (SELECT 1 FROM ${workflowStartReceipts} WHERE ${workflowStartReceipts.invokerType} = 'agent' AND ${workflowStartReceipts.invokerId} = ${row.agentId} AND ${workflowStartReceipts.principalId} = ${row.personId} AND ${workflowStartReceipts.idempotencyKey} = ${startKeyOf(row.chatId, row.key)})`;
  const [decided] = await auditedBatch(env, db, [
    db
      .update(agentHeldStarts)
      .set({ decision: "declined", decidedAt: new Date() })
      .where(and(stillOpen(row.id), notAdmitted))
      .returning({ id: agentHeldStarts.id }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "workflow.start.declined",
      target: { type: "workflow_resource", id: row.workflowResourceId },
      detail: { held: row.id, version: row.workflowResourceVersion },
    }),
  ]);
  if (decided.length === 0) {
    throw workflowResourceErrors.create("workflow.start_held_gone");
  }
};
