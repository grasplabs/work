/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { executionErrors } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { emitEvent } from "../src/workflows/emitted-events.ts";
import { callingRunOf } from "../src/workflows/resource-authority.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { sweepWorkflowStartDetails } from "../src/workflows/retention.ts";
import { allEvents } from "./audit-events.ts";
import { liveStatus, resumed, stopped } from "./runs.ts";
import { outcome, unique } from "./sign-in.ts";

// Emit tasks of JSON workflows (emitted-events.ts, resource-host.ts), from
// their threat model: an event goes only to core's outbox, through an
// event binding the run's start pinned, of a type its contract admits,
// with data its contract takes; its id, source, time and content type are
// the host's; it is written once, however often its step runs; a revoked
// binding emits nothing; and retention removes its data with its run's.

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

/** A workflow of `admin`'s emitting through `jobEvents`, `{ jobId }` in and out. */
const emitting = async (admin: Identity, tasks: unknown[], approve = true) => {
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
  const workflow = await createWorkflowResource(env, admin, `emit-${unique()}`);
  const version = await publishWorkflowVersion(env, admin, workflow.id, {
    definition: JSON.stringify({
      document: {
        dsl: "1.0.3",
        namespace: workflowNamespace,
        name: workflow.name,
        version: "1.0.0",
        title: workflow.name,
        metadata: {
          grasp: {
            profile: "grasp-open-workflow/1",
            params: {},
            bindings: { jobEvents: { kind: "event", contract } },
          },
        },
      },
      input: { schema: objectSchema({ jobId: { type: "string" } }) },
      output: { schema: objectSchema({ jobId: { type: "string" } }) },
      do: tasks,
    }),
    basedOn: null,
  });
  const approval = approve
    ? await approveWorkflowBinding(env, admin, workflow.id, {
        alias: "jobEvents",
        target: { kind: "event" },
        reviewed: { version: 1 },
      })
    : undefined;
  return { workflow, version, contract, approval };
};

/** An emit task `id` of a timeout of this run's job, with `more` attributes. */
const emitTimeout = (id: string, more: Record<string, unknown> = {}) => ({
  [id]: {
    emit: {
      event: {
        with: {
          type: timedOut,
          subject: "${ $workflow.input.jobId }",
          data: { jobId: "${ $workflow.input.jobId }" },
          ...more,
        },
      },
    },
    metadata: { grasp: { binding: "jobEvents" } },
  },
});

