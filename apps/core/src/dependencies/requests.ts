import { appErrors } from "@grasp-os/shared/apps";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import {
  canonicalGraph,
  dependencyApprovalsDigest,
  dependencyDecisionSchema,
  dependencyApprovalsListed,
  dependencyEndingSchema,
  dependencyErrors,
  dependencyGraphHash,
  dependencyGraphSchema,
  dependencyImpactListed,
  dependencyMaxBytes,
  dependencyProposalSchema,
  dependencySubjectsListed,
  subjectOfRef,
  dependencySummaryDirect,
  dependencySummaryFindings,
  dependencyTargetSchema,
  packageKey,
} from "@grasp-os/shared/dependencies";
import type {
  DependenciesWaiting,
  DependencyApprovals,
  DependencyFinding,
  DependencyGraph,
  DependencyImpact,
  DependencyImpactArtifact,
  DependencyPackage,
  DependencyRefusal,
  DependencyRequest,
  DependencyReview,
  DependencyStatus,
  DependencySubject,
  DependencySubjectsInForce,
  DependencyTarget,
  NamedDependencySubject,
} from "@grasp-os/shared/dependencies";
import {
  appIdSchema,
  identifierSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { graspLockSchema } from "@grasp-os/shared/packages";
import type { GraspLock, PackageLimits } from "@grasp-os/shared/packages";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import {
  auditedBatch,
  outboxed,
  outboxedEventWhere,
  outboxedIfChanged,
  storedEvent,
} from "../audit-outbox.ts";
import type { Acting } from "../auth/identity.ts";
import {
  auditOutbox,
  dependencyAdmissionRefusals,
  dependencyLocks,
  dependencyPolicy,
  dependencyRequests,
  users,
  workflowResources,
} from "../db/core/schema.ts";
import { isUniqueViolation } from "../db/d1.ts";
import {
  failUnless,
  lockGuardFailed,
  lockStatements,
  unusedLockStatements,
} from "../packages/locks.ts";
import { holdsApprove, holdsApproveSql } from "./approvers.ts";
import { peerIssues } from "./peers.ts";
import { dropPending } from "./pending.ts";
import {
  advancePolicy,
  policyGeneration,
  policyGenerationSql,
} from "./policy.ts";
import { builtSubject } from "./subject-builders.ts";
import {
  auditTargetOf,
  ofSubject,
  subjectKey,
  subjectNames,
  subjectOfInput,
  subjectOfRow,
} from "./subjects.ts";

// npm packages proposed for an App or a workflow (its subject,
// subjects.ts), a person's decision on them, and the one check that says
// whether a graph may be used. Everything below holds per subject: what
// it says of an App holds of a workflow too, whose packages are only
// ever for its compute modules (`computation`), and an approval is its
// subject's alone. Nothing here fetches,
// unpacks or runs a package: a graph is data handed in, and an approval is
// a row. What could go wrong, and what stops it:
//
// - Packages used before anyone approved them. A request allows nothing.
//   `admitDependencies` is the only way a graph counts as approved, and it
//   answers yes for exactly what a person approved: this App, this graph
//   (by its hash, which core computes itself from the packages, never
//   takes from the request) and these targets. Anything else is refused,
//   and the refusal is audited once per App, graph, targets, policy
//   generation and reason, for a graph some request names; any other hash
//   a caller makes up is refused and logged, so asking again and again
//   can't flood the audit trail.
// - An agent, a workflow or App code approving. They resolve
//   (agent-builds.ts, packages/resolve.ts), which proposes, and nothing
//   more: deciding is only on a person's own `/rpc` session, and takes the
//   session's identity, never one handed in.
// - A graph whose packages are whatever its proposer says. Nobody hands
//   in a graph: the resolver is the only proposer (packages/resolve.ts),
//   and every version, integrity hash, licence and edge in a request is
//   what it read from the registry through connect, with every tarball's
//   bytes checked against its integrity and unpacked in quarantine.
// - A role standing in for the permission, or someone deciding after they
//   lost it, left, or were taken off the team. Whether the person holds
//   `dependencies.approve` is part of the one update that takes the
//   decision (`holdsApproveSql`), so it is read as the decision lands.
// - A decision on something other than what the person reviewed. The same
//   update lands only while the request is still pending, its graph is the
//   one they named, and the policy generation is the one they saw. A
//   request never changes: a proposal for other packages or targets takes
//   the pending one's place, so the source asking for something else
//   refuses the old request. What is approved is the graph, whichever
//   revision of the source it was resolved from: the same packages at a
//   later revision need no new approval, and any other package, version,
//   byte, edge or target is another graph, with another hash.
// - Two decisions. The first lands; the second finds nothing pending.
// - One huge request, or many. The size is measured on what core stores,
//   never taken from a count in the request, and the lists are capped. One
//   request waits per App, and one that is replaced is deleted, so asking
//   again and again stores nothing more. No list reads a request's whole
//   graph: lists select the columns they show.
// - Package text steering anyone. A licence or a finding's summary is
//   bounded text shown as text; nothing reads it as instructions.
// - A request showing more than the decision needs. It holds package
//   metadata only: no source, records or credentials can be put in one.
// - An approval taken for more than it is. It says these exact packages
//   may be used by this App on these targets. It grants no connector,
//   collection, file or model access, approves no browser artifact for
//   sensitive data, and every use still runs under the App's own
//   permissions.
//
// - An approval that should end, and doesn't. A person who holds
//   `dependencies.approve` retires or revokes an App's graph (spec
//   19.3.1), every approval of it at once, so no approval of the same
//   graph for other targets keeps it in use. Retired is a lifecycle
//   decision: nothing new is admitted (`admitDependencies` with `new`, the
//   default), and only what was built before is (`retained`: the
//   artifacts the lock pinned, which no pin adds to once the graph is
//   retired, packages/build.ts). Revoked is a security decision: nothing
//   at all is admitted. Neither row is ever approved again: approving the
//   graph again is a new request, and both stay as history.
// - Ending an approval on what the person didn't see. The one batch that
//   ends it lands only while the approvals still in force are exactly the
//   ones they read, the policy generation is the one they read, and they
//   hold the permission; it moves the generation on with its audit event,
//   so a build that read the generation before is refused, and its pin
//   (whose write checks both) either landed before, and is what a retired
//   graph keeps, or never lands.
//
// Not stopped here: a licence is what the package states of itself, and
// a request reports no findings yet (no advisory source is read). What a
// person approves is the graph by its hash, so what is later fetched must
// match it byte for byte to be admitted.

type Row = typeof dependencyRequests.$inferSelect;

/**
 * A request as lists read it: every column but its whole review
 * (`snapshot`, up to {@link dependencyMaxBytes} each).
 */
const { snapshot: _snapshot, ...listed } = getTableColumns(dependencyRequests);
type Listed = Omit<Row, "snapshot">;

/** What a request keeps of its review, as JSON in `snapshot`. */
const snapshotSchema = z.object({
  graph: dependencyGraphSchema,
  findings: z.array(z.custom<DependencyFinding>()),
  refused: z.array(z.custom<DependencyRefusal>()),
});

const targetsSchema = z.array(dependencyTargetSchema);

const targetsOf = (row: Pick<Row, "targets">): DependencyTarget[] =>
  targetsSchema.parse(JSON.parse(row.targets));

/** Whether `row` is for every one of `targets`. */
const covers = (
  row: Pick<Row, "targets">,
  targets: readonly DependencyTarget[]
): boolean => {
  const approved = targetsOf(row);
  return targets.every((target) => approved.includes(target));
};

/** How often a proposal starts over when another one for the App lands first. */
const proposalTries = 3;

const notFound = () => dependencyErrors.create("dependency.not_found");

type DependencyAction =
  | "requested"
  | "superseded"
  | "withdrawn"
  | "approved"
  | "denied"
  | "retired"
  | "revoked"
  | "admission_refused";

/** The audit entry of something that happened to a request: identifiers only. */
const requestEntry = (
  actor: AuditActor,
  action: DependencyAction,
  row: Pick<
    Row,
    | "id"
    | "subjectType"
    | "subjectId"
    | "sourceRevision"
    | "graphHash"
    | "targets"
    | "direct"
    | "packages"
  >,
  detail: Record<string, string | number | boolean | null> = {}
): AuditEntry => ({
  actor,
  action: `dependency.${action}`,
  target: { type: "dependency_request", id: row.id },
  detail: {
    [row.subjectType]: row.subjectId,
    sourceRevision: row.sourceRevision,
    graphHash: row.graphHash,
    targets: targetsOf(row).join(" "),
    direct: row.direct,
    packages: row.packages,
    ...detail,
  },
});

/** `rows` as the API returns them, with their subjects' and the people's names. */
const toRequests = async (
  env: Env,
  rows: readonly Listed[],
  names: "read" | "if they can be read" = "read"
): Promise<DependencyRequest[]> => {
  if (rows.length === 0) {
    return [];
  }
  const db = drizzle(env.DB);
  const people = [
    ...new Set(
      rows.flatMap(({ requestedBy, decidedBy, endedBy }) =>
        [requestedBy, decidedBy, endedBy].filter((id) => id !== null)
      )
    ),
  ];
  const read = async () =>
    await Promise.all([
      subjectNames(db, rows.map(subjectOfRow)),
      db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, people)),
    ]);
  let subjectName = new Map<string, string>();
  let personNames: { id: string; name: string }[] = [];
  try {
    [subjectName, personNames] = await read();
  } catch (error) {
    // After a change landed, its answer goes without the names rather
    // than fail as if it hadn't.
    if (names === "read") {
      throw error;
    }
    log.warn("dependencies.names_unread", errorFields(error));
  }
  const personName = new Map(personNames.map(({ id, name }) => [id, name]));
  const person = (userId: string) => ({
    userId,
    name: personName.get(userId) ?? "",
  });
  return rows.map((row) => ({
    id: row.id,
    subject: {
      ...subjectOfRow(row),
      name: subjectName.get(subjectKey(subjectOfRow(row))) ?? "",
    },
    status: row.status,
    sourceRevision: row.sourceRevision,
    purpose: row.purpose,
    targets: targetsOf(row),
    graphHash: row.graphHash,
    counts: {
      direct: row.direct,
      packages: row.packages,
      findings: row.findings,
      refused: row.refused,
    },
    summary: row.summary,
    requestedBy: person(row.requestedBy),
    requestedAt: row.requestedAt.toISOString(),
    requestedVia: row.requestedVia ?? null,
    policyGeneration: row.policyGeneration,
    ...(row.decidedBy !== null &&
    row.decidedAt !== null &&
    row.decidedGeneration !== null
      ? {
          decided: {
            by: person(row.decidedBy),
            at: row.decidedAt.toISOString(),
            reason: row.reason,
            policyGeneration: row.decidedGeneration,
          },
        }
      : {}),
    ...(row.endedBy !== null &&
    row.endedAt !== null &&
    row.endedGeneration !== null &&
    row.endedReason !== null
      ? {
          ended: {
            by: person(row.endedBy),
            at: row.endedAt.toISOString(),
            reason: row.endedReason,
            policyGeneration: row.endedGeneration,
          },
        }
      : {}),
  }));
};

