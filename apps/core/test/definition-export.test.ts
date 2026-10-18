/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { generatedPath } from "@grasp-os/open-workflow/generate";
import { readAppManifest } from "@grasp-os/sdk/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalText } from "@grasp-os/shared/json";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { setCurrentVersion } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { exportAppDefinition } from "../src/definition-export.ts";
import { grantApprover } from "../src/dependencies/approvers.ts";
import { policyGeneration } from "../src/dependencies/policy.ts";
import { decideDependency } from "../src/dependencies/requests.ts";
import { resolveDependencies } from "../src/packages/resolve.ts";
import { loadWorkflowBuild } from "../src/workflow-builds.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { sealPackages } from "../src/workflows/sealed-packages.ts";
import { publish } from "./npm.ts";
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

/** A definition of `name` that answers `total` of [1, 2, 3] as its status. */
const computingDefinitionOf = (name: string): string =>
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
            total: { kind: "compute", contract: "local:code/total.ts#total" },
          },
        },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      {
        add: {
          call: "grasp.compute",
          with: { binding: "total", arguments: "${ [1, 2, 3] }" },
        },
      },
      { answer: { set: { status: "${ tostring }" } } },
    ],
  });

/** A calculation doubling the sum with `pkg`'s `double`. */
const moduleUsing = (
  pkg: string
): string => `import { compute, v } from "@grasp-os/sdk/compute";
import { double } from ${JSON.stringify(pkg)};

export const total = compute({
  input: v.array(v.number().integer().min(0)).max(100),
  output: v.number().integer().min(0),
  handler: (amounts) => double(amounts.reduce((all, amount) => all + amount, 0)),
});
`;

/** `by`'s request for workflow `id`'s packages `dependencies`, approved by `admin`. */
const approvedFor = async (
  by: Acting,
  admin: Identity,
  id: string,
  intent: { dependencies: Record<string, string>; entries?: string[] }
) => {
  const { request } = await resolveDependencies(env, by, {
    workflow: id,
    sourceRevision: "rev-1",
    purpose: "Double the quarter's total.",
    targets: ["computation"],
    ...intent,
  });
  await decideDependency(env, admin, request.id, {
    approved: true,
    reviewed: {
      graphHash: request.graphHash,
      policyGeneration: await policyGeneration(drizzle(env.DB)),
    },
  });
  return request.graphHash;
};

/**
 * An App whose current release binds `followUp` to a workflow version
 * sealing an approved package, its licence `license`.
 */
