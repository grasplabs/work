/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import {
  AppError,
  app as registerApp,
  defineSchema,
  defineTable,
  resource,
  v,
} from "@grasp-os/sdk";
import { inspectApp, manifestText, schemaHash } from "@grasp-os/sdk/host";
import { runFunction } from "@grasp-os/sdk/runner";
import type { OperationChannel } from "@grasp-os/sdk/runner";
import { serverModule } from "@grasp-os/sdk/server";
import {
  releaseFormatVersion,
  releaseManifestSchema,
  sdkProtocolVersion,
} from "@grasp-os/shared/app-releases";
import { sha256Hex } from "@grasp-os/shared/encoding";
import {
  appIdSchema,
  chatIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalText } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import type { Authority } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  maxLiveRunsPerPrincipal,
  workflowNamespace,
} from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { invocationFor } from "../src/app-functions.ts";
import type { Release } from "../src/app-releases.ts";
import {
  bindWorkflowToApp,
  unbindWorkflowFromApp,
} from "../src/app-workflow-bindings.ts";
import { appFor } from "../src/apps.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { appHost } from "../src/durable-objects.ts";
import { callOperation } from "../src/operations.ts";
import type { HostedApp, Runner } from "../src/operations.ts";
import { defaultMaxAttempts } from "../src/outbox-delivery.ts";
import type { OutboxConsumer } from "../src/outbox-delivery.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { StoreHost } from "../src/store-host.ts";
import { setWorkflowParams } from "../src/workflow-params.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import {
  appWorkflowStarts,
  dispatchStartIntent,
} from "../src/workflow-start-intents.ts";
import type { CallingAgent } from "../src/workflow-start-intents.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { racingDb } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { outcome, unique } from "./sign-in.ts";

// Starting independent workflows from an App's server functions
// (operations.ts, workflow-start-intents.ts): an action's
// `ctx.startWorkflow` and a mutation's `ctx.afterCommit.start`, from
// their threat model. App code runs as the SDK's runner runs it, against
// a real business store, its real outbox and the real start path; a
// "rogue" runner stands for App code talking to its channel directly.

const schema = defineSchema({ requests: defineTable({ title: v.string() }) });

const { query, mutation, action } = serverModule(schema);

/** The workflow the App declares, by the alias its builders bind. */
const followUp = resource.workflow("followUp", {
  input: v.object({ who: v.string().trim().min(1) }),
});

const handleSchema = v.object({
  startId: v.string(),
  runId: v.string().nullable(),
  version: v.number().integer(),
});

const list = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const requests = await ctx.db.query("requests").collect();
    return requests.length;
  },
});

/** Records a request, and has the follow-up started once it commits. */
const submit = mutation({
  args: { who: v.string(), fail: v.boolean().default(false) },
  returns: v.id("requests"),
  uses: [followUp],
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("requests", { title: args.who });
    await ctx.afterCommit.start(followUp, { who: args.who });
    if (args.fail) {
      throw new AppError("desk.refused", "The request was refused.");
    }
    return id;
  },
});

/** Stages a start, then a write whose revision guard can't hold. */
const guarded = mutation({
  args: { id: v.id("requests") },
  returns: v.null(),
  uses: [followUp],
  handler: async (ctx, args) => {
    await ctx.afterCommit.start(followUp, { who: "Guarded" });
    await ctx.db.patch(
      "requests",
      args.id,
      { title: "changed" },
      { expectedRevision: 99 }
    );
    return null;
  },
});

/** Starts the follow-up now. */
const kickOff = action({
  args: { who: v.string() },
  returns: handleSchema,
  uses: [followUp],
  handler: async (ctx, args) =>
    await ctx.startWorkflow(followUp, { who: args.who }),
});

/** An action and a mutation that list no workflow, for rogue code. */
const plainAction = action({
  args: {},
  returns: v.string(),
  handler: () => "plain",
});
/** Stages more starts than a commit may hold, past every refusal. */
const flood = mutation({
  args: {},
  returns: v.number(),
  uses: [followUp],
  handler: async (ctx) => {
    let refused = 0;
    for (let index = 0; index < 40; index += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one start after the other
        await ctx.afterCommit.start(followUp, { who: `n${index}` });
      } catch {
        refused += 1;
      }
    }
    return refused;
  },
});

/**
 * Stages starts whose inputs, each within its own bound, together take
 * more than a commit holds, past every refusal: how many were refused.
 */
const bulky = mutation({
  args: {},
  returns: v.number(),
  uses: [followUp],
  handler: async (ctx) => {
    let refused = 0;
    for (let index = 0; index < 9; index += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one start after the other
        await ctx.afterCommit.start(followUp, {
          who: `${index}`.padEnd(120 * 1024, "x"),
        });
      } catch {
        refused += 1;
      }
    }
    return refused;
  },
});

const plainMutation = mutation({
  args: {},
  returns: v.string(),
  handler: () => "plain",
});

