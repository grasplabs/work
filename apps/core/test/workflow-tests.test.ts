/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { v } from "@grasp-os/sdk";
import { declaredWorkflows, workflowFingerprint } from "@grasp-os/sdk/host";
import { expectedMessageOf, isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { activateVersion } from "../src/app-activation.ts";
import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { fixtureHostFor, sweepTestFixtures } from "../src/app-tests.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import {
  appFor,
  commitFiles,
  findApp,
  setCurrentVersion,
} from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { actionMainModule } from "../src/workflow-modules.ts";
import { setWorkflowParams } from "../src/workflow-params.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import { auditedDuring, unique } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// Workflow tests of an App (`workflowTest`, spec 28.2): a test principal
// starts a workflow the release under test binds, and the run is real, on
// the engine, the same version as anyone's, but nothing of the
// organization's. The threat model is in workflows/fixture-runs.ts; the
// ways it can fail come first here: a test's run lands in the
// organization's runs, receipts or audit; it reaches a model, an App or a
// store; it outlives its test, or a test died before removing it; a test
// asks about a run it didn't start; a test starts what the release
// doesn't bind. Then what a test sees: the run's end, and how often each
// task completed.

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A workflow `name` of `tasks`, its input `who` and output `status`. */
const definitionOf = (
  name: string,
  tasks: unknown[],
  bindings: Record<string, unknown> = {},
  params: Record<string, unknown> = {}
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params, bindings },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: tasks,
  });

/** Greets its input's `who`, after `before`. */
const greeting = (before: unknown[] = []) => [
  ...before,
  { greet: { set: { status: '${ "Hello, " + $workflow.input.who }' } } },
];

/** The App's files: it binds `followUp`, with `tests` as its tests. */
const filesWith = (
  tests: Record<string, string> = {},
  /** The parameter values the fixture gives each workflow, by alias. */
  workflows?: Record<string, { params: Record<string, unknown> }>
): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  requests: defineTable({ who: v.string() }),
});
`,
  "operations/requests.ts": `import { resource, v } from "@grasp-os/sdk";

export const followUp = resource.workflow("followUp", {
  input: v.object({ who: v.string().trim().min(1) }),
  output: v.object({ status: v.string() }),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { followUp } from "./operations/requests.ts";
import schema from "./schema.ts";

export default app({
  name: "Requests",
  schema,
  access: { tables: { requests: { read: "appMembers", write: "appMembers" } } },
  operations: {},
  screens: [],
  uses: [followUp],
});
`,
  "tests/fixtures/desk.json": JSON.stringify({
    principals: { "desk-user": { role: "user" } },
    ...(workflows === undefined ? {} : { workflows }),
  }),
  ...tests,
});

/** A connector contract of the catalog `admin` publishes: `mail.send`. */
const mailContract = async (admin: Identity): Promise<string> => {
  const key = `mail-${unique()}`;
  await publishCatalogContract(env, admin, {
    key,
    kind: "connector",
    operations: {
      "mail.send": {
        input: JSON.stringify(
          v.object({ to: v.string(), subject: v.string() }).descriptor
        ),
        output: JSON.stringify(v.object({ messageId: v.string() }).descriptor),
      },
    },
  });
  return key;
};

/** A workflow of `by`'s, its version 1 `tasks`, and `bindings`. */
const workflowOf = async (
  by: Acting,
  tasks: unknown[],
  bindings: Record<string, unknown> = {},
  {
    params = {},
    modules,
  }: {
    params?: Record<string, unknown>;
    modules?: Record<string, string>;
  } = {}
): Promise<string> => {
  const workflow = await createWorkflowResource(env, by, `greet-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: definitionOf(workflow.name, tasks, bindings, params),
    basedOn: null,
    ...(modules === undefined ? {} : { modules }),
  });
  return workflow.id;
};

/** The Requests App with `tests`, binding workflow `workflow` as `followUp`. */
const requestsApp = async (
  workflow: (by: Acting) => Promise<string>,
  tests: Record<string, string> = {},
  workflows?: Record<string, { params: Record<string, unknown> }>
) => {
  const builder = await person("builder");
  const fixture = await appWith(
    filesWith(tests, workflows),
    "Requests",
    builder
  );
  const workflowId = await workflow(builder);
  await bindWorkflowToApp(env, builder, workflowId, {
    app: fixture.app,
    alias: "followUp",
    version: 1,
  });
  await seal(fixture);
  const release = await loadRelease(env, fixture.app, 1);
  return { builder, app: fixture.app, workflowId, release };
};

/** A start of `followUp` with `input`, as the SDK sends it. */
const startOf = async (
  release: Release,
  input: unknown,
  change: (wire: Record<string, unknown>) => void = () => {
    // As generated.
  }
): Promise<string> => {
  const declared = declaredWorkflows(release.app, release.workflows).find(
    ({ alias }) => alias === "followUp"
  );
  if (declared === undefined) {
    throw new Error("No followUp");
  }
  const wire: Record<string, unknown> = {
    resourceId: release.manifest.resourceId,
    resourceVersion: release.manifest.resourceVersion,
    contractId: "workflows.followUp",
    fingerprint: await workflowFingerprint(declared),
    kind: "workflow",
  };
  change(wire);
  return JSON.stringify({
    workflow: wire,
    command: "start",
    input,
    idempotencyKey: "0".repeat(32),
  });
};

const resultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.object({ run: z.number() }) }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
]);

/** What a session's start answered: the run's number, or the refusal's code. */
const startedAs = (answer: string): number | string => {
  const result = resultSchema.parse(JSON.parse(answer));
  return result.ok ? result.value.run : result.error.code;
};

