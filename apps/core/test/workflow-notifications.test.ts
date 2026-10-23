/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import {
  AppError,
  app as registerApp,
  defineSchema,
  defineTable,
  resource,
  v,
} from "@grasp-os/sdk";
import type { WorkflowEventReference } from "@grasp-os/sdk";
import { eventFingerprint, inspectApp, manifestText } from "@grasp-os/sdk/host";
import { runFunction } from "@grasp-os/sdk/runner";
import type { OperationChannel } from "@grasp-os/sdk/runner";
import { serverModule } from "@grasp-os/sdk/server";
import {
  releaseFormatVersion,
  releaseManifestSchema,
  sdkProtocolVersion,
} from "@grasp-os/shared/app-releases";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalText } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import type { Authority } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { invocationFor } from "../src/app-functions.ts";
import type { Release } from "../src/app-releases.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appFor } from "../src/apps.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { callOperation } from "../src/operations.ts";
import type { HostedApp, Runner } from "../src/operations.ts";
import type { OutboxConsumer } from "../src/outbox-delivery.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { StoreHost } from "../src/store-host.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { dispatchNotifyIntent } from "../src/workflow-notifications.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { appWorkflowStarts } from "../src/workflow-start-intents.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import {
  resourceRunFor,
  terminateResourceRun,
} from "../src/workflows/resource-runs.ts";
import { allEvents } from "./audit-events.ts";
import { liveStatus } from "./runs.ts";
import { unique } from "./sign-in.ts";

// A mutation's workflow notifications (spec 10.7.4; operations.ts stages
// them, workflow-notifications.ts admits and delivers them), from their
// threat model: a notification commits with its mutation's records and
// receipt or not at all; it is delivered from the store's outbox into the
// run's inbox once, its event's ID from the receipt and its place, a
// dispatch that dies after the inbox took it delivering the same event;
// only an event the function lists, of a run the App started through its
// binding, under the App's `send` grant, with data its contract takes, is
// staged; one the run can no longer take is settled undeliverable,
// audited, the mutation standing.

const completed = "grasp.job.completed";
const jobData = v.object({ jobId: v.string() });
const jobEvent = { type: completed, data: jobData.descriptor };

/**
 * The reference `#grasp` generates for the `review` workflow's
 * `jobEvents`, as server code lists it.
 */
// SAFETY: the generated reference's fields, its data's type from the
// descriptor it carries.
const jobEvents = Object.freeze({
  kind: "workflowEvent",
  resourceId: "app",
  resourceVersion: 1,
  workflow: "workflows.review",
  workflowFingerprint: "0".repeat(64),
  alias: "jobEvents",
  type: completed,
  fingerprint: await eventFingerprint(jobEvent),
  data: jobData.descriptor,
}) as WorkflowEventReference<
  "workflows.review",
  "jobEvents",
  typeof completed,
  { jobId: string }
>;

const schema = defineSchema({ jobs: defineTable({ jobId: v.string() }) });
const { mutation } = serverModule(schema);

const review = resource.workflow("review", {
  input: v.object({ jobId: v.string() }),
  output: v.object({ status: v.string() }),
});

/** Records a job done and notifies its run. */
const markDone = mutation({
  args: { runId: v.string(), jobId: v.string() },
  returns: v.string(),
  uses: [jobEvents],
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("jobs", { jobId: args.jobId });
    ctx.notify(jobEvents, { runId: args.runId, data: { jobId: args.jobId } });
    return id;
  },
});

/** Records a job done and notifies its run, then fails. */
const markThenFail = mutation({
  args: { runId: v.string() },
  returns: v.null(),
  uses: [jobEvents],
  handler: async (ctx, args) => {
    await ctx.db.insert("jobs", { jobId: "job-1" });
    ctx.notify(jobEvents, { runId: args.runId, data: { jobId: "job-1" } });
    throw new AppError("desk.refused", "Not now.");
  },
});

/** Lists the event; its code asks the channel for whatever it is given. */
const rawNotify = mutation({
  args: { event: v.string(), runId: v.string(), data: v.string() },
  returns: v.string(),
  uses: [jobEvents],
  handler: () => "unreached",
});

/** Lists nothing; its code asks the channel to notify all the same. */
const unlisted = mutation({
  args: { event: v.string(), runId: v.string(), data: v.string() },
  returns: v.string(),
  handler: () => "unreached",
});

const jobsApp = registerApp({
  name: "Jobs",
  schema,
  access: { tables: { jobs: { read: "appMembers", write: "appMembers" } } },
  operations: { jobs: { markDone, markThenFail, rawNotify, unlisted } },
  screens: [],
  uses: [review],
});

