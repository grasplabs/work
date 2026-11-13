import { v } from "@grasp-os/runtime/app";
import { declaredWorkflows } from "@grasp-os/runtime/host";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { appPublishing } from "../src/app-publish.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { fixtureHostFor } from "../src/app-tests.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { releaseIdsOf } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { rollback } from "../src/publish.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { publishWorkflowVersion } from "../src/workflow-publish.ts";
import { createWorkflowResource } from "../src/workflow-resources.ts";
import { runObjectOf } from "../src/workflows/engine.ts";
import { testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { fakeProvider } from "./model-provider.ts";
import { resumed, sleeping, stopped } from "./runs.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import { auditedDuring, unique } from "./sign-in.ts";

// The model calls of a run an App's test started (`identity.start`,
// workflows/fixture-calls.ts), from its threat model first: a test's run
// asks a real model, spends budget or leaves a trace of a model call; a
// call the start gives nothing falls through to a real one; a replay
// answers again. Then what a test sees: the answer its start gives, how
// many requests each task made, as the test's provider counted them, and
// a fault that really restarts the run (`restartAfterStep`).

/** An object of `fields`, each required. */
const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/** A workflow's steps, and the `status` it ends with. */
interface Flow {
  steps: unknown[];
  status: unknown;
}

/** A workflow of `flow`, its args `who` and its result `status`. */
const definitionOf = (
  { steps, status }: Flow,
  permissions: Record<string, unknown>
): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status },
    permissions,
    steps,
  });

/** Asks the `summary` model binding for a line about the input's `who`. */
const summarize = {
  id: "summarize",
  type: "generate",
  instructions: "Greet them.",
  input: { who: { $expr: "args.who" } },
  returns: objectSchema({ line: { kind: "string" } }),
};

/** The line `summarize` answered. */
const line = { $expr: "summarize.line" };

/** A wait of `duration` (`"1 second"`) in step `hold`. */
const hold = (duration: string) => ({
  id: "hold",
  type: "wait",
  for: duration,
});

/** What a test's start gives the workflow the App binds as `followUp`. */
interface StartOptions {
  models?: Record<string, unknown>;
  restartAfterStep?: string;
}

