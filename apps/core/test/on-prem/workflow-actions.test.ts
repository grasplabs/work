/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import type { Json } from "@grasp-os/shared/json";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { loadWorkflowBuild } from "../../src/workflow-builds.ts";
import { publishCatalogContract } from "../../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../../src/workflow-resources.ts";
import { startWorkflow } from "../../src/workflow-starts.ts";
import { callAction } from "../../src/workflows/resource-action.ts";
import type { BuiltCall } from "../../src/workflows/resource-calls.ts";
import { resourceRunFor } from "../../src/workflows/resource-runs.ts";
import { unique } from "../sign-in.ts";

// A JSON workflow's own action on-prem: it runs as a sandbox session of
// its own (resource-action.ts), its one capability the host's `call`,
// passed in over the session as a run's host is.

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

describe("a JSON workflow's own action on-prem", () => {
  it("runs on the sandbox host, its resource calls reaching the host over its session", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = `mail-${unique()}`;
    await publishCatalogContract(env, admin, {
      key,
      kind: "connector",
      operations: {
        "mail.send": {
          input: JSON.stringify(
            v.object({ to: v.string(), subject: v.string() }).descriptor
          ),
          output: JSON.stringify(
            v.object({ messageId: v.string() }).descriptor
          ),
        },
      },
    });
    const workflow = await createWorkflowResource(env, ada, `act-${unique()}`);
    await publishWorkflowVersion(env, ada, workflow.id, {
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
                notify: {
                  kind: "operation",
                  contract: "local:code/notify.ts#notify",
                },
                mail: { kind: "connector", contract: key },
              },
            },
          },
        },
        input: { schema: objectSchema({ who: { type: "string" } }) },
        output: { schema: objectSchema({ status: { type: "string" } }) },
        do: [
          {
            notify: {
              call: "grasp.operation",
              with: {
                binding: "notify",
                arguments: { to: "${ $workflow.input.who }" },
              },
            },
          },
        ],
      }),
      basedOn: null,
      modules: {
        "code/notify.ts": `import { action, resource, v } from "@grasp-os/sdk/action";

export const notify = action({
  args: { to: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [resource.connector("mail", { operations: ["mail.send"] })],
  handler: async (ctx, args) => {
    const first = await ctx.resources.mail.call("mail.send", { to: args.to, subject: "one" });
    const second = await ctx.resources.mail.call("mail.send", { to: args.to, subject: "two" });
    return { status: [JSON.stringify(first), JSON.stringify(second)].join(" ") };
  },
});
`,
      },
    });
    const build = await loadWorkflowBuild(env, workflow.id, 1);
    const made: BuiltCall[] = [];
    const answer = await callAction(
      env,
      build.compute,
      build.sdk,
      {
        name: "grasp.action",
        binding: "notify",
        module: "code/notify.ts",
        export: "notify",
        arguments: { literal: null },
      },
      { to: "Ada" },
      Date.now() + 60_000,
      {
        owner: `workflow-resource:${workflow.id}`,
        refused: async () => {
          await Promise.resolve();
        },
        make: async (built: BuiltCall, ordinal: number): Promise<Json> => {
          made.push(built);
          return await Promise.resolve({ messageId: `m${ordinal}` });
        },
      }
    );
    expect({
      answer,
      made: made.map((built) =>
        built.name === "grasp.connector"
          ? [built.binding, built.operation, built.arguments]
          : built.name
      ),
    }).toStrictEqual({
      answer: { status: '{"messageId":"m1"} {"messageId":"m2"}' },
      made: [
        ["mail", "mail.send", { to: "Ada", subject: "one" }],
        ["mail", "mail.send", { to: "Ada", subject: "two" }],
      ],
    });
  }, 60_000);

  it("runs the actions of two runs at once, each a child of its run's own session", async () => {
    const ada = await person("builder");
    const workflow = await createWorkflowResource(env, ada, `act-${unique()}`);
    await publishWorkflowVersion(env, ada, workflow.id, {
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
                notify: {
                  kind: "operation",
                  contract: "local:code/notify.ts#notify",
                },
              },
            },
          },
        },
        input: { schema: objectSchema({ who: { type: "string" } }) },
        output: { schema: objectSchema({ status: { type: "string" } }) },
        do: [
          {
            notify: {
              call: "grasp.operation",
              with: {
                binding: "notify",
                arguments: { to: "${ $workflow.input.who }" },
              },
            },
          },
        ],
      }),
      basedOn: null,
      modules: {
        "code/notify.ts": `import { action, v } from "@grasp-os/sdk/action";

export const notify = action({
  args: { to: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [],
  handler: (_ctx, args) => ({ status: \`hello \${args.to}\` }),
});
`,
      },
    });
    const start = async (who: string) => {
      const { runId } = await startWorkflow(
        env,
        { type: "person", person: ada },
        workflow.id,
        { version: 1, input: { who }, key: unique() }
      );
      if (runId === null) {
        throw new Error("The start admitted no run");
      }
      return runId;
    };
    const runs = await Promise.all([start("Ada"), start("Grace")]);
    const ends = await Promise.all(
      runs.map(
        async (runId) =>
          await vi.waitFor(
            async () => {
              const read = await resourceRunFor(env, ada, workflow.id, runId);
              expect(read.endedAt).not.toBeNull();
              return read.status === "completed"
                ? { status: read.status, output: read.output }
                : { status: read.status, code: read.error?.code };
            },
            { timeout: 90_000, interval: 500 }
          )
      )
    );
    expect(ends).toStrictEqual([
      { status: "completed", output: { status: "hello Ada" } },
      { status: "completed", output: { status: "hello Grace" } },
    ]);
  }, 120_000);
});
