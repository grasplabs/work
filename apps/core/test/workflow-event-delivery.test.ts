/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import {
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import {
  createTriggerResource,
  setTriggerEnabled,
} from "../src/trigger-resources.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { drainEmittedEvents } from "../src/workflows/event-delivery.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { sweepWorkflowStartDetails } from "../src/workflows/retention.ts";
import { allEvents } from "./audit-events.ts";
import { outcome, unique } from "./sign-in.ts";

// Delivering the events JSON workflows emit to the system triggers that
// take them (workflows/event-delivery.ts), from its threat model: each
// matching trigger's run starts once, however often the event is
// delivered; only triggers of the event's contract and type, enabled and
// granted, take it, each refusal audited; the run joins the emitting
// run's lineage; an event past its retention is never delivered, and its
// expiry is audited; and an event that keeps failing is settled
// undeliverable, audited, never dropped.

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

const timedOut = "grasp.job.timeout";

/** A definition of workflow `name`: `{ jobId }` in and out, doing `tasks`. */
const definitionOf = (
  name: string,
  tasks: unknown[],
  bindings: Record<string, unknown> = {}
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings },
      },
    },
    input: { schema: objectSchema({ jobId: { type: "string" } }) },
    output: { schema: objectSchema({ jobId: { type: "string" } }) },
    do: tasks,
  });

