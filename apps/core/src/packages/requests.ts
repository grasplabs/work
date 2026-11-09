import { appErrors } from "@grasp-os/shared/apps";
import type { AgentProposer } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import {
  dependencyDecisionSchema,
  dependencyErrors,
  packageKey,
} from "@grasp-os/shared/dependencies";
import type {
  DependencyFinding,
  DependencyRequest,
  DependencyStatus,
  DependencySubject,
} from "@grasp-os/shared/dependencies";
import {
  chatIdSchema,
  identifierSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type { ChatId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { graspLockHash, packageErrors } from "@grasp-os/shared/packages";
import type { GraspLock } from "@grasp-os/shared/packages";
import { roleErrors } from "@grasp-os/shared/roles";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
import type { Acting } from "../auth/identity.ts";
import { dependencyRequests, users } from "../db/core/schema.ts";
import { isUniqueViolation } from "../db/d1.ts";
import { workspace } from "../durable-objects.ts";
import {
  latest,
  ofSubject,
  refuseMalware,
  requestEntry,
  snapshotOf,
} from "./approvals.ts";
import { knownMalwareIn } from "./malware.ts";
import type { MalwareFound } from "./malware.ts";
import {
  buildsNowSql,
  builtSubject,
  subjectName,
  subjectOfInput,
} from "./subjects.ts";

// npm packages asked for an App, its builder's decision on them, and the one check that says whether a graph may be used. Nothing
// here fetches or runs a package: a lock is data core resolved itself
// (resolve.ts), and an approval is a row. What could go wrong, and what
// stops it:
//
// - The agent approving for itself. It resolves, which proposes, and
//   nothing more: its APIs have no decision, and `decideDependency`
//   refuses any identity an agent acts under (`actor`, `via`). Deciding is
//   only on a person's own `/rpc` session, with the session's identity.
// - Someone who doesn't build the App deciding: the decider
//   must build the request's own subject (`builtSubject`), never one they
//   name; Grasp staff never decide.
// - An approval replayed for another graph: the decision names the graph
//   hash its person reviewed, and the one update that takes it lands only
//   while that request is pending with exactly that graph. A request
//   never changes: asking for anything else is another request with
//   another hash, which replaces the pending one.
// - Known malware approved anyway: both sources are asked again as the
//   approval is made, and a report refuses it; a check that can't be made
//   refuses it too. Malware is refused at resolve and build as well, and
//   the clock revokes an approval a later report covers (rescan.ts).
// - Packages used without an approval: `approvedLock` is the only way to
//   a graph's lock for a build, and only an approved row holds one.
// - An older approval coming back: a subject has one current approval.
//   Approving another retires it in the decision's batch, so a removal
//   holds, a package removed can be asked for again, and revoking the
//   current one leaves no approval to fall back on.
//
// Every request, decision, refusal of malware and revocation is audited.

type Row = typeof dependencyRequests.$inferSelect;

const notFound = () => dependencyErrors.create("dependency.not_found");

/** `row` as the API returns it, with its subject's and the people's names. */
const toRequest = async (env: Env, row: Row): Promise<DependencyRequest> => {
  const { lock, findings, removed } = snapshotOf(row);
  const people = [row.requestedBy, row.decidedBy].filter((id) => id !== null);
  const [name, named] = await Promise.all([
    subjectName(env, { type: row.subjectType, id: row.subjectId }),
    drizzle(env.DB)
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, people)),
  ]);
  const person = (userId: string) => ({
    userId,
    name: named.find(({ id }) => id === userId)?.name ?? "",
  });
  return {
    id: row.id,
    subject: { type: row.subjectType, id: row.subjectId, name },
    // Replaced by a later approval: no longer the subject's packages.
    status: row.status === "retired" ? "revoked" : row.status,
    purpose: row.purpose,
    graphHash: row.graphHash,
    lock,
    findings,
    removed,
    requestedBy: person(row.requestedBy),
    requestedAt: row.requestedAt.toISOString(),
    ...(row.decidedBy !== null && row.decidedAt !== null
      ? {
          decided: {
            by: person(row.decidedBy),
            at: row.decidedAt.toISOString(),
            reason: row.reason,
          },
        }
      : {}),
    ...(row.status === "revoked" && row.endedAt !== null
      ? {
          revoked: {
            at: row.endedAt.toISOString(),
            reason: row.endedReason ?? "",
          },
        }
      : {}),
  };
};