/**
 * A test session on the Requests App's release, for `desk-user`, its
 * fixture giving `workflows` their parameters, on `on`.
 */
const sessionOf = async (
  release: Release,
  {
    workflows,
    on = env,
  }: {
    workflows?: Record<string, { params: Record<string, unknown> }>;
    on?: Env;
  } = {}
) => {
  const host = fixtureHostFor(on, release, filesWith({}, workflows));
  return await host.open("desk", `test-${unique()}`);
};

/** How run `run` of `session` ended, as the test is told. */
const endOf = async (
  session: Awaited<ReturnType<typeof sessionOf>>,
  run: number | string
): Promise<unknown> => JSON.parse(await session.runOutcome(run));

/** The test runs core still records for `app`. */
const recordedRuns = async (app: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT run_id AS id FROM app_test_runs WHERE app_id = ?"
  )
    .bind(app)
    .all<{ id: string }>();
  return results.map(({ id }) => id);
};

/** The organization's receipts and runs of `workflow`. */
const organizationRunsOf = async (workflow: string) => {
  const receipts = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM workflow_start_receipts WHERE workflow_resource_id = ?"
  )
    .bind(workflow)
    .first<{ n: number }>();
  const runs = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM workflow_resource_runs WHERE workflow_resource_id = ?"
  )
    .bind(workflow)
    .first<{ n: number }>();
  return { receipts: receipts?.n, runs: runs?.n };
};

/** Activates version 1: whether it was made current, or the refusal's failures. */
const activated = async (
  by: Acting & Identity,
  app: string
): Promise<unknown> => {
  try {
    await activateVersion(env, by, app, 1);
  } catch (error) {
    if (!isExpectedError(error)) {
      throw error;
    }
    return error.details?.failures ?? error.code;
  }
  const found = await findApp(env, app);
  return found.currentVersion === 1 ? "current" : found.currentVersion;
};

/** The calls connect has a record of, whoever made them. */
const connectCalls = async (): Promise<number> => {
  const row = await connectDb()
    .prepare("SELECT COUNT(*) AS n FROM idempotent_calls")
    .first<{ n: number }>();
  return row?.n ?? -1;
};

/** Whether `work` answered or was refused. */
const refusal = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
    return "answered";
  } catch (error) {
    return error instanceof Error ? "refused" : "thrown";
  }
};

/** A suite of one workflow test, `body` with `owner` at hand. */
const suiteOf = (
  body: string
): string => `import { workflowTest } from "@grasp-os/sdk/testing";
import { workflows } from "#grasp";

export default workflowTest({
  fixtures: "desk",
  tests: {
    "runs": async (t) => {
      const owner = await t.as("desk-user");
      ${body}
    },
  },
});
`;

