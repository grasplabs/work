/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { declaredWorkflows, workflowFingerprint } from "@grasp-os/sdk/host";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { activateVersion } from "../src/app-activation.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { fixtureHostFor, sweepTestFixtures } from "../src/app-tests.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { findApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import { auditedDuring, unique } from "./sign-in.ts";

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
  tests: Record<string, string> = {}
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
  }),
  ...tests,
});

/** A workflow of `by`'s, its version 1 `tasks`, and `bindings`. */
const workflowOf = async (
  by: Acting,
  tasks: unknown[],
  bindings: Record<string, unknown> = {}
): Promise<string> => {
  const workflow = await createWorkflowResource(env, by, `greet-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: definitionOf(workflow.name, tasks, bindings),
    basedOn: null,
  });
  return workflow.id;
};

/** The Requests App with `tests`, binding workflow `workflow` as `followUp`. */
const requestsApp = async (
  workflow: (by: Acting) => Promise<string>,
  tests: Record<string, string> = {}
) => {
  const builder = await person("builder");
  const fixture = await appWith(filesWith(tests), "Requests", builder);
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

/** A test session on the Requests App's release, for `desk-user`. */
const sessionOf = async (release: Release) => {
  const files = filesWith();
  const host = fixtureHostFor(env, release, files);
  return await host.open("desk", `test-${unique()}`);
};

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

    // A test that died: its session never closed.
    const dead = await sessionOf(release);
    startedAs(
      await dead.start("desk-user", await startOf(release, { who: "Bo" }))
    );
    const [left = ""] = await recordedRuns(app);
    const before = await runEngine(env).status(left);
    await env.DB.prepare(
      "UPDATE app_test_runs SET created_at = ? WHERE run_id = ?"
    )
      .bind(Date.now() - 2 * 60 * 60_000, left)
      .run();
    await sweepTestFixtures(env, new Date());
    expect({
      closed: await runEngine(env).status(closed ?? ""),
      before: before !== undefined,
      swept: await runEngine(env).status(left),
      recorded: await recordedRuns(app),
    }).toStrictEqual({
      closed: undefined,
      before: true,
      swept: undefined,
      recorded: [],
    });
  });
});