const startsApp = registerApp({
  name: "Requests",
  schema,
  access: { tables: { requests: { read: "appMembers", write: "appMembers" } } },
  operations: {
    requests: {
      list,
      submit,
      guarded,
      kickOff,
      flood,
      bulky,
      plainAction,
      plainMutation,
    },
  },
  screens: [],
  uses: [followUp],
});

const { manifest } = inspectApp(startsApp);

/** The code of an expected error, or what else it was. */
const codeOf = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : String(error);

/**
 * App code as the SDK's runner runs it, but for the `plain` functions,
 * which talk to their channel directly, as code in an isolate could:
 * each asks to start `alias` and answers what the host said.
 */
const runnerFor =
  (alias: string): Runner =>
  async (path, args, channel: OperationChannel) => {
    if (path === "requests.plainAction" || path === "requests.plainMutation") {
      return await channel.resource(alias, "start", [{ who: "Rogue" }]).then(
        () => "started",
        (error: unknown) => codeOf(error)
      );
    }
    return await runFunction(startsApp, path, args, channel);
  };

const hosted = (alias = "followUp"): HostedApp => ({
  manifest,
  run: runnerFor(alias),
});

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

/** A greeting workflow's definition, which waits an hour first if asked. */
const definitionOf = (name: string, waits: boolean): string =>
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
          params: {
            greeting: {
              schema: { type: "string", maxLength: 200 },
              label: "Greeting",
              default: "Hello",
              sensitive: false,
            },
          },
          bindings: {},
        },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      ...(waits ? [{ pause: { wait: "PT1H" } }] : []),
      {
        greet: {
          set: {
            status: '${ $params.greeting + ", " + $workflow.input.who }',
          },
        },
      },
    ],
  });

/** Version 1 of a workflow of `owner`'s. */
const workflowOf = async (owner: Identity, waits = false) => {
  const workflow = await createWorkflowResource(
    env,
    owner,
    `follow-up-${unique()}`
  );
  await publishWorkflowVersion(env, owner, workflow.id, {
    definition: definitionOf(workflow.name, waits),
    basedOn: null,
  });
  return workflow;
};

/** What `by` may hand a permission request: their App and resource roles. */
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

const zeros = "0".repeat(64);

/** The release manifest of version 1 of `app`, sealed. */
const sealedManifest = async (app: string) => {
  const parsed = releaseManifestSchema.parse({
    formatVersion: releaseFormatVersion,
    resourceId: app,
    resourceVersion: 1,
    sourceTreeHash: zeros,
    schemaHash: zeros,
    contractHash: zeros,
    sdkVersion: "1.0.0",
    sdkProtocolVersion,
    uiVersion: "1.0.0",
    compilerVersion: "1.0.0",
    dependencyLockHash: zeros,
    target: "app",
    dataStoreBindings: [],
    artifacts: [{ path: "server.js", sha256: zeros, bytes: 0 }],
    bindings: [],
    verificationReportHash: zeros,
    migrationEvidence: [],
    artifactTrust: "unreviewed",
  });
  const text = canonicalText(parsed);
  const hash = await sha256Hex(text);
  await env.DB.prepare(
    "INSERT INTO sdk_release_manifests (app_id, version, manifest_hash, manifest, sealed_at, revoked_at) VALUES (?, 1, ?, ?, ?, NULL)"
  )
    .bind(app, hash, text, Date.now())
    .run();
  return { parsed, hash };
};

interface Fixture {
  readonly admin: Identity;
  /** Builds the App and the workflow. */
  readonly ada: Identity;
  /** Uses the App; has no role in the workflow. */
  readonly bob: Identity;
  readonly app: AppId;
  readonly workflowId: string;
  readonly permissionId: string;
  readonly bindingId: string;
  readonly store: OpenStore;
  readonly release: Release;
}

/**
 * Ada's App, version 1 approved and sealed, with its store; her workflow
 * bound to it as `followUp`; the App's `start` on it, granted by an
 * admin; and Bob, who uses the App and nothing else.
 */
const fixture = async (waits = false): Promise<Fixture> => {
  const admin = await person("admin");
  const ada = await person("builder");
  const bob = await person("user");
  const app = appIdSchema.parse(crypto.randomUUID());
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Requests', '', ?, ?)"
    ).bind(app, ada.userId, Date.now()),
    env.DB.prepare(
      "INSERT INTO app_versions (app_id, version, tree, files, author_id, message, created_at, approved) VALUES (?, 1, 'tree', 0, ?, 'Version', ?, 1)"
    ).bind(app, ada.userId, Date.now()),
    env.DB.prepare(
      "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
    ).bind(app, bob.userId, ada.userId, Date.now()),
  ]);
  const sealed = await sealedManifest(app);
  const storeId = await createStore(env, ada);
  const store = await openStore(env, storeId);
  await store.defineTables(manifestText(manifest.schema));
  const workflow = await workflowOf(ada, waits);
  const binding = await bindWorkflowToApp(env, ada, workflow.id, {
    app,
    alias: "followUp",
    version: 1,
  });
  const asked = await requestPermission(
    env,
    ada,
    {
      subject: { type: "app", appId: app },
      object: { type: "workflow", workflowId: workflow.id },
      actions: ["start"],
      binding: "FOLLOW_UP",
    },
    rolesOf(ada)
  );
  await grantPermission(env, admin, asked.id, { version: null });
  return {
    admin,
    ada,
    bob,
    app,
    workflowId: workflow.id,
    permissionId: asked.id,
    bindingId: binding.id,
    store,
    release: {
      manifest: sealed.parsed,
      manifestHash: sealed.hash,
      app: manifest,
      fingerprints: {},
      modules: {},
      sdk: {},
      store: {
        alias: "requests",
        storeId,
        schemaVersion: 1,
        schemaHash: zeros,
        operationManifestHash: zeros,
      },
    },
  };
};

