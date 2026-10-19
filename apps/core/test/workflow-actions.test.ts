/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import { jsonSchemaOf, schemaFromDescriptor } from "@grasp-os/sdk/host";
import type { ConnectorContract } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
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
  shareWorkflowResource,
  workflowVersions,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import {
  callAction,
  maxActionCalls,
} from "../src/workflows/resource-action.ts";
import type { ActionEffects } from "../src/workflows/resource-action.ts";
import type { CallingRun } from "../src/workflows/resource-authority.ts";
import {
  auditAdmissionRefusal,
  makeCall,
} from "../src/workflows/resource-calls.ts";
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
  uses = '[resource.connector("mail", { operations: ["mail.send"] })]'
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

/** The `mail` connector use of `operations`, as an action declares it. */
const connector = (operations: string[]): string =>
  `resource.connector("mail", { operations: ${JSON.stringify(operations)} })`;

/** The flag of workflow `id`'s version as `by` lists it. */
const listed = async (id: string, by: Identity) => {
  const [version] = await workflowVersions(env, by, id);
  return version?.actions.map(({ modelSteeredWrites }) => modelSteeredWrites);
};
/**
 * Runs `update` on a row the database's `trigger` keeps from changing, as
 * only a write around the platform could: the trigger dropped and put back
 * in the same transaction.
 */
const aroundTrigger = async (
  trigger: string,
  update: D1PreparedStatement
): Promise<void> => {
  const kept = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?"
  )
    .bind(trigger)
    .first<{ sql: string }>();
  if (kept === null) {
    throw new Error(`No trigger ${trigger}`);
  }
  await env.DB.batch([
    env.DB.prepare(`DROP TRIGGER ${trigger}`),
    update,
    env.DB.prepare(kept.sql),
  ]);
};
/**
 * Rewrites the bindings workflow `id`'s version seals, its manifest
 * hash made to match, as only a write around the platform could. A
 * replace of the row doesn't get around the database: it's refused.
 */
const resealed = async (
  id: string,
  edit: (bindings: { alias: string; contractId?: unknown }[]) => unknown[]
) => {
  const row = await env.DB.prepare(
    "SELECT manifest FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
  )
    .bind(id)
    .first<{ manifest: string }>();
  const manifest = z
    .looseObject({
      bindings: z.array(z.looseObject({ alias: z.string() })),
    })
    .parse(JSON.parse(row?.manifest ?? "{}"));
  const text = JSON.stringify({
    ...manifest,
    bindings: edit(manifest.bindings),
  });
  const hash = await sha256Hex(text);
  await expect(
    env.DB.prepare(
      `INSERT OR REPLACE INTO workflow_resource_versions (workflow_resource_id, version, definition_version, definition, definition_json_hash, profile_version, evaluator_hash, contract, contract_hash, manifest, manifest_hash, author_id, created_at)
        SELECT workflow_resource_id, version, definition_version, definition, definition_json_hash, profile_version, evaluator_hash, contract, contract_hash, ?, ?, author_id, created_at
        FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1`
    )
      .bind(text, hash, id)
      .run()
  ).rejects.toThrow("UNIQUE constraint failed: workflow_resource_versions.");
  await aroundTrigger(
    "workflow_resource_versions_immutable_update",
    env.DB.prepare(
      "UPDATE workflow_resource_versions SET manifest = ?, manifest_hash = ? WHERE workflow_resource_id = ? AND version = 1"
    ).bind(text, hash, id)
  );
};
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
  const published = await publishWorkflowVersion(env, by, workflow.id, {
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
  return { workflow, mail, serving, approval, key, published };
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

/**
 * The evidence run `runId` kept of calls refused at an action's admission
 * (`workflow.call.refused`): what each names, its generation as a number.
 */
const refusalsOf = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      (event) =>
        event.action === "workflow.call.refused" && event.target?.id === runId
    )
    .map(({ detail }) => ({
      ...detail,
      generation: typeof detail?.generation,
    }));
};

/** An action's admission refusal, as `ActionEffects.refused` hears it. */
interface HeardRefusal {
  readonly reason: string;
  readonly call: string | null;
  readonly errorCode: string;
}

