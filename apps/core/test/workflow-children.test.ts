/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { appFor } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { loadWorkflowBuild } from "../src/workflow-builds.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import type { RunStep } from "../src/workflows/host.ts";
import { ResourceRunHost } from "../src/workflows/resource-host.ts";
import {
  resourceRunFor,
  terminateResourceRun,
} from "../src/workflows/resource-runs.ts";
import { withQuotas } from "./quota-policies.ts";
import { admittedFreely, liveStatus, resumed, stopped } from "./runs.ts";
import { unique } from "./sign-in.ts";

// Child runs of JSON workflows (`run` tasks: run-children.ts,
// resource-host.ts, workflow-starts.ts), from their threat model: a child
// runs the exact version its parent's start froze, with its own approvals
// and nothing of its parent's, only on the parent workflow's own grant to
// start it; it joins its parent's lineage, held to its levels and
// descendants; a parent that restarts or retries starts it once; a child
// that fails fails its parent; and a parent that ends stops its children.

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

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A definition of `name` at `version`, `{ who }` in, `{ greeting }` out. */
const definitionOf = (
  name: string,
  tasks: unknown[],
  {
    version = "1.0.0",
    bindings = {},
  }: { version?: string; bindings?: Record<string, unknown> } = {}
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version,
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ greeting: { type: "string" } }) },
    do: tasks,
  });

/** A task running `child`'s 1.0.0 through binding `child`, on our `who`. */
const runChild = (id: string, child: string) => ({
  [id]: {
    run: {
      workflow: {
        namespace: workflowNamespace,
        name: child,
        version: "1.0.0",
        input: { who: "${ $workflow.input.who }" },
      },
    },
    metadata: { grasp: { binding: "child" } },
  },
});

/** The binding of `child`'s 1.0.0, as a parent declares it. */
const childBinding = (child: string) => ({
  child: { kind: "workflow", contract: `${workflowNamespace}/${child}/1.0.0` },
});

/** A workflow of `by`'s, its versions published from `definitions`, in turn. */
const workflowOf = async (
  by: Identity,
  prefix: string,
  definitions: ((name: string) => string)[]
) => {
  const workflow = await createWorkflowResource(
    env,
    by,
    `${prefix}-${unique()}`
  );
  for (const [index, definition] of definitions.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- versions in order
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: definition(workflow.name),
      basedOn: index === 0 ? null : index,
    });
  }
  return workflow;
};

/** A child greeting `who` with `word`, at 1.0.0 (and later at 2.0.0 if `then`). */
const greeter = async (by: Identity, word = "Hello", then?: string) =>
  await workflowOf(by, "child", [
    (name) =>
      definitionOf(name, [
        { greet: { set: { greeting: `\${ "${word}, " + .who }` } } },
      ]),
    ...(then === undefined
      ? []
      : [
          (name: string) =>
            definitionOf(
              name,
              [{ greet: { set: { greeting: `\${ "${then}, " + .who }` } } }],
              { version: "2.0.0" }
            ),
        ]),
  ]);

const rolesOf = (by: Identity) => ({
  app: async (named: string, role: "user" | "builder") =>
    await appFor(env, by, named, role),
  resource: async (
    ref: Parameters<typeof requireResourceRole>[2],
    needed: Parameters<typeof requireResourceRole>[3]
  ) => {
    await requireResourceRole(env, by, ref, needed);
  },
});

/** The parent workflow's own grant to start `child`: its permission's ID. */
const grantStart = async (
  admin: Identity,
  parent: string,
  child: string
): Promise<string> => {
  const request: PermissionRequest = {
    subject: { type: "workflow", workflowId: parent },
    object: { type: "workflow", workflowId: child },
    actions: ["start"],
    binding: "CHILD",
  };
  const asked = await requestPermission(env, admin, request, rolesOf(admin));
  await grantPermission(env, admin, asked.id, { version: null });
  return asked.id;
};

/** A parent of `admin`'s running `child` in its tasks, granted to start it. */
const parentOf = async (
  admin: Identity,
  child: { id: string; name: string },
  tasks: unknown[]
) => {
  const parent = await createWorkflowResource(env, admin, `parent-${unique()}`);
  const permission = await grantStart(admin, parent.id, child.id);
  await publishWorkflowVersion(env, admin, parent.id, {
    definition: definitionOf(parent.name, tasks, {
      bindings: childBinding(child.name),
    }),
    basedOn: null,
  });
  return { parent, permission };
};

/** Starts version 1 of `workflowId` for `by`: its run's ID. */
const started = async (by: Identity, workflowId: string): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    workflowId,
    { version: 1, input: { who: "Ada" }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  return runId;
};