const kinds = {
  "requests.list": "query",
  "requests.submit": "mutation",
  "requests.guarded": "mutation",
  "requests.flood": "mutation",
  "requests.bulky": "mutation",
  "requests.kickOff": "action",
  "requests.plainAction": "action",
  "requests.plainMutation": "mutation",
} as const;

/** Calls `path` as `by` through the App's invocation, as a screen would. */
const call = async (
  fx: Fixture,
  by: Identity,
  path: keyof typeof kinds,
  args: Json,
  options: {
    key?: string;
    app?: HostedApp;
    agent?: CallingAgent;
    /** Counts each time the call's gate is passed through. */
    gate?: { passes: number };
  } = {}
): Promise<OperationResult> => {
  const invocation = await invocationFor(env, fx.release, {
    by,
    requestId: crypto.randomUUID(),
    deadline: Date.now() + 30_000,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
  });
  const { gate } = options;
  return await callOperation(
    options.app ?? hosted(),
    gate === undefined
      ? invocation
      : {
          ...invocation,
          authorize: async () => {
            gate.passes += 1;
            return await invocation.authorize();
          },
        },
    { path, kind: kinds[path] },
    args,
    options.key === undefined ? {} : { idempotencyKey: options.key }
  );
};

/** Whether `value` is a JSON object: `Array.isArray` doesn't narrow a readonly array. */
const isObject = (
  value: Json | undefined
): value is Readonly<Record<string, Json | undefined>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A field of a JSON object, or undefined. */
const field = (value: Json, key: string): Json | undefined =>
  isObject(value) ? value[key] : undefined;

/** What a call answered, or the code it failed with. */
const answerOf = (result: OperationResult): unknown =>
  result.ok ? result.value : result.error.code;

interface Receipt {
  id: string;
  invoker_type: string;
  invoker_id: string;
  principal_id: string;
  idempotency_key: string;
  origin_app_version: number | null;
}

/** The start receipts App `appId` made, oldest first. */
const receiptsOf = async (appId: string): Promise<Receipt[]> => {
  const { results } = await env.DB.prepare(
    "SELECT id, invoker_type, invoker_id, principal_id, idempotency_key, origin_app_version FROM workflow_start_receipts WHERE invoker_type = 'app' AND invoker_id = ? ORDER BY created_at, id"
  )
    .bind(appId)
    .all<Receipt>();
  return results;
};

const objectOf = (store: OpenStore) => env.DATA_STORES.getByName(store.id);

/** The store's outbox entries. */
const outboxOf = async (
  store: OpenStore
): Promise<
  {
    id: string;
    attempts: number;
    settled_at: number | null;
    undeliverable: string | null;
  }[]
> =>
  await runInDurableObject(objectOf(store), (_instance, state) =>
    state.storage.sql
      .exec<{
        id: string;
        attempts: number;
        settled_at: number | null;
        undeliverable: string | null;
      }>(
        "SELECT id, attempts, settled_at, undeliverable FROM sdk_change_outbox ORDER BY rowid"
      )
      .toArray()
  );

/** Drains the store's outbox with `consumer` taking its starts, at `at`. */
const drainWith = async (
  store: OpenStore,
  consumer: OutboxConsumer,
  at = Date.now()
): Promise<void> => {
  await runInDurableObject(objectOf(store), async (_instance, state) => {
    await new StoreHost(state, env).drainOutbox(
      { "workflow.start": consumer },
      { now: new Date(at) }
    );
  });
};

/** Run `runId` of the fixture's workflow, as an admin reads it, output included. */
const runOf = async (
  fx: Fixture,
  runId: string | null
): Promise<WorkflowResourceRun> =>
  await resourceRunFor(env, fx.admin, fx.workflowId, runId);

/** That run, once it has ended. */
const ended = async (
  fx: Fixture,
  runId: string | null
): Promise<WorkflowResourceRun> =>
  await vi.waitFor(
    async () => {
      const run = await runOf(fx, runId);
      expect(run.endedAt).not.toBeNull();
      return run;
    },
    { timeout: 30_000, interval: 100 }
  );

const hour = 3_600_000;

/** The outbox's entries as settled: whether they are, and as what. */
const settledOf = async (store: OpenStore) => {
  const entries = await outboxOf(store);
  return entries.map(({ settled_at, undeliverable }) => ({
    settled: settled_at !== null,
    undeliverable,
  }));
};

