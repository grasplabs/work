/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
import { v } from "@grasp-os/sdk";
import type { Role } from "@grasp-os/shared/roles";
import type { WorkflowRunTrace } from "@grasp-os/shared/workflow-diagrams";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import {
  answerDecision,
  confirmDecision,
  reviewDecision,
} from "../src/decisions/decisions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunTrace } from "../src/workflows/resource-run-trace.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns } from "./runs.ts";
import { person as identityOf } from "./sealed-apps.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

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

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

const definitionOf = (
  name: string,
  version: string,
  tasks: unknown[],
  bindings: Record<string, unknown> = {}
) =>
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
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: tasks,
  });

/** Spec 13.9's routing, by who: branches that join explicitly. */
const routing = [
  {
    route: {
      switch: [
        {
          ada: { when: '${ $workflow.input.who == "Ada" }', then: "greet-ada" },
        },
        { anyone: { then: "greet-other" } },
      ],
    },
  },
  { "greet-ada": { set: { status: "ada" }, then: "finished" } },
  { "greet-other": { set: { status: "other" }, then: "finished" } },
  { finished: { set: "${ . }" } },
];

/** Starts version `version` of workflow `id` for `who`, and waits for its end. */
const ranFor = async (
  by: Acting,
  id: string,
  version: number,
  who: string
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version, input: { who }, key: unique() }
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

/** A trace as lines: what the diagram declares, and what the run reached. */
const pathOf = (trace: WorkflowRunTrace) => ({
  status: trace.status,
  declared: trace.diagram.tasks.map(({ id }) => id),
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
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: definitionOf(workflow.name, "1.0.0", routing),
      basedOn: null,
    });
    const ada = await ranFor(by, workflow.id, 1, "Ada");
    const grace = await ranFor(by, workflow.id, 1, "Grace");
    const declared = ["route", "greet-ada", "greet-other", "finished"];
    expect({
      ada: pathOf(await resourceRunTrace(env, by, workflow.id, ada)),
      grace: pathOf(await resourceRunTrace(env, by, workflow.id, grace)),
    }).toStrictEqual({
      ada: {
        status: "completed",
        declared,
        reached: ["finished reached", "greet-ada reached", "route reached"],
      },
      grace: {
        status: "completed",
        declared,
        reached: ["finished reached", "greet-other reached", "route reached"],
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
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: definitionOf(workflow.name, "1.0.0", [
        {
          mark: {
            set: { status: "marked" },
            export: {
              as: '${ {count: "not a number"} }',
              schema: objectSchema({ count: { type: "integer" } }),
            },
          },
        },
      ]),
      basedOn: null,
    });
    const failed = await ranFor(by, workflow.id, 1, "Ada");
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: definitionOf(workflow.name, "2.0.0", routing),
      basedOn: 1,
    });
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
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: definitionOf(workflow.name, "1.0.0", [
        { init: { set: "${ . }", export: { as: "${ {seen: []} }" } } },
        {
          "each-name": {
            for: { each: "name", in: '${ ["Ada", "Grace"] }', at: "i" },
            do: [
              {
                note: {
                  set: "${ . }",
                  export: { as: "${ {seen: ($context.seen + [$name])} }" },
                },
              },
            ],
          },
        },
        { finished: { set: '${ {status: ($context.seen | join(","))} }' } },
      ]),
      basedOn: null,
    });
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
        "each-name reached -",
        "note@each-name.0 reached -",
        "note@each-name.1 reached -",
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
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: definitionOf(workflow.name, "1.0.0", [
        {
          mark: {
            set: { status: "marked" },
            export: {
              as: '${ {count: "not a number"} }',
              schema: objectSchema({ count: { type: "integer" } }),
            },
          },
        },
      ]),
      basedOn: null,
    });
    const raising = await createWorkflowResource(env, by, `traced-${unique()}`);
    await publishWorkflowVersion(env, by, raising.id, {
      definition: definitionOf(raising.name, "1.0.0", [
        {
          refuse: {
            raise: {
              error: {
                type: "urn:grasp:error:refused",
                status: 409,
                title: "Refused.",
              },
            },
          },
        },
      ]),
      basedOn: null,
    });
    const failed = await ranFor(by, workflow.id, 1, "Ada");
    const raised = await ranFor(by, raising.id, 1, "Ada");
    expect({
      failed: shown(await resourceRunTrace(env, by, workflow.id, failed)),
      raised: shown(await resourceRunTrace(env, by, raising.id, raised)),
    }).toStrictEqual({
      failed: [
        {
          task: "mark",
          state: "failed",
          errorCode: "workflow.task_data_invalid",
        },
      ],
      raised: [
        { task: "refuse", state: "failed", errorCode: "workflow.raised" },
      ],
    });
  });

  it("shows nothing a run reached once its retention is over", async () => {
    const by = await person();
    const workflow = await createWorkflowResource(
      env,
      by,
      `traced-${unique()}`
    );
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: definitionOf(workflow.name, "1.0.0", routing),
      basedOn: null,
    });
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
      declared: trace.diagram.tasks.length,
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
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: definitionOf(workflow.name, "1.0.0", routing),
      basedOn: null,
    });
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
// while it waits, or told as done before it was answered; a page leaving
// a step out, or telling one twice, or a step's retries split across
// pages.

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

