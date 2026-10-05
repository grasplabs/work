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
  dependencyTargetSchema,
  packageKey,
} from "@grasp-os/shared/dependencies";
import type {
  DependenciesWaiting,
  DependencyFinding,
  DependencyGraph,
  DependencyRefusal,
  DependencyRequest,
  DependencyReview,
  DependencyStatus,
  DependencyTarget,
} from "@grasp-os/shared/dependencies";
import { appIdSchema, identifierSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { appFor } from "../apps.ts";
import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
import type { Acting } from "../auth/identity.ts";
import {
  apps,
  dependencyPolicy,
  dependencyRequests,
  users,
} from "../db/core/schema.ts";
import { isUniqueViolation } from "../db/d1.ts";
import { holdsApprove, holdsApproveSql } from "./approvers.ts";
import { policyGeneration, policyGenerationSql } from "./policy.ts";

// npm packages proposed for an App, a person's decision on them, and the
// one check that says whether a graph may be used. Nothing here fetches,
// unpacks or runs a package: a graph is data handed in, and an approval is
// a row. What could go wrong, and what stops it:
//
// - Packages used before anyone approved them. A request allows nothing.
//   `admitDependencies` is the only way a graph counts as approved, and it
//   answers yes for exactly what a person approved: this App, this source
//   revision, this graph (by its hash, which core computes itself from the
//   packages, never takes from the request) and these targets. Anything
//   else is refused, and the refusal is audited.
// - An agent, a workflow or App code approving. They propose
//   (agent-builds.ts) and nothing more: deciding is only on a person's own
//   `/rpc` session, and takes the session's identity, never one handed in.
// - A role standing in for the permission, or someone deciding after they
//   lost it, left, or were taken off the team. Whether the person holds
//   `dependencies.approve` is part of the one update that takes the
//   decision (`holdsApproveSql`), so it is read as the decision lands.
// - A decision on something other than what the person reviewed. The same
//   update lands only while the request is still pending, its graph is the
//   one they named, and the policy generation is the one they saw. A
//   request never changes; a proposal for another revision, graph or
//   target takes the pending one's place (`superseded`), so the source
//   moving on refuses the old request, and an approval never covers a
//   revision other than the one reviewed.
// - Two decisions. The first lands; the second finds nothing pending.
// - One huge request. The size is measured on what core stores, never
//   taken from a count in the request, and the lists are capped.
// - Package text steering anyone. A licence or a finding's summary is
//   bounded text shown as text; nothing reads it as instructions.
// - A request showing more than the decision needs. It holds package
//   metadata only: no source, records or credentials can be put in one.
// - An approval taken for more than it is. It says these exact packages
//   may be used by this App on these targets. It grants no connector,
//   collection, file or model access, approves no browser artifact for
//   sensitive data, and every use still runs under the App's own
//   permissions.

type Row = typeof dependencyRequests.$inferSelect;

/** What a request keeps of its review, as JSON in `snapshot`. */
const snapshotSchema = z.object({
  graph: dependencyGraphSchema,
  findings: z.array(z.custom<DependencyFinding>()),
  refused: z.array(z.custom<DependencyRefusal>()),
});

const targetsSchema = z.array(dependencyTargetSchema);

const targetsOf = (row: Pick<Row, "targets">): DependencyTarget[] =>
  targetsSchema.parse(JSON.parse(row.targets));

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
  rows: readonly Row[]
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

const toRequest = async (env: Env, row: Row): Promise<DependencyRequest> => {
  const [request] = await toRequests(env, [row]);
  if (request === undefined) {
    throw new Error(`Dependency request ${row.id} is missing`);
  }
  return request;
};

/** An App's requests in `status`, newest first. */
const requestsOf = async (
  env: Env,
  app: AppId,
  status: Row["status"]
): Promise<Row[]> =>
  await drizzle(env.DB)
    .select()
    .from(dependencyRequests)
    .where(
      and(
        eq(dependencyRequests.appId, app),
        eq(dependencyRequests.status, status)
      )
    )
    .orderBy(desc(dependencyRequests.requestedAt), desc(dependencyRequests.id));

/**
 * Proposes a graph for an App, as one of its builders or the chat's agent
 * acting for one: a pending request, which allows nothing. Never Grasp
 * staff, who neither ask for nor decide what a client's Apps may use.
 *
 * What is already there decides what happens. The same graph, revision
 * and targets already approved: that approval, and nothing new. The same
 * review already waiting: that request. Anything else waiting for the App
 * is superseded in the batch that stores the new request, as one waits per
 * App. A proposal that loses that race to another starts over.
 */
export const proposeDependencies = async (
  env: Env,
  by: Acting,
  input: unknown
): Promise<DependencyRequest> => {
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const proposal = dependencyErrors.parse(
    "dependency.invalid",
    dependencyProposalSchema,
    input
  );
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
  const graphHash = await dependencyGraphHash(graph);
  const targets = JSON.stringify(proposal.targets.toSorted());
  const same = (row: Row): boolean =>
    row.sourceRevision === proposal.sourceRevision &&
    row.graphHash === graphHash &&
    row.targets === targets;
  const actor = by.actor ?? actorOf(by);
  const db = drizzle(env.DB);
  for (let attempt = 0; attempt < proposalTries; attempt += 1) {
    // Each attempt reads how things stand now.
    // oxlint-disable-next-line no-await-in-loop
    const [approved, [waiting], generation] = await Promise.all([
      requestsOf(env, proposal.app, "approved"),
      requestsOf(env, proposal.app, "pending"),
      policyGeneration(db),
    ]);
    const standing = approved.find(same);
    if (standing) {
      // oxlint-disable-next-line no-await-in-loop
      return await toRequest(env, standing);
    }
    if (waiting && same(waiting) && waiting.snapshot === snapshot) {
      // oxlint-disable-next-line no-await-in-loop
      return await toRequest(env, waiting);
    }
    const row: Row = {
      id: crypto.randomUUID(),
      appId: proposal.app,
      sourceRevision: proposal.sourceRevision,
      graphHash,
      targets,
      purpose: proposal.purpose,
      snapshot,
      direct: graph.direct.length,
      packages: graph.packages.length,
      findings: proposal.findings.length,
      refused: proposal.refused.length,
      previous: approved[0]?.id ?? null,
      status: "pending",
      requestedBy: by.userId,
      requestedVia: by.via ?? null,
      requestedAt: new Date(),
      policyGeneration: generation,
      decidedBy: null,
      decidedAt: null,
      decidedGeneration: null,
      reason: null,
    };
    const requested = [
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
    ] as const;
    try {
      // oxlint-disable-next-line no-await-in-loop
      await auditedBatch(
        env,
        db,
        waiting
          ? [
              db
                .update(dependencyRequests)
                .set({ status: "superseded" })
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
              ...requested,
            ]
          : [...requested]
      );
      // oxlint-disable-next-line no-await-in-loop
      return await toRequest(env, row);
    } catch (error) {
      // Another request for the App is pending now: the batch wrote
      // nothing, and the next attempt goes by that one.
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
  }
  throw dependencyErrors.create("dependency.stale");
};

/** How an App's dependencies stand, for its builders. */
export const dependencyStatus = async (
  env: Env,
  by: Acting,
  app: unknown
): Promise<DependencyStatus> => {
  const { id } = await appFor(env, by, app, "builder");
  const db = drizzle(env.DB);
  const [generation, pending, approved] = await Promise.all([
    policyGeneration(db),
    requestsOf(env, id, "pending"),
    requestsOf(env, id, "approved"),
  ]);
  const [waiting] = await toRequests(env, pending);
  return {
    policyGeneration: generation,
    pending: waiting ?? null,
    approved: await toRequests(env, approved),
  };
};

/**
 * The requests waiting on `by`: every pending one, oldest first, if they
 * hold `dependencies.approve` now; none otherwise, whatever their role.
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
    .select()
    .from(dependencyRequests)
    .where(eq(dependencyRequests.status, "pending"))
    .orderBy(dependencyRequests.requestedAt, dependencyRequests.id);
  return {
    policyGeneration: generation,
    requests: await toRequests(env, rows),
  };
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

const keysOf = (
  graph: DependencyGraph
): Map<string, { name: string; version: string }> =>
  new Map(
    graph.packages.map(({ name, version }) => [
      packageKey({ name, version }),
      { name, version },
    ])
  );

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
    } catch {
      throw notFound();
    }
  }
  const { graph, findings, refused } = snapshotSchema.parse(
    JSON.parse(row.snapshot)
  );
  const before =
    row.previous === null ? undefined : await findRow(env, row.previous);
  let previous: DependencyReview["previous"] = null;
  if (before) {
    const was = keysOf(snapshotSchema.parse(JSON.parse(before.snapshot)).graph);
    const now = keysOf(graph);
    previous = {
      request: before.id,
      added: [...now].filter(([key]) => !was.has(key)).map(([, ref]) => ref),
      removed: [...was].filter(([key]) => !now.has(key)).map(([, ref]) => ref),
    };
  }
  return { ...(await toRequest(env, row)), graph, findings, refused, previous };
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
  const found = await findRow(env, input);
  const { approved, reviewed, reason } = dependencyErrors.parse(
    "dependency.invalid",
    dependencyDecisionSchema,
    decision
  );
  const status = approved ? "approved" : "denied";
  const db = drizzle(env.DB);
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
      .returning(),
    outboxedIfChanged(
      db,
      requestEntry(actorOf(by), status, found, {
        requestedBy: found.requestedBy,
        policyGeneration: reviewed.policyGeneration,
        ...(reason === undefined ? {} : { reason }),
      })
    ),
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
  sourceRevision: z.string().min(1).max(128),
  graphHash: z.string().regex(/^[0-9a-f]{64}$/u),
  targets: z.array(dependencyTargetSchema).min(1),
  policyGeneration: z.int().nonnegative(),
});

/** What a build asks to use: one graph, for one App, revision and targets. */
export type DependencyAdmission = z.input<typeof admissionSchema>;

/**
 * Whether exactly this graph is approved: for this App, at this source
 * revision, for every one of these targets, under the policy generation
 * the caller read. The one check for anything that would build with, run
 * or publish an App's packages; it answers with the approval it relied
 * on, to record with what was built. One read of the database answers it,
 * so a decision or a policy change lands wholly before or after.
 *
 * Refused with `dependency.policy_changed` when the generation moved on
 * since the caller read it (read the status again), and with
 * `dependency.approval_required` for anything not approved as asked: its
 * details name the request waiting for that graph, if one is. Each refusal
 * is audited as `actor`'s. An admission that succeeds records nothing
 * here: what uses it records the approval it relied on.
 */
export const admitDependencies = async (
  env: Env,
  actor: AuditActor,
  input: DependencyAdmission
): Promise<{ approval: string; policyGeneration: number }> => {
  const asked = admissionSchema.parse(input);
  const db = drizzle(env.DB);
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
          eq(dependencyRequests.sourceRevision, asked.sourceRevision),
          eq(dependencyRequests.graphHash, asked.graphHash),
          inArray(dependencyRequests.status, ["approved", "pending"])
        )
      )
      .orderBy(desc(dependencyRequests.requestedAt)),
  ]);
  const generation = policy?.generation ?? 0;
  const approval =
    generation === asked.policyGeneration
      ? candidates.find(
          (row) =>
            row.status === "approved" &&
            asked.targets.every((target) => targetsOf(row).includes(target))
        )
      : undefined;
  if (approval) {
    return { approval: approval.id, policyGeneration: generation };
  }
  const policyChanged = generation !== asked.policyGeneration;
  const waiting = candidates.find((row) => row.status === "pending");
  await auditedBatch(env, db, [
    outboxed(db, {
      actor,
      action: "dependency.admission_refused",
      target: { type: "app", id: asked.app },
      detail: {
        app: asked.app,
        sourceRevision: asked.sourceRevision,
        graphHash: asked.graphHash,
        targets: asked.targets.toSorted().join(" "),
        policyGeneration: asked.policyGeneration,
        reason: policyChanged ? "policy_changed" : "not_approved",
        ...(waiting ? { request: waiting.id } : {}),
      },
    }),
  ]);
  throw policyChanged
    ? dependencyErrors.create("dependency.policy_changed")
    : dependencyErrors.create(
        "dependency.approval_required",
        waiting ? { request: waiting.id } : undefined
      );
};
