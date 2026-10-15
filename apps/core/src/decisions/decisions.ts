import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { actorOf, runActorOf } from "@grasp-os/shared/audit";
import { decisionErrors, maxDeciders } from "@grasp-os/shared/decisions";
import type {
  DecisionAnswerInput,
  DecisionConfirmation,
  DecisionReview,
  DecisionView,
} from "@grasp-os/shared/decisions";
import {
  appIdSchema,
  identifierSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { Identity } from "@grasp-os/shared/rpc";
import { executionErrors } from "@grasp-os/shared/workflows";
import { and, eq, exists, gt, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import {
  auditedBatch,
  outboxed,
  outboxedIfChanged,
  outboxedWhere,
} from "../audit-outbox.ts";
import { notRemoved, organizationId } from "../auth/auth.ts";
import { signInConfig } from "../auth/config.ts";
import type { Member } from "../auth/identity.ts";
import {
  apps,
  members,
  teamMembers,
  teams,
  users,
  workflowDecisionConfirmations,
  workflowDecisions,
  workflowRuns,
} from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { removedText } from "../workflows/retention.ts";
import { tellScreens } from "../workflows/run-changes.ts";
import { oweWake, sendWake } from "../workflows/wakes.ts";
import {
  confirmationHash,
  confirmationTtlMs,
  contextFingerprint,
  newConfirmationToken,
  normalizedAnswer,
  responseFingerprint,
} from "./confirmations.ts";
import type { ReviewContext } from "./confirmations.ts";

// Decisions workflow runs wait for (`step.decision`), and the only ways to
// answer one. Threat model R3, R8 and WF1 to WF4:
//
// - Only a signed-in member the decision is from answers it, as they are
//   at that moment: who may answer is part of the one conditional update
//   that takes the answer (`mayAnswer`), so someone removed, demoted or
//   taken out of the team since they were asked can't, even mid-request.
//   Grasp staff never answer a client's decisions.
// - Nobody answers their own request (R8): the person who started the run
//   can't answer its decisions, unless the decision names exactly them
//   (`person:<them>`), which is their own explicit confirmation. A run a
//   trigger started has no starter, so its App's owner isn't held back.
// - A decision link is plain (`/decisions/<id>`) and grants nothing: it
//   only leads there. Whoever opens it must still be signed in and one who
//   may answer. Every answer is audited under who gave it.
// - The first answer is the decision: the same update moves the row from
//   `open`, only before its deadline and while its run hasn't ended.
//   A run that stops waiting closes its decision the same way, so an answer
//   and a timeout can't both count.
// - The run takes the answer from the row, never from the event that wakes
//   it: the event only says "look now". The wake is owed in the same batch
//   as the answer, and sent until the engine takes it
//   (workflows/wakes.ts), so a lost wake never leaves the run waiting out
//   its deadline. One answer owes one wake, whose key is the decision.
// - Who answered is taken from the session, never from the request. The
//   audit log records the answer under them, without its payload (R16).
// - No answer is recorded without the person's one-use confirmation of
//   exactly that answer, against exactly the review context they saw,
//   given in the trusted host decision UI (confirmations.ts, GRA-624):
//   the answer's update requires it, and the same batch takes it. An App's
//   screen never holds one, and agents never reach this service: it is
//   answered through a person's session only. A context that changed
//   since it was reviewed is a `decision.conflict`, never an approval.

type DecisionRow = typeof workflowDecisions.$inferSelect;

/** The run a decision belongs to, as `tellScreens` names it. */
const changed = (run: DecisionRun) => ({
  id: run.runId,
  appId: run.app,
  workflowId: run.workflow,
});

/** The run a decision belongs to, as the host serves it. */
export interface DecisionRun {
  runId: string;
  app: string;
  workflow: string;
  version: number;
}

/** A person a decision asks, and the link that leads them to it. */
export interface DecisionRecipient {
  userId: string;
  name: string;
  email: string;
  link: string;
}

/** How a decision stands for the run waiting on it. */
export type DecisionOutcome =
  | { answered: true; approved: boolean; by: string; payload: Json | null }
  | { answered: false };

/**
 * The run's next summary revision (workflows/summary.ts), after the
 * statement before it changed one of its decisions: their audit event,
 * stored only if the decision changed.
 */
const summaryChanged = (db: DrizzleD1Database, run: string) =>
  db
    .update(workflowRuns)
    .set({ summaryRevision: sql`${workflowRuns.summaryRevision} + 1` })
    .where(and(eq(workflowRuns.id, run), sql`changes() > 0`));

const decisionEventPrefix = "grasp-decision-";

/** The event that wakes a run waiting on `decision`: core's own type. */
export const decisionEventType = (decision: string): string =>
  `${decisionEventPrefix}${decision}`;

/**
 * The decision an event type of `decisionEventType` wakes a run for;
 * nothing for any other type.
 */
export const decisionOfEventType = (type: string): string | undefined =>
  type.startsWith(decisionEventPrefix) &&
  type.length > decisionEventPrefix.length
    ? type.slice(decisionEventPrefix.length)
    : undefined;

/** The longest description of a decision kept; the rest is cut. */
const maxDescription = 500;

/** The largest payload an answer carries, in bytes of JSON text. */
const maxPayloadBytes = 4096;

const answerSchema = z.strictObject({
  approved: z.boolean(),
  payload: z.json().optional(),
});

const notFound = () => decisionErrors.create("decision.not_found");

/** The audit entry of something that happened to a decision. */
const decisionEntry = (
  actor: AuditActor,
  action: `workflow.decision.${string}`,
  run: DecisionRun,
  row: Pick<DecisionRow, "id" | "step">,
  detail: Record<string, string | number | boolean> = {}
): AuditEntry => ({
  actor,
  action,
  target: { type: "workflow_decision", id: row.id },
  detail: {
    app: run.app,
    workflow: run.workflow,
    version: run.version,
    run: run.runId,
    step: row.step,
    ...detail,
  },
});

/** A table of decisions, or an alias of it, as `stillOpen` reads it. */
interface DecisionColumns {
  status: SQLiteColumn;
  expiresAt: SQLiteColumn;
}

/**
 * That a decision can still be answered at `now`, as a condition on
 * `decisions` (the table, or an alias of it): it is open, and its deadline
 * hasn't passed. One the run hasn't timed out yet, past its deadline, is
 * answered by nobody. The one place this rule lives: answering, and
 * whether a run waits for anyone (workflows/overview.ts), go by it.
 */
export const stillOpen = (decisions: DecisionColumns, now: Date): SQL =>
  and(eq(decisions.status, "open"), gt(decisions.expiresAt, now)) ?? sql`0`;

/**
 * That the decision's run goes on, as a condition: it hasn't ended, and
 * nobody asked to cancel it. A cancel is admitted before the engine
 * stops the run, which shows as running until then; an answer in
 * between would count for a run that never takes it.
 */
const runUnended = (): SQL => sql`EXISTS (
  SELECT 1 FROM ${workflowRuns}
  WHERE ${workflowRuns.id} = ${workflowDecisions.runId}
    AND ${workflowRuns.status} IN ('starting', 'running', 'paused')
    AND ${workflowRuns.cancelRequestedAt} IS NULL
)`;

// Run side: the host (workflows/host.ts) calls these for its run only.

/**
 * Opens the run's decision for `step`, or finds the one it opened: a step
 * that runs again after a crash opens nothing new. Its deadline is set
 * here, once, and is the one the run and every answer go by.
 */
export const openDecision = async (
  env: Env,
  run: DecisionRun,
  request: { step: string; from: string; description: string; timeout: number }
): Promise<{ decision: string; deadline: number }> => {
  const db = drizzle(env.DB);
  const now = Date.now();
  const row: DecisionRow = {
    id: crypto.randomUUID(),
    runId: run.runId,
    step: request.step,
    deciders: request.from,
    description: request.description.slice(0, maxDescription),
    status: "open",
    openedAt: new Date(now),
    expiresAt: new Date(now + request.timeout),
    decidedBy: null,
    decidedAt: null,
    payload: null,
  };
  // Opened only for a run that goes on, as the batch finds it: a decision
  // of a run cancelled meanwhile is taken out again in the same batch, and
  // neither audited nor told of.
  const liveRun = sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${run.runId} AND ${workflowRuns.cancelRequestedAt} IS NULL AND ${workflowRuns.endedAt} IS NULL)`;
  const stands = sql`EXISTS (SELECT 1 FROM ${workflowDecisions} WHERE ${workflowDecisions.id} = ${row.id})`;
  const [[inserted]] = await auditedBatch(env, db, [
    db
      .insert(workflowDecisions)
      .values(row)
      .onConflictDoNothing({
        target: [workflowDecisions.runId, workflowDecisions.step],
      })
      .returning({ id: workflowDecisions.id }),
    db
      .delete(workflowDecisions)
      .where(and(eq(workflowDecisions.id, row.id), sql`NOT ${liveRun}`)),
    outboxedWhere(
      db,
      decisionEntry(runActorOf(run), "workflow.decision.opened", run, row, {
        from: request.from,
      }),
      stands
    ),
    summaryChanged(db, run.runId),
  ]);
  const live = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, run.runId), liveRun))
    .get();
  if (live === undefined) {
    throw executionErrors.create("execution.stale_attempt");
  }
  // The run now waits for it; a step run again after a crash opened
  // nothing, and tells no one.
  if (inserted) {
    await tellScreens(env, changed(run));
  }
  const opened = await db
    .select({
      id: workflowDecisions.id,
      expiresAt: workflowDecisions.expiresAt,
    })
    .from(workflowDecisions)
    .where(
      and(
        eq(workflowDecisions.runId, run.runId),
        eq(workflowDecisions.step, request.step)
      )
    )
    .get();
  if (!opened) {
    throw new Error(`Decision ${request.step} of run ${run.runId} is missing`);
  }
  return { decision: opened.id, deadline: opened.expiresAt.getTime() };
};

/** The run's decision `decision`; `decision.not_found` for any other. */
const runDecision = async (
  env: Env,
  run: DecisionRun,
  decision: string
): Promise<DecisionRow> => {
  const row = await drizzle(env.DB)
    .select()
    .from(workflowDecisions)
    .where(
      and(
        eq(workflowDecisions.id, decision),
        eq(workflowDecisions.runId, run.runId)
      )
    )
    .get();
  if (!row) {
    throw notFound();
  }
  return row;
};

/** The deadline of the run's decision `decision`, in milliseconds. */
export const decisionDeadline = async (
  env: Env,
  run: DecisionRun,
  decision: string
): Promise<number> => {
  const row = await runDecision(env, run, decision);
  return row.expiresAt.getTime();
};

/**
 * Stored deciders (`role:admin`, `decidersSchema`) as their kind and ID:
 * the ID is everything after the first `:`.
 */
const decidersOf = (deciders: string): { kind: string; id: string } => {
  const colon = deciders.indexOf(":");
  return colon === -1
    ? { kind: "", id: "" }
    : { kind: deciders.slice(0, colon), id: deciders.slice(colon + 1) };
};

/** Members the deciders name, as a condition on `members`. */
const decidersCondition = (deciders: string): SQL => {
  const { kind, id } = decidersOf(deciders);
  switch (kind) {
    case "person": {
      return eq(members.userId, id);
    }
    case "role": {
      return eq(members.role, id);
    }
    case "team": {
      return sql`EXISTS (
        SELECT 1 FROM ${teamMembers}
        INNER JOIN ${teams} ON ${teams.id} = ${teamMembers.teamId}
        WHERE ${teamMembers.userId} = ${members.userId}
          AND ${teamMembers.teamId} = ${id}
          AND ${teams.organizationId} = ${organizationId}
      )`;
    }
    default: {
      return sql`0`;
    }
  }
};

/**
 * The members who may answer a decision now, as a condition on `members`:
 * active members of the organization its deciders name, but never whoever
 * started its run (R8). A `person:` decision names one person, so it only
 * leaves out its starter by naming someone else; one naming exactly the
 * starter is their own confirmation, and stands. The one place these rules
 * live: who is asked, who counts toward the cap, and who may answer all go
 * by it.
 */
const eligibleMembers = (deciders: string, runId: string | SQLiteColumn): SQL =>
  and(
    eq(members.organizationId, organizationId),
    notRemoved(members.userId),
    decidersCondition(deciders),
    decidersOf(deciders).kind === "person"
      ? undefined
      : sql`NOT EXISTS (
          SELECT 1 FROM ${workflowRuns}
          WHERE ${workflowRuns.id} = ${runId}
            AND ${workflowRuns.startedBy} = ${members.userId}
        )`
  ) ?? sql`0`;

/**
 * That `userId` may answer the decision now, as a condition on its row
 * (`eligibleMembers`), so it holds in the very statement that answers.
 */
const mayAnswer = (
  db: DrizzleD1Database,
  userId: string,
  deciders: string
): SQL =>
  and(
    eq(workflowDecisions.deciders, deciders),
    exists(
      db
        .select({ one: sql`1` })
        .from(members)
        .where(
          and(
            eq(members.userId, userId),
            eligibleMembers(deciders, workflowDecisions.runId)
          )
        )
    )
  ) ?? sql`0`;

/**
 * The people an open decision asks now, each with the decision's link:
 * the members who may answer it at this moment (`eligibleMembers`). An
 * answered or closed decision asks nobody, and nor does one past its
 * deadline. More than {@link maxDeciders} of them is refused; the run's
 * starter counts only when the decision names exactly them, as only then
 * may they answer. Who was asked is audited: their IDs, never their
 * emails.
 */
export const decisionRecipients = async (
  env: Env,
  run: DecisionRun,
  decision: string,
  reminder: boolean,
  stillAsking: () => Promise<void> = async () => {
    await Promise.resolve();
  }
): Promise<DecisionRecipient[]> => {
  const row = await runDecision(env, run, decision);
  // Past its deadline, nobody can answer it, so nobody is asked: a link
  // sent then would lead to a decision that takes no answer.
  if (row.status !== "open" || row.expiresAt.getTime() <= Date.now()) {
    return [];
  }
  const origin = signInConfig(env)?.origin;
  if (origin === undefined) {
    throw new Error("Sign-in isn't set up, so nobody can answer a decision");
  }
  const db = drizzle(env.DB);
  const people = await db
    .select({ userId: users.id, name: users.name, email: users.email })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(eligibleMembers(row.deciders, row.runId))
    .orderBy(users.name, users.id)
    .limit(maxDeciders + 1);
  if (people.length > maxDeciders) {
    throw decisionErrors.create("decision.too_many_deciders");
  }
  // Last before the ask is recorded: the step asking may have been let go
  // of while the people were read (the caller's check, `stillAsking`), and
  // its run cancelled or ended, which the write itself checks, so an ask
  // of a run that was cancelled meanwhile is never recorded.
  await stillAsking();
  const liveRun = sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${run.runId} AND ${workflowRuns.cancelRequestedAt} IS NULL AND ${workflowRuns.endedAt} IS NULL)`;
  const [, live] = await auditedBatch(env, db, [
    outboxedWhere(
      db,
      {
        ...decisionEntry(runActorOf(run), "workflow.decision.asked", run, row, {
          recipients: people.length,
          reminder,
        }),
        provenance: people.map(({ userId }) => userId),
      },
      liveRun
    ),
    db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, run.runId), liveRun)),
  ]);
  if (live.length === 0) {
    throw executionErrors.create("execution.stale_attempt");
  }
  const link = new URL(`/decisions/${encodeURIComponent(row.id)}`, origin);
  return people.map((person) => ({ ...person, link: link.href }));
};

