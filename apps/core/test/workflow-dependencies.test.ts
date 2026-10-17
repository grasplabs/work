import type { AuditEvent } from "@grasp-os/shared/audit";
import { npmRegistryOrigin } from "@grasp-os/shared/dependencies";
import type {
  DependencyProposal,
  DependencyRequest,
} from "@grasp-os/shared/dependencies";
import type { DependencyIntent } from "@grasp-os/shared/packages";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  admitDependencies,
  proposeForTests,
} from "../src/dependencies/requests.ts";
import { mockIdp } from "./idp.ts";
import { named, plain, publish } from "./npm.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// Packages for an independent workflow's compute modules (GRA-665), from
// the threat model on the issue: a workflow's packages need a person's
// approval exactly as an App's do, in the same queue, for `computation`
// only, asked for by the workflow's own builders, and an approval is its
// subject's alone, so an App's never covers a workflow, nor a
// workflow's an App. Who approved their own request is on the record.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

const integrity = `sha512-${"A".repeat(86)}==`;

/** A one-package graph, the same whoever proposes it. */
const graph: DependencyProposal["graph"] = {
  direct: [{ name: "stats", version: "1.0.0" }],
  packages: [
    {
      name: "stats",
      version: "1.0.0",
      origin: npmRegistryOrigin,
      integrity,
      license: "MIT",
      dependencies: [],
      peers: [],
    },
  ],
  platformPeers: {},
};

/** A proposal of `graph` for `subject` (`{ app }` or `{ workflow }`). */
const proposalFor = (
  subject: { app: string } | { workflow: string },
  changes: Partial<DependencyProposal> = {}
): DependencyProposal => ({
  ...subject,
  sourceRevision: "rev-1",
  purpose: "Compute the weighted median of the quarter.",
  targets: ["computation"],
  graph,
  findings: [],
  refused: [],
  ...changes,
});

/** Proposes as the resolver does once it resolved a graph (packages/resolve.ts). */
const proposeAs = async (
  person: Person,
  proposal: DependencyProposal
): Promise<DependencyRequest> =>
  await proposeForTests(env, await person.api.whoami(), proposal);

/** A builder with a new independent workflow of theirs. */
const builderWithWorkflow = async () => {
  const builder = await personApi("builder");
  const { id, name } = await builder.api.workflowResources.create(
    `stats-${unique()}`
  );
  return { builder, workflow: id, name };
};

/** A member an admin gave `dependencies.approve`. */
const approverBy = async (admin: Person, person?: Person): Promise<Person> => {
  const approver = person ?? (await personApi("user"));
  await admin.api.dependencies.grantApprover({
    type: "person",
    userId: approver.userId,
  });
  return approver;
};

const decide = async (
  api: Person["api"],
  request: Pick<DependencyRequest, "id" | "graphHash">,
  approved = true
) => {
  const { policyGeneration } = await api.dependencies.waiting();
  return await api.dependencies.decide(request.id, {
    approved,
    reviewed: { graphHash: request.graphHash, policyGeneration },
  });
};

/** Whether `graphHash` may be used for `subject` on `targets` now. */
const admission = async (
  person: Person,
  subject: { app: string } | { workflow: string },
  graphHash: string,
  targets: DependencyRequest["targets"] = ["computation"]
): Promise<string> => {
  const { policyGeneration } = await person.api.dependencies.status(subject);
  return await outcome(
    admitDependencies(
      env,
      { type: "person", userId: person.userId },
      { ...subject, graphHash, targets, policyGeneration }
    )
  );
};

/** The dependency events of `events`, as action, target and detail. */
const dependencyEvents = (events: AuditEvent[]) =>
  events
    .filter(({ action }) => action.startsWith("dependency."))
    .map(({ action, target, detail }) => ({ action, target, detail }));

