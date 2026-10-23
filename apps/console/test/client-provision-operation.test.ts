import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";
import { deriveRouterSecret } from "@grasp-os/shared/router";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { cloudflareApi } from "../src/cloudflare/api.ts";
import { queryD1 } from "../src/cloudflare/workers.ts";
import {
  auditEvents,
  clientProvisions,
  clientResources,
  clientRuns,
  clients,
  releases,
} from "../src/db/schema.ts";
import {
  clientMailDomain,
  onboardingSender,
} from "../src/deploy/core-config.ts";
import { mappedRoute } from "../src/deploy/router.ts";
import type { DeploySecrets } from "../src/deploy/secrets.ts";
import {
  allocateClientResources,
  clientInventory,
} from "../src/hosting/inventory.ts";
import {
  runClientProvision,
  startClientProvision,
} from "../src/hosting/operation.ts";
import { provisionPlacedClient } from "../src/hosting/workflow.ts";
import { claimRun } from "../src/runners.ts";
import type { HeldClient } from "../src/runners.ts";
import type { AccountState, ApiCall } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api.ts";
import { db, destination, placedClient, staff } from "./hosting.ts";
import { buildRelease, putBlobs } from "./releases.ts";
import type { ReleaseSpec } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-0123456789";
const cloudflare = mockCloudflareApi(token);
const api = cloudflareApi({ token, retryDelayMs: 0 });
const secrets: DeploySecrets = {
  routerKey: "test-router-key",
  clientKey: "test-client-key",
  shared: { connect: { COMPOSIO_API_KEY: "composio" } },
};
const domain = "grasp.test";
const context = {
  api,
  db,
  store: env.RELEASES,
  secrets,
  router: { hosts: env.ROUTER_HOSTS, domain, smoke: { retryDelayMs: 0 } },
};
const namespace = "production";

type Kind = "dedicated" | "workers_for_platforms";

/** The binding kinds Workers for Platforms documents for user Workers. */
const documented = new Set([
  "d1",
  "r2_bucket",
  "durable_object_namespace",
  "assets",
]);

/**
 * A release imported for a placed client: core binds its own Durable
 * Object classes, as the real one does, and nothing a placed client
 * refuses outright (Workflows, Workers AI). For a Workers for Platforms
 * destination, only the bindings its documentation lists for user
 * Workers, and no cron triggers. `adjust` changes core.
 */
const importRelease = async (
  kind: Kind,
  spec: Partial<ReleaseSpec> = {},
  adjust: (core: WorkerEntry) => WorkerEntry = (core) => core
): Promise<ReleaseManifest> => {
  const built = await buildRelease({
    notes: "feat(core): place me",
    ...(kind === "workers_for_platforms" ? { crons: [] } : {}),
    ...spec,
  });
  const { core } = built.manifest.workers;
  if (core === undefined) {
    throw new Error("The test release has no core");
  }
  const manifest: ReleaseManifest = {
    ...built.manifest,
    workers: {
      ...built.manifest.workers,
      core: adjust({
        ...core,
        durableObjectMigrations: [
          { tag: "v1", new_sqlite_classes: ["Workspace", "AuditLog"] },
        ],
        bindings: core.bindings.filter(({ type }) =>
          kind === "workers_for_platforms"
            ? documented.has(type)
            : type !== "workflow"
        ),
      }),
    },
  };
  await putBlobs(built);
  const now = new Date();
  await db.insert(releases).values({
    id: manifest.releaseId,
    commitSha: manifest.commit,
    manifest: JSON.stringify(manifest),
    manifestSha256: "0".repeat(64),
    builtAt: now,
    importedAt: now,
  });
  return manifest;
};

