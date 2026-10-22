/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { v } from "@grasp-os/sdk";
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
import { fixtureHostFor } from "../src/app-tests.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import type { Acting } from "../src/auth/identity.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { resumed, sleeping, stopped } from "./runs.ts";
import { appWith, calledAs, person, seal } from "./sealed-apps.ts";
import { auditedDuring, unique } from "./sign-in.ts";

// The model and store calls of a run an App's test started (`workflowTest`,
// workflows/fixture-calls.ts), from its threat model first: a test's run
// asks a real model, spends budget or leaves a trace of a model call; its
// store call reaches the App's own store, another App's or another test's;
// it runs an operation the release doesn't serve, or one of a shape the
// contract doesn't take; a call the fixture gives nothing falls through to
// a real one; a replay repeats a store write. Then what a test sees: the
// fixture's answer, and its own store holding what the run wrote.

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
  bindings: Record<string, unknown>
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

/** Asks the `summary` model binding for a line about the input's `who`. */
const summarize = {
  summarize: {
    call: "grasp.model",
    with: {
      binding: "summary",
      instructions: "Greet them.",
      input: { who: "${ $workflow.input.who }" },
      outputSchema: objectSchema({ line: { type: "string" } }),
    },
    export: { as: "${ {line: .line} }" },
  },
};

/** Saves the input's `who` through the `save` operation binding. */
const save = {
  save: {
    call: "grasp.operation",
    with: { binding: "save", arguments: { who: "${ $workflow.input.who }" } },
  },
};

/** What a test's fixture gives the workflow the App binds as `followUp`. */
interface WorkflowFixture {
  models?: Record<string, unknown>;
  operations?: Record<string, string>;
}

/** The App's files: it binds `followUp` and keeps requests; `tests`. */
const filesWith = (
  workflow: WorkflowFixture,
  tests: Record<string, string> = {}
): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  requests: defineTable({ who: v.string() }),
});
`,
  "operations/requests.ts": `import { resource, v } from "@grasp-os/sdk";
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
  handler: async (ctx) => (await ctx.db.query("requests").take(100)).map(({ who }) => who),
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
  "tests/fixtures/desk.json": JSON.stringify({
    principals: { "desk-user": { role: "user" } },
    workflows: { followUp: workflow },
  }),
  ...tests,
});

