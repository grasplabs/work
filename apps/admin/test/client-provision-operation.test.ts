import {
  clientsNamespace,
  placedModelGateway,
  platformWorkerName,
  stageOfNamespace,
} from "@grasp-os/shared/names";
import type { Stage } from "@grasp-os/shared/names";
import {
  connectVersionPath,
  provisionProbePath,
} from "@grasp-os/shared/provision-probe";
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";
import { moduleKey, releaseManifestSchema } from "@grasp-os/shared/release";
import { deriveRouterSecret, routerHostKey } from "@grasp-os/shared/router";
import { env } from "cloudflare:workers";
import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import golden from "../../../scripts/release/testdata/golden-manifest.json" with { type: "json" };
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
import { deployContext } from "../src/deploy/context.ts";
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
  deletePlacedClient,
  offboardPlacedClient,
} from "../src/hosting/offboarding.ts";
import {
  ProvisionOperationError,
  runClientProvision,
  sendsSettled,
  startClientProvision,
  startClientRelease,
} from "../src/hosting/operation.ts";
import {
  provisionPlacedClient,
  releasePlacedClient,
} from "../src/hosting/workflow.ts";
import {
  claimRun,
  currentRun,
  startingMs,
  takeAttempt,
} from "../src/runners.ts";
import type { HeldClient } from "../src/runners.ts";
import { adminWorkflows } from "../src/workflow-runs.ts";
import { envelope, notFound } from "./cloudflare-api-kit.ts";
import type { AccountState, ApiCall } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, destination, placedClient, staff } from "./hosting.ts";
import { buildRelease, evidenceFor, putBlobs, testLimits } from "./releases.ts";
import type { ReleaseSpec } from "./releases.ts";
import {
  deliverAlarm,
  ended,
  holdBatchOf,
  holdFirstBatchOf,
  journalOf,
  startsOf,
  timeOutAttempt,
} from "./runs.ts";
import type { LostWrite } from "./runs.ts";
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
  router: {
    hosts: env.ROUTER_HOSTS,
    domain,
    smoke: { retryDelayMs: 0 },
    // The stage these tests' admin serves (deploy/context.ts sets it).
    namespace: clientsNamespace("production"),
  },
  observe: { retryDelayMs: 0 },
};
const namespace = clientsNamespace("production");
/** The namespace the admin and the router bind in these tests. */
const clientDispatchNamespace = clientsNamespace("production");

type Kind = "dedicated" | "workers_for_platforms";

/** The binding kinds Workers for Platforms documents for user Workers. */
const documented = new Set([
  "d1",
  "r2_bucket",
  "durable_object_namespace",
  "assets",
]);

/** Core binding its connect, as the real one does (`adjust` for `importRelease`). */
const bindsConnect = (core: WorkerEntry): WorkerEntry => ({
  ...core,
  bindings: [
    ...core.bindings,
    { type: "service", name: "CONNECT", service: "grasp-os-connect" },
  ],
});

/**
 * A release imported for a placed client: core binds its own Durable
 * Object classes, as the real one does, and nothing a placed client
 * refuses outright (Workflows). For a Workers for Platforms
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
    limitEvidence: built.limitEvidenceText ?? null,
    builtAt: now,
    importedAt: now,
  });
  return manifest;
};

/**
 * The release as `release:build` makes it from the real wrangler.jsonc of
 * core and connect (its golden test, scripts/release/manifest-lib.test.ts,
 * keeps it theirs): every binding, cron and Durable Object migration of
 * theirs, on the modules, assets and migrations of a test release, which
 * the bucket holds. Imported; `adjust` changes each Worker first.
 */