const toRequest = async (env: Env, row: Listed): Promise<DependencyRequest> => {
  const [request] = await toRequests(env, [row]);
  if (request === undefined) {
    throw new Error(`Dependency request ${row.id} is missing`);
  }
  return request;
};

/**
 * A subject's approvals of the graph `graphHash`, in no order, without
 * the graph: one for each set of targets it was approved for, so a
 * handful at most, however many graphs the subject has had approved.
 */
const approvalsOf = async (
  env: Env,
  subject: DependencySubject,
  graphHash: string
): Promise<Listed[]> =>
  await drizzle(env.DB)
    .select(listed)
    .from(dependencyRequests)
    .where(
      and(
        ofSubject(dependencyRequests, subject),
        eq(dependencyRequests.graphHash, graphHash),
        eq(dependencyRequests.status, "approved")
      )
    );

/** The approval a subject got last, if any, without its graph. */
const latestApproval = async (
  env: Env,
  subject: DependencySubject
): Promise<Listed | undefined> =>
  await drizzle(env.DB)
    .select(listed)
    .from(dependencyRequests)
    .where(
      and(
        ofSubject(dependencyRequests, subject),
        eq(dependencyRequests.status, "approved")
      )
    )
    .orderBy(desc(dependencyRequests.decidedAt))
    .limit(1)
    .get();

/** The one request waiting for a subject, if any, without its graph. */
const pendingFor = async (
  env: Env,
  subject: DependencySubject
): Promise<Listed | undefined> =>
  await drizzle(env.DB)
    .select(listed)
    .from(dependencyRequests)
    .where(
      and(
        ofSubject(dependencyRequests, subject),
        eq(dependencyRequests.status, "pending")
      )
    )
    .get();

/** How grave each severity is, for which findings a list shows first. */
const gravity: Record<DependencyFinding["severity"], number> = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  info: 0,
};

/** The lock a resolve proposes its graph with, stored in the same batch. */
interface ResolvedLock {
  lock: GraspLock;
  limits: PackageLimits;
}

