import { packageModuleName } from "@grasp-os/compiler";
import type { DependencyRequest } from "@grasp-os/shared/dependencies";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { decideDependency } from "../src/packages/requests.ts";
import { resolveDependencies } from "../src/packages/resolve.ts";
import { loadWorkflowBuild } from "../src/workflow-builds.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { sealPackages } from "../src/workflows/sealed-packages.ts";
import { endLiveResourceRuns, objectSchema } from "./json-workflow-apps.ts";
import { publish, reportToOsv, rescannedUntil } from "./npm.ts";
import { person } from "./sealed-apps.ts";
import { auditedDuring, outcome, unique } from "./sign-in.ts";

// Approved npm packages a version of an independent workflow seals for
// its compute modules: modules import only the entries their version
// seals, from an approval of this workflow's; the package's code is the
// version's own; and a graph the clock revokes as malware refuses new
// starts and fails a run in flight at its next call.

/** A definition that calls `total` on [1, 2, 3], after `linger` if given. */
const definitionOf = (linger?: string): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status: { $expr: '"" + add' } },
    permissions: {
      modules: {
        total: { kind: "compute", contract: "local:code/total.ts#total" },
      },
    },
    steps: [
      ...(linger === undefined
        ? []
        : [{ id: "linger", type: "wait", for: linger }]),
      { id: "add", type: "call", module: "total", args: [1, 2, 3] },
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

/** A package exporting `double`, published to the test registry. */
const doubling = async (): Promise<string> => {
  const name = `double-${unique()}`;
  await publish({
    name,
    version: "1.0.0",
    manifest: { type: "module", main: "index.js", license: "MIT" },
    files: { "index.js": "export const double = (value) => value * 2;" },
  });
  return name;
};

/** A workflow of a new builder's, `pkg` asked for and, with `approved`, approved by them. */
const workflowWith = async (pkg: string, approved = true) => {
  const builder = await person("builder");
  const workflow = await createWorkflowResource(env, builder, `p-${unique()}`);
  const request = await resolveDependencies(env, builder, {
    workflow: workflow.id,
    purpose: "Double the quarter's total.",
    dependencies: [{ name: pkg, range: "^1.0.0" }],
  });
  if (approved) {
    await decideDependency(env, builder, request.id, {
      approved: true,
      graphHash: request.graphHash,
    });
  }
  return { builder, workflow, request };
};

/** Publishes `workflow` with `pkg` imported, sealing `graphHash`. */
const publishedWith = async (
  builder: Acting,
  workflow: { id: string },
  pkg: string,
  packages: { graphHash: string } | undefined,
  linger?: string
) =>
  await publishWorkflowVersion(
    env,
    builder,
    workflow.id,
    {
      definition: definitionOf(linger),
      basedOn: null,
      modules: { "code/total.ts": moduleUsing(pkg) },
      ...(packages === undefined ? {} : { packages }),
    },
    sealPackages
  );

/** Starts version 1 of `id` for `by`: its run's ID. */
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

/** `pkg` reported as malware, and `request`'s approval revoked by the clock's rescan. */
const revoked = async (pkg: string, request: DependencyRequest) => {
  await reportToOsv(
    pkg,
    "1.0.0",
    `MAL-2026-${Math.floor(Math.random() * 1e9)}`
  );
  await rescannedUntil(request.id, new Date());
};

describe("a workflow's modules importing approved packages", () => {
  // A run still asleep would go on in the engine after its test.
  afterEach(endLiveResourceRuns);

  it("seals the approved package into the version and runs it", async () => {
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);

    const version = await publishedWith(builder, workflow, pkg, {
      graphHash: request.graphHash,
    });
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

  it("imports no package its version doesn't seal from an approval of its own", async () => {
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg, false);
    const other = await workflowWith(pkg);
    const refusedFor = async (packages?: { graphHash: string }) =>
      await outcome(publishedWith(builder, workflow, pkg, packages));

    const unapproved = await refusedFor({ graphHash: request.graphHash });
    await decideDependency(env, builder, request.id, {
      approved: true,
      graphHash: request.graphHash,
    });

    expect({
      unapproved,
      unsealed: await refusedFor(),
      madeUp: await refusedFor({ graphHash: "f".repeat(64) }),
      // The same graph, approved for another workflow, isn't this one's.
      othersApproval: await outcome(
        publishedWith(
          other.builder,
          await createWorkflowResource(env, other.builder, `p-${unique()}`),
          pkg,
          { graphHash: other.request.graphHash }
        )
      ),
      staff: await outcome(
        publishedWith({ ...builder, staff: true }, workflow, pkg, {
          graphHash: request.graphHash,
        })
      ),
    }).toStrictEqual({
      unapproved: "dependency.approval_required",
      unsealed: "workflow.modules_invalid",
      madeUp: "dependency.approval_required",
      othersApproval: "dependency.approval_required",
      staff: "role.forbidden",
    });
  });

  it("refuses a new start once the graph is revoked as malware, audited", async () => {
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await publishedWith(builder, workflow, pkg, {
      graphHash: request.graphHash,
    });
    await revoked(pkg, request);

    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await outcome(started(builder, workflow.id));
    });

    expect({
      refused,
      audited: events
        .filter(({ action }) => action === "workflow.start.refused")
        .map(({ detail }) => detail.reason),
    }).toStrictEqual({
      refused: "workflow.packages_revoked",
      audited: ["workflow.packages_revoked"],
    });
  });

  it("fails a run in flight at its next compute call once the graph is revoked", async () => {
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    // It waits a few seconds before its calculation: revoked meanwhile.
    await publishedWith(
      builder,
      workflow,
      pkg,
      { graphHash: request.graphHash },
      "3 seconds"
    );
    const runId = await started(builder, workflow.id);
    await revoked(pkg, request);

    await expect(ended(builder, workflow.id, runId)).resolves.toStrictEqual({
      status: "failed",
      code: "workflow.packages_revoked",
    });
  });
});