type Builder = Awaited<ReturnType<typeof signedInBuilder>>;

/** Every step of run `runId`'s trace, `pageSize` at a time, and its pages. */
const pagedTrace = async (
  builder: Builder,
  id: string,
  runId: string,
  pageSize: number
) => {
  const pages: WorkflowRunTrace[] = [];
  let cursor: string | null = null;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page goes on from the one before
    const page: WorkflowRunTrace = await builder.api.workflowResources.runTrace(
      id,
      runId,
      {
        doors: false,
        pageSize,
        cursor,
      }
    );
    pages.push(page);
    ({ nextCursor: cursor } = page);
  } while (cursor !== null);
  return { steps: pages.flatMap(({ steps }) => steps), pages };
};

/** A trace's steps as lines: task, state, attempts and failure's code. */
const toldOf = ({ steps }: Pick<WorkflowRunTrace, "steps">) =>
  steps.map(
    ({ task, state, attempts, errorCode }) =>
      `${task} ${state} ${attempts} ${errorCode ?? "-"}`
  );

/** A compute module whose `fail` always fails, as a flaky dependency's. */
const failingModule = `import { compute, v } from "@grasp-os/sdk/compute";

export const fail = compute({
  input: v.string(),
  output: v.string(),
  handler: () => {
    throw new Error("The rates service didn't answer.");
  },
});
`;

