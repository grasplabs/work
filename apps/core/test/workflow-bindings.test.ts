/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { jsonSchemaOf, schemaFromDescriptor } from "@grasp-os/sdk/host";
import {
  releaseFormatVersion,
  releaseManifestSchema,
  sdkProtocolVersion,
} from "@grasp-os/shared/app-releases";
import { connectErrors } from "@grasp-os/shared/connect";
import type { ConnectorContract } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { appIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson, canonicalText } from "@grasp-os/shared/json";
import type {
  Authority,
  PermissionRequest,
} from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  bindWorkflowToApp,
  startAppBinding,
  unbindWorkflowFromApp,
} from "../src/app-workflow-bindings.ts";
import { appFor } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { standingOf } from "../src/screen-trust.ts";
import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { setWorkflowParams, workflowParams } from "../src/workflow-params.ts";
import {
  createWorkflowResource,
  deleteWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
  workflowVersions,
} from "../src/workflow-resources.ts";
import {
  admitWorkflowStart,
  decideWorkflowStart,
  startWorkflow,
} from "../src/workflow-starts.ts";
import type {
  StartAuthorization,
  StartInvoker,
} from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { sweepRunDetails } from "../src/workflows/retention.ts";
import { racingDb } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { outcome, refusal, unique } from "./sign-in.ts";

// Catalog bindings, App bindings and parameters of independent workflows
// (workflow-catalog.ts, workflow-bindings.ts, app-workflow-bindings.ts,
// workflow-params.ts), and what a start freezes of them
// (workflow-starts.ts), from their threat model: a binding to a resource
// the workflow can't use, an approval racing a version or a start, a
// parameter edit racing a start, a sensitive value leaking into listings
// or the audit log, and a frozen snapshot changed afterwards.

type Person = Identity;

/** The model the test deployment's gateway allows (vite.config.ts). */
const allowedModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const person = async (role: Role, staff = false): Promise<Person> => {
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
    staff,
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

/** The descriptor of an object with no fields. */
const emptyObject = {
  descriptorVersion: 1,
  kind: "object",
  presence: "required",
  nullable: false,
  fields: {},
};

/** A descriptor's exact JSON Schema, as JSON text, as connect states one. */
const shapeOf = (descriptor: unknown): string =>
  JSON.stringify(
    jsonSchemaOf(schemaFromDescriptor(JSON.stringify(descriptor)).descriptor, {
      exact: true,
    })
  );

/** The descriptor of null. */
const nullValue = {
  descriptorVersion: 1,
  kind: "null",
  presence: "required",
  nullable: false,
};

/**
 * Seals version `version` of App `app` with a manifest the release loader
 * reads as intact (revoked, if asked): what an operation's approval names.
 */
const sealed = async (app: string, version: number, revoked = false) => {
  const hash = "0".repeat(64);
  const manifest = canonicalText(
    releaseManifestSchema.parse({
      formatVersion: releaseFormatVersion,
      resourceId: app,
      resourceVersion: version,
      sourceTreeHash: hash,
      schemaHash: hash,
      contractHash: hash,
      sdkVersion: "1.0.0",
      sdkProtocolVersion,
      uiVersion: "1.0.0",
      compilerVersion: "1.0.0",
      dependencyLockHash: hash,
      target: "app",
      dataStoreBindings: [],
      artifacts: [{ path: "server.js", sha256: hash, bytes: 0 }],
      bindings: [],
      verificationReportHash: hash,
      migrationEvidence: [],
      artifactTrust: "unreviewed",
    })
  );
  await env.DB.prepare(
    "INSERT INTO sdk_release_manifests (app_id, version, manifest_hash, manifest, sealed_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(
      app,
      version,
      await sha256Hex(manifest),
      manifest,
      Date.now(),
      revoked ? Date.now() : null
    )
    .run();
};

/** A model capability contract key of this test's own. */
const modelKey = () => `summary-${unique()}`;

interface Draft {
  name: string;
  version?: string;
  model?: string;
  /** Whether `token` is sensitive: it is, unless a version says not. */
  tokenSensitive?: boolean;
  /** Another workflow's name, run at its 1.0.0 through binding `child`. */
  child?: string;
  /** Whether it waits an hour before it finishes. */
  waits?: boolean;
}

/**
 * A workflow's definition: a greeting with a sensitive `token` parameter
 * and a `limit` one; with `model`, a model step through binding `summary`
 * of that catalog contract; with `child`, a step running that workflow.
 */
const definitionOf = ({
  name,
  version = "1.0.0",
  model,
  tokenSensitive = true,
  child,
  waits = false,
}: Draft): string =>
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
          params: {
            limit: {
              schema: { type: "integer", minimum: 1, maximum: 10 },
              label: "Limit",
              default: 3,
              sensitive: false,
            },
            token: {
              schema: { type: "string", maxLength: 64 },
              label: "Token",
              default: "none",
              sensitive: tokenSensitive,
            },
          },
          bindings: {
            ...(model === undefined
              ? {}
              : { summary: { kind: "model", contract: model } }),
            ...(child === undefined
              ? {}
              : {
                  child: {
                    kind: "workflow",
                    contract: `${workflowNamespace}/${child}/1.0.0`,
                  },
                }),
          },
        },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      ...(model === undefined
        ? []
        : [
            {
              summarize: {
                call: "grasp.model",
                with: {
                  binding: "summary",
                  instructions: "Greet them.",
                  input: { who: "${ $workflow.input.who }" },
                  outputSchema: objectSchema({ line: { type: "string" } }),
                },
              },
            },
          ]),
      ...(child === undefined
        ? []
        : [
            {
              child: {
                run: {
                  workflow: {
                    namespace: workflowNamespace,
                    name: child,
                    version: "1.0.0",
                    input: { who: "${ $workflow.input.who }" },
                  },
                },
                metadata: { grasp: { binding: "child" } },
              },
            },
          ]),
      ...(waits ? [{ pause: { wait: "PT1H" } }] : []),
      { finish: { set: { status: "done" } } },
    ],
  });