const { manifest } = inspectApp(jobsApp);

/** The code of an expected error, or what else it was. */
const codeOf = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : String(error);

/**
 * App code as the SDK's runner runs it, but for `rawNotify` and
 * `unlisted`, which talk to their channel directly, as code in an
 * isolate could, and answer what the host said.
 */
const runner: Runner = async (path, args, channel: OperationChannel) => {
  if (path === "jobs.rawNotify" || path === "jobs.unlisted") {
    const asked = z
      .object({ event: z.string(), runId: z.string(), data: z.string() })
      .parse(args);
    return await channel
      .resource("review", "notify", [
        asked.event,
        asked.runId,
        JSON.parse(asked.data),
      ])
      .then(
        () => "staged",
        (error: unknown) => codeOf(error)
      );
  }
  return await runFunction(jobsApp, path, args, channel);
};

const hosted: HostedApp = { manifest, run: runner };

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

/**
 * A workflow waiting for its job's completion through `jobEvents`, then
 * ending with the event's source and job.
 */
const definitionOf = (name: string, contract: string): string =>
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
          bindings: { jobEvents: { kind: "event", contract } },
        },
      },
    },
    input: { schema: objectSchema({ jobId: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      {
        "await-job": {
          listen: {
            to: { one: { with: { type: completed } } },
            read: "envelope",
          },
          timeout: { after: { hours: 1 } },
          metadata: { grasp: { binding: "jobEvents" } },
        },
      },
      {
        finish: {
          set: { status: '${ .[0].source + " " + .[0].data.jobId }' },
        },
      },
    ],
  });

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

/** A grant to the App of `actions` on `workflow`, requested and granted. */
const granted = async (
  admin: Identity,
  ada: Identity,
  app: AppId,
  workflow: string,
  actions: string[]
): Promise<string> => {
  const asked = await requestPermission(
    env,
    ada,
    {
      subject: { type: "app", appId: app },
      object: { type: "workflow", workflowId: workflow },
      actions,
      binding: `REVIEW_${actions.join("_").toUpperCase()}`,
    },
    rolesOf(ada)
  );
  await grantPermission(env, admin, asked.id, { version: null });
  return asked.id;
};

/**
 * Ada's Jobs App, version 1 approved and sealed, with its store; her
 * workflow, waiting for its job's completion through `jobEvents`
 * (approved), bound to it as `review`; the App's `start` and `send`
 * grants on it, each its own; and Bob, who uses the App.
 */