describe("an App's workflow tests", { timeout: 180_000 }, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("run the workflow the release binds on the engine, to its end, each task completed once, and leave nothing of the organization's", async () => {
    const { builder, app, workflowId } = await requestsApp(
      async (by) =>
        await workflowOf(by, greeting([{ hold: { wait: "PT1S" } }])),
      {
        "tests/greet.test.ts": suiteOf(`
      const run = await owner.start(workflows.followUp, { who: "Ada" });
      t.equal(await t.runs.untilTerminal(run), {
        status: "completed",
        output: { status: "Hello, Ada" },
      });
      t.equal(await t.effects.completedCount(run, "greet"), 1);
      t.equal(await t.effects.completedCount(run, "hold"), 1);
      t.equal(await t.effects.completedCount(run, "elsewhere"), 0);`),
      }
    );
    let outcome: unknown;
    const events = await auditedDuring(async () => {
      outcome = await activated(builder, app);
    });
    expect({
      outcome,
      organization: await organizationRunsOf(workflowId),
      recorded: await recordedRuns(app),
      runEvents: events.filter(({ action }) => action.startsWith("workflow.")),
    }).toStrictEqual({
      outcome: "current",
      organization: { receipts: 0, runs: 0 },
      recorded: [],
      runEvents: [],
    });
  });

  it("refuse a version whose workflow test fails, saying how the run ended", async () => {
    const { builder, app } = await requestsApp(
      async (by) =>
        await workflowOf(by, [
          {
            greet: {
              set: { status: "${ $workflow.input.who | tonumber | tostring }" },
            },
          },
        ]),
      {
        "tests/greet.test.ts": suiteOf(`
      const run = await owner.start(workflows.followUp, { who: "Ada" });
      const ended = await t.runs.untilTerminal(run);
      t.equal(ended.status, "completed", "the run");`),
      }
    );
    await expect(activated(builder, app)).resolves.toStrictEqual([
      'tests/greet.test.ts, "runs": the run: expected "completed", got "failed"',
    ]);
  });

  it("refuse a start of what the release doesn't bind, or with input it doesn't take", async () => {
    const { release, app } = await requestsApp(
      async (by) => await workflowOf(by, greeting())
    );
    const session = await sessionOf(release);
    const refused = {
      fingerprint: startedAs(
        await session.start(
          "desk-user",
          await startOf(release, { who: "Ada" }, (wire) => {
            wire.fingerprint = "f".repeat(64);
          })
        )
      ),
      alias: startedAs(
        await session.start(
          "desk-user",
          await startOf(release, { who: "Ada" }, (wire) => {
            wire.contractId = "workflows.elsewhere";
          })
        )
      ),
      release: startedAs(
        await session.start(
          "desk-user",
          await startOf(release, { who: "Ada" }, (wire) => {
            wire.resourceVersion = 2;
          })
        )
      ),
      input: startedAs(
        await session.start("desk-user", await startOf(release, { who: "" }))
      ),
      notAStart: startedAs(
        await session.start(
          "desk-user",
          JSON.stringify({ reference: {}, input: {} })
        )
      ),
    };
    await session.close();
    expect({ refused, recorded: await recordedRuns(app) }).toStrictEqual({
      refused: {
        fingerprint: "version.mismatch",
        alias: "operation.not_found",
        release: "version.mismatch",
        input: "contract.invalid_args",
        notAStart: "contract.invalid_request",
      },
      recorded: [],
    });
  });

  it("refuse every call that leaves the run's own code: a model is never asked", async () => {
    const admin = await person("admin");
    const key = `summary-${unique()}`;
    await publishCatalogContract(env, admin, { key, kind: "model" });
    const { release } = await requestsApp(
      async (by) =>
        await workflowOf(
          by,
          [
            {
              greet: {
                call: "grasp.model",
                with: {
                  binding: "summary",
                  instructions: "Greet them.",
                  input: { who: "${ $workflow.input.who }" },
                  outputSchema: objectSchema({ line: { type: "string" } }),
                },
                export: { as: "${ {line: .line} }" },
              },
            },
            { finish: { set: { status: "${ $context.line }" } } },
          ],
          { summary: { kind: "model", contract: key } }
        )
    );
    const gateway = fakeGateway({
      text: '{"line":"Hello"}',
      inputTokens: 1,
      outputTokens: 1,
    });
    const ai: AiBinding = env.AI;
    vi.spyOn(ai, "fetch").mockImplementation(gateway.binding.fetch);
    const session = await sessionOf(release);
    const run = startedAs(
      await session.start("desk-user", await startOf(release, { who: "Ada" }))
    );
    const ended: unknown = JSON.parse(await session.runOutcome(run));
    const completed = await session.completedCount(run, "greet");
    await session.close();
    expect({ ended, completed, asked: gateway.requests.length }).toMatchObject({
      ended: { status: "failed", code: "resource.unavailable" },
      completed: 0,
      asked: 0,
    });
  });

  it("answer only about the runs their own test started", async () => {
    const { release } = await requestsApp(
      async (by) => await workflowOf(by, greeting())
    );
    const mine = await sessionOf(release);
    const theirs = await sessionOf(release);
    const run = startedAs(
      await mine.start("desk-user", await startOf(release, { who: "Ada" }))
    );
    const asked = {
      otherSession: await refusal(async () => await theirs.runOutcome(run)),
      notStarted: await refusal(async () => await mine.runOutcome(7)),
      notANumber: await refusal(
        async () => await mine.completedCount("0", "greet")
      ),
      otherPrincipal: startedAs(
        await mine
          .start("stranger", await startOf(release, { who: "Ada" }))
          .catch(() =>
            JSON.stringify({ ok: false, error: { code: "refused" } })
          )
      ),
    };
    await mine.close();
    await theirs.close();
    expect({ run, asked }).toStrictEqual({
      run: 0,
      asked: {
        otherSession: "refused",
        notStarted: "refused",
        notANumber: "refused",
        otherPrincipal: "refused",
      },
    });
  });

  it("refuse a run another test started, though its number names one of this test's own", async () => {
    const { builder, app } = await requestsApp(
      async (by) => await workflowOf(by, greeting()),
      {
        "tests/greet.test.ts": `import { workflowTest } from "@grasp-os/sdk/testing";
import type { WorkflowTestRun } from "@grasp-os/sdk/testing";
import { workflows } from "#grasp";

let kept: WorkflowTestRun | undefined;

const askedOf = async (ask: () => Promise<unknown>): Promise<string> => {
  try {
    await ask();
    return "answered";
  } catch (error) {
    return error instanceof Error ? error.message : "thrown";
  }
};

export default workflowTest({
  fixtures: "desk",
  tests: {
    "first": async (t) => {
      const owner = await t.as("desk-user");
      const run = await owner.start(workflows.followUp, { who: "Ada" });
      kept = run;
      t.equal((await t.runs.untilTerminal(run)).status, "completed");
    },
    "second": async (t) => {
      const theirs = kept;
      if (theirs === undefined) {
        throw new Error("the first test kept no run");
      }
      const owner = await t.as("desk-user");
      const own = await owner.start(workflows.followUp, { who: "Bob" });
      t.equal((await t.runs.untilTerminal(own)).status, "completed");
      t.equal(
        [
          await askedOf(async () => await t.runs.untilTerminal(theirs)),
          await askedOf(async () => await t.effects.completedCount(theirs, "greet")),
        ],
        [
          "expected a run this test started, not one another test started",
          "expected a run this test started, not one another test started",
        ]
      );
    },
  },
});
`,
      }
    );
    await expect(activated(builder, app)).resolves.toBe("current");
  });

  it("start at most ten runs in one test, however many it asks for at once", async () => {
    const { release, app } = await requestsApp(
      async (by) => await workflowOf(by, greeting([{ hold: { wait: "PT1H" } }]))
    );
    const session = await sessionOf(release);
    const request = await startOf(release, { who: "Ada" });
    const answers = await Promise.all(
      Array.from(
        { length: 12 },
        async () => await session.start("desk-user", request)
      )
    );
    const started = answers.map(startedAs);
    const recorded = await recordedRuns(app);
    await session.close();
    expect({
      runs: started.filter((answer) => typeof answer === "number").length,
      refused: started.filter((answer) => typeof answer === "string"),
      recorded: recorded.length,
      left: await recordedRuns(app),
    }).toStrictEqual({
      runs: 10,
      refused: ["operation.call_limit", "operation.call_limit"],
      recorded: 10,
      left: [],
    });
  });

  it("remove a test's runs from the engine as it ends, ended or not, and the sweep those a dead test left", async () => {
    const { release, app } = await requestsApp(
      async (by) => await workflowOf(by, greeting([{ hold: { wait: "PT1H" } }]))
    );
    const ended = await sessionOf(release);
    startedAs(
      await ended.start("desk-user", await startOf(release, { who: "Ada" }))
    );
    const [closed] = await recordedRuns(app);
    await ended.close();

    // A test that died: its session never closed. Its time is up.
    const dead = await sessionOf(release);
    startedAs(
      await dead.start("desk-user", await startOf(release, { who: "Bo" }))
    );
    const [left = ""] = await recordedRuns(app);
    const before = await runEngine(env).status(left);
    await env.DB.prepare(
      "UPDATE app_test_runs SET deadline = ? WHERE run_id = ?"
    )
      .bind(Date.now() - 1000, left)
      .run();
    // One whose test still runs: kept, whenever it started.
    const live = await sessionOf(release);
    startedAs(
      await live.start("desk-user", await startOf(release, { who: "Cy" }))
    );
    const both = await recordedRuns(app);
    const running = both.find((id) => id !== left) ?? "";
    await env.DB.prepare(
      "UPDATE app_test_runs SET created_at = ? WHERE run_id = ?"
    )
      .bind(Date.now() - 2 * 60 * 60_000, running)
      .run();
    await sweepTestFixtures(env, new Date());
    const kept = await recordedRuns(app);
    await live.close();
    expect({
      closed: await runEngine(env).status(closed ?? ""),
      before: before !== undefined,
      swept: await runEngine(env).status(left),
      kept,
      recorded: await recordedRuns(app),
    }).toStrictEqual({
      closed: undefined,
      before: true,
      swept: undefined,
      kept: [running],
      recorded: [],
    });
  });

  it("sweep the runs left longest ago first, a page at a time", async () => {
    const app = `app_${unique()}`;
    const now = Date.now();
    // Recorded oldest last, its deadline the latest: only the order by when
    // each was recorded puts it first.
    const rows = Array.from({ length: 51 }, (_, index) => ({
      runId: `left-${unique()}-${index}`,
      createdAt: now - 60_000 * (index + 1),
      deadline: now - 1000 * (51 - index),
    }));
    await env.DB.batch(
      rows.map(({ runId, createdAt, deadline }) =>
        env.DB.prepare(
          "INSERT INTO app_test_runs (run_id, app_id, app_version, workflow_resource_id, version, manifest_hash, build_hash, principal, input, params, created_at, deadline) VALUES (?, ?, 1, 'wf', 1, ?, ?, 'fixture-desk-user', '{}', '{}', ?, ?)"
        ).bind(runId, app, "0".repeat(64), "0".repeat(64), createdAt, deadline)
      )
    );
    await sweepTestFixtures(env, new Date());
    await expect(recordedRuns(app)).resolves.toStrictEqual([rows[0]?.runId]);
  });

  it("keep a run's record for the next sweep when it can't be deleted, and sweep on", async () => {
    const app = `app_${unique()}`;
    const runId = `left-${unique()}`;
    await env.DB.prepare(
      "INSERT INTO app_test_runs (run_id, app_id, app_version, workflow_resource_id, version, manifest_hash, build_hash, principal, input, params, created_at, deadline) VALUES (?, ?, 1, 'wf', 1, ?, ?, 'fixture-desk-user', '{}', '{}', ?, ?)"
    )
      .bind(
        runId,
        app,
        "0".repeat(64),
        "0".repeat(64),
        Date.now(),
        Date.now() - 1000
      )
      .run();
    // D1 refuses the record's delete, and only that.
    const db = new Proxy(env.DB, {
      get: (target, name): unknown => {
        const value: unknown = Reflect.get(target, name);
        if (name === "prepare" && typeof value === "function") {
          return (query: string): unknown => {
            if (/delete from "app_test_runs"/iu.test(query)) {
              throw new Error("D1 is unavailable.");
            }
            return Reflect.apply(value, target, [query]);
          };
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    const swept = await refusal(async () => {
      await sweepTestFixtures({ ...env, DB: db }, new Date());
    });
    expect({ swept, kept: await recordedRuns(app) }).toStrictEqual({
      swept: "answered",
      kept: [runId],
    });
  });

  it("stop an activation once its test's time is up", async () => {
    const { release } = await requestsApp(
      async (by) => await workflowOf(by, greeting([{ hold: { wait: "PT2S" } }]))
    );
    const session = await sessionOf(release);
    const run = startedAs(
      await session.start("desk-user", await startOf(release, { who: "Ada" }))
    );
    await env.DB.prepare("UPDATE app_test_runs SET deadline = ?")
      .bind(Date.now() - 1000)
      .run();
    const ended = await endOf(session, run);
    await session.close();
    expect(ended).toMatchObject({
      status: "failed",
      code: "operation.cancelled",
    });
  });

  it("stop waiting for a run's end once its test's session closes", async () => {
    const { release } = await requestsApp(
      async (by) => await workflowOf(by, greeting([{ hold: { wait: "PT1H" } }]))
    );
    const session = await sessionOf(release);
    const run = startedAs(
      await session.start("desk-user", await startOf(release, { who: "Ada" }))
    );
    const waiting = session.runOutcome(run);
    await scheduler.wait(200);
    await session.close();
    const answered = await Promise.race([
      waiting,
      (async () => {
        await scheduler.wait(5000);
        return "still waiting";
      })(),
    ]);
    expect(answered).toBe("null");
  });

  it("keep a start's room once it was recorded, and remove its run, when the engine fails it", async () => {
    const { release, app } = await requestsApp(
      async (by) => await workflowOf(by, greeting([{ hold: { wait: "PT1H" } }]))
    );
    let failed = false;
    const failingStart = <T extends object>(namespace: T): T =>
      new Proxy(namespace, {
        get: (target, name): unknown => {
          const value: unknown = Reflect.get(target, name);
          if (name === "jurisdiction" && typeof value === "function") {
            return (...args: unknown[]): unknown => {
              const scoped: unknown = Reflect.apply(value, target, args);
              return typeof scoped === "object" && scoped !== null
                ? failingStart(scoped)
                : scoped;
            };
          }
          if (name === "get" && typeof value === "function") {
            return (...args: unknown[]): unknown => {
              const stub: unknown = Reflect.apply(value, target, args);
              if (typeof stub !== "object" || stub === null) {
                return stub;
              }
              return new Proxy(stub, {
                get: (object, method): unknown => {
                  const member: unknown = Reflect.get(object, method);
                  if (method === "start" && !failed) {
                    failed = true;
                    return async () => {
                      await Promise.resolve();
                      throw new Error("The engine couldn't be reached.");
                    };
                  }
                  return typeof member === "function"
                    ? (...called: unknown[]): unknown =>
                        Reflect.apply(member, object, called)
                    : member;
                },
              });
            };
          }
          return typeof value === "function"
            ? (...args: unknown[]): unknown =>
                Reflect.apply(value, target, args)
            : value;
        },
      });
    const session = await sessionOf(release, {
      on: { ...env, WORKFLOW_RUNS: failingStart(env.WORKFLOW_RUNS) },
    });
    const request = await startOf(release, { who: "Ada" });
    const first = startedAs(await session.start("desk-user", request));
    const afterFailure = await recordedRuns(app);
    const rest: (number | string)[] = [];
    for (let index = 0; index < 10; index += 1) {
      // One after another: each start's own room.
      // oxlint-disable-next-line no-await-in-loop
      rest.push(startedAs(await session.start("desk-user", request)));
    }
    await session.close();
    expect({
      first: typeof first,
      afterFailure,
      started: rest.filter((answer) => typeof answer === "number").length,
      refused: rest.filter((answer) => typeof answer === "string"),
    }).toStrictEqual({
      first: "string",
      afterFailure: [],
      // Its room stayed taken: nine more, then the limit.
      started: 9,
      refused: ["operation.call_limit"],
    });
  });

  it("tell a test and its report of a failed run only the platform's code and words, never a value it read", async () => {
    const admin = await person("admin");
    const key = await mailContract(admin);
    let workflowId = "";
    const { app, builder } = await requestsApp(
      async (by) => {
        workflowId = await workflowOf(
          by,
          [
            {
              count: {
                set: { status: "${ $params.word | tonumber | tostring }" },
              },
            },
            {
              send: {
                call: "grasp.connector",
                with: {
                  binding: "mail",
                  operation: "mail.send",
                  arguments: { to: "Ada", subject: "${ $params.token }" },
                },
              },
            },
          ],
          { mail: { kind: "connector", contract: key } },
          {
            params: {
              word: {
                schema: { type: "string", maxLength: 64 },
                label: "Word",
                default: "default-word",
                sensitive: false,
              },
              token: {
                schema: { type: "string", maxLength: 64 },
                label: "Token",
                default: "none",
                sensitive: true,
              },
            },
          }
        );
        return workflowId;
      },
      {
        "tests/leak.test.ts": suiteOf(`
      const run = await owner.start(workflows.followUp, { who: "Ada" });
      t.equal(JSON.stringify(await t.runs.untilTerminal(run)), "shown");`),
      },
      { followUp: { params: { word: "fixture-secret-word" } } }
    );
    await setWorkflowParams(env, builder, workflowId, {
      expectedRevision: 0,
      values: { word: "org-secret-word", token: "org-secret-token" },
    });
    const report = JSON.stringify(await activated(builder, app));
    expect({
      // The test failed, quoting how the run ended, in full.
      failed: report.includes("failed") && report.includes("code"),
      leaked: /secret/u.test(report),
    }).toStrictEqual({ failed: true, leaked: false });
  });

  it("tell a test of a run that failed for a reason of core's own only the platform's words for a step's failure", async () => {
    const { release, app } = await requestsApp(
      async (by) => await workflowOf(by, greeting([{ hold: { wait: "PT1S" } }]))
    );
    const session = await sessionOf(release);
    const run = startedAs(
      await session.start("desk-user", await startOf(release, { who: "Ada" }))
    );
    // Its record changed under it: its next activation fails, as core's
    // own error, which names the run.
    await env.DB.prepare(
      "UPDATE app_test_runs SET manifest_hash = ? WHERE app_id = ?"
    )
      .bind("f".repeat(64), app)
      .run();
    const ended = await endOf(session, run);
    await session.close();
    expect(ended).toStrictEqual({
      status: "failed",
      code: "workflow.step_failed",
      message: expectedMessageOf("workflow.step_failed"),
    });
  });

  it("refuse a connector's call and an action's: connect and the action's sandbox are never asked", async () => {
    const admin = await person("admin");
    const key = await mailContract(admin);
    const connectorRun = await requestsApp(
      async (by) =>
        await workflowOf(
          by,
          [
            {
              send: {
                call: "grasp.connector",
                with: {
                  binding: "mail",
                  operation: "mail.send",
                  arguments: { to: "Ada", subject: "Hi" },
                },
              },
            },
            { greet: { set: { status: "sent" } } },
          ],
          { mail: { kind: "connector", contract: key } }
        )
    );
    const actionRun = await requestsApp(
      async (by) =>
        await workflowOf(
          by,
          [
            {
              notify: {
                call: "grasp.operation",
                with: {
                  binding: "notify",
                  arguments: { to: "${ $workflow.input.who }" },
                },
              },
            },
            { greet: { set: { status: "notified" } } },
          ],
          {
            notify: {
              kind: "operation",
              contract: "local:code/notify.ts#notify",
            },
          },
          {
            modules: {
              "code/notify.ts": `import { action, v } from "@grasp-os/sdk/action";

export const notify = action({
  args: { to: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [],
  handler: async () => ({ status: "notified" }),
});
`,
            },
          }
        )
    );
    const loaded: string[] = [];
    const loader = env.LOADER;
    const get = loader.get.bind(loader);
    vi.spyOn(loader, "get").mockImplementation((name, code) =>
      get(name, async () => {
        const made = await code();
        loaded.push(made.mainModule);
        return made;
      })
    );
    const connectBefore = await connectCalls();
    const endedIn = async (
      fixture: Awaited<ReturnType<typeof requestsApp>>
    ): Promise<unknown> => {
      const session = await sessionOf(fixture.release);
      const run = startedAs(
        await session.start(
          "desk-user",
          await startOf(fixture.release, { who: "Ada" })
        )
      );
      const outcome = await endOf(session, run);
      await session.close();
      return outcome;
    };
    expect({
      connector: await endedIn(connectorRun),
      action: await endedIn(actionRun),
      connectAsked: (await connectCalls()) - connectBefore,
      actionSandboxes: loaded.filter((main) => main === actionMainModule),
    }).toMatchObject({
      connector: { status: "failed", code: "resource.unavailable" },
      action: { status: "failed", code: "resource.unavailable" },
      connectAsked: 0,
      actionSandboxes: [],
    });
  });

  it("refuse a run's output that is more than the App declares, as a screen is shown it", async () => {
    const { release } = await requestsApp(async (by) => {
      const workflow = await createWorkflowResource(
        env,
        by,
        `wider-${unique()}`
      );
      await publishWorkflowVersion(env, by, workflow.id, {
        definition: JSON.stringify({
          ...JSON.parse(
            definitionOf(workflow.name, [
              { greet: { set: { status: "hello", secret: "ultramarine" } } },
            ])
          ),
          output: {
            schema: objectSchema({
              status: { type: "string" },
              secret: { type: "string" },
            }),
          },
        }),
        basedOn: null,
      });
      return workflow.id;
    });
    const session = await sessionOf(release);
    const run = startedAs(
      await session.start("desk-user", await startOf(release, { who: "Ada" }))
    );
    const ended = await endOf(session, run);
    await session.close();
    expect({
      ended,
      leaks: JSON.stringify(ended).includes("ultramarine"),
    }).toMatchObject({
      ended: { status: "failed", code: "contract.invalid_return" },
      leaks: false,
    });
  });

  it("run with the fixture's parameter values or their defaults, never the organization's", async () => {
    const params = {
      greeting: {
        schema: { type: "string", maxLength: 64 },
        label: "Greeting",
        default: "Hello",
        sensitive: false,
      },
    };
    let workflowId = "";
    let builder: Acting | undefined;
    const { release } = await requestsApp(async (by) => {
      builder = by;
      workflowId = await workflowOf(
        by,
        [
          {
            greet: {
              set: {
                status: '${ $params.greeting + ", " + $workflow.input.who }',
              },
            },
          },
        ],
        {},
        { params }
      );
      return workflowId;
    });
    if (builder === undefined) {
      throw new Error("No builder");
    }
    await setWorkflowParams(env, builder, workflowId, {
      expectedRevision: 0,
      values: { greeting: "Ultramarine" },
    });
    const ended = async (
      workflows?: Record<string, { params: Record<string, unknown> }>
    ): Promise<unknown> => {
      const session = await sessionOf(release, { workflows });
      const run = startedAs(
        await session.start("desk-user", await startOf(release, { who: "Ada" }))
      );
      const outcome = typeof run === "number" ? await endOf(session, run) : run;
      await session.close();
      return outcome;
    };
    expect({
      defaults: await ended(),
      fixture: await ended({ followUp: { params: { greeting: "Fixture" } } }),
      unknown: await ended({ followUp: { params: { colour: "red" } } }),
    }).toStrictEqual({
      defaults: { status: "completed", output: { status: "Hello, Ada" } },
      fixture: { status: "completed", output: { status: "Fixture, Ada" } },
      unknown: "workflow.params_invalid",
    });
  });
});

// A test's run calling its App's own store operations (GRA-898), from the
// threat model in workflows/fixture-runs.ts: the call reaches the
// organization's business store, another App's store or an App's export;
// it writes approvals, receipts or audit entries; a replay writes again.

/** The Requests App's files with store operations of its own. */
const storeFilesWith = (
  tests: Record<string, string> = {},
  revision = 1
): Record<string, string> => ({
  ...filesWith(tests),
  "operations/requests.ts": `// Revision ${revision}.
import { resource, v } from "@grasp-os/sdk";
import { mutation, query } from "#grasp/server";

export const followUp = resource.workflow("followUp", {
  input: v.object({ who: v.string().trim().min(1) }),
  output: v.object({ status: v.string() }),
});

export const add = mutation({
  args: { who: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("requests", { who: args.who });
    return null;
  },
});

export const list = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) =>
    (await ctx.db.query("requests").take(100)).map(({ who }) => who).toSorted(),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { add, followUp, list } from "./operations/requests.ts";
import schema from "./schema.ts";

export default app({
  name: "Requests",
  schema,
  access: { tables: { requests: { read: "appMembers", write: "appMembers" } } },
  operations: { requests: { add, list } },
  screens: [],
  uses: [followUp],
});
`,
});

/** Records its input's `who` through binding `record`, then greets. */
const recording = [
  {
    record: {
      call: "grasp.operation",
      with: {
        binding: "record",
        arguments: { who: "${ $workflow.input.who }" },
      },
    },
  },
  // A new activation after it: the call's step is replayed, not made again.
  { hold: { wait: "PT1S" } },
  ...greeting(),
];

/** How `admin` names Apps and resources in a permission. */
const rolesOf = (admin: Acting & Identity) => ({
  app: async (named: string, role: "user" | "builder") =>
    await appFor(env, admin, named, role),
  resource: async (
    ref: Parameters<typeof requireResourceRole>[2],
    needed: Parameters<typeof requireResourceRole>[3]
  ) => {
    await requireResourceRole(env, admin, ref, needed);
  },
});

/**
 * A Requests App whose own store's `requests.add` its bound workflow calls
 * through binding `record`, approved by an admin on the store of App
 * `approvedOn` (the App's own, unless given), as its `tasks` (`recording`
 * unless given): version 1 current, and version 2, with `tests`, the one
 * under test.
 */
const storeApp = async (
  tests: Record<string, string> = {},
  approvedOn?: { app: string; store: string; owner: Acting & Identity },
  tasks: unknown[] = recording
) => {
  const admin = await person("admin");
  const builder = await person("builder");
  const fixture = await appWith(storeFilesWith(), "Requests", builder);
  const current = await seal(fixture);
  await setCurrentVersion(env, builder, fixture.app, 1);
  const on = approvedOn ?? fixture;
  const key = `requests-${unique()}`;
  const operation = current.app.operations["requests.add"];
  await publishCatalogContract(env, admin, {
    key,
    kind: "operation",
    input: JSON.stringify(operation?.args),
    output: JSON.stringify(operation?.returns),
  });
  const workflowId = await workflowOf(builder, tasks, {
    record: { kind: "operation", contract: key },
  });
  const asked = await requestPermission(
    env,
    admin,
    {
      subject: { type: "workflow", workflowId },
      object: { type: "store", storeId: on.store },
      actions: ["requests.add"],
      binding: `STORE_${unique().toUpperCase().replaceAll("-", "_")}`,
    },
    rolesOf(admin)
  );
  await grantPermission(env, admin, asked.id, { version: null });
  await approveWorkflowBinding(env, admin, workflowId, {
    alias: "record",
    target: {
      kind: "storeOperation",
      permissionId: asked.id,
      operation: "requests.add",
      operationKind: "mutation",
    },
    reviewed: { version: 1 },
  });
  await bindWorkflowToApp(env, builder, workflowId, {
    app: fixture.app,
    alias: "followUp",
    version: 1,
  });
  await commitFiles(
    env,
    builder,
    fixture.app,
    storeFilesWith(tests, 2),
    "Tests"
  );
  await seal(fixture, 2);
  const release = await loadRelease(env, fixture.app, 2);
  return { admin, builder, fixture, workflowId, release };
};

/** What `by` reads of `app`'s business store, through its current version. */
const businessRequests = async (
  by: Acting & Identity,
  app: string
): Promise<unknown> => {
  const { currentVersion } = await findApp(env, app);
  const release = await loadRelease(
    env,
    appIdSchema.parse(app),
    currentVersion ?? 1
  );
  const answer = await callAppFunction(
    env,
    by,
    app,
    JSON.stringify({
      reference: {
        resourceId: release.manifest.resourceId,
        resourceVersion: release.manifest.resourceVersion,
        contractId: "requests.list",
        fingerprint: release.fingerprints["requests.list"] ?? "",
        kind: "query",
      },
      input: {},
    })
  );
  return answer.result.ok ? answer.result.value : answer.result.error.code;
};

/** What `desk-user` reads of the session's fixture store. */
const fixtureRequests = async (
  session: Awaited<ReturnType<typeof sessionOf>>,
  release: Release
): Promise<unknown> => {
  const answer: unknown = JSON.parse(
    await session.call(
      "desk-user",
      JSON.stringify({
        reference: {
          resourceId: release.manifest.resourceId,
          resourceVersion: release.manifest.resourceVersion,
          contractId: "requests.list",
          fingerprint: release.fingerprints["requests.list"] ?? "",
          kind: "query",
        },
        input: {},
      })
    )
  );
  return z
    .union([
      z.object({ ok: z.literal(true), value: z.unknown() }),
      z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
    ])
    .transform((result) => (result.ok ? result.value : result.error.code))
    .parse(answer);
};

/** Rows of `table` naming workflow `workflow`. */
const rowsNaming = async (table: string, workflow: string) => {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE workflow_resource_id = ?`
  )
    .bind(workflow)
    .first<{ n: number }>();
  return row?.n;
};

describe(
  "an App's workflow test's run calling its App's store",
  { timeout: 180_000 },
  () => {
    it("write through the App's own store operation to the test's fixture store, read back by the test, and nothing of the organization's", async () => {
      const { builder, fixture, workflowId } = await storeApp({
        "tests/record.test.ts": `import { workflowTest } from "@grasp-os/sdk/testing";
import { api, workflows } from "#grasp";

export default workflowTest({
  fixtures: "desk",
  tests: {
    "records": async (t) => {
      const owner = await t.as("desk-user");
      const run = await owner.start(workflows.followUp, { who: "Ada" });
      t.equal(await t.runs.untilTerminal(run), {
        status: "completed",
        output: { status: "Hello, Ada" },
      });
      t.equal(await owner.query(api.requests.list, {}), ["Ada"]);
      t.equal(await t.effects.completedCount(run, "record"), 1);
    },
  },
});
`,
      });
      const approvals = await rowsNaming(
        "workflow_binding_approvals",
        workflowId
      );
      let outcome: unknown;
      const events = await auditedDuring(async () => {
        try {
          await activateVersion(env, builder, fixture.app, 2);
          const found = await findApp(env, fixture.app);
          outcome = found.currentVersion;
        } catch (error) {
          outcome = isExpectedError(error)
            ? (error.details?.failures ?? error.code)
            : error;
        }
      });
      expect({
        outcome,
        business: await businessRequests(builder, fixture.app),
        organization: await organizationRunsOf(workflowId),
        approvals: await rowsNaming("workflow_binding_approvals", workflowId),
        events: events
          .map(({ action }) => action)
          .filter(
            (action) =>
              action.startsWith("workflow.") || action.startsWith("store.")
          ),
      }).toStrictEqual({
        outcome: 2,
        business: [],
        organization: { receipts: 0, runs: 0 },
        approvals,
        events: [],
      });
    });

    it("write once across the run's replay, on its own test's fixture store alone", async () => {
      const { builder, fixture, release } = await storeApp();
      const session = await sessionOf(release);
      const other = await sessionOf(release);
      const run = startedAs(
        await session.start("desk-user", await startOf(release, { who: "Ada" }))
      );
      const ended = await endOf(session, run);
      const completed = await session.completedCount(run, "record");
      const read = {
        own: await fixtureRequests(session, release),
        otherTest: await fixtureRequests(other, release),
        business: await businessRequests(builder, fixture.app),
      };
      await session.close();
      await other.close();
      expect({ ended, completed, read }).toStrictEqual({
        ended: { status: "completed", output: { status: "Hello, Ada" } },
        completed: 1,
        read: { own: ["Ada"], otherTest: [], business: [] },
      });
    });

    it("refuse another App's store operation, and one whose approval names an App's export, writing nothing", async () => {
      const elsewhere = await appWith(
        storeFilesWith(),
        "Requests",
        await person("builder")
      );
      await seal(elsewhere);
      await setCurrentVersion(env, elsewhere.owner, elsewhere.app, 1);
      const otherStore = await storeApp({}, elsewhere);
      const exported = await storeApp();
      await env.DB.prepare(
        "UPDATE workflow_binding_approvals SET target = json_object('kind', 'operation', 'permissionId', json_extract(target, '$.permissionId'), 'appVersion', 1, 'export', 'lookUp') WHERE workflow_resource_id = ? AND status = 'active'"
      )
        .bind(exported.workflowId)
        .run();
      const endedOn = async ({
        release,
      }: Awaited<ReturnType<typeof storeApp>>) => {
        const session = await sessionOf(release);
        const run = startedAs(
          await session.start(
            "desk-user",
            await startOf(release, { who: "Ada" })
          )
        );
        const ended = await endOf(session, run);
        const written = await fixtureRequests(session, release);
        await session.close();
        return { ended, written };
      };
      expect({
        otherStore: await endedOn(otherStore),
        exported: await endedOn(exported),
        elsewhere: await businessRequests(elsewhere.owner, elsewhere.app),
      }).toMatchObject({
        otherStore: {
          ended: { status: "failed", code: "resource.unavailable" },
          written: [],
        },
        exported: {
          ended: { status: "failed", code: "resource.unavailable" },
          written: [],
        },
        elsewhere: [],
      });
    });

    it("refuse its store operation once its approval is revoked, or its test's fixture store isn't the one recorded", async () => {
      const revoked = await storeApp();
      await env.DB.prepare(
        "UPDATE workflow_binding_approvals SET status = 'revoked' WHERE workflow_resource_id = ?"
      )
        .bind(revoked.workflowId)
        .run();
      // Its call a moment after it starts, once its record is changed.
      const swapped = await storeApp({}, undefined, [
        { first: { wait: "PT1S" } },
        ...recording,
      ]);
      const endedOn = async (
        { release }: Awaited<ReturnType<typeof storeApp>>,
        before: () => Promise<void> = async () => {
          // As started.
        }
      ) => {
        const session = await sessionOf(release);
        const run = startedAs(
          await session.start(
            "desk-user",
            await startOf(release, { who: "Ada" })
          )
        );
        await before();
        const ended = await endOf(session, run);
        await session.close();
        return ended;
      };
      expect({
        revoked: await endedOn(revoked),
        // Its record names a store no test made for it.
        swapped: await endedOn(swapped, async () => {
          await env.DB.prepare(
            "UPDATE app_test_runs SET fixture_store_id = ? WHERE app_id = ?"
          )
            .bind(swapped.fixture.store, swapped.fixture.app)
            .run();
        }),
      }).toMatchObject({
        revoked: { status: "failed", code: "resource.unavailable" },
        swapped: { status: "failed", code: "resource.unavailable" },
      });
    });
  }
);