/** A workflow `owner` created and published as `draft` at version 1. */
const workflowOf = async (owner: Person, model?: string) => {
  const workflow = await createWorkflowResource(
    env,
    owner,
    `greet-${unique()}`
  );
  await publishWorkflowVersion(env, owner, workflow.id, {
    definition: definitionOf({
      name: workflow.name,
      ...(model === undefined ? {} : { model }),
    }),
    basedOn: null,
  });
  return workflow;
};

/** A model contract `admin` publishes to the catalog. */
const modelContract = async (admin: Person): Promise<string> => {
  const key = modelKey();
  await publishCatalogContract(env, admin, { key, kind: "model" });
  return key;
};

const start = async (who: Person, id: string, version = 1) =>
  await startWorkflow(env, { type: "person", person: who }, id, {
    version,
    input: { who: "Ada" },
    key: `key-${unique()}`,
  });

/** A start receipt as stored, by its ID. */
const receiptRow = async (id: string) =>
  await env.DB.prepare(
    "SELECT input, params, params_revision, bindings, bindings_hash, details_removed_at FROM workflow_start_receipts WHERE id = ?"
  )
    .bind(id)
    .first<{
      input: string | null;
      params: string | null;
      params_revision: number;
      bindings: string;
      bindings_hash: string;
      details_removed_at: number | null;
    }>();

/** What `ada` may hand a permission request: her App and resource roles. */
const rolesOf = (by: Person) => ({
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
  by: Person,
  admin: Person,
  request: PermissionRequest
): Promise<string> => {
  const asked = await requestPermission(env, by, request, rolesOf(by));
  await grantPermission(env, admin, asked.id, { version: null });
  return asked.id;
};

/** An App `owner` owns, with an approved version 1. */
const appOf = async (owner: Person): Promise<string> => {
  const app = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Engine', '', ?, ?)"
    ).bind(app, owner.userId, Date.now()),
    env.DB.prepare(
      "INSERT INTO app_versions (app_id, version, tree, files, author_id, message, created_at, approved) VALUES (?, 1, 'tree', 0, ?, 'Version', ?, 1)"
    ).bind(app, owner.userId, Date.now()),
  ]);
  return app;
};

/**
 * A new start `invoker` decided on, for version `version` of workflow
 * `id`, with input of Ada's and a key of its own: admitted later, or not.
 */
const decide = async (
  invoker: StartInvoker,
  id: string,
  version: number
): Promise<StartAuthorization> => {
  const decision = await decideWorkflowStart(env, invoker, id, {
    version,
    input: { who: "Ada" },
    key: `key-${unique()}`,
  });
  if ("start" in decision) {
    throw new Error("A new start was answered as one already admitted");
  }
  return decision.authorization;
};

describe("the host catalog", () => {
  it("takes a contract once, from an admin, as the profile reads it, and never changes it", async () => {
    const admin = await person("admin");
    const builder = await person("builder");
    const staff = await person("admin", true);
    const key = modelKey();
    const published = await publishCatalogContract(env, admin, {
      key,
      kind: "model",
    });
    expect({
      fingerprint: published.fingerprint.length,
      again: await outcome(
        publishCatalogContract(env, admin, { key, kind: "model" })
      ),
      builder: await outcome(
        publishCatalogContract(env, builder, { key: modelKey(), kind: "model" })
      ),
      staff: await outcome(
        publishCatalogContract(env, staff, { key: modelKey(), kind: "model" })
      ),
      incomplete: await outcome(
        publishCatalogContract(env, admin, {
          key: modelKey(),
          kind: "operation",
        })
      ),
      tooLarge: await outcome(
        publishCatalogContract(env, admin, {
          key: `mail-${unique()}`,
          kind: "connector",
          operations: Object.fromEntries(
            ["a", "b", "c"].map((name) => [
              `mail.${name}`,
              {
                input: `${JSON.stringify(emptyObject)}${" ".repeat(200 * 1024)}`,
                output: JSON.stringify(emptyObject),
              },
            ])
          ),
        })
      ),
    }).toStrictEqual({
      fingerprint: 64,
      again: "workflow.contract_exists",
      builder: "role.forbidden",
      staff: "role.forbidden",
      incomplete: "workflow.contract_invalid",
      tooLarge: "workflow.contract_invalid",
    });
  });

  it("resolves a workflow's catalog binding by its exact key and records it in the version", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = await modelContract(admin);
    const workflow = await workflowOf(ada, key);
    const [version] = await workflowVersions(env, ada, workflow.id);
    const missing = await outcome(
      publishWorkflowVersion(env, ada, workflow.id, {
        definition: definitionOf({
          name: workflow.name,
          version: "2.0.0",
          model: `missing-${unique()}`,
        }),
        basedOn: 1,
      })
    );
    expect({
      bindings: version?.bindings.map(({ alias, kind, contractId }) => ({
        alias,
        kind,
        contractId,
      })),
      missing,
    }).toStrictEqual({
      bindings: [{ alias: "summary", kind: "model", contractId: key }],
      missing: "workflow.definition_invalid",
    });
  });
});

