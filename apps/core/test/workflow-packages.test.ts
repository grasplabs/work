import { computePackagesFile, packageModuleName } from "@grasp-os/compiler";
import { v } from "@grasp-os/sdk";
import { jsonSchemaOf, schemaFromDescriptor } from "@grasp-os/sdk/host";
import type { AuditEvent } from "@grasp-os/shared/audit";
import type { ConnectorContract } from "@grasp-os/shared/connect";
import type { DependencyRequest } from "@grasp-os/shared/dependencies";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { grantApprover } from "../src/dependencies/approvers.ts";
import { policyGeneration } from "../src/dependencies/policy.ts";
import {
  decideDependency,
  dependencyImpact,
  endDependency,
} from "../src/dependencies/requests.ts";
import { buildDependencies } from "../src/packages/build.ts";
import { resolveDependencies } from "../src/packages/resolve.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { loadWorkflowBuild } from "../src/workflow-builds.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { compileModules } from "../src/workflow-modules.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import {
  requirePackagesAdmitted,
  sealPackages,
} from "../src/workflows/sealed-packages.ts";
import { endLiveResourceRuns, objectSchema } from "./json-workflow-apps.ts";
import { mailConnection } from "./mail-connection.ts";
import { noise, publish } from "./npm.ts";
import { racingDb } from "./racing-db.ts";
import { artifactKey } from "./sealed-apps.ts";
import { auditedDuring, outcome, refusal, unique } from "./sign-in.ts";

// Approved npm packages a version of an independent workflow seals for
// its compute modules (GRA-665, slice 3), from the threat model on the
// issue: modules import only the entries their version seals, from an
// approval in force for this workflow; the package's bytes are the
// version's own; and a graph revoked since refuses new starts and fails
// a run in flight at its next call, audited.

/** A member of the organization in `role`, as their session has them. */
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

/**
 * The most characters a version's packages may have in tests: the
 * deployment's lowered `workflowPackageChars` (vite.config.ts).
 */
const testPackageChars = 64 * 1024;

/** An admin who may approve packages. */
const approver = async (): Promise<Identity> => {
  const admin = await person("admin");
  await grantApprover(env, admin, { type: "person", userId: admin.userId });
  return admin;
};

/**
 * A grasp-workflow/1 document on input `{ who }` running `steps` through
 * `bindings`, ending with `{ status }`, its status `status`'s value.
 */
const documentOf = (
  bindings: Record<string, unknown>,
  steps: unknown[],
  status: string
): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    input: objectSchema({ who: { type: "string" } }),
    output: {
      schema: objectSchema({ status: { type: "string" } }),
      value: { status: { $expr: status } },
    },
    bindings,
    steps,
  });

/**
 * A definition that calls `total` on [1, 2, 3] and answers its result as
 * the status; with `linger`, it waits that long first.
 */
const definitionOf = (linger?: string): string =>
  documentOf(
    { total: { kind: "compute", contract: "local:code/total.ts#total" } },
    [
      ...(linger === undefined
        ? []
        : [{ id: "linger", type: "wait", for: linger }]),
      { id: "add", type: "do", binding: "total", arguments: [1, 2, 3] },
    ],
    '"" + steps.add.output'
  );

/**
 * A definition whose action `doubled` answers `pkg`'s `double` of 6,
 * after `linger`.
 */
const actionDefinitionOf = (linger: string): string =>
  documentOf(
    {
      doubled: { kind: "action", contract: "local:code/doubled.ts#doubled" },
    },
    [
      { id: "linger", type: "wait", for: linger },
      {
        id: "doubled",
        type: "do",
        binding: "doubled",
        arguments: { value: 6 },
      },
    ],
    "steps.doubled.output.status"
  );

/** An action answering `pkg`'s `double` of its value, using nothing. */
const actionUsing = (
  pkg: string
): string => `import { action, v } from "@grasp-os/sdk/action";
import { double } from ${JSON.stringify(pkg)};

export const doubled = action({
  args: { value: v.number() },
  returns: v.object({ status: v.string() }),
  uses: [],
  handler: async (_ctx, args) => ({ status: String(double(args.value)) }),
});
`;

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