/**
 * How the run's decision stands now. With `close`, an open one is closed
 * first, timed out, in the same one conditional update an answer uses: an
 * answer that lands first is the outcome instead.
 */
export const decisionOutcome = async (
  env: Env,
  run: DecisionRun,
  decision: string,
  close: boolean
): Promise<DecisionOutcome> => {
  const found = await runDecision(env, run, decision);
  if (close && found.status === "open") {
    const db = drizzle(env.DB);
    const [[closed]] = await auditedBatch(env, db, [
      db
        .update(workflowDecisions)
        .set({ status: "timed_out" })
        .where(
          and(
            eq(workflowDecisions.id, found.id),
            eq(workflowDecisions.status, "open")
          )
        )
        .returning({ id: workflowDecisions.id }),
      outboxedIfChanged(
        db,
        decisionEntry(
          runActorOf(run),
          "workflow.decision.timed_out",
          run,
          found
        )
      ),
      summaryChanged(db, run.runId),
    ]);
    if (closed) {
      await tellScreens(env, changed(run));
    }
  }
  const row = close ? await runDecision(env, run, decision) : found;
  if (
    (row.status === "approved" || row.status === "rejected") &&
    row.decidedBy !== null
  ) {
    return {
      answered: true,
      approved: row.status === "approved",
      by: row.decidedBy,
      payload: row.payload ?? null,
    };
  }
  return { answered: false };
};