/** Run `runId` of `workflowId` once it ended, as `by` reads it. */
const endOf = async (
  by: Identity,
  workflowId: string,
  runId: string
): Promise<WorkflowResourceRun> =>
  await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, workflowId, runId);
      expect(run.endedAt).not.toBeNull();
      return run;
    },
    { timeout: 60_000, interval: 200 }
  );

/** The runs `parentId` started, as core keeps them. */
const childrenOf = async (parentId: string) => {
  const rows = await env.DB.prepare(
    "SELECT r.id, r.workflow_resource_id AS workflow, r.version, r.principal_id AS principal, r.root_run_id AS root, r.depth, r.status, r.restricted, s.invoker_type AS invokerType, s.invoker_id AS invoker, s.bindings FROM workflow_resource_runs AS r JOIN workflow_start_receipts AS s ON s.id = r.id WHERE r.parent_run_id = ? ORDER BY r.created_at"
  )
    .bind(parentId)
    .all<{
      id: string;
      workflow: string;
      version: number;
      principal: string;
      root: string;
      depth: number;
      status: string;
      restricted: number;
      invokerType: string;
      invoker: string;
      bindings: string;
    }>();
  return rows.results;
};

const endStateOf = (run: WorkflowResourceRun) => ({
  status: run.status,
  ...(run.status === "completed"
    ? { output: run.output }
    : { code: run.error?.code }),
});