/** A dispatch that admits the start, then dies before it acknowledges. */
const killedDispatch: OutboxConsumer = async (entry) => {
  await dispatchStartIntent(env, entry);
  throw new Error("Killed before acknowledging");
};

/** The dispatch as the store's outbox runs it. */
const dispatch: OutboxConsumer = async (entry) =>
  await dispatchStartIntent(env, entry);

describe("an action starting a workflow", () => {
  it("resolves once the start is admitted, as the App for the person calling, and the same call again recovers the same start", async () => {
    const fx = await fixture(true);
    const key = `kick-${unique()}`;
    const first = await call(
      fx,
      fx.bob,
      "requests.kickOff",
      { who: "Bob" },
      { key }
    );
    // The reply was lost: the screen calls again under the same key.
    const again = await call(
      fx,
      fx.bob,
      "requests.kickOff",
      { who: "Bob" },
      { key }
    );
    const other = await call(fx, fx.bob, "requests.kickOff", { who: "Bob" });
    expect(first.ok && again.ok && other.ok).toBeTruthy();
    if (!(first.ok && again.ok && other.ok)) {
      return;
    }
    const handle = handleSchema["~standard"].validate(first.value);
    const { startId, runId } =
      "value" in handle ? handle.value : { startId: "", runId: null };
    const run = await runOf(fx, runId);
    const receipts = await receiptsOf(fx.app);
    expect({
      handle: { ok: "value" in handle, version: field(first.value, "version") },
      again: again.value,
      otherIsAnother:
        JSON.stringify(other.value) !== JSON.stringify(first.value),
      runIsTheStart: runId === startId,
      // Admitted and under way, not finished: it waits an hour.
      running: run.endedAt === null,
      receipts: receipts.map(
        ({ invoker_type, invoker_id, principal_id, origin_app_version }) => ({
          invoker_type,
          invoker_id,
          principal_id,
          origin_app_version,
        })
      ),
    }).toStrictEqual({
      handle: { ok: true, version: 1 },
      again: first.value,
      otherIsAnother: true,
      runIsTheStart: true,
      running: true,
      // Bob's, through the App: never Ada's, who owns the App and the
      // workflow, though Bob has no role in the workflow himself.
      receipts: [
        {
          invoker_type: "app",
          invoker_id: fx.app,
          principal_id: fx.bob.userId,
          origin_app_version: 1,
        },
        {
          invoker_type: "app",
          invoker_id: fx.app,
          principal_id: fx.bob.userId,
          origin_app_version: 1,
        },
      ],
    });
  });

  it("starts nothing without the App's own grant, its binding, or the caller's use of the App, and says only that it can't", async () => {
    const fx = await fixture();
    const eve = await person("user");
    const outsider = await call(fx, eve, "requests.kickOff", { who: "Eve" });
    await revokePermission(env, fx.admin, fx.permissionId);
    const ungranted = await call(fx, fx.bob, "requests.kickOff", {
      who: "Bob",
    });
    const regranted = await requestPermission(
      env,
      fx.ada,
      {
        subject: { type: "app", appId: fx.app },
        object: { type: "workflow", workflowId: fx.workflowId },
        actions: ["start"],
        binding: "FOLLOW_UP",
      },
      rolesOf(fx.ada)
    );
    await grantPermission(env, fx.admin, regranted.id, { version: null });
    await unbindWorkflowFromApp(env, fx.ada, fx.bindingId);
    const unbound = await call(fx, fx.bob, "requests.kickOff", { who: "Bob" });
    expect({
      outsider: answerOf(outsider),
      ungranted: answerOf(ungranted),
      unbound: answerOf(unbound),
      receipts: await receiptsOf(fx.app),
    }).toStrictEqual({
      // Eve may not use the App at all.
      outsider: "app.not_found",
      ungranted: "resource.unavailable",
      unbound: "resource.unavailable",
      receipts: [],
    });
  });

  it("refuses input the declaration doesn't take before anything starts", async () => {
    const fx = await fixture();
    const blank = await call(fx, fx.bob, "requests.kickOff", { who: "   " });
    expect({
      blank: answerOf(blank),
      receipts: await receiptsOf(fx.app),
    }).toStrictEqual({ blank: "contract.invalid_args", receipts: [] });
  });
});

