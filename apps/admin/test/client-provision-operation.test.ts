import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";
import { moduleKey } from "@grasp-os/shared/release";
import { deriveRouterSecret } from "@grasp-os/shared/router";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import type { StaffAlert } from "../src/alerts.ts";
import { cloudflareApi } from "../src/cloudflare/api.ts";
import { queryD1 } from "../src/cloudflare/workers.ts";
import {
  auditEvents,
  clientWorkers,
  clientProvisions,
  clientResources,
  clientRuns,
  clients,
  releases,
} from "../src/db/schema.ts";
import { appliedSchema } from "../src/deploy/compatibility.ts";
import {
  clientMailDomain,
  onboardingSender,
} from "../src/deploy/core-config.ts";
import { mappedRoute } from "../src/deploy/router.ts";
import { rotationWindowMs } from "../src/deploy/secrets.ts";
import type { DeploySecrets } from "../src/deploy/secrets.ts";
import {
  allocateClientResources,
  clientInventory,
} from "../src/hosting/inventory.ts";
import {
  runClientProvision,
  startClientProvision,
  startClientRelease,
} from "../src/hosting/operation.ts";
import {
  provisionPlacedClient,
  releasePlacedClient,
} from "../src/hosting/workflow.ts";
import { claimRun } from "../src/runners.ts";
import type { HeldClient } from "../src/runners.ts";
import { envelope, notFound } from "./cloudflare-api-kit.ts";
import type { AccountState, ApiCall } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
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
  observe: { retryDelayMs: 0 },
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

/** The keys of `names` a rotation keeps the previous value of. */
const previousKeys = (names: readonly string[]): string[] =>
  names.filter((name) => name.endsWith("_PREVIOUS"));
/** The rest: what a script runs with once the window has closed. */
const currentKeys = (names: readonly string[]): string[] =>
  names.filter((name) => !name.endsWith("_PREVIOUS"));

/** A user Worker's script in a dispatch namespace: where it's put and read. */
const userScriptPath =
  /\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/u;

/**
 * Cloudflare's read-after-write lag: the next `stale` reads of a user
 * Worker's script after each upload answer as before it, that it isn't
 * there. Returns how many reads were answered so, by script path.
 */
const laggingUploads = (stale: number): Map<string, number> => {
  const behind = new Map<string, number>();
  const answeredStale = new Map<string, number>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    if (userScriptPath.test(pathname)) {
      if (request.method === "PUT") {
        behind.set(pathname, stale);
      } else if (request.method === "GET" && (behind.get(pathname) ?? 0) > 0) {
        behind.set(pathname, (behind.get(pathname) ?? 0) - 1);
        answeredStale.set(pathname, (answeredStale.get(pathname) ?? 0) + 1);
        return notFound();
      }
    }
    return await cloudflare.fetch(input, init);
  });
  return answeredStale;
};

/** A Worker's own script in an account: where its secrets and deployments are read. */
const ownScriptPath = /\/workers\/scripts\/(?<script>[^/]+)\/(?<rest>.+)$/u;

/**
 * Cloudflare's read-after-write lag on what the secrets step and the
 * probe read back: after each `PUT` of an account Worker's secret, the
 * next `stale` reads of its `read` (`secrets` or `deployments`) answer
 * `staleAnswer`, as from before it. Returns how many reads were answered
 * so, by script.
 */
const laggingAfterSecrets = (
  read: "secrets" | "deployments",
  stale: number,
  staleAnswer: unknown
): Map<string, number> => {
  const behind = new Map<string, number>();
  const answeredStale = new Map<string, number>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const found = ownScriptPath.exec(new URL(request.url).pathname)?.groups;
    if (found?.script !== undefined) {
      const { script, rest } = found;
      if (request.method === "PUT" && rest === "secrets") {
        behind.set(script, stale);
      } else if (
        request.method === "GET" &&
        rest === read &&
        (behind.get(script) ?? 0) > 0
      ) {
        behind.set(script, (behind.get(script) ?? 0) - 1);
        answeredStale.set(script, (answeredStale.get(script) ?? 0) + 1);
        return envelope(staleAnswer);
      }
    }
    return await cloudflare.fetch(input, init);
  });
  return answeredStale;
};

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

interface ProbeFailure {
  name: string;
  probe: NonNullable<AccountState["coreProbe"]>;
  code: string;
}