/** A client placed in `destinationId`, its operation started and claimed by a first attempt. */
const placedOperation = async (
  destinationId: string,
  manifest: ReleaseManifest
) => {
  const { clientId } = await placedClient(destinationId);
  const operationId = await startClientProvision(
    db,
    staff,
    clientId,
    manifest.releaseId
  );
  const runId = await claimRun(
    db,
    staff,
    clientId,
    null,
    { action: "client.provision_placed", clientId },
    { kind: "provision_placed", runId: `${clientId}-p1` }
  );
  if (runId === undefined) {
    throw new Error("The run wasn't claimed");
  }
  const held: HeldClient = { clientId, runId };
  return { clientId, operationId, held };
};

/** A client placed in a new destination of `kind` on a new account, its operation started and claimed. */
const setUp = async (kind: Kind, manifest: ReleaseManifest) => {
  const account = cloudflare.addAccount();
  if (kind === "workers_for_platforms") {
    account.namespaces.set(namespace, new Map());
  }
  const destinationId = await destination({
    kind,
    accountId: account.id,
    namespace: kind === "workers_for_platforms" ? namespace : null,
  });
  const placed = await placedOperation(destinationId, manifest);
  return { account, destinationId, ...placed };
};

const operationOf = async (clientId: string) =>
  await db
    .select()
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, clientId))
    .get();

/** Runs the operation expecting it to fail, its logged failure kept out of the output, and returns the error. */
const failing = async (held: HeldClient): Promise<unknown> => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await runClientProvision(context, held).then(
      () => null,
      (error: unknown) => error
    );
  } finally {
    errors.mockRestore();
  }
};

/** The migrations each database in `account` recorded, by database name. */
const appliedMigrations = async (
  account: AccountState
): Promise<Record<string, unknown[]>> => {
  const entries = await Promise.all(
    account.d1.map(async ({ uuid, name }): Promise<[string, unknown[]]> => {
      const [tables = []] = await queryD1(
        api,
        account.id,
        uuid,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'"
      );
      if (tables.length === 0) {
        return [name, []];
      }
      const [rows = []] = await queryD1(
        api,
        account.id,
        uuid,
        "SELECT name FROM d1_migrations ORDER BY id"
      );
      return [name, rows.map((row) => row.name)];
    })
  );
  return Object.fromEntries(entries);
};

/** What client `clientId`'s inventory records for `role`. */
const resourceOf = async (clientId: string, role: string) => {
  const inventory = await clientInventory(db, clientId);
  const row = inventory.find((resource) => resource.role === role);
  if (row === undefined) {
    throw new Error(`${clientId} has no ${role}`);
  }
  return row;
};

/** Client `clientId`'s core and connect scripts, as its inventory names them. */
const scriptsOf = async (clientId: string) => {
  const [core, connect] = await Promise.all([
    resourceOf(clientId, "worker:grasp-os-core"),
    resourceOf(clientId, "worker:grasp-os-connect"),
  ]);
  return { core: core.physicalName, connect: connect.physicalName };
};

/** A script's live version's bindings, by name. */
const liveBindings = (account: AccountState, script: string) => {
  const versions = account.scripts.get(script)?.versions ?? [];
  const bindings = z
    .array(z.object({ name: z.string() }).loose())
    .parse(versions.at(-1)?.metadata.bindings ?? []);
  return Object.fromEntries(bindings.map((binding) => [binding.name, binding]));
};

/** What the account holds, as names: anything made twice shows as a repeat. */
const holdings = (account: AccountState) => ({
  d1: account.d1.map(({ name }) => name).toSorted(),
  buckets: account.buckets.map(({ name }) => name).toSorted(),
  scripts: [...account.scripts.keys()].toSorted(),
});

/** Every zone in `account`, with the domains Email Sending sends from there. */
const zonesOf = (account: AccountState) =>
  account.zones.map(({ name, sending }) => ({
    name,
    sending: sending.map((entry) => ({
      name: entry.name,
      enabled: entry.enabled,
    })),
  }));

/** A call that creates a zone or turns Email Sending on for a domain. */
const isMailCreate = ({ method, path }: ApiCall): boolean =>
  method === "POST" &&
  (path === "/zones" || path.endsWith("/email/sending/subdomains"));

