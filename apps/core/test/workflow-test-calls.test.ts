import { v } from "@grasp-os/sdk";
import { declaredWorkflows, workflowFingerprint } from "@grasp-os/sdk/host";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { publishVersion } from "../src/app-publish.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { fixtureHostFor } from "../src/app-tests.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import type { Acting } from "../src/auth/identity.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { appDefinition } from "./app-definitions.ts";
import { fakeProvider } from "./model-provider.ts";
import { resumed, sleeping, stopped } from "./runs.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import { auditedDuring, unique } from "./sign-in.ts";

// The model calls of a run an App's test started (`workflowTest`,
// workflows/fixture-calls.ts), from its threat model first: a test's run
// asks a real model, spends budget or leaves a trace of a model call; a
// call the fixture gives nothing falls through to a real one; a replay
// answers again. Then what a test sees: the fixture's answer.

/** A JSON object schema of `properties`, each required, and nothing else. */
const objectSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** A workflow's steps, and the `status` it ends with. */
interface Flow {
  steps: unknown[];
  status: unknown;
}

/** A workflow of `flow`, its input `who` and output `status`. */
const definitionOf = (
  { steps, status }: Flow,
  bindings: Record<string, unknown>
): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    input: objectSchema({ who: { type: "string" } }),
    output: {
      schema: objectSchema({ status: { type: "string" } }),
      value: { status },
    },
    bindings,
    steps,
  });

/** Asks the `summary` model binding for a line about the input's `who`. */
const summarize = {
  id: "summarize",
  type: "agent",
  binding: "summary",
  instructions: "Greet them.",
  input: { who: { $expr: "input.who" } },
  output: objectSchema({ line: { type: "string" } }),
};

/** The line `summarize` answered. */
const line = { $expr: "steps.summarize.output.line" };

/** A wait of `duration` (`"1 second"`) in step `hold`. */
const hold = (duration: string) => ({
  id: "hold",
  type: "wait",
  for: duration,
});

/** What a test's fixture gives the workflow the App binds as `followUp`. */
interface WorkflowFixture {
  models?: Record<string, unknown>;
}