/** Every chat whose agent asked for `row`. */
const chatsOf = (
  row: Pick<Row, "requestedVia" | "requestedIn">
): AgentProposer[] =>
  row.requestedIn ?? (row.requestedVia === null ? [] : [row.requestedVia]);

/**
 * Tells `chats`, whose agents asked for a request, that something about
 * it changed: each page shows the card at once, mid-turn too, and with
 * `decided` each agent is told how it was decided. A failure is logged:
 * what changed stands.
 */
const tellChats = async (
  env: Env,
  row: Pick<Row, "requestedVia" | "requestedIn">,
  decided?: "approved" | "denied",
  chats: readonly AgentProposer[] = chatsOf(row)
): Promise<void> => {
  await Promise.all(
    chats.map(async (via) => {
      try {
        const chat = workspace(env, workspaceIdSchema.parse(via.workspaceId));
        await (decided === undefined
          ? chat.heldChanged(chatIdSchema.parse(via.chatId))
          : chat.packagesDecided(via.chatId, via.onBehalfOf, decided));
      } catch (error) {
        log.warn("dependencies.chat_unreached", {
          chatId: via.chatId,
          ...errorFields(error),
        });
      }
    })
  );
};

/**
 * Adds the chat `by` asks from to those of `waiting`, the same request
 * already waiting, and shows it its card: every chat that asked is told.
 */
const alsoAskedFrom = async (
  env: Env,
  by: Acting,
  waiting: Row
): Promise<Row> => {
  const { via } = by;
  if (
    via === undefined ||
    chatsOf(waiting).some(({ chatId }) => chatId === via.chatId)
  ) {
    return waiting;
  }
  const requestedIn = [...chatsOf(waiting), via];
  const [updated] = await drizzle(env.DB)
    .update(dependencyRequests)
    .set({ requestedIn })
    .where(
      and(
        eq(dependencyRequests.id, waiting.id),
        eq(dependencyRequests.status, "pending")
      )
    )
    .returning();
  if (updated === undefined) {
    return waiting;
  }
  await tellChats(env, updated, undefined, [via]);
  return updated;
};

/**
 * Proposes `lock` for `subject`, as one of its builders or the chat's
 * agent acting for one: a pending request, which allows nothing. The
 * same graph already approved is that approval; the same one waiting is
 * that request. Anything else waiting for the subject is replaced, in the
 * batch that stores the new request, so one request waits per subject.
 */
export const propose = async (
  env: Env,
  by: Acting,
  subject: DependencySubject,
  purpose: string,
  lock: GraspLock,
  findings: DependencyFinding[],
  /** The packages it takes out of the subject's approved set, by name. */
  removed: string[]
): Promise<DependencyRequest> => {
  const graphHash = await graspLockHash(lock);
  const actor = by.actor ?? actorOf(by);
  const db = drizzle(env.DB);
  for (let tries = 0; ; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- again only after a race
    const [approved, waiting] = await Promise.all([
      latest(env, subject, "approved", graphHash),
      latest(env, subject, "pending"),
    ]);
    if (approved) {
      // oxlint-disable-next-line no-await-in-loop -- answers, ending the loop
      return await toRequest(env, approved);
    }
    if (waiting?.graphHash === graphHash) {
      // oxlint-disable-next-line no-await-in-loop -- answers, ending the loop
      return await toRequest(env, await alsoAskedFrom(env, by, waiting));
    }
    const row: Row = {
      id: crypto.randomUUID(),
      subjectType: subject.type,
      subjectId: subject.id,
      sourceRevision: "",
      graphHash,
      targets: "[]",
      purpose,
      snapshot: JSON.stringify({ lock, findings, removed }),
      summary: {
        direct: Object.entries(lock.direct).map(([name, version]) =>
          packageKey({ name, version })
        ),
        findings: findings.slice(0, 5),
      },
      direct: Object.keys(lock.direct).length,
      packages: Object.keys(lock.packages).length,
      findings: findings.length,
      refused: 0,
      previous: null,
      status: "pending",
      requestedBy: by.userId,
      requestedVia: by.via ?? null,
      requestedIn: by.via === undefined ? null : [by.via],
      requestedAt: new Date(),
      policyGeneration: 0,
      decidedBy: null,
      decidedAt: null,
      decidedGeneration: null,
      reason: null,
      endedBy: null,
      endedAt: null,
      endedGeneration: null,
      endedReason: null,
      malwareCheckedAt: null,
      advisories: null,
    };
    const asked = [
      db.insert(dependencyRequests).values(row),
      outboxed(
        db,
        requestEntry(actor, "requested", row, {
          requestedBy: by.userId,
          findings: row.findings,
        })
      ),
    ] as const;
    try {
      // The request it replaces goes first: one waits per subject.
      // oxlint-disable-next-line no-await-in-loop -- again only after a race
      await (waiting
        ? auditedBatch(env, db, [
            db
              .delete(dependencyRequests)
              .where(
                and(
                  eq(dependencyRequests.id, waiting.id),
                  eq(dependencyRequests.status, "pending")
                )
              ),
            outboxedIfChanged(
              db,
              requestEntry(actor, "superseded", waiting, { by: row.id })
            ),
            ...asked,
          ])
        : auditedBatch(env, db, asked));
    } catch (error) {
      // Another request for the subject landed first: go by how things
      // stand now, once.
      if (isUniqueViolation(error) && tries === 0) {
        continue;
      }
      throw isUniqueViolation(error)
        ? dependencyErrors.create("dependency.stale")
        : error;
    }
    // oxlint-disable-next-line no-await-in-loop -- once, after it landed
    await tellChats(env, row);
    // oxlint-disable-next-line no-await-in-loop -- once, after it landed
    return await toRequest(env, row);
  }
};

