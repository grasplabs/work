/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { packageModuleName } from "@grasp-os/compiler";
import type { AuditEvent } from "@grasp-os/shared/audit";
import type { DependencyRequest } from "@grasp-os/shared/dependencies";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import type { Acting } from "../src/auth/identity.ts";
import { grantApprover } from "../src/dependencies/approvers.ts";
import { policyGeneration } from "../src/dependencies/policy.ts";
import {
  decideDependency,
  dependencyImpact,
  endDependency,
} from "../src/dependencies/requests.ts";
import { buildDependencies } from "../src/packages/build.ts";
import { resolveDependencies } from "../src/packages/resolve.ts";
import { loadWorkflowBuild } from "../src/workflow-builds.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { sealPackages } from "../src/workflows/sealed-packages.ts";
import { publish } from "./npm.ts";
import { racingDb } from "./racing-db.ts";
import { artifactKey } from "./sealed-apps.ts";
import { auditedDuring, outcome, unique } from "./sign-in.ts";

// Approved npm packages a version of an independent workflow seals for
// its compute modules (GRA-665, slice 3), from the threat model on the
// issue: modules import only the entries their version seals, from an
// approval in force for this workflow; the package's bytes are the
// version's own; and a graph revoked since refuses new starts and fails
// a run in flight at its next call, audited.

/** A member of the organization in `role`, as their session has them. */
const person = async (role: Role): Promise<Identity> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return {
    userId,
    email: `${userId}@acme.test`,
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
};

/** An admin who may approve packages. */
const approver = async (): Promise<Identity> => {
  const admin = await person("admin");
  await grantApprover(env, admin, { type: "person", userId: admin.userId });
  return admin;
};

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/**
 * A definition of `name` that calls `total` on [1, 2, 3] and answers its
 * result as the status; with `linger`, it waits that long first.
 */
const definitionOf = (name: string, linger?: string): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
          params: {},
          bindings: {
            total: { kind: "compute", contract: "local:code/total.ts#total" },
          },
        },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      ...(linger === undefined ? [] : [{ linger: { wait: linger } }]),
      {
        add: {
          call: "grasp.compute",
          with: { binding: "total", arguments: "${ [1, 2, 3] }" },
        },
      },
      { answer: { set: { status: "${ tostring }" } } },
    ],
  });

/** A calculation doubling the sum with `pkg`'s `double`. */
const moduleUsing = (
  pkg: string
): string => `import { compute, v } from "@grasp-os/sdk/compute";
import { double } from ${JSON.stringify(pkg)};

export const total = compute({
  input: v.array(v.number().integer().min(0)).max(100),
  output: v.number().integer().min(0),
  handler: (amounts) => double(amounts.reduce((all, amount) => all + amount, 0)),
});
`;

/** Publishes `name`@`version`, exporting `double`, to the test registry. */
const publishDoubling = async (name: string, version: string) => {
  await publish({
    name,
    version,
    manifest: { type: "module", main: "index.js", license: "MIT" },
    files: {
      "index.js": "export const double = (value) => value * 2;",
    },
  });
};

/** A package exporting `double`, published to the test registry. */
const doubling = async (): Promise<string> => {
  const name = `double-${unique()}`;
  await publishDoubling(name, "1.0.0");
  return name;
};

/** A workflow of a new builder's, and `pkg` resolved for it. */
const workflowWith = async (pkg: string) => {
  const builder = await person("builder");
  const workflow = await createWorkflowResource(env, builder, `p-${unique()}`);
  const { request } = await resolveDependencies(env, builder, {
    workflow: workflow.id,
    sourceRevision: "rev-1",
    purpose: "Double the quarter's total.",
    targets: ["computation"],
    dependencies: { [pkg]: "^1.0.0" },
  });
  return { builder, workflow, request };
};

const approve = async (by: Identity, request: DependencyRequest) => {
  await decideDependency(env, by, request.id, {
    approved: true,
    reviewed: {
      graphHash: request.graphHash,
      policyGeneration: await policyGeneration(drizzle(env.DB)),
    },
  });
};

/** Ends `request`'s graph as `ending` (`retired` or `revoked`), as `by`. */
const end = async (
  by: Identity,
  request: DependencyRequest,
  ending: "retired" | "revoked"
) => {
  const impact = await dependencyImpact(env, by, request.id);
  await endDependency(env, by, request.id, ending, {
    reviewed: {
      graphHash: request.graphHash,
      policyGeneration: impact.policyGeneration,
      approvalsDigest:
        ending === "retired"
          ? impact.endings.retire.digest
          : impact.endings.revoke.digest,
    },
    reason: "No longer wanted.",
  });
};

