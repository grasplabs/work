import { appErrors } from "@grasp-os/shared/apps";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { actorOf } from "@grasp-os/shared/audit";
import {
  canonicalGraph,
  dependencyDecisionSchema,
  dependencyErrors,
  dependencyGraphHash,
  dependencyGraphSchema,
  dependencyMaxBytes,
  dependencyProposalSchema,
  dependencySummaryDirect,
  dependencySummaryFindings,
  dependencyTargetSchema,
  packageKey,
} from "@grasp-os/shared/dependencies";
import type {
  DependenciesWaiting,
  DependencyFinding,
  DependencyGraph,
  DependencyPackage,
  DependencyRefusal,
  DependencyRequest,
  DependencyReview,
  DependencyStatus,
  DependencyTarget,
} from "@grasp-os/shared/dependencies";
import { appIdSchema, identifierSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { log } from "@grasp-os/shared/log";
import type { GraspLock, PackageLimits } from "@grasp-os/shared/packages";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  sql,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { appFor } from "../apps.ts";
import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
import type { Acting } from "../auth/identity.ts";
import {
  apps,
  auditOutbox,
  dependencyAdmissionRefusals,
  dependencyPolicy,
  dependencyRequests,
  users,
} from "../db/core/schema.ts";
import { isUniqueViolation } from "../db/d1.ts";
import {
  lockGuardFailed,
  lockStatements,
  unusedLockStatements,
} from "../packages/locks.ts";
import { holdsApprove, holdsApproveSql } from "./approvers.ts";
import { peerIssues } from "./peers.ts";
import { policyGeneration, policyGenerationSql } from "./policy.ts";

// npm packages proposed for an App, a person's decision on them, and the
// one check that says whether a graph may be used. Nothing here fetches,
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
  | "approved"
  | "denied"
  | "admission_refused";

/** The audit entry of something that happened to a request: identifiers only. */
const requestEntry = (
  actor: AuditActor,
  action: DependencyAction,
  row: Pick<
    Row,
    | "id"
    | "appId"
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
    app: row.appId,
    sourceRevision: row.sourceRevision,
    graphHash: row.graphHash,
    targets: targetsOf(row).join(" "),
    direct: row.direct,
    packages: row.packages,
    ...detail,
  },
});