/** Whether request `id` waits with exactly `snapshot` as its review. */
const sameReview = async (
  db: DrizzleD1Database,
  id: string,
  snapshot: string
): Promise<boolean> => {
  const same = await db
    .select({ id: dependencyRequests.id })
    .from(dependencyRequests)
    .where(
      and(
        eq(dependencyRequests.id, id),
        eq(dependencyRequests.snapshot, snapshot)
      )
    )
    .get();
  return same !== undefined;
};

/** What a proposal is, once checked, as each attempt goes by it. */
interface Checked {
  proposal: z.output<typeof dependencyProposalSchema>;
  subject: DependencySubject;
  graph: DependencyGraph;
  graphHash: string;
  targets: string;
  snapshot: string;
}

/** A new pending request's row for `checked`. */
const newRequest = (
  { proposal, subject, graph, graphHash, targets, snapshot }: Checked,
  by: Acting,
  previous: string | null,
  generation: number
): Row => ({
  id: crypto.randomUUID(),
  subjectType: subject.type,
  subjectId: subject.id,
  sourceRevision: proposal.sourceRevision,
  graphHash,
  targets,
  purpose: proposal.purpose,
  snapshot,
  summary: {
    direct: graph.direct.slice(0, dependencySummaryDirect).map(packageKey),
    findings: proposal.findings
      .toSorted((a, b) => gravity[b.severity] - gravity[a.severity])
      .slice(0, dependencySummaryFindings),
  },
  direct: graph.direct.length,
  packages: graph.packages.length,
  findings: proposal.findings.length,
  refused: proposal.refused.length,
  previous,
  status: "pending",
  requestedBy: by.userId,
  requestedVia: by.via ?? null,
  requestedAt: new Date(),
  policyGeneration: generation,
  decidedBy: null,
  decidedAt: null,
  decidedGeneration: null,
  reason: null,
  endedBy: null,
  endedAt: null,
  endedGeneration: null,
  endedReason: null,
});

/**
 * The statement that fails a proposal's batch (`failUnless`) unless its
 * subject is still there as it runs: a workflow deleted after `propose`
 * checked it gets no request or lock, which its deletion's batch
 * (`withdrawnWithWorkflow`, pending.ts) would have withdrawn had it come
 * first. An App's rows go with the App.
 */
const stillThere = (
  db: DrizzleD1Database,
  subject: DependencySubject,
  graphHash: string
) =>
  subject.type === "workflow"
    ? [
        failUnless(
          db,
          subject,
          graphHash,
          sql`EXISTS (SELECT 1 FROM ${workflowResources} WHERE ${workflowResources.id} = ${subject.id} AND ${workflowResources.deletedAt} IS NULL)`
        ),
      ]
    : [];

/** One attempt's outcome: the request it answers with, and its batch. */
interface Attempt {
  request: Listed;
  statements: BatchItem<"sqlite">[];
  lock: GraspLock | undefined;
}

/**
 * What one attempt at a proposal writes, by how things stand as it reads
 * them: see `propose`.
 */
const attempt = async (
  env: Env,
  by: Acting,
  checked: Checked,
  resolved: ResolvedLock | undefined
): Promise<Attempt> => {
  const { proposal, subject, graphHash, targets, snapshot } = checked;
  const actor = by.actor ?? actorOf(by);
  const db = drizzle(env.DB);
  const [approvals, latest, waiting, generation, written] = await Promise.all([
    approvalsOf(env, subject, graphHash),
    latestApproval(env, subject),
    pendingFor(env, subject),
    policyGeneration(db),
    resolved === undefined
      ? undefined
      : lockStatements(db, by, {
          subject,
          graphHash,
          fresh: resolved.lock,
          limits: resolved.limits,
        }),
  ]);
  const live = stillThere(db, subject, graphHash);
  const lockFirst = written?.statements ?? [];
  const lock = written?.lock;
  const standing = approvals.find((row) => covers(row, proposal.targets));
  if (standing) {
    // The App is back on a graph it has approved: whatever else waits for
    // it is no longer asked for, and goes as any replaced request.
    // Whatever waits as the batch runs, not what was read above: another
    // proposal may have taken that one's place since. Dropped before the
    // lock is written, so the lock of what waited gives up its room to it
    // (`lockStatements`).
    //
    // The approval may be retired or revoked as this runs: the batch then
    // fails whole (`failUnless`), and the next attempt finds it no longer
    // standing, and asks for a new one.
    return {
      request: standing,
      lock,
      statements: [
        ...live,
        failUnless(
          db,
          subject,
          graphHash,
          sql`EXISTS (SELECT 1 FROM ${dependencyRequests} WHERE ${dependencyRequests.id} = ${standing.id} AND ${dependencyRequests.status} = 'approved')`
        ),
        ...dropPending(db, actor, subject, {
          action: "superseded",
          by: standing.id,
        }),
        ...lockFirst,
        ...unusedLockStatements(db, subject),
      ],
    };
  }
  // The same graph and targets: the same request if what was reported of
  // it is the same too. Only this one row's review is read.
  if (
    waiting?.graphHash === graphHash &&
    waiting.targets === targets &&
    (await sameReview(db, waiting.id, snapshot))
  ) {
    return {
      request: waiting,
      lock,
      statements: lockFirst.length === 0 ? [] : [...live, ...lockFirst],
    };
  }
  const row = newRequest(checked, by, latest?.id ?? null, generation);
  const superseded = waiting
    ? [
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
      ]
    : [];
  return {
    request: row,
    lock,
    // The request it replaces goes first, so its lock gives up its room to
    // this one's (`lockStatements`).
    statements: [
      ...live,
      ...superseded,
      ...lockFirst,
      db.insert(dependencyRequests).values(row),
      outboxed(
        db,
        requestEntry(actor, "requested", row, {
          requestedBy: by.userId,
          findings: row.findings,
          refused: row.refused,
          policyGeneration: generation,
        })
      ),
      ...unusedLockStatements(db, subject),
    ],
  };
};

/**
 * Proposes a graph for an App, as one of its builders or the chat's agent
 * acting for one: a pending request, which allows nothing. Never Grasp
 * staff, who neither ask for nor decide what a client's Apps may use. Not
 * offered to anyone directly: a graph handed in would be whatever its
 * sender says, where the resolver's is what the registry has
 * (`proposeResolved`).
 *
 * What is already there decides what happens. The same graph already
 * approved for these targets, at any revision of the source: that
 * approval, and nothing new. The same review already waiting: that
 * request. Anything else waiting for the App is replaced, in the batch
 * that stores the new request (or on its own, when the proposal is one
 * already approved): its row is deleted (one waits per App, so
 * asking again and again stores nothing more) and the audit log keeps its
 * ID and graph hash, and each lock no pending or approved request names
 * any more goes with it (packages/locks.ts). With `resolved`, its lock is
 * written in each of those batches, and the batch lands only with it. A
 * proposal that loses a race to another starts over.
 */