// Person side: the `decisions` RPC (rpc.ts).

/** A decision with what the people who answer it see of it. */
const decisionWithRun = async (env: Env, decision: unknown) => {
  const id = identifierSchema.safeParse(decision);
  if (!id.success) {
    throw notFound();
  }
  const found = await drizzle(env.DB)
    .select({
      decision: workflowDecisions,
      app: { id: workflowRuns.appId, name: apps.name },
      workflow: workflowRuns.workflowId,
      version: workflowRuns.version,
      runStatus: workflowRuns.status,
      cancelRequestedAt: workflowRuns.cancelRequestedAt,
      decidedByName: users.name,
    })
    .from(workflowDecisions)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowDecisions.runId))
    .innerJoin(apps, eq(apps.id, workflowRuns.appId))
    .leftJoin(users, eq(users.id, workflowDecisions.decidedBy))
    .where(eq(workflowDecisions.id, id.data))
    .get();
  if (!found) {
    throw notFound();
  }
  return found;
};
type DecisionWithRun = Awaited<ReturnType<typeof decisionWithRun>>;

/** Whether `by` may answer the decision now (`mayAnswer`); never staff. */
const mayAnswerNow = async (
  env: Env,
  by: Identity,
  row: DecisionRow
): Promise<boolean> => {
  if (by.staff) {
    return false;
  }
  const db = drizzle(env.DB);
  const found = await db
    .select({ id: workflowDecisions.id })
    .from(workflowDecisions)
    .where(
      and(
        eq(workflowDecisions.id, row.id),
        mayAnswer(db, by.userId, row.deciders)
      )
    )
    .get();
  return found !== undefined;
};