const fixture = async () => {
  const admin = await person("admin");
  const ada = await person("builder");
  const bob = await person("user");
  const app = appIdSchema.parse(crypto.randomUUID());
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Jobs', '', ?, ?)"
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
  const contract = `job-events-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: contract,
    kind: "event",
    events: {
      [completed]: { data: JSON.stringify(jobData.descriptor), browser: true },
    },
  });
  const workflow = await createWorkflowResource(env, ada, `review-${unique()}`);
  await publishWorkflowVersion(env, ada, workflow.id, {
    definition: definitionOf(workflow.name, contract),
    basedOn: null,
  });
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "jobEvents",
    target: { kind: "event" },
    reviewed: { version: 1 },
  });
  await bindWorkflowToApp(env, ada, workflow.id, {
    app,
    alias: "review",
    version: 1,
  });
  await granted(admin, ada, app, workflow.id, ["start"]);
  const send = await granted(admin, ada, app, workflow.id, ["send"]);
  const release: Release = {
    manifest: sealed.parsed,
    manifestHash: sealed.hash,
    app: manifest,
    fingerprints: {},
    modules: {},
    sdk: {},
    store: {
      alias: "jobs",
      storeId,
      schemaVersion: 1,
      schemaHash: zeros,
      operationManifestHash: zeros,
    },
    workflows: [
      {
        alias: "review",
        events: { jobEvents: jobEvent },
        listens: {},
        decisions: {},
        pinned: { workflowId: workflow.id, version: 1 },
      },
    ],
  };
  return {
    admin,
    ada,
    bob,
    app,
    workflowId: workflow.id,
    send,
    store,
    release,
  };
};

type Fixture = Awaited<ReturnType<typeof fixture>>;

const kinds = {
  "jobs.markDone": "mutation",
  "jobs.markThenFail": "mutation",
  "jobs.rawNotify": "mutation",
  "jobs.unlisted": "mutation",
} as const;

/** Calls `path` as `by` through the App's invocation, as a screen would. */
const call = async (
  fx: Fixture,
  by: Identity,
  path: keyof typeof kinds,
  args: Json
): Promise<OperationResult> => {
  const invocation = await invocationFor(env, fx.release, {
    by,
    requestId: crypto.randomUUID(),
    deadline: Date.now() + 30_000,
  });
  return await callOperation(
    hosted,
    invocation,
    { path, kind: kinds[path] },
    args
  );
};

/** What a call answered, or the code it failed with. */
const answerOf = (result: OperationResult): unknown =>
  result.ok ? result.value : result.error.code;

/** A run of `review` the App starts for `by` on job `jobId`, waiting: its ID. */
const startedRun = async (
  fx: Fixture,
  by: Identity,
  jobId = "job-1"
): Promise<string> => {
  const authority: Authority = {
    subject: { type: "app", appId: fx.app },
    onBehalfOf: by.userId,
    mode: "interactive",
    appVersion: 1,
  };
  const handle = await appWorkflowStarts(env, authority).start(
    "review",
    { jobId },
    unique()
  );
  const { runId } = handle;
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  await vi.waitFor(
    async () => {
      await expect(liveStatus(runId)).resolves.toBe("waiting");
    },
    { timeout: 30_000, interval: 100 }
  );
  return runId;
};

const objectOf = (store: OpenStore) => env.DATA_STORES.getByName(store.id);

/** The store's outbox entries, as settled: their kind, and as what. */
const outboxOf = async (store: OpenStore) =>
  await runInDurableObject(objectOf(store), (_instance, state) =>
    state.storage.sql
      .exec<{
        kind: string;
        settled_at: number | null;
        undeliverable: string | null;
      }>(
        "SELECT kind, settled_at, undeliverable FROM sdk_change_outbox ORDER BY rowid"
      )
      .toArray()
      .map(({ kind, settled_at, undeliverable }) => ({
        kind,
        settled: settled_at !== null,
        undeliverable,
      }))
  );

/** Drains the store's outbox with `consumer` taking its notifications, at `at`. */
const drainWith = async (
  store: OpenStore,
  consumer: OutboxConsumer,
  at = Date.now()
): Promise<void> => {
  await runInDurableObject(objectOf(store), async (_instance, state) => {
    await new StoreHost(state, env).drainOutbox(
      { "workflow.notify": consumer },
      { now: new Date(at) }
    );
  });
};

/** The dispatch as the store's outbox runs it. */
const dispatch: OutboxConsumer = async (entry) =>
  await dispatchNotifyIntent(env, entry);

/** A dispatch that delivers the event, then dies before it acknowledges. */
const killedDispatch: OutboxConsumer = async (entry) => {
  await dispatchNotifyIntent(env, entry);
  throw new Error("Killed before acknowledging");
};

const hour = 3_600_000;

/** Run `runId`, once it has ended, as its workflow's builder reads it. */
const ended = async (
  fx: Fixture,
  runId: string
): Promise<WorkflowResourceRun> =>
  await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, fx.ada, fx.workflowId, runId);
      expect(run.endedAt).not.toBeNull();
      return run;
    },
    { timeout: 30_000, interval: 100 }
  );

/** The audit events of `action` for run `runId`. */
const auditedFor = async (action: string, runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      (event) =>
        event.action === action &&
        event.target?.type === "workflow_run" &&
        event.target.id === runId
    )
    .map(({ actor, detail }) => ({ actor, detail }));
};

describe("a mutation notifying a workflow's run", { timeout: 120_000 }, () => {
  it("is delivered once from the store's outbox after its commit, with the host's source, the same event when a dispatch dies after the inbox took it", async () => {
    const fx = await fixture();
    const runId = await startedRun(fx, fx.ada);

    const committed = await call(fx, fx.bob, "jobs.markDone", {
      runId,
      jobId: "job-1",
    });
    const staged = await outboxOf(fx.store);
    await drainWith(fx.store, killedDispatch);
    await drainWith(fx.store, dispatch, Date.now() + hour);
    const run = await ended(fx, runId);
    const sent = await auditedFor("workflow.event.sent", runId);

    expect({
      committed: committed.ok,
      staged,
      settled: await outboxOf(fx.store),
      run: { status: run.status, output: run.output },
      sent: sent.map(({ actor, detail }) => ({
        actor,
        via: detail?.via,
        principal: detail?.principal,
        redelivered: detail?.redelivered,
        sameEvent: detail?.event === sent[0]?.detail?.event,
      })),
    }).toStrictEqual({
      committed: true,
      staged: [
        { kind: "workflow.notify", settled: false, undeliverable: null },
      ],
      settled: [
        { kind: "workflow.notify", settled: true, undeliverable: null },
      ],
      // Bob's mutation notified Ada's run, as the App, for Bob.
      run: {
        status: "completed",
        output: {
          status: `urn:grasp:app:${fx.app}:version:1:person:${fx.bob.userId}:mutation job-1`,
        },
      },
      sent: [false, true].map((redelivered) => ({
        actor: { type: "app", appId: fx.app, part: "server" },
        via: "mutation",
        principal: fx.bob.userId,
        redelivered,
        sameEvent: true,
      })),
    });
  });

  it("stages nothing for a mutation that fails, and refuses an unlisted event, data its contract refuses, or a run that isn't the App's before anything is staged", async () => {
    const fx = await fixture();
    const runId = await startedRun(fx, fx.ada);
    const { runId: personsRun } = await startWorkflow(
      env,
      { type: "person", person: fx.ada },
      fx.workflowId,
      { version: 1, input: { jobId: "job-9" }, key: unique() }
    );
    const raw = async (
      path: "jobs.rawNotify" | "jobs.unlisted",
      fields: { event?: string; runId?: string | null; data?: unknown }
    ) =>
      answerOf(
        await call(fx, fx.bob, path, {
          event: fields.event ?? "jobEvents",
          runId: fields.runId ?? runId,
          data: JSON.stringify(fields.data ?? { jobId: "job-1" }),
        })
      );

    const outcomes = {
      failed: answerOf(await call(fx, fx.bob, "jobs.markThenFail", { runId })),
      unlisted: await raw("jobs.unlisted", {}),
      otherEvent: await raw("jobs.rawNotify", { event: "otherEvents" }),
      extraField: await raw("jobs.rawNotify", {
        data: { jobId: "job-1", source: "urn:forged" },
      }),
      malformed: await raw("jobs.rawNotify", { data: { jobId: 1 } }),
      noSuchRun: await raw("jobs.rawNotify", { runId: crypto.randomUUID() }),
      personsRun: await raw("jobs.rawNotify", { runId: personsRun }),
      wellFormed: await raw("jobs.rawNotify", {}),
    };

    expect({ outcomes, outbox: await outboxOf(fx.store) }).toStrictEqual({
      outcomes: {
        failed: "desk.refused",
        unlisted: "resource.not_allowed",
        otherEvent: "resource.not_allowed",
        extraField: "contract.invalid_args",
        malformed: "contract.invalid_args",
        noSuchRun: "resource.unavailable",
        personsRun: "resource.unavailable",
        // The one well-formed notification staged.
        wellFormed: "staged",
      },
      outbox: [
        { kind: "workflow.notify", settled: false, undeliverable: null },
      ],
    });
  });

  it("refuses to stage without the App's send grant", async () => {
    const fx = await fixture();
    const runId = await startedRun(fx, fx.ada);
    await revokePermission(env, fx.admin, fx.send);

    const refused = await call(fx, fx.bob, "jobs.markDone", {
      runId,
      jobId: "job-1",
    });

    expect({
      refused: answerOf(refused),
      outbox: await outboxOf(fx.store),
    }).toStrictEqual({ refused: "resource.unavailable", outbox: [] });
  });

  it("settles undeliverable, audited, once the run ended or the grant went before delivery, and the mutation stands", async () => {
    const fx = await fixture();
    const endedRun = await startedRun(fx, fx.ada);
    const revokedRun = await startedRun(fx, fx.ada, "job-2");
    const first = await call(fx, fx.bob, "jobs.markDone", {
      runId: endedRun,
      jobId: "job-1",
    });
    await terminateResourceRun(env, fx.ada, fx.workflowId, endedRun);
    await ended(fx, endedRun);
    await drainWith(fx.store, dispatch);
    const second = await call(fx, fx.bob, "jobs.markDone", {
      runId: revokedRun,
      jobId: "job-2",
    });
    await revokePermission(env, fx.admin, fx.send);
    await drainWith(fx.store, dispatch);
    const refusals = [
      ...(await auditedFor("workflow.notify_intent.refused", endedRun)),
      ...(await auditedFor("workflow.notify_intent.refused", revokedRun)),
    ];

    expect({
      committed: [first.ok, second.ok],
      outbox: await outboxOf(fx.store),
      refusals: refusals.map(({ detail }) => detail?.reason),
      sent: [
        ...(await auditedFor("workflow.event.sent", endedRun)),
        ...(await auditedFor("workflow.event.sent", revokedRun)),
      ],
    }).toStrictEqual({
      committed: [true, true],
      outbox: [
        {
          kind: "workflow.notify",
          settled: true,
          undeliverable: "workflow.run_ended",
        },
        {
          kind: "workflow.notify",
          settled: true,
          undeliverable: "workflow.event_denied",
        },
      ],
      refusals: ["workflow.run_ended", "workflow.event_denied"],
      sent: [],
    });
  });
});