/** Ways core's signed probe doesn't check out, after its health check did. */
const probeFailures: ProbeFailure[] = [
  {
    name: "core from before the probe",
    probe: "absent",
    code: "probe_unanswered",
  },
  {
    name: "core deployed as another client",
    probe: { asClient: "someone-else" },
    code: "probe_identity_mismatch",
  },
  {
    name: "a database that doesn't answer",
    probe: { down: ["KNOWLEDGE"] },
    code: "probe_binding_unanswered",
  },
  {
    name: "a bucket that doesn't answer",
    probe: { down: ["AUDIT_ARCHIVE"] },
    code: "probe_binding_unanswered",
  },
  {
    name: "a Durable Object namespace core can't reach",
    probe: { down: ["WORKSPACES"] },
    code: "probe_binding_unanswered",
  },
  {
    name: "a sandbox that doesn't run App code",
    probe: { down: ["LOADER"] },
    code: "probe_binding_unanswered",
  },
  {
    name: "connect's own database not answering",
    probe: { down: ["connect.DB"] },
    code: "probe_binding_unanswered",
  },
  {
    name: "connect not answering",
    probe: { down: ["CONNECT"], clocksDown: ["connect"] },
    code: "probe_binding_unanswered",
  },
  {
    name: "core's clock not armed",
    probe: { clocksDown: ["core"] },
    code: "probe_clock_unarmed",
  },
  {
    name: "connect's clock not armed",
    probe: { clocksDown: ["connect"] },
    code: "probe_clock_unarmed",
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

/** A client provisioned in a dedicated destination with `first`, and its account. */
const liveClient = async (first: ReleaseManifest) => {
  const set = await setUp("dedicated", first);
  await runClientProvision(context, set.held);
  return set;
};

/**
 * A new attempt holding client `clientId`, in place of the one before if
 * it left its claim (one that stopped), as starting a release claims one.
 */
const attempt = async (clientId: string): Promise<HeldClient> => {
  const before = await db
    .select({ runId: clientRuns.runId })
    .from(clientRuns)
    .where(eq(clientRuns.clientId, clientId))
    .get();
  const runId = await claimRun(
    db,
    staff,
    clientId,
    before?.runId ?? null,
    { action: "client.release_placed", clientId },
    {
      kind: "provision_placed",
      runId: `${clientId}-p${crypto.randomUUID().slice(0, 8)}`,
    }
  );
  if (runId === undefined) {
    throw new Error("The attempt wasn't claimed");
  }
  return { clientId, runId };
};

/** What client `clientId` runs, by Worker, as the admin records it. */
const runs = async (clientId: string) => {
  const rows = await db
    .select({
      worker: clientWorkers.worker,
      releaseId: clientWorkers.releaseId,
    })
    .from(clientWorkers)
    .where(eq(clientWorkers.clientId, clientId));
  return Object.fromEntries(
    rows.map(({ worker, releaseId }) => [worker, releaseId])
  );
};

/** What `promise` was refused with, as its code, or `started`. */
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error && "code" in error
      ? String(error.code)
      : "thrown";
  }
  return "started";
};

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
    // as the client, with the router secret the router will send.
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
        CLIENT_ID: { type: "json", json: clientId },
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

  it.each(probeFailures)(
    "leaves the hostname unpublished while core's signed probe finds $name, and resumes once it checks out",
    async ({ probe, code }) => {
      const manifest = await importRelease("dedicated");
      const { account, clientId, held } = await setUp("dedicated", manifest);
      account.coreProbe = probe;

      await expect(failing(held)).resolves.toMatchObject({ code });
      expect({
        operation: await operationOf(clientId),
        routed: await routed(clientId),
      }).toMatchObject({
        operation: { status: "failed", step: "secrets", error: code },
        routed: false,
      });

      delete account.coreProbe;
      await runClientProvision(context, held);
      await expect(provisioned(account, clientId)).resolves.toMatchObject(
        once(clientId)
      );
    }
  );

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

  it("reads an upload back through Cloudflare's lag, and goes on", async () => {
    const manifest = await importRelease("workers_for_platforms");
    const { held, clientId } = await setUp("workers_for_platforms", manifest);
    const stale = laggingUploads(3);

    await expect(failing(held)).resolves.toMatchObject({
      code: "probe_unqualified",
    });
    expect({
      operation: await operationOf(clientId),
      staleReads: [...stale.values()],
    }).toMatchObject({
      operation: { status: "failed", error: "probe_unqualified" },
      // Each Worker's upload read back once the lag passed.
      staleReads: [3, 3],
    });
  });

  it("stops at an upload that never reads back, after a bounded number of tries", async () => {
    const manifest = await importRelease("workers_for_platforms");
    const { held, clientId } = await setUp("workers_for_platforms", manifest);
    const stale = laggingUploads(Number.POSITIVE_INFINITY);

    await expect(failing(held)).resolves.toMatchObject({
      code: "upload_unobserved",
    });
    expect({
      operation: await operationOf(clientId),
      staleReads: [...stale.values()],
    }).toMatchObject({
      operation: { status: "failed", error: "upload_unobserved" },
      // Connect's, read six times, then the run stopped.
      staleReads: [6],
    });
  });

  it("reads delivered secrets back through Cloudflare's lag, and goes on", async () => {
    const manifest = await importRelease("dedicated");
    const { clientId, held } = await setUp("dedicated", manifest);
    // The secrets listed as before the last delivery: none of them.
    const stale = laggingAfterSecrets("secrets", 3, []);

    await runClientProvision(context, held);

    expect({
      operation: await operationOf(clientId),
      staleReads: [...stale.values()],
    }).toMatchObject({
      operation: { status: "done" },
      // Each Worker's secrets read back once the lag passed.
      staleReads: [3, 3],
    });
  });

  it("reads core's live version back through Cloudflare's lag, and goes on", async () => {
    const manifest = await importRelease("dedicated");
    const { clientId, held } = await setUp("dedicated", manifest);
    // Its deployments as before its upload: none live.
    const stale = laggingAfterSecrets("deployments", 3, { deployments: [] });

    await runClientProvision(context, held);
    const { core } = await scriptsOf(clientId);

    expect({
      operation: await operationOf(clientId),
      staleReads: stale.get(core),
    }).toMatchObject({ operation: { status: "done" }, staleReads: 3 });
  });

  it("removes the secrets a placed client's scripts are no longer given, once the ones they are given are there", async () => {
    const manifest = await importRelease("workers_for_platforms");
    const { account, clientId, held } = await setUp(
      "workers_for_platforms",
      manifest
    );
    // Rotated, and not live yet: each key that rotates goes with its
    // previous value too.
    await db
      .update(clients)
      .set({ generation: 2, rotatedAt: new Date() })
      .where(eq(clients.id, clientId));
    await expect(failing(held)).resolves.toMatchObject({
      code: "probe_unqualified",
    });
    const { core, connect } = await scriptsOf(clientId);
    const scripts = account.namespaces.get(namespace);
    const secretsOn = (script: string): Map<string, string> =>
      scripts?.get(script)?.versions.at(-1)?.secrets ??
      new Map<string, string>();
    const namesOn = (script: string): string[] =>
      [...secretsOn(script).keys()].toSorted((a, b) => a.localeCompare(b));
    const rotating = { core: namesOn(core), connect: namesOn(connect) };

    // The window has closed since, and something set a secret the admin
    // doesn't give.
    await db
      .update(clients)
      .set({ rotationLiveAt: new Date(Date.now() - rotationWindowMs - 1000) })
      .where(eq(clients.id, clientId));
    secretsOn(core).set("STRAY_KEY", "stray-value");
    const before = cloudflare.calls.length;
    await expect(failing(held)).resolves.toMatchObject({
      code: "probe_unqualified",
    });
    const writes = cloudflare.calls
      .slice(before)
      .filter(
        ({ method, path }) => path.includes("/secrets") && method !== "GET"
      );
    // Each script's secrets: every one given put before any is removed.
    const putsThenDeletes = (script: string): boolean => {
      const methods = writes
        .filter(({ path }) => path.includes(`/scripts/${script}/`))
        .map(({ method }) => method);
      return (
        methods.includes("DELETE") &&
        methods.lastIndexOf("PUT") < methods.indexOf("DELETE")
      );
    };

    expect({
      rotating: {
        core: previousKeys(rotating.core),
        connect: previousKeys(rotating.connect),
      },
      after: { core: namesOn(core), connect: namesOn(connect) },
      putsThenDeletes: [putsThenDeletes(core), putsThenDeletes(connect)],
    }).toStrictEqual({
      rotating: {
        core: ["ROUTER_SECRET_PREVIOUS"],
        connect: [
          "CAPABILITY_SIGNING_KEY_PREVIOUS",
          "TOKEN_ENCRYPTION_KEY_PREVIOUS",
        ],
      },
      after: {
        core: currentKeys(rotating.core),
        // Its previous vault key stays: tokens may still be sealed under it.
        connect: [
          ...currentKeys(rotating.connect),
          "TOKEN_ENCRYPTION_KEY_PREVIOUS",
        ].toSorted((a, b) => a.localeCompare(b)),
      },
      putsThenDeletes: [true, true],
    });

    // The step names what it removed, never a value.
    const steps = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "provision.secrets")
        )
      );
    const removed = steps
      .map(({ detail }) =>
        z
          .object({ revokedNames: z.string().optional() })
          .loose()
          .safeParse(JSON.parse(detail ?? "{}"))
      )
      .flatMap((parsed) =>
        parsed.success
          ? (parsed.data.revokedNames ?? "").split(",").filter(Boolean)
          : []
      )
      .toSorted((a, b) => a.localeCompare(b));
    expect(removed).toStrictEqual([
      "CAPABILITY_SIGNING_KEY_PREVIOUS",
      "ROUTER_SECRET_PREVIOUS",
      "STRAY_KEY",
    ]);

    // No value the scripts ran with is in what the admin recorded.
    const values = [
      ...secretsOn(core).values(),
      ...secretsOn(connect).values(),
    ].filter((value): value is string => typeof value === "string");
    const recorded = JSON.stringify({
      audit: await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.clientId, clientId)),
      operation: await operationOf(clientId),
    });
    expect(values.filter((value) => recorded.includes(value))).toStrictEqual(
      []
    );
  });

  it("keeps every secret it gives when a removal fails partway, and a retry finishes the removal", async () => {
    const manifest = await importRelease("workers_for_platforms");
    const { account, clientId, held } = await setUp(
      "workers_for_platforms",
      manifest
    );
    await expect(failing(held)).resolves.toMatchObject({
      code: "probe_unqualified",
    });
    const { core } = await scriptsOf(clientId);
    const onCore = (): Map<string, string> =>
      account.namespaces.get(namespace)?.get(core)?.versions.at(-1)?.secrets ??
      new Map<string, string>();
    const given = [...onCore().keys()];
    onCore().set("STRAY_ONE", "one");
    onCore().set("STRAY_TWO", "two");
    // Removing the second keeps failing, as an API error would, its
    // retries too, until the run gives up.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.method === "DELETE" &&
        request.url.endsWith("/secrets/STRAY_TWO")
      ) {
        return Response.json(
          {
            success: false,
            errors: [{ code: 10_013, message: "An unknown error" }],
            messages: [],
            result: null,
          },
          { status: 500 }
        );
      }
      return await cloudflare.fetch(input, init);
    });

    await expect(failing(held)).resolves.toBeDefined();
    const afterFailure = new Set(onCore().keys());
    vi.mocked(globalThis.fetch).mockImplementation(cloudflare.fetch);
    await expect(failing(held)).resolves.toMatchObject({
      code: "probe_unqualified",
    });

    expect({
      keptGiven: given.every((name) => afterFailure.has(name)),
      strayLeftAfterFailure: afterFailure.has("STRAY_TWO"),
      afterRetry: [...onCore().keys()].toSorted((a, b) => a.localeCompare(b)),
    }).toStrictEqual({
      keptGiven: true,
      strayLeftAfterFailure: true,
      afterRetry: given.toSorted((a, b) => a.localeCompare(b)),
    });
  });

  it("removes a secret it doesn't give from a script it already delivered to, while a rotation keeps connect's previous vault key", async () => {
    const manifest = await importRelease("workers_for_platforms");
    const { account, clientId, held } = await setUp(
      "workers_for_platforms",
      manifest
    );
    // Rotating: connect is given TOKEN_ENCRYPTION_KEY_PREVIOUS, the key
    // it would keep anyway.
    await db
      .update(clients)
      .set({ generation: 2, rotatedAt: new Date() })
      .where(eq(clients.id, clientId));
    await expect(failing(held)).resolves.toMatchObject({
      code: "probe_unqualified",
    });
    const { connect } = await scriptsOf(clientId);
    const secretsOn = (script: string): Map<string, string> =>
      account.namespaces.get(namespace)?.get(script)?.versions.at(-1)
        ?.secrets ?? new Map<string, string>();

    // Delivered already, and recorded so: one secret more on connect.
    secretsOn(connect).set("STRAY_KEY", "stray-value");
    await expect(failing(held)).resolves.toMatchObject({
      code: "probe_unqualified",
    });

    expect(secretsOn(connect).has("STRAY_KEY")).toBeFalsy();
  });

  it("records each secret it removes as it removes it, so a run that fails after one keeps its name", async () => {
    const manifest = await importRelease("workers_for_platforms");
    const { account, clientId, held } = await setUp(
      "workers_for_platforms",
      manifest
    );
    await expect(failing(held)).resolves.toMatchObject({
      code: "probe_unqualified",
    });
    const { core } = await scriptsOf(clientId);
    const strayed = account.namespaces
      .get(namespace)
      ?.get(core)
      ?.versions.at(-1)?.secrets;
    strayed?.set("STRAY_A", "a-value");
    strayed?.set("STRAY_B", "b-value");
    // The second removal is refused: the run stops there.
    let deletes = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.method === "DELETE" &&
        new URL(request.url).pathname.includes("/secrets/")
      ) {
        deletes += 1;
        if (deletes === 2) {
          return Response.json(
            {
              success: false,
              errors: [{ code: 10_000, message: "Refused" }],
              messages: [],
              result: null,
            },
            { status: 400 }
          );
        }
      }
      return await cloudflare.fetch(input, init);
    });

    const error = await failing(held);
    const recorded = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "provision.secret_revoked")
        )
      );
    const names = recorded.map(
      ({ detail }) =>
        z
          .object({ script: z.string(), name: z.string() })
          .loose()
          .parse(JSON.parse(detail ?? "{}")).name
    );
    const now = account.namespaces
      .get(namespace)
      ?.get(core)
      ?.versions.at(-1)?.secrets;
    const strays = ["STRAY_A", "STRAY_B"].filter(
      (name) => now?.has(name) === true
    );

    expect({
      failed: error !== null,
      // One removed before the refusal, and recorded; the other still there.
      recorded: names,
      left: strays,
    }).toStrictEqual({
      failed: true,
      recorded: ["STRAY_A", "STRAY_B"].filter((name) => !strays.includes(name)),
      left: [strays[0]],
    });
    expect(strays).toHaveLength(1);
  });

  it("marks a rotated client's generation live once its hostname is published, and audits it", async () => {
    const manifest = await importRelease("dedicated");
    const { clientId, held } = await setUp("dedicated", manifest);
    await db
      .update(clients)
      .set({ generation: 2, rotatedAt: new Date() })
      .where(eq(clients.id, clientId));

    await runClientProvision(context, held);

    const client = await db
      .select({ rotationLiveAt: clients.rotationLiveAt })
      .from(clients)
      .where(eq(clients.id, clientId))
      .get();
    const live = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "client.rotation_live")
        )
      );
    expect({
      live: client?.rotationLiveAt instanceof Date,
      audited: live.map(
        ({ detail }) =>
          z.object({ generation: z.number() }).parse(JSON.parse(detail ?? "{}"))
            .generation
      ),
    }).toStrictEqual({ live: true, audited: [2] });
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

  // Its later releases and rollbacks (spec 40.3, 40.4): the same
  // operation, run again for the release, onto the same stable scripts
  // and the client's own resources. How they can fail, each tried below:
  // - a release of a client not live yet, or over an operation still
  //   running another release, or two at once;
  // - a script taken back past a Durable Object migration it ran, by a
  //   rollback or a release to an older one, refused before any upload;
  // - a rollback with nothing before to go back to;
  // - a release that stops part way, resumed: nothing made twice, and its
  //   hostname not moved until it passes its probe;
  // - a release whose code, live on the stable scripts, fails its probe:
  //   rolled back on its own, audited, and staff told, also when the
  //   rollback doesn't finish.

  it("releases a live client to a later release on its stable scripts, migrating its databases and probing it before it's done", async () => {
    const first = await importRelease("dedicated");
    const { account, clientId } = await liveClient(first);
    const scripts = await scriptsOf(clientId);
    const uploadsBefore = account.scriptUploads.length;
    const later = await importRelease("dedicated", {
      notes: "feat(core): later",
      migrations: {
        "0000_init.sql": "CREATE TABLE a (id TEXT);",
        "0001_more.sql": "CREATE TABLE b (id TEXT);",
      },
    });

    await startClientRelease(db, staff, clientId, {
      releaseId: later.releaseId,
    });
    await runClientProvision(context, await attempt(clientId));

    expect({
      operation: await operationOf(clientId),
      runs: await runs(clientId),
      // The same two scripts, each uploaded once more: connect, then core.
      uploads: account.scriptUploads
        .slice(uploadsBefore)
        .map(({ script }) => script),
      scripts: holdings(account).scripts,
      applied: Object.values(await appliedMigrations(account)).some(
        (names) => names.join(",") === "0000_init.sql,0001_more.sql"
      ),
      route: await mappedRoute(env.ROUTER_HOSTS, `${clientId}.${domain}`),
    }).toMatchObject({
      operation: {
        releaseId: later.releaseId,
        previousReleaseId: first.releaseId,
        status: "done",
        error: null,
      },
      runs: { core: later.releaseId, connect: later.releaseId },
      uploads: [scripts.connect, scripts.core],
      scripts: [scripts.connect, scripts.core].toSorted(),
      applied: true,
      route: { clientId, generation: 1 },
    });
  });

  it("rolls a live client back to the release it ran before, and refuses past a Durable Object migration or with nothing before", async () => {
    const first = await importRelease("dedicated");
    const { account, clientId } = await liveClient(first);
    const nothing = await codeOf(
      startClientRelease(db, staff, clientId, { rollback: true })
    );
    const second = await importRelease("dedicated", {
      notes: "feat(core): second",
    });
    await startClientRelease(db, staff, clientId, {
      releaseId: second.releaseId,
    });
    await runClientProvision(context, await attempt(clientId));

    await startClientRelease(db, staff, clientId, { rollback: true });
    await runClientProvision(context, await attempt(clientId));
    const back = {
      operation: await operationOf(clientId),
      runs: await runs(clientId),
    };

    // A release that adds a Durable Object migration can't be rolled back.
    const third = await importRelease(
      "dedicated",
      { notes: "feat(core): new class" },
      (core) => ({
        ...core,
        durableObjectMigrations: [
          ...core.durableObjectMigrations,
          { tag: "v2", new_sqlite_classes: ["Extra"] },
        ],
      })
    );
    await startClientRelease(db, staff, clientId, {
      releaseId: third.releaseId,
    });
    await runClientProvision(context, await attempt(clientId));
    const past = await codeOf(
      startClientRelease(db, staff, clientId, { rollback: true })
    );
    // Nor released to an older one without it, before anything uploads.
    const uploads = account.scriptUploads.length;
    const behind = await codeOf(
      startClientRelease(db, staff, clientId, { releaseId: second.releaseId })
    );

    expect({
      nothing,
      back,
      past,
      behind,
      uploaded: account.scriptUploads.length - uploads,
    }).toMatchObject({
      nothing: "nothing_to_roll_back",
      back: {
        operation: {
          releaseId: first.releaseId,
          previousReleaseId: second.releaseId,
          status: "done",
        },
        runs: { core: first.releaseId, connect: first.releaseId },
      },
      past: "rollback_past_migration",
      behind: "release_behind_migration",
      uploaded: 0,
    });
  });

  it("rolls back a release that stopped before any script ran its new Durable Object migration, and keeps the schema a stopped release migrated to", async () => {
    const first = await importRelease("dedicated");
    const { clientId } = await liveClient(first);
    const { connect } = await scriptsOf(clientId);
    // Declares a new class and a migration of its databases; stops at
    // connect's upload, after its databases migrated and before any
    // script ran the class's migration.
    const later = await importRelease(
      "dedicated",
      {
        notes: "feat(core): new class, new table",
        migrations: {
          "0000_init.sql": "CREATE TABLE a (id TEXT);",
          "0001_more.sql": "CREATE TABLE b (id TEXT);",
        },
      },
      (core) => ({
        ...core,
        durableObjectMigrations: [
          ...core.durableObjectMigrations,
          { tag: "v2", new_sqlite_classes: ["Extra"] },
        ],
      })
    );
    await startClientRelease(db, staff, clientId, {
      releaseId: later.releaseId,
    });
    cloudflare.failNext(isUpload(connect), 400);
    await failing(await attempt(clientId));

    const back = await codeOf(
      startClientRelease(db, staff, clientId, { rollback: true })
    );
    const schema = await appliedSchema(db, clientId);

    expect({ back, schema: schema?.releaseId }).toStrictEqual({
      back: "started",
      // Back on the release before, its databases stay at the later one's.
      schema: later.releaseId,
    });
  });

  it("never lowers what a script ran on a stale read: an upload whose answer was lost still keeps a rollback from going back past its migration", async () => {
    const first = await importRelease("dedicated");
    const { account, clientId } = await liveClient(first);
    const { core } = await scriptsOf(clientId);
    const later = await importRelease(
      "dedicated",
      { notes: "feat(core): new class", core: "export default { core: 9 };" },
      (entry) => ({
        ...entry,
        durableObjectMigrations: [
          ...entry.durableObjectMigrations,
          { tag: "v2", new_sqlite_classes: ["Extra"] },
        ],
      })
    );
    await startClientRelease(db, staff, clientId, {
      releaseId: later.releaseId,
    });
    // Core's upload runs its migration, and the answer never arrives.
    cloudflare.failNext(isUpload(core), "lost");
    await failing(await attempt(clientId));
    // Resumed: core reads at the migration before, as a stale read would,
    // and the upload stops before it's sent (its module gone from the store).
    const script = account.scripts.get(core);
    if (script === undefined) {
      throw new Error("core isn't in the fake");
    }
    script.migrationTag = "v1";
    const [module] = later.workers.core?.modules ?? [];
    await env.RELEASES.delete(moduleKey(module?.sha256 ?? ""));
    await failing(await attempt(clientId));
    script.migrationTag = "v2";

    const back = await codeOf(
      startClientRelease(db, staff, clientId, { rollback: true })
    );

    expect(back).toBe("rollback_past_migration");
  });

  it("refuses a release of a client not live yet, or while its operation runs, and one of two at once", async () => {
    const first = await importRelease("dedicated");
    const pending = await setUp("dedicated", first);
    const later = await importRelease("dedicated", {
      notes: "feat(core): later",
    });

    const notLive = await codeOf(
      startClientRelease(db, staff, pending.clientId, {
        releaseId: later.releaseId,
      })
    );
    const { clientId } = await liveClient(first);
    const both = await Promise.all([
      codeOf(
        startClientRelease(db, staff, clientId, { releaseId: later.releaseId })
      ),
      codeOf(startClientRelease(db, staff, clientId, { rollback: true })),
    ]);
    const running = await codeOf(
      startClientRelease(db, staff, clientId, { releaseId: first.releaseId })
    );
    // The release itself, still running with no runner going: resumed.
    const resumed = await codeOf(
      startClientRelease(db, staff, clientId, { releaseId: later.releaseId })
    );

    expect({
      notLive,
      both: both.toSorted(),
      running,
      resumed,
      operation: await operationOf(clientId),
    }).toMatchObject({
      notLive: "client_not_active",
      // The rollback has nothing before; the release takes the operation.
      both: ["nothing_to_roll_back", "started"],
      running: "operation_running",
      resumed: "started",
      operation: { releaseId: later.releaseId, status: "running" },
    });
  });

  it("resumes a release that stopped part way, leaving its hostname where it was until it passes its probe", async () => {
    const first = await importRelease("dedicated");
    const { account, clientId } = await liveClient(first);
    const later = await importRelease("dedicated", {
      notes: "feat(core): later",
    });
    await startClientRelease(db, staff, clientId, {
      releaseId: later.releaseId,
    });
    // Core's upload is refused: connect runs the later release already.
    cloudflare.failNext(
      (call) => call.method === "PUT" && call.path.endsWith("-grasp-os-core"),
      400
    );
    await expect(failing(await attempt(clientId))).resolves.toMatchObject({
      status: 400,
    });
    const stopped = {
      operation: await operationOf(clientId),
      route: await mappedRoute(env.ROUTER_HOSTS, `${clientId}.${domain}`),
    };

    // Started again, it resumes: connect isn't uploaded twice.
    await startClientRelease(db, staff, clientId, {
      releaseId: later.releaseId,
    });
    const uploadsBefore = account.scriptUploads.length;
    await runClientProvision(context, await attempt(clientId));
    const { core } = await scriptsOf(clientId);

    expect({
      stopped,
      resumed: account.scriptUploads
        .slice(uploadsBefore)
        .map(({ script }) => script),
      operation: await operationOf(clientId),
    }).toMatchObject({
      stopped: {
        operation: {
          releaseId: later.releaseId,
          status: "failed",
          error: "cloudflare_400_10000",
        },
        route: { clientId, generation: 1 },
      },
      resumed: [core],
      operation: { releaseId: later.releaseId, status: "done" },
    });
  });

  it("rolls a release that fails its probe once live back to the release before on its own, audited, and tells staff", async () => {
    const first = await importRelease("dedicated");
    const { account, clientId } = await liveClient(first);
    const later = await importRelease("dedicated", {
      notes: "feat(core): broken once live",
    });
    // What staff are told, as the Workflow sends it (src/alerts.ts).
    const alert = vi
      .fn<(alert: StaffAlert) => Promise<void>>()
      .mockResolvedValue();
    const alerting = { ...context, alert };
    const { connect } = await scriptsOf(clientId);
    // The release's core answers as another client; once the release's
    // connect went, the next upload of connect (the rollback's) finds core
    // answering as it should again.
    account.coreProbe = { asClient: "someone-else" };
    // oxlint-disable require-await -- the fake waits on these; nothing to wait for
    cloudflare.beforeAnswering(isUpload(connect), async () => {
      cloudflare.beforeAnswering(isUpload(connect), async () => {
        delete account.coreProbe;
      });
    });
    // oxlint-enable require-await

    await startClientRelease(db, staff, clientId, {
      releaseId: later.releaseId,
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runClientProvision(alerting, await attempt(clientId));
    } finally {
      errors.mockRestore();
    }
    const [rolledBack] = await db
      .select({ actor: auditEvents.actor, detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "release.rollback")
        )
      );

    // A rollback that fails its probe too: thrown, and staff told so; an
    // alert that can't be sent hides neither.
    const unsent = vi
      .fn<(alert: StaffAlert) => Promise<void>>()
      .mockRejectedValue(new Error("channel down"));
    const stuck = await liveClient(first);
    await startClientRelease(db, staff, stuck.clientId, {
      releaseId: later.releaseId,
    });
    stuck.account.coreProbe = { asClient: "someone-else" };
    const stuckErrors = vi.spyOn(console, "error").mockImplementation(() => {});
    const stuckError = await runClientProvision(
      { ...context, alert: unsent },
      await attempt(stuck.clientId)
    ).then(
      () => null,
      (error: unknown) => error
    );
    stuckErrors.mockRestore();

    expect({
      operation: await operationOf(clientId),
      runs: await runs(clientId),
      rolledBack: {
        actor: rolledBack?.actor,
        detail: z.unknown().parse(JSON.parse(rolledBack?.detail ?? "null")),
      },
      stuck: {
        error: stuckError,
        operation: await operationOf(stuck.clientId),
      },
      alerts: [...alert.mock.calls, ...unsent.mock.calls].map(([sent]) => sent),
    }).toMatchObject({
      operation: { releaseId: first.releaseId, status: "done" },
      runs: { core: first.releaseId, connect: first.releaseId },
      rolledBack: {
        actor: "system",
        detail: { from: later.releaseId, cause: "probe_identity_mismatch" },
      },
      stuck: {
        error: { code: "probe_identity_mismatch" },
        operation: { releaseId: first.releaseId, status: "failed" },
      },
      alerts: [
        { clientId, kind: "release_rolled_back", subject: later.releaseId },
        {
          clientId: stuck.clientId,
          kind: "release_rollback_failed",
          subject: later.releaseId,
        },
      ],
    });
  });

  it("releases a live client through its Workflow, as staff start it", async () => {
    const first = await importRelease("dedicated");
    const { clientId } = await liveClient(first);
    const later = await importRelease("dedicated", {
      notes: "feat(core): later",
    });
    const attempts = await introspectWorkflow(env.PROVISION_PLACED_CLIENT);
    try {
      await attempts.modifyAll(async (modifier) => {
        await modifier.disableRetryDelays();
      });
      await releasePlacedClient(env, staff, clientId, {
        releaseId: later.releaseId,
      });
      const [only] = await attempts.get();
      await only?.waitForStatus("complete");
      await expect(runs(clientId)).resolves.toStrictEqual({
        core: later.releaseId,
        connect: later.releaseId,
      });
    } finally {
      await attempts.dispose();
    }
  });
});
