/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import { jsonSchemaOf, schemaFromDescriptor } from "@grasp-os/sdk/host";
import type { ConnectorContract } from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  workflowNamespace,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import { loadWorkflowBuild } from "../src/workflow-builds.ts";
import type { LoadedModules } from "../src/workflow-builds.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import {
  callAction,
  maxActionCalls,
} from "../src/workflows/resource-action.ts";
import { makeCall } from "../src/workflows/resource-calls.ts";
import type { BuiltCall } from "../src/workflows/resource-calls.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { allEvents } from "./audit-events.ts";
import { mailConnection } from "./mail-connection.ts";
import { outcome, refusal, unique } from "./sign-in.ts";

// A JSON workflow's own actions (workflow-modules.ts, resource-action.ts),
// from the threat model on GRA-666: an action reaches the bindings it
// declares and nothing else, each call decided again and kept as an
// effect of its own, within its one bounded step.

const identityOf = (userId: string, role: Role): Identity => ({
  userId,
  email: `${userId}@acme.test`,
  name: "Person",
  role,
  teams: [],
  staff: false,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

/** A member of the organization with `role`, as their session has them. */
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
  return identityOf(userId, role);
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

const descriptorOf = (schema: { descriptor: unknown }): string =>
  JSON.stringify(schema.descriptor);

const shapeOf = (descriptor: string) =>
  jsonSchemaOf(schemaFromDescriptor(descriptor).descriptor, { exact: true });

const rolesOf = (by: Identity) => ({
  app: async (named: string, role: "user" | "builder") =>
    await appFor(env, by, named, role),
  resource: async (
    ref: Parameters<typeof requireResourceRole>[2],
    needed: Parameters<typeof requireResourceRole>[3]
  ) => {
    await requireResourceRole(env, by, ref, needed);
  },
});

/** A permission `by` asks for and `admin` grants. */
const granted = async (
  by: Identity,
  admin: Identity,
  request: PermissionRequest
): Promise<string> => {
  const asked = await requestPermission(env, by, request, rolesOf(by));
  await grantPermission(env, admin, asked.id, { version: null });
  return asked.id;
};

/** A connector contract of the catalog: `mail.send`. */
const mailContract = async (admin: Identity): Promise<string> => {
  const key = `mail-${unique()}`;
  await publishCatalogContract(env, admin, {
    key,
    kind: "connector",
    operations: {
      "mail.send": {
        input: descriptorOf(v.object({ to: v.string(), subject: v.string() })),
        output: descriptorOf(v.object({ messageId: v.string() })),
      },
    },
  });
  return key;
};

/** `env`, its connect serving the mail contract for the connection. */
const servingMail = (): Env => {
  const contract: ConnectorContract = {
    contract: "composio.mail@1",
    actions: {
      send: {
        tool: "mail.send",
        readOnly: false,
        input: JSON.stringify(
          shapeOf(
            descriptorOf(v.object({ to: v.string(), subject: v.string() }))
          )
        ),
        output: JSON.stringify(
          shapeOf(descriptorOf(v.object({ messageId: v.string() })))
        ),
      },
    },
  };
  return {
    ...env,
    CONNECT: new Proxy(env.CONNECT, {
      get: (target, name): unknown =>
        name === "connectorContract"
          ? async () => await Promise.resolve(contract)
          : Reflect.get(target, name),
    }),
  };
};

/** A module whose action `notify` runs `body` with `uses` declared. */
const notifyModule = (
  body: string,
  uses = '[resource.connector("mail")]'
): string => `import { action, resource, v } from "@grasp-os/sdk/action";

export const notify = action({
  args: { to: v.string() },
  returns: v.object({ status: v.string() }),
  uses: ${uses},
  handler: async (ctx, args) => {
    ${body}
  },
});
`;

/** Sends two mails and answers what the context holds. */
const sendsTwice =
  notifyModule(`await ctx.resources.mail.call("mail.send", { to: args.to, subject: "one" });
    await ctx.resources.mail.call("mail.send", { to: args.to, subject: "two" });
    return { status: [...Object.keys(ctx), ...Object.keys(ctx.resources)].join(",") };`);

/** The sealed call of the `notify` action. */
const notifyCall = {
  name: "grasp.action",
  binding: "notify",
  module: "code/notify.ts",
  export: "notify",
  arguments: { literal: null },
} as const;

/** A definition of `name`: binding `notify` to the action, and `mail`. */
/** What a definition holds besides its action: its tasks before, its `mail`. */
interface DefinitionParts {
  readonly before?: readonly unknown[];
  readonly mail?: { readonly kind: string; readonly contract: string };
}

const definitionOf = (
  name: string,
  {
    before = [],
    mail = { kind: "connector", contract: "" },
  }: DefinitionParts = {}
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
          params: {},
          bindings: {
            notify: {
              kind: "operation",
              contract: "local:code/notify.ts#notify",
            },
            mail,
          },
        },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      ...before,
      {
        notify: {
          call: "grasp.operation",
          with: {
            binding: "notify",
            arguments: { to: "${ $workflow.input.who }" },
          },
        },
      },
      { pause: { wait: "PT1S" } },
    ],
  });

