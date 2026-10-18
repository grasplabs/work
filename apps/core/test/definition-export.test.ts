import { generatedPath } from "@grasp-os/open-workflow/generate";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { setCurrentVersion } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { exportAppDefinition } from "../src/definition-export.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import { auditedDuring, outcome, refusal, unique } from "./sign-in.ts";

// Exporting an App's definition (definition-export.ts): its current
// sealed release and the exact workflow versions it binds, as portable
// source. What a package may carry is its schema's allow-list, so these
// assert its shape key by key, not only that known secrets are absent.

const workflowShape = `v.object({ who: v.string() })`;

/** An App that declares three workflows and a model, with a store. */
const files = (): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  requests: defineTable({ who: v.string() }),
});
`,
  "operations/requests.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const followUp = resource.workflow("followUp", {
  input: ${workflowShape},
  output: v.object({ status: v.string() }),
});
export const remind = resource.workflow("remind", {
  input: ${workflowShape},
  output: v.object({ status: v.string() }),
});
export const later = resource.workflow("later", {
  input: ${workflowShape},
  output: v.object({ status: v.string() }),
});
export const writer = resource.model("writer", { maxOutputTokens: 100 });

export const kickOff = action({
  args: { who: v.string() },
  returns: v.string(),
  uses: [followUp, remind, later, writer],
  handler: async (ctx, args) => {
    const started = await ctx.startWorkflow(followUp, { who: args.who });
    return started.startId;
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { followUp, kickOff, later, remind, writer } from "./operations/requests.ts";
import schema from "./schema.ts";

export default app({
  name: "Requests",
  schema,
  access: { tables: { requests: { read: "appMembers", write: "appMembers" } } },
  operations: { requests: { kickOff } },
  screens: [],
  uses: [followUp, remind, later, writer],
});
`,
});

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A greeting workflow's definition, with `params` as its parameters. */
const definitionOf = (name: string, params: Record<string, unknown>): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params, bindings: {} },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [{ greet: { set: { status: "done" } } }],
  });

