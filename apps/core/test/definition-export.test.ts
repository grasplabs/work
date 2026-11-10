import { generatedWorkflowEntry } from "@grasp-os/compiler";
import { definitionText, readDefinition } from "@grasp-os/runtime/definition";
import { readAppManifest } from "@grasp-os/runtime/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalText } from "@grasp-os/shared/json";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { publishVersion } from "../src/app-publish.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import type { Acting } from "../src/auth/identity.ts";
import { exportAppDefinition } from "../src/definition-export.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { testApp, withFiles } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { published as publishedApp } from "./apps.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import { auditedDuring, outcome, refusal, unique } from "./sign-in.ts";

// Exporting an App's definition (definition-export.ts): its current
// sealed release and the exact workflow versions it binds, as portable
// source. What a package may carry is its schema's allow-list, so these
// assert its shape key by key, not only that known secrets are absent.

const workflowShape = `v.object({ who: v.string() })`;

/** An App that declares three workflows and a model, with a store. */
const files = (): TestApp =>
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
        "permission.ai({ maxOutputTokens: 100 })",
        `permission.workflow("followUp", {
  args: ${workflowShape},
  returns: v.object({ status: v.string() }),
})`,
        `permission.workflow("remind", {
  args: ${workflowShape},
  returns: v.object({ status: v.string() }),
})`,
        `permission.workflow("later", {
  args: ${workflowShape},
  returns: v.object({ status: v.string() }),
})`,
      ],
    },
    {
      "server/requests.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const followUp = permissions.followUp;
export const remind = permissions.remind;
export const later = permissions.later;
export const writer = permissions.ai;

export const kickOff = action({
  args: { who: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const started = await ctx.workflows.followUp.start({ who: args.who });
    return started.startId;
  },
});
`,
    }
  );

const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/** A greeting workflow's definition, with `params` as its parameters. */
const definitionOf = (params: Record<string, unknown>): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status: "done" },
    params,
    steps: [],
  });

/** A workflow `by` created and published `params` to, as version 1. */
const published = async (by: Acting, params: Record<string, unknown>) => {
  const workflow = await createWorkflowResource(env, by, `greet-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: definitionOf(params),
    basedOn: null,
  });
  return workflow;
};

/** A refusal's code and details, as these tests read them. */
const refusedSchema = z.object({ code: z.string(), details: z.unknown() });

/** The sorted keys of `value`. */
const keys = (value: object): string[] => Object.keys(value).toSorted();

