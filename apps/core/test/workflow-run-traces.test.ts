/* oxlint-disable unicorn/no-thenable -- an if step's list is its then */
import { v } from "@grasp-os/runtime/app";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WorkflowRunTrace } from "@grasp-os/shared/workflow-diagrams";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import {
  answerDecision,
  confirmDecision,
  reviewDecision,
} from "../src/decisions/decisions.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { shareWorkflowResource } from "../src/workflow-members.ts";
import { createWorkflowResource } from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { runObjectOf } from "../src/workflows/engine.ts";
import { resourceRunTrace } from "../src/workflows/resource-run-trace.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { person as identityOf } from "./sealed-apps.ts";
import {
  descriptorOf,
  mailInput,
  mailOutput,
  serving,
} from "./sealed-run-harness.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";
import { publishDefinition } from "./workflow-publishing.ts";

// A run laid over its version's diagram (resource-run-trace.ts): the
// tasks its own journal reached, each step of them in order, with its loop
// item, times and failure's code, and so the path it took through the
// declared branches, never one the diagram suggests; the diagram of the
// version the run pinned, whatever was published since; and only for the
// workflow's builders.

const person = async (role: Role = "builder"): Promise<Acting> => {
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

/** A definition of `steps`, input `{ who }`, ending `{ status: "done" }`. */
const definitionOf = (
  steps: unknown[],
  permissions: Record<string, unknown> = {}
) =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status: "done" },
    permissions,
    steps,
  });

/** A step `id` that runs and ends at once: a wait of a second. */
const passing = (id: string) => ({ id, type: "wait", for: "1 second" });

/**
 * A step `id` that runs and ends at once without sleeping: a wait until a
 * deadline long past, its enter step and its own.
 */
const quick = (id: string) => ({ id, type: "wait", until: { $expr: "0" } });

/**
 * A step `id` that always fails: a wait until a deadline further ahead
 * than a year, which its enter step refuses (`workflow.call_invalid`).
 */
const failing = (id: string) => ({
  id,
  type: "wait",
  until: { $expr: "8640000000000000" },
});

/** A raise `id`, which has no step: its code throws it. */
const raising = (id: string) => ({
  id,
  type: "raise",
  error: { code: "test.refused", message: "Refused." },
});

/** Routing by who: one branch or the other, then on. */
const routing = [
  {
    id: "route",
    type: "if",
    condition: { $expr: 'args.who === "Ada"' },
    then: [passing("greetAda")],
    else: [passing("greetOther")],
  },
  passing("finished"),
];

/**
 * Starts workflow `id`, live at `version`, for `who` on `startEnv`, and
 * waits for its end.
 */
const ranFor = async (
  by: Acting,
  id: string,
  version: number,
  who: string,
  startEnv: Env = env
): Promise<string> => {
  const { runId } = await startWorkflow(
    startEnv,
    { type: "person", person: by },
    id,
    { expected: version, args: { who }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start made a run");
  }
  await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      expect(run.endedAt).not.toBeNull();
    },
    { timeout: 30_000, interval: 100 }
  );
  return runId;
};

/** A trace's steps: each one's task, state and failure's code. */
const shown = (trace: WorkflowRunTrace) =>
  trace.steps.map(({ task, state, errorCode }) => ({ task, state, errorCode }));

/** The IDs of `tasks`, each followed by those of the lists it holds. */
const declaredIn = (tasks: WorkflowRunTrace["diagram"]["tasks"]): string[] =>
  tasks.flatMap(({ id, scopes }) => [
    id,
    ...scopes.flatMap((scope) => declaredIn(scope.tasks)),
  ]);

/** A trace as lines: what the diagram declares, and what the run reached. */
const pathOf = (trace: WorkflowRunTrace) => ({
  status: trace.status,
  declared: declaredIn(trace.diagram.tasks),
  reached: trace.tasks.map(({ task, state }) => `${task} ${state}`).toSorted(),
});

