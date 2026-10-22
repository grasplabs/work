/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import { loadWorkflowBuild } from "../src/workflow-builds.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import type { Settled } from "../src/workflows/code.ts";
import { eventTypeKey } from "../src/workflows/event-envelopes.ts";
import type { RunStep } from "../src/workflows/host.ts";
import { ResourceRunHost } from "../src/workflows/resource-host.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { admitRunEvent } from "../src/workflows/run-events.ts";
import type { RunEventDelivery } from "../src/workflows/run-events.ts";
import {
  admittedFreely,
  liveStatus,
  resumed,
  runObject,
  stopped,
} from "./runs.ts";
import { outcome, unique } from "./sign-in.ts";

// Listen tasks of JSON workflows and the run inbox they take events from
// (run-events.ts, resource-host.ts, @grasp-os/workerflow's waitForMatch),
// from their threat model: a sender can't forge an event's ID, source or
// time, nor send through a binding or of a type the run's start didn't
// pin, nor with data its contract refuses; a listen on one binding never
// takes another's events, whatever their type; an event that comes early,
// while the run is paused, or twice, is taken once, by the wait that
// matches it, and a run that restarts takes no event again; a listen that
// waits past its timeout fails; and a module in the run's isolate can't
// make the host listen for what the build didn't seal, or record events
// the run never took.

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

const strings = { type: "array", items: { type: "string" } };

/** A job's events: its completion and its timeout, each a job and a note. */
const jobData = JSON.stringify(
  v.object({ jobId: v.string(), note: v.string() }).descriptor
);

const completed = "grasp.job.completed";
const timedOut = "grasp.job.timeout";

/**
 * A workflow of `admin`'s whose input is `{ jobId }` and whose output is
 * `{ notes }`, running `tasks`, its event bindings `jobEvents` and
 * `otherEvents` both of one job event contract, each of `aliases`
 * approved for version 1 (a binding no task uses isn't one to approve).
 */