/** The decision, if `by` may answer it now. */
const allowedDecision = async (
  env: Env,
  by: Identity,
  decision: unknown
): Promise<DecisionWithRun> => {
  const found = await decisionWithRun(env, decision);
  if (!(await mayAnswerNow(env, by, found.decision))) {
    throw decisionErrors.create("decision.forbidden");
  }
  return found;
};

/**
 * The database's own time as a statement runs, in milliseconds: what a
 * write checks a deadline or an expiry against, so time spent between
 * reading and writing never stretches either.
 */
const databaseNow = sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;

/** Statuses of a run that hasn't ended. */
const unended: ReadonlySet<string> = new Set(["starting", "running", "paused"]);

/** The pinned fields of the decision a person reviews before answering. */
const contextOf = ({
  decision,
  app,
  workflow,
  version,
}: DecisionWithRun): ReviewContext => ({
  decision: decision.id,
  run: decision.runId,
  app: app.id,
  workflow,
  version,
  step: decision.step,
  deciders: decision.deciders,
  description: decision.description,
  expiresAt: decision.expiresAt,
});

/**
 * Where a decision stands as its page shows it: an open decision of a run
 * that has ended, or that someone asked to cancel, takes no answer
 * (`runUnended`), and shows as `closed`.
 */
const statusOf = ({
  decision,
  runStatus,
  cancelRequestedAt,
}: DecisionWithRun): DecisionView["status"] =>
  decision.status === "open" &&
  (!unended.has(runStatus) || cancelRequestedAt !== null)
    ? "closed"
    : decision.status;