const propose = async (
  env: Env,
  by: Acting,
  input: unknown,
  resolved?: ResolvedLock
): Promise<{ request: DependencyRequest; lock: GraspLock | undefined }> => {
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const proposal = dependencyErrors.parse(
    "dependency.invalid",
    dependencyProposalSchema,
    input
  );
  const peers = peerIssues(proposal.graph);
  if (peers.length > 0) {
    throw dependencyErrors.create("dependency.invalid", { issues: peers });
  }
  // Its own builders only; a workflow's targets are checked by the schema
  // (`computation` alone).
  const subject = await builtSubject(env, by, subjectOfRef(proposal));
  const graph = canonicalGraph(proposal.graph);
  const snapshot = canonicalJson({
    graph,
    findings: proposal.findings,
    refused: proposal.refused,
  });
  const bytes = new TextEncoder().encode(snapshot).length;
  if (bytes > dependencyMaxBytes) {
    throw dependencyErrors.create("dependency.invalid", {
      issues: [`graph: at most ${dependencyMaxBytes} bytes, this is ${bytes}`],
    });
  }
  const checked: Checked = {
    proposal,
    subject: { type: subject.type, id: subject.id },
    graph,
    graphHash: await dependencyGraphHash(graph),
    targets: JSON.stringify(proposal.targets.toSorted()),
    snapshot,
  };
  const db = drizzle(env.DB);
  for (let tries = 0; tries < proposalTries; tries += 1) {
    // Each attempt reads how things stand now, the lock included.
    // oxlint-disable-next-line no-await-in-loop
    const { request, statements, lock } = await attempt(
      env,
      by,
      checked,
      resolved
    );
    const [first, ...rest] = statements;
    try {
      if (first !== undefined) {
        // oxlint-disable-next-line no-await-in-loop
        await auditedBatch(env, db, [first, ...rest]);
      }
      // oxlint-disable-next-line no-await-in-loop
      return { request: await toRequest(env, request), lock };
    } catch (error) {
      // Another request for the App is pending now, or another resolve
      // wrote the lock first: the batch wrote nothing, and the next
      // attempt goes by how things stand then.
      if (!(isUniqueViolation(error) || lockGuardFailed(error))) {
        throw error;
      }
      // Or the subject went as it ran (`stillThere`): refused as gone.
      // oxlint-disable-next-line no-await-in-loop
      await builtSubject(env, by, subject);
    }
  }
  throw dependencyErrors.create("dependency.stale");
};

/**
 * Proposes a graph with no lock of its own: `propose`'s request alone.
 * For tests only, of the request machinery itself (approval, supersession,
 * decisions): nothing in the product calls it, and nothing offers it to a
 * client. The product proposes only what it resolved (`proposeResolved`).
 */
export const proposeForTests = async (
  env: Env,
  by: Acting,
  input: unknown
): Promise<DependencyRequest> => {
  const { request } = await propose(env, by, input);
  return request;
};

/**
 * Proposes the graph a resolve made (packages/resolve.ts), with its lock,
 * which is stored in the batch that stores the request: never one without
 * the other. Returns the request and the lock that holds.
 */
export const proposeResolved = async (
  env: Env,
  by: Acting,
  input: unknown,
  resolved: ResolvedLock
): Promise<{ request: DependencyRequest; lock: GraspLock }> => {
  const { request, lock } = await propose(env, by, input, resolved);
  return { request, lock: lock ?? resolved.lock };
};

/** How an App's or a workflow's dependencies stand, for its builders. */
export const dependencyStatus = async (
  env: Env,
  by: Acting,
  input: unknown
): Promise<DependencyStatus> => {
  const { type, id } = await builtSubject(env, by, subjectOfInput(input));
  const subject: DependencySubject = { type, id };
  const [generation, pending, approved] = await Promise.all([
    policyGeneration(drizzle(env.DB)),
    pendingFor(env, subject),
    latestApproval(env, subject),
  ]);
  return {
    policyGeneration: generation,
    pending: pending ? await toRequest(env, pending) : null,
    approved: approved ? await toRequest(env, approved) : null,
  };
};

/**
 * The requests waiting on `by`: every pending one, oldest first, if they
 * hold `dependencies.approve` now; none otherwise, whatever their role.
 * The permission is the deployment's, so a holder sees the request of
 * every App and workflow, shared with them or not, in one queue: its
 * package metadata, never its source.
 */
export const waitingDependencies = async (
  env: Env,
  by: Identity
): Promise<DependenciesWaiting> => {
  const db = drizzle(env.DB);
  const generation = await policyGeneration(db);
  if (!(await holdsApprove(env, by))) {
    return { policyGeneration: generation, requests: [] };
  }
  const rows = await db
    .select(listed)
    .from(dependencyRequests)
    .where(eq(dependencyRequests.status, "pending"))
    .orderBy(dependencyRequests.requestedAt, dependencyRequests.id);
  return {
    policyGeneration: generation,
    requests: await toRequests(env, rows),
  };
};

/** How many requests wait on `by`: as many as `waitingDependencies` lists. */
export const waitingDependencyCount = async (
  env: Env,
  by: Identity
): Promise<number> => {
  if (!(await holdsApprove(env, by))) {
    return 0;
  }
  const row = await drizzle(env.DB)
    .select({ waiting: count() })
    .from(dependencyRequests)
    .where(eq(dependencyRequests.status, "pending"))
    .get();
  return row?.waiting ?? 0;
};

const findRow = async (env: Env, input: unknown): Promise<Row> => {
  const id = identifierSchema.safeParse(input);
  const row = id.success
    ? await drizzle(env.DB)
        .select()
        .from(dependencyRequests)
        .where(eq(dependencyRequests.id, id.data))
        .get()
    : undefined;
  if (!row) {
    throw notFound();
  }
  return row;
};

const byKey = (graph: DependencyGraph): Map<string, DependencyPackage> =>
  new Map(graph.packages.map((node) => [packageKey(node), node]));

const refOf = ({ name, version }: DependencyPackage) => ({ name, version });

/**
 * What `graph` changes of the graph `before` was approved with: the
 * packages it adds, those it no longer brings, and those with the same
 * name and version whose bytes or origin are not the same.
 */
const changesFrom = (
  before: Row,
  graph: DependencyGraph
): NonNullable<DependencyReview["previous"]> => {
  const was = byKey(snapshotSchema.parse(JSON.parse(before.snapshot)).graph);
  const now = byKey(graph);
  return {
    request: before.id,
    added: [...now]
      .filter(([key]) => !was.has(key))
      .map(([, node]) => refOf(node)),
    removed: [...was]
      .filter(([key]) => !now.has(key))
      .map(([, node]) => refOf(node)),
    changed: [...now]
      .filter(([key, node]) => {
        const old = was.get(key);
        return (
          old !== undefined &&
          (old.integrity !== node.integrity || old.origin !== node.origin)
        );
      })
      .map(([, node]) => refOf(node)),
  };
};