const descriptorOf = (schema: { descriptor: unknown }): string =>
  JSON.stringify(schema.descriptor);

/** What `mail.send` takes and answers, as descriptors. */
const mailInput = descriptorOf(
  v.object({ to: v.string(), subject: v.string() })
);
const mailOutput = descriptorOf(v.object({ messageId: v.string() }));

const shapeText = (descriptor: string): string =>
  JSON.stringify(
    jsonSchemaOf(schemaFromDescriptor(descriptor).descriptor, { exact: true })
  );

/** `env`, its connect serving the `mail.send` contract for a connection. */
const servingMail = (): Env => {
  const contract: ConnectorContract = {
    contract: "composio.mail@1",
    actions: {
      send: {
        tool: "mail.send",
        readOnly: false,
        input: shapeText(mailInput),
        output: shapeText(mailOutput),
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

/** A permission `by` asks for and `admin` grants. */
const granted = async (
  by: Identity,
  admin: Identity,
  request: PermissionRequest
): Promise<string> => {
  const asked = await requestPermission(env, by, request, {
    app: async (named: string, role: "user" | "builder") =>
      await appFor(env, by, named, role),
    resource: async (ref, needed) => {
      await requireResourceRole(env, by, ref, needed);
    },
  });
  await grantPermission(env, admin, asked.id, { version: null });
  return asked.id;
};

/**
 * A definition whose action `notify` sends mail through its `mail`
 * binding, a connector of catalog contract `mailKey`.
 */
const mailingDefinitionOf = (mailKey: string): string =>
  documentOf(
    {
      notify: { kind: "action", contract: "local:code/notify.ts#notify" },
      mail: { kind: "connector", contract: mailKey },
    },
    [
      {
        id: "notify",
        type: "do",
        binding: "notify",
        arguments: { to: { $expr: "input.who" } },
      },
    ],
    "steps.notify.output.status"
  );

/** An action sending two mails, their subjects `pkg`'s `double` of 1 and 2. */
const mailingUsing = (
  pkg: string
): string => `import { action, resource, v } from "@grasp-os/sdk/action";
import { double } from ${JSON.stringify(pkg)};

export const notify = action({
  args: { to: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [resource.connector("mail", { operations: ["mail.send"] })],
  handler: async (ctx, args) => {
    await ctx.resources.mail.call("mail.send", { to: args.to, subject: String(double(1)) });
    await ctx.resources.mail.call("mail.send", { to: args.to, subject: String(double(2)) });
    return { status: "sent" };
  },
});
`;

/** Publishes `name`@`version`, exporting `double`, to the test registry. */
const publishDoubling = async (
  name: string,
  version: string,
  /** Code its module runs as it loads, before `double`. */
  prelude = "",
  /** Its exports, if any besides `main`. */
  exports?: Record<string, string>
) => {
  await publish({
    name,
    version,
    manifest: {
      type: "module",
      main: "index.js",
      license: "MIT",
      ...(exports === undefined ? {} : { exports }),
    },
    files: {
      "index.js": `${prelude}export const double = (value) => value * 2;`,
    },
  });
};

/** A package exporting `double`, published to the test registry. */
const doubling = async (): Promise<string> => {
  const name = `double-${unique()}`;
  await publishDoubling(name, "1.0.0");
  return name;
};

/** A workflow of a new builder's, and `pkg` resolved for it. */
const workflowWith = async (pkg: string, entries?: string[]) => {
  const builder = await person("builder");
  const workflow = await createWorkflowResource(env, builder, `p-${unique()}`);
  const { request } = await resolveDependencies(env, builder, {
    workflow: workflow.id,
    sourceRevision: "rev-1",
    purpose: "Double the quarter's total.",
    targets: ["computation"],
    dependencies: [{ name: pkg, range: "^1.0.0" }],
    ...(entries === undefined ? {} : { entries }),
  });
  return { builder, workflow, request };
};

const approve = async (by: Identity, request: DependencyRequest) => {
  await decideDependency(env, by, request.id, {
    approved: true,
    reviewed: {
      graphHash: request.graphHash,
      policyGeneration: await policyGeneration(drizzle(env.DB)),
    },
  });
};

/** Ends `request`'s graph as `ending` (`retired` or `revoked`), as `by`. */
const end = async (
  by: Identity,
  request: DependencyRequest,
  ending: "retired" | "revoked"
) => {
  const impact = await dependencyImpact(env, by, request.id);
  await endDependency(env, by, request.id, ending, {
    reviewed: {
      graphHash: request.graphHash,
      policyGeneration: impact.policyGeneration,
      approvalsDigest:
        ending === "retired"
          ? impact.endings.retire.digest
          : impact.endings.revoke.digest,
    },
    reason: "No longer wanted.",
  });
};

/** Publishes version 1 of `workflow` with `pkg` imported, sealing `graphHash`. */
const publishedWith = async (
  builder: Acting,
  workflow: { id: string; name: string },
  pkg: string,
  graphHash: string,
  linger?: string
) =>
  await publishWorkflowVersion(
    env,
    builder,
    workflow.id,
    {
      definition: definitionOf(linger),
      basedOn: null,
      modules: { "code/total.ts": moduleUsing(pkg) },
      packages: { graphHash },
    },
    sealPackages
  );

/** Starts version 1 of `workflow` for `by`: its run's ID. */
const started = async (by: Acting, id: string): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, input: { who: "Ada" }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  return runId;
};

/** How run `runId` of `id` ended. */
const ended = async (by: Acting, id: string, runId: string) => {
  const run = await vi.waitFor(
    async () => {
      const found = await resourceRunFor(env, by, id, runId);
      expect(found.endedAt).not.toBeNull();
      return found;
    },
    { timeout: 30_000, interval: 100 }
  );
  return run.status === "completed"
    ? { status: run.status, output: run.output }
    : { status: run.status, code: run.error?.code };
};

const outcomesOf = (events: AuditEvent[], actions: readonly string[]) =>
  events
    .filter(({ action }) => actions.includes(action))
    .map(({ action, detail }) => ({
      action,
      reason: detail.reason ?? null,
      failureCode: detail.failureCode ?? null,
    }));

/**
 * A run of a workflow of a new builder's whose action, importing an
 * approved package, sends two mails, the first held at the mail server
 * until the graph is ended as `ending` (`retired` or `revoked`): how the
 * run ended, what the server did, and what was audited meanwhile.
 */
const mailedThroughEnding = async (ending: "retired" | "revoked") => {
  const admin = await approver();
  const pkg = await doubling();
  const { builder, workflow, request } = await workflowWith(pkg);
  await approve(admin, request);
  const mailKey = `mail-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: mailKey,
    kind: "connector",
    operations: { "mail.send": { input: mailInput, output: mailOutput } },
  });
  await publishWorkflowVersion(
    env,
    builder,
    workflow.id,
    {
      definition: mailingDefinitionOf(mailKey),
      basedOn: null,
      modules: { "code/notify.ts": mailingUsing(pkg) },
      packages: { graphHash: request.graphHash },
    },
    sealPackages
  );
  // The first mail is held at the server until the graph is ended.
  const mail = await mailConnection(["slow"]);
  const permissionId = await granted(builder, admin, {
    subject: { type: "workflow", workflowId: workflow.id },
    object: { type: "connection", connectionId: mail.id },
    actions: ["mail.send"],
    binding: `MAIL_${unique().toUpperCase().replaceAll("-", "_")}`,
  });
  // Connect serves the contract as the approval and the start check it.
  const serving = servingMail();
  await approveWorkflowBinding(serving, admin, workflow.id, {
    alias: "mail",
    target: { kind: "connector", permissionId, contract: "composio.mail@1" },
    reviewed: { version: 1 },
  });
  const { runId } = await startWorkflow(
    serving,
    { type: "person", person: builder },
    workflow.id,
    { version: 1, input: { who: "Ada" }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  let run: Awaited<ReturnType<typeof ended>> | undefined;
  const events = await auditedDuring(async () => {
    try {
      await vi.waitFor(
        async () => {
          await expect(mail.holding()).resolves.toBeTruthy();
        },
        { timeout: 30_000, interval: 100 }
      );
      await end(admin, request, ending);
    } finally {
      // Released whatever the wait saw, so no call stays held.
      await mail.release();
    }
    run = await ended(builder, workflow.id, runId);
  });
  return { run, server: await mail.did(), events };
};

describe("a workflow's modules importing approved packages", () => {
  // A run still asleep would go on in the engine after its test.
  afterEach(endLiveResourceRuns);

  it("seals the approved package into the version and runs it", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);

    const version = await publishedWith(
      builder,
      workflow,
      pkg,
      request.graphHash
    );
    const build = await loadWorkflowBuild(env, workflow.id, version.version);
    const run = await ended(
      builder,
      workflow.id,
      await started(builder, workflow.id)
    );

    expect({
      sealed: build.packages,
      module: Object.hasOwn(build.compute.modules, packageModuleName(pkg)),
      run,
    }).toStrictEqual({
      sealed: { graphHash: request.graphHash },
      module: true,
      run: { status: "completed", output: { status: "12" } },
    });
  });

  it("imports no package its version doesn't seal from an approval in force", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    const refusedFor = async ({
      packages,
      sealer = sealPackages,
    }: {
      packages?: { graphHash: string };
      sealer?: typeof sealPackages | null;
    } = {}) =>
      await outcome(
        publishWorkflowVersion(
          env,
          builder,
          workflow.id,
          {
            definition: definitionOf(),
            basedOn: null,
            modules: { "code/total.ts": moduleUsing(pkg) },
            ...(packages === undefined ? {} : { packages }),
          },
          sealer ?? undefined
        )
      );

    const unapproved = await refusedFor({
      packages: { graphHash: request.graphHash },
    });
    await approve(admin, request);
    const refused = {
      unapproved,
      unsealed: await refusedFor(),
      otherGraph: await refusedFor({ packages: { graphHash: "f".repeat(64) } }),
      noSealer: await refusedFor({
        packages: { graphHash: request.graphHash },
        sealer: null,
      }),
    };
    // Built and pinned while approved: what a retired graph keeps, and
    // still nothing a new version may seal.
    await buildDependencies(env, builder, {
      workflow: workflow.id,
      graphHash: request.graphHash,
      target: "computation",
      policyGeneration: await policyGeneration(drizzle(env.DB)),
    });
    await end(admin, request, "retired");

    expect({
      ...refused,
      retired: await refusedFor({ packages: { graphHash: request.graphHash } }),
    }).toStrictEqual({
      unapproved: "dependency.approval_required",
      unsealed: "workflow.modules_invalid",
      otherGraph: "dependency.approval_required",
      noSealer: "workflow.packages_invalid",
      retired: "dependency.retired",
    });
  });

  it("keeps running what a retired graph sealed", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    await publishedWith(builder, workflow, pkg, request.graphHash);
    await end(admin, request, "retired");

    await expect(
      ended(builder, workflow.id, await started(builder, workflow.id))
    ).resolves.toStrictEqual({ status: "completed", output: { status: "12" } });
  });

  it("refuses a new start once the graph is revoked, audited", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    await publishedWith(builder, workflow, pkg, request.graphHash);
    await end(admin, request, "revoked");

    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await outcome(started(builder, workflow.id));
    });

    expect({
      refused,
      audited: outcomesOf(events, ["workflow.start.refused"]),
    }).toStrictEqual({
      refused: "workflow.packages_revoked",
      audited: [
        {
          action: "workflow.start.refused",
          reason: "workflow.packages_revoked",
          failureCode: null,
        },
      ],
    });
  });

  it("refuses a start whose graph is revoked as it is admitted", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    await publishedWith(builder, workflow, pkg, request.graphHash);
    let raced = false;
    // The start's first batch is the one that admits it: revoked just before.
    const db = racingDb(async () => {
      if (!raced) {
        raced = true;
        await end(admin, request, "revoked");
      }
    });

    const refused = await outcome(
      startWorkflow(
        { ...env, DB: db },
        { type: "person", person: builder },
        workflow.id,
        { version: 1, input: { who: "Ada" }, key: unique() }
      )
    );
    const { results } = await env.DB.prepare(
      "SELECT id FROM workflow_resource_runs WHERE workflow_resource_id = ?"
    )
      .bind(workflow.id)
      .all();

    expect({ raced, refused, runs: results.length }).toStrictEqual({
      raced: true,
      refused: "workflow.packages_revoked",
      runs: 0,
    });
  });

  it("fails a run in flight at its next compute call once the graph is revoked, audited", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    // It waits a few seconds before its calculation: revoked meanwhile.
    await publishedWith(builder, workflow, pkg, request.graphHash, "3 seconds");
    const runId = await started(builder, workflow.id);

    let run: Awaited<ReturnType<typeof ended>> | undefined;
    const events = await auditedDuring(async () => {
      await end(admin, request, "revoked");
      run = await ended(builder, workflow.id, runId);
    });

    expect({
      run,
      audited: outcomesOf(events, [
        "dependency.admission_refused",
        "workflow.run.failed",
      ]),
    }).toStrictEqual({
      run: { status: "failed", code: "workflow.packages_revoked" },
      audited: [
        {
          action: "dependency.admission_refused",
          reason: "revoked",
          failureCode: null,
        },
        {
          action: "workflow.run.failed",
          reason: null,
          failureCode: "workflow.packages_revoked",
        },
      ],
    });
  });

  it("refuses to run a version whose sealed package bytes were changed", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    await publishedWith(builder, workflow, pkg, request.graphHash);
    const row = await env.DB.prepare(
      "SELECT manifest FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
    )
      .bind(workflow.id)
      .first<{ manifest: string }>();
    const { artifacts } = z
      .object({
        build: z.object({
          artifacts: z.array(
            z.object({ path: z.string(), sha256: z.string() })
          ),
        }),
      })
      .parse(JSON.parse(row?.manifest ?? "{}")).build;
    const sealed = artifacts.find(
      ({ path }) => path === `compute/${packageModuleName(pkg)}`
    );
    await env.FILES.put(
      await artifactKey(sealed?.sha256 ?? ""),
      "export const double = (value) => value * 3;"
    );

    expect({
      sealed: sealed !== undefined,
      run: await ended(
        builder,
        workflow.id,
        await started(builder, workflow.id)
      ),
    }).toStrictEqual({
      sealed: true,
      run: { status: "failed", code: "workflow.version_corrupt" },
    });
  });

  it("takes the same modules sealing another graph for another publication", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    await publishedWith(builder, workflow, pkg, request.graphHash);
    // Another graph of the same entry: its next version, resolved anew once
    // the first is revoked.
    await end(admin, request, "revoked");
    await publishDoubling(pkg, "1.0.1");
    const { request: next } = await resolveDependencies(env, builder, {
      workflow: workflow.id,
      sourceRevision: "rev-2",
      purpose: "Double the quarter's total.",
      targets: ["computation"],
      dependencies: [{ name: pkg, range: "^1.0.0" }],
    });
    await approve(admin, next);

    // The same document and modules on another graph: a version of its
    // own, never the first one answered again.
    const republished = await publishWorkflowVersion(
      env,
      builder,
      workflow.id,
      {
        definition: definitionOf(),
        basedOn: 1,
        modules: { "code/total.ts": moduleUsing(pkg) },
        packages: { graphHash: next.graphHash },
      },
      sealPackages
    );

    expect({
      otherGraph: next.graphHash !== request.graphHash,
      republished: republished.version,
    }).toStrictEqual({
      otherGraph: true,
      republished: 2,
    });
  });

  it("fails a run in flight at its next action once the graph is revoked", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    await publishWorkflowVersion(
      env,
      builder,
      workflow.id,
      {
        definition: actionDefinitionOf("3 seconds"),
        basedOn: null,
        modules: { "code/doubled.ts": actionUsing(pkg) },
        packages: { graphHash: request.graphHash },
      },
      sealPackages
    );
    const runId = await started(builder, workflow.id);
    await end(admin, request, "revoked");

    await expect(ended(builder, workflow.id, runId)).resolves.toStrictEqual({
      status: "failed",
      code: "workflow.packages_revoked",
    });
  });

  it("makes no call more of an action whose graph is revoked while it runs, audited", async () => {
    const { run, server, events } = await mailedThroughEnding("revoked");

    expect({
      run,
      // The mail sent before the revocation, and none after.
      server,
      audited: outcomesOf(events, [
        "dependency.admission_refused",
        "workflow.run.failed",
      ]),
    }).toStrictEqual({
      run: { status: "failed", code: "workflow.packages_revoked" },
      server: { calls: 1, sent: [{ to: "Ada", subject: "2" }] },
      audited: [
        {
          action: "dependency.admission_refused",
          reason: "revoked",
          failureCode: null,
        },
        {
          action: "workflow.run.failed",
          reason: null,
          failureCode: "workflow.packages_revoked",
        },
      ],
    });
  });

  it("keeps making the calls of an action whose graph is retired while it runs", async () => {
    const { run, server, events } = await mailedThroughEnding("retired");

    // What a retired graph sealed keeps running, as a compute call's does.
    expect({
      run,
      server,
      refused: outcomesOf(events, ["dependency.admission_refused"]),
    }).toStrictEqual({
      run: { status: "completed", output: { status: "sent" } },
      server: {
        calls: 2,
        sent: [
          { to: "Ada", subject: "2" },
          { to: "Ada", subject: "4" },
        ],
      },
      refused: [],
    });
  });

  it("refuses package code that reads the clock or randomness as it loads", async () => {
    const admin = await approver();
    const refusals: string[] = [];
    for (const prelude of [
      "export const at = Date.now();\n",
      "export const roll = Math.random();\n",
    ]) {
      const pkg = `double-${unique()}`;
      // oxlint-disable-next-line no-await-in-loop -- one package at a time
      await publishDoubling(pkg, "1.0.0", prelude);
      // oxlint-disable-next-line no-await-in-loop -- as above
      const { builder, workflow, request } = await workflowWith(pkg);
      // oxlint-disable-next-line no-await-in-loop -- as above
      await approve(admin, request);
      refusals.push(
        // oxlint-disable-next-line no-await-in-loop -- as above
        await outcome(publishedWith(builder, workflow, pkg, request.graphHash))
      );
    }

    expect(refusals).toStrictEqual([
      "workflow.modules_invalid",
      "workflow.modules_invalid",
    ]);
  });

  it("seals nothing for Grasp staff, nor another workflow's approved graph", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const theirs = await workflowWith(pkg);
    await approve(admin, theirs.request);
    const { builder, workflow, request } = await workflowWith(pkg);
    // Staff with an admin's role in the workflow, as staff sessions carry.
    const staff: Acting = { ...builder, role: "admin", staff: true };
    await approve(admin, request);

    expect({
      // The same graph by its hash, approved only for the other workflow.
      sameGraph: theirs.request.graphHash === request.graphHash,
      staff: await outcome(
        publishedWith(staff, workflow, pkg, request.graphHash)
      ),
    }).toStrictEqual({ sameGraph: true, staff: "role.forbidden" });
    // Their approval admits nothing for a workflow that never had one.
    const other = await person("builder");
    const unrelated = await createWorkflowResource(env, other, `u-${unique()}`);
    await expect(
      outcome(publishedWith(other, unrelated, pkg, theirs.request.graphHash))
    ).resolves.toBe("dependency.approval_required");
  });

  it("refuses packages larger than a version holds", async () => {
    const admin = await approver();
    const pkg = `double-${unique()}`;
    await publishDoubling(
      pkg,
      "1.0.0",
      `export const blob = ${JSON.stringify(noise(testPackageChars + 1024))};\n`
    );
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);

    await expect(
      outcome(publishedWith(builder, workflow, pkg, request.graphHash))
    ).resolves.toBe("workflow.packages_invalid");
  });

  it("seals and runs a package whose name has a ~, apart from one with a /", async () => {
    const admin = await approver();
    const pkg = `dou~ble-${unique()}`;
    await publishDoubling(pkg, "1.0.0");
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    await publishedWith(builder, workflow, pkg, request.graphHash);

    expect({
      apart: packageModuleName("a~b") !== packageModuleName("a/b"),
      run: await ended(
        builder,
        workflow.id,
        await started(builder, workflow.id)
      ),
    }).toStrictEqual({
      apart: true,
      run: { status: "completed", output: { status: "12" } },
    });
  });

  it("answers a start admitted before the graph was revoked when it is asked again", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    await publishedWith(builder, workflow, pkg, request.graphHash);
    const key = unique();
    const asked = async () =>
      await startWorkflow(
        env,
        { type: "person", person: builder },
        workflow.id,
        { version: 1, input: { who: "Ada" }, key }
      );
    const first = await asked();
    await end(admin, request, "revoked");

    const again = await asked();
    const fresh = await outcome(started(builder, workflow.id));

    expect({ same: again.runId === first.runId, fresh }).toStrictEqual({
      same: true,
      fresh: "workflow.packages_revoked",
    });
  });

  it("loads no package module its manifest doesn't seal", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    await publishedWith(builder, workflow, pkg, request.graphHash);
    const row = await env.DB.prepare(
      "SELECT manifest FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
    )
      .bind(workflow.id)
      .first<{ manifest: string }>();
    const manifest = z
      .object({
        packages: z
          .object({ entries: z.record(z.string(), z.string()) })
          .catchall(z.json()),
      })
      .catchall(z.json())
      .parse(JSON.parse(row?.manifest ?? "{}"));
    // A version beside it whose manifest no longer seals what the same
    // build holds (versions never change, so a new row): the build's own
    // modules unchanged, a package module among them it doesn't seal.
    let next = 1;
    const rewritten = async (changed: Record<string, Json>) => {
      next += 1;
      const text = canonicalJson(changed);
      const { results: columns } = await env.DB.prepare(
        "SELECT name FROM pragma_table_info('workflow_resource_versions') WHERE name NOT IN ('version', 'definition_version', 'manifest', 'manifest_hash')"
      ).all<{ name: string }>();
      const rest = columns.map(({ name }) => name).join(", ");
      await env.DB.prepare(
        `INSERT INTO workflow_resource_versions (version, definition_version, manifest, manifest_hash, ${rest}) SELECT ?, ?, ?, ?, ${rest} FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1`
      )
        .bind(next, `1.0.${next}`, text, await sha256Hex(text), workflow.id)
        .run();
      return await outcome(loadWorkflowBuild(env, workflow.id, next));
    };
    const { packages, ...unsealed } = manifest;

    expect({
      noEntries: await rewritten({
        ...manifest,
        packages: { ...packages, entries: {} },
      }),
      noPackages: await rewritten(unsealed),
    }).toStrictEqual({
      noEntries: "workflow.version_corrupt",
      noPackages: "workflow.version_corrupt",
    });
  });

  it("tries a call again, not fails it, while the policy keeps changing as it is read", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    // Every read of the policy finds it moved on since the last, while
    // the call runs: what it leaves to finish after (its audit) doesn't.
    let racing = true;
    const db = racingDb(async (real) => {
      if (!racing) {
        return;
      }
      await real
        .prepare(
          "INSERT INTO dependency_policy (id, generation) VALUES ('policy', 1) ON CONFLICT(id) DO UPDATE SET generation = generation + 1"
        )
        .run();
    });

    const answered = await outcome(
      requirePackagesAdmitted(
        { ...env, DB: db },
        workflow.id,
        request.graphHash
      )
    );
    racing = false;

    expect(answered).not.toBe("workflow.packages_revoked");
    expect(answered).toContain("couldn't be read");
  });

  it("imports an entry whose subpath takes it past a package name's length", async () => {
    const admin = await approver();
    const pkg = `double-${unique()}`;
    // A subpath as long as an entry may be, past 214 characters together.
    const subpath = "d".repeat(250 - pkg.length);
    const entry = `${pkg}/${subpath}`;
    await publishDoubling(pkg, "1.0.0", "", {
      ".": "./index.js",
      [`./${subpath}`]: "./index.js",
    });
    const { builder, workflow, request } = await workflowWith(pkg, [entry]);
    await approve(admin, request);
    await publishedWith(builder, workflow, entry, request.graphHash);

    expect({
      long: entry.length > 214,
      run: await ended(
        builder,
        workflow.id,
        await started(builder, workflow.id)
      ),
    }).toStrictEqual({
      long: true,
      run: { status: "completed", output: { status: "12" } },
    });
  });

  it("writes no version whose graph was retired as it was published", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    // Built before, so publishing writes nothing of its own until the
    // version's batch.
    await buildDependencies(env, builder, {
      workflow: workflow.id,
      graphHash: request.graphHash,
      target: "computation",
      policyGeneration: await policyGeneration(drizzle(env.DB)),
    });
    let sealed = false;
    let raced = false;
    // Once its packages are sealed, the graph is retired before anything
    // else the publication writes lands.
    const db = racingDb(async () => {
      if (sealed && !raced) {
        raced = true;
        await end(admin, request, "retired");
      }
    });
    const sealing: typeof sealPackages = async (...args) => {
      const done = await sealPackages(...args);
      sealed = true;
      return done;
    };

    const refused = await outcome(
      publishWorkflowVersion(
        { ...env, DB: db },
        builder,
        workflow.id,
        {
          definition: definitionOf(),
          basedOn: null,
          modules: { "code/total.ts": moduleUsing(pkg) },
          packages: { graphHash: request.graphHash },
        },
        sealing
      )
    );
    const { results } = await env.DB.prepare(
      "SELECT version FROM workflow_resource_versions WHERE workflow_resource_id = ?"
    )
      .bind(workflow.id)
      .all();

    expect({ raced, refused, versions: results.length }).toStrictEqual({
      raced: true,
      refused: "dependency.retired",
      versions: 0,
    });
  });

  it("says a start refused as its packages are revoked mid-decision was refused for them", async () => {
    const admin = await approver();
    const pkg = await doubling();
    const { builder, workflow, request } = await workflowWith(pkg);
    await approve(admin, request);
    await publishedWith(builder, workflow, pkg, request.graphHash);
    let raced = false;
    // The graph is revoked just before the decision's last read of what
    // holds (the one naming the pinned version).
    const real = env.DB;
    const db = new Proxy(real, {
      get: (target, property) => {
        if (property !== "prepare") {
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function"
            ? (...args: unknown[]): unknown =>
                Reflect.apply(value, target, args)
            : value;
        }
        return (query: string) => {
          const statement = target.prepare(query);
          if (raced || !query.includes("AS pinned")) {
            return statement;
          }
          return new Proxy(statement, {
            get: (inner, name) => {
              const value: unknown = Reflect.get(inner, name);
              if (typeof value !== "function") {
                return value;
              }
              if (name === "bind") {
                return (...values: unknown[]) => {
                  const bound = inner.bind(...values);
                  return new Proxy(bound, {
                    get: (boundTarget, method) => {
                      const run: unknown = Reflect.get(boundTarget, method);
                      if (typeof run !== "function") {
                        return run;
                      }
                      return async (...args: unknown[]): Promise<unknown> => {
                        if (!raced) {
                          raced = true;
                          await end(admin, request, "revoked");
                        }
                        return await Reflect.apply(run, boundTarget, args);
                      };
                    },
                  });
                };
              }
              return (...args: unknown[]): unknown =>
                Reflect.apply(value, inner, args);
            },
          });
        };
      },
    });

    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await outcome(
        startWorkflow(
          { ...env, DB: db },
          { type: "person", person: builder },
          workflow.id,
          { version: 1, input: { who: "Ada" }, key: unique() }
        )
      );
    });

    expect({
      raced,
      refused,
      audited: outcomesOf(events, ["workflow.start.refused"]),
    }).toStrictEqual({
      raced: true,
      refused: "workflow.packages_revoked",
      audited: [
        {
          action: "workflow.start.refused",
          reason: "workflow.packages_revoked",
          failureCode: null,
        },
      ],
    });
  });

  it("takes no list of packages from a workflow's own files", async () => {
    const pkg = await doubling();
    const builder = await person("builder");
    const workflow = await createWorkflowResource(
      env,
      builder,
      `p-${unique()}`
    );

    const refused = z
      .object({
        code: z.string(),
        details: z.object({
          diagnostics: z.array(z.object({ message: z.string() })),
        }),
      })
      .parse(
        await refusal(
          compileModules(
            env,
            {
              "code/total.ts": moduleUsing(pkg),
              [computePackagesFile]: JSON.stringify([pkg]),
            },
            workflow.id
          )
        )
      );

    // Refused as it is built, the import itself: never taken as approved.
    expect({
      code: refused.code,
      importRefused: refused.details.diagnostics.some(({ message }) =>
        message.includes("can't be imported here")
      ),
    }).toStrictEqual({ code: "workflow.modules_invalid", importRefused: true });
  });
});