describe("approving a workflow's binding", () => {
  it("is for admins, of a target that can serve it, in a version that declares it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const staff = await person("admin", true);
    const key = await modelContract(admin);
    const workflow = await workflowOf(ada, key);
    const approve = async (by: Person, target: unknown, version = 1) =>
      await approveWorkflowBinding(env, by, workflow.id, {
        alias: "summary",
        target,
        reviewed: { version },
      });
    const model = { kind: "model", model: allowedModel };
    expect({
      builder: await outcome(approve(ada, model)),
      staff: await outcome(approve(staff, model)),
      notAllowed: await outcome(
        approve(admin, { kind: "model", model: "openai/not-allowed" })
      ),
      wrongKind: await outcome(
        approve(admin, { kind: "decision", deciders: ["role:admin"] })
      ),
      unpublished: await outcome(approve(admin, model, 2)),
      approved: await outcome(approve(admin, model)),
    }).toStrictEqual({
      builder: "role.forbidden",
      staff: "role.forbidden",
      notAllowed: "workflow.binding_invalid",
      wrongKind: "workflow.binding_invalid",
      unpublished: "workflow.binding_invalid",
      approved: "ok",
    });
  });

  it("serves a connector only through the workflow's own permission, on actions of the contract's exact shapes connect serves now", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = `mail-${unique()}`;
    await publishCatalogContract(env, admin, {
      key,
      kind: "connector",
      operations: {
        "mail.send": {
          input: JSON.stringify({
            descriptorVersion: 1,
            kind: "object",
            presence: "required",
            nullable: false,
            fields: {},
          }),
          output: JSON.stringify(nullValue),
        },
      },
    });
    const workflow = await createWorkflowResource(env, ada, `mail-${unique()}`);
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
              bindings: { mail: { kind: "connector", contract: key } },
            },
          },
        },
        input: { schema: objectSchema({ who: { type: "string" } }) },
        output: { schema: objectSchema({ status: { type: "string" } }) },
        do: [
          {
            send: {
              call: "grasp.connector",
              with: { binding: "mail", operation: "mail.send", arguments: {} },
            },
          },
          { finish: { set: { status: "done" } } },
        ],
      }),
      basedOn: null,
    });
    // A permission an App holds on a connection: not the workflow's.
    const app = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Engine', '', ?, ?)"
    )
      .bind(app, ada.userId, Date.now())
      .run();
    const asked = async (subject: PermissionRequest["subject"]) =>
      await requestPermission(
        env,
        ada,
        {
          subject,
          object: { type: "connection", connectionId: "connection-mail" },
          actions: ["mail.send"],
          binding: `MAIL_${unique().toUpperCase()}`,
        },
        {
          app: async (named, role) => await appFor(env, ada, named, role),
          resource: async (ref, needed) => {
            await requireResourceRole(env, ada, ref, needed);
          },
        }
      );
    const appsOwn = await asked({ type: "app", appId: appIdSchema.parse(app) });
    await grantPermission(env, admin, appsOwn.id, { version: null });
    const workflowsOwn = await asked({
      type: "workflow",
      workflowId: workflow.id,
    });
    await grantPermission(env, admin, workflowsOwn.id, { version: null });
    // What connect serves the connection as, for this test: `serve`
    // decides, so the connection's contract can change under an approval.
    const exact = {
      send: {
        tool: "mail.send",
        readOnly: false,
        input: shapeOf(emptyObject),
        output: shapeOf(nullValue),
      },
    };
    let serve: () => ConnectorContract = () => ({
      contract: "graph.mail@1",
      actions: exact,
    });
    const connecting: Env = {
      ...env,
      CONNECT: new Proxy(env.CONNECT, {
        get: (target, name): unknown =>
          name === "connectorContract"
            ? async () => await Promise.resolve(serve())
            : Reflect.get(target, name),
      }),
    };
    const approve = async (permissionId: string) =>
      await approveWorkflowBinding(connecting, admin, workflow.id, {
        alias: "mail",
        target: { kind: "connector", permissionId, contract: "graph.mail@1" },
        reviewed: { version: 1 },
      });
    const appsOwnTry = await outcome(approve(appsOwn.id));
    serve = () => ({
      contract: "graph.mail@1",
      actions: { send: { ...exact.send, output: shapeOf(emptyObject) } },
    });
    const otherShape = await outcome(approve(workflowsOwn.id));
    serve = () => {
      throw connectErrors.create("connect.contract_not_found");
    };
    const notServed = await outcome(approve(workflowsOwn.id));
    serve = () => ({ contract: "graph.mail@1", actions: exact });
    const approved = await outcome(approve(workflowsOwn.id));
    const startsNow = await outcome(
      startWorkflow(connecting, { type: "person", person: ada }, workflow.id, {
        version: 1,
        input: { who: "Ada" },
        key: `key-${unique()}`,
      })
    );
    // The connection stops serving that contract: the approval can't
    // outlive it, so the next start is refused.
    serve = () => {
      throw connectErrors.create("connect.contract_not_found");
    };
    const afterDrift = await outcome(
      startWorkflow(connecting, { type: "person", person: ada }, workflow.id, {
        version: 1,
        input: { who: "Ada" },
        key: `key-${unique()}`,
      })
    );
    expect({
      appsOwn: appsOwnTry,
      otherShape,
      notServed,
      approved,
      startsNow,
      afterDrift,
    }).toStrictEqual({
      appsOwn: "workflow.binding_invalid",
      otherShape: "workflow.binding_invalid",
      notServed: "workflow.binding_invalid",
      approved: "ok",
      startsNow: "ok",
      afterDrift: "workflow.binding_unapproved",
    });
  });
});