const listening = async (
  admin: Identity,
  tasks: unknown[],
  /** The bindings its tasks listen through, each approved. */
  aliases: readonly string[] = ["jobEvents"]
) => {
  const contract = `job-events-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: contract,
    kind: "event",
    events: {
      [completed]: { data: jobData, browser: false },
      [timedOut]: { data: jobData, browser: false },
    },
  });
  const workflow = await createWorkflowResource(
    env,
    admin,
    `listen-${unique()}`
  );
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
            bindings: {
              jobEvents: { kind: "event", contract },
              otherEvents: { kind: "event", contract },
            },
          },
        },
      },
      input: { schema: objectSchema({ jobId: { type: "string" } }) },
      output: { schema: objectSchema({ notes: strings }) },
      do: tasks,
    }),
    basedOn: null,
  });
  const approvals: Record<string, string> = {};
  for (const alias of aliases) {
    // oxlint-disable-next-line no-await-in-loop -- two approvals, in turn
    const approval = await approveWorkflowBinding(env, admin, workflow.id, {
      alias,
      target: { kind: "event" },
      reviewed: { version: 1 },
    });
    approvals[alias] = approval.id;
  }
  return { workflow, version, approvals };
};

/** A listen task `id`, through `jobEvents` unless said, of `to`. */
const listen = (
  id: string,
  to: Record<string, unknown>,
  {
    read = "data",
    binding = "jobEvents",
    timeout = { minutes: 5 },
  }: {
    read?: "data" | "envelope";
    binding?: string;
    timeout?: Record<string, number>;
  } = {}
) => ({
  [id]: {
    listen: { to, read },
    timeout: { after: timeout },
    metadata: { grasp: { binding } },
  },
});

/** A filter of this run's job's events of `type`, by its subject. */
const ofThisJob = (type: string) => ({
  with: { type, subject: "${ $workflow.input.jobId }" },
});

/** The notes of the events a listen reading data took. */
const notes = { notes: { set: { notes: "${ [.[] | .note] }" } } };

/** Starts version 1 of `workflow` for `by` on job `jobId`: its run's ID. */
const started = async (
  by: Identity,
  workflowId: string,
  jobId = "job-1"
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    workflowId,
    { version: 1, input: { jobId }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  return runId;
};

/** Once the engine has run `runId` waiting, on its sleep or its listen. */
const waiting = async (runId: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      await expect(liveStatus(runId)).resolves.toBe("waiting");
    },
    { timeout: 20_000, interval: 100 }
  );
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
    { timeout: 30_000, interval: 100 }
  );

const source = "https://grasp.test/apps/invoices";

/** A delivery to `runId` of `workflowId`, of a job event. */
const delivery = (
  workflowId: string,
  runId: string,
  event: Partial<RunEventDelivery> & { note?: string } = {}
): RunEventDelivery => {
  const { note = "done", ...rest } = event;
  return {
    workflowId,
    runId,
    binding: "jobEvents",
    type: completed,
    subject: "job-1",
    data: { jobId: "job-1", note },
    key: unique(),
    source,
    ...rest,
  };
};

describe("listen tasks", { timeout: 120_000 }, () => {
  it("take an event sent before the listen began, of their own binding and job, and leave another job's and another binding's", async () => {
    const admin = await person("admin");
    const { workflow } = await listening(
      admin,
      [
        { pause: { wait: "PT2S" } },
        {
          "await-job": {
            ...listen("await-job", { one: ofThisJob(completed) })["await-job"],
            export: { as: "${ { first: [.[] | .note] } }" },
          },
        },
        listen(
          "await-other",
          { one: ofThisJob(completed) },
          { binding: "otherEvents" }
        ),
        { notes: { set: { notes: "${ $context.first + [.[] | .note] }" } } },
      ],
      ["jobEvents", "otherEvents"]
    );
    const runId = await started(admin, workflow.id);
    await waiting(runId);

    const sent = [
      delivery(workflow.id, runId, {
        binding: "otherEvents",
        note: "another binding's",
      }),
      delivery(workflow.id, runId, {
        subject: "job-2",
        note: "another job's",
      }),
      delivery(workflow.id, runId, { note: "ours" }),
    ];
    for (const event of sent) {
      // oxlint-disable-next-line no-await-in-loop -- in order: acceptance order matters
      await admitRunEvent(env, event);
    }
    const run = await endOf(admin, workflow.id, runId);
    const journal = await runObject(runId).journal();

    // The other binding's event, sent first, waited for its own listen.
    expect({ status: run.status, output: run.output }).toStrictEqual({
      status: "completed",
      output: { notes: ["ours", "another binding's"] },
    });
    expect(
      journal?.events.map((event) => event.consumed_by !== null)
    ).toStrictEqual([true, false, true]);
  });

  it("wait for all their filters in the filters' order, whatever order the events came in, and read envelopes the host minted", async () => {
    const admin = await person("admin");
    const { workflow } = await listening(admin, [
      listen(
        "await-both",
        { all: [ofThisJob(completed), ofThisJob(timedOut)] },
        { read: "envelope" }
      ),
      {
        envelopes: {
          set: {
            notes:
              "${ [.[] | .data.note] + [.[] | .type] + [.[] | .id] + [.[] | .source] + [.[] | .specversion] + [.[] | .time | tostring] }",
          },
        },
      },
    ]);
    const runId = await started(admin, workflow.id);
    await waiting(runId);

    const late = await admitRunEvent(
      env,
      delivery(workflow.id, runId, { type: timedOut, note: "timed out" })
    );
    const done = await admitRunEvent(
      env,
      delivery(workflow.id, runId, { note: "done" })
    );
    const run = await endOf(admin, workflow.id, runId);

    const output = z.object({ notes: z.array(z.string()) }).parse(run.output);
    expect(output.notes.slice(0, 10)).toStrictEqual([
      "done",
      "timed out",
      completed,
      timedOut,
      done.id,
      late.id,
      source,
      source,
      "1.0",
      "1.0",
    ]);
    expect(
      output.notes.slice(10).every((time) => !Number.isNaN(Date.parse(time)))
    ).toBeTruthy();
    expect(done.id).toMatch(/^evt_[0-9a-f]{48}$/u);
  });

  it("take the first event, in the order the run accepted them, that matches any of their filters", async () => {
    const admin = await person("admin");
    const { workflow } = await listening(admin, [
      { pause: { wait: "PT2S" } },
      listen("await-either", {
        any: [ofThisJob(completed), ofThisJob(timedOut)],
      }),
      notes,
    ]);
    const runId = await started(admin, workflow.id);
    await waiting(runId);

    await admitRunEvent(
      env,
      delivery(workflow.id, runId, { type: timedOut, note: "first" })
    );
    await admitRunEvent(env, delivery(workflow.id, runId, { note: "second" }));
    const run = await endOf(admin, workflow.id, runId);

    expect(run.output).toStrictEqual({ notes: ["first"] });
  });

  it("take their own events per item when a for loop runs them, each item the first match of its own", async () => {
    const admin = await person("admin");
    const { workflow } = await listening(admin, [
      { init: { set: "${ . }", export: { as: "${ {notes: []} }" } } },
      { pause: { wait: "PT2S" } },
      {
        "each-job": {
          for: { each: "name", in: '${ ["j1", "j2"] }' },
          do: [
            {
              "await-item": {
                ...listen("await-item", {
                  one: { with: { type: completed, subject: "${ $name }" } },
                })["await-item"],
                export: {
                  as: "${ {notes: ($context.notes + [.[] | .note])} }",
                },
              },
            },
          ],
        },
      },
      { done: { set: { notes: "${ $context.notes }" } } },
    ]);
    const runId = await started(admin, workflow.id);
    await waiting(runId);

    for (const [subject, note] of [
      ["j2", "first j2"],
      ["j1", "j1"],
      ["j2", "second j2"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- in order: acceptance order matters
      await admitRunEvent(env, delivery(workflow.id, runId, { subject, note }));
    }
    const run = await endOf(admin, workflow.id, runId);
    const journal = await runObject(runId).journal();

    expect({ status: run.status, output: run.output }).toStrictEqual({
      status: "completed",
      output: { notes: ["j1", "first j2"] },
    });
    expect(
      journal?.events.map((event) => event.consumed_by !== null)
    ).toStrictEqual([true, true, false]);
  });

  it("take their own events per item when for loops nest, each pair the first match of its own", async () => {
    const admin = await person("admin");
    const { workflow } = await listening(admin, [
      { init: { set: "${ . }", export: { as: "${ {notes: []} }" } } },
      { pause: { wait: "PT2S" } },
      {
        outer: {
          for: { each: "job", at: "jobAt", in: '${ ["j1", "j2"] }' },
          do: [
            {
              inner: {
                for: { each: "part", at: "partAt", in: '${ ["x"] }' },
                do: [
                  {
                    "await-pair": {
                      ...listen("await-pair", {
                        one: {
                          with: {
                            type: completed,
                            subject: "${ $job + $part }",
                          },
                        },
                      })["await-pair"],
                      export: {
                        as: "${ {notes: ($context.notes + [.[] | .note])} }",
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      { done: { set: { notes: "${ $context.notes }" } } },
    ]);
    const runId = await started(admin, workflow.id);
    await waiting(runId);

    for (const [subject, note] of [
      ["j2x", "first j2x"],
      ["j1x", "j1x"],
      ["j2x", "second j2x"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- in order: acceptance order matters
      await admitRunEvent(env, delivery(workflow.id, runId, { subject, note }));
    }
    const run = await endOf(admin, workflow.id, runId);
    const journal = await runObject(runId).journal();

    expect({ status: run.status, output: run.output }).toStrictEqual({
      status: "completed",
      output: { notes: ["j1x", "first j2x"] },
    });
    expect(
      journal?.events.map((event) => event.consumed_by !== null)
    ).toStrictEqual([true, true, false]);
  });

  it("fail the run when their events don't come by the timeout, and an ended run takes no more", async () => {
    const admin = await person("admin");
    const { workflow } = await listening(admin, [
      listen(
        "await-job",
        { one: ofThisJob(completed) },
        { timeout: { seconds: 2 } }
      ),
      notes,
    ]);
    const runId = await started(admin, workflow.id);

    const run = await endOf(admin, workflow.id, runId);
    const late = await outcome(
      admitRunEvent(env, delivery(workflow.id, runId))
    );

    expect({ status: run.status, code: run.error?.code, late }).toStrictEqual({
      status: "failed",
      code: "workflow.event_timeout",
      late: "workflow.run_ended",
    });
  });

  it("keep an event that comes while the run is paused, and take it once, when it resumes", async () => {
    const admin = await person("admin");
    const { workflow } = await listening(admin, [
      listen("await-job", { one: ofThisJob(completed) }),
      listen("await-next", { one: ofThisJob(completed) }),
      notes,
    ]);
    const runId = await started(admin, workflow.id);
    await waiting(runId);
    await stopped(runId);

    // Sent twice under one key while paused: one event, kept, and the run
    // stays paused.
    const event = delivery(workflow.id, runId, { note: "while paused" });
    const first = await admitRunEvent(env, event);
    const again = await admitRunEvent(env, event);
    const paused = await liveStatus(runId);
    await resumed(runId);
    await waiting(runId);
    // A restart of the run replays the first listen's event, taken once.
    await stopped(runId);
    await resumed(runId);
    await waiting(runId);
    await admitRunEvent(env, delivery(workflow.id, runId, { note: "next" }));
    const run = await endOf(admin, workflow.id, runId);

    expect({
      paused,
      first: first.accepted,
      again,
      output: run.output,
    }).toStrictEqual({
      paused: "paused",
      first: true,
      again: { id: first.id, accepted: false },
      output: { notes: ["next"] },
    });
    const journal = await runObject(runId).journal();
    expect(
      journal?.events.map((row) => row.consumed_by !== null)
    ).toStrictEqual([true, true]);
  });

  it("refuse events their run doesn't take, before accepting anything", async () => {
    const admin = await person("admin");
    const { workflow, approvals } = await listening(admin, [
      listen("await-job", { one: ofThisJob(completed) }),
      notes,
    ]);
    const other = await listening(admin, [
      listen("await-job", { one: ofThisJob(completed) }),
      notes,
    ]);
    const runId = await started(admin, workflow.id);
    await waiting(runId);
    // Another job's: accepted, and taken by no listen, so the run still
    // waits while every refusal below is checked.
    const event = delivery(workflow.id, runId, {
      subject: "job-2",
      note: "first",
    });
    await admitRunEvent(env, event);

    const refused = {
      binding: await outcome(
        admitRunEvent(env, delivery(workflow.id, runId, { binding: "nope" }))
      ),
      type: await outcome(
        admitRunEvent(
          env,
          delivery(workflow.id, runId, { type: "grasp.job.started" })
        )
      ),
      data: await outcome(
        admitRunEvent(env, {
          ...delivery(workflow.id, runId),
          data: { jobId: "job-1", note: "x", extra: true },
        })
      ),
      otherWorkflow: await outcome(
        admitRunEvent(env, delivery(other.workflow.id, runId))
      ),
      relativeSource: await outcome(
        admitRunEvent(env, { ...delivery(workflow.id, runId), source: "/me" })
      ),
      reusedKey: await outcome(
        admitRunEvent(env, { ...event, data: { jobId: "job-1", note: "x" } })
      ),
    };
    const stillWaiting = await liveStatus(runId);
    await revokeWorkflowBinding(env, admin, workflow.id, approvals.jobEvents);
    const revoked = await outcome(
      admitRunEvent(env, delivery(workflow.id, runId))
    );
    const journal = await runObject(runId).journal();

    expect({ ...refused, revoked, stillWaiting }).toStrictEqual({
      binding: "workflow.event_invalid",
      type: "workflow.event_invalid",
      data: "workflow.event_invalid",
      otherWorkflow: "workflow.run_unavailable",
      relativeSource: "workflow.event_invalid",
      reusedKey: "workflow.event_conflict",
      revoked: "workflow.event_denied",
      stillWaiting: "waiting",
    });
    expect(journal?.events).toHaveLength(1);
  });

  it("fail the run, taking nothing, when the binding's approval is revoked between an event's admission and the listen", async () => {
    const admin = await person("admin");
    const { workflow, approvals } = await listening(admin, [
      { pause: { wait: "PT2S" } },
      listen("await-job", { one: ofThisJob(completed) }),
      notes,
    ]);
    const runId = await started(admin, workflow.id);
    await waiting(runId);

    await admitRunEvent(env, delivery(workflow.id, runId, { note: "early" }));
    await revokeWorkflowBinding(env, admin, workflow.id, approvals.jobEvents);
    const run = await endOf(admin, workflow.id, runId);
    const journal = await runObject(runId).journal();

    expect({ status: run.status, code: run.error?.code }).toStrictEqual({
      status: "failed",
      code: "workflow.event_denied",
    });
    expect(journal?.events.map((row) => row.consumed_by)).toStrictEqual([null]);
  });

  it("aren't lowered with a filter that correlates on an event's content", async () => {
    const admin = await person("admin");
    const { version } = await listening(admin, [
      listen("await-job", {
        one: {
          with: { type: completed },
          correlate: { job: { from: "${ .data.jobId }", expect: "job-1" } },
        },
      }),
      notes,
    ]);

    expect(
      version.build.executable ? [] : version.build.unsupported
    ).toStrictEqual([
      {
        pointer: "/do/0/await-job/listen/to/one/correlate",
        taskId: "await-job",
        feature: "listen:correlate",
      },
    ]);
  });

  it("aren't lowered with a filter on an attribute the inbox doesn't keep", async () => {
    const admin = await person("admin");
    const { version } = await listening(admin, [
      listen("await-job", {
        one: {
          with: { type: completed, dataschema: "https://example.com/job" },
        },
      }),
      notes,
    ]);

    expect(
      version.build.executable ? [] : version.build.unsupported
    ).toStrictEqual([
      {
        pointer: "/do/0/await-job/listen/to/one/with/dataschema",
        taskId: "await-job",
        feature: "listen:dataschema",
      },
    ]);
  });
});

/** A host of a run of `workflowId`'s version 1, its waits `waits`. */
const hostOf = async (
  by: Identity,
  workflowId: string,
  waits: RunStep["waitForMatch"]
): Promise<ResourceRunHost> => {
  const manifest = await env.DB.prepare(
    "SELECT manifest_hash AS hash FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
  )
    .bind(workflowId)
    .first<{ hash: string }>();
  const build = await loadWorkflowBuild(
    env,
    workflowId,
    1,
    manifest?.hash ?? ""
  );
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
    waitForMatch: waits,
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
      input: { jobId: "job-1" },
      params: {},
      createdAt: Date.now(),
      build,
      calling: {
        runId,
        workflowId,
        version: 1,
        principal: by.userId,
        invoker: { type: "person", id: by.userId, appVersion: null },
        // A test run's: nothing outside the host is asked.
        bindings: new Map(),
        candidate: new Map([
          [
            "jobEvents",
            {
              kind: "event",
              contractId: "x",
              fingerprint: "x",
              answer: undefined,
            },
          ],
        ]),
        restricted: false,
      },
      maxModelCalls: 1,
    },
    {
      leaseOf: () => ({ generation: 1, deadline: Date.now() + 60_000 }),
      tampered: () => {},
      admitAttempt: admittedFreely,
    }
  );
};

const codeOf = (settled: Settled<unknown>): unknown =>
  settled.ok ? settled.value : settled.error.code;

const data = { input: { input: { jobId: "job-1" }, context: {} } };

/** The event every wait of these hosts takes, as the engine keeps it. */
const takenEvent = {
  id: "evt_1",
  source,
  type: completed,
  subject: "job-1",
  datacontenttype: "application/json",
  data: { jobId: "job-1", note: "taken" },
};

/** An enter step that resolves the task's deadline and filters. */
const entered = async (host: ResourceRunHost, id: string) =>
  await host.do(`enter:${id}`, data, async (attempt) => {
    const until = await attempt.until({ input: { jobId: "job-1" } });
    return until.ok
      ? {
          ok: true,
          value: { output: { jobId: "job-1" }, until: until.value },
        }
      : until;
  });

describe("a listen's host", { timeout: 60_000 }, () => {
  it("waits for exactly the events its enter step resolved, and nothing the isolate passes", async () => {
    const admin = await person("admin");
    const { workflow } = await listening(admin, [
      listen("await-job", { one: ofThisJob(completed) }),
      notes,
    ]);
    const asked: unknown[] = [];
    const host = await hostOf(admin, workflow.id, async (_name, options) => {
      asked.push(options.match);
      return await Promise.resolve({
        payload: takenEvent,
        timestamp: new Date(),
      });
    });
    // Before its enter step recorded what it waits for: nothing to wait on.
    const early = await host.listen("task:await-job");
    const fresh = await hostOf(admin, workflow.id, async (_name, options) => {
      asked.push(options.match);
      return await Promise.resolve({
        payload: takenEvent,
        timestamp: new Date(),
      });
    });
    await entered(fresh, "await-job");
    const taken = await fresh.listen("task:await-job");

    expect({
      early: codeOf(early),
      taken: codeOf(taken),
      asked,
    }).toStrictEqual({
      early: "workflow.invalid",
      taken: [{ jobId: "job-1", note: "taken" }],
      asked: [
        [
          {
            type: await eventTypeKey("jobEvents", completed),
            attributes: { subject: "job-1" },
          },
        ],
      ],
    });
  });

  it("refuses a leave step that transforms or records events its task never took", async () => {
    const admin = await person("admin");
    const { workflow } = await listening(admin, [
      {
        "await-job": {
          ...listen("await-job", { one: ofThisJob(completed) })["await-job"],
          output: { as: "${ { notes: [.[] | .note] } }" },
        },
      },
    ]);
    const host = await hostOf(
      admin,
      workflow.id,
      async () =>
        await Promise.resolve({ payload: takenEvent, timestamp: new Date() })
    );
    await entered(host, "await-job");
    await host.listen("task:await-job");
    const build = await loadWorkflowBuild(env, workflow.id, 1);
    const slot =
      build.expressions.find(({ stage }) => stage === "taskOutputAs")?.slot ??
      -1;
    const forged = await host.do("leave:await-job", data, async (attempt) => {
      const shaped = await attempt.evaluate(slot, {
        input: { jobId: "job-1" },
        output: [{ jobId: "job-1", note: "forged" }],
      });
      return shaped.ok ? { ok: true, value: { output: shaped.value } } : shaped;
    });

    expect(codeOf(forged)).toBe("workflow.invalid");
  });
});
