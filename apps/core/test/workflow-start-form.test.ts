import type { Role } from "@grasp-os/shared/roles";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { decideGoLive, requestGoLive } from "../src/workflow-lifecycle.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { workflowStartForm } from "../src/workflow-start-form.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { outcome, unique } from "./sign-in.ts";

// Starting an independent workflow by hand from its page (GRA-1305): what
// the page reads to start one (src/workflow-start-form.ts), and that the
// start it then makes goes through for those, and only those, who may
// start the workflow. From the ways it can fail: someone with no role
// learning of the workflow or starting it; a form for a version other
// than the one a start should run; a form whose input the start then
// refuses, or one that lets through input the workflow doesn't take.

/** A member of the organization in `role`, as their session has them. */
const person = async (role: Role): Promise<Acting> => {
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

/** A workflow.json named `name` at `version`, whose input is an object with `properties`. */
const definitionOf = (
  name: string,
  version: string,
  properties: Record<string, unknown>
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version,
      title: name,
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
          params: {},
          bindings: {},
        },
      },
    },
    input: {
      schema: {
        format: "json",
        document: {
          type: "object",
          properties,
          required: Object.keys(properties),
          additionalProperties: false,
        },
      },
    },
    output: {
      schema: {
        format: "json",
        document: {
          type: "object",
          properties: { status: { type: "string" } },
          required: ["status"],
          additionalProperties: false,
        },
      },
    },
    do: [{ finish: { set: { status: "done" } } }],
  });

/** The input `version` takes: who to greet, and how many times. */
const greeting = { who: { type: "string" }, times: { type: "integer" } };

/** Ada's workflow, published once, Uma its user; Carl a member with no role in it. */
const greetingWorkflow = async () => {
  const [ada, uma, carl] = await Promise.all([
    person("builder"),
    person("user"),
    person("user"),
  ]);
  const workflow = await createWorkflowResource(env, ada, `greet-${unique()}`);
  await publishWorkflowVersion(env, ada, workflow.id, {
    definition: definitionOf(workflow.name, "1.0.0", greeting),
    basedOn: null,
  });
  await shareWorkflowResource(env, ada, workflow.id, {
    type: "person",
    id: uma.userId,
    role: "user",
  });
  return { ada, uma, carl, workflow };
};

/** What starting `id` by hand as `by` with the form's version and `input` answers. */
const started = async (
  by: Acting,
  id: string,
  version: number | null,
  input: unknown
): Promise<string> =>
  await outcome(
    startWorkflow(env, { type: "person", person: by }, id, {
      version,
      input,
      key: `key-${unique()}`,
    })
  );

describe("starting an independent workflow by hand", () => {
  it("gives anyone with a role the version a start runs and the exact schema of its input, which the start takes", async () => {
    const { ada, uma, workflow } = await greetingWorkflow();

    const [byBuilder, byUser] = await Promise.all([
      workflowStartForm(env, ada, workflow.id),
      workflowStartForm(env, uma, workflow.id),
    ]);

    expect({
      byBuilder,
      byUser,
      // The form's input, as a person fills it in, starts a run.
      starts: await started(uma, workflow.id, byUser.version, {
        who: "Ada",
        times: 2,
      }),
      // What the form says the start won't take, it doesn't.
      missing: await started(uma, workflow.id, byUser.version, { who: "Ada" }),
      extra: await started(uma, workflow.id, byUser.version, {
        who: "Ada",
        times: 2,
        also: true,
      }),
      wrongType: await started(uma, workflow.id, byUser.version, {
        who: "Ada",
        times: "two",
      }),
    }).toStrictEqual({
      byBuilder: byUser,
      byUser: {
        version: 1,
        input: {
          type: "object",
          properties: {
            who: { type: "string" },
            times: { type: "integer" },
          },
          required: ["times", "who"],
          additionalProperties: false,
        },
      },
      starts: "ok",
      missing: "workflow.start_invalid",
      extra: "workflow.start_invalid",
      wrongType: "workflow.start_invalid",
    });
  });

  it("tells someone with no role in it nothing, and lets them start nothing", async () => {
    const { carl, workflow } = await greetingWorkflow();

    expect({
      form: await outcome(workflowStartForm(env, carl, workflow.id)),
      start: await started(carl, workflow.id, 1, { who: "Ada", times: 1 }),
      unknown: await outcome(workflowStartForm(env, carl, crypto.randomUUID())),
    }).toStrictEqual({
      form: "workflow.resource_unavailable",
      start: "workflow.resource_unavailable",
      // As for a workflow that doesn't exist.
      unknown: "workflow.resource_unavailable",
    });
  });

  it("runs the version approved to go live, not one published after it, and none before any is published", async () => {
    const { ada, uma, workflow } = await greetingWorkflow();
    const admin = await person("admin");
    const asked = await requestGoLive(env, ada, workflow.id, {
      version: 1,
      revision: 0,
    });
    await decideGoLive(env, admin, workflow.id, {
      version: 1,
      verdict: "approve",
      revision: asked.revision,
    });
    // Version 2 takes other input, and isn't live.
    await publishWorkflowVersion(env, ada, workflow.id, {
      definition: definitionOf(workflow.name, "1.1.0", {
        who: { type: "string" },
      }),
      basedOn: 1,
    });
    const empty = await createWorkflowResource(env, ada, `new-${unique()}`);
    const live = await workflowStartForm(env, uma, workflow.id);

    expect({
      live: { version: live.version, fields: live.input?.required },
      starts: await started(uma, workflow.id, live.version, {
        who: "Ada",
        times: 1,
      }),
      unpublished: await workflowStartForm(env, ada, empty.id),
    }).toStrictEqual({
      live: { version: 1, fields: ["times", "who"] },
      starts: "ok",
      unpublished: { version: null, input: null },
    });
  });
});