describe("App code starting a workflow it didn't declare", () => {
  it("is refused by the host, whatever it sends, and starts nothing", async () => {
    const fx = await fixture();
    // Another workflow Ada binds to the App, which the App never declared.
    const other = await workflowOf(fx.ada);
    await bindWorkflowToApp(env, fx.ada, other.id, {
      app: fx.app,
      alias: "other",
      version: 1,
    });
    const asked = await requestPermission(
      env,
      fx.ada,
      {
        subject: { type: "app", appId: fx.app },
        object: { type: "workflow", workflowId: other.id },
        actions: ["start"],
        binding: "OTHER",
      },
      rolesOf(fx.ada)
    );
    await grantPermission(env, fx.admin, asked.id, { version: null });
    const rogue = async (
      path: "requests.plainAction" | "requests.plainMutation",
      alias: string
    ) => answerOf(await call(fx, fx.bob, path, {}, { app: hosted(alias) }));
    expect({
      // Declared by the App, but not listed by the function asking.
      actionUnlisted: await rogue("requests.plainAction", "followUp"),
      mutationUnlisted: await rogue("requests.plainMutation", "followUp"),
      // Bound and granted, but never declared by the App.
      actionUndeclared: await rogue("requests.plainAction", "other"),
      mutationUndeclared: await rogue("requests.plainMutation", "other"),
      receipts: await receiptsOf(fx.app),
      outbox: await outboxOf(fx.store),
    }).toStrictEqual({
      actionUnlisted: "resource.not_allowed",
      mutationUnlisted: "operation.no_resources",
      actionUndeclared: "resource.not_allowed",
      mutationUndeclared: "operation.no_resources",
      receipts: [],
      outbox: [],
    });
  });
});

describe("a mutation starting a workflow after it commits", () => {
  it("starts it once from the store's outbox, as the person the mutation acted for, and a retried mutation stages nothing more", async () => {
    const fx = await fixture();
    const key = `submit-${unique()}`;
    const first = await call(
      fx,
      fx.bob,
      "requests.submit",
      { who: "Bob" },
      { key }
    );
    const again = await call(
      fx,
      fx.bob,
      "requests.submit",
      { who: "Bob" },
      { key }
    );
    const staged = await outboxOf(fx.store);
    await runDurableObjectAlarm(objectOf(fx.store));
    const receipts = await receiptsOf(fx.app);
    const run = await ended(fx, receipts[0]?.id ?? null);
    expect({
      sameOutcome: first.ok && again.ok && first.value === again.value,
      staged: staged.length,
      settled: await settledOf(fx.store),
      receipts: receipts.map(
        ({ invoker_type, principal_id, idempotency_key }) => ({
          invoker_type,
          principal_id,
          afterCommit: idempotency_key.startsWith("grasp:after-commit:"),
        })
      ),
      run: { status: run.status, output: run.output },
    }).toStrictEqual({
      sameOutcome: true,
      staged: 1,
      settled: [{ settled: true, undeliverable: null }],
      receipts: [
        { invoker_type: "app", principal_id: fx.bob.userId, afterCommit: true },
      ],
      run: { status: "completed", output: { status: "Hello, Bob" } },
    });
  });

  it("starts nothing for a mutation that fails, whose commit is refused, or whose attempt was superseded", async () => {
    const fx = await fixture();
    const failed = await call(fx, fx.bob, "requests.submit", {
      who: "Bob",
      fail: true,
    });
    const kept = await call(fx, fx.bob, "requests.submit", { who: "Kept" });
    const keptOutbox = await outboxOf(fx.store);
    const id = kept.ok ? kept.value : null;
    const refused = await call(fx, fx.bob, "requests.guarded", { id });
    // A superseded attempt, at the store: a later claim of the same key
    // moved the fence on, so the earlier attempt's commit, intent and all,
    // is refused.
    const starts = appWorkflowStarts(env, {
      subject: { type: "app", appId: fx.app },
      onBehalfOf: fx.bob.userId,
      mode: "interactive",
      appVersion: 1,
    } satisfies Authority);
    const claim = {
      scope: {
        principal: fx.bob.userId,
        resource: fx.app,
        binding: null,
        contractId: "requests.submit",
        contractVersion: 1,
        operationKind: "mutation" as const,
      },
      key: ["call", `fenced-${unique()}`],
      inputHash: zeros,
      runId: null,
      deadline: Date.now() + 60_000,
    };
    const older = await fx.store.claim(claim);
    const newer = await fx.store.claim(claim);
    const superseded =
      "held" in older && "held" in newer
        ? await fx.store
            .commit({
              principal: { userId: fx.bob.userId },
              roles: { appMember: true, appBuilder: false },
              schemaHash: await schemaHash(manifest.schema),
              receipt: older.held,
              stagedAt: Date.now(),
              writes: [],
              intents: [
                {
                  kind: "workflow.start",
                  data: starts.intent("followUp", { who: "Fenced" }),
                },
              ],
              result: null,
            })
            .then(
              () => "committed",
              (error: unknown) => codeOf(error)
            )
        : "unclaimed";
    await runDurableObjectAlarm(objectOf(fx.store));
    const receipts = await receiptsOf(fx.app);
    const outbox = await outboxOf(fx.store);
    expect({
      failed: answerOf(failed),
      refused: answerOf(refused),
      superseded,
      // Only the mutation that committed staged a start.
      staged: keptOutbox.length,
      outbox: outbox.length,
      receipts: receipts.length,
    }).toStrictEqual({
      failed: "desk.refused",
      refused: "data.conflict",
      superseded: "submission.superseded",
      staged: 1,
      outbox: 1,
      receipts: 1,
    });
  });

  it("recovers the same run when its dispatch dies after the start, before the entry is settled", async () => {
    const fx = await fixture();
    const committed = await call(fx, fx.bob, "requests.submit", { who: "Bob" });
    expect(committed.ok).toBeTruthy();
    // The dispatch admits the start, then dies before it acknowledges.
    await drainWith(fx.store, killedDispatch);
    const afterKill = await receiptsOf(fx.app);
    const pending = await outboxOf(fx.store);
    // Handed over again past its backoff, twice at once.
    await Promise.all([
      drainWith(fx.store, dispatch, Date.now() + hour),
      drainWith(fx.store, dispatch, Date.now() + hour),
    ]);
    const receipts = await receiptsOf(fx.app);
    const run = await ended(fx, receipts[0]?.id ?? null);
    expect({
      afterKill: afterKill.map(({ id }) => id),
      pending: pending.map(({ attempts, settled_at }) => ({
        attempts,
        settled_at,
      })),
      receipts: receipts.map(({ id }) => id),
      settled: await settledOf(fx.store),
      run: run.status,
    }).toStrictEqual({
      afterKill: [expect.any(String)],
      pending: [{ attempts: 1, settled_at: null }],
      // The same start, and so the same run: never a second.
      receipts: afterKill.map(({ id }) => id),
      settled: [{ settled: true, undeliverable: null }],
      run: "completed",
    });
  });

  it("is decided as it is dispatched: a person who lost the App, or a grant revoked since the commit, starts nothing, audited", async () => {
    const fx = await fixture();
    const bobs = await call(fx, fx.bob, "requests.submit", { who: "Bob" });
    await env.DB.prepare(
      "DELETE FROM app_members WHERE app_id = ? AND member_id = ?"
    )
      .bind(fx.app, fx.bob.userId)
      .run();
    await runDurableObjectAlarm(objectOf(fx.store));
    const afterRemoval = await receiptsOf(fx.app);

    const adas = await call(fx, fx.ada, "requests.submit", { who: "Ada" });
    await revokePermission(env, fx.admin, fx.permissionId);
    await runDurableObjectAlarm(objectOf(fx.store));
    const logged = await allEvents();
    const events = logged.filter(
      (event) =>
        event.action === "workflow.start_intent.refused" &&
        event.target?.id === fx.app
    );
    expect({
      committed: bobs.ok && adas.ok,
      afterRemoval,
      receipts: await receiptsOf(fx.app),
      outbox: await settledOf(fx.store),
      audited: events
        .map(({ detail }) => String(detail?.principal))
        .toSorted((a, b) => a.localeCompare(b)),
    }).toStrictEqual({
      committed: true,
      afterRemoval: [],
      receipts: [],
      outbox: [
        { settled: true, undeliverable: "workflow.start_denied" },
        { settled: true, undeliverable: "workflow.start_denied" },
      ],
      audited: [fx.bob.userId, fx.ada.userId].toSorted((a, b) =>
        a.localeCompare(b)
      ),
    });
  });
});