describe("approving an operation", () => {
  it("takes only an export of a release that loads, with the contract's exact shape, keeps that release while it serves, and stops serving once it can't", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = `lookup-${unique()}`;
    const descriptor = JSON.stringify(emptyObject);
    await publishCatalogContract(env, admin, {
      key,
      kind: "operation",
      input: descriptor,
      output: descriptor,
    });
    // What an export states for that contract: the descriptor's JSON Schema.
    const shape = jsonSchemaOf(schemaFromDescriptor(descriptor).descriptor, {
      exact: true,
    });
    const app = await appOf(ada);
    // Versions 2 and 3 export the same: 2 was never sealed, 3 was revoked.
    await env.DB.batch(
      [2, 3].map((version) =>
        env.DB.prepare(
          "INSERT INTO app_versions (app_id, version, tree, files, author_id, message, created_at, approved) VALUES (?, ?, 'tree', 0, ?, 'Version', ?, 1)"
        ).bind(app, version, ada.userId, Date.now())
      )
    );
    await env.DB.prepare("UPDATE app_versions SET exports = ? WHERE app_id = ?")
      .bind(
        JSON.stringify({
          lookup: { access: "read", input: shape, output: shape },
          other: { access: "read", input: shape, output: { type: "string" } },
        }),
        app
      )
      .run();
    await sealed(app, 1);
    await sealed(app, 3, true);
    const workflow = await createWorkflowResource(env, ada, `op-${unique()}`);
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
              bindings: { lookup: { kind: "operation", contract: key } },
            },
          },
        },
        input: { schema: objectSchema({ who: { type: "string" } }) },
        output: { schema: objectSchema({ status: { type: "string" } }) },
        do: [
          {
            look: {
              call: "grasp.operation",
              with: { binding: "lookup", arguments: {} },
            },
          },
          { finish: { set: { status: "done" } } },
        ],
      }),
      basedOn: null,
    });
    const permissionId = await granted(ada, admin, {
      subject: { type: "workflow", workflowId: workflow.id },
      object: { type: "app", appId: appIdSchema.parse(app) },
      actions: ["read"],
      binding: `APP_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    const approve = async (target: Record<string, unknown>) =>
      await approveWorkflowBinding(env, admin, workflow.id, {
        alias: "lookup",
        target: { kind: "operation", permissionId, ...target },
        reviewed: { version: 1 },
      });
    const pins = async () => {
      const rows = await env.DB.prepare(
        "SELECT holder_id AS holder FROM sdk_release_pins WHERE app_id = ? AND holder_kind = 'approval'"
      )
        .bind(app)
        .all<{ holder: string }>();
      return rows.results.map(({ holder }) => holder);
    };
    const tries = {
      otherShape: await outcome(approve({ appVersion: 1, export: "other" })),
      unsealed: await outcome(approve({ appVersion: 2, export: "lookup" })),
      revoked: await outcome(approve({ appVersion: 3, export: "lookup" })),
    };
    const approval = await approve({ appVersion: 1, export: "lookup" });
    const whileServing = await pins();
    const startsNow = await outcome(start(ada, workflow.id));
    await revokeWorkflowBinding(env, admin, workflow.id, approval.id);
    const afterRevoke = await pins();
    const again = await approve({ appVersion: 1, export: "lookup" });
    // An admin revokes the release under the approval: it can't be called,
    // so no start freezes it.
    await env.DB.prepare(
      "UPDATE sdk_release_manifests SET revoked_at = ? WHERE app_id = ? AND version = 1"
    )
      .bind(Date.now(), app)
      .run();
    const releaseRevoked = await outcome(start(ada, workflow.id));
    const beforeDelete = await pins();
    await deleteWorkflowResource(env, ada, workflow.id);
    expect({
      tries,
      whileServing,
      startsNow,
      afterRevoke,
      releaseRevoked,
      beforeDelete,
      afterDelete: await pins(),
    }).toStrictEqual({
      tries: {
        otherShape: "workflow.binding_invalid",
        unsealed: "workflow.binding_invalid",
        revoked: "workflow.binding_invalid",
      },
      whileServing: [approval.id],
      startsNow: "ok",
      releaseRevoked: "workflow.binding_unapproved",
      afterRevoke: [],
      beforeDelete: [again.id],
      afterDelete: [],
    });
  });

  it("approves nothing when the release it would pin is removed as the approval is written", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = `lookup-${unique()}`;
    const descriptor = JSON.stringify(emptyObject);
    await publishCatalogContract(env, admin, {
      key,
      kind: "operation",
      input: descriptor,
      output: descriptor,
    });
    const shape = jsonSchemaOf(schemaFromDescriptor(descriptor).descriptor, {
      exact: true,
    });
    const app = await appOf(ada);
    await env.DB.prepare("UPDATE app_versions SET exports = ? WHERE app_id = ?")
      .bind(
        JSON.stringify({
          lookup: { access: "read", input: shape, output: shape },
        }),
        app
      )
      .run();
    await sealed(app, 1);
    const workflow = await createWorkflowResource(env, ada, `op-${unique()}`);
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
              bindings: { lookup: { kind: "operation", contract: key } },
            },
          },
        },
        input: { schema: objectSchema({ who: { type: "string" } }) },
        output: { schema: objectSchema({ status: { type: "string" } }) },
        do: [
          {
            look: {
              call: "grasp.operation",
              with: { binding: "lookup", arguments: {} },
            },
          },
          { finish: { set: { status: "done" } } },
        ],
      }),
      basedOn: null,
    });
    const permissionId = await granted(ada, admin, {
      subject: { type: "workflow", workflowId: workflow.id },
      object: { type: "app", appId: appIdSchema.parse(app) },
      actions: ["read"],
      binding: `APP_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    // Retention removes the release, no pin holding it yet, just after the
    // approval checked it and before its batch lands.
    const db = racingDb(
      async () =>
        await env.DB.prepare(
          "DELETE FROM sdk_release_manifests WHERE app_id = ? AND version = 1"
        )
          .bind(app)
          .run(),
      /insert into "workflow_binding_approvals"/iu
    );
    const approved = await outcome(
      approveWorkflowBinding({ ...env, DB: db }, admin, workflow.id, {
        alias: "lookup",
        target: {
          kind: "operation",
          permissionId,
          appVersion: 1,
          export: "lookup",
        },
        reviewed: { version: 1 },
      })
    );
    const approvals = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM workflow_binding_approvals WHERE workflow_resource_id = ?"
    )
      .bind(workflow.id)
      .first<{ count: number }>();
    expect({ approved, approvals: approvals?.count }).toStrictEqual({
      approved: "workflow.binding_invalid",
      approvals: 0,
    });
  });
});