/** The App's files: it binds `followUp` and keeps requests; `tests`. */
const filesWith = (tests: Record<string, string> = {}): TestApp =>
  testApp(
    {
      name: "Requests",
      tables: {
        requests: {
          fields: { who: "v.string()" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
      permissions: [
        'permission.workflow("followUp", {\n  args: v.object({ who: v.string().trim().min(1) }),\n  returns: v.object({ status: v.string() }),\n})',
      ],
    },
    {
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

      ...tests,
    }
  );

/** The model catalog contract `admin` publishes. */
const modelContract = async (admin: Identity): Promise<string> => {
  const model = `summary-${unique()}`;
  await publishCatalogContract(env, admin, { key: model, kind: "model" });
  return model;
};

/**
 * The Requests App binding a workflow of `flow` as `followUp`, its model
 * binding `ai`, with `options` what a test's start of it gives and `tests`
 * as its tests.
 */
const requestsApp = async (
  flow: Flow,
  options: StartOptions,
  tests: Record<string, string> = {}
) => {
  const admin = await person("admin");
  const model = await modelContract(admin);
  const builder = await person("builder");
  const files = filesWith(tests);
  const fixture = await appWith(files, "Requests", builder);
  const resource = await createWorkflowResource(
    env,
    builder,
    `greet-${unique()}`
  );
  await publishWorkflowVersion(env, builder, resource.id, {
    definition: definitionOf(flow, { ai: { contract: model } }),
    basedOn: null,
  });
  await bindWorkflowToApp(env, builder, resource.id, {
    app: fixture.app,
    alias: "followUp",
    version: 1,
  });
  await seal(fixture);
  const release = await loadRelease(env, fixture.app, 1);
  return { builder, app: fixture.app, release, options };
};

type RequestsApp = Awaited<ReturnType<typeof requestsApp>>;

/** A start of `followUp` with `args`, as the SDK sends it. */
const startOf = async (release: Release, args: unknown): Promise<string> => {
  const declared = declaredWorkflows(release.app, release.workflows).find(
    ({ alias }) => alias === "followUp"
  );
  if (declared === undefined) {
    throw new Error("No followUp");
  }
  return await Promise.resolve(
    JSON.stringify({
      reference: {
        name: "workflows.followUp.mutations.start",
        kind: "mutation",
      },
      args: { args },
    })
  );
};

const startedSchema = z.object({
  ok: z.literal(true),
  value: z.object({ run: z.number() }),
});

/** A test session on `app`'s release, its run of `followUp` for "Ada" started. */
const runningIn = async (app: RequestsApp) => {
  const host = fixtureHostFor(
    env,
    app.release,
    await releaseIdsOf(env, app.release)
  );
  const session = await host.open(`test-${unique()}`);
  await session.identify(
    JSON.stringify({ name: "desk-user", role: "user", teams: [] })
  );
  const { value } = startedSchema.parse(
    JSON.parse(
      await session.start(
        "desk-user",
        await startOf(app.release, { who: "Ada" }),
        JSON.stringify(app.options)
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
    await rollback(env, appPublishing, by, app, 1);
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

/** A suite of one test of the App's workflow, `body` with `owner` at hand. */
const suiteOf = (
  body: string
): string => `import { appTest } from "@grasp-os/sdk/testing";
import { ${["api", "workflows"].filter((name) => body.includes(`${name}.`)).join(", ")} } from "@server/_generated/api";
import { expect } from "vitest";
import schema from "../server/schema.ts";

export default appTest(schema, {
  "runs": async (t) => {
${body.includes("owner") ? '    const owner = t.withIdentity({ name: "desk-user" });' : ""}
    ${body}
  },
});
`;

describe("a workflow test's model calls", { timeout: 180_000 }, () => {
  it("answer a model call with the start's answer, and never ask a model or leave a trace of one", async () => {
    const provider = await watchedProvider();
    const app = await requestsApp(
      { steps: [summarize], status: line },
      {},
      {
        "tests/greet.test.ts": suiteOf(`
      const run = await owner.start(
        workflows.followUp,
        { who: "Ada" },
        { models: { ai: { line: "Hello from the test" } } }
      );
      expect(await t.runs.untilTerminal(run)).toEqual({
        status: "completed",
        result: { status: "Hello from the test" },
      });
      expect(await t.effects.completedCount(run, "summarize")).toBe(1);
      expect(await t.effects.modelRequestCount(run, "summarize")).toBe(1);`),
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

  it("fail a model call the start gives nothing, or an answer the task's schema doesn't take, without asking a model", async () => {
    const provider = await watchedProvider();
    const tasks = { steps: [summarize], status: line };
    expect({
      unfixtured: await endedIn(await requestsApp(tasks, {})),
      otherBinding: await endedIn(
        await requestsApp(tasks, { models: { elsewhere: { line: "Hi" } } })
      ),
      wrongShape: await endedIn(
        await requestsApp(tasks, { models: { ai: { words: 3 } } })
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
                  type: "call",
                  connection: "save",
                  action: "add",
                  args: { who: { $expr: "args.who" } },
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
      { models: { ai: { line: "Hello" } } }
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
        ended: { status: "completed", result: { status: "Hello" } },
        completed: 1,
        asked: 0,
      }
    );
  });

  it("restart a run for real after the step its fault names, replaying it from the journal: the step's effect isn't repeated", async () => {
    const provider = await watchedProvider();
    /** How `options`' run ended, its counts, and its activations. */
    const ranWith = async (options: StartOptions) => {
      const app = await requestsApp(
        { steps: [summarize], status: line },
        options
      );
      const { session, run, runId } = await runningIn(app);
      const ended: unknown = JSON.parse(await session.runOutcome(run));
      const completed = await session.completedCount(run, "summarize");
      const requests = await session.modelRequestCount(run, "summarize");
      const activations = await runInDurableObject(
        runObjectOf(env, runId),
        (_object, state) =>
          state.storage.sql
            .exec<{ generation: number; ended: string | null }>(
              "SELECT generation, ended FROM activations ORDER BY generation"
            )
            .toArray()
      );
      await session.close();
      return { ended, completed, requests, activations };
    };
    const models = { ai: { line: "Hello" } };
    const faulted = await ranWith({ models, restartAfterStep: "summarize" });
    const plain = await ranWith({ models });
    expect({
      faulted: {
        ...faulted,
        superseded: faulted.activations.filter(
          ({ ended }) => ended === "superseded"
        ).length,
        generations: faulted.activations.length,
      },
      plain: {
        ...plain,
        superseded: plain.activations.filter(
          ({ ended }) => ended === "superseded"
        ).length,
        generations: plain.activations.length,
      },
      asked: provider.requests.length,
    }).toMatchObject({
      faulted: {
        ended: { status: "completed", result: { status: "Hello" } },
        completed: 1,
        requests: 1,
        superseded: 1,
        generations: 2,
      },
      plain: {
        ended: { status: "completed", result: { status: "Hello" } },
        completed: 1,
        requests: 1,
        superseded: 0,
        generations: 1,
      },
      asked: 0,
    });
  });

  it.each([
    ["a task the workflow doesn't have", "summarise"],
    ["a sleep, whose step journals no result", "hold"],
  ])("refuse a fault after %s, which would never fire", async (_case, task) => {
    const app = await requestsApp(
      { steps: [summarize, hold("1 second")], status: line },
      { models: { ai: { line: "Hello" } }, restartAfterStep: task }
    );
    const host = fixtureHostFor(
      env,
      app.release,
      await releaseIdsOf(env, app.release)
    );
    const session = await host.open(`test-${unique()}`);
    await session.identify(
      JSON.stringify({ name: "desk-user", role: "user", teams: [] })
    );
    const answer: unknown = JSON.parse(
      await session.start(
        "desk-user",
        await startOf(app.release, { who: "Ada" }),
        JSON.stringify(app.options)
      )
    );
    const left = await leftOf(app.app);
    await session.close();
    expect({ answer, left }).toMatchObject({
      answer: { ok: false, error: { code: "contract.invalid_args" } },
      left: { runs: 0 },
    });
  });

  it("count each task's model requests as the test's provider answered them, apart", async () => {
    const provider = await watchedProvider();
    const again = { ...summarize, id: "again" };
    const app = await requestsApp(
      {
        steps: [summarize, again, hold("1 second")],
        status: line,
      },
      { models: { ai: { line: "Hello" } } }
    );
    const { session, run } = await runningIn(app);
    const ended: unknown = JSON.parse(await session.runOutcome(run));
    const counts = {
      summarize: await session.modelRequestCount(run, "summarize"),
      again: await session.modelRequestCount(run, "again"),
      hold: await session.modelRequestCount(run, "hold"),
      none: await session.modelRequestCount(run, "none"),
    };
    const invalid = await session
      .modelRequestCount(run, "not a task")
      .then(() => "counted")
      .catch((error: unknown) =>
        isExpectedError(error) ? error.code : "threw"
      );
    await session.close();
    expect({
      ended,
      counts,
      invalid,
      asked: provider.requests.length,
    }).toStrictEqual({
      ended: { status: "completed", result: { status: "Hello" } },
      counts: { summarize: 1, again: 1, hold: 0, none: 0 },
      invalid: "contract.invalid_args",
      asked: 0,
    });
  });
});