const importRealRelease = async (
  adjust: (worker: WorkerEntry) => WorkerEntry = (worker) => worker
): Promise<ReleaseManifest> => {
  const real = releaseManifestSchema.parse(golden);
  const built = await buildRelease({ notes: "feat(core): the real one" });
  const workers = Object.fromEntries(
    Object.entries(built.manifest.workers).map(([name, worker]) => {
      const own = real.workers[name];
      if (own === undefined) {
        throw new Error(`The real release has no ${name}`);
      }
      return [
        name,
        adjust({
          ...worker,
          bindings: own.bindings,
          crons: own.crons,
          durableObjectMigrations: own.durableObjectMigrations,
          requiredSecrets: own.requiredSecrets,
          compatibilityFlags: own.compatibilityFlags,
        }),
      ];
    })
  );
  const manifest: ReleaseManifest = { ...built.manifest, workers };
  await putBlobs(built);
  const now = new Date();
  await db.insert(releases).values({
    id: manifest.releaseId,
    commitSha: manifest.commit,
    manifest: JSON.stringify(manifest),
    manifestSha256: "0".repeat(64),
    limitEvidence: built.limitEvidenceText ?? null,
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
  // Claimed first: only the holder starts the operation.
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
  const operationId = await startClientProvision(
    db,
    staff,
    held,
    manifest.releaseId
  );
  return { clientId, operationId, held };
};

/** A client placed in a new destination of `kind` on a new account, its operation started and claimed. */
const setUp = async (
  kind: Kind,
  manifest: ReleaseManifest,
  inNamespace = namespace
) => {
  const account = cloudflare.addAccount();
  if (kind === "workers_for_platforms") {
    account.namespaces.set(inNamespace, new Map());
  }
  const destinationId = await destination(
    {
      kind,
      accountId: account.id,
      namespace: kind === "workers_for_platforms" ? inNamespace : null,
    },
    stageOfNamespace(inNamespace) ?? "production"
  );
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

/** A core script's upload, wherever it's put. */
const isCoreUpload = ({ method, path }: ApiCall): boolean =>
  method === "PUT" && path.endsWith("-core");

/** The code an operation's failure carries, or what it was. */
const codeFrom = (outcome: unknown): unknown =>
  outcome instanceof Error && "code" in outcome ? outcome.code : outcome;

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

/** A migration sent, with its record (`applyD1Migrations`). */
const isMigration = (call: ApiCall): boolean =>
  call.path.endsWith("/query") &&
  JSON.stringify(call.body).includes("INSERT INTO d1_migrations");

/** A read of which migrations a database has had (`applyD1Migrations`). */
const readMigrations = (call: ApiCall): boolean =>
  call.path.endsWith("/query") &&
  JSON.stringify(call.body).includes("SELECT name FROM d1_migrations");

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
  /** Its `previousRelease` names a release imported just before it. */
  follows?: true;
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
    name: "a release built before platform limits were recorded",
    kind: "dedicated",
    spec: { platformLimits: null },
    code: "release_without_limits",
  },
  {
    name: "a release raising a platform limit with evidence for on-premises only",
    kind: "dedicated",
    spec: {
      platformLimits: { ...testLimits, workflowSteps: 2000 },
      previousRelease: {
        releaseId: "r000000001-0000000",
        platformLimits: testLimits,
      },
      limitEvidence: (release) => [
        evidenceFor(release, "workflowSteps", 2000, "workerd"),
      ],
    },
    follows: true,
    code: "limit_evidence_missing",
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
    name: "a release with a binding Workers for Platforms doesn't document",
    kind: "workers_for_platforms",
    adjust: (core) => ({
      ...core,
      bindings: [...core.bindings, { type: "kv_namespace", name: "CACHE" }],
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

/** When client `clientId` was offboarded, moved `days` into the past. */
const offboardedDaysAgo = async (clientId: string, days: number) => {
  await db
    .update(clients)
    .set({ offboardedAt: new Date(Date.now() - days * 86_400_000) })
    .where(eq(clients.id, clientId));
};

/**
 * Holds the next call `matches` picks out once it has been answered, until
 * released: its caller has read the answer, and does nothing with it yet.
 */
const heldAfter = (matches: (call: ApiCall) => boolean) => {
  let answered = false;
  const released = Promise.withResolvers<unknown>();
  cloudflare.afterAnswering(matches, async () => {
    answered = true;
    await released.promise;
  });
  return {
    read: async () => {
      await vi.waitFor(() => {
        if (!answered) {
          throw new Error("The call hasn't been answered yet");
        }
      });
    },
    release: () => {
      released.resolve(true);
    },
  };
};

/** Waits until attempt `id` ended, and checks it ended `status`. */
const attemptEnded = async (
  id: string | undefined,
  status: string
): Promise<void> => {
  if (id === undefined) {
    throw new Error("No such attempt was started");
  }
  await expect(
    ended(adminWorkflows.provisionPlacedClient, id)
  ).resolves.toMatchObject({ status });
};

describe("provisioning a placed client", () => {
  useStoreSecrets({ deployer: token });

  it.each(["", "Production", "prod", "staging "])(
    "runs no operation for an admin whose STAGE is %j, before any Cloudflare call",
    async (stage) => {
      const manifest = await importRelease("dedicated");
      const { clientId, held } = await setUp("dedicated", manifest);
      const before = cloudflare.calls.length;

      // The admin as its deploy left it, its STAGE misconfigured: never
      // taken for production. Set as a deploy could, past what the
      // generated types allow.
      const deployed = { ...env };
      Reflect.set(deployed, "STAGE", stage);
      const misconfigured = await deployContext(deployed);
      const refused = await runClientProvision(misconfigured, held).then(
        () => null,
        (error: unknown) => error
      );

      expect({
        refused: refused instanceof ProvisionOperationError && refused.code,
        operation: await operationOf(clientId),
        calls: cloudflare.calls.length - before,
      }).toMatchObject({
        refused: "stage_unset",
        operation: { status: "failed", step: null, error: "stage_unset" },
        calls: 0,
      });
    }
  );

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
    const { clientId, operationId, held } = await setUp("dedicated", manifest);
    await expect(
      startClientProvision(db, staff, held, manifest.releaseId)
    ).resolves.toBe(operationId);
    const other = await importRelease("dedicated");
    await expect(
      startClientProvision(db, staff, held, other.releaseId)
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
    async ({ kind, spec, adjust, follows, code }) => {
      const before = follows === true ? await importRelease(kind) : null;
      const previous =
        before !== null && spec?.previousRelease
          ? { ...spec.previousRelease, releaseId: before.releaseId }
          : spec?.previousRelease;
      const manifest = await importRelease(
        kind,
        spec === undefined ? spec : { ...spec, previousRelease: previous },
        adjust
      );
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

  it("probes a core in the namespace the router binds through that binding, its connect through the gateway, and routes its hostname to its script", async () => {
    // Core binds its connect, as the real one does: through the gateway.
    const manifest = await importRelease(
      "workers_for_platforms",
      {},
      bindsConnect
    );
    const { account, clientId, held } = await setUp(
      "workers_for_platforms",
      manifest,
      clientDispatchNamespace
    );
    const outbound = cloudflare.calls.length;

    await runClientProvision(
      {
        ...context,
        router: {
          ...context.router,
          namespace: clientDispatchNamespace,
          dispatcher: cloudflare.dispatcher(
            account.id,
            clientDispatchNamespace
          ),
        },
      },
      held
    );

    const { core, connect } = await scriptsOf(clientId);
    const bindings = z
      .array(z.object({ name: z.string() }).loose())
      .parse(
        account.namespaces
          .get(clientDispatchNamespace)
          ?.get(core)
          ?.versions.at(-1)?.metadata.bindings ?? []
      );
    // The version each runs, as the namespace has it live: connect's
    // after its secrets were delivered.
    const liveIn = (script: string) =>
      account.namespaces.get(clientDispatchNamespace)?.get(script)
        ?.deployments[0]?.versions[0]?.version_id;
    const recorded = await db
      .select({
        worker: clientWorkers.worker,
        versionId: clientWorkers.versionId,
      })
      .from(clientWorkers)
      .where(eq(clientWorkers.clientId, clientId))
      .orderBy(clientWorkers.worker);
    const [probed] = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "provision.probe")
        )
      );
    expect({
      operation: await operationOf(clientId),
      // Nothing left unrecorded: connect's settled.
      unrecorded: z
        .object({ connectUnrecorded: z.number().optional() })
        .parse(JSON.parse(probed?.detail ?? "{}")).connectUnrecorded,
      // What drift compares against: core's as it answered, and its
      // connect's as connect named it to core in the probe.
      recorded,
      entry: await env.ROUTER_HOSTS.get(`${clientId}.${domain}`, "json"),
      // Its connect, as core binds it: the gateway, naming its own script.
      connectBinding: bindings.find(({ name }) => name === "CONNECT"),
      // Its health and the admin's probe, through the namespace, at the
      // hostname the router will reach it at: never over workers.dev.
      dispatched: cloudflare.dispatched().map(({ script, url }) => ({
        script,
        path: new URL(url).pathname,
        host: new URL(url).host,
      })),
      workersDev: cloudflare.calls
        .slice(outbound)
        .filter(({ path }) => path.includes("workers.dev")).length,
    }).toMatchObject({
      operation: { status: "done" },
      unrecorded: undefined,
      recorded: [
        { worker: "connect", versionId: liveIn(connect) ?? "none" },
        { worker: "core", versionId: liveIn(core) ?? "none" },
      ],
      entry: { clientId, script: core, generation: 1 },
      connectBinding: {
        type: "service",
        name: "CONNECT",
        service: platformWorkerName("connect-gateway", "production"),
        props: { script: connect },
      },
      dispatched: [
        { script: core, path: "/health", host: `${clientId}.${domain}` },
        {
          script: core,
          path: provisionProbePath,
          host: `${clientId}.${domain}`,
        },
        // Connect's version read again, signed: the same twice apart.
        {
          script: core,
          path: connectVersionPath,
          host: `${clientId}.${domain}`,
        },
      ],
      workersDev: 0,
    });
  });

  it.each(
    (["release", "secrets"] as const).flatMap((change) => [
      {
        change,
        isolates:
          "answer as the version recorded before it twice, then the new one",
        stale: 2,
        recordsNew: true,
      },
      {
        change,
        isolates: "never answer as anything but the version recorded before it",
        stale: "always" as const,
        recordsNew: false,
      },
    ])
  )(
    "never records a namespace connect as the version it ran before a $change change when its old isolates $isolates",
    async ({ change, stale, recordsNew }) => {
      const manifest = await importRelease(
        "workers_for_platforms",
        {},
        bindsConnect
      );
      const { account, clientId, held } = await setUp(
        "workers_for_platforms",
        manifest,
        clientDispatchNamespace
      );
      const namespaced = {
        ...context,
        router: {
          ...context.router,
          dispatcher: cloudflare.dispatcher(
            account.id,
            clientDispatchNamespace
          ),
        },
      };
      await runClientProvision(namespaced, held);
      const recordedConnect = async (): Promise<string | null> => {
        const row = await db
          .select({ versionId: clientWorkers.versionId })
          .from(clientWorkers)
          .where(
            and(
              eq(clientWorkers.clientId, clientId),
              eq(clientWorkers.worker, "connect")
            )
          )
          .get();
        return row?.versionId ?? null;
      };
      const before = await recordedConnect();
      // A second release (connect uploaded again, its secrets delivered
      // again), or the same release run again with its secrets rotated
      // (only its secrets delivered again): each write a new version;
      // isolates of the one before still answering core for a moment.
      if (change === "release") {
        const second = await importRelease(
          "workers_for_platforms",
          { notes: "feat(core): second" },
          bindsConnect
        );
        await startClientRelease(db, staff, await attempt(clientId), {
          releaseId: second.releaseId,
        });
      } else {
        await db
          .update(clients)
          .set({ generation: 2, rotatedAt: new Date() })
          .where(eq(clients.id, clientId));
        await startClientRelease(db, staff, await attempt(clientId), {
          again: true,
          what: "secrets",
        });
      }
      if (stale === "always") {
        account.connectAnswering = before;
      } else {
        account.connectAnswersFirst = Array.from(
          { length: stale },
          () => before
        );
      }
      const rerun = await attempt(clientId);
      await runClientProvision(namespaced, rerun);
      const { connect } = await scriptsOf(clientId);
      const live = account.namespaces.get(clientDispatchNamespace)?.get(connect)
        ?.deployments[0]?.versions[0]?.version_id;
      const probes = await db
        .select({ detail: auditEvents.detail })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.clientId, clientId),
            eq(auditEvents.action, "provision.probe")
          )
        );

      const operation = await operationOf(clientId);
      expect({
        before: typeof before,
        changed: live !== before,
        status: operation?.status,
        recorded: await recordedConnect(),
        unrecorded: probes
          .map(({ detail }) =>
            z
              .object({
                run: z.string(),
                connectUnrecorded: z.number().optional(),
              })
              .parse(JSON.parse(detail ?? "{}"))
          )
          .find(({ run }) => run === rerun.runId)?.connectUnrecorded,
      }).toStrictEqual({
        before: "string",
        changed: true,
        status: "done",
        recorded: recordsNew ? (live ?? "none") : null,
        unrecorded: recordsNew ? undefined : 1,
      });
    }
  );

  it.each([
    {
      worker: "connect" as const,
      answers: "a version made earlier in the run once",
    },
    {
      worker: "core" as const,
      answers: "the version recorded before the run, until they stop",
    },
  ])(
    "records a namespace $worker only as its latest version when its isolates answer $answers",
    async ({ worker }) => {
      const manifest = await importRelease(
        "workers_for_platforms",
        {},
        bindsConnect
      );
      const { account, clientId, held } = await setUp(
        "workers_for_platforms",
        manifest,
        clientDispatchNamespace
      );
      const namespaced = {
        ...context,
        router: {
          ...context.router,
          dispatcher: cloudflare.dispatcher(
            account.id,
            clientDispatchNamespace
          ),
        },
      };
      await runClientProvision(namespaced, held);
      const recordedOf = async (): Promise<Record<string, string | null>> => {
        const rows = await db
          .select({
            worker: clientWorkers.worker,
            versionId: clientWorkers.versionId,
          })
          .from(clientWorkers)
          .where(eq(clientWorkers.clientId, clientId));
        return Object.fromEntries(
          rows.map(({ worker: name, versionId }) => [name, versionId])
        );
      };
      const before = await recordedOf();
      const second = await importRelease(
        "workers_for_platforms",
        { notes: "feat(core): second" },
        bindsConnect
      );
      await startClientRelease(db, staff, await attempt(clientId), {
        releaseId: second.releaseId,
      });
      const rerun = await attempt(clientId);
      let stopped: unknown = null;
      let whileOld: string | null = null;
      if (worker === "connect") {
        // Its upload's version, made before its secrets': not the latest.
        account.connectAnswersFirst = ["made-earlier-in-this-run"];
      } else {
        // Its old isolates answer its health and its probe alike: the run
        // stops rather than record what it superseded, and goes on once
        // they're gone.
        account.answeringVersion = before.core ?? "none";
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        stopped = await runClientProvision(namespaced, rerun).then(
          () => null,
          (error: unknown) => error
        );
        errors.mockRestore();
        const meanwhile = await recordedOf();
        whileOld = meanwhile.core ?? null;
        delete account.answeringVersion;
      }
      await runClientProvision(namespaced, rerun);
      const scripts = await scriptsOf(clientId);
      const live = account.namespaces
        .get(clientDispatchNamespace)
        ?.get(scripts[worker])?.deployments[0]?.versions[0]?.version_id;
      const operation = await operationOf(clientId);
      const recorded = await recordedOf();

      expect({
        stopped: worker === "core" ? stopped instanceof Error : null,
        whileOld,
        status: operation?.status,
        changed: live !== before[worker],
        recorded: recorded[worker],
      }).toStrictEqual({
        stopped: worker === "core" ? true : null,
        whileOld: null,
        status: "done",
        changed: true,
        recorded: live ?? "none",
      });
    }
  );

  it("still refuses what a run superseded on its retry, after its probe recorded none of connect's and a later step failed", async () => {
    const manifest = await importRelease(
      "workers_for_platforms",
      {},
      bindsConnect
    );
    const { account, clientId, held } = await setUp(
      "workers_for_platforms",
      manifest,
      clientDispatchNamespace
    );
    const namespaced = {
      ...context,
      router: {
        ...context.router,
        dispatcher: cloudflare.dispatcher(account.id, clientDispatchNamespace),
      },
    };
    await runClientProvision(namespaced, held);
    const recordedConnect = async (): Promise<string | null> => {
      const row = await db
        .select({ versionId: clientWorkers.versionId })
        .from(clientWorkers)
        .where(
          and(
            eq(clientWorkers.clientId, clientId),
            eq(clientWorkers.worker, "connect")
          )
        )
        .get();
      return row?.versionId ?? null;
    };
    const before = await recordedConnect();
    const second = await importRelease(
      "workers_for_platforms",
      { notes: "feat(core): second" },
      bindsConnect
    );
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: second.releaseId,
    });
    const rerun = await attempt(clientId);
    // Its probe: only the old isolates answer, so none is recorded; then
    // publishing its hostname fails.
    account.connectAnswering = before;
    const put = vi
      .spyOn(env.ROUTER_HOSTS, "put")
      .mockRejectedValueOnce(new Error("the router's map is down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await runClientProvision(namespaced, rerun).then(
      () => null,
      (error: unknown) => error
    );
    errors.mockRestore();
    put.mockRestore();
    const afterFailure = await recordedConnect();
    // Retried: nothing uploaded or delivered again, and an old isolate
    // answers first, twice.
    delete account.connectAnswering;
    account.connectAnswersFirst = [before, before];
    await runClientProvision(namespaced, rerun);
    const { connect } = await scriptsOf(clientId);
    const live = account.namespaces.get(clientDispatchNamespace)?.get(connect)
      ?.deployments[0]?.versions[0]?.version_id;
    const operation = await operationOf(clientId);

    expect({
      failed: failed instanceof Error,
      afterFailure,
      changed: live !== before,
      status: operation?.status,
      recorded: await recordedConnect(),
    }).toStrictEqual({
      failed: true,
      afterFailure: null,
      changed: true,
      status: "done",
      recorded: live ?? "none",
    });
  });

  it("goes live on a core of a release from before connect's version, recording none of connect's", async () => {
    const manifest = await importRelease(
      "workers_for_platforms",
      {},
      bindsConnect
    );
    const { account, clientId, held } = await setUp(
      "workers_for_platforms",
      manifest,
      clientDispatchNamespace
    );
    // Its core names no version of connect's: not in its probe, nor asked.
    account.coreProbe = { noConnectVersion: true };

    await runClientProvision(
      {
        ...context,
        router: {
          ...context.router,
          dispatcher: cloudflare.dispatcher(
            account.id,
            clientDispatchNamespace
          ),
        },
      },
      held
    );
    const recorded = await db
      .select({
        worker: clientWorkers.worker,
        versionId: clientWorkers.versionId,
      })
      .from(clientWorkers)
      .where(eq(clientWorkers.clientId, clientId))
      .orderBy(clientWorkers.worker);
    const [probed] = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "provision.probe")
        )
      );
    const operation = await operationOf(clientId);

    expect({
      status: operation?.status,
      connect: recorded.find(({ worker }) => worker === "connect")?.versionId,
      core: typeof recorded.find(({ worker }) => worker === "core")?.versionId,
      unrecorded: z
        .object({ connectUnrecorded: z.number().optional() })
        .parse(JSON.parse(probed?.detail ?? "{}")).connectUnrecorded,
    }).toStrictEqual({
      status: "done",
      connect: null,
      core: "string",
      unrecorded: 1,
    });
  });

  it("can't reach a core uploaded to the same namespace in another account, its hostname unpublished", async () => {
    const manifest = await importRelease("workers_for_platforms");
    const { clientId, held } = await setUp(
      "workers_for_platforms",
      manifest,
      clientDispatchNamespace
    );
    // The router's own account, whose namespace of that name lacks the core.
    const routers = cloudflare.addAccount("Router");
    routers.namespaces.set(clientDispatchNamespace, new Map());

    const outcome = await runClientProvision(
      {
        ...context,
        router: {
          ...context.router,
          namespace: clientDispatchNamespace,
          dispatcher: cloudflare.dispatcher(
            routers.id,
            clientDispatchNamespace
          ),
        },
      },
      held
    ).then(
      () => "done",
      (error: unknown) => (error instanceof Error ? error.message : "")
    );

    expect({
      outcome: outcome === "done" ? outcome : "stopped",
      operation: await operationOf(clientId),
      dispatched: cloudflare.dispatched().length,
      routed: await routed(clientId),
    }).toMatchObject({
      outcome: "stopped",
      operation: { status: "failed" },
      dispatched: 0,
      routed: false,
    });
  });

  it("places a client only in its own stage's namespace, in either direction, before anything is created or uploaded", async () => {
    const manifest = await importRelease("workers_for_platforms");
    // A production destination, run by a staging admin...
    const production = await setUp("workers_for_platforms", manifest);
    // ...and a staging one, recorded by a staging admin, run by production's.
    const staging = await setUp(
      "workers_for_platforms",
      manifest,
      clientsNamespace("staging")
    );
    const runAs = async (held: HeldClient, stage: Stage): Promise<unknown> => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        return await runClientProvision(
          {
            ...context,
            router: { ...context.router, namespace: clientsNamespace(stage) },
          },
          held
        ).then(
          () => null,
          (error: unknown) => error
        );
      } finally {
        errors.mockRestore();
      }
    };

    const refused = [
      await runAs(production.held, "staging"),
      await runAs(staging.held, "production"),
    ];
    expect({
      refused: refused.map((error) =>
        error instanceof ProvisionOperationError ? error.code : error
      ),
      created: [production.account, staging.account].map(
        (account) => account.d1.length + account.scriptUploads.length
      ),
      inventory: [
        await clientInventory(db, production.clientId),
        await clientInventory(db, staging.clientId),
      ],
      routed: [
        await routed(production.clientId),
        await routed(staging.clientId),
      ],
    }).toStrictEqual({
      refused: ["destination_other_stage", "destination_other_stage"],
      created: [0, 0],
      inventory: [[], []],
      routed: [false, false],
    });
  });

  it("builds a retry's Durable Object migrations from what an earlier attempt's upload left, once that upload landed", async () => {
    const manifest = await importRelease("workers_for_platforms");
    const { held: claim } = await setUp("workers_for_platforms", manifest);
    // The first attempt's core upload, carrying core's migration, is held
    // on its way when the step's retry takes the client.
    const held = Promise.withResolvers<boolean>();
    let uploading = false;
    cloudflare.beforeAnswering(isCoreUpload, async () => {
      uploading = true;
      await held.promise;
    });
    const step = { attemptKey: "provision-step" };
    const first = { ...claim, ...step, attempt: 1 };
    await takeAttempt(db, first);
    const firstRun = failing(first);
    await vi.waitUntil(() => uploading, { timeout: 10_000 });
    const retry = { ...claim, ...step, attempt: 2 };
    await takeAttempt(db, retry);
    const retryRun = failing(retry);
    // A while for the retry to read what core runs, were it to read
    // before the held upload landed; then that upload lands.
    await scheduler.wait(1000);
    held.resolve(true);
    const [firstOutcome, retryOutcome] = await Promise.all([
      firstRun,
      retryRun,
    ]);

    expect({
      // The one that timed out is refused once its upload answered.
      first: codeFrom(firstOutcome),
      // The retry's upload goes on from the migration that landed, and the
      // run stops only where it must, at the probe.
      retry: codeFrom(retryOutcome),
    }).toStrictEqual({
      first: "runner_replaced",
      retry: "probe_unqualified",
    });
  });

  it("takes the real release live in Workers for Platforms, its model calls through the destination's gateway held to the client's ceiling, and without mail", async () => {
    const real = await importRealRelease();
    const { account, clientId, held } = await setUp(
      "workers_for_platforms",
      real,
      clientDispatchNamespace
    );

    await runClientProvision(
      {
        ...context,
        router: {
          ...context.router,
          namespace: clientDispatchNamespace,
          dispatcher: cloudflare.dispatcher(
            account.id,
            clientDispatchNamespace
          ),
        },
      },
      held
    );

    const { core } = await scriptsOf(clientId);
    const coreBindings = z
      .array(z.object({ type: z.string(), name: z.string() }).loose())
      .parse(
        account.namespaces
          .get(clientDispatchNamespace)
          ?.get(core)
          ?.versions.at(-1)?.metadata.bindings ?? []
      );
    const gateway = coreBindings.find(({ name }) => name === "MODEL_GATEWAY");
    expect({
      operation: await operationOf(clientId),
      // Workers AI bound, as the real core binds it.
      ai: coreBindings
        .filter(({ type }) => type === "ai")
        .map(({ name }) => name),
      // Through the destination's shared gateway, ensured before core went
      // live, at the client's ceiling: €250 a month unless staff set another.
      gateways: account.gateways.map(({ id }) => id),
      gateway: z.object({ json: z.unknown() }).loose().parse(gateway).json,
      // Its core goes live without `EMAIL`, so it sends nothing and says
      // so, and no sending domain is set up for it.
      mail: coreBindings.filter(
        ({ type, name }) => type === "send_email" || name === "EMAIL"
      ),
      zones: account.zones.length,
      routed: await routed(clientId),
    }).toMatchObject({
      operation: { status: "done" },
      ai: ["AI"],
      gateways: [placedModelGateway("production")],
      gateway: {
        gateway: placedModelGateway("production"),
        budgets: { deployment: { limit: 250, alertAt: 80 } },
      },
      mail: [],
      zones: 0,
      routed: true,
    });
  });

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

  it("holds a rollback while marks it can't read are fresh, and lets it go once they age out", async () => {
    const manifest = await importRelease("dedicated");
    const { clientId } = await setUp("dedicated", manifest);
    const operation = await operationOf(clientId);
    const change = operation?.change ?? 0;
    const mark = async (updatedAt: Date) => {
      await db
        .update(clientProvisions)
        .set({ sending: "not json", updatedAt })
        .where(eq(clientProvisions.clientId, clientId));
    };

    await mark(new Date());
    const fresh = await sendsSettled(db, clientId, change);
    await mark(new Date(Date.now() - 10 * 60_000));
    const aged = await sendsSettled(db, clientId, change);

    expect({ fresh, aged }).toStrictEqual({ fresh: false, aged: true });
  });

  it("aborts an upload left unanswered past its limit, and keeps it marked sent, as it may still land", async () => {
    const manifest = await importRelease("dedicated");
    const { clientId, held } = await setUp("dedicated", manifest);
    // Connect's upload goes unanswered until the test ends.
    const answered = Promise.withResolvers<boolean>();
    cloudflare.beforeAnswering(
      (call) => call.method === "PUT" && call.path.endsWith("-connect"),
      async () => {
        await answered.promise;
      }
    );
    const abortedBefore = cloudflare.abortedCalls();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let outcome: string;
    try {
      outcome = await runClientProvision(
        { ...context, sendTimeoutMs: 50 },
        held
      ).then(
        () => "done",
        (error: unknown) => (error instanceof Error ? error.name : "thrown")
      );
    } finally {
      errors.mockRestore();
      answered.resolve(true);
    }
    const row = await db
      .select({
        status: clientProvisions.status,
        sending: clientProvisions.sending,
      })
      .from(clientProvisions)
      .where(eq(clientProvisions.clientId, clientId))
      .get();

    expect({
      outcome,
      aborted: cloudflare.abortedCalls() - abortedBefore,
      status: row?.status,
      // Marked still: a rollback waits it out (`sendsSettled`).
      marked:
        Object.keys(
          z
            .record(z.string(), z.unknown())
            .parse(JSON.parse(row?.sending ?? "{}"))
        ).length > 0,
    }).toStrictEqual({
      outcome: "TimeoutError",
      aborted: 1,
      status: "failed",
      marked: true,
    });
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

  it("runs as a workflow, and starting it again resumes the one operation", async () => {
    const manifest = await importRelease("dedicated");
    const account = cloudflare.addAccount();
    const destinationId = await destination({
      kind: "dedicated",
      accountId: account.id,
      namespace: null,
    });
    const { clientId } = await placedClient(destinationId);
    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    // The first attempt is refused connect's upload, and stops.
    cloudflare.failNext(
      (call) => call.method === "PUT" && call.path.endsWith("-connect"),
      400
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
    await attemptEnded(attempts.started[0], "errored");
    errors.mockRestore();
    await expect(operationOf(clientId)).resolves.toMatchObject({
      status: "failed",
      step: "migrations",
      error: "cloudflare_400_10000",
    });

    // Started again, a new attempt resumes it.
    await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
    await attemptEnded(attempts.started[1], "complete");
    await expect(provisioned(account, clientId)).resolves.toMatchObject(
      once(clientId)
    );
  });

  it("migrates a client once when its attempt times out mid-migration and its retry runs", async () => {
    const manifest = await importRelease("dedicated");
    const account = cloudflare.addAccount();
    const destinationId = await destination({
      kind: "dedicated",
      accountId: account.id,
      namespace: null,
    });
    const { clientId } = await placedClient(destinationId);
    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    // Each attempt is held once it read which migrations a database still
    // needs: the first times out there, and its retry starts.
    const first = heldAfter(readMigrations);
    const retry = heldAfter(readMigrations);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // Both released however the checks go: a held caller left behind
    // would block the run's object for the rest of the file.
    try {
      await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
      const [timingOut] = attempts.started;
      if (timingOut === undefined) {
        throw new Error("No attempt was started");
      }
      await first.read();
      const { retried } = await timeOutAttempt(
        adminWorkflows.provisionPlacedClient,
        timingOut
      );
      await retry.read();
      // Both read the same migrations as still needed. The one that timed
      // out goes on first, while its retry still holds the client.
      first.release();
      await vi.waitFor(() => {
        const stopped = errors.mock.calls.some((logged) =>
          JSON.stringify(logged).includes("runner_replaced")
        );
        if (!stopped) {
          throw new Error("The attempt that timed out hasn't stopped yet");
        }
      });
      retry.release();
      await retried;
      await attemptEnded(timingOut, "complete");

      const applies = cloudflare.calls.filter(
        (call) =>
          call.path.endsWith("/query") &&
          JSON.stringify(call.body).includes("INSERT INTO d1_migrations")
      );
      expect({
        applies: applies.length,
        provisioned: await provisioned(account, clientId),
      }).toMatchObject({
        applies: 3,
        provisioned: once(clientId),
      });
    } finally {
      first.release();
      retry.release();
      errors.mockRestore();
    }
  });

  it("reports a provision done when its attempt loses the step's result after the operation completed", async () => {
    const manifest = await importRelease("dedicated");
    const account = cloudflare.addAccount();
    const destinationId = await destination({
      kind: "dedicated",
      accountId: account.id,
      namespace: null,
    });
    const { clientId } = await placedClient(destinationId);
    let held: LostWrite | undefined;
    // Held once the operation is done: its last write, which also gave the
    // client's claim back.
    using attempts = startsOf(
      adminWorkflows.provisionPlacedClient,
      async (stub) => {
        held = await holdBatchOf(stub, async (database) => {
          const status = await database
            .prepare("SELECT status FROM client_provisions WHERE client_id = ?")
            .bind(clientId)
            .first<string>("status");
          return status === "done";
        });
      }
    );
    try {
      await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
      const [finished] = attempts.started;
      if (finished === undefined || held === undefined) {
        throw new Error("No attempt was started");
      }
      await held.committed;
      // The activation is lost before the step's result is kept: the step
      // runs again, finds the operation done, and the run succeeds.
      await deliverAlarm(adminWorkflows.provisionPlacedClient, finished);
      await attemptEnded(finished, "complete");

      await expect(provisioned(account, clientId)).resolves.toMatchObject(
        once(clientId)
      );
    } finally {
      held?.lose();
    }
  });

  it("sends no migration again from an attempt that timed out while it waited out a 429", async () => {
    const manifest = await importRelease("dedicated");
    const account = cloudflare.addAccount();
    const destinationId = await destination({
      kind: "dedicated",
      accountId: account.id,
      namespace: null,
    });
    const { clientId } = await placedClient(destinationId);
    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    // The first attempt's first migration is refused with a 429, and the
    // attempt is held as it gets it back: its step times out meanwhile,
    // and the retry migrates the client.
    cloudflare.failNext(isMigration, { retryAfter: "0" });
    const refused = heldAfter(isMigration);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
      const [timingOut] = attempts.started;
      if (timingOut === undefined) {
        throw new Error("No attempt was started");
      }
      await refused.read();
      const { retried } = await timeOutAttempt(
        adminWorkflows.provisionPlacedClient,
        timingOut
      );
      await retried;
      await attemptEnded(timingOut, "complete");
      // The attempt that timed out waits out the 429, and would send the
      // migration again.
      refused.release();
      await vi.waitFor(() => {
        const stopped = errors.mock.calls.some((logged) =>
          JSON.stringify(logged).includes("runner_replaced")
        );
        if (!stopped) {
          throw new Error("The attempt that timed out hasn't stopped yet");
        }
      });

      expect({
        // The refused one, then the retry's three.
        sent: cloudflare.calls.filter(isMigration).length,
        provisioned: await provisioned(account, clientId),
      }).toMatchObject({ sent: 4, provisioned: once(clientId) });
    } finally {
      refused.release();
      errors.mockRestore();
    }
  });

  it("provisions a client once when its attempt loses its step's result after the step's first write", async () => {
    const manifest = await importRelease("dedicated");
    const account = cloudflare.addAccount();
    const destinationId = await destination({
      kind: "dedicated",
      accountId: account.id,
      namespace: null,
    });
    const { clientId } = await placedClient(destinationId);
    let held: LostWrite | undefined;
    using attempts = startsOf(
      adminWorkflows.provisionPlacedClient,
      async (stub) => {
        held = await holdFirstBatchOf(stub);
      }
    );

    try {
      await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
      const [lostOne] = attempts.started;
      if (lostOne === undefined || held === undefined) {
        throw new Error("No attempt was started");
      }
      // The step wrote, and its activation is lost before it hears back: a
      // duplicate delivery takes the attempt over, and the step runs again,
      // resuming the operation.
      await held.committed;
      await deliverAlarm(adminWorkflows.provisionPlacedClient, lostOne);
      await attemptEnded(lostOne, "complete");

      const journal = await journalOf(
        adminWorkflows.provisionPlacedClient,
        lostOne
      );
      expect({
        provision: journal.steps.map(({ name, state, attempt: tried }) => ({
          name,
          state,
          tried,
        })),
        provisioned: await provisioned(account, clientId),
      }).toMatchObject({
        provision: [{ name: "provision", state: "succeeded", tried: 2 }],
        provisioned: once(clientId),
      });
    } finally {
      held?.lose();
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

    await startClientRelease(db, staff, await attempt(clientId), {
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
      startClientRelease(db, staff, await attempt(clientId), { rollback: true })
    );
    const second = await importRelease("dedicated", {
      notes: "feat(core): second",
    });
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: second.releaseId,
    });
    await runClientProvision(context, await attempt(clientId));

    await startClientRelease(db, staff, await attempt(clientId), {
      rollback: true,
    });
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
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: third.releaseId,
    });
    await runClientProvision(context, await attempt(clientId));
    const past = await codeOf(
      startClientRelease(db, staff, await attempt(clientId), { rollback: true })
    );
    // Nor released to an older one without it, before anything uploads.
    const uploads = account.scriptUploads.length;
    const behind = await codeOf(
      startClientRelease(db, staff, await attempt(clientId), {
        releaseId: second.releaseId,
      })
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
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: later.releaseId,
    });
    cloudflare.failNext(isUpload(connect), 400);
    await failing(await attempt(clientId));

    const back = await codeOf(
      startClientRelease(db, staff, await attempt(clientId), { rollback: true })
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
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: later.releaseId,
    });
    // Core's upload runs its migration, and the answer never arrives.
    cloudflare.failNext(isUpload(core), "lost");
    await failing(await attempt(clientId));
    // An upload with no answer may still land: its mark keeps the next
    // attempt from sending until it ages out, as it has by now.
    await db
      .update(clientProvisions)
      .set({
        sending: sql`(SELECT json_group_object(key, json_set(value, '$.at', 0)) FROM json_each(${clientProvisions.sending}))`,
      })
      .where(eq(clientProvisions.clientId, clientId));
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
      startClientRelease(db, staff, await attempt(clientId), { rollback: true })
    );

    expect(back).toBe("rollback_past_migration");
  });

  it("refuses a release of a client not live yet, and a start by a runner that lost the client, changing nothing; the holder takes an operation left running", async () => {
    const first = await importRelease("dedicated");
    const pending = await setUp("dedicated", first);
    const later = await importRelease("dedicated", {
      notes: "feat(core): later",
    });

    const notLive = await codeOf(
      startClientRelease(db, staff, await attempt(pending.clientId), {
        releaseId: later.releaseId,
      })
    );
    const { clientId } = await liveClient(first);
    // Two starts: the first claims, the second claims in its place; the
    // first, no longer holding the client, writes nothing.
    const lost = await attempt(clientId);
    const holder = await attempt(clientId);
    const lostStart = await codeOf(
      startClientRelease(db, staff, lost, { releaseId: later.releaseId })
    );
    const untouched = await operationOf(clientId);
    const started = await codeOf(
      startClientRelease(db, staff, holder, { releaseId: later.releaseId })
    );
    // Its runner ended, the release still running: the next holder takes
    // the client back to the release it ran, or resumes it.
    const takenBack = await codeOf(
      startClientRelease(db, staff, await attempt(clientId), {
        releaseId: first.releaseId,
      })
    );
    const resumed = await codeOf(
      startClientRelease(db, staff, await attempt(clientId), {
        releaseId: first.releaseId,
      })
    );

    expect({
      notLive,
      lostStart,
      untouched,
      started,
      takenBack,
      resumed,
      operation: await operationOf(clientId),
    }).toMatchObject({
      notLive: "client_not_active",
      lostStart: "operation_running",
      untouched: { releaseId: first.releaseId, status: "done" },
      started: "started",
      takenBack: "started",
      resumed: "started",
      operation: { releaseId: first.releaseId, status: "running" },
    });
  });

  it("resumes a release that stopped part way, leaving its hostname where it was until it passes its probe", async () => {
    const first = await importRelease("dedicated");
    const { account, clientId } = await liveClient(first);
    const later = await importRelease("dedicated", {
      notes: "feat(core): later",
    });
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: later.releaseId,
    });
    // Core's upload is refused: connect runs the later release already.
    cloudflare.failNext(
      (call) => call.method === "PUT" && call.path.endsWith("-core"),
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
    await startClientRelease(db, staff, await attempt(clientId), {
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
    // What staff are told, as the run sends it (src/alerts.ts).
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

    await startClientRelease(db, staff, await attempt(clientId), {
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
    await startClientRelease(db, staff, await attempt(stuck.clientId), {
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

  it("releases a live client through its run, as staff start it, and a start at the same moment that loses the claim changes nothing", async () => {
    const first = await importRelease("dedicated");
    const { clientId } = await liveClient(first);
    const later = await importRelease("dedicated", {
      notes: "feat(core): later",
    });
    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    // Another release asked for at once: it claims nothing, so it never
    // changes the operation the winning attempt runs.
    const other = await importRelease("dedicated", {
      notes: "feat(core): other",
    });
    const [won, lost] = await Promise.all([
      codeOf(
        releasePlacedClient(env, staff, clientId, {
          releaseId: later.releaseId,
        })
      ),
      codeOf(
        releasePlacedClient(env, staff, clientId, {
          releaseId: other.releaseId,
        })
      ),
    ]);
    await attemptEnded(attempts.started[0], "complete");
    const operation = await operationOf(clientId);
    const answers = [won, lost].toSorted();
    const { started } = attempts;
    expect({
      answers,
      attempts: started.length,
      runs: await runs(clientId),
      operation,
    }).toMatchObject({
      answers: ["already_running", "started"],
      attempts: 1,
      runs: { core: operation?.releaseId, connect: operation?.releaseId },
      operation: { status: "done" },
    });
  });

  // Offboarding, then deleting its resources (src/hosting/offboarding.ts):
  // the threat model is in its header.

  it("offboards a live client at once, unrouting it and deleting nothing, and no later release routes it again", async () => {
    const first = await importRelease("dedicated");
    const { account, clientId } = await liveClient(first);
    const before = holdings(account);
    const later = await importRelease("dedicated", {
      notes: "feat(core): later",
    });

    await offboardPlacedClient(env, staff, clientId);
    // Again: it's offboarded already, and its hostname stays out.
    await offboardPlacedClient(env, staff, clientId);
    const refused = await codeOf(
      startClientRelease(db, staff, await attempt(clientId), {
        releaseId: later.releaseId,
      })
    );
    const client = await db
      .select({ status: clients.status, offboardedAt: clients.offboardedAt })
      .from(clients)
      .where(eq(clients.id, clientId))
      .get();

    expect({
      status: client?.status,
      offboarded: client?.offboardedAt instanceof Date,
      route: await mappedRoute(env.ROUTER_HOSTS, `${clientId}.${domain}`),
      holdings: holdings(account),
      refused,
    }).toStrictEqual({
      status: "offboarded",
      offboarded: true,
      route: null,
      holdings: before,
      refused: "client_not_active",
    });
  });

  it("deletes an offboarded client's resources only after its retention, with staff confirming no export, and only its own", async () => {
    const first = await importRelease("dedicated");
    const { account, clientId } = await liveClient(first);
    const other = await liveClient(first);
    const others = holdings(other.account);
    await offboardPlacedClient(env, staff, clientId);

    const early = await codeOf(
      deletePlacedClient(env, staff, clientId, { exportConfirmed: true })
    );
    await offboardedDaysAgo(clientId, 31);
    const unconfirmed = await codeOf(
      deletePlacedClient(env, staff, clientId, { exportConfirmed: false })
    );
    const live = await codeOf(
      deletePlacedClient(env, staff, other.clientId, { exportConfirmed: true })
    );
    const kept = holdings(account);
    const deletion = await deletePlacedClient(env, staff, clientId, {
      exportConfirmed: true,
    });
    const inventory = await clientInventory(db, clientId);
    const events = await db
      .select({ action: auditEvents.action, detail: auditEvents.detail })
      .from(auditEvents)
      .where(eq(auditEvents.clientId, clientId));
    const deletedEvents = events.filter(
      ({ action }) => action === "client.delete_resource"
    );
    const summary = events.find(
      ({ action }) => action === "client.delete_resources"
    );

    expect({
      early,
      unconfirmed,
      live,
      kept: kept.d1.length > 0 && kept.scripts.length > 0,
      deletion: deletion.emptying,
      gone: holdings(account),
      recorded: inventory.every((row) => row.deletedAt !== null),
      // Each resource audited as it went, then the whole, with what staff
      // confirmed.
      audited: deletedEvents.length,
      summary: z.unknown().parse(JSON.parse(summary?.detail ?? "null")),
      others: holdings(other.account),
    }).toMatchObject({
      early: "retention_running",
      unconfirmed: "export_unconfirmed",
      live: "not_offboarded",
      kept: true,
      deletion: [],
      gone: { d1: [], buckets: [], scripts: [] },
      recorded: true,
      audited: inventory.length,
      summary: { deleted: inventory.length, exportConfirmed: true },
      others,
    });
  });

  it("empties a bucket that still holds objects and deletes it on a later run, and keeps a database whose name another id has", async () => {
    const first = await importRelease("dedicated");
    const { account, clientId } = await liveClient(first);
    await offboardPlacedClient(env, staff, clientId);
    await offboardedDaysAgo(clientId, 31);
    const files = await resourceOf(clientId, "r2:grasp-os-files");
    account.fullBuckets.add(files.physicalName);

    const firstRun = await deletePlacedClient(env, staff, clientId, {
      exportConfirmed: true,
    });
    const [emptied] = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "client.empty_bucket")
        )
      );
    const emptying = {
      emptying: firstRun.emptying,
      rule: account.lifecycles.has(files.physicalName),
      kept: account.buckets.some(({ name }) => name === files.physicalName),
      audited: z.unknown().parse(JSON.parse(emptied?.detail ?? "null")),
    };
    // Its objects expired since: the next run deletes it.
    account.fullBuckets.delete(files.physicalName);
    const secondRun = await deletePlacedClient(env, staff, clientId, {
      exportConfirmed: true,
    });

    // Another client's database under the recorded name: kept.
    const next = await liveClient(first);
    await offboardPlacedClient(env, staff, next.clientId);
    await offboardedDaysAgo(next.clientId, 31);
    const database = await resourceOf(next.clientId, "d1:grasp-os-core");
    const swapped = next.account.d1.find(
      ({ uuid }) => uuid === database.providerId
    );
    if (swapped !== undefined) {
      swapped.uuid = crypto.randomUUID();
    }
    const before = holdings(next.account);
    const notOwned = await codeOf(
      deletePlacedClient(env, staff, next.clientId, { exportConfirmed: true })
    );

    expect({
      emptying,
      second: secondRun.emptying,
      bucketGone: account.buckets.length,
      notOwned,
      // Refused before anything went: its scripts and their objects too.
      untouched: holdings(next.account),
    }).toStrictEqual({
      emptying: {
        emptying: [files.physicalName],
        rule: true,
        kept: true,
        audited: { role: files.role, physicalName: files.physicalName },
      },
      second: [],
      bucketGone: 0,
      notOwned: "resource_not_owned",
      untouched: before,
    });
  });

  it("refuses deleting a row not named for its deployment, or a database whose id was never recorded, before anything goes", async () => {
    const first = await importRelease("dedicated");
    const misnamed = await liveClient(first);
    const unrecorded = await liveClient(first);
    for (const { clientId } of [misnamed, unrecorded]) {
      // oxlint-disable-next-line no-await-in-loop -- two, in order
      await offboardPlacedClient(env, staff, clientId);
      // oxlint-disable-next-line no-await-in-loop -- two, in order
      await offboardedDaysAgo(clientId, 31);
    }
    const files = await resourceOf(misnamed.clientId, "r2:grasp-os-files");
    await db
      .update(clientResources)
      .set({ physicalName: "gsomeone-else-files" })
      .where(
        and(
          eq(clientResources.clientId, misnamed.clientId),
          eq(clientResources.role, files.role)
        )
      );
    await db
      .update(clientResources)
      .set({ providerId: null })
      .where(
        and(
          eq(clientResources.clientId, unrecorded.clientId),
          eq(clientResources.role, "d1:grasp-os-core")
        )
      );
    const before = {
      misnamed: holdings(misnamed.account),
      unrecorded: holdings(unrecorded.account),
    };

    const refused = {
      misnamed: await codeOf(
        deletePlacedClient(env, staff, misnamed.clientId, {
          exportConfirmed: true,
        })
      ),
      unrecorded: await codeOf(
        deletePlacedClient(env, staff, unrecorded.clientId, {
          exportConfirmed: true,
        })
      ),
    };

    expect({
      refused,
      untouched: {
        misnamed: holdings(misnamed.account),
        unrecorded: holdings(unrecorded.account),
      },
    }).toStrictEqual({
      refused: {
        misnamed: "resource_not_owned",
        unrecorded: "resource_not_owned",
      },
      untouched: before,
    });
  });

  it("refuses offboarding with no client domain set, or a hostname the router gives another client, and leaves the route", async () => {
    const first = await importRelease("dedicated");
    const { clientId } = await liveClient(first);
    const other = await liveClient(first);
    const hostname = `${clientId}.${domain}`;

    const unconfigured = await codeOf(
      offboardPlacedClient({ ...env, CLIENT_DOMAIN: "" }, staff, clientId)
    );
    const status = await db
      .select({ status: clients.status })
      .from(clients)
      .where(eq(clients.id, clientId))
      .get();
    // The map gives its hostname the other client's entry.
    const otherEntry = await env.ROUTER_HOSTS.get(
      routerHostKey(`${other.clientId}.${domain}`)
    );
    await env.ROUTER_HOSTS.put(routerHostKey(hostname), otherEntry ?? "");
    const notOurs = await codeOf(offboardPlacedClient(env, staff, clientId));

    expect({
      unconfigured,
      status: status?.status,
      notOurs,
      route: await mappedRoute(env.ROUTER_HOSTS, hostname),
    }).toMatchObject({
      unconfigured: "routing_unconfigured",
      status: "active",
      notOurs: "hostname_not_ours",
      route: { clientId: other.clientId },
    });
  });
});

/** Where a release B's runner stops for good, as a crash leaves it. */
interface CrashPoint {
  at: string;
  /** Whether B started: claimed, and its operation taken to B. */
  started: boolean;
  /** Whether a runner claimed the client and died without starting. */
  claimed: boolean;
  /**
   * What fails B's run where it stops, and what puts it back after; none
   * when it doesn't run.
   */
  plan?: (scripts: {
    core: string;
    connect: string;
  }) => (() => void) | undefined;
  /** Whether both Workers ran B, its core's new migration included. */
  bothRanB: boolean;
  /** Whether only connect ran B. */
  connectRanB: boolean;
}

const crashPoints: CrashPoint[] = [
  {
    at: "before the claim",
    started: false,
    claimed: false,
    bothRanB: false,
    connectRanB: false,
  },
  {
    at: "after the claim",
    started: false,
    claimed: true,
    bothRanB: false,
    connectRanB: false,
  },
  {
    at: "mid-migrate",
    started: true,
    claimed: true,
    plan: () => {
      cloudflare.failNext(
        (call) =>
          call.path.endsWith("/query") &&
          JSON.stringify(call.body).includes("CREATE TABLE b"),
        400
      );
    },
    bothRanB: false,
    connectRanB: false,
  },
  {
    at: "after connect's upload",
    started: true,
    claimed: true,
    plan: ({ core }) => {
      cloudflare.failNext(isUpload(core), 400);
    },
    bothRanB: false,
    connectRanB: true,
  },
  {
    at: "after core's upload",
    started: true,
    claimed: true,
    plan: () => {
      cloudflare.failNext(
        (call) => call.method === "PUT" && call.path.endsWith("/secrets"),
        400
      );
    },
    bothRanB: true,
    connectRanB: true,
  },
  {
    at: "after the probe",
    started: true,
    claimed: true,
    plan: () => {
      const put = vi
        .spyOn(env.ROUTER_HOSTS, "put")
        .mockRejectedValueOnce(new Error("the runner died"));
      return () => {
        put.mockRestore();
      };
    },
    bothRanB: true,
    connectRanB: true,
  },
];

type Competing = "resume" | "another" | "rollback";
const competing: Competing[] = ["resume", "another", "rollback"];

const walk = crashPoints.flatMap((point) =>
  competing.map((action) => ({ ...point, action }))
);

/** Core with a class of its own added, by a Durable Object migration. */
const withExtraClass = (core: WorkerEntry): WorkerEntry => ({
  ...core,
  durableObjectMigrations: [
    ...core.durableObjectMigrations,
    { tag: "v2", new_sqlite_classes: ["Extra"] },
  ],
});

/** What the walk expects of an action after a crash point. */
interface Expected {
  startedAs: string;
  releaseId?: string;
  previousReleaseId?: string | null;
}

/**
 * What an action after `point` should come to: a rollback goes back to
 * what every Worker ran when B started (A), refused once a script ran B's
 * new migration, nothing when B never started; a release records as the
 * one before what every Worker was seen running as it started, never how
 * B's run ended, and split between releases the last whole one (A).
 */
const expectedOf = (
  point: CrashPoint,
  action: Competing,
  ids: { a: string; b: string; c: string }
): Expected => {
  if (action === "rollback") {
    if (!point.started) {
      return { startedAs: "nothing_to_roll_back" };
    }
    return point.bothRanB
      ? { startedAs: "rollback_past_migration" }
      : { startedAs: "started", releaseId: ids.a };
  }
  let previous: string | null = ids.a;
  if (action === "another" && point.bothRanB) {
    previous = ids.b;
  }
  return {
    startedAs: "started",
    releaseId: action === "resume" ? ids.b : ids.c,
    previousReleaseId: previous,
  };
};

/**
 * A live client on release A, with B (a new class and table) and C (B's,
 * and a table more) imported, and B's runner stopped for good at `point`:
 * its run left running, as a crash leaves it.
 */
const crashedAt = async (point: CrashPoint) => {
  const { started, claimed, plan } = point;
  const a = await importRelease("dedicated");
  const { clientId } = await liveClient(a);
  const scripts = await scriptsOf(clientId);
  // B adds a class (a Durable Object migration) and a table; C keeps
  // both and adds a table of its own.
  const b = await importRelease(
    "dedicated",
    {
      notes: "feat(core): b",
      core: "export default { core: 'b' };",
      migrations: {
        "0000_init.sql": "CREATE TABLE a (id TEXT);",
        "0001_more.sql": "CREATE TABLE b (id TEXT);",
      },
    },
    withExtraClass
  );
  const c = await importRelease(
    "dedicated",
    {
      notes: "feat(core): c",
      core: "export default { core: 'c' };",
      migrations: {
        "0000_init.sql": "CREATE TABLE a (id TEXT);",
        "0001_more.sql": "CREATE TABLE b (id TEXT);",
        "0002_most.sql": "CREATE TABLE c (id TEXT);",
      },
    },
    withExtraClass
  );

  // B's runner, to where it stops: then it dies, its run left running.
  let dead: HeldClient | undefined;
  if (claimed) {
    dead = await attempt(clientId);
  }
  if (started && dead !== undefined) {
    await startClientRelease(db, staff, dead, { releaseId: b.releaseId });
    const restore = plan?.(scripts);
    await failing(dead);
    restore?.();
    await db
      .update(clientProvisions)
      .set({ status: "running", error: null })
      .where(eq(clientProvisions.clientId, clientId));
  }

  if (dead !== undefined) {
    // Its instance gone long since, as a crash leaves it: its claim may be
    // replaced, and nothing counts it as starting.
    await db
      .update(clientRuns)
      .set({ claimedAt: new Date(Date.now() - 2 * startingMs) })
      .where(eq(clientRuns.clientId, clientId));
  }
  return { clientId, dead, a, b, c };
};

describe("a release's runner crashing, and another action on the client after", () => {
  useStoreSecrets({ deployer: token });

  it("keeps the worst case when core's upload gets a 4xx Cloudflare didn't write: a rollback past its new migration stays refused", async () => {
    const point = crashPoints.find(({ at }) => at === "after connect's upload");
    if (point === undefined) {
      throw new Error("No such crash point");
    }
    const { clientId } = await crashedAt({
      ...point,
      plan: ({ core }) => {
        // Refused, by its status, but by no answer of Cloudflare's: what
        // reached it may have run.
        cloudflare.failNext(isUpload(core), "400-uncoded");
      },
    });

    const back = await codeOf(
      startClientRelease(db, staff, await attempt(clientId), {
        rollback: true,
      })
    );

    expect(back).toBe("rollback_past_migration");
  });

  it("keeps the way back across two forward moves that each stop part way, so a rollback takes it back to the last whole release", async () => {
    const a = await importRelease("dedicated");
    const { clientId } = await liveClient(a);
    const { core } = await scriptsOf(clientId);
    const b = await importRelease("dedicated", {
      notes: "feat(core): b",
      core: "export default { core: 'b2' };",
    });
    const l = await importRelease("dedicated", {
      notes: "feat(core): l",
      core: "export default { core: 'l' };",
    });
    // B stops after connect's upload, core's refused: split, B and A.
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: b.releaseId,
    });
    cloudflare.failNext(isUpload(core), 400);
    await failing(await attempt(clientId));
    const afterB = await runs(clientId);
    // L, from that split, stops the same way: split, L and A.
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: l.releaseId,
    });
    cloudflare.failNext(isUpload(core), 400);
    await failing(await attempt(clientId));
    const afterL = await runs(clientId);
    const operation = await operationOf(clientId);
    const carried = operation?.previousReleaseId;

    const holder = await attempt(clientId);
    const back = await codeOf(
      startClientRelease(db, staff, holder, { rollback: true })
    );
    await runClientProvision(context, holder);

    expect({
      afterB,
      afterL,
      carried,
      back,
      endsOn: await runs(clientId),
    }).toStrictEqual({
      afterB: { connect: b.releaseId, core: a.releaseId },
      afterL: { connect: l.releaseId, core: a.releaseId },
      // A, the last whole release, carried forward across both.
      carried: a.releaseId,
      back: "started",
      endsOn: { connect: a.releaseId, core: a.releaseId },
    });
  });

  it.each(walk)(
    "$at, then $action: ends coherent, by what its Workers ran, and the dead runner writes nothing",
    async ({ action, ...point }) => {
      const { started } = point;
      const { clientId, dead, a, b, c } = await crashedAt(point);

      // The next action, as a new holder.
      const holder = await attempt(clientId);
      const to =
        action === "rollback"
          ? { rollback: true as const }
          : { releaseId: action === "resume" ? b.releaseId : c.releaseId };
      const startedAs = await codeOf(startClientRelease(db, staff, holder, to));
      if (startedAs === "started") {
        await runClientProvision(context, holder);
      }
      const settled = await operationOf(clientId);
      // The dead runner, waking: writes nothing.
      const staleWrote =
        dead === undefined
          ? false
          : await failing(dead).then(
              async () =>
                JSON.stringify(await operationOf(clientId)) !==
                JSON.stringify(settled)
            );

      const expected = expectedOf(point, action, {
        a: a.releaseId,
        b: b.releaseId,
        c: c.releaseId,
      });
      const schema = await appliedSchema(db, clientId);

      expect({
        startedAs,
        operation: settled,
        runs: await runs(clientId),
        staleWrote,
        // Never behind what any run migrated its databases to.
        schemaAtLeastB:
          started && action !== "rollback"
            ? schema?.releaseId === (action === "resume" ? b : c).releaseId
            : true,
      }).toMatchObject({
        startedAs: expected.startedAs,
        ...(expected.releaseId === undefined
          ? {}
          : {
              operation: {
                releaseId: expected.releaseId,
                status: "done",
                ...(expected.previousReleaseId === undefined
                  ? {}
                  : { previousReleaseId: expected.previousReleaseId }),
              },
              runs: { core: expected.releaseId, connect: expected.releaseId },
            }),
        staleWrote: false,
        schemaAtLeastB: true,
      });
    }
  );

  it("offboards or releases a client asked for both at once, never both: the loser changes nothing", async () => {
    const first = await importRelease("dedicated");
    const { clientId } = await liveClient(first);
    const later = await importRelease("dedicated", {
      notes: "feat(core): later",
    });
    const hostname = `${clientId}.${domain}`;
    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    const [offboarded, released] = await Promise.all([
      codeOf(offboardPlacedClient(env, staff, clientId)),
      codeOf(
        releasePlacedClient(env, staff, clientId, {
          releaseId: later.releaseId,
        })
      ),
    ]);
    const { started } = attempts;
    // A run the offboarding refused ends errored.
    await Promise.all(
      started.map(async (id) => {
        await ended(adminWorkflows.provisionPlacedClient, id);
      })
    );
    const client = await db
      .select({ status: clients.status })
      .from(clients)
      .where(eq(clients.id, clientId))
      .get();
    const route = await mappedRoute(env.ROUTER_HOSTS, hostname);
    const offboardWon = offboarded === "started";

    expect({
      oneWon: offboardWon !== (released === "started"),
      status: client?.status,
      routed: route !== null,
    }).toStrictEqual({
      oneWon: true,
      status: offboardWon ? "offboarded" : "active",
      // Offboarded: never routed again; released: still served.
      routed: !offboardWon,
    });
  });

  it("holds the client while it offboards: a release asked for as its hostname is deleted can't claim it, and starts nothing", async () => {
    const first = await importRelease("dedicated");
    const { clientId } = await liveClient(first);
    const later = await importRelease("dedicated", {
      notes: "feat(core): later",
    });
    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    let meanwhile = "not asked";
    const remove = env.ROUTER_HOSTS.delete.bind(env.ROUTER_HOSTS);
    const deleting = vi
      .spyOn(env.ROUTER_HOSTS, "delete")
      .mockImplementationOnce(async (key: string) => {
        // A release asked for while offboarding deletes the route.
        meanwhile = await codeOf(
          releasePlacedClient(env, staff, clientId, {
            releaseId: later.releaseId,
          })
        );
        await remove(key);
      });

    const offboarded = await codeOf(offboardPlacedClient(env, staff, clientId));
    deleting.mockRestore();
    const { started } = attempts;

    expect({
      offboarded,
      meanwhile,
      started: started.length,
      route: await mappedRoute(env.ROUTER_HOSTS, `${clientId}.${domain}`),
    }).toStrictEqual({
      offboarded: "started",
      meanwhile: "already_running",
      started: 0,
      route: null,
    });
  });

  it("keeps a client it couldn't unroute as it was, the route and its claim given back, and offboards it when tried again", async () => {
    const first = await importRelease("dedicated");
    const { clientId } = await liveClient(first);
    const hostname = `${clientId}.${domain}`;
    const deleting = vi
      .spyOn(env.ROUTER_HOSTS, "delete")
      .mockRejectedValueOnce(new Error("KV unavailable"));

    const failed = await codeOf(offboardPlacedClient(env, staff, clientId));
    deleting.mockRestore();
    const row = await db
      .select({ status: clients.status })
      .from(clients)
      .where(eq(clients.id, clientId))
      .get();
    const stillRouted = await mappedRoute(env.ROUTER_HOSTS, hostname);
    const afterFailure = {
      status: row?.status,
      routed: stillRouted !== null,
      claimed: await currentRun(env, clientId),
    };
    const retried = await codeOf(offboardPlacedClient(env, staff, clientId));

    expect({
      failed,
      afterFailure,
      retried,
      route: await mappedRoute(env.ROUTER_HOSTS, hostname),
    }).toMatchObject({
      failed: "thrown",
      afterFailure: { status: "active", routed: true, claimed: null },
      retried: "started",
      route: null,
    });
  });

  it.each(crashPoints)(
    "$at, then offboarding: unrouted at once, and neither the dead runner nor a later start serves it again",
    async (point) => {
      const { clientId, dead, b } = await crashedAt(point);
      const hostname = `${clientId}.${domain}`;

      const offboarded = await codeOf(
        offboardPlacedClient(env, staff, clientId)
      );
      const routeAfter = await mappedRoute(env.ROUTER_HOSTS, hostname);
      const settled = await operationOf(clientId);
      // The dead runner, waking: holds nothing, writes and routes nothing.
      const stale =
        dead === undefined
          ? "none"
          : String(
              await failing(dead).then((error) =>
                error instanceof Error && "code" in error ? error.code : error
              )
            );
      const later = await codeOf(
        startClientRelease(db, staff, await attempt(clientId), {
          releaseId: b.releaseId,
        })
      );
      let staleExpected = "none";
      if (point.started) {
        staleExpected = "runner_replaced";
      } else if (dead !== undefined) {
        staleExpected = "null";
      }

      expect({
        offboarded,
        routeAfter,
        stale: dead === undefined ? "none" : stale,
        unchanged:
          JSON.stringify(await operationOf(clientId)) ===
          JSON.stringify(settled),
        routeAtEnd: await mappedRoute(env.ROUTER_HOSTS, hostname),
        later,
      }).toStrictEqual({
        offboarded: "started",
        routeAfter: null,
        // It lost its claim with the offboarding; one that never started
        // finds its operation done, and runs nothing.
        stale: staleExpected,
        unchanged: true,
        routeAtEnd: null,
        later: "client_not_active",
      });
    }
  );
});