/** How an App's packages stand, for its builders. */
export const dependencyStatus = async (
  env: Env,
  by: Acting,
  input: unknown
): Promise<DependencyStatus> => {
  const { type, id } = await builtSubject(env, by, subjectOfInput(input));
  const subject: DependencySubject = { type, id };
  const [pending, approved] = await Promise.all([
    latest(env, subject, "pending"),
    latest(env, subject, "approved"),
  ]);
  return {
    pending: pending ? await toRequest(env, pending) : null,
    approved: approved ? await toRequest(env, approved) : null,
  };
};

/**
 * The requests the agent of `chatId`, `userId`'s own chat, asked for and
 * that still wait: what the chat's card shows them to decide.
 */
export const chatPackageRequests = async (
  env: Env,
  userId: string,
  chatId: ChatId
): Promise<DependencyRequest[]> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(dependencyRequests)
    .where(
      and(
        eq(dependencyRequests.status, "pending"),
        sql`EXISTS (SELECT 1 FROM json_each(coalesce(${dependencyRequests.requestedIn}, json_array(json(${dependencyRequests.requestedVia})))) AS asked
          WHERE json_extract(asked.value, '$.chatId') = ${chatId}
            AND json_extract(asked.value, '$.onBehalfOf') = ${userId})`
      )
    )
    .orderBy(dependencyRequests.requestedAt);
  return await Promise.all(rows.map(async (row) => await toRequest(env, row)));
};

/**
 * Refuses approving `row`'s graph when a package of it is now known as
 * malware, asked of both sources again: one reported after it was
 * proposed is refused all the same. Fails closed when either can't be
 * read, audited as an approval refused with connect's error code.
 */
const refuseKnownMalware = async (
  env: Env,
  actor: AuditActor,
  row: Row
): Promise<void> => {
  const { lock } = snapshotOf(row);
  let found: MalwareFound[];
  try {
    found = await knownMalwareIn(env, Object.values(lock.packages));
  } catch (error) {
    const db = drizzle(env.DB);
    await auditedBatch(env, db, [
      outboxed(
        db,
        requestEntry(actor, "approval_refused", row, {
          errorCode: packageErrors.codeOf(error) ?? "internal.unexpected",
        })
      ),
    ]);
    throw error;
  }
  const [first, ...rest] = found;
  if (first !== undefined) {
    await refuseMalware(
      env,
      actor,
      { type: row.subjectType, id: row.subjectId },
      [first, ...rest],
      "approval"
    );
  }
};

/**
 * `row`'s subject for `by` to decide, as one of its builders: anyone with
 * no role in it is told no request is there; one who only uses it, that
 * they may not.
 */