describe("run tasks", { timeout: 180_000 }, () => {
  it("start the exact version their binding pins, as a child in the parent's lineage, and take its output", async () => {
    const admin = await person("admin");
    // Version 2 says something else: the parent's binding pins 1.0.0.
    const child = await greeter(admin, "Hello", "Goodbye");
    const { parent } = await parentOf(admin, child, [
      runChild("greet-child", child.name),
    ]);

    const runId = await started(admin, parent.id);
    const run = await endOf(admin, parent.id, runId);
    const [started_] = await childrenOf(runId);

    expect(endStateOf(run)).toStrictEqual({
      status: "completed",
      output: { greeting: "Hello, Ada" },
    });
    expect({
      workflow: started_?.workflow,
      version: started_?.version,
      principal: started_?.principal,
      root: started_?.root,
      depth: started_?.depth,
      status: started_?.status,
      invokerType: started_?.invokerType,
      invoker: started_?.invoker,
      bindings: started_?.bindings,
    }).toStrictEqual({
      workflow: child.id,
      version: 1,
      principal: admin.userId,
      root: runId,
      depth: 1,
      status: "completed",
      invokerType: "workflow",
      invoker: runId,
      // Its own start's: the parent's binding of it isn't the child's.
      bindings: "[]",
    });
  });

  it("start nothing once the parent workflow's own grant to start the child is revoked", async () => {
    const admin = await person("admin");
    const child = await greeter(admin);
    const { parent, permission } = await parentOf(admin, child, [
      { pause: { wait: "PT2S" } },
      runChild("greet-child", child.name),
    ]);

    const runId = await started(admin, parent.id);
    await vi.waitFor(
      async () => {
        await expect(liveStatus(runId)).resolves.toBe("waiting");
      },
      { timeout: 30_000, interval: 100 }
    );
    await revokePermission(env, admin, permission);
    const run = await endOf(admin, parent.id, runId);

    expect({
      end: endStateOf(run),
      children: await childrenOf(runId),
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.start_denied" },
      children: [],
    });
  });

  it("give the child nothing of the parent's: its own binding needs its own approval, however the parent's stands", async () => {
    const admin = await person("admin");
    const contract = `models-${unique()}`;
    await publishCatalogContract(env, admin, { key: contract, kind: "model" });
    // A child declaring a model binding no admin approved for it.
    const child = await workflowOf(admin, "child", [
      (name) =>
        definitionOf(
          name,
          [
            {
              ask: {
                call: "grasp.model",
                with: {
                  binding: "summary",
                  instructions: "Greet them.",
                  input: { who: "${ .who }" },
                  outputSchema: objectSchema({ greeting: { type: "string" } }),
                },
              },
            },
          ],
          { bindings: { summary: { kind: "model", contract } } }
        ),
    ]);
    const { parent } = await parentOf(admin, child, [
      runChild("greet-child", child.name),
    ]);

    const runId = await started(admin, parent.id);
    const run = await endOf(admin, parent.id, runId);

    expect({
      end: endStateOf(run),
      children: await childrenOf(runId),
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.binding_unapproved" },
      children: [],
    });
  });

  it("stop a running child's work once the parent workflow's grant to start it is revoked", async () => {
    const admin = await person("admin");
    const contract = `job-events-${unique()}`;
    await publishCatalogContract(env, admin, {
      key: contract,
      kind: "event",
      events: {
        "grasp.job.completed": {
          data: JSON.stringify(v.object({ greeting: v.string() }).descriptor),
          browser: false,
        },
      },
    });
    // A child that waits, then listens through an approved binding of its
    // own: the listen asks that the authority behind the child still holds.
    const child = await workflowOf(admin, "child", [
      (name) =>
        definitionOf(
          name,
          [
            { linger: { wait: "PT3S" } },
            {
              "await-job": {
                listen: {
                  to: { one: { with: { type: "grasp.job.completed" } } },
                },
                timeout: { after: { minutes: 5 } },
                metadata: { grasp: { binding: "jobEvents" } },
                output: { as: "${ .[0] }" },
              },
            },
          ],
          { bindings: { jobEvents: { kind: "event", contract } } }
        ),
    ]);
    await approveWorkflowBinding(env, admin, child.id, {
      alias: "jobEvents",
      target: { kind: "event" },
      reviewed: { version: 1 },
    });
    const { parent, permission } = await parentOf(admin, child, [
      runChild("greet-child", child.name),
    ]);

    const runId = await started(admin, parent.id);
    await vi.waitFor(
      async () => {
        const [running] = await childrenOf(runId);
        await expect(liveStatus(running?.id ?? "")).resolves.toBe("waiting");
      },
      { timeout: 30_000, interval: 100 }
    );
    await revokePermission(env, admin, permission);
    const run = await endOf(admin, parent.id, runId);
    const [denied] = await childrenOf(runId);
    const childRun = await endOf(admin, child.id, denied?.id ?? "");

    expect({
      parent: endStateOf(run),
      child: endStateOf(childRun),
    }).toStrictEqual({
      parent: { status: "failed", code: "workflow.child_failed" },
      child: { status: "failed", code: "workflow.event_denied" },
    });
  });

  it("fail their run when the child fails, naming why", async () => {
    const admin = await person("admin");
    // Its output isn't its contract's: the child fails.
    const child = await workflowOf(admin, "child", [
      (name) => definitionOf(name, [{ greet: { set: { wrong: "shape" } } }]),
    ]);
    const { parent } = await parentOf(admin, child, [
      runChild("greet-child", child.name),
    ]);

    const runId = await started(admin, parent.id);
    const run = await endOf(admin, parent.id, runId);
    const [failed] = await childrenOf(runId);

    expect({
      end: endStateOf(run),
      child: failed?.status,
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.child_failed" },
      child: "failed",
    });
  });

  it("stop at the lineage's levels and descendant runs, whatever the workflows bind", async () => {
    const admin = await person("admin");
    const leaf = await greeter(admin);
    const { parent: middle } = await parentOf(admin, leaf, [
      runChild("greet-leaf", leaf.name),
    ]);
    const { parent: top } = await parentOf(admin, middle, [
      runChild("greet-middle", middle.name),
    ]);
    const { parent: twice } = await parentOf(admin, leaf, [
      runChild("first", leaf.name),
      runChild("second", leaf.name),
    ]);

    // Two levels: a child, never a grandchild.
    const deep = await withQuotas({ workflowNestingLevels: 2 }, async () => {
      const deepRun = await started(admin, top.id);
      return endStateOf(await endOf(admin, top.id, deepRun));
    });
    // One descendant run: a first child, never a second.
    const wide = await withQuotas({ workflowDescendantRuns: 1 }, async () => {
      const wideRun = await started(admin, twice.id);
      return endStateOf(await endOf(admin, twice.id, wideRun));
    });

    expect({ deep, wide }).toStrictEqual({
      deep: { status: "failed", code: "workflow.child_failed" },
      wide: { status: "failed", code: "workflow.lineage_limit" },
    });
  });

  it("start their child once, however often the parent stops and resumes while it runs", async () => {
    const admin = await person("admin");
    const child = await workflowOf(admin, "child", [
      (name) =>
        definitionOf(name, [
          { linger: { wait: "PT3S" } },
          { greet: { set: { greeting: '${ "Hello, " + .who }' } } },
        ]),
    ]);
    const { parent } = await parentOf(admin, child, [
      runChild("greet-child", child.name),
    ]);

    const runId = await started(admin, parent.id);
    await vi.waitFor(
      async () => {
        await expect(childrenOf(runId)).resolves.toHaveLength(1);
        await expect(liveStatus(runId)).resolves.toBe("waiting");
      },
      { timeout: 30_000, interval: 100 }
    );
    await stopped(runId);
    await resumed(runId);
    const run = await endOf(admin, parent.id, runId);

    const children = await childrenOf(runId);
    expect({
      end: endStateOf(run),
      children: children.map(({ status }) => status),
    }).toStrictEqual({
      end: { status: "completed", output: { greeting: "Hello, Ada" } },
      children: ["completed"],
    });
  });

  it("stop their child when the parent ends first", async () => {
    const admin = await person("admin");
    const child = await workflowOf(admin, "child", [
      (name) =>
        definitionOf(name, [
          { linger: { wait: "PT1H" } },
          { greet: { set: { greeting: "late" } } },
        ]),
    ]);
    const { parent } = await parentOf(admin, child, [
      runChild("greet-child", child.name),
    ]);

    const runId = await started(admin, parent.id);
    await vi.waitFor(
      async () => {
        const [running] = await childrenOf(runId);
        expect(running?.status).toBe("running");
        await expect(liveStatus(running?.id ?? "")).resolves.toBe("waiting");
      },
      { timeout: 30_000, interval: 100 }
    );
    await terminateResourceRun(env, admin, parent.id, runId);

    await vi.waitFor(
      async () => {
        const [stoppedChild] = await childrenOf(runId);
        expect(stoppedChild?.status).toBe("cancelled");
      },
      { timeout: 30_000, interval: 200 }
    );
  });
});