describe("what a start freezes", () => {
  it("serves an approval to the exact version an admin reviewed, never a later or an earlier one", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = await modelContract(admin);
    const workflow = await workflowOf(ada, key);
    const publish = async (version: string, basedOn: number) =>
      await publishWorkflowVersion(env, ada, workflow.id, {
        definition: definitionOf({ name: workflow.name, version, model: key }),
        basedOn,
      });
    const approve = async (version: number) =>
      await approveWorkflowBinding(env, admin, workflow.id, {
        alias: "summary",
        target: { kind: "model", model: allowedModel },
        reviewed: { version },
      });
    await approve(1);
    // A builder publishes versions 2 and 3, declaring the alias the same:
    // code no admin reviewed with that model, until one reviews version 3.
    await publish("2.0.0", 1);
    const unreviewed = await outcome(start(ada, workflow.id, 2));
    await publish("3.0.0", 2);
    const decided = await decide(
      { type: "person", person: ada },
      workflow.id,
      1
    );
    await approve(3);
    expect({
      unreviewed,
      reviewed: await outcome(start(ada, workflow.id, 1)),
      earlierThanReview: await outcome(start(ada, workflow.id, 2)),
      newlyReviewed: await outcome(start(ada, workflow.id, 3)),
      // Approving version 3 left version 1's approval as it was.
      decidedBefore: await outcome(admitWorkflowStart(env, decided)),
    }).toStrictEqual({
      unreviewed: "workflow.binding_unapproved",
      reviewed: "ok",
      earlierThanReview: "workflow.binding_unapproved",
      newlyReviewed: "ok",
      // The approval moved the policy generation: decided again.
      decidedBefore: "workflow.start_denied",
    });
  });

  it("starts another workflow it binds only while that one is live and it holds its own grant to start it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const child = await workflowOf(ada);
    const parent = await createWorkflowResource(env, ada, `parent-${unique()}`);
    await publishWorkflowVersion(env, ada, parent.id, {
      definition: definitionOf({ name: parent.name, child: child.name }),
      basedOn: null,
    });
    const ungranted = await outcome(start(ada, parent.id));
    await granted(ada, admin, {
      subject: { type: "workflow", workflowId: parent.id },
      object: { type: "workflow", workflowId: child.id },
      actions: ["start"],
      binding: "CHILD",
    });
    const allowed = await outcome(start(ada, parent.id));
    // Version 2 binds nothing, so the child can go; version 1 still binds it.
    await publishWorkflowVersion(env, ada, parent.id, {
      definition: definitionOf({ name: parent.name, version: "2.0.0" }),
      basedOn: 1,
    });
    const deleted = await outcome(deleteWorkflowResource(env, ada, child.id));
    expect({
      ungranted,
      allowed,
      deleted,
      childGone: await outcome(start(ada, parent.id)),
    }).toStrictEqual({
      ungranted: "workflow.start_denied",
      allowed: "ok",
      deleted: "ok",
      childGone: "workflow.start_denied",
    });
  });

  it("needs an approval for each catalog binding, freezes it, and is refused once it is revoked, but for a start sent again", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = await modelContract(admin);
    const workflow = await workflowOf(ada, key);
    const unapproved = await outcome(start(ada, workflow.id));
    const approval = await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "summary",
      target: { kind: "model", model: allowedModel },
      reviewed: { version: 1 },
    });
    const request = {
      version: 1,
      input: { who: "Ada" },
      key: `key-${unique()}`,
    };
    const asAda = { type: "person", person: ada } as const;
    const started = await startWorkflow(env, asAda, workflow.id, request);
    const stored = await receiptRow(started.id);
    const decided = await decide(
      { type: "person", person: ada },
      workflow.id,
      1
    );
    await revokeWorkflowBinding(env, admin, workflow.id, approval.id);
    const generation = async () =>
      await env.DB.prepare(
        "SELECT policy_generation AS n FROM workflow_resources WHERE id = ?"
      )
        .bind(workflow.id)
        .first<number>("n");
    const revoked = await generation();
    // Revoking it again changes nothing, so refuses no start.
    await revokeWorkflowBinding(env, admin, workflow.id, approval.id);
    const frozen: unknown = JSON.parse(stored?.bindings ?? "[]");
    // The start admitted before the revocation, sent again, is that start.
    const sentAgain = await startWorkflow(env, asAda, workflow.id, request);
    expect({
      revokedAgain: (await generation()) === revoked,
      unapproved,
      frozen,
      decidedBefore: await outcome(admitWorkflowStart(env, decided)),
      after: await outcome(start(ada, workflow.id)),
      sentAgain: sentAgain.id,
    }).toStrictEqual({
      unapproved: "workflow.binding_unapproved",
      frozen: [
        {
          alias: "summary",
          kind: "model",
          resourceId: null,
          resourceVersion: null,
          contractId: key,
          fingerprint: approval.fingerprint,
          approval: approval.id,
          target: { kind: "model", model: allowedModel },
        },
      ],
      decidedBefore: "workflow.start_denied",
      after: "workflow.binding_unapproved",
      revokedAgain: true,
      sentAgain: started.id,
    });
  });

  it("admits a version with as many catalog bindings as the profile allows", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = await modelContract(admin);
    const aliases = Array.from({ length: 40 }, (_, index) => `model${index}`);
    const workflow = await createWorkflowResource(env, ada, `many-${unique()}`);
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
              bindings: Object.fromEntries(
                aliases.map((alias) => [
                  alias,
                  { kind: "model", contract: key },
                ])
              ),
            },
          },
        },
        input: { schema: objectSchema({ who: { type: "string" } }) },
        output: { schema: objectSchema({ status: { type: "string" } }) },
        do: [
          ...aliases.map((alias) => ({
            [`ask-${alias.toLowerCase()}`]: {
              call: "grasp.model",
              with: {
                binding: alias,
                instructions: "Greet them.",
                input: { who: "${ $workflow.input.who }" },
                outputSchema: objectSchema({ line: { type: "string" } }),
              },
            },
          })),
          { finish: { set: { status: "done" } } },
        ],
      }),
      basedOn: null,
    });
    for (const alias of aliases) {
      // oxlint-disable-next-line no-await-in-loop -- one approval at a time, as an admin gives them
      await approveWorkflowBinding(env, admin, workflow.id, {
        alias,
        target: { kind: "model", model: allowedModel },
        reviewed: { version: 1 },
      });
    }
    await expect(outcome(start(ada, workflow.id))).resolves.toBe("ok");
  });

  it("freezes the parameter revision in force, refuses a start an edit raced, and never changes after", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    await setWorkflowParams(env, ada, workflow.id, {
      expectedRevision: 0,
      values: { limit: 5 },
    });
    const first = await start(ada, workflow.id);
    const decided = await decide(
      { type: "person", person: ada },
      workflow.id,
      1
    );
    await setWorkflowParams(env, ada, workflow.id, {
      expectedRevision: 1,
      values: { limit: 7 },
    });
    const raced = await outcome(admitWorkflowStart(env, decided));
    const mutated = await outcome(
      env.DB.prepare(
        "UPDATE workflow_start_receipts SET params = '{}' WHERE id = ?"
      )
        .bind(first.id)
        .run()
    );
    // Even with its input and values removed, as retention would, nothing
    // else of it changes.
    const rebound = await outcome(
      env.DB.prepare(
        "UPDATE workflow_start_receipts SET input = NULL, params = NULL, details_removed_at = ?, bindings_hash = 'other' WHERE id = ?"
      )
        .bind(Date.now(), first.id)
        .run()
    );
    const stored = await receiptRow(first.id);
    const params: unknown = JSON.parse(stored?.params ?? "{}");
    expect({
      params,
      revision: stored?.params_revision,
      raced,
      mutated: mutated.includes("immutable"),
      rebound: rebound.includes("immutable"),
    }).toStrictEqual({
      params: { limit: 5, token: "none" },
      revision: 1,
      raced: "workflow.start_denied",
      mutated: true,
      rebound: true,
    });
  });
});