describe("packages for a workflow's compute modules", () => {
  it("waits in the approvers' queue as the workflow's, and admits nothing until a person approves", async () => {
    const admin = await personApi("admin");
    const approver = await approverBy(admin);
    const { builder, workflow, name } = await builderWithWorkflow();
    const request = await proposeAs(builder, proposalFor({ workflow }));

    const { requests } = await approver.api.dependencies.waiting();
    const before = await admission(builder, { workflow }, request.graphHash);
    await decide(approver.api, request);
    const after = await admission(builder, { workflow }, request.graphHash);
    const { approved } = await builder.api.dependencies.status({ workflow });

    expect({
      queued: requests.find(({ id }) => id === request.id)?.subject,
      before,
      after,
      approved: approved?.id,
    }).toStrictEqual({
      queued: { type: "workflow", id: workflow, name },
      before: "dependency.approval_required",
      after: "ok",
      approved: request.id,
    });
  });

  it("asks only for computation: any other target is refused, and nothing waits", async () => {
    const { builder, workflow } = await builderWithWorkflow();

    const refused = await Promise.all(
      (
        [
          ["browser"],
          ["server"],
          ["workflow"],
          ["computation", "server"],
        ] as const
      ).map(
        async (targets) =>
          await outcome(
            proposeAs(
              builder,
              proposalFor({ workflow }, { targets: [...targets] })
            )
          )
      )
    );
    const resolved = await outcome(
      builder.api.dependencies.resolve({
        workflow,
        sourceRevision: "rev-1",
        purpose: "Render a chart.",
        targets: ["browser"],
        dependencies: { stats: "^1.0.0" },
      })
    );
    const { pending } = await builder.api.dependencies.status({ workflow });

    expect({ refused, resolved, pending }).toStrictEqual({
      refused: Array.from({ length: 4 }, () => "dependency.invalid"),
      resolved: "dependency.invalid",
      pending: null,
    });
  });

  it("is asked for and read by the workflow's builders only", async () => {
    const { builder, workflow } = await builderWithWorkflow();
    const follower = await personApi("builder");
    await builder.api.workflowResources.share(workflow, {
      type: "person",
      id: follower.userId,
      role: "user",
    });
    const stranger = await personApi("builder");
    // An App of their own gives them nothing in the workflow.
    const { id: app } = await stranger.api.apps.create({
      name: `App ${unique()}`,
    });

    const asked = {
      follower: await outcome(proposeAs(follower, proposalFor({ workflow }))),
      stranger: await outcome(proposeAs(stranger, proposalFor({ workflow }))),
      both: await outcome(
        proposeAs(stranger, { ...proposalFor({ workflow }), app })
      ),
      followerReads: await outcome(
        follower.api.dependencies.status({ workflow })
      ),
      strangerReads: await outcome(
        stranger.api.dependencies.approvals({ workflow })
      ),
    };

    expect(asked).toStrictEqual({
      follower: "role.forbidden",
      stranger: "workflow.resource_unavailable",
      both: "dependency.invalid",
      followerReads: "role.forbidden",
      strangerReads: "workflow.resource_unavailable",
    });
  });

  it("keeps an App's approval and a workflow's apart, even of the same packages", async () => {
    const admin = await personApi("admin");
    const approver = await approverBy(admin);
    const { builder, workflow } = await builderWithWorkflow();
    const { id: app } = await builder.api.apps.create({
      name: `App ${unique()}`,
    });
    const forApp = await proposeAs(builder, proposalFor({ app }));
    await decide(approver.api, forApp);
    const forWorkflow = await proposeAs(builder, proposalFor({ workflow }));

    // The same graph, approved for the App: the workflow still waits.
    const whileWaiting = await admission(
      builder,
      { workflow },
      forApp.graphHash
    );
    await decide(approver.api, forWorkflow);
    // Revoking the workflow's ends nothing of the App's.
    const { policyGeneration, endings } =
      await approver.api.dependencies.impact(forWorkflow.id);
    await approver.api.dependencies.revoke(forWorkflow.id, {
      reviewed: {
        graphHash: forWorkflow.graphHash,
        policyGeneration,
        approvalsDigest: endings.revoke.digest,
      },
      reason: "Not needed by this workflow any more.",
    });

    const appApprovals = await builder.api.dependencies.approvals({ app });
    const workflowApprovals = await approver.api.dependencies.approvals({
      workflow,
    });

    expect({
      sameGraph: forApp.graphHash === forWorkflow.graphHash,
      separateRequests: forApp.id !== forWorkflow.id,
      whileWaiting,
      workflowAfter: await admission(
        builder,
        { workflow },
        forWorkflow.graphHash
      ),
      appAfter: await admission(builder, { app }, forApp.graphHash),
      appApprovals: appApprovals.approvals.map(({ id }) => id),
      workflowApprovals: workflowApprovals.approvals.map(({ id }) => id),
    }).toStrictEqual({
      sameGraph: true,
      separateRequests: true,
      whileWaiting: "dependency.approval_required",
      workflowAfter: "dependency.revoked",
      appAfter: "ok",
      appApprovals: [forApp.id],
      workflowApprovals: [],
    });
  });

  it("records the workflow as what was refused, approved or revoked", async () => {
    const admin = await personApi("admin");
    const approver = await approverBy(admin);
    const { builder, workflow } = await builderWithWorkflow();
    const request = await proposeAs(builder, proposalFor({ workflow }));

    const events = await auditedDuring(async () => {
      await admission(builder, { workflow }, request.graphHash);
      await decide(approver.api, request);
    });

    expect(dependencyEvents(events)).toMatchObject([
      {
        action: "dependency.admission_refused",
        target: { type: "workflow_resource", id: workflow },
        detail: { workflow, reason: "not_approved", request: request.id },
      },
      {
        action: "dependency.approved",
        target: { type: "dependency_request", id: request.id },
        detail: { workflow, targets: "computation", selfDecided: false },
      },
    ]);
  });

  it("says when someone approved their own request, for an App or a workflow", async () => {
    const admin = await personApi("admin");
    const { builder, workflow } = await builderWithWorkflow();
    await approverBy(admin, builder);
    const { id: app } = await builder.api.apps.create({
      name: `App ${unique()}`,
    });
    const forWorkflow = await proposeAs(builder, proposalFor({ workflow }));
    const forApp = await proposeAs(
      builder,
      proposalFor({ app }, { targets: ["browser"] })
    );

    const events = await auditedDuring(async () => {
      await decide(builder.api, forWorkflow);
      await decide(builder.api, forApp, false);
    });

    expect(
      dependencyEvents(events).map(({ action, detail }) => ({
        action,
        requestedBy: detail.requestedBy,
        selfDecided: detail.selfDecided,
      }))
    ).toStrictEqual([
      {
        action: "dependency.approved",
        requestedBy: builder.userId,
        selfDecided: true,
      },
      {
        action: "dependency.denied",
        requestedBy: builder.userId,
        selfDecided: true,
      },
    ]);
  });

  it("locks a resolved graph as the workflow's, and a denial drops only the workflow's lock", async () => {
    const admin = await personApi("admin");
    const approver = await approverBy(admin);
    const { builder, workflow } = await builderWithWorkflow();
    const { id: app } = await builder.api.apps.create({
      name: `App ${unique()}`,
    });
    const stats = named("stats");
    await publish(plain(stats, "1.0.0"));
    const intent = {
      sourceRevision: "rev-1",
      purpose: "Compute the weighted median of the quarter.",
      dependencies: { [stats]: "^1.0.0" },
    } satisfies Partial<DependencyIntent>;
    const forWorkflow = await builder.api.dependencies.resolve({
      ...intent,
      workflow,
      targets: ["computation"],
    });
    await builder.api.dependencies.resolve({
      ...intent,
      app,
      targets: ["computation"],
    });
    const locksOf = async () => {
      const { results } = await env.DB.prepare(
        "SELECT subject_type AS type, subject_id AS id FROM dependency_locks WHERE graph_hash = ? AND subject_id IN (?, ?) ORDER BY subject_type"
      )
        .bind(forWorkflow.request.graphHash, app, workflow)
        .all<{ type: string; id: string }>();
      return results;
    };
    const before = await locksOf();

    await decide(approver.api, forWorkflow.request, false);

    expect({ before, after: await locksOf() }).toStrictEqual({
      before: [
        { type: "app", id: app },
        { type: "workflow", id: workflow },
      ],
      after: [{ type: "app", id: app }],
    });
  });

  it("stores no request, lock, lease or refusal of a subject core doesn't have, nor moves one to another subject", async () => {
    const { builder, workflow } = await builderWithWorkflow();
    const request = await proposeAs(builder, proposalFor({ workflow }));
    const { id: app } = await builder.api.apps.create({
      name: `App ${unique()}`,
    });
    const missing = crypto.randomUUID();
    // Each table's row of `request`'s graph, for the subject bound first.
    const { results: columns } = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('dependency_requests') WHERE name NOT IN ('id', 'subject_type', 'subject_id', 'status')"
    ).all<{ name: string }>();
    const rest = columns.map(({ name }) => name).join(", ");
    const inserts = [
      `INSERT INTO dependency_requests (id, subject_type, subject_id, status, ${rest}) SELECT lower(hex(randomblob(16))), ?, ?, 'denied', ${rest} FROM dependency_requests WHERE graph_hash = ?`,
      "INSERT INTO dependency_locks (subject_type, subject_id, graph_hash, lock, created_at) VALUES (?, ?, ?, '{}', 0)",
      "INSERT INTO dependency_build_leases (subject_type, subject_id, graph_hash, target, holder, expires_at) VALUES (?, ?, ?, 'computation', 'h', 0)",
      "INSERT INTO dependency_admission_refusals (subject_type, subject_id, graph_hash, targets, policy_generation, reason, created_at) VALUES (?, ?, ?, 'computation', 0, 'not_approved', 0)",
    ];
    const subjects = [
      ["workflow", missing],
      ["app", missing],
      // A workflow's ID named as an App's.
      ["app", workflow],
      // Neither kind of subject, though the ID is an App's.
      ["team", app],
    ] as const;

    const inserted = await Promise.all(
      inserts.flatMap((query) =>
        subjects.map(
          async ([type, id]) =>
            await outcome(
              env.DB.prepare(query).bind(type, id, request.graphHash).run()
            )
        )
      )
    );
    const moved = await Promise.all(
      [
        ["subject_id", missing],
        ["subject_type", "app"],
      ].map(
        async ([column, value]) =>
          await outcome(
            env.DB.prepare(
              `UPDATE dependency_requests SET ${column} = ? WHERE id = ?`
            )
              .bind(value, request.id)
              .run()
          )
      )
    );

    expect({
      inserted: inserted.map((said) =>
        said.includes("App or a workflow core has")
      ),
      moved: moved.map((said) => said.includes("keep their subject")),
    }).toStrictEqual({
      inserted: Array.from({ length: 16 }, () => true),
      moved: [true, true],
    });
  });

  it("withdraws a deleted workflow's waiting request and drops the lock only it named", async () => {
    const admin = await personApi("admin");
    const approver = await approverBy(admin);
    const { builder, workflow } = await builderWithWorkflow();
    const stats = named("stats");
    await publish(plain(stats, "1.0.0"));
    const { request } = await builder.api.dependencies.resolve({
      workflow,
      sourceRevision: "rev-1",
      purpose: "Compute the weighted median of the quarter.",
      targets: ["computation"],
      dependencies: { [stats]: "^1.0.0" },
    });
    const locks = async () => {
      const { results } = await env.DB.prepare(
        "SELECT graph_hash FROM dependency_locks WHERE subject_type = 'workflow' AND subject_id = ?"
      )
        .bind(workflow)
        .all();
      return results.length;
    };
    const lockedBefore = await locks();

    const events = await auditedDuring(async () => {
      await builder.api.workflowResources.delete(workflow);
    });
    const waiting = await approver.api.dependencies.waiting();
    const decided = await outcome(decide(approver.api, request));

    expect({
      lockedBefore,
      lockedAfter: await locks(),
      queued: waiting.requests.some(({ id }) => id === request.id),
      decided,
      withdrawn: dependencyEvents(events).map(({ action, target, detail }) => ({
        action,
        target,
        workflow: detail.workflow,
        reason: detail.reason,
      })),
    }).toStrictEqual({
      lockedBefore: 1,
      lockedAfter: 0,
      queued: false,
      decided: "dependency.not_found",
      withdrawn: [
        {
          action: "dependency.withdrawn",
          target: { type: "dependency_request", id: request.id },
          workflow,
          reason: "workflow.deleted",
        },
      ],
    });
  });

  it("says when revoking a graph denies the revoker's own waiting request", async () => {
    const admin = await personApi("admin");
    const { builder, workflow } = await builderWithWorkflow();
    await approverBy(admin, builder);
    const approved = await proposeAs(builder, proposalFor({ workflow }));
    await decide(builder.api, approved);
    const retiring = await builder.api.dependencies.impact(approved.id);
    await builder.api.dependencies.retire(approved.id, {
      reviewed: {
        graphHash: approved.graphHash,
        policyGeneration: retiring.policyGeneration,
        approvalsDigest: retiring.endings.retire.digest,
      },
      reason: "Replaced soon.",
    });
    // The retired graph asked for again: a request that waits for it.
    const waiting = await proposeAs(
      builder,
      proposalFor({ workflow }, { sourceRevision: "rev-2" })
    );
    const { policyGeneration, endings } = await builder.api.dependencies.impact(
      approved.id
    );

    const events = await auditedDuring(async () => {
      await builder.api.dependencies.revoke(approved.id, {
        reviewed: {
          graphHash: approved.graphHash,
          policyGeneration,
          approvalsDigest: endings.revoke.digest,
        },
        reason: "A safer package does the same.",
      });
    });

    expect(
      dependencyEvents(events)
        .filter(({ action }) => action === "dependency.denied")
        .map(({ target, detail }) => ({
          id: target?.id,
          selfDecided: detail.selfDecided,
        }))
    ).toStrictEqual([{ id: waiting.id, selfDecided: true }]);
  });
});