const toView = async (
  env: Env,
  found: DecisionWithRun
): Promise<DecisionView> => {
  const { decision, app, workflow, decidedByName } = found;
  return {
    id: decision.id,
    app: { id: appIdSchema.parse(app.id), name: app.name },
    workflow: workflowIdSchema.parse(workflow),
    run: runIdSchema.parse(decision.runId),
    // None is asked with an empty description: one that is empty went with
    // its run's details (workflows/retention.ts), and says so.
    description:
      decision.description === "" ? removedText(env) : decision.description,
    status: statusOf(found),
    expiresAt: decision.expiresAt.toISOString(),
    revision: await contextFingerprint(contextOf(found)),
    ...(decision.decidedBy !== null && decision.decidedAt !== null
      ? {
          decided: {
            by: { userId: decision.decidedBy, name: decidedByName ?? "" },
            at: decision.decidedAt.toISOString(),
          },
        }
      : {}),
  };
};

/** A decision `by` may answer. */
export const decisionFor = async (
  env: Env,
  by: Identity,
  decision: unknown
): Promise<DecisionView> =>
  await toView(env, await allowedDecision(env, by, decision));

/**
 * Of `decisions`, the ones `by` may answer now (`mayAnswer`): none for
 * Grasp staff. One query per distinct set of deciders among them, all in
 * one batch: one round trip, and one snapshot.
 */
export const answerableBy = async (
  env: Env,
  by: Member,
  decisions: readonly { id: string; deciders: string }[]
): Promise<Set<string>> => {
  if (by.staff || decisions.length === 0) {
    return new Set();
  }
  const byDeciders = new Map<string, string[]>();
  for (const { id, deciders } of decisions) {
    byDeciders.set(deciders, [...(byDeciders.get(deciders) ?? []), id]);
  }
  const db = drizzle(env.DB);
  const [first, ...rest] = [...byDeciders].map(([deciders, ids]) =>
    db
      .select({ id: workflowDecisions.id })
      .from(workflowDecisions)
      .where(
        and(
          inList(workflowDecisions.id, ids),
          mayAnswer(db, by.userId, deciders)
        )
      )
  );
  // Never without one: there is a decision (see above).
  if (first === undefined) {
    return new Set();
  }
  const found = await db.batch([first, ...rest]);
  return new Set(found.flat().map(({ id }) => id));
};