/** `rows` as the API returns them, with the App's and the people's names. */
const toRequests = async (
  env: Env,
  rows: readonly Listed[]
): Promise<DependencyRequest[]> => {
  if (rows.length === 0) {
    return [];
  }
  const db = drizzle(env.DB);
  const people = [
    ...new Set(
      rows.flatMap(({ requestedBy, decidedBy }) =>
        decidedBy === null ? [requestedBy] : [requestedBy, decidedBy]
      )
    ),
  ];
  const [appNames, personNames] = await Promise.all([
    db
      .select({ id: apps.id, name: apps.name })
      .from(apps)
      .where(inArray(apps.id, [...new Set(rows.map(({ appId }) => appId))])),
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, people)),
  ]);
  const appName = new Map(appNames.map(({ id, name }) => [id, name]));
  const personName = new Map(personNames.map(({ id, name }) => [id, name]));
  const person = (userId: string) => ({
    userId,
    name: personName.get(userId) ?? "",
  });
  return rows.map((row) => ({
    id: row.id,
    app: {
      id: appIdSchema.parse(row.appId),
      name: appName.get(row.appId) ?? "",
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
 * An App's approvals of the graph `graphHash`, in no order, without the
 * graph: one for each set of targets it was approved for, so a handful at
 * most, however many graphs the App has had approved.
 */
const approvalsOf = async (
  env: Env,
  app: AppId,
  graphHash: string
): Promise<Listed[]> =>
  await drizzle(env.DB)
    .select(listed)
    .from(dependencyRequests)
    .where(
      and(
        eq(dependencyRequests.appId, app),
        eq(dependencyRequests.graphHash, graphHash),
        eq(dependencyRequests.status, "approved")
      )
    );

/** The approval an App got last, if any, without its graph. */
const latestApproval = async (
  env: Env,
  app: AppId
): Promise<Listed | undefined> =>
  await drizzle(env.DB)
    .select(listed)
    .from(dependencyRequests)
    .where(
      and(
        eq(dependencyRequests.appId, app),
        eq(dependencyRequests.status, "approved")
      )
    )
    .orderBy(desc(dependencyRequests.decidedAt))
    .limit(1)
    .get();

/** The one request waiting for an App, if any, without its graph. */
const pendingFor = async (env: Env, app: AppId): Promise<Listed | undefined> =>
  await drizzle(env.DB)
    .select(listed)
    .from(dependencyRequests)
    .where(
      and(
        eq(dependencyRequests.appId, app),
        eq(dependencyRequests.status, "pending")
      )
    )
    .get();

/**
 * The statements that drop whatever request waits for `app` as their batch
 * runs, replaced by `by`, with its audit event by `actor`: the event
 * first, written from the very row the delete then removes (one waits per
 * App at most), so it names what was removed whatever was read before,
 * and nothing is recorded when nothing waits. What `requestEntry` records
 * of a superseded request, as SQL.
 */
const dropPending = (
  db: DrizzleD1Database,
  actor: AuditActor,
  app: AppId,
  by: string
) => {
  const waits = and(
    eq(dependencyRequests.appId, app),
    eq(dependencyRequests.status, "pending")
  );
  const eventId = crypto.randomUUID();
  const now = new Date();
  const event = sql`json_object(
    'id', ${eventId},
    'at', ${now.toISOString()},
    'source', 'core',
    'actor', json(${JSON.stringify(actor)}),
    'action', 'dependency.superseded',
    'target', json_object('type', 'dependency_request', 'id', ${dependencyRequests.id}),
    'provenance', json('[]'),
    'detail', json_object(
      'app', ${dependencyRequests.appId},
      'sourceRevision', ${dependencyRequests.sourceRevision},
      'graphHash', ${dependencyRequests.graphHash},
      'targets', (SELECT group_concat(value, ' ') FROM json_each(${dependencyRequests.targets})),
      'direct', ${dependencyRequests.direct},
      'packages', ${dependencyRequests.packages},
      'by', ${by}
    )
  )`;
  return [
    db
      .insert(auditOutbox)
      .select(
        sql`SELECT ${eventId}, ${event}, ${now.getTime()} FROM ${dependencyRequests} WHERE ${waits}`
      ),
    db.delete(dependencyRequests).where(waits),
  ] as const;
};

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
  graph: DependencyGraph;
  graphHash: string;
  targets: string;
  snapshot: string;
}

/** A new pending request's row for `checked`. */
const newRequest = (
  { proposal, graph, graphHash, targets, snapshot }: Checked,
  by: Acting,
  previous: string | null,
  generation: number
): Row => ({
  id: crypto.randomUUID(),
  appId: proposal.app,
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
});

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
  const { proposal, graphHash, targets, snapshot } = checked;
  const actor = by.actor ?? actorOf(by);
  const db = drizzle(env.DB);
  const [approvals, latest, waiting, generation, written] = await Promise.all([
    approvalsOf(env, proposal.app, graphHash),
    latestApproval(env, proposal.app),
    pendingFor(env, proposal.app),
    policyGeneration(db),
    resolved === undefined
      ? undefined
      : lockStatements(db, by, {
          app: proposal.app,
          graphHash,
          fresh: resolved.lock,
          limits: resolved.limits,
        }),
  ]);
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
    return {
      request: standing,
      lock,
      statements: [
        ...dropPending(db, actor, proposal.app, standing.id),
        ...lockFirst,
        ...unusedLockStatements(db, proposal.app),
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
    return { request: waiting, lock, statements: lockFirst };
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
      ...unusedLockStatements(db, proposal.app),
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
  await appFor(env, by, proposal.app, "builder");
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

/** How an App's dependencies stand, for its builders. */
export const dependencyStatus = async (
  env: Env,
  by: Acting,
  app: unknown
): Promise<DependencyStatus> => {
  const { id } = await appFor(env, by, app, "builder");
  const [generation, pending, approved] = await Promise.all([
    policyGeneration(drizzle(env.DB)),
    pendingFor(env, id),
    latestApproval(env, id),
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
 * every App, shared with them or not: its package metadata, never its
 * source.
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
 * `dependencies.approve` now) or builds its App; `dependency.not_found`
 * for anyone else, as for one that isn't there.
 */
export const dependencyReview = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<DependencyReview> => {
  const row = await findRow(env, input);
  if (!(await holdsApprove(env, by))) {
    try {
      await appFor(env, by, row.appId, "builder");
    } catch (error) {
      // Not theirs to read: as if it weren't there. Anything else failed.
      if (
        appErrors.codeOf(error) === "app.not_found" ||
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
 * the permission themselves.
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
        policyGeneration: reviewed.policyGeneration,
        ...(reason === undefined ? {} : { reason }),
      })
    ),
    // A denied graph's lock goes, unless another request still names it.
    ...unusedLockStatements(db, found.appId),
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

const admissionSchema = z.strictObject({
  app: appIdSchema,
  graphHash: z.string().regex(/^[0-9a-f]{64}$/u),
  targets: z.array(dependencyTargetSchema).min(1),
  policyGeneration: z.int().nonnegative(),
});

/** What a build asks to use: one graph, for one App and targets. */
export type DependencyAdmission = z.input<typeof admissionSchema>;

/** What `admissionOf` decided. */
export type Admission =
  | { admitted: true; approval: string; policyGeneration: number }
  | {
      admitted: false;
      reason: "policy_changed" | "not_approved";
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
 * policy generation the caller read. For a caller that records a refusal
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
          eq(dependencyRequests.appId, asked.app),
          eq(dependencyRequests.graphHash, asked.graphHash),
          inArray(dependencyRequests.status, ["approved", "pending", "denied"])
        )
      ),
  ]);
  const generation = policy?.generation ?? 0;
  const policyChanged = generation !== asked.policyGeneration;
  const approval = policyChanged
    ? undefined
    : candidates.find(
        (row) => row.status === "approved" && covers(row, asked.targets)
      );
  if (approval) {
    return {
      admitted: true,
      approval: approval.id,
      policyGeneration: generation,
    };
  }
  return {
    admitted: false,
    reason: policyChanged ? "policy_changed" : "not_approved",
    waiting: candidates.find((row) => row.status === "pending")?.id,
    requested: candidates.length > 0,
    generation,
  };
};

/**
 * Whether exactly this graph is approved: for this App, for every one of
 * these targets, under the policy generation the caller read. The one
 * check for anything that would build with, run or publish an App's
 * packages; it answers with the approval it relied on, to record with
 * what was built. One read of the database answers it, so a decision or a
 * policy change lands wholly before or after.
 *
 * Which revision of the source the graph comes from is not asked: an
 * approved graph holds for every revision that resolves to it, and a
 * source that asks for anything else resolves to another hash.
 *
 * Refused with `dependency.policy_changed` when the generation moved on
 * since the caller read it (read the status again), and with
 * `dependency.approval_required` for anything not approved as asked: its
 * details name the request waiting for that graph, if one is. A refusal
 * is audited as `actor`'s the first time it is made for this App, graph,
 * set of targets, policy generation in force and reason, and only for a
 * graph some request of the App's names: the same refusal again records
 * nothing more, and one of a hash nobody proposed is logged instead, so a
 * caller can't fill the audit trail by asking. Each part of that key is
 * one core decides or a handful of values (never the generation the
 * caller says it read), so the rows it keeps are bounded too. An
 * admission that succeeds records nothing here: what uses it records the
 * approval it relied on.
 */
export const admitDependencies = async (
  env: Env,
  actor: AuditActor,
  input: DependencyAdmission
): Promise<{ approval: string; policyGeneration: number }> => {
  const asked = admissionSchema.parse(input);
  const db = drizzle(env.DB);
  const decided = await admissionOf(db, asked);
  if (decided.admitted) {
    return {
      approval: decided.approval,
      policyGeneration: decided.policyGeneration,
    };
  }
  const { reason, waiting, requested, generation } = decided;
  const targets = [...new Set(asked.targets)].toSorted().join(" ");
  if (requested) {
    await auditedBatch(env, db, [
      db
        .insert(dependencyAdmissionRefusals)
        .values({
          appId: asked.app,
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
        target: { type: "app", id: asked.app },
        detail: {
          app: asked.app,
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
      app: asked.app,
      graphHash: asked.graphHash,
      targets,
      reason,
    });
  }
  throw reason === "policy_changed"
    ? dependencyErrors.create("dependency.policy_changed")
    : dependencyErrors.create(
        "dependency.approval_required",
        waiting === undefined ? undefined : { request: waiting }
      );
};
