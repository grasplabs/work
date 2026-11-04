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
  subjectOfRef,
  dependencySummaryDirect,
  dependencySummaryFindings,
  findingGravity,
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
  DependencyPackageRef,
  DependencySubject,
  DependencyTarget,
} from "@grasp-os/shared/dependencies";
import {
  appIdSchema,
  identifierSchema,
  workflowResourceIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  graspLockSchema,
  packageErrors,
  packageLimitsOf,
} from "@grasp-os/shared/packages";
import type { GraspLock, PackageLimits } from "@grasp-os/shared/packages";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import {
  auditedBatch,
  keepAuditEvent,
  outboxed,
  outboxedEventWhere,
  outboxedIfChanged,
  storedEvent,
} from "../audit-outbox.ts";
import { teamsOf } from "../auth/identity.ts";
import type { Acting } from "../auth/identity.ts";
import {
  auditOutbox,
  dependencyAdmissionRefusals,
  dependencyLocks,
  dependencyPolicy,
  dependencyRequestAskers,
  dependencyRequests,
  users,
  workflowResources,
} from "../db/core/schema.ts";
import { isUniqueViolation } from "../db/d1.ts";
import { workspace } from "../durable-objects.ts";
import { packageNoticed } from "../notifications.ts";
import {
  failUnless,
  lockGuardFailed,
  lockStatements,
  unusedLockStatements,
} from "../packages/locks.ts";
import { knownMalwareIn, scanPackages } from "../packages/malware.ts";
import type { AffectingAdvisory, PackageScan } from "../packages/malware.ts";
import { concernedWith } from "./concerned.ts";
import { peerIssues } from "./peers.ts";
import { dropPending } from "./pending.ts";
import {
  advancePolicy,
  policyGeneration,
  policyGenerationSql,
} from "./policy.ts";
import {
  archivedSql,
  buildsSubjectSql,
  builtSubject,
} from "./subject-builders.ts";
import {
  auditTargetOf,
  ofSubject,
  subjectKey,
  subjectNames,
  subjectOfInput,
  subjectOfRow,
} from "./subjects.ts";

// npm packages proposed for an App or a workflow (its subject,
// subjects.ts), a builder's decision on them, and the one check that says
// whether a graph may be used. Everything below holds per subject: what
// it says of an App holds of a workflow too, whose packages are only
// ever for its compute modules (`computation`), and an approval is its
// subject's alone. Nothing here fetches, unpacks or runs a package: a
// graph is data handed in, and an approval is a row.
//
// Who decides (Nick, 2026-11-04): the builder of the App or workflow, in
// the chat whose agent asked (chat/package-requests on the page), with
// one click, on their own session. No admin grants anyone the right to;
// security comes from what is enforced and recorded around the decision.
// What could go wrong, and what stops it:
//
// - The agent approving for itself. It resolves (agent-builds.ts,
//   packages/resolve.ts), which proposes, and nothing more: its env has
//   no way to decide, and deciding takes the identity of a person's own
//   `/rpc` session (`requireOwnSession`), never one acting for them
//   (`actor`, `via`). A request allows nothing until a person decides it.
// - Someone who doesn't build the subject approving: a member it isn't
//   shared with, someone it is shared with as a user, a builder of
//   another App, Grasp staff. Deciding asks the subject's own role check
//   (`builtSubject`), as every builder's change does, and refuses anyone
//   else; each refusal is audited (`dependency.decision_refused`). The
//   write that takes the decision lands only while the person is still an
//   active member. A builder of App A deciding a request of App B is
//   refused for B, whatever they hold in A: the subject is the request's,
//   never one the caller names.
// - An approval replayed: for another graph, App or request. A decision
//   names one request by ID and the graph hash and policy generation the
//   person reviewed; the one update that takes it lands only while that
//   request is still pending, for that graph, under that generation. A
//   request never changes: a proposal for other packages or targets takes
//   the pending one's place, so a decision on the old one finds nothing.
//   What is approved is the graph, for its subject and targets alone
//   (`admitDependencies`), by a hash core computes itself from the
//   packages, never takes from the request.
// - Known malware approved anyway. A resolve refuses it before proposing
//   (`refuseMalware`), an approval asks both sources again and refuses it
//   (`refuseKnownMalware`), failing closed when either can't be read, a
//   build asks again (`refuseMalwareBefore`), and the regular re-scan
//   revokes an approval a later report covers (`rescanPackages`).
//   Whoever approves, no decision admits it.
// - Packages used before anyone approved them. `admitDependencies` is the
//   only way a graph counts as approved, and it answers yes for exactly
//   what a person approved: this subject, this graph and these targets.
//   A refusal is audited once per subject, graph, targets, policy
//   generation and reason, for a graph some request names; any other
//   hash a caller makes up is refused and logged, so asking again and
//   again can't flood the audit trail.
// - A graph whose packages are whatever its proposer says. Nobody hands
//   in a graph: the resolver is the only proposer (packages/resolve.ts),
//   and every version, integrity hash, licence and edge in a request is
//   what it read from the registry through connect, with every tarball's
//   bytes checked against its integrity and unpacked in quarantine.
// - Two decisions. The first lands; the second finds nothing pending.
// - One huge request, or many. The size is measured on what core stores,
//   never taken from a count in the request, and the lists are capped. One
//   request waits per subject, and one that is replaced is deleted, so
//   asking again and again stores nothing more. No list reads a request's
//   whole graph: lists select the columns they show.
// - Package text steering anyone. A licence or a finding's summary is
//   bounded text shown as text; nothing reads it as instructions.
// - An approval taken for more than it is. It says these exact packages
//   may be used by this subject on these targets. It grants no connector,
//   collection, file or model access, and every use still runs under the
//   subject's own permissions.
// - Nobody knowing what was approved, built or found. Every request,
//   decision, refusal, build (`dependency.built`, packages/build.ts),
//   ending and re-scan finding is in the audit log.
//
// - An approval that should end, and doesn't. A builder retires or
//   revokes a graph (spec 19.3.1), every approval of it at once, so no
//   approval of the same graph for other targets keeps it in use. Retired
//   is a lifecycle decision: nothing new is admitted (`admitDependencies`
//   with `new`, the default), and only what was built before is
//   (`retained`: the artifacts the lock pinned, which no pin adds to once
//   the graph is retired, packages/build.ts). Revoked is a security
//   decision: nothing at all is admitted. Neither row is ever approved
//   again: approving the graph again is a new request, and both stay as
//   history.
// - Ending an approval on what the person didn't see. The one batch that
//   ends it lands only while the approvals still in force are exactly the
//   ones they read and the policy generation is the one they read; it
//   moves the generation on with its audit event, so a build that read
//   the generation before is refused, and its pin (whose write checks
//   both) either landed before, and is what a retired graph keeps, or
//   never lands.
//
// Not stopped here: a licence is what the package states of itself, and
// findings (lookalike names, the registry's advisories, GRA-699) warn the
// approver, never refuse, but for known malware: a graph without findings
// isn't shown to be safe. An advisory published after the approval is
// found by the re-scan and told to the builders, who decide.
// What a person approves is the graph by its hash, so what is later
// fetched must match it byte for byte to be admitted.

