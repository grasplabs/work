import type { Role } from "@grasp-os/shared/roles";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import {
  resourceRunFor,
  terminateResourceRun,
} from "../src/workflows/resource-runs.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { resumed, runInstance, sleeping, stopped, woken } from "./runs.ts";
import { unique } from "./sign-in.ts";

// Typed failures of grasp-workflow/2 runs, published and started as a
// builder would, from their threat model. A catch takes only a failure
// of a step in its own `try` list, decided by the host from its own
// record of the run (never from what the isolate threw), filtered by the
// error's type and status and its `when`; anything it doesn't take goes
// on unchanged, to the catch around it. A wait or a cancellation is never
// a failure a catch sees. Its `do` runs as ordinary recorded steps, so a
// crash during it replays what ran and binds the caught error again from
// the journal. That a raise fails its run, a catch takes it, and a retry
// backs off are the run host's own tests (workflow-schema-runs,
// retry-rounds).

/** A builder of the organization, as their session has them. */
const builder = async (role: Role = "builder"): Promise<Acting> => {
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
  return { userId, role, teams: [], staff: false };
};

const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/** A domain error a raise raises: of the workflow's own type. */
const conflict = {
  code: "invoice.conflict",
  message: "The invoice changed meanwhile.",
};

/** A raise of the domain conflict, as step `deny`. */
const deny = { id: "deny", type: "raise", error: conflict };

/** A step `id` that only marks that it ran: a wait of a second. */
const mark = (id: string) => ({ id, type: "wait", for: "1 second" });

/** A try `id` around `tried`, its catch `handler`. */
const guarded = (
  tried: unknown[],
  handler: Record<string, unknown>,
  id = "guard"
) => ({ id, type: "try", try: tried, catch: handler });

/** A definition running `steps`, its input `{ who }`, its output `{ status }`. */
const definitionOf = (steps: unknown[]) =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status: "done" },
    steps,
  });