/** Why an answer, or its confirmation, was refused, as audited. */
type RefusalCode =
  | "decision.closed"
  | "decision.forbidden"
  | "decision.unconfirmed"
  | "decision.conflict";

/**
 * Records that `by`'s answer to a decision, or its confirmation
 * (`stage: "confirm"`), was refused (`code`): nobody may answer it, or
 * nobody may any more (it was answered, it timed out, its run ended or a
 * cancel of it was admitted), the answer wasn't confirmed as given, or
 * the decision changed since it was reviewed. Who tried, and why, never
 * what they answered nor their confirmation. A refusal that can't be
 * recorded fails the call as one to try again: none goes unrecorded.
 */
const auditRefusal = async (
  env: Env,
  by: Identity,
  found: DecisionWithRun,
  code: RefusalCode,
  where: { via?: "screen"; stage?: "confirm" }
): Promise<void> => {
  const db = drizzle(env.DB);
  const run: DecisionRun = {
    runId: found.decision.runId,
    app: found.app.id,
    workflow: found.workflow,
    version: found.version,
  };
  await auditedBatch(env, db, [
    outboxed(
      db,
      decisionEntry(
        actorOf(by),
        "workflow.decision.answer_refused",
        run,
        found.decision,
        {
          errorCode: code,
          ...(where.via === undefined ? {} : { via: where.via }),
          ...(where.stage === undefined ? {} : { stage: where.stage }),
        }
      )
    ),
  ]);
};

/**
 * `answer` as an answer to a decision, normalized as it is recorded
 * (`normalizedAnswer`); `decision.invalid` for anything else.
 */
const answerOf = (answer: unknown): DecisionAnswerInput => {
  const parsed: DecisionAnswerInput = decisionErrors.parse(
    "decision.invalid",
    answerSchema,
    answer
  );
  const normalized = normalizedAnswer(parsed);
  if (
    normalized.payload !== undefined &&
    new TextEncoder().encode(JSON.stringify(normalized.payload)).length >
      maxPayloadBytes
  ) {
    throw decisionErrors.create("decision.invalid", {
      issues: [`payload: at most ${maxPayloadBytes} bytes of JSON`],
    });
  }
  return normalized;
};

/**
 * Whether the decision already holds exactly `answer`, given by `by`: the
 * answer is recorded, and giving it again asks nothing and writes nothing.
 */
const recordedFor = async (
  found: DecisionWithRun,
  by: Identity,
  answer: DecisionAnswerInput
): Promise<boolean> => {
  const { decision } = found;
  if (
    decision.decidedBy !== by.userId ||
    (decision.status !== "approved" && decision.status !== "rejected")
  ) {
    return false;
  }
  const [recorded, given] = await Promise.all([
    responseFingerprint({
      approved: decision.status === "approved",
      payload: decision.payload ?? null,
    }),
    responseFingerprint(answer),
  ]);
  return recorded === given;
};

/** Whether the decision takes an answer at `now`, as its page shows it. */
const takesAnswers = (found: DecisionWithRun, now: Date): boolean =>
  statusOf(found) === "open" &&
  found.decision.expiresAt.getTime() > now.getTime();

/**
 * What the trusted host decision UI shows `by` before they confirm
 * `answer`: the decision with its review context, and the answer as it
 * would be recorded. `recorded` when they already gave exactly that
 * answer, which asks nothing more. Only someone who may answer the
 * decision sees it; one that takes no answer is `decision.closed`.
 */
export const reviewDecision = async (
  env: Env,
  by: Identity,
  decision: unknown,
  answer: unknown
): Promise<DecisionReview> => {
  const found = await allowedDecision(env, by, decision);
  const response = answerOf(answer);
  if (await recordedFor(found, by, response)) {
    return { state: "recorded", decision: await toView(env, found) };
  }
  if (!takesAnswers(found, new Date())) {
    throw decisionErrors.create("decision.closed");
  }
  return { state: "review", decision: await toView(env, found), response };
};

/**
 * Mints `by`'s one-use confirmation of `answer` to a decision, as they
 * reviewed it at `revision`, once they confirmed it in the trusted host
 * decision UI: bound to them, the decision, its review context and that
 * answer, for {@link confirmationTtlMs}. It replaces any earlier one of
 * theirs for the decision; expired ones are dropped on the way. A context
 * that changed since `revision` is a `decision.conflict`. Refusals are
 * audited as the answer's would be. The token is handed back once and
 * kept only as its hash.
 */