/** The catalog contracts `admin` publishes: a model's, and `requests.add`'s. */
const contracts = async (admin: Identity) => {
  const model = `summary-${unique()}`;
  await publishCatalogContract(env, admin, { key: model, kind: "model" });
  const operation = `save-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: operation,
    kind: "operation",
    input: JSON.stringify(v.object({ who: v.string() }).descriptor),
    output: JSON.stringify(v.null().descriptor),
  });
  return { model, operation };
};

/**
 * The Requests App binding a workflow of `tasks` as `followUp`, its model
 * binding `summary` and its operation binding `save`, with `workflow` as
 * its fixture and `tests` as its tests.
 */
const requestsApp = async (
  tasks: unknown[],
  workflow: WorkflowFixture,
  tests: Record<string, string> = {}
) => {
  const admin = await person("admin");
  const keys = await contracts(admin);
  const builder = await person("builder");
  const files = filesWith(workflow, tests);
  const fixture = await appWith(files, "Requests", builder);
  const resource = await createWorkflowResource(
    env,
    builder,
    `greet-${unique()}`
  );
  await publishWorkflowVersion(env, builder, resource.id, {
    definition: definitionOf(resource.name, tasks, {
      summary: { kind: "model", contract: keys.model },
      save: { kind: "operation", contract: keys.operation },
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
  return { builder, app: fixture.app, store: fixture.store, release, files };
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

/** The model gateway, faked: what it was asked. */
const watchedGateway = () => {
  const gateway = fakeGateway({
    text: '{"line":"From a real model"}',
    inputTokens: 1,
    outputTokens: 1,
  });
  const ai: AiBinding = env.AI;
  vi.spyOn(ai, "fetch").mockImplementation(gateway.binding.fetch);
  return gateway;
};

/** Activates version 1 of `app`: "current", or the refusal's failures. */
const activated = async (
  by: Acting & Identity,
  app: string
): Promise<unknown> => {
  try {
    await activateVersion(env, by, app, 1);
    return "current";
  } catch (error) {
    if (!isExpectedError(error)) {
      throw error;
    }
    return error.details?.failures ?? error.code;
  }
};

/** What the App's own store holds, as its builder reads it once current. */
const ownStoreOf = async (app: RequestsApp): Promise<unknown> => {
  const result = await calledAs(app.builder, app.app, {
    contractId: "requests.list",
    kind: "query",
  });
  return result.ok ? result.value : result.error.code;
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
import { api, workflows } from "#grasp";

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

describe(
  "a workflow test's model and store calls",
  { timeout: 180_000 },
  () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("answer a model call with the fixture's answer, and never ask a model or leave a trace of one", async () => {
      const gateway = watchedGateway();
      const app = await requestsApp(
        [summarize, { finish: { set: { status: "${ $context.line }" } } }],
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
        asked: gateway.requests.length,
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
      const gateway = watchedGateway();
      const tasks = [
        summarize,
        { finish: { set: { status: "${ $context.line }" } } },
      ];
      expect({
        unfixtured: await endedIn(await requestsApp(tasks, {})),
        otherBinding: await endedIn(
          await requestsApp(tasks, { models: { elsewhere: { line: "Hi" } } })
        ),
        wrongShape: await endedIn(
          await requestsApp(tasks, { models: { summary: { words: 3 } } })
        ),
        asked: gateway.requests.length,
      }).toMatchObject({
        unfixtured: { status: "failed", code: "workflow.test_unfixtured" },
        otherBinding: { status: "failed", code: "workflow.test_unfixtured" },
        wrongShape: { status: "failed", code: "workflow.call_invalid" },
        asked: 0,
      });
    });

    it("run a store call on the test's own store, which the test reads back, and never on the App's own store", async () => {
      const app = await requestsApp(
        [save, { finish: { set: { status: "saved" } } }],
        { operations: { save: "requests.add" } },
        {
          "tests/save.test.ts": suiteOf(`
      t.equal(await owner.query(api.requests.list, {}), []);
      const run = await owner.start(workflows.followUp, { who: "Ada" });
      t.equal(await t.runs.untilTerminal(run), {
        status: "completed",
        output: { status: "saved" },
      });
      t.equal(await owner.query(api.requests.list, {}), ["Ada"]);`),
        }
      );
      expect({
        outcome: await activated(app.builder, app.app),
        ownStore: await ownStoreOf(app),
        left: await leftOf(app.app),
      }).toStrictEqual({
        outcome: "current",
        ownStore: [],
        left: { stores: 0, runs: 0 },
      });
    });

    it("refuse a store call whose run names the App's own store or another App's test store, and change neither", async () => {
      const tasks = [
        { hold: { wait: "PT1S" } },
        save,
        { finish: { set: { status: "saved" } } },
      ];
      const app = await requestsApp(tasks, {
        operations: { save: "requests.add" },
      });
      const other = await requestsApp(tasks, {
        operations: { save: "requests.add" },
      });
      // Another App's test store, recorded as its tests record one.
      const otherStore = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO app_test_fixtures (store_id, app_id, version, created_at) VALUES (?, ?, 1, ?)"
      )
        .bind(otherStore, other.app, Date.now())
        .run();
      const endedOn = async (store: string | null): Promise<unknown> => {
        const { session, run, runId } = await runningIn(app);
        // While it holds, its record is changed to name another store.
        await env.DB.prepare(
          "UPDATE app_test_runs SET store_id = ? WHERE run_id = ?"
        )
          .bind(store, runId)
          .run();
        const ended: unknown = JSON.parse(await session.runOutcome(run));
        await session.close();
        return ended;
      };
      const endedOnRecorded = async (store: string): Promise<unknown> => {
        await env.DB.prepare(
          "INSERT INTO app_test_fixtures (store_id, app_id, version, created_at) VALUES (?, ?, 1, ?)"
        )
          .bind(store, app.app, Date.now())
          .run();
        try {
          return await endedOn(store);
        } finally {
          // Never left for the sweep, which would discard what it names.
          await env.DB.prepare(
            "DELETE FROM app_test_fixtures WHERE store_id = ?"
          )
            .bind(store)
            .run();
        }
      };
      const refused = {
        ownStore: await endedOn(app.store),
        otherAppsStore: await endedOn(otherStore),
        noStore: await endedOn(null),
        // Its own store recorded as a test store too: listed, so never one.
        ownStoreRecorded: await endedOnRecorded(app.store),
      };
      await activated(app.builder, app.app);
      expect({ refused, ownStore: await ownStoreOf(app) }).toMatchObject({
        refused: {
          ownStore: { status: "failed", code: "resource.unavailable" },
          otherAppsStore: { status: "failed", code: "resource.unavailable" },
          noStore: { status: "failed", code: "resource.unavailable" },
          ownStoreRecorded: { status: "failed", code: "resource.unavailable" },
        },
        ownStore: [],
      });
    });

    it("refuse an operation the release doesn't serve as the binding's contract, and fail a binding the fixture gives none", async () => {
      const tasks = [save, { finish: { set: { status: "saved" } } }];
      expect({
        otherShape: await endedIn(
          await requestsApp(tasks, { operations: { save: "requests.list" } })
        ),
        missing: await endedIn(
          await requestsApp(tasks, { operations: { save: "requests.remove" } })
        ),
        unfixtured: await endedIn(await requestsApp(tasks, {})),
      }).toMatchObject({
        otherShape: { status: "failed", code: "workflow.call_denied" },
        missing: { status: "failed", code: "workflow.call_denied" },
        unfixtured: { status: "failed", code: "workflow.test_unfixtured" },
      });
    });

    it("write once and answer once, though the run stops after its calls and starts again", async () => {
      const gateway = watchedGateway();
      const app = await requestsApp(
        [
          save,
          summarize,
          { hold: { wait: "PT2S" } },
          { finish: { set: { status: "${ $context.line }" } } },
        ],
        {
          models: { summary: { line: "Hello" } },
          operations: { save: "requests.add" },
        }
      );
      const { session, run, runId } = await runningIn(app);
      await sleeping(runId, "task:hold");
      // Down while it waits, then back: the workflow runs again from its
      // start, its finished steps replayed.
      await stopped(runId);
      await resumed(runId);
      const ended: unknown = JSON.parse(await session.runOutcome(run));
      const saved: unknown = JSON.parse(
        await session.call(
          "desk-user",
          JSON.stringify({
            reference: {
              resourceId: app.release.manifest.resourceId,
              resourceVersion: app.release.manifest.resourceVersion,
              contractId: "requests.list",
              fingerprint: app.release.fingerprints["requests.list"],
              kind: "query",
            },
            input: {},
          })
        )
      );
      const completed = {
        save: await session.completedCount(run, "save"),
        summarize: await session.completedCount(run, "summarize"),
      };
      await session.close();
      expect({
        ended,
        saved,
        completed,
        asked: gateway.requests.length,
      }).toStrictEqual({
        ended: { status: "completed", output: { status: "Hello" } },
        saved: { ok: true, value: ["Ada"] },
        completed: { save: 1, summarize: 1 },
        asked: 0,
      });
    });
  }
);