/**
 * A workflow of `by`'s with `module` as its action, its `mail` binding a
 * connection of its own approved by `admin`.
 */
const actingWorkflow = async (
  by: Identity,
  admin: Identity,
  module: string,
  before: unknown[] = []
) => {
  const key = await mailContract(admin);
  const workflow = await createWorkflowResource(env, by, `act-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: definitionOf(workflow.name, {
      before,
      mail: { kind: "connector", contract: key },
    }),
    basedOn: null,
    modules: { "code/notify.ts": module },
  });
  const mail = await mailConnection();
  const permissionId = await granted(by, admin, {
    subject: { type: "workflow", workflowId: workflow.id },
    object: { type: "connection", connectionId: mail.id },
    actions: ["mail.send"],
    binding: `MAIL_${unique().toUpperCase().replaceAll("-", "_")}`,
  });
  const serving = servingMail();
  const approval = await approveWorkflowBinding(serving, admin, workflow.id, {
    alias: "mail",
    target: { kind: "connector", permissionId, contract: "composio.mail@1" },
    reviewed: { version: 1 },
  });
  return { workflow, mail, serving, approval, key };
};

/** Starts version 1 of workflow `id` for `by`, on `startEnv`. */
const started = async (
  by: Identity,
  id: string,
  startEnv: Env
): Promise<string> => {
  const { runId } = await startWorkflow(
    startEnv,
    { type: "person", person: by },
    id,
    { version: 1, input: { who: "Ada" }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  return runId;
};

/** How run `runId` of workflow `id` ended. */
const ended = async (by: Identity, id: string, runId: string) => {
  const run: WorkflowResourceRun = await vi.waitFor(
    async () => {
      const read = await resourceRunFor(env, by, id, runId);
      expect(read.endedAt).not.toBeNull();
      return read;
    },
    { timeout: 30_000, interval: 100 }
  );
  return run.status === "completed"
    ? { status: run.status, output: run.output }
    : { status: run.status, code: run.error?.code };
};

/** The receipts of run `runId`'s calls: call, binding, key and outcome. */
const receiptsOf = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      (event) =>
        event.action === "workflow.run.called" && event.target?.id === runId
    )
    .map(({ detail }) => ({
      call: detail?.call,
      binding: detail?.binding,
      key: detail?.key,
      result: detail?.outcome,
    }));
};

describe("a JSON workflow's own actions", () => {
  it("calls the bindings it declares, each an effect of its own, once even across a replay", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, mail, serving } = await actingWorkflow(
      ada,
      admin,
      sendsTwice
    );
    const runId = await started(ada, workflow.id, serving);
    const end = await ended(ada, workflow.id, runId);
    const sent = await mail.did();
    const receipts = await receiptsOf(runId);
    const keys = receipts.map(({ key }) => String(key));
    expect({
      end,
      // Two mails, though the run replayed after its pause.
      calls: sent.calls,
      receipts: receipts.map(({ call, binding, result }) => ({
        call,
        binding,
        result,
      })),
      // Each effect under a key of its own: its step's, and its ordinal.
      distinct: new Set(keys).size,
      ordinals: [keys[0]?.endsWith(":1"), keys[2]?.endsWith(":2")],
    }).toStrictEqual({
      // Its context holds its resources, and those its declared `mail`.
      end: { status: "completed", output: { status: "resources,mail" } },
      calls: 2,
      receipts: [
        { call: "grasp.connector", binding: "mail", result: "started" },
        { call: "grasp.connector", binding: "mail", result: "done" },
        { call: "grasp.connector", binding: "mail", result: "started" },
        { call: "grasp.connector", binding: "mail", result: "done" },
      ],
      distinct: 2,
      ordinals: [true, true],
    });
  });

  it("refuses a call once the approval behind its binding is revoked, though the action catches it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, mail, serving, approval } = await actingWorkflow(
      ada,
      admin,
      notifyModule(`try {
      await ctx.resources.mail.call("mail.send", { to: args.to, subject: "one" });
    } catch {
      // Swallowed: the refusal stands all the same.
    }
    return { status: "caught" };`),
      [{ hold: { wait: "PT1S" } }]
    );
    const runId = await started(ada, workflow.id, serving);
    await revokeWorkflowBinding(env, admin, workflow.id, approval.id);
    await expect(ended(ada, workflow.id, runId)).resolves.toStrictEqual({
      status: "failed",
      code: "workflow.call_denied",
    });
    const sent = await mail.did();
    expect(sent.calls).toBe(0);
  });

  it("refuses a definition whose action uses a binding it doesn't declare, or of another kind", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = await mailContract(admin);
    for (const [uses, mail] of [
      // Declares a use the definition has no binding for.
      ['[resource.connector("other")]', { kind: "connector", contract: key }],
      // Uses `mail` as an operation, which the definition binds a connector.
      ['[resource.operation("mail")]', { kind: "connector", contract: key }],
      // Uses the workflow's own action: never one of its own modules.
      ['[resource.operation("notify")]', { kind: "connector", contract: key }],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const workflow = await createWorkflowResource(
        env,
        ada,
        `act-${unique()}`
      );
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const error = await refusal(
        publishWorkflowVersion(env, ada, workflow.id, {
          definition: definitionOf(workflow.name, { mail }),
          basedOn: null,
          modules: {
            "code/notify.ts": notifyModule('return { status: "x" };', uses),
          },
        })
      );
      const parsed = z
        .object({ code: z.string(), details: z.unknown() })
        .parse(error);
      expect(parsed.code).toBe("workflow.definition_invalid");
      expect(JSON.stringify(parsed.details)).toContain("binding.unknown_use");
    }
  });

  it("fails with a refusal the action swallowed, even when its deadline ends it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await actingWorkflow(
      ada,
      admin,
      notifyModule(`try {
      await ctx.resources.mail.call("mail.send", { to: args.to, subject: "one" });
    } catch {
      // Swallowed, then waits on a call that never answers.
    }
    await ctx.resources.mail.call("mail.send", { to: args.to, subject: "two" });
    return { status: "late" };`)
    );
    const build = await loadWorkflowBuild(env, workflow.id, 1);
    let calls = 0;
    const code = await outcome(
      callAction(
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
        Date.now() + 2000,
        {
          owner: `workflow-resource:${workflow.id}`,
          make: async (): Promise<Json> => {
            calls += 1;
            if (calls === 1) {
              throw workflowResourceErrors.create("workflow.call_denied");
            }
            // oxlint-disable-next-line promise/avoid-new -- a call that never answers
            return await new Promise<never>(() => {
              // Never answers.
            });
          },
        }
      )
    );
    expect({ code, calls }).toStrictEqual({
      code: "workflow.call_denied",
      calls: 2,
    });
  });

  it("waits for every call an action made before its task records, and keeps the refusal of one it didn't wait for", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // Calls without waiting for them, and answers at once.
    const { workflow } = await actingWorkflow(
      ada,
      admin,
      notifyModule(`void ctx.resources.mail.call("mail.send", { to: args.to, subject: "late" });
    return { status: "answered" };`)
    );
    const build = await loadWorkflowBuild(env, workflow.id, 1);
    const run = async (make: () => Promise<Json>) =>
      await callAction(
        env,
        build.compute,
        build.sdk,
        notifyCall,
        { to: "Ada" },
        Date.now() + 30_000,
        { owner: `workflow-action:${workflow.id}`, make }
      );
    // Its effect lands before the task does.
    let done = false;
    const answered = await run(async () => {
      await scheduler.wait(200);
      done = true;
      return { messageId: "m" };
    });
    // Its refusal stands though the action never saw it.
    const refused = await outcome(
      run(async () => {
        await scheduler.wait(200);
        throw workflowResourceErrors.create("workflow.call_denied");
      })
    );
    expect({ answered, done, refused }).toStrictEqual({
      answered: { status: "answered" },
      done: true,
      refused: "workflow.call_denied",
    });
  });

  it("refuses arguments past a step's payload as a call's refusal, and hands the action no host error's detail", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await actingWorkflow(
      ada,
      admin,
      notifyModule(`let seen = "";
    try {
      await ctx.resources.mail.call("mail.send", { to: args.to, subject: "x".repeat(1_100_000) });
    } catch (error) {
      seen = String((error as Error).message);
    }
    try {
      await ctx.resources.mail.call("mail.send", { to: args.to, subject: "fails" });
    } catch (error) {
      seen = String((error as Error).message);
    }
    await ctx.resources.mail.call("mail.send", { to: args.to, subject: seen });
    return { status: "swallowed" };`)
    );
    const build = await loadWorkflowBuild(env, workflow.id, 1);
    const subjects: unknown[] = [];
    const code = await outcome(
      callAction(
        env,
        build.compute,
        build.sdk,
        notifyCall,
        { to: "Ada" },
        Date.now() + 30_000,
        {
          owner: `workflow-action:${workflow.id}`,
          make: async (built: BuiltCall): Promise<Json> => {
            subjects.push(
              built.name === "grasp.connector"
                ? z.object({ subject: z.string() }).parse(built.arguments)
                    .subject
                : null
            );
            if (subjects.length === 1) {
              // A host fault with internals in its message.
              throw new Error("internal: secret detail of the host");
            }
            return await Promise.resolve({ messageId: "m" });
          },
        }
      )
    );
    // The oversized call never reached the host, and stands as the task's
    // refusal; the host's fault reached the action as an opaque error.
    expect(code).toBe("workflow.call_invalid");
    expect(subjects).toHaveLength(2);
    expect(String(subjects[1])).not.toContain("secret detail");
  });

  it("refuses a restricted run's action its connector calls before anything is sent, and keeps the receipt", async () => {
    const runId = crypto.randomUUID();
    const code = await outcome(
      makeCall(
        env,
        {
          runId,
          workflowId: crypto.randomUUID(),
          version: 1,
          principal: crypto.randomUUID(),
          invoker: {
            type: "person",
            id: crypto.randomUUID(),
            appVersion: null,
          },
          restricted: true,
          bindings: new Map([
            [
              "mail",
              {
                alias: "mail",
                kind: "connector",
                resourceId: null,
                resourceVersion: null,
                contractId: "mail",
                fingerprint: "f",
                approval: "a",
                target: {
                  kind: "connector",
                  permissionId: "p",
                  contract: "composio.mail@1",
                },
              },
            ],
          ]),
        },
        "notify",
        {
          name: "grasp.connector",
          binding: "mail",
          operation: "mail.send",
          arguments: { to: "Ada", subject: "s" },
          sensitive: [],
        },
        {
          key: `${runId}:1`,
          deadline: Date.now() + 30_000,
          fence: { run: runId, key: "k", number: 1, generation: 1 },
          requireHolds: () => {
            // Holds.
          },
          fromAction: true,
        }
      )
    );
    expect({ code, receipts: await receiptsOf(runId) }).toStrictEqual({
      code: "workflow.action_restricted",
      receipts: [
        {
          call: "grasp.connector",
          binding: "mail",
          key: `${runId}:1`,
          result: "workflow.action_restricted",
        },
      ],
    });
  });

  it("holds an action to the uses its version sealed, and to its calls' cap, whatever its module claims", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await actingWorkflow(
      ada,
      admin,
      notifyModule(`for (let sent = 0; sent < ${maxActionCalls + 1}; sent += 1) {
      await ctx.resources.mail.call("mail.send", { to: args.to, subject: "again" });
    }
    return { status: "sent" };`)
    );
    const build = await loadWorkflowBuild(env, workflow.id, 1);
    const call = {
      name: "grasp.action",
      binding: "notify",
      module: "code/notify.ts",
      export: "notify",
      arguments: { literal: null },
    } as const;
    const made: BuiltCall[] = [];
    const effects = {
      owner: `workflow-resource:${workflow.id}`,
      make: async (built: BuiltCall): Promise<Json> => {
        made.push(built);
        return await Promise.resolve({ messageId: "m" });
      },
    };
    // Its calls past the cap are refused.
    const capped = await outcome(
      callAction(
        env,
        build.compute,
        build.sdk,
        call,
        { to: "Ada" },
        Date.now() + 30_000,
        effects
      )
    );
    expect(capped).toBe("workflow.action_call_limit");
    expect(made).toHaveLength(maxActionCalls);
    // A seal that lists no uses refuses the call its module still makes.
    const contract = build.compute.contracts.get("code/notify.ts#notify");
    if (contract === undefined) {
      throw new Error("The build seals no notify");
    }
    const sealedNone: LoadedModules = {
      ...build.compute,
      contracts: new Map([
        ["code/notify.ts#notify", { ...contract, uses: [] }],
      ]),
    };
    made.length = 0;
    const denied = await outcome(
      callAction(
        env,
        sealedNone,
        build.sdk,
        call,
        { to: "Ada" },
        Date.now() + 30_000,
        effects
      )
    );
    expect({ denied, made: made.length }).toStrictEqual({
      denied: "workflow.call_denied",
      made: 0,
    });
  });
});