describe("parameter configuration", () => {
  it("is revision-checked, checked against the current version, and edited by builders, never staff", async () => {
    const ada = await person("builder");
    const reader = await person("builder");
    const staff = await person("admin", true);
    const workflow = await workflowOf(ada);
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: reader.userId,
      role: "user",
    });
    const secret = `secret-${unique()}`;
    const set = async (by: Person, input: unknown) =>
      await setWorkflowParams(env, by, workflow.id, input);
    const tooHighAttempt = set(ada, {
      expectedRevision: 0,
      values: { limit: 99 },
    });
    const [tooHighCode, tooHigh] = await Promise.all([
      outcome(tooHighAttempt),
      refusal(tooHighAttempt),
    ]);
    const first = await set(ada, {
      expectedRevision: 0,
      values: { token: secret },
    });
    expect({
      reader: await outcome(
        set(reader, { expectedRevision: 1, values: { limit: 2 } })
      ),
      staff: await outcome(
        set(staff, { expectedRevision: 1, values: { limit: 2 } })
      ),
      unknown: await outcome(
        set(ada, { expectedRevision: 0, values: { other: 1 } })
      ),
      tooHigh: tooHighCode,
      leaks: JSON.stringify(tooHigh).includes("99"),
      first: first.revision,
      stale: await outcome(
        set(ada, { expectedRevision: 0, values: { limit: 2 } })
      ),
    }).toStrictEqual({
      reader: "role.forbidden",
      staff: "role.forbidden",
      unknown: "workflow.params_invalid",
      tooHigh: "workflow.params_invalid",
      leaks: false,
      first: 1,
      stale: "workflow.params_conflict",
    });
  });

  it("refuses an edit checked against a version another replaced as it was written", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    // A new version is published between the check and the write.
    const db = racingDb(
      async () =>
        await publishWorkflowVersion(env, ada, workflow.id, {
          definition: definitionOf({ name: workflow.name, version: "2.0.0" }),
          basedOn: 1,
        }),
      /insert into "workflow_resource_params"/iu
    );
    const raced = await outcome(
      setWorkflowParams({ ...env, DB: db }, ada, workflow.id, {
        expectedRevision: 0,
        values: { limit: 4 },
      })
    );
    const read = await workflowParams(env, ada, workflow.id);
    expect({
      raced,
      revision: read.revision,
      again: await outcome(
        setWorkflowParams(env, ada, workflow.id, {
          expectedRevision: 0,
          values: { limit: 4 },
        })
      ),
    }).toStrictEqual({
      raced: "workflow.params_conflict",
      revision: 0,
      again: "ok",
    });
  });

  it("takes null as a value, and puts a parameter back to its default only when told to reset it", async () => {
    const ada = await person("builder");
    const workflow = await createWorkflowResource(env, ada, `null-${unique()}`);
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
              params: {
                // Required, with null its only value.
                marker: {
                  schema: { type: "null" },
                  label: "Marker",
                  required: true,
                  sensitive: false,
                },
                limit: {
                  schema: { type: "integer", minimum: 1, maximum: 10 },
                  label: "Limit",
                  default: 3,
                  sensitive: false,
                },
              },
              bindings: {},
            },
          },
        },
        input: { schema: objectSchema({ who: { type: "string" } }) },
        output: { schema: objectSchema({ status: { type: "string" } }) },
        do: [{ finish: { set: { status: "done" } } }],
      }),
      basedOn: null,
    });
    const set = async (input: unknown) =>
      await setWorkflowParams(env, ada, workflow.id, input);
    const unset = await outcome(start(ada, workflow.id));
    await set({ expectedRevision: 0, values: { marker: null, limit: 7 } });
    const withNull = await outcome(start(ada, workflow.id));
    const both = await outcome(
      set({ expectedRevision: 1, values: { limit: 2 }, reset: ["limit"] })
    );
    const reset = await set({ expectedRevision: 1, reset: ["limit"] });
    // A required parameter has no default to go back to.
    const resetRequired = await outcome(
      set({ expectedRevision: 2, reset: ["marker"] })
    );
    expect({
      unset,
      withNull,
      both,
      resetRequired,
      after: reset.params.map(({ name, set: isSet, value }) => ({
        name,
        set: isSet,
        value,
      })),
    }).toStrictEqual({
      unset: "workflow.params_invalid",
      withNull: "ok",
      both: "workflow.params_invalid",
      resetRequired: "workflow.params_invalid",
      after: [
        { name: "limit", set: false, value: null },
        { name: "marker", set: true, value: null },
      ],
    });
  });

  it("refuses values too large together to fit a start's receipt, before saving anything", async () => {
    const ada = await person("builder");
    const workflow = await createWorkflowResource(env, ada, `big-${unique()}`);
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
              params: Object.fromEntries(
                ["first", "second"].map((name) => [
                  name,
                  {
                    schema: { type: "string", maxLength: 400_000 },
                    label: name,
                    default: "",
                    sensitive: false,
                  },
                ])
              ),
              bindings: {},
            },
          },
        },
        input: { schema: objectSchema({ who: { type: "string" } }) },
        output: { schema: objectSchema({ status: { type: "string" } }) },
        do: [{ finish: { set: { status: "done" } } }],
      }),
      basedOn: null,
    });
    // Each fits its own schema; together they are over the bound.
    const large = "x".repeat(300_000);
    const together = await outcome(
      setWorkflowParams(env, ada, workflow.id, {
        expectedRevision: 0,
        values: { first: large, second: large },
      })
    );
    const read = await workflowParams(env, ada, workflow.id);
    const one = await outcome(
      setWorkflowParams(env, ada, workflow.id, {
        expectedRevision: 0,
        values: { first: large },
      })
    );
    expect({ together, revision: read.revision, one }).toStrictEqual({
      together: "workflow.params_invalid",
      revision: 0,
      one: "ok",
    });
  });

  it("never lists or audits a sensitive value", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const secret = `secret-${unique()}`;
    await setWorkflowParams(env, ada, workflow.id, {
      expectedRevision: 0,
      values: { token: secret, limit: 4 },
    });
    const listed = await workflowParams(env, ada, workflow.id);
    const started = await start(ada, workflow.id);
    const events = await allEvents();
    // Nor a hash of the values, which a guess at a short one is checked
    // against.
    const hashed = await sha256Hex(canonicalJson({ limit: 4, token: secret }));
    expect({
      listed: listed.params,
      inEvents: JSON.stringify(events).includes(secret),
      inReceipt: JSON.stringify(started).includes(secret),
      hashInEvents: JSON.stringify(events).includes(hashed),
      hashInReceipt: JSON.stringify(started).includes(hashed),
    }).toStrictEqual({
      listed: [
        {
          name: "limit",
          label: "Limit",
          sensitive: false,
          set: true,
          value: 4,
        },
        {
          name: "token",
          label: "Token",
          sensitive: true,
          set: true,
          value: null,
        },
      ],
      inEvents: false,
      inReceipt: false,
      hashInEvents: false,
      hashInReceipt: false,
    });
  });
});