/**
 * A request's row, without `malware_checked_at`, which nothing reads or
 * writes any more (`scanned_at` replaced it; a later release drops it).
 */
type Row = Omit<typeof dependencyRequests.$inferSelect, "malwareCheckedAt">;

/**
 * A request as lists read it: every column but its whole review
 * (`snapshot`, up to {@link dependencyMaxBytes} each).
 */
const {
  snapshot: _snapshot,
  malwareCheckedAt: _malwareCheckedAt,
  ...listed
} = getTableColumns(dependencyRequests);
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
  | "approval_refused"
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

/**
 * The statement that records `by` as asking for request `request`, from
 * the chat whose agent acted for them, if one did
 * (`dependency_request_askers`): once each, and only while it waits, so a
 * request replaced meanwhile gets no asker.
 */
const askedBy = (db: DrizzleD1Database, request: string, by: Acting) =>
  db
    .insert(dependencyRequestAskers)
    // The table's columns, in its order.
    .select(
      sql`SELECT ${request}, ${by.userId}, ${by.via?.chatId ?? ""}, ${by.via?.workspaceId ?? null}, ${Date.now()}
        WHERE EXISTS (SELECT 1 FROM ${dependencyRequests} WHERE ${dependencyRequests.id} = ${request} AND ${dependencyRequests.status} = 'pending')`
    )
    .onConflictDoNothing();

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
      .toSorted(
        (a, b) => findingGravity[b.severity] - findingGravity[a.severity]
      )
      .slice(0, dependencySummaryFindings),
  },
  direct: graph.direct.length,
  packages: graph.packages.length,
  findings: proposal.findingsTotal,
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
  scannedAt: null,
  advisoriesNoticed: null,
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
    // It waits on whoever asked for it again too, from wherever they did.
    return {
      request: waiting,
      lock,
      statements: [...live, ...lockFirst, askedBy(db, waiting.id, by)],
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
      askedBy(db, row.id, by),
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
  const subject = await builtSubject(env, by, subjectOfRef(proposal), true);
  const graph = canonicalGraph(proposal.graph);
  // The total too: a resolve finding more or fewer below the kept ones
  // is another review, never taken for the one waiting.
  const snapshot = canonicalJson({
    graph,
    findings: proposal.findings,
    findingsTotal: proposal.findingsTotal,
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
      await builtSubject(env, by, subject, true);
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

/** A package version a malware advisory affects, and the advisory. */
export interface MalwareFound {
  package: DependencyPackageRef;
  advisory: string;
}

/** Most malware findings one refusal audits, each as its own event. */
const malwareAuditedMax = 25;

/**
 * Refuses a resolve of `subject`'s graph because packages in it are known
 * malware (`found`, GRA-699: Nick decided on 2026-10-19 that confirmed
 * malware is refused, every other finding only warns). Audited, one event
 * for each package and advisory (an audit value is identifier-sized), the
 * first `malwareAuditedMax`, each saying how many were found; stored as no
 * request: nobody can approve what was never proposed.
 */
export const refuseMalware = async (
  env: Env,
  by: Acting,
  subject: DependencySubject,
  found: readonly [MalwareFound, ...MalwareFound[]],
  /**
   * Where it was refused, when not at a resolve: an approval's request,
   * or a build of the approved graph (`refuseMalwareBefore`).
   */
  at?: { request: string; at: "approval" } | { graphHash: string; at: "build" }
): Promise<never> => {
  const db = drizzle(env.DB);
  const actor = by.actor ?? actorOf(by);
  const [first, ...rest] = found.slice(0, malwareAuditedMax).map((malware) =>
    outboxed(db, {
      actor,
      action: "dependency.malware_refused",
      target: auditTargetOf(subject),
      detail: {
        [subject.type]: subject.id,
        package: malware.package.name,
        version: malware.package.version,
        advisory: malware.advisory,
        found: found.length,
        ...at,
      },
    })
  );
  if (first !== undefined) {
    await auditedBatch(env, db, [first, ...rest]);
  }
  throw dependencyErrors.create("dependency.malware", {
    packages: found.map(
      (malware) => `${packageKey(malware.package)} (${malware.advisory})`
    ),
  });
};

/**
 * Refuses a build of `subject`'s approved graph `graphHash` that would
 * make a new artifact of packages reported as malware since the graph was
 * approved (GRA-924), by either source (`knownMalwareIn`), as a resolve
 * is refused (`refuseMalware`, at `build`). Fails closed when either
 * can't be read (`package.malware_unchecked`), building nothing.
 */
export const refuseMalwareBefore = async (
  env: Env,
  by: Acting,
  subject: DependencySubject,
  graphHash: string,
  packages: readonly DependencyPackageRef[]
): Promise<void> => {
  const [first, ...rest] = await knownMalwareIn(env, packages);
  if (first !== undefined) {
    await refuseMalware(env, by, subject, [first, ...rest], {
      graphHash,
      at: "build",
    });
  }
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
 * Refuses anyone but a person on their own session: never an agent acting
 * for one (`actor`, `via`), nor Grasp staff, who neither ask for nor
 * decide what a client's Apps and workflows may use.
 */
const requireOwnSession = (by: Acting): void => {
  const { actor, via } = by;
  if (by.staff || actor !== undefined || via !== undefined) {
    throw dependencyErrors.create("dependency.forbidden");
  }
};

/**
 * Refuses `by` unless they build `subject` now, as its own role check
 * says (`builtSubject`), with the teams they are in now rather than those
 * their session last read, so leaving a team it is shared with stops
 * them at once: someone with no role in it with `dependency.not_found`,
 * as for a request that isn't there, and anyone else who doesn't build it
 * with `dependency.forbidden`. With `change`, an archived App refuses too
 * (`app.archived`).
 */
const requireBuilderOf = async (
  env: Env,
  by: Acting,
  subject: DependencySubject,
  change = false
): Promise<void> => {
  const now: Acting = { ...by, teams: await teamsOf(env.DB, by.userId) };
  try {
    await builtSubject(env, now, subject, change);
  } catch (error) {
    if (
      appErrors.codeOf(error) === "app.not_found" ||
      workflowResourceErrors.codeOf(error) === "workflow.resource_unavailable"
    ) {
      throw notFound();
    }
    if (roleErrors.codeOf(error) === "role.forbidden") {
      throw dependencyErrors.create("dependency.forbidden");
    }
    throw error;
  }
};

/** Whether `by` builds `subject` now (`requireBuilderOf`). */
const builds = async (
  env: Env,
  by: Acting,
  subject: DependencySubject
): Promise<boolean> => {
  try {
    await requireBuilderOf(env, by, subject);
    return true;
  } catch (error) {
    const code = dependencyErrors.codeOf(error);
    if (code === "dependency.not_found" || code === "dependency.forbidden") {
      return false;
    }
    throw error;
  }
};

/**
 * The requests waiting on `by`, oldest first: those they asked for, or
 * their chat's agent did for them (in chat `chatId` alone, when given),
 * of Apps and workflows they still build. Nobody else's: a builder
 * decides what was asked of them, in the chat that asked.
 */
export const waitingDependencies = async (
  env: Env,
  by: Identity,
  chatId?: string
): Promise<DependenciesWaiting> => {
  const db = drizzle(env.DB);
  const [generation, rows] = await Promise.all([
    policyGeneration(db),
    by.staff
      ? []
      : db
          .select(listed)
          .from(dependencyRequests)
          .where(
            and(
              eq(dependencyRequests.status, "pending"),
              sql`EXISTS (SELECT 1 FROM ${dependencyRequestAskers}
                WHERE ${dependencyRequestAskers.requestId} = ${dependencyRequests.id}
                  AND ${dependencyRequestAskers.personId} = ${by.userId}
                  ${chatId === undefined ? sql`` : sql`AND ${dependencyRequestAskers.chatId} = ${chatId}`})`
            )
          )
          .orderBy(dependencyRequests.requestedAt, dependencyRequests.id),
  ]);
  // One waits per subject, so a handful: each asked of its own role check.
  const theirs = await Promise.all(
    rows.map(async (row) => await builds(env, by, subjectOfRow(row)))
  );
  return {
    policyGeneration: generation,
    requests: await toRequests(
      env,
      rows.filter((_, index) => theirs[index] === true)
    ),
  };
};

const findRow = async (env: Env, input: unknown): Promise<Row> => {
  const id = identifierSchema.safeParse(input);
  const row = id.success
    ? await drizzle(env.DB)
        .select({ ...listed, snapshot: dependencyRequests.snapshot })
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
 * One request in full, for the builders of its App or workflow;
 * `dependency.not_found` for anyone else, as for one that isn't there.
 */
export const dependencyReview = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<DependencyReview> => {
  const row = await findRow(env, input);
  try {
    await requireBuilderOf(env, by, subjectOfRow(row));
  } catch (error) {
    // Not theirs to read: as if it weren't there. Anything else failed.
    if (dependencyErrors.codeOf(error) === "dependency.forbidden") {
      throw notFound();
    }
    throw error;
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
 * Most advisory IDs an approval keeps of what affected its graph
 * (`advisories_noticed`, `PackageLimits.advisoriesNoticed`): bounded
 * whatever a source answers.
 */
const advisoriesNoticedMax = (env: Env): number =>
  packageLimitsOf(env.PACKAGE_LIMITS).advisoriesNoticed;

/** The IDs of `affecting`, each once, sorted, at most `max`. */
const advisoryIdsOf = (
  affecting: readonly AffectingAdvisory[],
  max: number
): string[] =>
  [...new Set(affecting.map(({ advisory }) => advisory.id))]
    .toSorted()
    .slice(0, max);

/**
 * Refuses approving `found`'s graph when a package of it is now known as
 * malware (GRA-913), by the registry's advisories (CWE-506) or OSV.dev's
 * reports, asked again as at a resolve (`findingsOf`, packages/resolve.ts):
 * one reported after the graph was proposed is refused all the same,
 * audited as at a resolve (`refuseMalware`), saying the request and that
 * it was its approval; the request stays pending, for a builder to deny.
 * Fails closed when either source can't be read, or the check fails any
 * other way, audited as an approval refused (`dependency.approval_refused`,
 * with connect's error code, or `internal.unexpected`). Asked only
 * to approve: saying no never waits on either. Answers with the IDs of
 * every advisory that affects the graph now, malware or not, at most
 * `advisoriesNoticedMax`: what its approver approved it with, which
 * the re-scan never tells as new (`rescanPackages`).
 */
const refuseKnownMalware = async (
  env: Env,
  by: Identity,
  found: Listed
): Promise<string[]> => {
  const db = drizzle(env.DB);
  const row = await db
    .select({ snapshot: dependencyRequests.snapshot })
    .from(dependencyRequests)
    .where(eq(dependencyRequests.id, found.id))
    .get();
  if (!row) {
    throw notFound();
  }
  const { graph } = snapshotSchema.parse(JSON.parse(row.snapshot));
  let scan: PackageScan;
  try {
    scan = await scanPackages(
      env,
      graph.packages.map(({ name, version }) => ({ name, version }))
    );
  } catch (error) {
    // Every failure of the check refuses the approval, and is audited so:
    // connect's own refusal by its code, anything else (connect out of
    // reach, a call that broke) as unexpected.
    await auditedBatch(env, db, [
      outboxed(
        db,
        requestEntry(actorOf(by), "approval_refused", found, {
          errorCode: packageErrors.codeOf(error) ?? "internal.unexpected",
        })
      ),
    ]);
    throw error;
  }
  const [first, ...rest] = scan.malware;
  if (first !== undefined) {
    await refuseMalware(env, by, subjectOfRow(found), [first, ...rest], {
      request: found.id,
      at: "approval",
    });
  }
  return advisoryIdsOf(scan.affecting, advisoriesNoticedMax(env));
};

/**
 * Runs `act`, a decision on request `found` (an approval, a denial, or
 * an ending), auditing a refusal of who decided
 * (`dependency.decision_refused`: someone who doesn't build its subject,
 * or not on their own session) with why. Only for a request that is
 * there: one of an ID nobody has is logged, never audited, so made-up IDs
 * can't fill the audit trail.
 */
const refusalsAudited = async <T>(
  env: Env,
  by: Acting,
  found: Pick<Listed, "id"> | undefined,
  detail: Record<string, string>,
  act: () => Promise<T>
): Promise<T> => {
  try {
    return await act();
  } catch (error) {
    const code = dependencyErrors.codeOf(error);
    if (code === "dependency.forbidden" || code === "dependency.not_found") {
      if (found === undefined) {
        log.warn("dependencies.decision_refused", { reason: code });
      } else {
        await keepAuditEvent(env, drizzle(env.DB), {
          actor: by.actor ?? actorOf(by),
          action: "dependency.decision_refused",
          target: { type: "dependency_request", id: found.id },
          detail: { reason: code, ...detail },
        });
      }
    }
    throw error;
  }
};

/**
 * Tells each chat whose agent asked for `request` how it was decided
 * (`Workspace.packagesDecided`), as a chat's connection is (permissions.ts
 * `tellChat`): the agent learns it on its next turn, and the chat's page
 * reads what waits again. Nothing for a person's own ask. The decision
 * stands however this goes.
 */
const tellChats = async (
  env: Env,
  request: Listed,
  decision: "approved" | "denied"
): Promise<void> => {
  const askers = await drizzle(env.DB)
    .select({
      personId: dependencyRequestAskers.personId,
      chatId: dependencyRequestAskers.chatId,
      workspaceId: dependencyRequestAskers.workspaceId,
    })
    .from(dependencyRequestAskers)
    .where(eq(dependencyRequestAskers.requestId, request.id));
  // Each chat once, however many times it asked.
  const chats = new Map(
    askers.flatMap((asker) =>
      asker.chatId === "" || asker.workspaceId === null
        ? []
        : [[`${asker.workspaceId}/${asker.chatId}`, asker] as const]
    )
  );
  await Promise.all(
    [...chats.values()].map(async ({ personId, chatId, workspaceId }) => {
      try {
        await workspace(
          env,
          workspaceIdSchema.parse(workspaceId)
        ).packagesDecided(chatId, personId, { request: request.id, decision });
      } catch (error) {
        log.warn("chat.packages_decided_failed", {
          chatId,
          ...errorFields(error),
        });
      }
    })
  );
};

/**
 * What a write of `by`'s on `subject` needs of them and the subject, read
 * in the write's own batch, before it, so it sees exactly what the write
 * saw: whether they build it, and whether it is archived. One row,
 * whatever became of the request.
 */
const standingStatement = (
  db: DrizzleD1Database,
  by: Identity,
  subject: DependencySubject
) =>
  db
    .select({
      builds: sql<number>`${buildsSubjectSql(by.userId, subject)}`,
      archived: sql<number>`${archivedSql(subject)}`,
    })
    .from(sql`(SELECT 1) AS one`);

/**
 * Why a write found nothing to change, from what its batch read
 * (`standingStatement`): `by` no longer builds the subject, or was demoted
 * or removed (`dependency.forbidden`); a decision's App was archived
 * (`app.archived`); or what they reviewed changed (`dependency.stale`).
 */
const whyNotWritten = (
  standing: { builds: number; archived: number } | undefined,
  /** A decision, which an archived App refuses too. */
  deciding: boolean
): Error => {
  if (standing === undefined || standing.builds === 0) {
    return dependencyErrors.create("dependency.forbidden");
  }
  if (deciding && standing.archived !== 0) {
    return appErrors.create("app.archived");
  }
  return dependencyErrors.create("dependency.stale");
};

/** Approves or denies a pending request for `by`: see `decideDependency`. */
const decide = async (
  env: Env,
  by: Identity,
  found: Listed,
  decision: unknown
): Promise<DependencyRequest> => {
  const { approved, reviewed, reason } = dependencyErrors.parse(
    "dependency.invalid",
    dependencyDecisionSchema,
    decision
  );
  const subject = subjectOfRow(found);
  // An archived App is read-only: nothing is decided for it.
  await requireBuilderOf(env, by, subject, true);
  let advisories: string[] | null = null;
  if (approved) {
    // A request already decided, or reviewed at another graph, is refused
    // as stale before anything is asked of the registry or OSV.dev.
    if (found.status !== "pending" || found.graphHash !== reviewed.graphHash) {
      throw dependencyErrors.create("dependency.stale");
    }
    advisories = await refuseKnownMalware(env, by, found);
  }
  const status = approved ? "approved" : "denied";
  const db = drizzle(env.DB);
  const [[standing], [decided]] = await auditedBatch(env, db, [
    standingStatement(db, by, subject),
    db
      .update(dependencyRequests)
      .set({
        status,
        decidedBy: by.userId,
        decidedAt: new Date(),
        decidedGeneration: reviewed.policyGeneration,
        reason: reason ?? null,
        advisoriesNoticed: advisories,
      })
      .where(
        and(
          eq(dependencyRequests.id, found.id),
          eq(dependencyRequests.status, "pending"),
          eq(dependencyRequests.graphHash, reviewed.graphHash),
          sql`${policyGenerationSql} = ${reviewed.policyGeneration}`,
          // Read as it lands: the registry and OSV.dev take seconds, and
          // someone unshared meanwhile decides nothing.
          buildsSubjectSql(by.userId, subject),
          sql`NOT ${archivedSql(subject)}`
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
    ...unusedLockStatements(db, subject),
  ]);
  if (!decided) {
    throw whyNotWritten(standing, true);
  }
  await tellChats(env, decided, status);
  return await toRequest(env, decided);
};

/**
 * Approves or denies a pending request for `by`, once: only a builder of
 * its App or workflow (`requireBuilderOf`, the request's subject, never
 * one the caller names), on their own session (`requireOwnSession`): never
 * an agent acting for them, nor Grasp staff. Known malware is refused
 * whoever approves (`refuseKnownMalware`). One conditional update is the
 * decision: it lands only while the request is pending, its graph is the
 * one reviewed, the policy generation is the one reviewed, `by` still
 * builds its subject (`buildsSubjectSql`) and an App is not archived, in
 * the batch that records it.
 * The chat that asked is told (`tellChats`). A refusal of who decides is
 * audited (`dependency.decision_refused`), with why, for a request that
 * is there; one of an ID nobody has is only logged, so asking with made-up
 * IDs can't fill the audit trail.
 */
export const decideDependency = async (
  env: Env,
  by: Identity,
  input: unknown,
  decision: unknown
): Promise<DependencyRequest> => {
  const id = identifierSchema.safeParse(input);
  const found = id.success
    ? await drizzle(env.DB)
        .select(listed)
        .from(dependencyRequests)
        .where(eq(dependencyRequests.id, id.data))
        .get()
    : undefined;
  return await refusalsAudited(env, by, found, {}, async () => {
    requireOwnSession(by);
    if (!found) {
      throw notFound();
    }
    return await decide(env, by, found, decision);
  });
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
 * {@link dependencyApprovalsListed}, for its builders, who may end them
 * on their own session (`decides`). `dependency.not_found` for anyone
 * else, as for one that isn't there. Never their graphs: a list selects
 * what it shows.
 */
export const dependencyApprovals = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<DependencyApprovals> => {
  const db = drizzle(env.DB);
  const asked = subjectOfInput(input);
  await requireBuilderOf(env, by, asked);
  const [generation, rows, names] = await Promise.all([
    policyGeneration(db),
    db
      .select(listed)
      .from(dependencyRequests)
      .where(
        and(
          ofSubject(dependencyRequests, asked),
          inArray(dependencyRequests.status, ["approved", "retired"])
        )
      )
      .orderBy(desc(dependencyRequests.decidedAt), dependencyRequests.id)
      .limit(dependencyApprovalsListed),
    subjectNames(db, [asked]),
  ]);
  return {
    policyGeneration: generation,
    decides: !by.staff,
    subject: { ...asked, name: names.get(subjectKey(asked)) ?? "" },
    approvals: await toRequests(env, rows),
  };
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
 * for a builder of its App or workflow: its approvals in force, and the
 * artifacts its lock pins. `dependency.not_found` for anyone with no role
 * in it, as for an approval that isn't there or no longer in force.
 */
export const dependencyImpact = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<DependencyImpact> => {
  const db = drizzle(env.DB);
  const row = await approvalRow(db, input);
  const subject = subjectOfRow(row);
  await requireBuilderOf(env, by, subject);
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
 * Who denies the request a revocation denies with it: the person who
 * revoked, or core itself for a revocation of reported malware
 * (`rescanPackages`), which no person decided.
 */
interface Denier {
  actor: AuditActor;
  /** The person, if one decided; `null` for core's own revocation. */
  userId: string | null;
}

/**
 * The statements, for a batch that revokes `subject`'s graph `graphHash`
 * and stores event `revocation`, that deny the request waiting for that
 * same subject and graph, if one does, as `by`'s decision under
 * `generation`: its audit event first (`dependency.denied`, naming the
 * revocation), written from the very row the update then changes, and
 * both only if the revocation landed.
 */
const denyWaiting = (
  db: DrizzleD1Database,
  by: Denier,
  { subject, graphHash }: { subject: DependencySubject; graphHash: string },
  revocation: string,
  generation: number,
  reason: string
) => {
  const waits = and(
    ofSubject(dependencyRequests, subject),
    eq(dependencyRequests.graphHash, graphHash),
    eq(dependencyRequests.status, "pending"),
    storedEvent(revocation)
  );
  const eventId = crypto.randomUUID();
  const now = new Date();
  const event = sql`json_object(
    'id', ${eventId},
    'at', ${now.toISOString()},
    'source', 'core',
    'actor', json(${JSON.stringify(by.actor)}),
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

/** Ends approval `named`'s graph for `by`: see `endDependency`. */
const end = async (
  env: Env,
  by: Identity,
  named: Listed,
  ending: Ending,
  decision: unknown
): Promise<DependencyRequest[]> => {
  const { reviewed, reason } = dependencyErrors.parse(
    "dependency.invalid",
    dependencyEndingSchema,
    decision
  );
  const db = drizzle(env.DB);
  const subject = subjectOfRow(named);
  await requireBuilderOf(env, by, subject);
  if (named.graphHash !== reviewed.graphHash) {
    throw dependencyErrors.create("dependency.stale");
  }
  // What the person reviewed, not merely what this call reads: the
  // approvals in force now must be the very set the impact showed them
  // (by digest, however many), and the batch then lands only while they
  // still are.
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
  const lands = sql`(SELECT COUNT(*) FROM ${dependencyRequests} WHERE ${inForce}) = ${ids.length} AND (SELECT COUNT(*) FROM ${dependencyRequests} WHERE ${inForce} AND ${dependencyRequests.id} IN ${reviewedIds}) = ${ids.length} AND ${policyGenerationSql} = ${reviewed.policyGeneration} AND ${buildsSubjectSql(by.userId, subject)}`;
  const status: Row["status"] = ending;
  const [[standing], , ended] = await auditedBatch(env, db, [
    standingStatement(db, by, subject),
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
      ? denyWaiting(
          db,
          { actor: actorOf(by), userId: by.userId },
          { subject, graphHash: named.graphHash },
          event.id,
          generation,
          reason
        )
      : []),
    // A revoked graph's lock goes, now that nothing waiting names it; a
    // retired one is in use (packages/locks.ts).
    ...unusedLockStatements(db, subject),
  ]);
  if (ended.length !== ids.length) {
    throw whyNotWritten(standing, false);
  }
  // Landed: the answer is what the batch returned, and reading names
  // can't turn it into a failure.
  return await toRequests(
    env,
    ended.toSorted((a, b) => a.id.localeCompare(b.id)),
    "if they can be read"
  );
};

/**
 * Retires or revokes the graph of approval `input` for its App or
 * workflow, for `by`:
 * the approvals of the graph the person reviewed, in one batch that
 * lands only while those are exactly the ones `ending` would end now
 * (`endings`), the
 * policy generation is the one reviewed, and `by` still builds its
 * subject (`buildsSubjectSql`), all read as it runs. The batch records it once
 * (`dependency.retired` or `dependency.revoked`, naming every approval it
 * ended) and moves the policy generation on, so every admission read
 * before is refused from then on. Revoking also denies the request
 * waiting for the same graph, if one does, and the graph's lock goes, its
 * files queued for cleanup (packages/locks.ts). A retired graph keeps its lock,
 * and the artifacts it pins keep working.
 *
 * As for a decision: only a builder of it, from their own session, never
 * an agent acting for one nor Grasp staff, a refusal audited as a
 * decision's is (`refusalsAudited`). Refused with `dependency.stale` when
 * the approvals in force or the policy changed since they were read.
 */
export const endDependency = async (
  env: Env,
  by: Identity,
  input: unknown,
  ending: Ending,
  decision: unknown
): Promise<DependencyRequest[]> => {
  const db = drizzle(env.DB);
  const found = await approvalRow(db, input).catch(
    (error: unknown): Listed | undefined => {
      if (dependencyErrors.codeOf(error) === "dependency.not_found") {
        return;
      }
      throw error;
    }
  );
  return await refusalsAudited(env, by, found, { ending }, async () => {
    requireOwnSession(by);
    if (found === undefined) {
      throw notFound();
    }
    return await end(env, by, found, ending, decision);
  });
};

// Malware reported after an approval (GRA-924, threat T5). A graph is
// checked for known malware as it is resolved and again as it is approved
// (GRA-913), but a version reported later was still admitted: built
// while nothing was pinned yet, and served or run from what was built.
// What could go wrong, and what stops it:
//
// - A build of a version reported since the approval: an unpinned build
//   asks again first (`refuseMalwareBefore`, packages/build.ts), and is
//   refused as a resolve is (`dependency.malware`, audited as
//   `dependency.malware_refused`), failing closed when either source
//   can't be read (`package.malware_unchecked`).
// - An artifact built before the report, served or run on: every graph in
//   force (approved or retired) is checked again on core's clock, each at
//   most every `malwareRecheckMs`, a bounded number a run
//   (`rescanPackages`). One a report covers is revoked for its subject, as
//   a person's revocation does (`endDependency`): the same batch, so its
//   lock goes, the request waiting for it is denied, and the policy
//   generation moves on, after which nothing of it is admitted, built,
//   served or started, and a run in flight fails at its next call
//   (workflows/sealed-packages.ts). Revoked by core, not a person: audited
//   with a system actor and the advisory, and no `ended.by`.
// - Sources out of reach taken as clean: a check that can't read either
//   source revokes nothing, marks nothing checked, and is logged; the run
//   stops there, and the next one asks again. A revocation that lost a
//   race (a person ended or decided it meanwhile) marks nothing either.
// - A source that answers wrongly revokes what it names: only versions of
//   the graph count (`osvMalwareIn`), and the revocation names its
//   advisory, so its builders can see why and approve a new graph.
//
// An advisory published after the approval, one that doesn't mark
// malware (a vulnerability): the same re-scan reads the registry's
// advisories of the graph's exact versions, and one not known when the
// graph was approved (its review's findings) nor told before is recorded
// (`dependency.advisory_found`) and told to the subject's builders and
// approvers, once (`advisoriesNoticed`). The approval stands: a builder
// decides whether to update or remove the package. Core decides nothing
// a person should.

/** How long an approval in force goes between two re-scans. */
export const malwareRecheckMs = 6 * 60 * 60 * 1000;

/** Most graphs one run of the re-scan asks about, one after another. */
export const malwareRecheckGraphs = 20;

/** Core itself, as the actor of a revocation no person decided. */
const coreActor: AuditActor = { type: "system" };

/**
 * Revokes every approval in force (approved or retired) of `subject`'s
 * graph `graphHash` because packages in it are reported as malware
 * (`found`), as core: one batch that lands only while those approvals are
 * still the ones in force and the policy generation is the one read,
 * recording `dependency.revoked` with the first advisory and how many
 * were found, then each finding as `dependency.malware_refused` (at
 * `recheck`), moving the generation on, denying the request waiting for
 * the graph and dropping its lock, as `endDependency` does. `false` when
 * it lost a race, or nothing was in force: the next run looks again.
 */
const revokeReportedMalware = async (
  env: Env,
  subject: DependencySubject,
  graphHash: string,
  found: readonly [MalwareFound, ...MalwareFound[]]
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const [inForceNow, generationNow] = await Promise.all([
    endableIds(db, subject, graphHash, "revoked"),
    policyGeneration(db),
  ]);
  const ids = inForceNow.map(({ id }) => id);
  const [named] = ids;
  if (named === undefined) {
    return false;
  }
  const [first] = found;
  const generation = generationNow + 1;
  const reason = `Reported as malware: ${packageKey(first.package)} (${first.advisory})`;
  const concerned = await concernedWith(env, subject, ids);
  const event = createAuditEvent(
    {
      actor: coreActor,
      action: "dependency.revoked",
      target: { type: "dependency_request", id: named },
      detail: {
        [subject.type]: subject.id,
        graphHash,
        approvals: ids.length,
        approvalsDigest: await dependencyApprovalsDigest(ids),
        reason: "malware",
        package: first.package.name,
        version: first.package.version,
        advisory: first.advisory,
        found: found.length,
        policyGeneration: generation,
      },
    },
    "core"
  );
  const inForce = endable(subject, graphHash, "revoked");
  const readIds = sql`(SELECT value FROM json_each(${JSON.stringify(ids)}))`;
  const lands = sql`(SELECT COUNT(*) FROM ${dependencyRequests} WHERE ${inForce}) = ${ids.length} AND (SELECT COUNT(*) FROM ${dependencyRequests} WHERE ${inForce} AND ${dependencyRequests.id} IN ${readIds}) = ${ids.length} AND ${policyGenerationSql} = ${generationNow}`;
  const findings = found.slice(0, malwareAuditedMax).map((malware) =>
    outboxedEventWhere(
      db,
      createAuditEvent(
        {
          actor: coreActor,
          action: "dependency.malware_refused",
          target: auditTargetOf(subject),
          detail: {
            [subject.type]: subject.id,
            package: malware.package.name,
            version: malware.package.version,
            advisory: malware.advisory,
            found: found.length,
            at: "recheck",
            revocation: event.id,
          },
        },
        "core"
      ),
      storedEvent(event.id)
    )
  );
  const [, ended] = await auditedBatch(env, db, [
    outboxedEventWhere(db, event, lands),
    db
      .update(dependencyRequests)
      .set({
        status: "revoked",
        endedBy: null,
        endedAt: new Date(),
        endedGeneration: generation,
        endedReason: reason,
      })
      .where(
        and(sql`${dependencyRequests.id} IN ${readIds}`, storedEvent(event.id))
      )
      .returning({ id: dependencyRequests.id }),
    advancePolicy(db, storedEvent(event.id)),
    ...findings,
    ...denyWaiting(
      db,
      { actor: coreActor, userId: null },
      { subject, graphHash },
      event.id,
      generation,
      reason
    ),
    ...unusedLockStatements(db, subject),
    // Its builders and approvers are told, as no person decided it.
    ...packageNoticed(db, {
      type: "package_revoked",
      subject,
      package: first.package,
      advisory: first.advisory,
      personIds: concerned,
      recorded: storedEvent(event.id),
    }),
  ]);
  return ended.length === ids.length;
};

/** One graph in force the re-check is due to read. */
interface DueGraph {
  subjectType: Row["subjectType"];
  subjectId: string;
  graphHash: string;
}

/** An approval in force of a graph, as the re-scan read it. */
interface ReadApproval {
  id: string;
  advisoriesNoticed: string[] | null;
}

/**
 * That the approvals in force of a graph (`inForce`) are still exactly
 * `read`, each with the advisories it had told as they were read, as SQL:
 * so a re-scan tells nothing once the graph ended meanwhile, and two runs
 * never both tell the same advisory.
 */
const unchangedSince = (
  inForce: SQL | undefined,
  read: readonly ReadApproval[]
): SQL => {
  if (read.length === 0) {
    return sql`0`;
  }
  const each = read.map(
    ({ id, advisoriesNoticed }) =>
      sql`(${dependencyRequests.id} = ${id} AND ${dependencyRequests.advisoriesNoticed} IS ${
        advisoriesNoticed === null ? null : JSON.stringify(advisoriesNoticed)
      })`
  );
  return sql`(SELECT COUNT(*) FROM ${dependencyRequests} WHERE ${inForce}) = ${read.length}
    AND (SELECT COUNT(*) FROM ${dependencyRequests} WHERE ${inForce} AND (${sql.join(each, sql` OR `)})) = ${read.length}`;
};

/**
 * Records the advisories `found` of `subject`'s graph that weren't known
 * as it was approved nor told since (`known`), and tells its builders and
 * approvers, once: in one batch that lands only while its approvals in
 * force are still the ones read (`unchangedSince`), and that marks them
 * scanned at `at` and keeps what was told (`advisories_noticed`). The
 * approvals stand.
 */
const noticeAdvisories = async (
  env: Env,
  {
    subject,
    graphHash,
    inForce,
    read,
    known,
  }: {
    subject: DependencySubject;
    graphHash: string;
    inForce: SQL | undefined;
    read: readonly ReadApproval[];
    known: ReadonlySet<string>;
  },
  found: readonly AffectingAdvisory[],
  at: Date
): Promise<void> => {
  const db = drizzle(env.DB);
  // What its approvals keep, and the room left for more: past the cap,
  // nothing more is told, rather than told again on every run.
  const max = advisoriesNoticedMax(env);
  const told = new Set(
    read.flatMap(({ advisoriesNoticed }) => advisoriesNoticed ?? [])
  );
  const unknown = [
    ...new Map(
      found
        .filter(({ advisory }) => !known.has(advisory.id))
        .map((each) => [each.advisory.id, each] as const)
    ).values(),
  ].toSorted((a, b) => a.advisory.id.localeCompare(b.advisory.id));
  const room = Math.max(0, max - told.size);
  if (unknown.length > room) {
    log.warn("dependencies.advisories_capped", {
      [subject.type]: subject.id,
      graphHash,
      max,
      untold: unknown.length - room,
    });
  }
  // A bounded number a run, each recorded as its own event and kept as
  // told: the rest wait for the next run, never skipped.
  const fresh = unknown.slice(
    0,
    Math.min(room, packageLimitsOf(env.PACKAGE_LIMITS).advisoriesPerScan)
  );
  const [first] = fresh;
  if (first === undefined) {
    await db.update(dependencyRequests).set({ scannedAt: at }).where(inForce);
    return;
  }
  // What was told, and what is told now: never told again.
  const noticed = [
    ...told,
    ...fresh.map(({ advisory }) => advisory.id),
  ].toSorted();
  const concerned = await concernedWith(
    env,
    subject,
    read.map(({ id }) => id)
  );
  const [recorded, ...more] = fresh.map(({ advisory, package: ref }) =>
    createAuditEvent(
      {
        actor: coreActor,
        action: "dependency.advisory_found",
        target: auditTargetOf(subject),
        detail: {
          [subject.type]: subject.id,
          graphHash,
          package: ref.name,
          version: ref.version,
          advisory: advisory.id,
          severity: advisory.severity,
          found: fresh.length,
        },
      },
      "core"
    )
  );
  if (recorded === undefined) {
    return;
  }
  const unchanged = unchangedSince(inForce, read);
  await auditedBatch(env, db, [
    outboxedEventWhere(db, recorded, unchanged),
    ...more.map((event) =>
      outboxedEventWhere(db, event, storedEvent(recorded.id))
    ),
    db
      .update(dependencyRequests)
      .set({ scannedAt: at, advisoriesNoticed: noticed })
      .where(and(inForce, storedEvent(recorded.id))),
    ...packageNoticed(db, {
      type: "package_advisory",
      subject,
      package: first.package,
      advisory: first.advisory.id,
      personIds: concerned,
      recorded: storedEvent(recorded.id),
    }),
  ]);
};

/**
 * Re-scans one graph in force against both sources: the registry's
 * advisories of its exact versions and OSV.dev's malware reports. Malware
 * reported since revokes its approvals (`revokeReportedMalware`); clean of
 * it, any advisory new since it was approved is recorded and told
 * (`noticeAdvisories`), and its approvals are marked scanned at `at`.
 * `false` when the sources couldn't be read: nothing is marked, revoked
 * or told, and it is logged.
 */
const recheckGraph = async (
  env: Env,
  db: DrizzleD1Database,
  due: DueGraph,
  at: Date
): Promise<boolean> => {
  const subject = subjectOfRow(due);
  const inForce = and(
    ofSubject(dependencyRequests, subject),
    eq(dependencyRequests.graphHash, due.graphHash),
    inArray(dependencyRequests.status, ["approved", "retired"])
  );
  const read = await db
    .select({
      id: dependencyRequests.id,
      advisoriesNoticed: dependencyRequests.advisoriesNoticed,
    })
    .from(dependencyRequests)
    .where(inForce);
  const [named] = read;
  if (named === undefined) {
    // Ended since it was listed: nothing to check.
    return true;
  }
  // Its graph, from an approval just read: a row is never deleted, so it
  // is there however the graph's approvals changed since, which the batch
  // that tells checks again (`unchangedSince`).
  const row = await db
    .select({ snapshot: dependencyRequests.snapshot })
    .from(dependencyRequests)
    .where(eq(dependencyRequests.id, named.id))
    .get();
  if (row === undefined) {
    return true;
  }
  const { graph, findings } = snapshotSchema.parse(JSON.parse(row.snapshot));
  const packages = graph.packages.map(({ name, version }) => ({
    name,
    version,
  }));
  let scan: PackageScan;
  try {
    scan = await scanPackages(env, packages);
  } catch (error) {
    log.warn("dependencies.malware_unchecked", {
      [subject.type]: subject.id,
      graphHash: due.graphHash,
      errorCode: packageErrors.codeOf(error) ?? "internal.unexpected",
      ...errorFields(error),
    });
    return false;
  }
  const [first, ...rest] = scan.malware;
  if (first === undefined) {
    // What its approvers approved it with, and what the re-scan told since.
    const known = new Set([
      ...findings.flatMap(({ id }) => (id === null ? [] : [id])),
      ...read.flatMap(({ advisoriesNoticed }) => advisoriesNoticed ?? []),
    ]);
    await noticeAdvisories(
      env,
      { subject, graphHash: due.graphHash, inForce, read, known },
      scan.affecting,
      at
    );
    return true;
  }
  const revoked = await revokeReportedMalware(env, subject, due.graphHash, [
    first,
    ...rest,
  ]);
  if (!revoked) {
    log.warn("dependencies.malware_revocation_raced", {
      [subject.type]: subject.id,
      graphHash: due.graphHash,
    });
  }
  return true;
};

/**
 * Re-scans the approvals in force (approved or retired) against the
 * registry's advisories and OSV.dev, on core's clock (clock.ts): each
 * graph at most every {@link malwareRecheckMs}, the longest unscanned
 * first, at most {@link malwareRecheckGraphs} a run, one at a time. A
 * graph malware covers is revoked; a new advisory is recorded and told;
 * one whose sources can't be read ends the run, to be asked again by the
 * next.
 */
export const rescanPackages = async (
  env: Env,
  at: Date = new Date()
): Promise<void> => {
  const db = drizzle(env.DB);
  const due = await db
    .select({
      subjectType: dependencyRequests.subjectType,
      subjectId: dependencyRequests.subjectId,
      graphHash: dependencyRequests.graphHash,
    })
    .from(dependencyRequests)
    .where(
      and(
        inArray(dependencyRequests.status, ["approved", "retired"]),
        or(
          isNull(dependencyRequests.scannedAt),
          lt(
            dependencyRequests.scannedAt,
            new Date(at.getTime() - malwareRecheckMs)
          )
        )
      )
    )
    .groupBy(
      dependencyRequests.subjectType,
      dependencyRequests.subjectId,
      dependencyRequests.graphHash
    )
    .orderBy(sql`MIN(coalesce(${dependencyRequests.scannedAt}, 0))`)
    .limit(malwareRecheckGraphs);
  for (const graph of due) {
    // oxlint-disable-next-line no-await-in-loop -- one graph at a time, bounded
    if (!(await recheckGraph(env, db, graph, at))) {
      return;
    }
  }
};