/**
 * One request in full, for whoever may decide it (they hold
 * `dependencies.approve` now) or builds its App or workflow;
 * `dependency.not_found` for anyone else, as for one that isn't there.
 */
export const dependencyReview = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<DependencyReview> => {
  const row = await findRow(env, input);
  if (!(await holdsApprove(env, by))) {
    try {
      await builtSubject(env, by, subjectOfRow(row));
    } catch (error) {
      // Not theirs to read: as if it weren't there. Anything else failed.
      if (
        appErrors.codeOf(error) === "app.not_found" ||
        workflowResourceErrors.codeOf(error) ===
          "workflow.resource_unavailable" ||
        roleErrors.codeOf(error) === "role.forbidden"
      ) {
        throw notFound();
      }
      throw error;
    }
  }
  const { graph, findings, refused } = snapshotSchema.parse(
    JSON.parse(row.snapshot)
  );
  const before =
    row.previous === null ? undefined : await findRow(env, row.previous);
  return {
    ...(await toRequest(env, row)),
    graph,
    findings,
    refused,
    previous: before ? changesFrom(before, graph) : null,
  };
};

/**
 * Approves or denies a pending request for `by`, once. One conditional
 * update is the decision: it lands only while the request is pending, its
 * graph is the one reviewed, the policy generation is the one reviewed,
 * and `by` holds `dependencies.approve`, all read as it runs, in the
 * batch that records it. No role decides, nor Grasp staff, nor an agent
 * acting for the person. The person who asked may decide, if they hold
 * the permission themselves: the audit event then says so
 * (`selfDecided`), so a review of the log finds every such decision.
 */
export const decideDependency = async (
  env: Env,
  by: Identity,
  input: unknown,
  decision: unknown
): Promise<DependencyRequest> => {
  // Only a person, from their own session: never an agent acting for one.
  const { actor, via }: Acting = by;
  if (by.staff || actor !== undefined || via !== undefined) {
    throw dependencyErrors.create("dependency.forbidden");
  }
  if (!(await holdsApprove(env, by))) {
    throw dependencyErrors.create("dependency.forbidden");
  }
  const { approved, reviewed, reason } = dependencyErrors.parse(
    "dependency.invalid",
    dependencyDecisionSchema,
    decision
  );
  const id = identifierSchema.safeParse(input);
  const db = drizzle(env.DB);
  const found = id.success
    ? await db
        .select(listed)
        .from(dependencyRequests)
        .where(eq(dependencyRequests.id, id.data))
        .get()
    : undefined;
  if (!found) {
    throw notFound();
  }
  const status = approved ? "approved" : "denied";
  const [[decided]] = await auditedBatch(env, db, [
    db
      .update(dependencyRequests)
      .set({
        status,
        decidedBy: by.userId,
        decidedAt: new Date(),
        decidedGeneration: reviewed.policyGeneration,
        reason: reason ?? null,
      })
      .where(
        and(
          eq(dependencyRequests.id, found.id),
          eq(dependencyRequests.status, "pending"),
          eq(dependencyRequests.graphHash, reviewed.graphHash),
          sql`${policyGenerationSql} = ${reviewed.policyGeneration}`,
          holdsApproveSql(by.userId)
        )
      )
      .returning(listed),
    outboxedIfChanged(
      db,
      requestEntry(actorOf(by), status, found, {
        requestedBy: found.requestedBy,
        selfDecided: found.requestedBy === by.userId,
        policyGeneration: reviewed.policyGeneration,
        ...(reason === undefined ? {} : { reason }),
      })
    ),
    // A denied graph's lock goes, unless another request still names it.
    ...unusedLockStatements(db, subjectOfRow(found)),
  ]);
  if (!decided) {
    // Who holds the permission can have changed since it was checked above.
    throw dependencyErrors.create(
      (await holdsApprove(env, by))
        ? "dependency.stale"
        : "dependency.forbidden"
    );
  }
  return await toRequest(env, decided);
};

const admissionSchema = z
  .strictObject({
    /** Whose graph: an App's or a workflow's, exactly one. */
    app: appIdSchema.optional(),
    workflow: workflowResourceIdSchema.optional(),
    graphHash: z.string().regex(/^[0-9a-f]{64}$/u),
    targets: z.array(dependencyTargetSchema).min(1),
    policyGeneration: z.int().nonnegative(),
  })
  .refine(
    ({ app, workflow }) => (app === undefined) !== (workflow === undefined),
    {
      message: "Either an App or a workflow, not both",
      path: ["app"],
    }
  )
  .transform(({ app, workflow, ...rest }) => ({
    ...rest,
    subject: subjectOfRef({ app, workflow }),
  }));

/** What a use asks for: one graph, for one App or workflow, and targets. */
export type DependencyAdmission = z.input<typeof admissionSchema>;

/**
 * What an admission allows. `approved`: anything the approval covers, a
 * new build included. `retained`: the graph is retired, so only what was
 * built with it before (an artifact its lock pins) may still be used.
 */
export type AdmissionScope = "approved" | "retained";

/** Why an admission was refused. */
export type AdmissionRefusal =
  | "policy_changed"
  | "not_approved"
  | "retired"
  | "revoked";

/** What `admissionOf` decided. */
export type Admission =
  | {
      admitted: true;
      approval: string;
      policyGeneration: number;
      scope: AdmissionScope;
    }
  | {
      admitted: false;
      reason: Exclude<AdmissionRefusal, "retired">;
      /** A request waiting for a decision on the App, if any. */
      waiting: string | undefined;
      /** Whether any request of the App's names the graph, decided or not. */
      requested: boolean;
      /** The policy generation in force, whichever the caller read. */
      generation: number;
    };

/**
 * The one check `admitDependencies` makes, without its audit: whether a
 * person's approval covers exactly this App, graph and targets under the
 * policy generation the caller read, and how far (`AdmissionScope`): an
 * approval in force covers anything; one retired covers only what was
 * built before; one revoked, nothing. For a caller that records a refusal
 * its own way (serving an artifact, packages/serve.ts, which would
 * otherwise write an audit row for every refused file a browser asks for).
 */