/** Publishes version 1 of `workflow` with `pkg` imported, sealing `graphHash`. */
const publishedWith = async (
  builder: Acting,
  workflow: { id: string; name: string },
  pkg: string,
  graphHash: string,
  linger?: string
) =>
  await publishWorkflowVersion(
    env,
    builder,
    workflow.id,
    {
      definition: definitionOf(workflow.name, linger),
      basedOn: null,
      modules: { "code/total.ts": moduleUsing(pkg) },
      packages: { graphHash },
    },
    sealPackages
  );

/** Starts version 1 of `workflow` for `by`: its run's ID. */
const started = async (by: Acting, id: string): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, input: { who: "Ada" }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  return runId;
};

/** How run `runId` of `id` ended. */
const ended = async (by: Acting, id: string, runId: string) => {
  const run = await vi.waitFor(
    async () => {
      const found = await resourceRunFor(env, by, id, runId);
      expect(found.endedAt).not.toBeNull();
      return found;
    },
    { timeout: 30_000, interval: 100 }
  );
  return run.status === "completed"
    ? { status: run.status, output: run.output }
    : { status: run.status, code: run.error?.code };
};

const outcomesOf = (events: AuditEvent[], actions: readonly string[]) =>
  events
    .filter(({ action }) => actions.includes(action))
    .map(({ action, detail }) => ({
      action,
      reason: detail.reason ?? null,
      failureCode: detail.failureCode ?? null,
    }));