export const confirmDecision = async (
  env: Env,
  by: Identity,
  decision: unknown,
  revision: unknown,
  answer: unknown,
  via?: "screen"
): Promise<DecisionConfirmation> => {
  const found = await decisionWithRun(env, decision);
  const where = via === undefined ? {} : { via };
  const refuse = async (code: RefusalCode) => {
    await auditRefusal(env, by, found, code, { ...where, stage: "confirm" });
    return decisionErrors.create(code);
  };
  if (!(await mayAnswerNow(env, by, found.decision))) {
    throw await refuse("decision.forbidden");
  }
  const response = answerOf(answer);
  const now = new Date();
  if (!takesAnswers(found, now)) {
    throw await refuse("decision.closed");
  }
  const context = await contextFingerprint(contextOf(found));
  if (revision !== context) {
    throw await refuse("decision.conflict");
  }
  const { token, hash } = await newConfirmationToken();
  const expiresAt = new Date(now.getTime() + confirmationTtlMs);
  const db = drizzle(env.DB);
  const run: DecisionRun = {
    runId: found.decision.runId,
    app: found.app.id,
    workflow: found.workflow,
    version: found.version,
  };
  await auditedBatch(env, db, [
    db
      .delete(workflowDecisionConfirmations)
      .where(lte(workflowDecisionConfirmations.expiresAt, now)),
    db
      .delete(workflowDecisionConfirmations)
      .where(
        and(
          eq(workflowDecisionConfirmations.decisionId, found.decision.id),
          eq(workflowDecisionConfirmations.userId, by.userId)
        )
      ),
    db.insert(workflowDecisionConfirmations).values({
      tokenHash: hash,
      decisionId: found.decision.id,
      userId: by.userId,
      contextFingerprint: context,
      responseFingerprint: await responseFingerprint(response),
      createdAt: now,
      expiresAt,
    }),
    // Who confirmed, where, and until when: never the token, nor what
    // they answer (the answer's own entry says that).
    outboxed(
      db,
      decisionEntry(
        actorOf(by),
        "workflow.decision.confirmed",
        run,
        found.decision,
        via === undefined
          ? { expiresAt: expiresAt.toISOString() }
          : { via, expiresAt: expiresAt.toISOString() }
      )
    ),
  ]);
  return { confirmation: token, expiresAt: expiresAt.toISOString() };
};

/**
 * Why `by`'s confirmed answer wasn't taken, as the decision stands now,
 * or nothing when exactly that answer of theirs is the decision.
 */
const refusalOf = async (
  env: Env,
  by: Identity,
  found: DecisionWithRun,
  answer: DecisionAnswerInput,
  confirmed?: { context: string }
): Promise<RefusalCode | undefined> => {
  if (!(await mayAnswerNow(env, by, found.decision))) {
    return "decision.forbidden";
  }
  if (await recordedFor(found, by, answer)) {
    return undefined;
  }
  if (!takesAnswers(found, new Date())) {
    return "decision.closed";
  }
  if (confirmed === undefined) {
    return "decision.unconfirmed";
  }
  return confirmed.context === (await contextFingerprint(contextOf(found)))
    ? "decision.unconfirmed"
    : "decision.conflict";
};

/**
 * Answers a decision for `by`, if they may, once, with their one-use
 * `confirmation` of exactly this answer against the decision as it stands
 * (`confirmDecision`): the first answer, before the deadline and while
 * the run goes on, is the decision, and anything after it is
 * `decision.closed`. Exactly that answer again, by them, is the recorded
 * decision, and needs no confirmation. The answer's update requires the
 * confirmation, and the same batch takes it, audits the answer and owes
 * the run its wake: all of them, or none. `via` says where they answered,
 * when not on the decision's own page: on one of the App's screens
 * (`screen`). The audit log says so.
 */