export const admissionOf = async (
  db: DrizzleD1Database,
  input: DependencyAdmission
): Promise<Admission> => {
  const asked = admissionSchema.parse(input);
  const [[policy], candidates] = await db.batch([
    // No row yet is generation 0 (policy.ts).
    db
      .select({ generation: dependencyPolicy.generation })
      .from(dependencyPolicy),
    db
      .select({
        id: dependencyRequests.id,
        status: dependencyRequests.status,
        targets: dependencyRequests.targets,
      })
      .from(dependencyRequests)
      .where(
        and(
          ofSubject(dependencyRequests, asked.subject),
          eq(dependencyRequests.graphHash, asked.graphHash)
        )
      ),
  ]);
  const generation = policy?.generation ?? 0;
  const policyChanged = generation !== asked.policyGeneration;
  const covering = (status: Row["status"]) =>
    candidates.find(
      (row) => row.status === status && covers(row, asked.targets)
    );
  if (!policyChanged) {
    // An approval in force first: a graph approved again after it was
    // retired or revoked is approved, whatever its older rows say.
    for (const [status, scope] of [
      ["approved", "approved"],
      ["retired", "retained"],
    ] as const) {
      const approval = covering(status);
      if (approval) {
        return {
          admitted: true,
          approval: approval.id,
          policyGeneration: generation,
          scope,
        };
      }
    }
  }
  let reason: Exclude<AdmissionRefusal, "retired"> = "not_approved";
  if (policyChanged) {
    reason = "policy_changed";
  } else if (covering("revoked")) {
    reason = "revoked";
  }
  return {
    admitted: false,
    reason,
    waiting: candidates.find((row) => row.status === "pending")?.id,
    requested: candidates.length > 0,
    generation,
  };
};

/** What `admitDependencies` admitted, to record with what used it. */
export interface Admitted {
  approval: string;
  policyGeneration: number;
  scope: AdmissionScope;
}

/**
 * Whether exactly this graph may be used: for this App, for every one of
 * these targets, under the policy generation the caller read. The one
 * check for anything that would build with, run or publish an App's
 * packages; it answers with the approval it relied on, to record with
 * what was built. One read of the database answers it, so a decision or a
 * policy change lands wholly before or after.
 *
 * `use` says what for. `new` (the default): anything not built with the
 * graph before, a new build or a new pin, which only an approval in force
 * admits. `retained`: reusing what was built with it before, which a
 * retired approval admits too (scope `retained`); the caller must then
 * use nothing but that.
 *
 * Which revision of the source the graph comes from is not asked: an
 * approved graph holds for every revision that resolves to it, and a
 * source that asks for anything else resolves to another hash.
 *
 * Refused with `dependency.policy_changed` when the generation moved on
 * since the caller read it (read the status again); `dependency.revoked`
 * for a graph revoked for the App; `dependency.retired` for a new use of
 * one retired; and `dependency.approval_required` for anything else not
 * approved as asked: its details name the request waiting for that
 * graph, if one is. A refusal is audited as `actor`'s the first time it
 * is made for this App, graph, set of targets, policy generation in force
 * and reason, and only for a graph some request of the App's names: the
 * same refusal again records nothing more, and one of a hash nobody
 * proposed is logged instead, so a caller can't fill the audit trail by
 * asking. Each part of that key is one core decides or a handful of
 * values (never the generation the caller says it read), so the rows it
 * keeps are bounded too. An admission that succeeds records nothing here:
 * what uses it records the approval it relied on.
 */
export const admitDependencies = async (
  env: Env,
  actor: AuditActor,
  input: DependencyAdmission,
  use: "new" | "retained" = "new"
): Promise<Admitted> => {
  const asked = admissionSchema.parse(input);
  const db = drizzle(env.DB);
  const decided = await admissionOf(db, input);
  if (
    decided.admitted &&
    (decided.scope === "approved" || use === "retained")
  ) {
    return {
      approval: decided.approval,
      policyGeneration: decided.policyGeneration,
      scope: decided.scope,
    };
  }
  const refusal: {
    reason: AdmissionRefusal;
    waiting: string | undefined;
    requested: boolean;
    generation: number;
  } = decided.admitted
    ? {
        reason: "retired",
        waiting: undefined,
        requested: true,
        generation: decided.policyGeneration,
      }
    : decided;
  const { reason, waiting, requested, generation } = refusal;
  const targets = [...new Set(asked.targets)].toSorted().join(" ");
  if (requested) {
    await auditedBatch(env, db, [
      db
        .insert(dependencyAdmissionRefusals)
        .values({
          subjectType: asked.subject.type,
          subjectId: asked.subject.id,
          graphHash: asked.graphHash,
          targets,
          policyGeneration: generation,
          reason,
          createdAt: new Date(),
        })
        .onConflictDoNothing(),
      outboxedIfChanged(db, {
        actor,
        action: "dependency.admission_refused",
        target: auditTargetOf(asked.subject),
        detail: {
          [asked.subject.type]: asked.subject.id,
          graphHash: asked.graphHash,
          targets,
          policyGeneration: asked.policyGeneration,
          reason,
          ...(waiting === undefined ? {} : { request: waiting }),
        },
      }),
    ]);
  } else {
    log.warn("dependencies.admission_refused", {
      [asked.subject.type]: asked.subject.id,
      graphHash: asked.graphHash,
      targets,
      reason,
    });
  }
  if (reason === "not_approved") {
    throw dependencyErrors.create(
      "dependency.approval_required",
      waiting === undefined ? undefined : { request: waiting }
    );
  }
  throw dependencyErrors.create(`dependency.${reason}`);
};

/** What ending an approval leaves it, and the approvals it ends. */
const endings = {
  retired: ["approved"],
  revoked: ["approved", "retired"],
} as const satisfies Record<"retired" | "revoked", readonly Row["status"][]>;

type Ending = keyof typeof endings;

/** That a row of `subject`'s graph `graphHash` is one `ending` ends, as SQL. */
const endable = (
  subject: DependencySubject,
  graphHash: string,
  ending: Ending
): SQL =>
  and(
    ofSubject(dependencyRequests, subject),
    eq(dependencyRequests.graphHash, graphHash),
    inArray(dependencyRequests.status, [...endings[ending]])
  ) ?? sql`0`;

/**
 * Every approval of `subject`'s graph `graphHash` that `ending` would
 * end: its ID and status only, however many there are.
 */
const endableIds = async (
  db: DrizzleD1Database,
  subject: DependencySubject,
  graphHash: string,
  ending: Ending
): Promise<{ id: string; status: Row["status"] }[]> =>
  await db
    .select({ id: dependencyRequests.id, status: dependencyRequests.status })
    .from(dependencyRequests)
    .where(endable(subject, graphHash, ending));

/**
 * The approvals in force (approved or retired) of the App or workflow
 * `input` names, the newest decision first, at most
 * {@link dependencyApprovalsListed}: for one of its builders, or someone
 * who holds `dependencies.approve` now, who may end them. `app.not_found`
 * or `workflow.resource_unavailable` for anyone else, as for one that
 * isn't there. Never their graphs: a list selects what it shows.
 */