/** Effects' `refused` that keeps what it hears in `heard`. */
const hearing =
  (heard: HeardRefusal[]) =>
  async (said: HeardRefusal): Promise<void> => {
    heard.push(said);
    await Promise.resolve();
  };

/** A binding that is down: any use of it throws. */
const down = <T extends object>(binding: T): T =>
  new Proxy(binding, {
    get: () => {
      throw new Error("Unavailable");
    },
  });

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
    const receipts = await receiptsOf(runId);
    // Refused by the call's authority, it has its receipt there, and no
    // admission evidence besides.
    expect({
      sent: sent.calls,
      receipts: receipts.map(({ result }) => result),
      evidence: await refusalsOf(runId),
    }).toStrictEqual({
      sent: 0,
      receipts: ["workflow.call_denied"],
      evidence: [],
    });
  });

  it("shows what each action may call in its version, as sealed, to every role alike", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const reader = await person("user");
    const { workflow, published, key } = await actingWorkflow(
      ada,
      admin,
      sendsTwice
    );
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: reader.userId,
      role: "user",
    });
    const [asBuilder] = await workflowVersions(env, ada, workflow.id);
    const [asReader] = await workflowVersions(env, reader, workflow.id);
    const actions = [
      {
        binding: "notify",
        module: "code/notify.ts",
        export: "notify",
        uses: [{ alias: "mail", kind: "connector", operations: ["mail.send"] }],
        // No model asked, so no write a model may steer (GRA-718).
        modelSteeredWrites: [],
      },
    ];
    expect({
      published: published.actions,
      builder: asBuilder?.actions,
      reader: asReader?.actions,
      // Beside the catalog binding the action reaches, as every role sees it.
      readerBindings: asReader?.bindings.map(({ alias, contractId }) => ({
        alias,
        contractId,
      })),
    }).toStrictEqual({
      published: actions,
      builder: actions,
      reader: actions,
      readerBindings: [{ alias: "mail", contractId: key }],
    });
  });

  it("flags the writes an action's model may steer in its version's review, counting as a write whatever it can't rule out, to every role alike", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const reader = await person("user");
    // `mail.read` stated read-only; `mail.send` and `mail.draft` not, so
    // taken for writes.
    const mail = `mail-${unique()}`;
    const operation = {
      input: descriptorOf(v.object({ to: v.string(), subject: v.string() })),
      output: descriptorOf(v.object({ messageId: v.string() })),
    };
    await publishCatalogContract(env, admin, {
      key: mail,
      kind: "connector",
      operations: {
        "mail.send": operation,
        "mail.draft": { ...operation, readOnly: false },
        "mail.read": { ...operation, readOnly: true },
      },
    });
    const model = `writer-${unique()}`;
    await publishCatalogContract(env, admin, { key: model, kind: "model" });
    // An App's export: its contract states nothing about reading only.
    const contacts = `contacts-${unique()}`;
    await publishCatalogContract(env, admin, {
      key: contacts,
      kind: "operation",
      ...operation,
    });
    const writer =
      'resource.model("writer", { output: v.object({ line: v.string() }) })';
    const definitionSchema = z.looseObject({
      document: z.looseObject({
        metadata: z.object({
          grasp: z.looseObject({
            bindings: z.record(z.string(), z.unknown()),
          }),
        }),
      }),
    });
    /** Publishes an action with `uses`; answers its flag, published and listed. */
    const reviewed = async (uses: string) => {
      const workflow = await createWorkflowResource(
        env,
        ada,
        `act-${unique()}`
      );
      await shareWorkflowResource(env, ada, workflow.id, {
        type: "person",
        id: reader.userId,
        role: "user",
      });
      const definition = definitionSchema.parse(
        JSON.parse(
          definitionOf(workflow.name, {
            mail: { kind: "connector", contract: mail },
          })
        )
      );
      const { bindings } = definition.document.metadata.grasp;
      if (uses.includes("writer")) {
        bindings.writer = { kind: "model", contract: model };
      }
      if (uses.includes("contacts")) {
        bindings.contacts = { kind: "operation", contract: contacts };
      }
      if (!uses.includes('"mail"')) {
        delete bindings.mail;
      }
      const published = await publishWorkflowVersion(env, ada, workflow.id, {
        definition: JSON.stringify(definition),
        basedOn: null,
        modules: {
          "code/notify.ts": notifyModule('return { status: "x" };', uses),
        },
      });
      return {
        id: workflow.id,
        published: published.actions.map(
          ({ modelSteeredWrites }) => modelSteeredWrites
        ),
      };
    };
    const sendsAndDrafts = {
      alias: "mail",
      kind: "connector",
      operations: ["mail.send", "mail.draft"],
    };
    const reads = {
      alias: "mail",
      kind: "connector",
      operations: ["mail.read"],
    };

    const modelAndWrites = await reviewed(
      `[${writer}, ${connector(["mail.send", "mail.draft", "mail.read"])}]`
    );
    const modelAndReads = await reviewed(
      `[${writer}, ${connector(["mail.read"])}]`
    );
    const writesAlone = await reviewed(
      `[${connector(["mail.send", "mail.draft"])}]`
    );
    const modelAndExport = await reviewed(
      `[${writer}, resource.operation("contacts")]`
    );
    // What it reads only once its contract is there, as the version
    // pinned it: a binding the version doesn't seal, a contract the catalog
    // doesn't hold, or one that isn't the contract pinned rules nothing out.
    const unbound = await reviewed(`[${writer}, ${connector(["mail.read"])}]`);
    await resealed(unbound.id, (bindings) =>
      bindings.filter(({ alias }) => alias !== "mail")
    );
    const uncatalogued = await reviewed(
      `[${writer}, ${connector(["mail.read"])}]`
    );
    await resealed(uncatalogued.id, (bindings) =>
      bindings.map((binding) =>
        binding.alias === "mail"
          ? { ...binding, contractId: `missing-${unique()}` }
          : binding
      )
    );
    const before = {
      modelAndWrites: await listed(modelAndWrites.id, ada),
      reader: await listed(modelAndWrites.id, reader),
      modelAndReads: await listed(modelAndReads.id, ada),
      writesAlone: await listed(writesAlone.id, ada),
      modelAndExport: await listed(modelAndExport.id, ada),
      unbound: await listed(unbound.id, ada),
      uncatalogued: await listed(uncatalogued.id, ada),
    };
    // A catalog row rewritten around the platform, now stating every
    // operation read-only, isn't the contract the version pinned. A
    // replace of the row is refused (GRA-726): only dropping the
    // database's trigger gets there.
    const replacedText = JSON.stringify({
      kind: "connector",
      operations: {
        "mail.send": { ...operation, readOnly: true },
        "mail.draft": { ...operation, readOnly: true },
        "mail.read": { ...operation, readOnly: true },
      },
    });
    const replacedFingerprint = await sha256Hex(replacedText);
    const replace = await outcome(
      env.DB.prepare(
        `INSERT OR REPLACE INTO workflow_catalog_contracts (key, kind, contract, fingerprint, published_by, published_at)
          SELECT key, kind, ?, ?, published_by, published_at FROM workflow_catalog_contracts WHERE key = ?`
      )
        .bind(replacedText, replacedFingerprint, mail)
        .run()
    );
    await aroundTrigger(
      "workflow_catalog_contracts_immutable_update",
      env.DB.prepare(
        "UPDATE workflow_catalog_contracts SET contract = ?, fingerprint = ? WHERE key = ?"
      ).bind(replacedText, replacedFingerprint, mail)
    );
    expect({
      published: {
        modelAndWrites: modelAndWrites.published,
        modelAndReads: modelAndReads.published,
        writesAlone: writesAlone.published,
        modelAndExport: modelAndExport.published,
      },
      ...before,
      replaceRefused: replace.includes(
        "UNIQUE constraint failed: workflow_catalog_contracts."
      ),
      replaced: await listed(modelAndWrites.id, ada),
    }).toStrictEqual({
      published: {
        modelAndWrites: [[sendsAndDrafts]],
        modelAndReads: [[]],
        writesAlone: [[]],
        modelAndExport: [[{ alias: "contacts", kind: "operation" }]],
      },
      modelAndWrites: [[sendsAndDrafts]],
      reader: [[sendsAndDrafts]],
      modelAndReads: [[]],
      writesAlone: [[]],
      modelAndExport: [[{ alias: "contacts", kind: "operation" }]],
      unbound: [[reads]],
      uncatalogued: [[reads]],
      replaceRefused: true,
      replaced: [
        [
          {
            alias: "mail",
            kind: "connector",
            operations: ["mail.send", "mail.draft", "mail.read"],
          },
        ],
      ],
    });
  });

  it("refuses a definition whose action uses a binding it doesn't declare, or of another kind", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = await mailContract(admin);
    for (const [uses, mail] of [
      // Declares a use the definition has no binding for.
      [
        '[resource.connector("other", { operations: ["mail.send"] })]',
        { kind: "connector", contract: key },
      ],
      // Uses `mail` as an operation, which the definition binds a connector.
      ['[resource.operation("mail")]', { kind: "connector", contract: key }],
      // Uses the workflow's own action: never one of its own modules.
      ['[resource.operation("notify")]', { kind: "connector", contract: key }],
      // Uses `mail` as a model, which the definition binds a connector.
      [
        '[resource.model("mail", { output: v.object({ line: v.string() }) })]',
        { kind: "connector", contract: key },
      ],
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

  it("refuses an action that declares an operation its connector's contract doesn't name, or doesn't declare one", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = await mailContract(admin);
    const codes: string[] = [];
    for (const uses of [
      // An operation the contract doesn't name.
      '[resource.connector("mail", { operations: ["mail.delete"] })]',
      // A pattern is a name like any other: never a wildcard.
      '[resource.connector("mail", { operations: ["*"] })]',
      // No operations declared.
      '[resource.connector("mail")]',
      '[resource.connector("mail", { operations: [] })]',
      // A use built by hand, widening what it calls.
      '[{ "~use": { alias: "mail", kind: "connector", operations: ["mail.send", "mail.delete"] } }]',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const workflow = await createWorkflowResource(
        env,
        ada,
        `act-${unique()}`
      );
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const error = await refusal(
        publishWorkflowVersion(env, ada, workflow.id, {
          definition: definitionOf(workflow.name, {
            mail: { kind: "connector", contract: key },
          }),
          basedOn: null,
          modules: {
            "code/notify.ts": notifyModule('return { status: "x" };', uses),
          },
        })
      );
      const parsed = z
        .object({ code: z.string(), details: z.unknown() })
        .parse(error);
      codes.push(
        parsed.code === "workflow.definition_invalid" &&
          JSON.stringify(parsed.details).includes("binding.unknown_operation")
          ? "binding.unknown_operation"
          : parsed.code
      );
    }
    expect(codes).toStrictEqual([
      "binding.unknown_operation",
      "binding.unknown_operation",
      "workflow.modules_invalid",
      "workflow.modules_invalid",
      "workflow.modules_invalid",
    ]);
  });

  it("makes no call of an operation the action's use doesn't declare, though it computes the name and swallows the refusal, and keeps the evidence once", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, serving } = await actingWorkflow(
      ada,
      admin,
      notifyModule(
        `try {
      await ctx.resources.mail.call(["mail", "archive"].join("."), { to: args.to, subject: "x" });
    } catch {
      // Swallowed.
    }
    return { status: "swallowed" };`,
        // The list it passed, changed once declared: the copy stands.
        `(() => {
    const operations = ["mail.send"];
    const mail = resource.connector("mail", { operations });
    operations.push("mail.archive");
    return [mail];
  })()`
      )
    );
    const build = await loadWorkflowBuild(env, workflow.id, 1);
    let calls = 0;
    const heard: HeardRefusal[] = [];
    const code = await outcome(
      callAction(
        env,
        build.compute,
        build.sdk,
        notifyCall,
        { to: "Ada" },
        Date.now() + 5000,
        {
          owner: `workflow-action:${workflow.id}`,
          refused: hearing(heard),
          make: async (): Promise<Json> => {
            calls += 1;
            return await Promise.resolve({ messageId: "m" });
          },
        }
      )
    );
    // Through a run, the refusal is kept as evidence once, naming the
    // use and the host's record of the attempt, never the computed name.
    const runId = await started(ada, workflow.id, serving);
    expect({
      code,
      calls,
      heard,
      run: await ended(ada, workflow.id, runId),
      evidence: await refusalsOf(runId),
      receipts: await receiptsOf(runId),
    }).toStrictEqual({
      code: "workflow.call_denied",
      calls: 0,
      heard: [
        {
          reason: "operation_undeclared",
          call: "mail",
          errorCode: "workflow.call_denied",
        },
      ],
      run: { status: "failed", code: "workflow.call_denied" },
      evidence: [
        {
          workflow: workflow.id,
          version: 1,
          person: ada.userId,
          build: build.hash,
          task: "notify",
          attempt: 1,
          generation: "number",
          call: "mail",
          errorCode: "workflow.call_denied",
          reason: "operation_undeclared",
        },
      ],
      receipts: [],
    });
  });

  it("keeps an admission refusal standing when its evidence can't be kept", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await actingWorkflow(
      ada,
      admin,
      notifyModule(
        `try {
      await ctx.resources.mail.call(["mail", "archive"].join("."), { to: args.to });
    } catch {
      // Swallowed.
    }
    return { status: "swallowed" };`,
        // Its operations a list of strings: any name type-checks.
        `(() => {
    const operations: string[] = ["mail.send"];
    return [resource.connector("mail", { operations })];
  })()`
      )
    );
    const build = await loadWorkflowBuild(env, workflow.id, 1);
    const run: CallingRun = {
      runId: `run-${unique()}`,
      workflowId: workflow.id,
      version: 1,
      principal: ada.userId,
      invoker: { type: "person", id: ada.userId, appVersion: null },
      bindings: new Map(),
      restricted: false,
    };
    const refusedBy = async (refused: ActionEffects["refused"]) =>
      await outcome(
        callAction(
          env,
          build.compute,
          build.sdk,
          notifyCall,
          { to: "Ada" },
          Date.now() + 5000,
          {
            owner: `workflow-action:${workflow.id}`,
            make: async (): Promise<Json> =>
              await Promise.resolve({ messageId: "m" }),
            refused,
          }
        )
      );
    // The audit log's database down: the write fails, and is logged.
    const logged = vi.spyOn(console, "error").mockReturnValue();
    let code: unknown;
    let thrown: unknown;
    let hung: unknown;
    let events: unknown[] = [];
    try {
      code = await refusedBy(async (said) => {
        await auditAdmissionRefusal({ ...env, DB: down(env.DB) }, run, {
          build: build.hash,
          task: "notify",
          attempt: 1,
          generation: 1,
          ...said,
        });
      });
      // A hook that throws, all the same, never takes the refusal's place.
      thrown = await refusedBy(async () => {
        await Promise.resolve();
        throw new Error("Unavailable");
      });
      // Nor one that never settles: the refusal waits no longer than the
      // attempt's deadline.
      hung = await refusedBy(async () => {
        await Promise.withResolvers<null>().promise;
      });
      events = logged.mock.calls.map(([fields]: unknown[]) =>
        typeof fields === "object" && fields !== null && "event" in fields
          ? fields.event
          : undefined
      );
    } finally {
      logged.mockRestore();
    }
    expect({
      code,
      thrown,
      hung,
      logged: events.filter((event) => event === "workflow.call.audit_failed")
        .length,
    }).toStrictEqual({
      code: "workflow.call_denied",
      thrown: "workflow.call_denied",
      hung: "workflow.call_denied",
      // Once by the write that failed, once by the hook that threw.
      logged: 2,
    });
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
          refused: hearing([]),
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
        { owner: `workflow-action:${workflow.id}`, make, refused: hearing([]) }
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

  it("waits for a call the action started from one it didn't wait for", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // The second call starts only once the first, never waited for, answers.
    const { workflow } = await actingWorkflow(
      ada,
      admin,
      notifyModule(`void ctx.resources.mail
      .call("mail.send", { to: args.to, subject: "first" })
      .then(async () => await ctx.resources.mail.call("mail.send", { to: args.to, subject: "second" }));
    return { status: "answered" };`)
    );
    const build = await loadWorkflowBuild(env, workflow.id, 1);
    const done: string[] = [];
    const answered = await callAction(
      env,
      build.compute,
      build.sdk,
      notifyCall,
      { to: "Ada" },
      Date.now() + 30_000,
      {
        owner: `workflow-action:${workflow.id}`,
        refused: hearing([]),
        make: async (built: BuiltCall): Promise<Json> => {
          await scheduler.wait(100);
          done.push(
            built.name === "grasp.connector"
              ? z.object({ subject: z.string() }).parse(built.arguments).subject
              : ""
          );
          return { messageId: "m" };
        },
      }
    );
    expect({ answered, done }).toStrictEqual({
      answered: { status: "answered" },
      done: ["first", "second"],
    });
  });

  it("makes no call of an action outside its step, though the action keeps the runner from waiting for it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // The runner shares the action's isolate, so its own wait is no
    // boundary: this action makes a call, then breaks the call's then (and
    // every promise's constructor, so await goes through then), and the
    // runner answers at once, the call still on its way to the host. The
    // host is the boundary: a call it has when the action answers settles
    // before the task records (its refusal standing); one that reaches it
    // after is refused, never made. Either way, no effect outside the step.
    const { workflow } = await actingWorkflow(
      ada,
      admin,
      `import { action, resource, v } from "@grasp-os/sdk/action";

export const notify = action({
  args: { to: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [resource.connector("mail", { operations: ["mail.send"] })],
  handler: (ctx, args) => {
    const late = ctx.resources.mail.call("mail.send", { to: args.to, subject: "late" });
    const realThen = Promise.prototype.then;
    Object.defineProperty(Promise.prototype, "constructor", {
      value: Object,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Promise.prototype, "then", {
      value(this: Promise<unknown>, onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
        // The call the runner waits for looks settled at once; every other
        // promise works as it did.
        if (this === late && typeof onFulfilled === "function") {
          onFulfilled(undefined);
          return this;
        }
        return Reflect.apply(realThen, this, [onFulfilled, onRejected]);
      },
      configurable: true,
      writable: true,
    });
    return { status: "answered" };
  },
});
`
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
        { owner: `workflow-action:${workflow.id}`, make, refused: hearing([]) }
      );
    let begun = 0;
    let done = 0;
    const answered = await outcome(
      run(async () => {
        begun += 1;
        await scheduler.wait(100);
        done += 1;
        return { messageId: "m" };
      })
    );
    const atAnswer = { begun, done };
    // Long enough for a call still on its way to reach the host.
    await scheduler.wait(500);
    expect({ answered, atAnswer, after: { begun, done } }).toStrictEqual({
      answered: "ok",
      // Every call made was made, and settled, within the step.
      atAnswer: { begun: atAnswer.done, done: atAnswer.done },
      after: atAnswer,
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
          refused: hearing([]),
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
    const heard: HeardRefusal[] = [];
    const effects = {
      owner: `workflow-resource:${workflow.id}`,
      refused: hearing(heard),
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
    // The cap's refusal is evidence once, not once a call past it.
    expect(heard.splice(0)).toStrictEqual([
      {
        reason: "call_limit",
        call: "mail",
        errorCode: "workflow.action_call_limit",
      },
    ]);
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
    expect({ denied, made: made.length, heard }).toStrictEqual({
      denied: "workflow.call_denied",
      made: 0,
      // An alias its seal doesn't list is named by no one: it is the
      // module's text.
      heard: [
        {
          reason: "use_undeclared",
          call: null,
          errorCode: "workflow.call_denied",
        },
      ],
    });
  });
});