const isUpload = (script: string) => (call: ApiCall) =>
  call.method === "PUT" && call.path.endsWith(`/scripts/${script}`);

/** How many of a script's uploads carried Durable Object migrations, as sent. */
const migrationsRun = async (script: string): Promise<number> => {
  const carried = await Promise.all(
    cloudflare.calls.filter(isUpload(script)).map(async ({ body }) => {
      const metadata = body instanceof FormData ? body.get("metadata") : null;
      return (
        metadata instanceof Blob &&
        "migrations" in JSON.parse(await metadata.text())
      );
    })
  );
  return carried.filter(Boolean).length;
};

/** The operation's audit actions, oldest first. */
const actionsOf = async (clientId: string): Promise<string[]> => {
  const rows = await db
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.clientId, clientId))
    .orderBy(asc(auditEvents.at), sql`rowid`);
  return rows
    .map(({ action }) => action)
    .filter(
      (action) =>
        action.startsWith("provision.") && action !== "provision.progress"
    );
};

/** Whether the router's map routes the client's hostname anywhere. */
const routed = async (clientId: string): Promise<boolean> =>
  (await mappedRoute(env.ROUTER_HOSTS, `${clientId}.${domain}`)) !== null;

/** The secrets each Worker runs with: derived for the client, and connect's shared one. */
const wanted = {
  core: ["ROUTER_SECRET", "BETTER_AUTH_SECRET", "CAPABILITY_SIGNING_KEY"],
  connect: [
    "CAPABILITY_SIGNING_KEY",
    "TOKEN_ENCRYPTION_KEY",
    "COMPOSIO_API_KEY",
  ],
};

/** Everything a finished provisioning leaves of client `clientId`, in `account`. */
const provisioned = async (account: AccountState, clientId: string) => {
  const { core, connect } = await scriptsOf(clientId);
  const [client] = await db
    .select({ status: clients.status })
    .from(clients)
    .where(eq(clients.id, clientId));
  return {
    operation: await operationOf(clientId),
    status: client?.status,
    claims: await db
      .select()
      .from(clientRuns)
      .where(eq(clientRuns.clientId, clientId)),
    route: await mappedRoute(env.ROUTER_HOSTS, `${clientId}.${domain}`),
    holdings: holdings(account),
    zones: zonesOf(account),
    uploads: account.scriptUploads.map(({ script }) => script),
    coreMigrations: await migrationsRun(core),
    applied: Object.values(await appliedMigrations(account)).map(
      (names) => names.length
    ),
    // The secrets each Worker needs that its live version lacks.
    missingSecrets: [
      ...wanted.core.filter(
        (name) =>
          account.scripts.get(core)?.versions.at(-1)?.secrets.has(name) !== true
      ),
      ...wanted.connect.filter(
        (name) =>
          account.scripts.get(connect)?.versions.at(-1)?.secrets.has(name) !==
          true
      ),
    ],
  };
};

/** What `provisioned` says of a client provisioned once with a release that sends no mail, uploads aside. */
const once = (clientId: string) => ({
  operation: { status: "done", step: "route", error: null },
  status: "active",
  claims: [],
  route: { clientId, generation: 1 },
  // No mail, so no sending domain.
  zones: [],
  coreMigrations: 1,
  applied: [1, 1, 1],
  missingSecrets: [],
});

/** Where a run can stop, and how: a call answered with a failure, or a change made whose answer was lost. */
interface Stop {
  step: string;
  /** The last step the operation recorded before it. */
  stopped: string;
  code: string;
  plan: (account: AccountState, clientId: string) => Promise<void> | void;
}