const started = async (by: Identity, workflowId: string): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    workflowId,
    { version: 1, input: { jobId: "job-1" }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  return runId;
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

const endStateOf = (run: WorkflowResourceRun) => ({
  status: run.status,
  ...(run.status === "completed"
    ? { output: run.output }
    : { code: run.error?.code }),
});

/** The events run `runId` emitted, as core's outbox keeps them. */
const emittedBy = async (runId: string) => {
  const rows = await env.DB.prepare(
    "SELECT id, task_id AS task, binding, contract_id AS contract, source, type, subject, data, details_removed_at AS removed, delivered_at AS delivered FROM workflow_emitted_events WHERE run_id = ? ORDER BY created_at"
  )
    .bind(runId)
    .all<{
      id: string;
      task: string;
      binding: string;
      contract: string;
      source: string;
      type: string;
      subject: string | null;
      data: string | null;
      removed: number | null;
      delivered: number | null;
    }>();
  return rows.results;
};

describe("emit tasks", { timeout: 120_000 }, () => {
  it("write their event once to the outbox, its id and source the host's, and pass their input on", async () => {
    const admin = await person("admin");
    const { workflow, contract } = await emitting(admin, [
      emitTimeout("publish-timeout"),
    ]);

    const runId = await started(admin, workflow.id);
    const run = await endOf(admin, workflow.id, runId);
    const [event] = await emittedBy(runId);
    const events = await allEvents();
    const audited = events.filter(
      (entry) =>
        entry.action === "workflow.event.emitted" && entry.target?.id === runId
    );

    expect(endStateOf(run)).toStrictEqual({
      status: "completed",
      output: { jobId: "job-1" },
    });
    expect(event?.id).toMatch(/^evt_[0-9a-f]{48}$/u);
    expect({ ...event, id: undefined }).toStrictEqual({
      id: undefined,
      task: "publish-timeout",
      binding: "jobEvents",
      contract,
      source: `urn:grasp:workflow:${workflow.id}:run:${runId}`,
      type: timedOut,
      subject: "job-1",
      data: JSON.stringify({ jobId: "job-1" }),
      removed: null,
      delivered: null,
    });
    expect(audited).toHaveLength(1);
  });

  it("write their event once, however often the run stops and resumes around it", async () => {
    const admin = await person("admin");
    const { workflow } = await emitting(admin, [
      emitTimeout("publish-timeout"),
      { linger: { wait: "PT2S" } },
    ]);

    const runId = await started(admin, workflow.id);
    await vi.waitFor(
      async () => {
        await expect(liveStatus(runId)).resolves.toBe("waiting");
      },
      { timeout: 30_000, interval: 100 }
    );
    await stopped(runId);
    await resumed(runId);
    await endOf(admin, workflow.id, runId);

    await expect(emittedBy(runId)).resolves.toHaveLength(1);
  });

  it("emit nothing, failing the run, through a binding whose approval was revoked", async () => {
    const admin = await person("admin");
    const { workflow, approval } = await emitting(admin, [
      { linger: { wait: "PT2S" } },
      emitTimeout("publish-timeout"),
    ]);

    const runId = await started(admin, workflow.id);
    await vi.waitFor(
      async () => {
        await expect(liveStatus(runId)).resolves.toBe("waiting");
      },
      { timeout: 30_000, interval: 100 }
    );
    await revokeWorkflowBinding(env, admin, workflow.id, approval?.id);
    const run = await endOf(admin, workflow.id, runId);

    expect({
      end: endStateOf(run),
      emitted: await emittedBy(runId),
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.event_denied" },
      emitted: [],
    });
  });

  it("emit nothing, failing the run, with data the type's contract doesn't take", async () => {
    const admin = await person("admin");
    const { workflow } = await emitting(admin, [
      emitTimeout("publish-timeout", {
        data: { jobId: "${ $workflow.input.jobId }", extra: true },
      }),
    ]);

    const runId = await started(admin, workflow.id);
    const run = await endOf(admin, workflow.id, runId);

    expect({
      end: endStateOf(run),
      emitted: await emittedBy(runId),
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.event_invalid" },
      emitted: [],
    });
  });

  it("aren't lowered with a source of their own or a content type other than JSON's", async () => {
    const admin = await person("admin");
    const { version } = await emitting(
      admin,
      [
        emitTimeout("publish-timeout", {
          source: "https://evil.example.com",
          datacontenttype: "text/plain",
        }),
      ],
      false
    );

    expect(
      version.build.executable ? [] : version.build.unsupported
    ).toStrictEqual([
      {
        pointer: "/do/0/publish-timeout/emit/event/with/source",
        taskId: "publish-timeout",
        feature: "emit:source",
      },
      {
        pointer: "/do/0/publish-timeout/emit/event/with/datacontenttype",
        taskId: "publish-timeout",
        feature: "emit:datacontenttype",
      },
    ]);
  });

  it("keep a data schema only as the literal URI the definition gives, never one built from data", async () => {
    const admin = await person("admin");
    const { version } = await emitting(
      admin,
      [emitTimeout("publish-timeout", { dataschema: "${ .jobId }" })],
      false
    );
    const literal = await emitting(admin, [
      emitTimeout("publish-timeout", {
        dataschema: "https://example.com/job-timeout",
      }),
    ]);

    const runId = await started(admin, literal.workflow.id);
    await endOf(admin, literal.workflow.id, runId);
    const row = await env.DB.prepare(
      "SELECT dataschema, restricted FROM workflow_emitted_events WHERE run_id = ?"
    )
      .bind(runId)
      .first<{ dataschema: string; restricted: number }>();

    expect({
      expression: version.build.executable ? [] : version.build.unsupported,
      literal: row,
    }).toStrictEqual({
      expression: [
        {
          pointer: "/do/0/publish-timeout/emit/event/with/dataschema",
          taskId: "publish-timeout",
          feature: "emit:dataschema",
        },
      ],
      literal: { dataschema: "https://example.com/job-timeout", restricted: 0 },
    });
  });

  it("aren't lowered with a data schema that isn't an http or https URI", async () => {
    const admin = await person("admin");
    const unsupported = async (dataschema: string) => {
      const { version } = await emitting(
        admin,
        [emitTimeout("publish-timeout", { dataschema })],
        false
      );
      return version.build.executable ? [] : version.build.unsupported;
    };

    await expect(
      Promise.all(
        ["data:text/plain,x", "file:///etc/passwd", "urn:example:job"].map(
          unsupported
        )
      )
    ).resolves.toStrictEqual(
      Array.from({ length: 3 }, () => [
        {
          pointer: "/do/0/publish-timeout/emit/event/with/dataschema",
          taskId: "publish-timeout",
          feature: "emit:dataschema",
        },
      ])
    );
  });

  it("write nothing for an attempt that stopped holding while its event was being checked", async () => {
    const admin = await person("admin");
    const { workflow } = await emitting(admin, [
      { linger: { wait: "PT1H" } },
      emitTimeout("publish-timeout"),
    ]);
    const runId = await started(admin, workflow.id);
    await vi.waitFor(
      async () => {
        await expect(liveStatus(runId)).resolves.toBe("waiting");
      },
      { timeout: 30_000, interval: 100 }
    );
    const run = await callingRunOf(env, workflow.id, runId);
    if (run === undefined) {
      throw new Error("The run has ended");
    }

    const stale = await outcome(
      emitEvent(
        env,
        run,
        {
          taskId: "publish-timeout",
          stepKey: "stale-step",
          binding: "jobEvents",
          type: timedOut,
          data: { jobId: "job-1" },
        },
        () => {
          throw executionErrors.create("execution.stale_attempt");
        }
      )
    );

    expect({ stale, emitted: await emittedBy(runId) }).toStrictEqual({
      stale: "execution.stale_attempt",
      emitted: [],
    });
  });

  it("lose their event's subject and data with their run's details, keeping its envelope", async () => {
    const admin = await person("admin");
    const { workflow } = await emitting(admin, [
      emitTimeout("publish-timeout"),
    ]);

    const runId = await started(admin, workflow.id);
    await endOf(admin, workflow.id, runId);
    const later = new Date(Date.now() + 1000);
    await sweepWorkflowStartDetails(env, later, later);
    const [event] = await emittedBy(runId);

    expect({
      type: event?.type,
      subject: event?.subject,
      data: event?.data,
      removed: event?.removed !== null,
      // Closed undelivered with its details, never delivered without them.
      closed: event?.delivered === event?.removed,
    }).toStrictEqual({
      type: timedOut,
      subject: null,
      data: null,
      removed: true,
      closed: true,
    });
  });
});