/** An event contract of `admin`'s with the job timeout type: its key. */
const jobEvents = async (admin: Identity): Promise<string> => {
  const contract = `job-events-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: contract,
    kind: "event",
    events: {
      [timedOut]: {
        data: JSON.stringify(v.object({ jobId: v.string() }).descriptor),
        browser: false,
      },
    },
  });
  return contract;
};

/** A workflow of `admin`'s emitting a timeout of its job through `contract`. */
const emitting = async (admin: Identity, contract: string) => {
  const workflow = await createWorkflowResource(env, admin, `emit-${unique()}`);
  await publishWorkflowVersion(env, admin, workflow.id, {
    definition: definitionOf(
      workflow.name,
      [
        {
          "publish-timeout": {
            emit: {
              event: {
                with: {
                  type: timedOut,
                  subject: "${ $workflow.input.jobId }",
                  data: { jobId: "${ $workflow.input.jobId }" },
                },
              },
            },
            metadata: { grasp: { binding: "jobEvents" } },
          },
        },
      ],
      { jobEvents: { kind: "event", contract } }
    ),
    basedOn: null,
  });
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "jobEvents",
    target: { kind: "event" },
    reviewed: { version: 1 },
  });
  return workflow;
};

/** A workflow of `admin`'s that takes a job and hands it back. */
const consuming = async (admin: Identity) => {
  const workflow = await createWorkflowResource(env, admin, `take-${unique()}`);
  await publishWorkflowVersion(env, admin, workflow.id, {
    definition: definitionOf(workflow.name, [
      { finish: { set: { jobId: "${ $workflow.input.jobId }" } } },
    ]),
    basedOn: null,
  });
  return workflow;
};

/** `start` on workflow `id` for trigger `trigger`, asked and granted by `admin`. */
const grantStart = async (admin: Identity, trigger: string, id: string) => {
  const request: PermissionRequest = {
    subject: { type: "trigger", triggerId: triggerIdSchema.parse(trigger) },
    object: {
      type: "workflow",
      workflowId: workflowResourceIdSchema.parse(id),
    },
    actions: ["start"],
    binding: `START_${unique().toUpperCase().replaceAll("-", "_")}`,
  };
  const { id: permission } = await requestPermission(env, admin, request, {
    app: () => {
      throw new Error("No App here");
    },
    resource: async (ref, needed) => {
      await requireResourceRole(env, admin, ref, needed);
    },
  });
  await grantPermission(env, admin, permission, { version: null });
};

/**
 * A system trigger of `admin`'s starting workflow `id` on `type` events
 * of `contract`, granted its start unless `granted` is false.
 */
const systemTrigger = async (
  admin: Identity,
  id: string,
  contract: string,
  { type = timedOut, granted = true } = {}
) => {
  const trigger = await createTriggerResource(env, admin, {
    kind: "system",
    workflowId: id,
    version: 1,
    config: { event: { contract, type } },
  });
  if (granted) {
    await grantStart(admin, trigger.id, id);
  }
  return trigger;
};

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
    { timeout: 30_000, interval: 100 }
  );

/** Run `admin`'s of workflow `id` for job `jobId`, once it has ended: its ID. */
const emitted = async (admin: Identity, id: string, jobId = "job-1") => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: admin },
    id,
    { version: 1, input: { jobId }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  await endOf(admin, id, runId);
  return runId;
};

/** The event run `runId` emitted, as the outbox keeps it. */
const eventOf = async (runId: string) =>
  await env.DB.prepare(
    "SELECT id, delivered_at AS delivered, undeliverable, delivery_attempts AS attempts FROM workflow_emitted_events WHERE run_id = ?"
  )
    .bind(runId)
    .first<{
      id: string;
      delivered: number | null;
      undeliverable: string | null;
      attempts: number;
    }>();

/** The runs trigger `trigger` started, with where each sits in a lineage. */
const runsOf = async (trigger: string) => {
  const rows = await env.DB.prepare(
    "SELECT run.id, run.parent_run_id AS parent, run.root_run_id AS root, run.depth, run.restricted FROM workflow_resource_runs AS run JOIN workflow_start_receipts AS receipt ON receipt.id = run.id WHERE receipt.invoker_type = 'trigger' AND receipt.invoker_id = ?"
  )
    .bind(trigger)
    .all<{
      id: string;
      parent: string | null;
      root: string | null;
      depth: number;
      restricted: number;
    }>();
  return rows.results;
};

/**
 * `env` whose database refuses, once, any statement `matches` finds:
 * a drain that dies there, or loses the answer.
 */
const failingOnce = (matches: RegExp): Env => {
  let failed = false;
  const db = new Proxy(env.DB, {
    get: (target, property): unknown => {
      const value: unknown = Reflect.get(target, property);
      if (property === "prepare") {
        return (query: string): unknown => {
          if (!failed && matches.test(query)) {
            failed = true;
            throw new Error("The database went away");
          }
          return target.prepare(query);
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  return { ...env, DB: db };
};

/** Makes event `id` due again now, as once its backoff or lease ran out. */
const dueAgain = async (id: string) => {
  await env.DB.prepare(
    "UPDATE workflow_emitted_events SET delivery_at = 0 WHERE id = ?"
  )
    .bind(id)
    .run();
};

describe("emitted events", { timeout: 120_000 }, () => {
  it("start each matching trigger's run once, in the emitting run's lineage, however often they are delivered", async () => {
    const admin = await person("admin");
    const contract = await jobEvents(admin);
    const source = await emitting(admin, contract);
    const target = await consuming(admin);
    const first = await systemTrigger(admin, target.id, contract);
    const second = await systemTrigger(admin, target.id, contract);

    const runId = await emitted(admin, source.id);
    const event = await eventOf(runId);
    // Its acknowledgement lost: the runs started, the event not settled.
    await drainEmittedEvents(
      failingOnce(/^update "workflow_emitted_events" set "delivered_at"/iu)
    );
    const lost = await eventOf(runId);
    await dueAgain(event?.id ?? "");
    // Two drains at once, then one more.
    await Promise.all([drainEmittedEvents(env), drainEmittedEvents(env)]);
    await drainEmittedEvents(env);
    const ofFirst = await runsOf(first.id);
    const ofSecond = await runsOf(second.id);
    const started = [...ofFirst, ...ofSecond];
    const ends = await Promise.all(
      started.map(async ({ id }) => {
        const run = await endOf(admin, target.id, id);
        return run.output;
      })
    );
    const settled = await eventOf(runId);

    expect({
      lost: { delivered: lost?.delivered, attempts: lost?.attempts },
      delivered: settled?.delivered !== null,
      runs: started.map(({ parent, root, depth, restricted }) => ({
        parent,
        root,
        depth,
        restricted,
      })),
      ends,
    }).toStrictEqual({
      lost: { delivered: null, attempts: 1 },
      delivered: true,
      runs: Array.from({ length: 2 }, () => ({
        parent: null,
        root: runId,
        depth: 1,
        restricted: 0,
      })),
      ends: [{ jobId: "job-1" }, { jobId: "job-1" }],
    });
  });

  it("reach only enabled triggers of their contract and type, each refusal audited", async () => {
    const admin = await person("admin");
    const contract = await jobEvents(admin);
    const other = await jobEvents(admin);
    const source = await emitting(admin, contract);
    const target = await consuming(admin);
    const otherType = await systemTrigger(admin, target.id, contract, {
      type: "grasp.job.done",
    });
    const otherContract = await systemTrigger(admin, target.id, other);
    const disabled = await systemTrigger(admin, target.id, contract);
    await setTriggerEnabled(env, admin, disabled.id, false);
    const ungranted = await systemTrigger(admin, target.id, contract, {
      granted: false,
    });

    const runId = await emitted(admin, source.id);
    await drainEmittedEvents(env);
    const event = await eventOf(runId);
    const logged = await allEvents();
    const refusals = logged.filter(
      (entry) =>
        entry.action === "workflow.event.refused" &&
        entry.detail.event === event?.id
    );

    expect({
      runs: await Promise.all(
        [otherType, otherContract, disabled, ungranted].map(async ({ id }) => {
          const runs = await runsOf(id);
          return runs.length;
        })
      ),
      delivered: event?.delivered !== null,
      undeliverable: event?.undeliverable,
      refusals: refusals.map(({ detail }) => detail),
    }).toStrictEqual({
      runs: [0, 0, 0, 0],
      delivered: true,
      undeliverable: null,
      refusals: [
        {
          event: event?.id,
          type: timedOut,
          trigger: ungranted.id,
          code: "workflow.start_denied",
        },
      ],
    });
  });

  it("are never delivered past their retention, which audits each closed undelivered", async () => {
    const admin = await person("admin");
    const contract = await jobEvents(admin);
    const source = await emitting(admin, contract);
    const target = await consuming(admin);
    const trigger = await systemTrigger(admin, target.id, contract);

    const runId = await emitted(admin, source.id);
    const later = new Date(Date.now() + 1000);
    await sweepWorkflowStartDetails(env, later, later);
    await sweepWorkflowStartDetails(env, later, later);
    await drainEmittedEvents(env);
    const event = await eventOf(runId);
    const logged = await allEvents();
    const expired = logged.filter(
      (entry) =>
        entry.action === "workflow.event.expired" &&
        entry.detail.event === event?.id
    );

    const triggered = await runsOf(trigger.id);
    expect({
      runs: triggered.length,
      expired: expired.map(({ target: run, detail }) => ({ run, detail })),
    }).toStrictEqual({
      runs: 0,
      expired: [
        {
          run: { type: "workflow_run", id: runId },
          detail: { event: event?.id, type: timedOut, delivered: false },
        },
      ],
    });
  });

  it("are settled undeliverable, audited, once their deliveries keep failing", async () => {
    const admin = await person("admin");
    const contract = await jobEvents(admin);
    const source = await emitting(admin, contract);
    const target = await consuming(admin);
    const trigger = await systemTrigger(admin, target.id, contract);

    const runId = await emitted(admin, source.id);
    const failing = failingOnce(/from "trigger_resources"/iu);
    await drainEmittedEvents(failing, { maxAttempts: 1 });
    const event = await eventOf(runId);
    await dueAgain(event?.id ?? "");
    const again = await outcome(drainEmittedEvents(env));
    const logged = await allEvents();
    const audited = logged.filter(
      (entry) =>
        entry.action === "workflow.event.undeliverable" &&
        entry.detail.event === event?.id
    );

    const triggered = await runsOf(trigger.id);
    expect({
      event: {
        delivered: event?.delivered !== null,
        undeliverable: event?.undeliverable,
        attempts: event?.attempts,
      },
      again,
      runs: triggered.length,
      audited: audited.map(({ detail }) => detail),
    }).toStrictEqual({
      event: {
        delivered: true,
        undeliverable: "internal.unexpected",
        attempts: 1,
      },
      again: "ok",
      runs: 0,
      audited: [
        {
          event: event?.id,
          type: timedOut,
          attempts: 1,
          code: "internal.unexpected",
        },
      ],
    });
  });
});