/** A host of a run of `workflowId`'s version 1, its children `asked`. */
const hostOf = async (
  by: Identity,
  workflowId: string,
  asked: unknown[]
): Promise<ResourceRunHost> => {
  const build = await loadWorkflowBuild(env, workflowId, 1);
  let count = 0;
  const step: RunStep = {
    do: async (name, _config, fn) => {
      count += 1;
      return await fn({ attempt: 1, idempotencyKey: `key:${name}:${count}` });
    },
    sleep: async () => {
      await Promise.resolve();
    },
    sleepUntil: async () => {
      await Promise.resolve();
    },
    waitForEvent: async () => await Promise.reject(new Error("No waits here")),
    // The child's end, as its event journaled it.
    waitForMatch: async () =>
      await Promise.resolve({
        payload: { status: "completed", output: { greeting: "Hello, Ada" } },
        timestamp: new Date(),
      }),
  };
  const runId = crypto.randomUUID();
  return new ResourceRunHost(
    env,
    step,
    {
      runId,
      workflowId,
      version: 1,
      principal: by.userId,
      input: { who: "Ada" },
      params: {},
      createdAt: Date.now(),
      build,
      calling: {
        runId,
        workflowId,
        version: 1,
        principal: by.userId,
        invoker: { type: "person", id: by.userId, appVersion: null },
        bindings: new Map(),
        restricted: false,
      },
      maxModelCalls: 1,
    },
    {
      leaseOf: () => ({ generation: 1, deadline: Date.now() + 60_000 }),
      tampered: () => {},
      admitAttempt: admittedFreely,
      children: {
        start: async (_parent, alias, taskId, input) => {
          asked.push({ alias, taskId, input });
          return await Promise.resolve("child-run");
        },
        remind: async () => {
          await Promise.resolve();
        },
      },
    }
  );
};

const data = { input: { input: { who: "Ada" }, context: {} } };

describe("a run task's host", { timeout: 60_000 }, () => {
  it("starts only the child its build sealed, on what the host builds, and waits only once its enter step started it", async () => {
    const admin = await person("admin");
    const child = await greeter(admin);
    const { parent } = await parentOf(admin, child, [
      runChild("greet-child", child.name),
    ]);
    const asked: unknown[] = [];
    const early = await hostOf(admin, parent.id, asked);
    const tooEarly = await early.child("task:greet-child");
    const host = await hostOf(admin, parent.id, asked);
    await host.do("enter:greet-child", data, async (attempt) => {
      // What the isolate passes is its transformed input, nothing more.
      const until = await attempt.until({ input: { who: "Ada" } });
      return until.ok
        ? { ok: true, value: { output: { who: "Ada" }, until: until.value } }
        : until;
    });
    const output = await host.child("task:greet-child");

    expect({
      tooEarly: tooEarly.ok ? "ok" : tooEarly.error.code,
      output: output.ok ? output.value : output.error.code,
      asked,
    }).toStrictEqual({
      tooEarly: "workflow.invalid",
      output: { greeting: "Hello, Ada" },
      asked: [{ alias: "child", taskId: "greet-child", input: { who: "Ada" } }],
    });
  });
});