describe("a workflow's modules importing approved packages", () => {
  it("seals the approved package into the version and runs it", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);

    const version = await publishedWith(
      builder,
      workflow,
      pkg,
      request.graphHash
    );
    const build = await loadWorkflowBuild(env, workflow.id, version.version);
    const run = await ended(
      builder,
      workflow.id,
      await started(builder, workflow.id)
    );

    expect({
      sealed: build.packages,
      module: Object.hasOwn(build.compute.modules, packageModuleName(pkg)),
      run,
    }).toStrictEqual({
      sealed: { graphHash: request.graphHash },
      module: true,
      run: { status: "completed", output: { status: "12" } },
    });
  });

  it("imports no package its version doesn't seal from an approval in force", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    const refusedFor = async ({
      packages,
      sealer = sealPackages,
    }: {
      packages?: { graphHash: string };
      sealer?: typeof sealPackages | null;
    } = {}) =>
      await outcome(
        publishWorkflowVersion(
          env,
          builder,
          workflow.id,
          {
            definition: definitionOf(workflow.name),
            basedOn: null,
            modules: { "code/total.ts": moduleUsing(pkg) },
            ...(packages === undefined ? {} : { packages }),
          },
          sealer ?? undefined
        )
      );

    const unapproved = await refusedFor({
      packages: { graphHash: request.graphHash },
    });
    await approve(admin, request);
    const refused = {
      unapproved,
      unsealed: await refusedFor(),
      otherGraph: await refusedFor({ packages: { graphHash: "f".repeat(64) } }),
      noSealer: await refusedFor({
        packages: { graphHash: request.graphHash },
        sealer: null,
      }),
    };
    // Built and pinned while approved: what a retired graph keeps, and
    // still nothing a new version may seal.
    await buildDependencies(env, builder, {
      workflow: workflow.id,
      graphHash: request.graphHash,
      target: "computation",
      policyGeneration: await policyGeneration(drizzle(env.DB)),
    });
    await end(admin, request, "retired");

    expect({
      ...refused,
      retired: await refusedFor({ packages: { graphHash: request.graphHash } }),
    }).toStrictEqual({
      unapproved: "dependency.approval_required",
      unsealed: "workflow.modules_invalid",
      otherGraph: "dependency.approval_required",
      noSealer: "workflow.packages_invalid",
      retired: "dependency.retired",
    });
  });

  it("keeps running what a retired graph sealed", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    await publishedWith(builder, workflow, pkg, request.graphHash);
    await end(admin, request, "retired");

    await expect(
      ended(builder, workflow.id, await started(builder, workflow.id))
    ).resolves.toStrictEqual({ status: "completed", output: { status: "12" } });
  });

  it("refuses a new start once the graph is revoked, audited", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    await publishedWith(builder, workflow, pkg, request.graphHash);
    await end(admin, request, "revoked");

    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await outcome(started(builder, workflow.id));
    });

    expect({
      refused,
      audited: outcomesOf(events, ["workflow.start.refused"]),
    }).toStrictEqual({
      refused: "workflow.packages_revoked",
      audited: [
        {
          action: "workflow.start.refused",
          reason: "workflow.packages_revoked",
          failureCode: null,
        },
      ],
    });
  });

  it("refuses a start whose graph is revoked as it is admitted", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    await publishedWith(builder, workflow, pkg, request.graphHash);
    let raced = false;
    // The start's first batch is the one that admits it: revoked just before.
    const db = racingDb(async () => {
      if (!raced) {
        raced = true;
        await end(admin, request, "revoked");
      }
    });

    const refused = await outcome(
      startWorkflow(
        { ...env, DB: db },
        { type: "person", person: builder },
        workflow.id,
        { version: 1, input: { who: "Ada" }, key: unique() }
      )
    );
    const { results } = await env.DB.prepare(
      "SELECT id FROM workflow_resource_runs WHERE workflow_resource_id = ?"
    )
      .bind(workflow.id)
      .all();

    expect({ raced, refused, runs: results.length }).toStrictEqual({
      raced: true,
      refused: "workflow.packages_revoked",
      runs: 0,
    });
  });

  it("fails a run in flight at its next compute call once the graph is revoked, audited", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    // It waits a few seconds before its calculation: revoked meanwhile.
    await publishedWith(builder, workflow, pkg, request.graphHash, "PT3S");
    const runId = await started(builder, workflow.id);

    let run: Awaited<ReturnType<typeof ended>> | undefined;
    const events = await auditedDuring(async () => {
      await end(admin, request, "revoked");
      run = await ended(builder, workflow.id, runId);
    });

    expect({
      run,
      audited: outcomesOf(events, [
        "dependency.admission_refused",
        "workflow.run.failed",
      ]),
    }).toStrictEqual({
      run: { status: "failed", code: "workflow.packages_revoked" },
      audited: [
        {
          action: "dependency.admission_refused",
          reason: "revoked",
          failureCode: null,
        },
        {
          action: "workflow.run.failed",
          reason: null,
          failureCode: "workflow.packages_revoked",
        },
      ],
    });
  });

  it("refuses to run a version whose sealed package bytes were changed", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    await publishedWith(builder, workflow, pkg, request.graphHash);
    const row = await env.DB.prepare(
      "SELECT manifest FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
    )
      .bind(workflow.id)
      .first<{ manifest: string }>();
    const { artifacts } = z
      .object({
        build: z.object({
          artifacts: z.array(
            z.object({ path: z.string(), sha256: z.string() })
          ),
        }),
      })
      .parse(JSON.parse(row?.manifest ?? "{}")).build;
    const sealed = artifacts.find(
      ({ path }) => path === `compute/${packageModuleName(pkg)}`
    );
    await env.FILES.put(
      artifactKey(sealed?.sha256 ?? ""),
      "export const double = (value) => value * 3;"
    );

    expect({
      sealed: sealed !== undefined,
      run: await ended(
        builder,
        workflow.id,
        await started(builder, workflow.id)
      ),
    }).toStrictEqual({
      sealed: true,
      run: { status: "failed", code: "workflow.version_corrupt" },
    });
  });

  it("takes the same modules sealing another graph for another publication", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    await publishedWith(builder, workflow, pkg, request.graphHash);
    // Another graph of the same entry: its next version, resolved anew once
    // the first is revoked.
    await end(admin, request, "revoked");
    await publishDoubling(pkg, "1.0.1");
    const { request: next } = await resolveDependencies(env, builder, {
      workflow: workflow.id,
      sourceRevision: "rev-2",
      purpose: "Double the quarter's total.",
      targets: ["computation"],
      dependencies: { [pkg]: "^1.0.0" },
    });
    await approve(admin, next);

    expect({
      otherGraph: next.graphHash !== request.graphHash,
      republished: await outcome(
        publishedWith(builder, workflow, pkg, next.graphHash)
      ),
    }).toStrictEqual({
      otherGraph: true,
      republished: "workflow.version_exists",
    });
  });
});