export const answerDecision = async (
  env: Env,
  by: Identity,
  decision: unknown,
  answer: unknown,
  confirmation: unknown,
  via?: "screen"
): Promise<DecisionView> => {
  const found = await decisionWithRun(env, decision);
  const refuse = async (code: RefusalCode) => {
    await auditRefusal(env, by, found, code, via === undefined ? {} : { via });
    return decisionErrors.create(code);
  };
  if (!(await mayAnswerNow(env, by, found.decision))) {
    throw await refuse("decision.forbidden");
  }
  const response = answerOf(answer);
  const row = found.decision;
  // Why the answer isn't taken, as the decision stands now, read afresh:
  // another request may have answered it meanwhile. Exactly this answer
  // of theirs being the decision now (a retry racing its original) is
  // that decision, given back.
  const notTaken = async (confirmed?: {
    context: string;
  }): Promise<DecisionView> => {
    const current = await decisionWithRun(env, row.id);
    const code = await refusalOf(env, by, current, response, confirmed);
    if (code === undefined) {
      return await toView(env, current);
    }
    throw await refuse(code);
  };
  const now = new Date();
  const hash = await confirmationHash(confirmation);
  const confirmed =
    hash === undefined
      ? undefined
      : await drizzle(env.DB)
          .select({
            context: workflowDecisionConfirmations.contextFingerprint,
            response: workflowDecisionConfirmations.responseFingerprint,
          })
          .from(workflowDecisionConfirmations)
          .where(
            and(
              eq(workflowDecisionConfirmations.tokenHash, hash),
              eq(workflowDecisionConfirmations.decisionId, row.id),
              eq(workflowDecisionConfirmations.userId, by.userId),
              gt(workflowDecisionConfirmations.expiresAt, now)
            )
          )
          .get();
  const given = await responseFingerprint(response);
  const matching =
    confirmed === undefined || confirmed.response !== given
      ? undefined
      : confirmed;
  if (hash === undefined || matching === undefined) {
    return await notTaken();
  }
  const context = await contextFingerprint(contextOf(found));
  if (matching.context !== context) {
    return await notTaken(matching);
  }
  const run: DecisionRun = {
    runId: row.runId,
    app: found.app.id,
    workflow: found.workflow,
    version: found.version,
  };
  const status = response.approved ? "approved" : "rejected";
  const db = drizzle(env.DB);
  const wake = {
    id: `decision:${row.id}`,
    runId: row.runId,
    type: decisionEventType(row.id),
  };
  // The row this batch's update wrote: by whoever answered here, now.
  const answeredHere = sql`EXISTS (SELECT 1 FROM ${workflowDecisions} WHERE ${and(
    eq(workflowDecisions.id, row.id),
    eq(workflowDecisions.status, status),
    eq(workflowDecisions.decidedBy, by.userId),
    eq(workflowDecisions.decidedAt, now)
  )})`;
  const [[answered]] = await auditedBatch(env, db, [
    db
      .update(workflowDecisions)
      .set({
        status,
        decidedBy: by.userId,
        decidedAt: now,
        payload: response.payload ?? null,
      })
      .where(
        and(
          eq(workflowDecisions.id, row.id),
          stillOpen(workflowDecisions, now),
          // Before the deadline as the write runs, not only as it was read.
          sql`${workflowDecisions.expiresAt} > ${databaseNow}`,
          runUnended(),
          mayAnswer(db, by.userId, row.deciders),
          // The review context the confirmation was given against, as it
          // was read: what the person saw is what they answer.
          eq(workflowDecisions.description, row.description),
          eq(workflowDecisions.expiresAt, row.expiresAt),
          exists(
            db
              .select({ one: sql`1` })
              .from(workflowDecisionConfirmations)
              .where(
                and(
                  eq(workflowDecisionConfirmations.tokenHash, hash),
                  eq(workflowDecisionConfirmations.decisionId, row.id),
                  eq(workflowDecisionConfirmations.userId, by.userId),
                  eq(workflowDecisionConfirmations.contextFingerprint, context),
                  eq(workflowDecisionConfirmations.responseFingerprint, given),
                  sql`${workflowDecisionConfirmations.expiresAt} > ${databaseNow}`
                )
              )
          )
        )
      )
      .returning(),
    outboxedIfChanged(
      db,
      decisionEntry(
        actorOf(by),
        `workflow.decision.${status}`,
        run,
        row,
        via === undefined ? {} : { via }
      )
    ),
    summaryChanged(db, row.runId),
    // Owed with this answer only.
    oweWake(db, wake, answeredHere, { now: now.getTime() }),
    // Taken with this answer only: one use, and never without the answer.
    // Anyone else's for the decision goes too: it answers nothing now.
    db
      .delete(workflowDecisionConfirmations)
      .where(
        and(eq(workflowDecisionConfirmations.decisionId, row.id), answeredHere)
      ),
  ]);
  if (!answered) {
    // Who may answer, the decision or its context can have changed since
    // they were read above, or another answer came first.
    return await notTaken(matching);
  }
  await sendWake(env, wake.id);
  await tellScreens(env, changed(run));
  return await toView(env, {
    ...found,
    decision: answered,
    decidedByName: by.name,
  });
};
