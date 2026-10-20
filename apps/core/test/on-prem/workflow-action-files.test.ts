/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { Json } from "@grasp-os/shared/json";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { loadWorkflowBuild } from "../../src/workflow-builds.ts";
import { publishCatalogContract } from "../../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../../src/workflow-resources.ts";
import { callAction } from "../../src/workflows/resource-action.ts";
import type { BuiltCall } from "../../src/workflows/resource-calls.ts";
import { callFiles } from "../../src/workflows/run-files.ts";
import { unique } from "../sign-in.ts";

// A workflow action's run files on-prem (GRA-724): the action runs on the
// sandbox host with no bindings and no network, and every byte of a file
// it writes and reads crosses the session's one capability, the host's
// `call`, as a files call core makes: nothing in the sandbox touches R2.

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

const filesModule = `import { action, resource, v } from "@grasp-os/sdk/action";

export const keep = action({
  args: { text: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [resource.files("files", { operations: ["write", "read"] })],
  handler: async (ctx, args) => {
    const bound = typeof Reflect.get(globalThis, "FILES");
    let network = "refused";
    try {
      await fetch("https://example.com/");
      network = "reached";
    } catch {
      network = "refused";
    }
    const written = await ctx.resources.files.write({ name: "a.txt", type: "text/plain", content: args.text });
    const text = await ctx.resources.files.read({ file: written.file });
    return { status: JSON.stringify({ bound, network, same: text === args.text, size: written.size }) };
  },
});
`;

describe("a workflow action's run files on-prem", () => {
  it("cross the session only as the host's files calls: the sandbox has no bucket and no network", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = `files-${unique()}`;
    await publishCatalogContract(env, admin, { key, kind: "files" });
    const workflow = await createWorkflowResource(
      env,
      ada,
      `files-${unique()}`
    );
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
                keep: {
                  kind: "operation",
                  contract: "local:code/keep.ts#keep",
                },
                files: { kind: "files", contract: key },
              },
            },
          },
        },
        input: { schema: objectSchema({ text: { type: "string" } }) },
        output: { schema: objectSchema({ status: { type: "string" } }) },
        do: [
          {
            keep: {
              call: "grasp.operation",
              with: {
                binding: "keep",
                arguments: { text: "${ $workflow.input.text }" },
              },
            },
          },
        ],
      }),
      basedOn: null,
      modules: { "code/keep.ts": filesModule },
    });
    const build = await loadWorkflowBuild(env, workflow.id, 1);
    // A call's bytes and more: two pieces, within the action's input.
    const text = "abcdefgh".repeat(100_000);
    const runId = crypto.randomUUID();
    const made: string[] = [];
    const answer = await callAction(
      env,
      build.compute,
      build.sdk,
      {
        name: "grasp.action",
        binding: "keep",
        module: "code/keep.ts",
        export: "keep",
        arguments: { literal: null },
      },
      { text },
      Date.now() + 120_000,
      {
        owner: `workflow-resource:${workflow.id}`,
        refused: async () => {
          await Promise.resolve();
        },
        // What core's host does for each call (resource-calls.ts): the
        // files call, for this run, keyed as the action's calls are.
        make: async (built: BuiltCall, ordinal: number): Promise<Json> => {
          made.push(
            built.name === "grasp.files" ? built.operation : built.name
          );
          if (built.name !== "grasp.files") {
            throw new Error("Only files calls are made here");
          }
          const { output } = await callFiles(
            env,
            { runId, workflowId: workflow.id, effectKey: `step:${ordinal}` },
            built.operation,
            built.arguments
          );
          return output;
        },
      }
    );
    expect({ answer, made }).toStrictEqual({
      answer: {
        status: JSON.stringify({
          bound: "undefined",
          network: "refused",
          same: true,
          size: text.length,
        }),
      },
      made: ["open", "append", "append", "finish", "read", "read"],
    });
  }, 120_000);
});