const requireDecider = async (env: Env, by: Acting, row: Row) => {
  try {
    await builtSubject(env, by, { type: row.subjectType, id: row.subjectId });
  } catch (error) {
    if (appErrors.codeOf(error) === "app.not_found") {
      throw notFound();
    }
    if (roleErrors.codeOf(error) === "role.forbidden") {
      throw dependencyErrors.create("dependency.forbidden");
    }
    throw error;
  }
};

/**
 * Approves or denies a pending request for `by`, once, as a builder of
 * its App, from their own session: never an agent acting for
 * them, nor Grasp staff. One conditional update is the decision: it lands
 * only while the request is pending with the graph `by` reviewed. The
 * person who asked may decide (the chat's card asks them): the audit
 * event says so (`selfDecided`).
 */
export const decideDependency = async (
  env: Env,
  by: Acting,
  input: unknown,
  decision: unknown
): Promise<DependencyRequest> => {
  if (by.staff || by.actor !== undefined || by.via !== undefined) {
    throw dependencyErrors.create("dependency.forbidden");
  }
  const { approved, graphHash, reason } = dependencyErrors.parse(
    "dependency.invalid",
    dependencyDecisionSchema,
    decision
  );
  const id = identifierSchema.safeParse(input);
  const db = drizzle(env.DB);
  const row = id.success
    ? await db
        .select()
        .from(dependencyRequests)
        .where(eq(dependencyRequests.id, id.data))
        .get()
    : undefined;
  if (!row) {
    throw notFound();
  }
  await requireDecider(env, by, row);
  if (row.status !== "pending" || row.graphHash !== graphHash) {
    throw dependencyErrors.create("dependency.stale");
  }
  const actor = actorOf(by);
  if (approved) {
    await refuseKnownMalware(env, actor, row);
  }
  const status = approved ? "approved" : "denied";
  const subject: DependencySubject = {
    type: row.subjectType,
    id: row.subjectId,
  };
  const replaced = approved
    ? await latest(env, subject, "approved")
    : undefined;
  const decidedAt = new Date();
  // What was known of it as it was approved: the clock tells its builders
  // of any advisory past these (rescan.ts).
  const known = snapshotOf(row).findings.flatMap(({ id: advisory }) =>
    advisory === null ? [] : [advisory]
  );
  const [[decided]] = await auditedBatch(env, db, [
    db
      .update(dependencyRequests)
      .set({
        status,
        decidedBy: by.userId,
        decidedAt,
        decidedGeneration: 0,
        reason: reason ?? null,
        advisories: approved ? [...new Set(known)] : null,
      })
      .where(
        and(
          eq(dependencyRequests.id, row.id),
          eq(dependencyRequests.status, "pending"),
          eq(dependencyRequests.graphHash, graphHash),
          // Still a builder, read here: the malware check above can take a
          // while, and a role taken away meanwhile decides nothing.
          buildsNowSql(subject, by)
        )
      )
      .returning(),
    outboxedIfChanged(
      db,
      requestEntry(actor, status, row, {
        requestedBy: row.requestedBy,
        selfDecided: row.requestedBy === by.userId,
        ...(reason === undefined ? {} : { reason }),
      })
    ),
    // The approval it replaces retires, and only once this one landed:
    // one current approval per subject.
    ...(replaced === undefined
      ? []
      : [
          db
            .update(dependencyRequests)
            .set({
              status: "retired",
              endedAt: decidedAt,
              endedReason: `Replaced by request ${row.id}`,
            })
            .where(
              and(
                ofSubject(subject),
                eq(dependencyRequests.status, "approved"),
                ne(dependencyRequests.id, row.id),
                sql`EXISTS (SELECT 1 FROM ${dependencyRequests} WHERE ${dependencyRequests.id} = ${row.id} AND ${dependencyRequests.status} = 'approved')`
              )
            ),
          outboxedIfChanged(
            db,
            requestEntry(actor, "retired", replaced, { by: row.id })
          ),
        ]),
  ]);
  if (!decided) {
    // No longer theirs to decide, or decided meanwhile.
    await requireDecider(env, by, row);
    throw dependencyErrors.create("dependency.stale");
  }
  await tellChats(env, decided, status);
  return await toRequest(env, decided);
};