/** The fixture's App acting for `by`, at its version 1. */
const appAuthority = (fx: Fixture, by: Identity): Authority => ({
  subject: { type: "app", appId: fx.app },
  onBehalfOf: by.userId,
  mode: "interactive",
  appVersion: 1,
});

/** An outbox entry of a start `by`'s call staged, as its dispatch takes it. */
const entryOf = (
  fx: Fixture,
  by: Identity,
  options: {
    id?: string;
    attempts?: number;
    signal?: AbortSignal;
    agent?: CallingAgent;
  } = {}
) => ({
  id: options.id ?? `${unique()}:1:0`,
  intent: {
    kind: "workflow.start" as const,
    data: appWorkflowStarts(
      env,
      appAuthority(fx, by),
      options.agent ?? null
    ).intent("followUp", { who: "Bob" }),
  },
  attempts: options.attempts ?? 0,
  signal: options.signal ?? new AbortController().signal,
});

/** What became of a dispatch: its answer, or the code it threw. */
const dispatched = async (
  ...args: Parameters<typeof dispatchStartIntent>
): Promise<unknown> => {
  try {
    return await dispatchStartIntent(...args);
  } catch (error) {
    return codeOf(error);
  }
};

/** How many starts App `appId` made. */
const receiptCount = async (appId: string): Promise<number> => {
  const receipts = await receiptsOf(appId);
  return receipts.length;
};

/** The audit events of `name` about `target`, as their details. */
const detailsOf = async (name: string, target: string) => {
  const logged = await allEvents();
  return logged
    .filter((event) => event.action === name && event.target?.id === target)
    .map(({ detail }) => detail);
};

/** An agent of a chat of its own, granted `write` on the fixture's App. */
const agentOf = async (
  fx: Fixture
): Promise<{
  agent: CallingAgent;
  permissionId: string;
}> => {
  const agent: CallingAgent = {
    agentId: `agent-${unique()}`,
    workspaceId: workspaceIdSchema.parse(crypto.randomUUID()),
    chatId: chatIdSchema.parse(crypto.randomUUID()),
  };
  const asked = await requestPermission(
    env,
    fx.ada,
    {
      subject: { type: "agent", agentId: agent.agentId },
      object: { type: "app", appId: fx.app },
      actions: ["write"],
      binding: "REQUESTS",
    },
    rolesOf(fx.ada)
  );
  await grantPermission(env, fx.admin, asked.id, { version: null });
  return { agent, permissionId: asked.id };
};