describe("a sensitive parameter", () => {
  it("stays withheld once any version marked it, whatever a later version says", async () => {
    const ada = await person("builder");
    const reader = await person("builder");
    const workflow = await workflowOf(ada);
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: reader.userId,
      role: "user",
    });
    const secret = `secret-${unique()}`;
    await setWorkflowParams(env, ada, workflow.id, {
      expectedRevision: 0,
      values: { token: secret },
    });
    // A builder declares it not sensitive in a new version.
    await publishWorkflowVersion(env, ada, workflow.id, {
      definition: definitionOf({
        name: workflow.name,
        version: "2.0.0",
        tokenSensitive: false,
      }),
      basedOn: 1,
    });
    const listed = await workflowParams(env, reader, workflow.id);
    const later = `later-${unique()}`;
    const edited = await setWorkflowParams(env, ada, workflow.id, {
      expectedRevision: 1,
      values: { token: later },
    });
    expect({
      listed: listed.params.find(({ name }) => name === "token"),
      leaks: JSON.stringify([listed, edited]).includes(secret),
      leaksLater: JSON.stringify(edited).includes(later),
    }).toStrictEqual({
      listed: {
        name: "token",
        label: "Token",
        sensitive: true,
        set: true,
        value: null,
      },
      leaks: false,
      leaksLater: false,
    });
  });
});

describe("an App binding a workflow", () => {
  it("pins an exact version, grants nothing, and while its App may start it keeps the workflow from being deleted", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const bob = await person("builder");
    const cy = await person("builder");
    const eve = await person("builder");
    const staff = await person("admin", true);
    const workflow = await workflowOf(ada);
    const app = await appOf(ada);
    await env.DB.prepare(
      "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'builder', ?, ?)"
    )
      .bind(app, bob.userId, ada.userId, Date.now())
      .run();
    // Cy builds the workflow, not the App.
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: cy.userId,
      role: "builder",
    });
    const authority: Authority = {
      subject: { type: "app", appId: appIdSchema.parse(app) },
      onBehalfOf: ada.userId,
      mode: "interactive",
      appVersion: 1,
    };
    const bind = async (by: Person, version: number) =>
      await bindWorkflowToApp(env, by, workflow.id, {
        app,
        alias: "greet",
        version,
      });
    // Bob builds the App but has no role in the workflow.
    const byBob = await outcome(bind(bob, 1));
    const byStaff = await outcome(bind(staff, 1));
    const missingVersion = await outcome(bind(ada, 9));
    const binding = await bind(ada, 1);
    const ungranted = await outcome(
      startAppBinding(env, authority, "greet", {
        input: { who: "Ada" },
        key: "k1",
      })
    );
    await granted(ada, admin, {
      subject: { type: "app", appId: appIdSchema.parse(app) },
      object: { type: "workflow", workflowId: workflow.id },
      actions: ["start"],
      binding: "GREET",
    });
    const started = await startAppBinding(env, authority, "greet", {
      input: { who: "Ada" },
      key: "k2",
    });
    const bound = await refusal(deleteWorkflowResource(env, ada, workflow.id));
    const events = await allEvents();
    const refused = events.find(
      ({ action, target }) =>
        action === "workflow.delete_refused" && target?.id === workflow.id
    );
    const unbinds = {
      staff: await outcome(unbindWorkflowFromApp(env, staff, binding.id)),
      eve: await outcome(unbindWorkflowFromApp(env, eve, binding.id)),
      // A builder of the workflow removes what holds it up.
      cy: await outcome(unbindWorkflowFromApp(env, cy, binding.id)),
    };
    expect({
      byBob,
      byStaff,
      missingVersion,
      ungranted,
      started: started.version,
      bound,
      audited: refused?.detail,
      unbinds,
      afterUnbind: await outcome(deleteWorkflowResource(env, ada, workflow.id)),
    }).toMatchObject({
      byBob: "workflow.resource_unavailable",
      byStaff: "role.forbidden",
      missingVersion: "workflow.app_binding_invalid",
      ungranted: "workflow.start_denied",
      started: 1,
      bound: {
        code: "workflow.resource_bound",
        details: { appBindings: [{ id: binding.id, app }] },
      },
      audited: { appBindings: 1, appBinding1: binding.id, app1: app },
      unbinds: {
        staff: "role.forbidden",
        eve: "workflow.app_binding_unavailable",
        cy: "ok",
      },
      afterUnbind: "ok",
    });
  });

  it("pins nothing while its App may not start the workflow", async () => {
    const ada = await person("builder");
    const bob = await person("builder");
    const workflow = await workflowOf(ada);
    // Bob, a user of the workflow, binds it to an App of his own.
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    const app = await appOf(bob);
    await bindWorkflowToApp(env, bob, workflow.id, {
      app,
      alias: "greet",
      version: 1,
    });
    await expect(
      outcome(deleteWorkflowResource(env, ada, workflow.id))
    ).resolves.toBe("ok");
  });

  it("makes the screens of an App that starts a workflow sensitive again when the workflow is granted more", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const app = await appOf(ada);
    await granted(ada, admin, {
      subject: { type: "app", appId: appIdSchema.parse(app) },
      object: { type: "workflow", workflowId: workflow.id },
      actions: ["start"],
      binding: "GREET",
    });
    // An admin judged the App's data ordinary, with the access it had.
    await env.DB.prepare(
      `INSERT INTO screen_policies (app_id, output, generation) VALUES (?, 'ordinary', 1)
       ON CONFLICT (app_id) DO UPDATE SET output = 'ordinary', generation = generation + 1`
    )
      .bind(app)
      .run();
    const before = await standingOf(env, appIdSchema.parse(app));
    await granted(ada, admin, {
      subject: { type: "workflow", workflowId: workflow.id },
      object: { type: "connection", connectionId: `connection-${unique()}` },
      actions: ["mail.send"],
      binding: `MAIL_${unique().toUpperCase()}`,
    });
    const after = await standingOf(env, appIdSchema.parse(app));
    expect({
      output: after.output,
      moved: after.generation - before.generation,
    }).toStrictEqual({ output: "sensitive", moved: 1 });
  });
});