export const dependencyApprovals = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<DependencyApprovals> => {
  const db = drizzle(env.DB);
  const decides = await holdsApprove(env, by);
  const asked = subjectOfInput(input);
  // Who may approve packages reads any App's or workflow's, with its name,
  // and nothing else of it: not its versions, screens, data or members.
  const names = decides ? await subjectNames(db, [asked]) : undefined;
  const knownName = names?.get(subjectKey(asked));
  const subject: NamedDependencySubject =
    knownName === undefined
      ? await builtSubject(env, by, asked)
      : { ...asked, name: knownName };
  const [generation, rows] = await Promise.all([
    policyGeneration(db),
    db
      .select(listed)
      .from(dependencyRequests)
      .where(
        and(
          ofSubject(dependencyRequests, subject),
          inArray(dependencyRequests.status, ["approved", "retired"])
        )
      )
      .orderBy(desc(dependencyRequests.decidedAt), dependencyRequests.id)
      .limit(dependencyApprovalsListed),
  ]);
  return {
    policyGeneration: generation,
    decides,
    subject,
    approvals: await toRequests(env, rows),
  };
};

/**
 * Every App and workflow holding approvals in force (approved or
 * retired), each by its name now, how many it holds and when the newest
 * was decided, newest first, at most {@link dependencySubjectsListed}: for
 * someone who holds `dependencies.approve` now, who may end them; nothing
 * for anyone else. Where an approver finds a workflow's approvals, which
 * have no page of their workflow's to be on.
 */
export const dependencySubjectsInForce = async (
  env: Env,
  by: Identity
): Promise<DependencySubjectsInForce> => {
  if (!(await holdsApprove(env, by))) {
    return { decides: false, subjects: [] };
  }
  const db = drizzle(env.DB);
  const decidedAt = sql<number>`MAX(${dependencyRequests.decidedAt})`;
  const rows = await db
    .select({
      subjectType: dependencyRequests.subjectType,
      subjectId: dependencyRequests.subjectId,
      approvals: count(),
      decidedAt,
    })
    .from(dependencyRequests)
    .where(inArray(dependencyRequests.status, ["approved", "retired"]))
    .groupBy(dependencyRequests.subjectType, dependencyRequests.subjectId)
    .orderBy(desc(decidedAt), dependencyRequests.subjectId)
    .limit(dependencySubjectsListed);
  const names = await subjectNames(db, rows.map(subjectOfRow));
  return {
    decides: true,
    subjects: rows.map((row) => {
      const subject = subjectOfRow(row);
      return {
        subject: { ...subject, name: names.get(subjectKey(subject)) ?? "" },
        approvals: row.approvals,
        decidedAt: new Date(row.decidedAt).toISOString(),
      };
    }),
  };
};

/** Only a person on their own session who holds `dependencies.approve` now. */
const requireDecider = async (env: Env, by: Identity): Promise<void> => {
  const { actor, via }: Acting = by;
  if (by.staff || actor !== undefined || via !== undefined) {
    throw dependencyErrors.create("dependency.forbidden");
  }
  if (!(await holdsApprove(env, by))) {
    throw dependencyErrors.create("dependency.forbidden");
  }
};

/** The approval `input` names, while it is in force (approved or retired). */
const approvalRow = async (
  db: DrizzleD1Database,
  input: unknown
): Promise<Listed> => {
  const id = identifierSchema.safeParse(input);
  const row = id.success
    ? await db
        .select(listed)
        .from(dependencyRequests)
        .where(
          and(
            eq(dependencyRequests.id, id.data),
            inArray(dependencyRequests.status, ["approved", "retired"])
          )
        )
        .get()
    : undefined;
  if (!row) {
    throw notFound();
  }
  return row;
};

/** The artifacts `subject`'s lock of `graphHash` pins, newest first. */
const pinnedArtifacts = async (
  db: DrizzleD1Database,
  subject: DependencySubject,
  graphHash: string
): Promise<DependencyImpactArtifact[]> => {
  const row = await db
    .select({ lock: dependencyLocks.lock })
    .from(dependencyLocks)
    .where(
      and(
        ofSubject(dependencyLocks, subject),
        eq(dependencyLocks.graphHash, graphHash)
      )
    )
    .get();
  if (!row) {
    return [];
  }
  const lock = graspLockSchema.parse(JSON.parse(row.lock));
  return Object.entries(lock.artifacts ?? {})
    .flatMap(([compiler, pins]) =>
      Object.values(pins).map(({ target, hash, pinnedAt }) => ({
        target,
        compiler,
        hash,
        pinnedAt,
      }))
    )
    .toSorted((a, b) => b.pinnedAt.localeCompare(a.pinnedAt));
};

/**
 * What retiring or revoking the graph of approval `input` would touch,
 * for someone who holds `dependencies.approve` now: its approvals in
 * force, and the artifacts its lock pins. `dependency.not_found` for
 * anyone else, as for an approval that isn't there or no longer in force.
 */
export const dependencyImpact = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<DependencyImpact> => {
  if (!(await holdsApprove(env, by))) {
    throw notFound();
  }
  const db = drizzle(env.DB);
  const row = await approvalRow(db, input);
  const subject = subjectOfRow(row);
  const [generation, inForce, listedRows, artifacts] = await Promise.all([
    policyGeneration(db),
    endableIds(db, subject, row.graphHash, "revoked"),
    db
      .select(listed)
      .from(dependencyRequests)
      .where(endable(subject, row.graphHash, "revoked"))
      .orderBy(desc(dependencyRequests.decidedAt), dependencyRequests.id)
      .limit(dependencyImpactListed),
    pinnedArtifacts(db, subject, row.graphHash),
  ]);
  const approved = inForce
    .filter(({ status }) => status === "approved")
    .map(({ id }) => id);
  const all = inForce.map(({ id }) => id);
  const requests = await toRequests(env, listedRows);
  return {
    policyGeneration: generation,
    subject: requests[0]?.subject ?? { ...subject, name: "" },
    graphHash: row.graphHash,
    approvals: requests,
    endings: {
      retire: {
        approvals: approved.length,
        digest: await dependencyApprovalsDigest(approved),
      },
      revoke: {
        approvals: all.length,
        digest: await dependencyApprovalsDigest(all),
      },
    },
    artifacts,
  };
};

/**
 * The statements, for a batch that revokes `named`'s graph and stores
 * event `revocation`, that deny the request waiting for that same subject
 * and graph, if one does, as `by`'s decision under `generation`: its audit
 * event first (`dependency.denied`, naming the revocation), written from
 * the very row the update then changes, and both only if the revocation
 * landed.
 */