describe("a run's trace", () => {
  it("shows the tasks the run's own journal reached, so the branch it took, over every declared one", async () => {
    const by = await person();
    const workflow = await createWorkflowResource(
      env,
      by,
      `traced-${unique()}`
    );
    await publishDefinition(env, by, workflow.id, definitionOf(routing));
    const ada = await ranFor(by, workflow.id, 1, "Ada");
    const grace = await ranFor(by, workflow.id, 1, "Grace");
    const declared = ["route", "greetAda", "greetOther", "finished"];
    expect({
      ada: pathOf(await resourceRunTrace(env, by, workflow.id, ada)),
      grace: pathOf(await resourceRunTrace(env, by, workflow.id, grace)),
    }).toStrictEqual({
      ada: {
        status: "completed",
        declared,
        reached: ["finished reached", "greetAda reached", "route reached"],
      },
      grace: {
        status: "completed",
        declared,
        reached: ["finished reached", "greetOther reached", "route reached"],
      },
    });
  });

  it("is drawn over the run's own version, not one published since, and shows where it failed", async () => {
    const by = await person();
    const workflow = await createWorkflowResource(
      env,
      by,
      `traced-${unique()}`
    );
    await publishDefinition(
      env,
      by,
      workflow.id,
      definitionOf([failing("mark")])
    );
    const failed = await ranFor(by, workflow.id, 1, "Ada");
    await publishDefinition(env, by, workflow.id, definitionOf(routing));
    expect(
      pathOf(await resourceRunTrace(env, by, workflow.id, failed))
    ).toStrictEqual({
      status: "failed",
      declared: ["mark"],
      reached: ["mark failed"],
    });
  });

  it("lists each step in the order the run reached it, with the loop item it ran in and when it ran", async () => {
    const by = await person();
    const workflow = await createWorkflowResource(
      env,
      by,
      `traced-${unique()}`
    );
    await publishDefinition(
      env,
      by,
      workflow.id,
      definitionOf([
        passing("init"),
        {
          id: "eachName",
          type: "forEach",
          items: { $expr: '["Ada", "Grace"]' },
          do: [passing("note")],
        },
        passing("finished"),
      ])
    );
    const run = await ranFor(by, workflow.id, 1, "Ada");
    const { steps } = await resourceRunTrace(env, by, workflow.id, run);
    const timed = steps.every(
      ({ startedAt, endedAt }) =>
        endedAt !== null && Date.parse(startedAt) <= Date.parse(endedAt)
    );
    expect({
      steps: steps.map(
        ({ task, item, state, errorCode }) =>
          `${task}${item === null ? "" : `@${item}`} ${state} ${errorCode ?? "-"}`
      ),
      ordered: steps.every(
        (step, index) =>
          index === 0 || (steps[index - 1]?.ordinal ?? 0) < step.ordinal
      ),
      timed,
    }).toStrictEqual({
      steps: [
        "init reached -",
        "note@0 reached -",
        "note@1 reached -",
        "finished reached -",
      ],
      ordered: true,
      timed: true,
    });
  });

  it("names the code each failed step failed with", async () => {
    const by = await person();
    const workflow = await createWorkflowResource(
      env,
      by,
      `traced-${unique()}`
    );
    await publishDefinition(
      env,
      by,
      workflow.id,
      definitionOf([failing("mark")])
    );
    const raiser = await createWorkflowResource(env, by, `traced-${unique()}`);
    await publishDefinition(
      env,
      by,
      raiser.id,
      definitionOf([raising("refuse")])
    );
    const failed = await ranFor(by, workflow.id, 1, "Ada");
    const raised = await ranFor(by, raiser.id, 1, "Ada");
    expect({
      failed: shown(await resourceRunTrace(env, by, workflow.id, failed)),
      raised: shown(await resourceRunTrace(env, by, raiser.id, raised)),
    }).toStrictEqual({
      failed: [
        { task: "mark", state: "failed", errorCode: "workflow.call_invalid" },
      ],
      // A raise has no step: its code throws it, and the run fails with
      // it, no step of it to show.
      raised: [],
    });
  });

  it("shows nothing a run reached once its retention is over", async () => {
    const by = await person();
    const workflow = await createWorkflowResource(
      env,
      by,
      `traced-${unique()}`
    );
    await publishDefinition(env, by, workflow.id, definitionOf(routing));
    const run = await ranFor(by, workflow.id, 1, "Ada");
    // Past the 30 days its details are kept.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
    let trace: WorkflowRunTrace;
    try {
      trace = await resourceRunTrace(env, by, workflow.id, run);
    } finally {
      vi.useRealTimers();
    }
    expect({
      removed: trace.detailsRemoved,
      reached: trace.tasks,
      steps: trace.steps,
      declared: declaredIn(trace.diagram.tasks).length,
    }).toStrictEqual({ removed: true, reached: [], steps: [], declared: 4 });
  });

  it("is only for the workflow's builders, and only of its own runs", async () => {
    const by = await person();
    const user = await person("user");
    const workflow = await createWorkflowResource(
      env,
      by,
      `traced-${unique()}`
    );
    const other = await createWorkflowResource(env, by, `traced-${unique()}`);
    await publishDefinition(env, by, workflow.id, definitionOf(routing));
    await shareWorkflowResource(env, by, workflow.id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const run = await ranFor(user, workflow.id, 1, "Ada");
    expect({
      user: await outcome(resourceRunTrace(env, user, workflow.id, run)),
      elsewhere: await outcome(resourceRunTrace(env, by, other.id, run)),
    }).toStrictEqual({
      user: "role.forbidden",
      elsewhere: "workflow.run_unavailable",
    });
  });
});

// Read over the session API (`workflowResources.runTrace`), as the
// workflow's pages read it. What could go wrong, tried below: a try's
// retry of a failed step told as steps of no task, or left out, or as a
// second step; a decision's wait left out, so its task shows nothing
// while it waits, or told as done before it was answered; a run longer
// than a trace reads shown as though it were all of it.

const idp = mockIdp();

/** A builder signed in, and as core's own calls take them. */
const signedInBuilder = async () => {
  const session = await signedInApi(idp, "builder");
  const acting: Acting = {
    userId: session.userId,
    role: "builder",
    teams: [],
    staff: false,
  };
  return { ...session, acting };
};

/** A trace's steps as lines: task, state, attempts and failure's code. */
const toldOf = ({ steps }: Pick<WorkflowRunTrace, "steps">) =>
  steps.map(
    ({ task, state, attempts, errorCode }) =>
      `${task} ${state} ${attempts} ${errorCode ?? "-"}`
  );

/**
 * A mail connection `by`'s workflow `id` sends through as `mail`, granted
 * and approved by `admin`, to a mail server unavailable for longer than
 * any retry.
 */
const unavailableMail = async (
  by: Acting,
  admin: Identity,
  id: string
): Promise<void> => {
  const mail = await mailConnection(
    Array.from({ length: 50 }, () => "unavailable" as const)
  );
  const asked = await requestPermission(
    env,
    by,
    {
      subject: { type: "workflow", workflowId: id },
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.send"],
      binding: `MAIL_${unique().toUpperCase().replaceAll("-", "_")}`,
    },
    {
      app: () => {
        throw new Error("No App here");
      },
      resource: async (ref, needed) => {
        await requireResourceRole(env, by, ref, needed);
      },
    }
  );
  await grantPermission(env, admin, asked.id, { version: null });
  await approveWorkflowBinding(serving, admin, id, {
    alias: "mail",
    target: {
      kind: "connector",
      permissionId: asked.id,
      contract: "composio.mail@1",
    },
    reviewed: { version: 1 },
  });
};

describe("a run's trace, read over the session API", () => {
  it("tells a try's retries of a failed step as that one step's attempts", async () => {
    const admin = await identityOf("admin");
    const builder = await signedInBuilder();
    const contract = `mail-${unique()}`;
    await publishCatalogContract(env, admin, {
      key: contract,
      kind: "connector",
      operations: {
        "mail.send": {
          input: descriptorOf(mailInput),
          output: descriptorOf(mailOutput),
        },
      },
    });
    const workflow = await createWorkflowResource(
      env,
      builder.acting,
      `traced-${unique()}`
    );
    await publishDefinition(
      env,
      builder.acting,
      workflow.id,
      definitionOf(
        [
          {
            id: "guard",
            type: "try",
            try: [
              {
                id: "notify",
                type: "call",
                connection: "mail",
                action: "mail.send",
                args: { to: { $expr: "args.who" }, subject: "Hello" },
              },
            ],
            catch: {
              retry: { attempts: 3, delay: "1 second", backoff: "constant" },
              do: [passing("fellBack")],
            },
          },
        ],
        { connections: { mail: { contract } } }
      )
    );
    await unavailableMail(builder.acting, admin, workflow.id);
    const runId = await ranFor(builder.acting, workflow.id, 1, "Ada", serving);

    const whole = await builder.api.workflowResources.runTrace(
      workflow.id,
      runId
    );

    expect({
      status: whole.status,
      steps: toldOf(whole),
      task: whole.tasks.find(({ task }) => task === "notify"),
    }).toStrictEqual({
      status: "completed",
      // One step of nine attempts in all, failed at the last, which the
      // catch took, then the step its catch runs: the catch's three
      // rounds, each of the engine's three tries of a call that may work
      // when tried again (sealed-run.ts, `sealedRetries`).
      steps: [
        "notify failed 9 connect.server_unavailable",
        "fellBack reached 0 -",
      ],
      task: { task: "notify", state: "failed", attempts: 9 },
    });
  });

  it("tells a decision's wait by the decision's task: waiting until it is answered, then reached", async () => {
    const admin = await identityOf("admin");
    const reviewer = await identityOf("user");
    const builder = await signedInBuilder();
    const contract = `approval-${unique()}`;
    await publishCatalogContract(env, admin, {
      key: contract,
      kind: "decision",
      input: JSON.stringify(v.object({ who: v.string() }).descriptor),
      response: JSON.stringify(v.object({ comment: v.string() }).descriptor),
    });
    const workflow = await createWorkflowResource(
      env,
      builder.acting,
      `traced-${unique()}`
    );
    await publishDefinition(
      env,
      builder.acting,
      workflow.id,
      definitionOf(
        [
          {
            id: "ask",
            type: "decide",
            decision: "approval",
            recipients: [`person:${reviewer.userId}`],
            prompt: "Greet them?",
            input: { who: { $expr: "args.who" } },
          },
          passing("finish"),
        ],
        { decisions: { approval: { contract } } }
      )
    );
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "approval",
      target: { kind: "decision", deciders: [`person:${reviewer.userId}`] },
      reviewed: { version: 1 },
    });
    const { runId } = await startWorkflow(
      env,
      { type: "person", person: builder.acting },
      workflow.id,
      { expected: 1, args: { who: "Ada" }, key: unique() }
    );
    if (runId === null) {
      throw new Error("The start made a run");
    }
    const traceNow = async () =>
      await builder.api.workflowResources.runTrace(workflow.id, runId);
    const waiting = await vi.waitFor(
      async () => {
        const trace = await traceNow();
        if (!trace.steps.some(({ state }) => state === "waiting")) {
          throw new Error("The run isn't waiting for its decision yet");
        }
        return trace;
      },
      { timeout: 30_000, interval: 100 }
    );
    const decision = await env.DB.prepare(
      "SELECT id FROM workflow_decisions WHERE resource_run_id = ?"
    )
      .bind(runId)
      .first<{ id: string }>();
    if (decision === null) {
      throw new Error("The run opened no decision");
    }
    const answer = { approved: true, payload: { comment: "Looks right" } };
    const review = await reviewDecision(env, reviewer, decision.id, answer);
    if (review.state !== "review") {
      throw new Error("Nothing to review");
    }
    const { confirmation } = await confirmDecision(
      env,
      reviewer,
      decision.id,
      review.decision.revision,
      review.response
    );
    await answerDecision(
      env,
      reviewer,
      decision.id,
      review.response,
      confirmation
    );
    await vi.waitFor(
      async () => {
        const run = await resourceRunFor(
          env,
          builder.acting,
          workflow.id,
          runId
        );
        expect(run.endedAt).not.toBeNull();
      },
      { timeout: 30_000, interval: 100 }
    );
    const answered = await traceNow();
    const asked = answered.steps.filter(({ task }) => task === "ask");

    expect({
      waiting: toldOf(waiting),
      waitingTask: waiting.tasks.find(({ task }) => task === "ask")?.state,
      waitingEnd: waiting.steps.at(-1)?.endedAt,
      answered: toldOf(answered),
      ended: asked.every(
        ({ startedAt, endedAt }) =>
          endedAt !== null && Date.parse(startedAt) <= Date.parse(endedAt)
      ),
    }).toStrictEqual({
      // Its enter step opened the decision; its call step waits on it.
      waiting: ["ask reached 1 -", "ask waiting 1 -"],
      waitingTask: "waiting",
      waitingEnd: null,
      answered: ["ask reached 1 -", "ask reached 1 -", "finish reached 0 -"],
      ended: true,
    });
  });

  it(
    "says when it shows only the first part of a run whose journal is longer than one trace reads",
    { timeout: 200_000 },
    async () => {
      const builder = await signedInBuilder();
      const long = await createWorkflowResource(
        env,
        builder.acting,
        `traced-${unique()}`
      );
      // More records than a trace reads: some four an item's step.
      const items = 600;
      await publishDefinition(
        env,
        builder.acting,
        long.id,
        definitionOf([
          {
            id: "eachName",
            type: "forEach",
            items: { $expr: `${JSON.stringify("x".repeat(items))}.split("")` },
            do: [quick("note")],
          },
          passing("finished"),
        ])
      );
      const short = await createWorkflowResource(
        env,
        builder.acting,
        `traced-${unique()}`
      );
      await publishDefinition(
        env,
        builder.acting,
        short.id,
        definitionOf(routing)
      );
      const traceOf = async (id: string, runId: string) =>
        await builder.api.workflowResources.runTrace(id, runId);
      // Room for the loop's steps, past the tests' lowered step limit,
      // while the long run journals more than a trace reads: its engine
      // holds a record past the 2,000th. Read then, ended or not.
      const configuredLimits = env.TEST_QUOTA_LIMITS;
      env.TEST_QUOTA_LIMITS = { workflowSteps: 1000 };
      let longTrace: WorkflowRunTrace;
      try {
        const { runId: longRun } = await startWorkflow(
          env,
          { type: "person", person: builder.acting },
          long.id,
          { expected: 1, args: { who: "Ada" }, key: unique() }
        );
        if (longRun === null) {
          throw new Error("The start made a run");
        }
        await vi.waitFor(
          async () => {
            const past = await runObjectOf(env, longRun).history({
              after: 2000,
              limit: 1,
            });
            expect(past?.records.length ?? 0).toBeGreaterThan(0);
          },
          { timeout: 150_000, interval: 200 }
        );
        longTrace = await traceOf(long.id, longRun);
      } finally {
        env.TEST_QUOTA_LIMITS = configuredLimits;
      }
      const shortRun = await ranFor(builder.acting, short.id, 1, "Ada");
      const shortTrace = await traceOf(short.id, shortRun);
      const notes = longTrace.steps.filter(({ task }) => task === "note");

      expect({
        long: {
          truncated: longTrace.truncated,
          // Its first items, in order, short of all of them and of the
          // task after the loop.
          // Two steps an item's run: its enter step and its own.
          firstItems: notes.every(
            ({ item }, index) => item === String(Math.floor(index / 2))
          ),
          some: notes.length > 0 && notes.length < 2 * items,
          finished: longTrace.steps.some(({ task }) => task === "finished"),
        },
        short: {
          truncated: shortTrace.truncated,
          steps: shortTrace.steps.length,
        },
      }).toStrictEqual({
        long: {
          truncated: true,
          firstItems: true,
          some: true,
          finished: false,
        },
        // `greetAda` and `finished`: an `if` has no step.
        short: { truncated: false, steps: 2 },
      });
    }
  );
});