describe("what a start rechecks, and records", () => {
  it("refuses a restricted App's starts, now and from its outbox, so restricted data never reaches a run", async () => {
    const fx = await fixture();
    const staged = await call(fx, fx.bob, "requests.submit", { who: "Bob" });
    await appHost(env, fx.app).restrict();
    const started = await call(fx, fx.bob, "requests.kickOff", { who: "Bob" });
    await runDurableObjectAlarm(objectOf(fx.store));
    const refusals = await detailsOf("workflow.start_intent.refused", fx.app);
    expect({
      staged: staged.ok,
      started: answerOf(started),
      receipts: await receiptsOf(fx.app),
      outbox: await settledOf(fx.store),
      audited: refusals.map((detail) => detail?.reason),
    }).toStrictEqual({
      staged: true,
      started: "workflow.start_restricted",
      receipts: [],
      outbox: [{ settled: true, undeliverable: "workflow.start_restricted" }],
      audited: ["workflow.start_restricted"],
    });
  });

  it("starts nothing from a revoked release's commits, nor for an agent that lost its permission, and names the agent", async () => {
    const fx = await fixture();
    const { agent, permissionId } = await agentOf(fx);
    // An agent's start, while it holds its permission: admitted, naming it.
    const kept = await call(
      fx,
      fx.bob,
      "requests.kickOff",
      { who: "Bob" },
      { agent }
    );
    const staged = await call(
      fx,
      fx.bob,
      "requests.submit",
      { who: "Bob" },
      { agent }
    );
    await revokePermission(env, fx.admin, permissionId);
    await runDurableObjectAlarm(objectOf(fx.store));
    const afterAgent = await settledOf(fx.store);
    const admitted = await detailsOf("workflow.start.admitted", fx.workflowId);
    const refused = await detailsOf("workflow.start_intent.refused", fx.app);

    // The App's release revoked after a commit: its start runs no more.
    const before = await call(fx, fx.bob, "requests.submit", { who: "Bob" });
    await env.DB.prepare(
      "UPDATE sdk_release_manifests SET revoked_at = ? WHERE app_id = ? AND version = 1"
    )
      .bind(Date.now(), fx.app)
      .run();
    await runDurableObjectAlarm(objectOf(fx.store));
    expect({
      kept: kept.ok,
      staged: staged.ok,
      before: before.ok,
      afterAgent,
      admittedAgents: admitted.map((detail) => detail?.agent),
      refusedAgents: refused.map((detail) => detail?.agent),
      outbox: await settledOf(fx.store),
      receipts: await receiptCount(fx.app),
    }).toStrictEqual({
      kept: true,
      staged: true,
      before: true,
      afterAgent: [{ settled: true, undeliverable: "workflow.start_denied" }],
      admittedAgents: [agent.agentId],
      refusedAgents: [agent.agentId],
      outbox: [
        { settled: true, undeliverable: "workflow.start_denied" },
        { settled: true, undeliverable: "workflow.start_denied" },
      ],
      receipts: 1,
    });
  });

  it("admits no start of an agent's commit once its permission is revoked after the check, before the receipt", async () => {
    const fx = await fixture();
    const { agent, permissionId } = await agentOf(fx);
    const db = racingDb(async () => {
      await revokePermission(env, fx.admin, permissionId);
    }, /insert into "workflow_start_receipts"/iu);
    const answer = await dispatched(
      { ...env, DB: db },
      entryOf(fx, fx.bob, { agent })
    );
    expect({
      answer,
      receipts: await receiptCount(fx.app),
    }).toStrictEqual({
      answer: { undeliverable: "workflow.start_denied" },
      receipts: 0,
    });
  });

  it("decides again when a parameter edit makes its decision stale, and starts it", async () => {
    const fx = await fixture();
    const db = racingDb(
      async () =>
        await setWorkflowParams(env, fx.ada, fx.workflowId, {
          expectedRevision: 0,
          values: { greeting: "Hi" },
        }),
      /insert into "workflow_start_receipts"/iu
    );
    const answer = await dispatched({ ...env, DB: db }, entryOf(fx, fx.bob));
    expect({
      answer,
      receipts: await receiptCount(fx.app),
    }).toStrictEqual({ answer: "delivered", receipts: 1 });
  });

  it("hands a start back to its outbox while every decision goes stale, and starts it once the edits stop", async () => {
    const fx = await fixture();
    const edits = { revision: 0 };
    const db = racingDb(
      async () => {
        await setWorkflowParams(env, fx.ada, fx.workflowId, {
          expectedRevision: edits.revision,
          values: { greeting: `Hi ${edits.revision}` },
        });
        edits.revision += 1;
      },
      /insert into "workflow_start_receipts"/iu,
      Number.POSITIVE_INFINITY
    );
    const entry = entryOf(fx, fx.bob);
    const busy = await dispatched({ ...env, DB: db }, entry);
    const later = await dispatched(env, { ...entry, attempts: 1 });
    expect({
      busy,
      later,
      refused: await detailsOf("workflow.start_intent.refused", fx.app),
      receipts: await receiptCount(fx.app),
    }).toStrictEqual({
      busy: "workflow.start_denied",
      later: "delivered",
      refused: [],
      receipts: 1,
    });
  });

  it("keys each commit's start by its outbox entry, so a later commit under a reused mutation key starts anew", async () => {
    const fx = await fixture();
    const receipt = unique();
    const first = await dispatched(
      env,
      entryOf(fx, fx.bob, { id: `${receipt}:1:0` })
    );
    const later = await dispatched(
      env,
      entryOf(fx, fx.bob, { id: `${receipt}:2:0` })
    );
    const receipts = await receiptsOf(fx.app);
    expect({
      first,
      later,
      receipts: receipts.map(({ idempotency_key }) => idempotency_key),
    }).toStrictEqual({
      first: "delivered",
      later: "delivered",
      receipts: [
        `grasp:after-commit:${receipt}:1:0`,
        `grasp:after-commit:${receipt}:2:0`,
      ],
    });
  });

  it("refuses a start past a commit's bound before it reads anything more", async () => {
    const fx = await fixture();
    const gate = { passes: 0 };
    const flooded = await call(fx, fx.bob, "requests.flood", {}, { gate });
    expect({
      refused: answerOf(flooded),
      // The call's own, one per start a commit may hold, and the commit's.
      passes: gate.passes,
    }).toStrictEqual({ refused: 24, passes: 18 });
  });

  it("refuses a start its commit has no room for where the handler may catch it, and commits the rest", async () => {
    const fx = await fixture();
    const staged = await call(fx, fx.bob, "requests.bulky", {});
    const refused = answerOf(staged);
    const outbox = await settledOf(fx.store);
    expect({
      committed: staged.ok,
      someRefused: typeof refused === "number" && refused > 0 && refused < 9,
      stagedTheRest: outbox.length === 9 - Number(refused),
    }).toStrictEqual({
      committed: true,
      someRefused: true,
      stagedTheRest: true,
    });
  });

  it("records an unreadable intent, and one whose last attempt fails, as it gives them up", async () => {
    const fx = await fixture(true);
    const unreadable = await dispatched(env, {
      id: `${unique()}:1:0`,
      intent: { kind: "workflow.start", data: { app: fx.app } },
      attempts: 0,
      signal: new AbortController().signal,
    });
    const unreadableEvents = await allEvents();
    // Bob's live runs at their limit: each attempt fails, the last audited.
    const starts = appWorkflowStarts(env, appAuthority(fx, fx.bob));
    for (let index = 0; index < maxLiveRunsPerPrincipal; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one start after the other
      await starts.start("followUp", { who: "Bob" }, `fill-${index}`);
    }
    const early = await dispatched(env, entryOf(fx, fx.bob));
    const last = await dispatched(
      env,
      entryOf(fx, fx.bob, { attempts: defaultMaxAttempts - 1 })
    );
    const { length: abandoned } = await detailsOf(
      "workflow.start_intent.abandoned",
      fx.app
    );
    expect({
      unreadable,
      unreadableAudited: unreadableEvents.some(
        (event) => event.action === "workflow.start_intent.unreadable"
      ),
      early,
      last,
      abandoned,
    }).toStrictEqual({
      unreadable: { undeliverable: "outbox.unreadable" },
      unreadableAudited: true,
      early: "workflow.run_limit",
      last: "workflow.run_limit",
      abandoned: 1,
    });
  });

  it("settles a re-dispatch as delivered when an earlier one admitted the start before authority changed", async () => {
    const fx = await fixture();
    const entry = entryOf(fx, fx.bob);
    const first = await dispatched(env, entry);
    await revokePermission(env, fx.admin, fx.permissionId);
    const again = await dispatched(env, entry);
    expect({
      first,
      again,
      refused: await detailsOf("workflow.start_intent.refused", fx.app),
      receipts: await receiptCount(fx.app),
    }).toStrictEqual({
      first: "delivered",
      again: "delivered",
      refused: [],
      receipts: 1,
    });
  });

  it("stops once its hand-over's time is up, starting nothing", async () => {
    const fx = await fixture();
    const timedOut = new AbortController();
    timedOut.abort();
    const answer = await dispatched(
      env,
      entryOf(fx, fx.bob, { signal: timedOut.signal })
    );
    expect({
      stopped: typeof answer === "string" && answer !== "delivered",
      receipts: await receiptsOf(fx.app),
    }).toStrictEqual({ stopped: true, receipts: [] });
  });

  it("keeps core's start keys from any key a person chooses", async () => {
    const fx = await fixture();
    const taken = await outcome(
      startWorkflow(env, { type: "person", person: fx.ada }, fx.workflowId, {
        version: 1,
        input: { who: "Ada" },
        key: `grasp:after-commit:${unique()}`,
      })
    );
    expect(taken).toBe("workflow.start_invalid");
  });
});