/** A workflow of `by`'s, published once from `definition`. */
const published = async (by: Acting, definition: string) => {
  const workflow = await createWorkflowResource(env, by, `flow-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition,
    basedOn: null,
  });
  return workflow;
};

/** Starts version 1 of workflow `id` for `who`: its run's ID. */
const startFor = async (by: Acting, id: string, who = "Ada") => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, input: { who }, key: unique() }
  );
  return runId;
};

/** Run `runId` of workflow `id` once it has ended. */
const endedRun = async (
  by: Acting,
  id: string,
  runId: string
): Promise<WorkflowResourceRun> =>
  await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      expect(run.endedAt).not.toBeNull();
      return run;
    },
    { timeout: 30_000, interval: 100 }
  );

/** What a run ended with: its status, and its output or error code. */
const endOf = (run: WorkflowResourceRun) => ({
  status: run.status,
  ...(run.status === "completed"
    ? { output: run.output }
    : { code: run.error?.code }),
});

/** The marks (`mark`) ended run `runId` reached, in order. */
const marksOf = async (runId: string): Promise<string[]> => {
  using events = await runInstance(runId).subscribe({
    filter: ["sleep_started"],
  });
  const names: string[] = [];
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one event at a time, in order
    const { done, value } = await events.next();
    if (done === true) {
      return names;
    }
    if (value.type === "sleep_started") {
      names.push(value.stepName.split(":")[0] ?? "");
    }
  }
};

/** Publishes `steps` and runs them once: how the run ended, and its marks. */
const outcomeOf = async (steps: unknown[]) => {
  const by = await builder();
  const workflow = await published(by, definitionOf(steps));
  const runId = await startFor(by, workflow.id);
  return {
    ...endOf(await endedRun(by, workflow.id, runId)),
    marks: await marksOf(runId),
  };
};

/**
 * How many attempts the engine started of each step of ended run `runId`
 * whose name starts with one of `steps`, from the run's own event stream.
 */
const attemptsOf = async (runId: string, steps: readonly string[]) => {
  using events = await runInstance(runId).subscribe({
    filter: ["attempt_started"],
  });
  const counts = Object.fromEntries(steps.map((step) => [step, 0]));
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one event at a time, in order
    const { done, value } = await events.next();
    if (done === true) {
      return counts;
    }
    const step =
      value.type === "attempt_started"
        ? steps.find((name) => value.stepName.startsWith(name))
        : undefined;
    if (step !== undefined) {
      counts[step] = (counts[step] ?? 0) + 1;
    }
  }
};

describe("raise and catch", () => {
  it("lets a failure a catch's filter doesn't name go on unchanged, to the catch around it", async () => {
    const inner = guarded(
      [deny],
      { code: "invoice.missing", do: [mark("inner")] },
      "innerGuard"
    );
    const outer = guarded([inner], {
      code: conflict.code,
      do: [mark("outer")],
    });
    expect({
      around: await outcomeOf([outer]),
      alone: await outcomeOf([inner]),
    }).toStrictEqual({
      around: {
        status: "completed",
        output: { status: "done" },
        marks: ["outer"],
      },
      alone: { status: "failed", code: "workflow.raised", marks: [] },
    });
  });

  it("takes a failure only when its when holds, reading the error it would take", async () => {
    const caughtWhen = async (when: string) =>
      await outcomeOf([
        guarded([deny], { when: { $expr: when }, do: [mark("caught")] }),
      ]);
    expect({
      holds: await caughtWhen("error.status === 409"),
      doesnt: await caughtWhen("error.status === 500"),
    }).toStrictEqual({
      holds: {
        status: "completed",
        output: { status: "done" },
        marks: ["caught"],
      },
      doesnt: { status: "failed", code: "workflow.raised", marks: [] },
    });
  });

  it("fails the run with a recovery's own failure", async () => {
    const by = await builder();
    const workflow = await published(
      by,
      definitionOf([
        guarded([deny], {
          do: [
            {
              id: "undo",
              type: "raise",
              error: {
                code: "invoice.undo_failed",
                message: "The invoice couldn't be put back.",
              },
            },
          ],
        }),
      ])
    );
    const run = await endedRun(
      by,
      workflow.id,
      await startFor(by, workflow.id)
    );
    expect({ ...endOf(run), message: run.error?.message }).toStrictEqual({
      status: "failed",
      code: "workflow.raised",
      message: "The invoice couldn't be put back.",
    });
  });

  it("doesn't retry a failure its catch doesn't take", async () => {
    const by = await builder();
    const workflow = await published(
      by,
      definitionOf([
        guarded([deny], {
          errors: { status: 500 },
          retry: { attempts: 3, delay: "1 second", backoff: "constant" },
        }),
      ])
    );
    const runId = await startFor(by, workflow.id);
    const run = await endedRun(by, workflow.id, runId);
    expect({
      end: endOf(run),
      attempts: await attemptsOf(runId, ["deny:"]),
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.raised" },
      attempts: { "deny:": 1 },
    });
  });
});

describe("what a catch never takes", () => {
  afterEach(endLiveResourceRuns);

  it("leaves a run waiting inside a try waiting, and its cancellation unseen by its catch", async () => {
    const by = await builder();
    const workflow = await published(
      by,
      definitionOf([
        guarded([{ id: "pause", type: "wait", for: "1 hour" }], {
          do: [mark("recovered")],
        }),
      ])
    );
    const runId = await startFor(by, workflow.id);
    await sleeping(runId, "pause:task");
    await terminateResourceRun(env, by, workflow.id, runId);
    const run = await endedRun(by, workflow.id, runId);
    expect({
      status: run.status,
      caught: await attemptsOf(runId, ["guard:catch"]),
      marks: await marksOf(runId),
    }).toStrictEqual({
      status: "cancelled",
      caught: { "guard:catch": 0 },
      marks: ["pause"],
    });
  });
});

/**
 * A recovery step `id` that fails the run unless `error` is the conflict
 * caught, as `when` says it isn't: so a replay that didn't bind it again
 * from the journal fails.
 */
const unlessCaught = (id: string, when: string) => ({
  id,
  type: "raise",
  if: { $expr: when },
  error: { code: "not.caught", message: "Failed." },
});

describe("a caught failure's recovery, through a crash", () => {
  afterEach(endLiveResourceRuns);

  it("replays the failure, its catch and its finished recovery steps, binding the caught error again", async () => {
    const by = await builder();
    const workflow = await published(
      by,
      definitionOf([
        guarded([deny], {
          do: [
            unlessCaught(
              "note",
              `error.code !== ${JSON.stringify(conflict.code)}`
            ),
            { id: "pause", type: "wait", for: "1 hour" },
            unlessCaught(
              "report",
              `error.message !== ${JSON.stringify(conflict.message)}`
            ),
          ],
        }),
      ])
    );
    const runId = await startFor(by, workflow.id);
    await sleeping(runId, "pause:task");
    // A crash while the recovery waits; then its wait ends: the next
    // activation, in a fresh isolate, replays the raise's failure, the
    // catch and `note`, and reads `error` again.
    await stopped(runId);
    await resumed(runId);
    await woken(runId, "pause:task");
    const run = await endedRun(by, workflow.id, runId);
    expect({
      end: endOf(run),
      attempts: await attemptsOf(runId, [
        "deny:",
        "guard:catch",
        "note:",
        "report:",
      ]),
    }).toStrictEqual({
      end: { status: "completed", output: { status: "done" } },
      attempts: { "deny:": 1, "guard:catch": 1, "note:": 1, "report:": 1 },
    });
  });
});