/** The App's files: it binds `followUp` and keeps requests; `tests`. */
const filesWith = (
  workflow: WorkflowFixture,
  tests: Record<string, string> = {}
): Record<string, string> => ({
  ...appDefinition({
    name: "Requests",
    tables: {
      requests: {
        fields: { who: "v.string()" },
        access: { read: "appMembers", write: "appMembers" },
      },
    },
    permissions: [
      'permission.workflow("followUp", {\n  input: v.object({ who: v.string().trim().min(1) }),\n  output: v.object({ status: v.string() }),\n})',
    ],
  }),
  "server/requests.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const followUp = permissions.followUp;

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
  handler: async (ctx) => (await ctx.db.query("requests").take(100)).map(({ who }) => who),
});
`,

  "tests/fixtures/desk.json": JSON.stringify({
    principals: { "desk-user": { role: "user" } },
    workflows: { followUp: workflow },
  }),
  ...tests,
});

/** The model catalog contract `admin` publishes. */
const modelContract = async (admin: Identity): Promise<string> => {
  const model = `summary-${unique()}`;
  await publishCatalogContract(env, admin, { key: model, kind: "model" });
  return model;
};

/**
 * The Requests App binding a workflow of `flow` as `followUp`, its model
 * binding `summary`, with `workflow` as its fixture and `tests` as its
 * tests.
 */
const requestsApp = async (
  flow: Flow,
  workflow: WorkflowFixture,
  tests: Record<string, string> = {}
) => {
  const admin = await person("admin");
  const model = await modelContract(admin);
  const builder = await person("builder");
  const files = filesWith(workflow, tests);
  const fixture = await appWith(files, "Requests", builder);
  const resource = await createWorkflowResource(
    env,
    builder,
    `greet-${unique()}`
  );
  await publishWorkflowVersion(env, builder, resource.id, {
    definition: definitionOf(flow, {
      summary: { kind: "model", contract: model },
    }),
    basedOn: null,
  });
  await bindWorkflowToApp(env, builder, resource.id, {
    app: fixture.app,
    alias: "followUp",
    version: 1,
  });
  await seal(fixture);
  const release = await loadRelease(env, fixture.app, 1);
  return { builder, app: fixture.app, release, files };
};

type RequestsApp = Awaited<ReturnType<typeof requestsApp>>;

/** A start of `followUp` with `input`, as the SDK sends it. */
const startOf = async (release: Release, input: unknown): Promise<string> => {
  const declared = declaredWorkflows(release.app, release.workflows).find(
    ({ alias }) => alias === "followUp"
  );
  if (declared === undefined) {
    throw new Error("No followUp");
  }
  return JSON.stringify({
    workflow: {
      resourceId: release.manifest.resourceId,
      resourceVersion: release.manifest.resourceVersion,
      contractId: "workflows.followUp",
      fingerprint: await workflowFingerprint(declared),
      kind: "workflow",
    },
    command: "start",
    input,
    idempotencyKey: "0".repeat(32),
  });
};

const startedSchema = z.object({
  ok: z.literal(true),
  value: z.object({ run: z.number() }),
});

/** A test session on `app`'s release, its run of `followUp` for "Ada" started. */
const runningIn = async (app: RequestsApp) => {
  const host = fixtureHostFor(env, app.release, app.files);
  const session = await host.open("desk", `test-${unique()}`);
  const { value } = startedSchema.parse(
    JSON.parse(
      await session.start(
        "desk-user",
        await startOf(app.release, { who: "Ada" })
      )
    )
  );
  const row = await env.DB.prepare(
    "SELECT run_id AS id FROM app_test_runs WHERE app_id = ?"
  )
    .bind(app.app)
    .first<{ id: string }>();
  if (row === null) {
    throw new Error("No test run recorded");
  }
  return { session, run: value.run, runId: row.id };
};

/** How `app`'s run of `followUp` for "Ada" ended in a test of its own. */
const endedIn = async (app: RequestsApp): Promise<unknown> => {
  const { session, run } = await runningIn(app);
  const ended: unknown = JSON.parse(await session.runOutcome(run));
  await session.close();
  return ended;
};

/** The model's provider, faked: what it was asked. */
const watchedProvider = async () =>
  await fakeProvider({
    text: '{"line":"From a real model"}',
    inputTokens: 1,
    outputTokens: 1,
  });

/** Activates version 1 of `app`: "current", or the refusal's failures. */
const activated = async (
  by: Acting & Identity,
  app: string
): Promise<unknown> => {
  try {
    await publishVersion(env, by, app, 1);
    return "current";
  } catch (error) {
    if (!isExpectedError(error)) {
      throw error;
    }
    return error.details?.failures ?? error.code;
  }
};

/** What `work` comes to: "ok", or its error's code. */
const outcomeOf = async (work: () => Promise<void>): Promise<string> => {
  try {
    await work();
    return "ok";
  } catch (error) {
    if (!isExpectedError(error)) {
      throw error;
    }
    return error.code;
  }
};

/** The test stores and runs core still records for `app`. */
const leftOf = async (app: string) => {
  const stores = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM app_test_fixtures WHERE app_id = ?"
  )
    .bind(app)
    .first<{ n: number }>();
  const runs = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM app_test_runs WHERE app_id = ?"
  )
    .bind(app)
    .first<{ n: number }>();
  return { stores: stores?.n, runs: runs?.n };
};

/** A suite of one workflow test, `body` with `owner` at hand. */
const suiteOf = (
  body: string
): string => `import { workflowTest } from "@grasp-os/sdk/testing";
import { ${["api", "workflows"].filter((name) => body.includes(`${name}.`)).join(", ")} } from "@server/_generated/api";

