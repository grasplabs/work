/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { activateVersion } from "../../src/app-activation.ts";
import { loadRelease } from "../../src/app-releases.ts";
import { bindWorkflowToApp } from "../../src/app-workflow-bindings.ts";
import type { Acting } from "../../src/auth/identity.ts";
import { publishCatalogContract } from "../../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../../src/workflow-resources.ts";
import { appWith, person, seal } from "../sealed-apps.ts";
import { unique } from "../sign-in.ts";

// A workflow test's store call on-prem (workflows/fixture-calls.ts): its
// operation runs in the sandbox as a child of the suite's session, taking
// its turn among the suite's calls, never a place of the pool of its own.
// With the supervisor's two processes, the suite holding one while it
// waits for its run, a store call of its own place would wait for ever.

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

describe("a workflow test's store call on-prem", { timeout: 180_000 }, () => {
  it("runs as a child of the suite's session, so the suite waiting for its run never holds it up", async () => {
    const app = await requestsApp(
      [save, { finish: { set: { status: "saved" } } }],
      { operations: { save: "requests.add" } },
      {
        "tests/save.test.ts": suiteOf(`
      const run = await owner.start(workflows.followUp, { who: "Ada" });
      t.equal(await t.runs.untilTerminal(run), {
        status: "completed",
        output: { status: "saved" },
      });
      t.equal(await owner.query(api.requests.list, {}), ["Ada"]);`),
      }
    );
    await expect(activated(app.builder, app.app)).resolves.toBe("current");
  });
});