const denyWaiting = (
  db: DrizzleD1Database,
  by: Identity,
  named: Listed,
  revocation: string,
  generation: number,
  reason: string
) => {
  const waits = and(
    ofSubject(dependencyRequests, subjectOfRow(named)),
    eq(dependencyRequests.graphHash, named.graphHash),
    eq(dependencyRequests.status, "pending"),
    storedEvent(revocation)
  );
  const eventId = crypto.randomUUID();
  const now = new Date();
  const event = sql`json_object(
    'id', ${eventId},
    'at', ${now.toISOString()},
    'source', 'core',
    'actor', json(${JSON.stringify(actorOf(by))}),
    'action', 'dependency.denied',
    'target', json_object('type', 'dependency_request', 'id', ${dependencyRequests.id}),
    'provenance', json('[]'),
    'detail', json_object(
      ${dependencyRequests.subjectType}, ${dependencyRequests.subjectId},
      'sourceRevision', ${dependencyRequests.sourceRevision},
      'graphHash', ${dependencyRequests.graphHash},
      'targets', (SELECT group_concat(value, ' ') FROM json_each(${dependencyRequests.targets})),
      'direct', ${dependencyRequests.direct},
      'packages', ${dependencyRequests.packages},
      'requestedBy', ${dependencyRequests.requestedBy},
      'selfDecided', json(CASE WHEN ${dependencyRequests.requestedBy} = ${by.userId} THEN 'true' ELSE 'false' END),
      'policyGeneration', ${generation},
      'reason', ${reason},
      'revocation', ${revocation}
    )
  )`;
  return [
    db
      .insert(auditOutbox)
      .select(
        sql`SELECT ${eventId}, ${event}, ${now.getTime()} FROM ${dependencyRequests} WHERE ${waits}`
      ),
    db
      .update(dependencyRequests)
      .set({
        status: "denied",
        decidedBy: by.userId,
        decidedAt: now,
        decidedGeneration: generation,
        reason,
      })
      .where(waits),
  ] as const;
};

/**
 * Retires or revokes the graph of approval `input` for its App or
 * workflow, for `by`:
 * the approvals of the graph the person reviewed, in one batch that
 * lands only while those are exactly the ones `ending` would end now
 * (`endings`), the
 * policy generation is the one reviewed, and `by` holds
 * `dependencies.approve`, all read as it runs. The batch records it once
 * (`dependency.retired` or `dependency.revoked`, naming every approval it
 * ended) and moves the policy generation on, so every admission read
 * before is refused from then on. Revoking also denies the request
 * waiting for the same graph, if one does, and the graph's lock goes, its
 * files queued for cleanup (packages/locks.ts). A retired graph keeps its lock,
 * and the artifacts it pins keep working.
 *
 * As for a decision: only a person, from their own session, never an
 * agent acting for one nor Grasp staff. Refused with `dependency.stale`
 * when the approvals in force or the policy changed since they were read.
 */
export const endDependency = async (
  env: Env,
  by: Identity,
  input: unknown,
  ending: Ending,
  decision: unknown
): Promise<DependencyRequest[]> => {
  await requireDecider(env, by);
  const { reviewed, reason } = dependencyErrors.parse(
    "dependency.invalid",
    dependencyEndingSchema,
    decision
  );
  const db = drizzle(env.DB);
  const named = await approvalRow(db, input);
  if (named.graphHash !== reviewed.graphHash) {
    throw dependencyErrors.create("dependency.stale");
  }
  // What the person reviewed, not merely what this call reads: the
  // approvals in force now must be the very set the impact showed them
  // (by digest, however many), and the batch then lands only while they
  // still are.
  const subject = subjectOfRow(named);
  const inForceNow = await endableIds(db, subject, named.graphHash, ending);
  const ids = inForceNow.map(({ id }) => id);
  if (
    !ids.includes(named.id) ||
    (await dependencyApprovalsDigest(ids)) !== reviewed.approvalsDigest
  ) {
    throw dependencyErrors.create("dependency.stale");
  }
  const generation = reviewed.policyGeneration + 1;
  const event = createAuditEvent(
    {
      actor: actorOf(by),
      action: `dependency.${ending}`,
      target: { type: "dependency_request", id: named.id },
      detail: {
        [subject.type]: subject.id,
        graphHash: named.graphHash,
        // How many, and which by digest: the rows themselves record that
        // they ended, with this generation (`ended_generation`).
        approvals: ids.length,
        approvalsDigest: reviewed.approvalsDigest,
        reason,
        policyGeneration: generation,
      },
    },
    "core"
  );
  // The approvals in force as the batch runs are exactly the ones
  // reviewed: as many, and each of them, whatever order rows come in.
  const inForce = endable(subject, named.graphHash, ending);
  // The IDs as one JSON parameter, however many there are.
  const reviewedIds = sql`(SELECT value FROM json_each(${JSON.stringify(ids)}))`;
  const lands = sql`(SELECT COUNT(*) FROM ${dependencyRequests} WHERE ${inForce}) = ${ids.length} AND (SELECT COUNT(*) FROM ${dependencyRequests} WHERE ${inForce} AND ${dependencyRequests.id} IN ${reviewedIds}) = ${ids.length} AND ${policyGenerationSql} = ${reviewed.policyGeneration} AND ${holdsApproveSql(by.userId)}`;
  const status: Row["status"] = ending;
  const [, ended] = await auditedBatch(env, db, [
    outboxedEventWhere(db, event, lands),
    db
      .update(dependencyRequests)
      .set({
        status,
        endedBy: by.userId,
        endedAt: new Date(),
        endedGeneration: generation,
        endedReason: reason,
      })
      .where(
        and(
          sql`${dependencyRequests.id} IN ${reviewedIds}`,
          storedEvent(event.id)
        )
      )
      .returning(listed),
    advancePolicy(db, storedEvent(event.id)),
    // A request waiting for the revoked graph is denied with it: approving
    // it later would bring back the lock, and what it pinned, unbuilt.
    ...(ending === "revoked"
      ? denyWaiting(db, by, named, event.id, generation, reason)
      : []),
    // A revoked graph's lock goes, now that nothing waiting names it; a
    // retired one is in use (packages/locks.ts).
    ...unusedLockStatements(db, subject),
  ]);
  if (ended.length !== ids.length) {
    // Who holds the permission can have changed since it was checked.
    throw dependencyErrors.create(
      (await holdsApprove(env, by))
        ? "dependency.stale"
        : "dependency.forbidden"
    );
  }
  // Landed: the answer is what the batch returned, and reading names
  // can't turn it into a failure.
  return await toRequests(
    env,
    ended.toSorted((a, b) => a.id.localeCompare(b.id)),
    "if they can be read"
  );
};