describe("exporting an App's definition", { timeout: 120_000 }, () => {
  it("packages the sealed release and each version it binds once, as generated code with only what its allow-list names", async () => {
    const fixture = await appWith(files(), "Requests");
    const { owner, app, store } = fixture;
    const workflow = await published(owner, {
      apiKey: { label: "API key", type: { kind: "string" } },
      pageSize: {
        label: "Page size",
        type: { kind: "number", default: 25 },
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
    await publishVersion(env, owner, app, 1);

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
      app: [
        "bindings",
        "definition",
        "files",
        "manifest",
        "provenance",
        "store",
        "version",
        "workflowContracts",
        "workflows",
      ],
      provenance: [
        "compilerVersion",
        "contractHash",
        "definitionHash",
        "dependencyLockHash",
        "generated",
        "manifestHash",
        "schemaHash",
        "sdkVersion",
        "sourceTreeHash",
        "uiVersion",
      ],
      generated: [
        ".grasp/contracts.json",
        "server/_generated/api.ts",
        "server/_generated/dataModel.ts",
        "server/_generated/internal.ts",
        "server/_generated/server.ts",
      ],
      store: ["alias", "operationManifestHash", "schemaHash", "schemaVersion"],
      workflow: ["bindings", "files", "provenance"],
      workflowProvenance: [
        "buildHash",
        "definitionHash",
        "manifestHash",
        "profile",
      ],
      // The code alone: the definition stays with the version.
      workflowFiles: [generatedWorkflowEntry],
    });
    // The source, and the registration the seal read from it, which the
    // SDK reads back as it was sealed.
    // The definition, apart from the files, which hashes as sealed.
    expect({
      files: keys(exported.app.files),
      manifest: canonicalText(readAppManifest(exported.app.manifest)),
      definitionHash: await sha256Hex(
        definitionText(readDefinition(exported.app.definition))
      ),
      provenance: exported.app.provenance.definitionHash,
    }).toStrictEqual({
      files: keys(files().files),
      manifest: canonicalText(release.app),
      definitionHash: release.manifest.definitionHash,
      provenance: release.manifest.definitionHash,
    });

    // Both aliases name the one version, packaged once; the unbound alias
    // is listed, so activation blocks on it.
    expect({
      version: exported.app.version,
      manifestHash: exported.app.provenance.manifestHash,
      bindings: exported.app.bindings,
      workflows: exported.app.workflows,
      contracts: exported.app.workflowContracts,
      packaged: keys(exported.workflows),
      unresolved: exported.unresolved,
      workflowBindings: entry.bindings,
    }).toStrictEqual({
      version: 1,
      manifestHash: release.manifestHash,
      bindings: { ai: "ai" },
      workflows: { followUp: key, later: null, remind: key },
      // What the references type of each packaged one, never of the
      // unbound alias.
      contracts: {
        followUp: { events: {}, listens: {}, decisions: {} },
        remind: { events: {}, listens: {}, decisions: {} },
      },
      packaged: [key],
      unresolved: [{ alias: "later", reason: "unbound" }],
      workflowBindings: {},
    });

    const text = JSON.stringify(exported);
    const asPublished = await env.DB.prepare(
      "SELECT definition_json_hash, manifest_hash FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
    )
      .bind(workflow.id)
      .first<{ definition_json_hash: string; manifest_hash: string }>();
    expect({
      hashes: {
        manifest: entry.provenance.manifestHash,
        definition: entry.provenance.definitionHash,
      },
      // No row of this deployment anywhere in the package.
      ids: [store, workflow.id, owner.userId, app].filter((id) =>
        text.includes(id)
      ),
    }).toStrictEqual({
      hashes: {
        manifest: asPublished?.manifest_hash,
        definition: asPublished?.definition_json_hash,
      },
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

  it("lists a workflow its exporter doesn't build, without its code", async () => {
    const fixture = await appWith(files(), "Requests");
    const { owner, app } = fixture;
    const bob = await person("builder");
    const theirs = await published(bob, {});
    await shareWorkflowResource(env, bob, theirs.id, {
      type: "person",
      id: owner.userId,
      role: "user",
    });
    await bindWorkflowToApp(env, owner, theirs.id, {
      app,
      alias: "followUp",
      version: 1,
    });
    await seal(fixture);
    await publishVersion(env, owner, app, 1);

    const exported = await exportAppDefinition(env, owner, app);
    expect({
      workflows: exported.app.workflows,
      contracts: exported.app.workflowContracts,
      packaged: exported.workflows,
      unresolved: exported.unresolved.toSorted((a, b) =>
        a.alias < b.alias ? -1 : 1
      ),
    }).toStrictEqual({
      workflows: { followUp: null, later: null, remind: null },
      contracts: {},
      packaged: {},
      unresolved: [
        { alias: "followUp", reason: "forbidden" },
        { alias: "later", reason: "unbound" },
        { alias: "remind", reason: "unbound" },
      ],
    });
    expect(JSON.stringify(exported)).not.toContain(theirs.name);
  });

  it("refuses a package past its byte budget, or one whose files hold a known secret format, naming the file and never the match", async () => {
    const budgeted = await appWith(files(), "Requests");
    await seal(budgeted);
    await publishVersion(env, budgeted.owner, budgeted.app, 1);
    // Built here, so no file of the repository holds one.
    const token = ["ghp", "_", "Q".repeat(36)].join("");
    const leaky = await appWith(
      withFiles(files(), {
        "server/requests.ts": `// Deploy with ${token}\n${files().files["server/requests.ts"] ?? ""}`,
      }),
      "Requests"
    );
    await seal(leaky);
    await publishVersion(env, leaky.owner, leaky.app, 1);

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
        details: { path: "app/server/requests.ts" },
      },
      echoed: false,
    });
  });

  it("is for the App's builders and its admins, never its users or Grasp staff, and records no refusal", async () => {
    const fixture = await appWith(files(), "Requests");
    const { owner, app } = fixture;
    await seal(fixture);
    await publishVersion(env, owner, app, 1);
    await publishedApp(app);
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