describe("screen trust through workflows", () => {
  it("makes the screens of an App sensitive again when an App its workflow calls is granted more", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    // App X starts the workflow, which calls App Y's exports.
    const starter = await appOf(ada);
    const called = await appOf(ada);
    await granted(ada, admin, {
      subject: { type: "app", appId: appIdSchema.parse(starter) },
      object: { type: "workflow", workflowId: workflow.id },
      actions: ["start"],
      binding: "GREET",
    });
    await granted(ada, admin, {
      subject: { type: "workflow", workflowId: workflow.id },
      object: { type: "app", appId: appIdSchema.parse(called) },
      actions: ["read"],
      binding: `APP_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    await env.DB.prepare(
      `INSERT INTO screen_policies (app_id, output, generation) VALUES (?, 'ordinary', 1)
       ON CONFLICT (app_id) DO UPDATE SET output = 'ordinary', generation = generation + 1`
    )
      .bind(starter)
      .run();
    const before = await standingOf(env, appIdSchema.parse(starter));
    await granted(ada, admin, {
      subject: { type: "app", appId: appIdSchema.parse(called) },
      object: { type: "connection", connectionId: `connection-${unique()}` },
      actions: ["mail.send"],
      binding: `MAIL_${unique().toUpperCase()}`,
    });
    const after = await standingOf(env, appIdSchema.parse(starter));
    expect({
      output: after.output,
      moved: after.generation - before.generation,
    }).toStrictEqual({ output: "sensitive", moved: 1 });
  });
});

describe("retention", () => {
  it("removes a receipt's input and values and a replaced revision's values, and nothing else", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const secret = `secret-${unique()}`;
    await setWorkflowParams(env, ada, workflow.id, {
      expectedRevision: 0,
      values: { token: secret },
    });
    await setWorkflowParams(env, ada, workflow.id, {
      expectedRevision: 1,
      values: { limit: 4 },
    });
    const key = `key-${unique()}`;
    const request = { version: 1, input: { who: "Ada" }, key };
    const first = await startWorkflow(
      env,
      { type: "person", person: ada },
      workflow.id,
      request
    );
    // Its run reads them until it ends: retention counts from then.
    await vi.waitFor(
      async () => {
        const run = await resourceRunFor(env, ada, workflow.id, first.runId);
        expect(run.endedAt).not.toBeNull();
      },
      { timeout: 30_000, interval: 100 }
    );
    // Run retention, past the deployment's retention (30 days).
    await sweepRunDetails(env, new Date(Date.now() + 31 * 24 * 3_600_000));
    const receipt = await receiptRow(first.id);
    const revisions = await env.DB.prepare(
      'SELECT revision, "values" AS kept FROM workflow_resource_params WHERE workflow_resource_id = ? ORDER BY revision'
    )
      .bind(workflow.id)
      .all<{ revision: number; kept: string | null }>();
    const listed = await workflowParams(env, ada, workflow.id);
    // The same start sent again is still the same start, by its key.
    const again = await startWorkflow(
      env,
      { type: "person", person: ada },
      workflow.id,
      request
    );
    expect({
      receipt: {
        input: receipt?.input,
        params: receipt?.params,
        removed: receipt?.details_removed_at !== null,
        bindings: receipt?.bindings,
      },
      revisions: revisions.results.map(({ revision, kept }) => ({
        revision,
        kept: kept !== null,
      })),
      limit: listed.params.find(({ name }) => name === "limit")?.value,
      again: again.id,
    }).toStrictEqual({
      receipt: { input: null, params: null, removed: true, bindings: "[]" },
      revisions: [
        { revision: 1, kept: false },
        { revision: 2, kept: true },
      ],
      limit: 4,
      again: first.id,
    });
  });
});

describe("deleting a workflow", () => {
  it("is refused while a run of it hasn't ended, and the refusal audited with it", async () => {
    const ada = await person("builder");
    const workflow = await createWorkflowResource(
      env,
      ada,
      `greet-${unique()}`
    );
    await publishWorkflowVersion(env, ada, workflow.id, {
      definition: definitionOf({ name: workflow.name, waits: true }),
      basedOn: null,
    });
    // Its run waits an hour: it hasn't ended as the deletion is asked.
    await start(ada, workflow.id);
    const error = await refusal(deleteWorkflowResource(env, ada, workflow.id));
    const events = await allEvents();
    const refused = events.find(
      ({ action, target }) =>
        action === "workflow.delete_refused" && target?.id === workflow.id
    );
    expect({ error, audited: refused?.detail }).toMatchObject({
      error: { code: "workflow.resource_bound", details: { liveRuns: 1 } },
      audited: { liveRuns: 1 },
    });
  });
});