const stops: Stop[] = [
  {
    step: "resources",
    stopped: "validated",
    code: "cloudflare_0",
    plan: () => {
      cloudflare.failNext(
        (call) => call.method === "POST" && call.path.endsWith("/d1/database"),
        "lost"
      );
    },
  },
  {
    step: "migrations",
    stopped: "resources",
    code: "cloudflare_0",
    plan: () => {
      cloudflare.failNext(
        (call) =>
          call.path.endsWith("/query") &&
          JSON.stringify(call.body).includes("INSERT INTO d1_migrations"),
        "lost"
      );
    },
  },
  {
    step: "connect upload",
    stopped: "migrations",
    code: "cloudflare_400_10000",
    plan: async (_account, clientId) => {
      const { connect } = await scriptsOf(clientId);
      cloudflare.failNext(isUpload(connect), 400);
    },
  },
  {
    step: "core upload",
    stopped: "connect",
    code: "cloudflare_0",
    plan: async (_account, clientId) => {
      const { core } = await scriptsOf(clientId);
      // Its Durable Object migration runs, and the answer never arrives.
      cloudflare.failNext(isUpload(core), "lost");
    },
  },
  {
    step: "secrets",
    stopped: "core",
    code: "cloudflare_400_10000",
    plan: () => {
      cloudflare.failNext(
        (call) => call.method === "PUT" && call.path.endsWith("/secrets"),
        400
      );
    },
  },
  {
    step: "probe",
    stopped: "secrets",
    code: "smoke_check_failed",
    plan: (account) => {
      // As many failed health checks as the smoke check tries.
      account.unhealthy = 5;
    },
  },
];

interface Refusal {
  name: string;
  kind: Kind;
  spec?: Partial<ReleaseSpec>;
  adjust?: (core: WorkerEntry) => WorkerEntry;
  code: string;
}

const refusals: Refusal[] = [
  {
    name: "a release that declares nothing of what it works with",
    kind: "dedicated",
    spec: { compatibility: null },
    code: "release_undeclared",
  },
  {
    name: "a release whose core calls a connect it doesn't ship",
    kind: "dedicated",
    spec: {
      compatibility: {
        interfaces: {
          connect: { serves: 1, calls: {} },
          core: { calls: { connect: { min: 2, max: 2 } } },
        },
        workflowJournal: { min: 8, max: 9 },
        sdkProtocols: { min: 2, max: 2 },
      },
    },
    code: "release_incompatible",
  },
  {
    name: "a release that binds Workers AI, with no spend ceiling decided",
    kind: "dedicated",
    adjust: (core) => ({
      ...core,
      bindings: [...core.bindings, { type: "ai", name: "AI" }],
    }),
    code: "model_spend_undecided",
  },
  {
    name: "a binding Workers for Platforms doesn't document for user Workers",
    kind: "workers_for_platforms",
    adjust: (core) => ({
      ...core,
      bindings: [
        ...core.bindings,
        { type: "service", name: "CONNECT", service: "grasp-os-connect" },
      ],
    }),
    code: "wfp_binding_unqualified",
  },
  {
    // Whether a user Worker can send mail at all is a spike of its own.
    name: "a release that sends mail into Workers for Platforms",
    kind: "workers_for_platforms",
    adjust: (core) => ({
      ...core,
      bindings: [...core.bindings, { type: "send_email", name: "EMAIL" }],
    }),
    code: "wfp_binding_unqualified",
  },
];