/** A workflow `by` created and published `params` to, as version 1. */
const published = async (by: Acting, params: Record<string, unknown>) => {
  const workflow = await createWorkflowResource(env, by, `greet-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: definitionOf(workflow.name, params),
    basedOn: null,
  });
  return workflow;
};

/** A workflow definition's parameters, as far as these tests read them. */
const paramsSchema = z.object({
  document: z.object({
    metadata: z.object({
      grasp: z.object({
        params: z.record(
          z.string(),
          z.looseObject({
            default: z.unknown().optional(),
            schema: z.looseObject({
              properties: z.record(z.string(), z.unknown()).optional(),
            }),
          })
        ),
      }),
    }),
  }),
});

/** A refusal's code and details, as these tests read them. */
const refusedSchema = z.object({ code: z.string(), details: z.unknown() });

/** The sorted keys of `value`. */
const keys = (value: object): string[] => Object.keys(value).toSorted();

describe("exporting an App's definition", { timeout: 120_000 }, () => {
  it("packages the sealed release and each version it binds once, with only what its allow-list names and no sensitive default or bound", async () => {
    const fixture = await appWith(files(), "Requests");
    const { owner, app, store } = fixture;
    const apiKey = `api-key-${unique()}`;
    const region = `region-${unique()}`;
    // Long enough that no hash in the package holds it by chance.
    const floor =
      1_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000_000);
    const workflow = await published(owner, {
      retries: {
        schema: { type: "integer", minimum: floor },
        label: "Retries",
        required: true,
        sensitive: true,
      },
      apiKey: {
        schema: { type: "string" },
        label: "API key",
        default: apiKey,
        sensitive: true,
      },
      settings: {
        schema: {
          type: "object",
          properties: { region: { type: "string", default: region } },
          required: [],
          additionalProperties: false,
        },
        label: "Settings",
        required: true,
        sensitive: true,
      },
      pageSize: {
        schema: { type: "number" },
        label: "Page size",
        default: 25,
        sensitive: false,
      },
    });
    for (const alias of ["followUp", "remind"]) {
      // oxlint-disable-next-line no-await-in-loop -- one alias at a time
      await bindWorkflowToApp(env, owner, workflow.id, {
        app,
        alias,
        version: 1,
      });
    }
    const release = await seal(fixture);
    await setCurrentVersion(env, owner, app, 1);

    let exported: Awaited<ReturnType<typeof exportAppDefinition>> | undefined;
    const audited = await auditedDuring(async () => {
      exported = await exportAppDefinition(env, owner, app);
    });
    if (exported === undefined) {
      throw new Error("Nothing was exported");
    }
    const key = `${workflowNamespace}/${workflow.name}/1.0.0`;
    const entry = exported.workflows[key];
    if (entry === undefined) {
      throw new Error("The bound version wasn't packaged");
    }

    // The allow-list, level by level.
    expect({
      root: keys(exported),
      app: keys(exported.app),
      provenance: keys(exported.app.provenance),
      generated: keys(exported.app.provenance.generated),
      store: exported.app.store === null ? null : keys(exported.app.store),
      workflow: keys(entry),
      workflowProvenance: keys(entry.provenance),
      workflowFiles: keys(entry.files),
    }).toStrictEqual({
      root: ["app", "formatVersion", "unresolved", "workflows"],
      app: ["bindings", "files", "provenance", "store", "version", "workflows"],
      provenance: [
        "compilerVersion",
        "contractHash",
        "dependencyLockHash",
        "generated",
        "manifestHash",
        "schemaHash",
        "sdkProtocolVersion",
        "sdkVersion",
        "sourceTreeHash",
        "uiVersion",
      ],
      generated: [
        ".grasp/contracts.json",
        ".grasp/references.ts",
        ".grasp/server-references.ts",
        ".grasp/server.ts",
      ],
      store: ["alias", "operationManifestHash", "schemaHash", "schemaVersion"],
      workflow: [
        "bindings",
        "files",
        "provenance",
        "withheldConstraints",
        "withheldDefaults",
        "workflows",
      ],
      workflowProvenance: [
        "buildHash",
        "definitionHash",
        "evaluatorHash",
        "manifestHash",
        "profile",
      ],
      workflowFiles: [generatedPath, "workflow.json"].toSorted(),
    });
    expect(keys(exported.app.files)).toStrictEqual(keys(files()));

    // Both aliases name the one version, packaged once; the unbound alias
    // is listed, so activation blocks on it.
    expect({
      version: exported.app.version,
      manifestHash: exported.app.provenance.manifestHash,
      bindings: exported.app.bindings,
      workflows: exported.app.workflows,
      packaged: keys(exported.workflows),
      unresolved: exported.unresolved,
      nested: { workflows: entry.workflows, bindings: entry.bindings },
    }).toStrictEqual({
      version: 1,
      manifestHash: release.manifestHash,
      bindings: { writer: "model" },
      workflows: { followUp: key, later: null, remind: key },
      packaged: [key],
      unresolved: [{ at: "app", alias: "later", reason: "unbound" }],
      nested: { workflows: {}, bindings: {} },
    });

    // Sensitive defaults are withheld, the parameter required instead; a
    // default that isn't sensitive is kept.
    const { params } = paramsSchema.parse(
      JSON.parse(entry.files["workflow.json"] ?? "{}")
    ).document.metadata.grasp;
    const text = JSON.stringify(exported);
    // Nor any hash over the definition as published, against which a
    // holder could test guesses at what was withheld.
    const asPublished = await env.DB.prepare(
      "SELECT definition_json_hash, manifest_hash FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
    )
      .bind(workflow.id)
      .first<{ definition_json_hash: string; manifest_hash: string }>();
    expect({
      withheld: entry.withheldDefaults.toSorted(),
      constraints: entry.withheldConstraints,
      retries: params.retries?.schema,
      apiKey: params.apiKey,
      region: params.settings?.schema.properties?.region,
      pageSize: params.pageSize?.default,
      secrets: [
        apiKey,
        region,
        String(floor),
        asPublished?.definition_json_hash ?? "unpublished",
        asPublished?.manifest_hash ?? "unpublished",
      ].filter((secret) => text.includes(secret)),
      hashes: {
        manifest: entry.provenance.manifestHash,
        build: entry.provenance.buildHash,
        definition:
          entry.provenance.definitionHash ===
          (await sha256Hex(entry.files["workflow.json"] ?? "")),
      },
      // No row of this deployment anywhere in the package.
      ids: [store, workflow.id, owner.userId, app].filter((id) =>
        text.includes(id)
      ),
    }).toStrictEqual({
      withheld: ["apiKey", "settings"],
      constraints: ["retries"],
      retries: { type: "integer" },
      apiKey: {
        schema: { type: "string" },
        label: "API key",
        required: true,
        sensitive: true,
      },
      region: { type: "string" },
      pageSize: 25,
      secrets: [],
      hashes: { manifest: null, build: null, definition: true },
      ids: [],
    });

    expect(
      audited
        .filter(({ target }) => target?.id === app)
        .map(({ action, actor, detail }) => ({ action, actor, detail }))
    ).toStrictEqual([
      {
        action: "app.definition.exported",
        actor: { type: "person", userId: owner.userId },
        detail: { version: 1, workflows: 1, unresolved: 1 },
      },
    ]);
  });

  it("lists a workflow its exporter doesn't build, and those whose sensitive parameter pins or bounds its value, without their definitions", async () => {
    const fixture = await appWith(files(), "Requests");
    const { owner, app } = fixture;
    const bob = await person("builder");
    const theirs = await published(bob, {});
    await shareWorkflowResource(env, bob, theirs.id, {
      type: "person",
      id: owner.userId,
      role: "user",
    });
    const tier = `tier-${unique()}`;
    const pinning = await published(owner, {
      tier: {
        schema: { type: "string", enum: [tier, "standard"] },
        label: "Tier",
        required: true,
        sensitive: true,
      },
    });
    // Long enough that no hash in the package holds it by chance.
    const bound =
      1_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000_000);
    const bounding = await published(owner, {
      port: {
        schema: { type: "number", minimum: bound, maximum: bound },
        label: "Port",
        required: true,
        sensitive: true,
      },
    });
    await bindWorkflowToApp(env, owner, theirs.id, {
      app,
      alias: "followUp",
      version: 1,
    });
    await bindWorkflowToApp(env, owner, bounding.id, {
      app,
      alias: "later",
      version: 1,
    });
    await bindWorkflowToApp(env, owner, pinning.id, {
      app,
      alias: "remind",
      version: 1,
    });
    await seal(fixture);
    await setCurrentVersion(env, owner, app, 1);

    const exported = await exportAppDefinition(env, owner, app);
    expect({
      workflows: exported.app.workflows,
      packaged: exported.workflows,
      unresolved: exported.unresolved.toSorted((a, b) =>
        a.alias < b.alias ? -1 : 1
      ),
    }).toStrictEqual({
      workflows: { followUp: null, later: null, remind: null },
      packaged: {},
      unresolved: [
        { at: "app", alias: "followUp", reason: "forbidden" },
        { at: "app", alias: "later", reason: "sensitive_constraint" },
        { at: "app", alias: "remind", reason: "sensitive_constraint" },
      ],
    });
    const text = JSON.stringify(exported);
    expect(
      [tier, theirs.name, String(bound)].filter((value) => text.includes(value))
    ).toStrictEqual([]);
  });

  it("refuses a package past its byte budget, or one whose files hold a known secret format, naming the file and never the match", async () => {
    const budgeted = await appWith(files(), "Requests");
    await seal(budgeted);
    await setCurrentVersion(env, budgeted.owner, budgeted.app, 1);
    // Built here, so no file of the repository holds one.
    const token = ["ghp", "_", "Q".repeat(36)].join("");
    const leaky = await appWith(
      {
        ...files(),
        "app.ts": `// Deploy with ${token}\n${files()["app.ts"] ?? ""}`,
      },
      "Requests"
    );
    await seal(leaky);
    await setCurrentVersion(env, leaky.owner, leaky.app, 1);

    const refused = await refusal(
      exportAppDefinition(env, leaky.owner, leaky.app)
    );
    expect({
      tooLarge: await outcome(
        exportAppDefinition(
          { ...env, DEFINITION_EXPORT_MAX_BYTES: "1000" },
          budgeted.owner,
          budgeted.app
        )
      ),
      withinBudget: await outcome(
        exportAppDefinition(env, budgeted.owner, budgeted.app)
      ),
      secret: refusedSchema.parse(refused),
      echoed: JSON.stringify(refused).includes(token),
    }).toStrictEqual({
      tooLarge: "version.export_too_large",
      withinBudget: "ok",
      secret: {
        code: "version.export_secret_found",
        details: { path: "app/app.ts" },
      },
      echoed: false,
    });
  });

  it("is for the App's builders and its admins, never its users or Grasp staff, and records no refusal", async () => {
    const fixture = await appWith(files(), "Requests");
    const { owner, app } = fixture;
    await seal(fixture);
    await setCurrentVersion(env, owner, app, 1);
    const user = await person("user");
    await env.DB.prepare(
      "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
    )
      .bind(app, user.userId, owner.userId, Date.now())
      .run();
    const admin = await person("admin");
    const staff = { ...(await person("admin")), staff: true };

    const audited = await auditedDuring(async () => {
      expect({
        user: await outcome(exportAppDefinition(env, user, app)),
        staff: await outcome(exportAppDefinition(env, staff, app)),
        stranger: await outcome(
          exportAppDefinition(env, await person("builder"), app)
        ),
      }).toStrictEqual({
        user: "role.forbidden",
        staff: "role.forbidden",
        stranger: "app.not_found",
      });
      await exportAppDefinition(env, admin, app);
    });
    expect(
      audited
        .filter(({ target }) => target?.id === app)
        .map(({ actor }) => actor)
    ).toStrictEqual([{ type: "person", userId: admin.userId }]);
  });
});