const appSealingPackage = async (license: string) => {
  const fixture = await appWith(files(), "Requests");
  const { owner, app } = fixture;
  const admin = await person("admin");
  await grantApprover(env, admin, { type: "person", userId: admin.userId });
  const pkg = `double-${unique()}`;
  await publish({
    name: pkg,
    version: "1.0.0",
    manifest: { type: "module", main: "index.js", license },
    files: { "index.js": "export const double = (value) => value * 2;" },
  });
  const workflow = await createWorkflowResource(env, owner, `p-${unique()}`);
  const graphHash = await approvedFor(owner, admin, workflow.id, {
    dependencies: { [pkg]: "^1.0.0" },
  });
  await publishWorkflowVersion(
    env,
    owner,
    workflow.id,
    {
      definition: computingDefinitionOf(workflow.name),
      basedOn: null,
      modules: { "code/total.ts": moduleUsing(pkg) },
      packages: { graphHash },
    },
    sealPackages
  );
  await bindWorkflowToApp(env, owner, workflow.id, {
    app,
    alias: "followUp",
    version: 1,
  });
  await seal(fixture);
  await setCurrentVersion(env, owner, app, 1);
  return { owner, app, admin, pkg, workflow, graphHash };
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
      workflowPackages: entry.packages,
    }).toStrictEqual({
      root: ["app", "formatVersion", "unresolved", "workflows"],
      app: [
        "bindings",
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
        "packages",
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
      workflowPackages: null,
    });
    // The source, and the registration the seal read from it, which the
    // SDK reads back as it was sealed.
    expect({
      files: keys(exported.app.files),
      manifest: canonicalText(readAppManifest(exported.app.manifest)),
    }).toStrictEqual({
      files: keys(files()),
      manifest: canonicalText(release.app),
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
      nested: { workflows: entry.workflows, bindings: entry.bindings },
    }).toStrictEqual({
      version: 1,
      manifestHash: release.manifestHash,
      bindings: { writer: "model" },
      workflows: { followUp: key, later: null, remind: key },
      // What the references type of each packaged one, never of the
      // unbound alias.
      contracts: {
        followUp: { events: {}, listens: {}, decisions: {} },
        remind: { events: {}, listens: {}, decisions: {} },
      },
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

  it("carries a version's approved packages, which publish again only once the graph is approved for the workflow publishing them", async () => {
    const { owner, app, admin, pkg, workflow, graphHash } =
      await appSealingPackage("MIT");

    const exported = await exportAppDefinition(env, owner, app);
    const entry =
      exported.workflows[`${workflowNamespace}/${workflow.name}/1.0.0`];
    const packages = entry?.packages;
    if (entry === undefined || packages === null || packages === undefined) {
      throw new Error("The version's packages weren't exported");
    }

    // Elsewhere, as an import would: another builder's workflow publishes
    // the exported definition and modules, under its own name.
    const builder = await person("builder");
    const copy = await createWorkflowResource(env, builder, `p-${unique()}`);
    const original = z
      .looseObject({ document: z.looseObject({}) })
      .parse(JSON.parse(entry.files["workflow.json"] ?? "{}"));
    const definition = JSON.stringify({
      ...original,
      document: { ...original.document, name: copy.name },
    });
    const modules = Object.fromEntries(
      Object.entries(entry.files).filter(([file]) => file.startsWith("code/"))
    );
    const publishCopy = async (sealing: string) =>
      await publishWorkflowVersion(
        env,
        builder,
        copy.id,
        {
          definition,
          basedOn: null,
          modules,
          packages: { graphHash: sealing },
        },
        sealPackages
      );
    // The exported graph is never taken as approved for another workflow.
    const unapproved = await outcome(publishCopy(packages.graphHash));
    // Asked for at the lock's exact versions, and approved anew.
    const asked = await approvedFor(builder, admin, copy.id, {
      dependencies: packages.lock?.direct ?? {},
      entries: [...packages.entries],
    });
    const republished = await publishCopy(asked);
    const loaded = await loadWorkflowBuild(
      env,
      copy.id,
      republished.version,
      republished.manifestHash
    );
    expect({
      packages: {
        ...packages,
        lock: packages.lock === null ? null : { direct: packages.lock.direct },
      },
      lockPinsNoBuild:
        packages.lock !== null && !("artifacts" in packages.lock),
      unapproved,
      sameGraph: asked === packages.graphHash,
      sealed: loaded.packages,
    }).toStrictEqual({
      packages: {
        graphHash,
        entries: [pkg],
        lock: { direct: { [pkg]: "1.0.0" } },
      },
      lockPinsNoBuild: true,
      unapproved: "dependency.approval_required",
      sameGraph: true,
      sealed: { graphHash },
    });
  });

  it("scans a version's packages for known secret formats like its files, naming the record and never the match", async () => {
    // Built here, so no file of the repository holds one.
    const token = ["ghp", "_", "Q".repeat(36)].join("");
    const { owner, app, workflow } = await appSealingPackage(token);
    const refused = await refusal(exportAppDefinition(env, owner, app));
    expect({
      refused: refusedSchema.parse(refused),
      echoed: JSON.stringify(refused).includes(token),
    }).toStrictEqual({
      refused: {
        code: "version.export_secret_found",
        details: {
          path: `workflows/${workflowNamespace}/${workflow.name}/1.0.0/packages`,
        },
      },
      echoed: false,
    });
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