export default workflowTest({
  fixtures: "desk",
  tests: {
    "runs": async (t) => {
${body.includes("owner") ? '      const owner = await t.as("desk-user");' : ""}
      ${body}
    },
  },
});
`;

describe("a workflow test's model calls", { timeout: 180_000 }, () => {
  it("answer a model call with the fixture's answer, and never ask a model or leave a trace of one", async () => {
    const provider = await watchedProvider();
    const app = await requestsApp(
      { steps: [summarize], status: line },
      { models: { summary: { line: "Hello from the fixture" } } },
      {
        "tests/greet.test.ts": suiteOf(`
      const run = await owner.start(workflows.followUp, { who: "Ada" });
      t.equal(await t.runs.untilTerminal(run), {
        status: "completed",
        output: { status: "Hello from the fixture" },
      });
      t.equal(await t.effects.completedCount(run, "summarize"), 1);`),
      }
    );
    let outcome: unknown;
    const events = await auditedDuring(async () => {
      outcome = await activated(app.builder, app.app);
    });
    expect({
      outcome,
      asked: provider.requests.length,
      traces: events
        .map(({ action }) => action)
        .filter(
          (action) =>
            action.startsWith("model.") || action.startsWith("workflow.")
        ),
      left: await leftOf(app.app),
    }).toStrictEqual({
      outcome: "current",
      asked: 0,
      traces: [],
      left: { stores: 0, runs: 0 },
    });
  });

  it("fail a model call the fixture gives nothing, or an answer the task's schema doesn't take, without asking a model", async () => {
    const provider = await watchedProvider();
    const tasks = { steps: [summarize], status: line };
    expect({
      unfixtured: await endedIn(await requestsApp(tasks, {})),
      otherBinding: await endedIn(
        await requestsApp(tasks, { models: { elsewhere: { line: "Hi" } } })
      ),
      wrongShape: await endedIn(
        await requestsApp(tasks, { models: { summary: { words: 3 } } })
      ),
      asked: provider.requests.length,
    }).toMatchObject({
      unfixtured: { status: "failed", code: "workflow.test_unfixtured" },
      otherBinding: { status: "failed", code: "workflow.test_unfixtured" },
      wrongShape: { status: "failed", code: "workflow.call_invalid" },
      asked: 0,
    });
  });

  // A workflow reaches no App's store: there is no binding that would.
  it("can't be bound to an App's store operation, nor its contract published", async () => {
    const admin = await person("admin");
    const builder = await person("builder");
    const resource = await createWorkflowResource(
      env,
      builder,
      `greet-${unique()}`
    );
    expect({
      contract: await outcomeOf(async () => {
        await publishCatalogContract(env, admin, {
          key: `save-${unique()}`,
          kind: "operation",
          input: JSON.stringify(v.object({ who: v.string() }).descriptor),
          output: JSON.stringify(v.null().descriptor),
        });
      }),
      binding: await outcomeOf(async () => {
        await publishWorkflowVersion(env, builder, resource.id, {
          definition: definitionOf(
            {
              steps: [
                {
                  id: "save",
                  type: "do",
                  binding: "save",
                  arguments: { who: { $expr: "input.who" } },
                },
              ],
              status: "saved",
            },
            { save: { kind: "operation", contract: "requests.add@1" } }
          ),
          basedOn: null,
        });
      }),
    }).toStrictEqual({
      contract: "workflow.contract_invalid",
      binding: "workflow.definition_invalid",
    });
  });

  it("answer once, though the run stops after its calls and starts again", async () => {
    const provider = await watchedProvider();
    const app = await requestsApp(
      { steps: [summarize, hold("2 seconds")], status: line },
      { models: { summary: { line: "Hello" } } }
    );
    const { session, run, runId } = await runningIn(app);
    await sleeping(runId, "hold:task");
    // Down while it waits, then back: the workflow runs again from its
    // start, its finished steps replayed.
    await stopped(runId);
    await resumed(runId);
    const ended: unknown = JSON.parse(await session.runOutcome(run));
    const completed = await session.completedCount(run, "summarize");
    await session.close();
    expect({ ended, completed, asked: provider.requests.length }).toStrictEqual(
      {
        ended: { status: "completed", output: { status: "Hello" } },
        completed: 1,
        asked: 0,
      }
    );
  });
});