describe("provisioning a placed client", () => {
  useStoreSecrets({ deployer: token, tenant: `${token}-tenant-admin` });

  it("provisions a fresh client end to end, its hostname published last", async () => {
    const manifest = await importRelease("dedicated");
    const { account, clientId, held } = await setUp("dedicated", manifest);

    await runClientProvision(context, held);

    const { core, connect } = await scriptsOf(clientId);
    // Connect before core, which binds it; each uploaded once.
    await expect(provisioned(account, clientId)).resolves.toMatchObject({
      ...once(clientId),
      uploads: [connect, core],
    });
    // Core binds the client's own database, connect and bucket, and runs
    // with the router secret the router will send.
    const [database, bucket] = await Promise.all([
      resourceOf(clientId, "d1:grasp-os-core"),
      resourceOf(clientId, "r2:grasp-os-files"),
    ]);
    const live = account.scripts.get(core)?.versions.at(-1);
    expect({
      bindings: liveBindings(account, core),
      routerSecret: live?.secrets.get("ROUTER_SECRET"),
    }).toMatchObject({
      bindings: {
        DB: { id: database.providerId },
        CONNECT: { service: connect },
        FILES: { bucket_name: bucket.physicalName },
      },
      routerSecret: await deriveRouterSecret(secrets.routerKey, clientId, 1),
    });
    await expect(actionsOf(clientId)).resolves.toStrictEqual([
      "provision.start",
      "provision.validated",
      "provision.resources",
      "provision.migrations",
      "provision.worker_live",
      "provision.connect",
      "provision.worker_live",
      "provision.core",
      "provision.secrets",
      "provision.probe",
      "provision.mail",
      "provision.route",
      "provision.done",
    ]);
    // No secret value reaches an audit event or the operation's row.
    const recorded = JSON.stringify([
      await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.clientId, clientId)),
      await operationOf(clientId),
    ]);
    expect(
      [live?.secrets.get("ROUTER_SECRET") ?? "", "composio"].filter((value) =>
        recorded.includes(value)
      )
    ).toStrictEqual([]);
  });

  it("sets up a placed client's sending domain in its destination's account before publishing it, and locks its mail to the onboarding sender, whatever the release allows", async () => {
    const manifest = await importRelease(
      "dedicated",
      { sendsMail: true },
      (core) => ({
        ...core,
        bindings: core.bindings.map((binding) =>
          binding.type === "send_email"
            ? { ...binding, allowed_sender_addresses: ["ceo@acme.test"] }
            : binding
        ),
      })
    );
    const { account, clientId, held } = await setUp("dedicated", manifest);

    await runClientProvision(context, held);

    const { core } = await scriptsOf(clientId);
    const mailDomain = clientMailDomain(clientId, domain);
    const actions = await actionsOf(clientId);
    const operation = await operationOf(clientId);
    const progress: unknown = JSON.parse(operation?.progress ?? "{}");
    expect({
      zones: zonesOf(account),
      email: liveBindings(account, core).EMAIL,
      progress,
      mailThenRoute: actions.slice(-3),
    }).toMatchObject({
      zones: [
        { name: mailDomain, sending: [{ name: mailDomain, enabled: true }] },
      ],
      email: {
        type: "send_email",
        name: "EMAIL",
        allowed_sender_addresses: [onboardingSender(clientId, domain).address],
      },
      // Not yet delegated, so not yet sending: on record for staff.
      progress: { mail: { zoneId: account.zones[0]?.id, active: false } },
      mailThenRoute: ["provision.mail", "provision.route", "provision.done"],
    });
  });

  it("sets up a placed client's sending domain once, resumed after its answer was lost", async () => {
    const manifest = await importRelease("dedicated", { sendsMail: true });
    const { account, clientId, held } = await setUp("dedicated", manifest);
    // Email Sending is turned on, and the answer never arrives.
    cloudflare.failNext(
      ({ method, path }) =>
        method === "POST" && path.endsWith("/email/sending/subdomains"),
      "lost"
    );

    await failing(held);
    await expect(
      Promise.all([operationOf(clientId), routed(clientId)])
    ).resolves.toMatchObject([
      { status: "failed", step: "probe", error: "cloudflare_0" },
      false,
    ]);

    await runClientProvision(context, held);
    const mailDomain = clientMailDomain(clientId, domain);
    expect({
      operation: await operationOf(clientId),
      routed: await routed(clientId),
      zones: zonesOf(account),
      // The zone's and the domain's, each once across both runs.
      creates: cloudflare.calls.filter(isMailCreate).map(({ path }) => path),
    }).toMatchObject({
      operation: { status: "done", step: "route" },
      routed: true,
      zones: [
        { name: mailDomain, sending: [{ name: mailDomain, enabled: true }] },
      ],
      creates: [
        "/zones",
        `/zones/${account.zones[0]?.id}/email/sending/subdomains`,
      ],
    });
  });

  it("does nothing once done", async () => {
    const manifest = await importRelease("dedicated");
    const { clientId, held } = await setUp("dedicated", manifest);
    await runClientProvision(context, held);

    const before = cloudflare.calls.length;
    await runClientProvision(context, held);
    expect(cloudflare.calls).toHaveLength(before);
    await expect(operationOf(clientId)).resolves.toMatchObject({
      status: "done",
    });
  });

  it("starting it again resumes the client's one operation, and refuses another release", async () => {
    const manifest = await importRelease("dedicated");
    const { clientId, operationId } = await setUp("dedicated", manifest);
    await expect(
      startClientProvision(db, staff, clientId, manifest.releaseId)
    ).resolves.toBe(operationId);
    const other = await importRelease("dedicated");
    await expect(
      startClientProvision(db, staff, clientId, other.releaseId)
    ).rejects.toMatchObject({ code: "operation_release_changed" });
    await expect(
      db
        .select({ id: clientProvisions.id })
        .from(clientProvisions)
        .where(eq(clientProvisions.clientId, clientId))
    ).resolves.toStrictEqual([{ id: operationId }]);
  });

  it.each(stops)(
    "resumes after stopping at $step, creating nothing twice",
    async ({ stopped, code, plan }) => {
      const manifest = await importRelease("dedicated");
      const { account, clientId, held } = await setUp("dedicated", manifest);
      // Allocated first, so a plan can name the client's scripts: the
      // operation's own allocation finds it.
      await allocateClientResources(db, "system", {
        clientId,
        manifest,
        operationId: "test",
      });
      await plan(account, clientId);

      await failing(held);
      await expect(operationOf(clientId)).resolves.toMatchObject({
        status: "failed",
        step: stopped,
        error: code,
      });
      await expect(routed(clientId)).resolves.toBeFalsy();

      account.unhealthy = 0;
      await runClientProvision(context, held);

      const state = await provisioned(account, clientId);
      expect(state).toMatchObject(once(clientId));
      expect({
        d1: new Set(state.holdings.d1).size,
        buckets: new Set(state.holdings.buckets).size,
        scripts: state.holdings.scripts.length,
        // Neither the failed run nor its retry removes anything.
        deleted: cloudflare.calls
          .filter((call) => call.method === "DELETE")
          .map(({ path }) => path),
      }).toStrictEqual({ d1: 3, buckets: 2, scripts: 2, deleted: [] });
    }
  );

  it("stops a runner that lost the client, which writes nothing more, and its successor finishes", async () => {
    const manifest = await importRelease("dedicated");
    const {
      account,
      clientId,
      held: stale,
    } = await setUp("dedicated", manifest);
    await allocateClientResources(db, "system", {
      clientId,
      manifest,
      operationId: "test",
    });
    const { core } = await scriptsOf(clientId);
    let successor = "";
    // A new attempt takes the client over while the stale one's core upload is in flight.
    cloudflare.beforeAnswering(isUpload(core), async () => {
      successor =
        (await claimRun(
          db,
          staff,
          clientId,
          stale.runId,
          { action: "client.provision_placed", clientId },
          { kind: "provision_placed", runId: `${clientId}-p2` }
        )) ?? "";
    });

    await expect(failing(stale)).resolves.toMatchObject({
      code: "runner_replaced",
    });
    // Neither its upload nor its failure is recorded; run again, it calls nothing.
    const before = cloudflare.calls.length;
    await expect(failing(stale)).resolves.toMatchObject({
      code: "runner_replaced",
    });
    await expect(operationOf(clientId)).resolves.toMatchObject({
      status: "running",
      step: "connect",
      error: null,
    });
    expect(cloudflare.calls).toHaveLength(before);

    await runClientProvision(context, { clientId, runId: successor });
    await expect(provisioned(account, clientId)).resolves.toMatchObject({
      ...once(clientId),
      operation: { status: "done", runId: successor },
    });
  });

  it("leaves the hostname unpublished while core fails its probe", async () => {
    const manifest = await importRelease("dedicated");
    const { account, clientId, held } = await setUp("dedicated", manifest);
    account.unhealthy = 1000;

    await expect(failing(held)).resolves.toMatchObject({
      code: "smoke_check_failed",
    });
    const [client] = await db
      .select({ status: clients.status })
      .from(clients)
      .where(eq(clients.id, clientId));
    expect({
      operation: await operationOf(clientId),
      routed: await routed(clientId),
      status: client?.status,
      // Its inventory stays, for the retry.
      scripts: holdings(account).scripts.length,
    }).toMatchObject({
      operation: {
        status: "failed",
        step: "secrets",
        error: "smoke_check_failed",
      },
      routed: false,
      status: "provisioning",
      scripts: 2,
    });
  });

  it("delivers a secret again on retry when it was deleted after its delivery", async () => {
    const manifest = await importRelease("dedicated");
    const { account, clientId, held } = await setUp("dedicated", manifest);
    account.unhealthy = 1000;
    await expect(failing(held)).resolves.toMatchObject({
      code: "smoke_check_failed",
    });
    const { core } = await scriptsOf(clientId);
    account.scripts.get(core)?.versions.at(-1)?.secrets.delete("ROUTER_SECRET");

    account.unhealthy = 0;
    await runClientProvision(context, held);
    await expect(
      Promise.all([operationOf(clientId), routed(clientId)])
    ).resolves.toMatchObject([{ status: "done" }, true]);
    expect(
      account.scripts.get(core)?.versions.at(-1)?.secrets.get("ROUTER_SECRET")
    ).toBe(await deriveRouterSecret(secrets.routerKey, clientId, 1));
  });

  it.each(refusals)(
    "refuses $name before anything is created or uploaded",
    async ({ kind, spec, adjust, code }) => {
      const manifest = await importRelease(kind, spec, adjust);
      const { account, clientId, held } = await setUp(kind, manifest);

      await expect(failing(held)).resolves.toMatchObject({ code });
      expect({
        operation: await operationOf(clientId),
        databases: account.d1.length,
        zones: account.zones.length,
        uploads: account.scriptUploads.length,
        inventory: await clientInventory(db, clientId),
      }).toMatchObject({
        operation: { status: "failed", step: null, error: code },
        databases: 0,
        zones: 0,
        uploads: 0,
        inventory: [],
      });
    }
  );

  it("uploads into a Workers for Platforms namespace, and stops at the probe it can't qualify", async () => {
    const manifest = await importRelease("workers_for_platforms");
    const { account, clientId, held } = await setUp(
      "workers_for_platforms",
      manifest
    );

    await expect(failing(held)).resolves.toMatchObject({
      code: "probe_unqualified",
    });
    const { core, connect } = await scriptsOf(clientId);
    const scripts = account.namespaces.get(namespace);
    expect({
      operation: await operationOf(clientId),
      inNamespace: [...(scripts?.keys() ?? [])].toSorted(),
      // Nothing outside the namespace.
      outside: account.scripts.size,
      tag: scripts?.get(core)?.migrationTag,
      routerSecret: scripts
        ?.get(core)
        ?.versions.at(-1)
        ?.secrets.has("ROUTER_SECRET"),
      routed: await routed(clientId),
    }).toMatchObject({
      operation: {
        status: "failed",
        step: "secrets",
        error: "probe_unqualified",
      },
      inNamespace: [connect, core].toSorted(),
      outside: 0,
      tag: "v1",
      routerSecret: true,
      routed: false,
    });

    // Run again, it uploads and delivers nothing again.
    const before = cloudflare.calls.length;
    await expect(failing(held)).resolves.toMatchObject({
      code: "probe_unqualified",
    });
    expect(
      cloudflare.calls
        .slice(before)
        // Reading what each database applied is a POST of its own.
        .filter(
          (call) =>
            (call.method === "PUT" || call.method === "POST") &&
            !call.path.endsWith("/query")
        )
        .map(({ path }) => path)
    ).toStrictEqual([]);
  });

  it("keeps two clients in one destination to their own resources", async () => {
    const manifest = await importRelease("dedicated");
    const {
      account,
      destinationId,
      held: firstRun,
    } = await setUp("dedicated", manifest);
    await runClientProvision(context, firstRun);
    const firstVersions = Object.fromEntries(
      [...account.scripts].map(([name, script]) => [
        name,
        script.versions.length,
      ])
    );
    const firstMigrations = await appliedMigrations(account);

    const second = await placedOperation(destinationId, manifest);
    await runClientProvision(context, second.held);

    const { core, connect } = await scriptsOf(second.clientId);
    const database = await resourceOf(second.clientId, "d1:grasp-os-core");
    expect({
      // The first client's scripts and databases are as it left them.
      versions: Object.fromEntries(
        Object.keys(firstVersions).map((name) => [
          name,
          account.scripts.get(name)?.versions.length,
        ])
      ),
      migrations: await appliedMigrations(account),
      // The second's core binds only its own.
      bindings: liveBindings(account, core),
      databases: account.d1.length,
    }).toMatchObject({
      versions: firstVersions,
      migrations: firstMigrations,
      bindings: {
        DB: { id: database.providerId },
        CONNECT: { service: connect },
      },
      databases: 6,
    });
  });

  it("refuses an inventory id that is another client's database, before migrating or binding it", async () => {
    const manifest = await importRelease("dedicated");
    const {
      account,
      clientId: first,
      destinationId,
      held: firstRun,
    } = await setUp("dedicated", manifest);
    await runClientProvision(context, firstRun);
    const firstMigrations = await appliedMigrations(account);
    const victim = await resourceOf(first, "d1:grasp-os-core");

    const second = await placedOperation(destinationId, manifest);
    await allocateClientResources(db, "system", {
      clientId: second.clientId,
      manifest,
      operationId: "test",
    });
    // Its row names the first client's database's id.
    await db
      .update(clientResources)
      .set({
        providerId: victim.providerId,
        createRequestedBy: second.held.runId,
      })
      .where(
        and(
          eq(clientResources.clientId, second.clientId),
          eq(clientResources.role, "d1:grasp-os-core")
        )
      );
    const uploads = account.scriptUploads.length;

    await expect(failing(second.held)).resolves.toMatchObject({
      code: "foreign_resource",
    });
    expect({
      migrations: await appliedMigrations(account),
      uploads: account.scriptUploads.length,
    }).toMatchObject({ migrations: firstMigrations, uploads });
  });

  it("runs as a Workflow, and starting it again resumes the one operation", async () => {
    const manifest = await importRelease("dedicated");
    const account = cloudflare.addAccount();
    const destinationId = await destination({
      kind: "dedicated",
      accountId: account.id,
      namespace: null,
    });
    const { clientId } = await placedClient(destinationId);
    const attempts = await introspectWorkflow(env.PROVISION_PLACED_CLIENT);
    try {
      await attempts.modifyAll(async (modifier) => {
        await modifier.disableRetryDelays();
      });
      // The first attempt is refused connect's upload, and stops.
      cloudflare.failNext(
        (call) =>
          call.method === "PUT" && call.path.endsWith("-grasp-os-connect"),
        400
      );
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
      const [first] = await attempts.get();
      await first?.waitForStatus("errored");
      errors.mockRestore();
      await expect(operationOf(clientId)).resolves.toMatchObject({
        status: "failed",
        step: "migrations",
        error: "cloudflare_400_10000",
      });

      // Started again, a new attempt resumes it.
      await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
      const [, second] = await attempts.get();
      await second?.waitForStatus("complete");
      await expect(provisioned(account, clientId)).resolves.toMatchObject(
        once(clientId)
      );
    } finally {
      await attempts.dispose();
    }
  });
});