describe("a run's trace, read over the session API", () => {
  afterEach(endLiveRuns);

  it("tells a try's retries of a failed step as that one step's attempts, on whichever page", async () => {
    const builder = await signedInBuilder();
    const workflow = await createWorkflowResource(
      env,
      builder.acting,
      `traced-${unique()}`
    );
    await publishWorkflowVersion(env, builder.acting, workflow.id, {
      definition: definitionOf(
        workflow.name,
        "1.0.0",
        [
          {
            guard: {
              try: [
                {
                  "fetch-rates": {
                    call: "grasp.compute",
                    with: { binding: "rates", arguments: "${ .who }" },
                  },
                },
              ],
              catch: {
                retry: {
                  delay: { milliseconds: 50 },
                  backoff: { constant: {} },
                  limit: { attempt: { count: 3 } },
                },
                do: [{ "fell-back": { set: { status: "fallback" } } }],
              },
            },
          },
        ],
        { rates: { kind: "compute", contract: "local:code/rates.ts#fail" } }
      ),
      basedOn: null,
      modules: { "code/rates.ts": failingModule },
    });
    const runId = await ranFor(builder.acting, workflow.id, 1, "Ada");

    const whole = await builder.api.workflowResources.runTrace(
      workflow.id,
      runId,
      { doors: false }
    );
    const paged = await pagedTrace(builder, workflow.id, runId, 1);

    expect({
      status: whole.status,
      steps: toldOf(whole),
      task: whole.tasks.find(({ task }) => task === "fetch-rates"),
      complete: whole.complete,
      paged: paged.steps,
    }).toStrictEqual({
      status: "completed",
      // One step of three attempts in all, failed at the last, which the
      // catch took: the try's enter and catch steps around it.
      steps: [
        "guard reached 1 -",
        "fetch-rates failed 3 workflow.compute_failed",
        "guard reached 1 -",
        "fell-back reached 1 -",
      ],
      task: { task: "fetch-rates", state: "failed", attempts: 3 },
      complete: true,
      paged: whole.steps,
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
    await publishWorkflowVersion(env, builder.acting, workflow.id, {
      definition: definitionOf(
        workflow.name,
        "1.0.0",
        [
          {
            ask: {
              call: "grasp.decision",
              with: {
                binding: "approval",
                recipients: [`person:${reviewer.userId}`],
                prompt: "Greet them?",
                input: { who: "${ $workflow.input.who }" },
              },
            },
          },
          { finish: { set: { status: "done" } } },
        ],
        { approval: { kind: "decision", contract } }
      ),
      basedOn: null,
    });
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "approval",
      target: { kind: "decision", deciders: [`person:${reviewer.userId}`] },
      reviewed: { version: 1 },
    });
    const { runId } = await startWorkflow(
      env,
      { type: "person", person: builder.acting },
      workflow.id,
      { version: 1, input: { who: "Ada" }, key: unique() }
    );
    if (runId === null) {
      throw new Error("The start made a run");
    }
    const traceNow = async () =>
      await builder.api.workflowResources.runTrace(workflow.id, runId, {
        doors: false,
      });
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
      waiting: ["ask reached 1 -", "ask waiting 0 -"],
      waitingTask: "waiting",
      waitingEnd: null,
      answered: ["ask reached 1 -", "ask reached 1 -", "finish reached 1 -"],
      ended: true,
    });
  });

  it("reads a run longer than a page in pages, each step once and none left out", async () => {
    const builder = await signedInBuilder();
    const workflow = await createWorkflowResource(
      env,
      builder.acting,
      `traced-${unique()}`
    );
    const names = Array.from({ length: 12 }, (_, index) => `n${index}`);
    await publishWorkflowVersion(env, builder.acting, workflow.id, {
      definition: definitionOf(workflow.name, "1.0.0", [
        { init: { set: "${ . }", export: { as: "${ {seen: []} }" } } },
        {
          "each-name": {
            for: {
              each: "name",
              in: `\${ ${JSON.stringify(names)} }`,
              at: "i",
            },
            do: [
              {
                note: {
                  set: "${ . }",
                  export: { as: "${ {seen: ($context.seen + [$name])} }" },
                },
              },
            ],
          },
        },
        { finished: { set: '${ {status: ($context.seen | join(","))} }' } },
      ]),
      basedOn: null,
    });
    const runId = await ranFor(builder.acting, workflow.id, 1, "Ada");

    const whole = await builder.api.workflowResources.runTrace(
      workflow.id,
      runId,
      { doors: false }
    );
    const paged = await pagedTrace(builder, workflow.id, runId, 5);

    expect({
      steps: paged.steps.map(
        ({ task, item }) => `${task}${item === null ? "" : `@${item}`}`
      ),
      pages: paged.pages.map(({ steps, complete }) => ({
        steps: steps.length,
        complete,
      })),
      // The same steps as one page holds, told the same.
      same: paged.steps,
    }).toStrictEqual({
      steps: [
        "init",
        "each-name",
        ...names.map((_, index) => `note@each-name.${index}`),
        "finished",
      ],
      // Fifteen steps: three pages, the last full, and none after it.
      pages: [
        { steps: 5, complete: false },
        { steps: 5, complete: false },
        { steps: 5, complete: true },
      ],
      same: whole.steps,
    });
  });
});
