import {
  clientsNamespace,
  platformAccountId,
  stageOfNamespace,
} from "@grasp-os/shared/names";
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";
import { releaseManifestSchema } from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";
import { and, asc, eq, sql } from "drizzle-orm";
import { expect, vi } from "vite-plus/test";
import { z } from "zod";

import golden from "../../../scripts/release/testdata/golden-manifest.json" with { type: "json" };
import { cloudflareApi } from "../src/cloudflare/api.ts";
import { queryD1 } from "../src/cloudflare/workers.ts";
import {
  auditEvents,
  clientWorkers,
  clientPlacements,
  clientProvisions,
  clientRuns,
  clients,
  releases,
} from "../src/db/schema.ts";
import { mappedRoute } from "../src/deploy/router.ts";
import type { DeploySecrets } from "../src/deploy/secrets.ts";
import { clientInventory } from "../src/hosting/inventory.ts";
import {
  runClientProvision,
  startClientProvision,
  startClientRelease,
} from "../src/hosting/operation.ts";
import { claimRun, startingMs } from "../src/runners.ts";
import type { HeldClient } from "../src/runners.ts";
import { adminWorkflows } from "../src/workflow-runs.ts";
import { notFound } from "./cloudflare-api-kit.ts";
import type { AccountState, ApiCall, CoreState } from "./cloudflare-api-kit.ts";
import { fakeCloudflareApi } from "./cloudflare-api.ts";
import { clientScripts, graspAccount } from "./grasp-account.ts";
import { db, destination, placedClient, staff } from "./hosting.ts";
import { buildRelease, putBlobs } from "./releases.ts";
import type { ReleaseSpec } from "./releases.ts";
import { ended } from "./runs.ts";

/**
 * The provisioning operation's harness, shared by the
 * client-provision-*.test.ts files: the fake Cloudflare API and Secrets
 * Store, releases built and imported, placed clients set up and run, and
 * how what an operation left is read back.
 */

export const token = "test-deployer-token-0123456789";
/**
 * The fake Cloudflare API each file puts in place of `fetch` with
 * `mockCloudflareApi(token, cloudflare)`, registering its own hooks.
 */
export const cloudflare = fakeCloudflareApi(token);
export const api = cloudflareApi({ token, retryDelayMs: 0 });
export const secrets: DeploySecrets = {
  routerKey: "test-router-key",
  clientKey: "test-client-key",
  shared: {
    connect: {
      COMPOSIO_API_KEY: "composio",
      // Grasp's OpenAI key, which the platform AI's defaults use.
      OPENAI_API_KEY: "grasp-openai-key",
    },
  },
};
export const domain = "grasp.test";
export const context = {
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
    dispatcher: cloudflare.dispatcher(
      platformAccountId,
      clientsNamespace("production")
    ),
  },
  observe: { retryDelayMs: 0 },
};
export const namespace = clientsNamespace("production");
/**
 * The operation as an admin without its dispatcher binding runs it: it
 * uploads and delivers, and stops at the probe it can't qualify.
 */
export const unbound = {
  ...context,
  router: { ...context.router, dispatcher: undefined },
};
/** The namespace the admin and the router bind in these tests. */
export const clientDispatchNamespace = clientsNamespace("production");

/**
 * The binding kinds a Workers for Platforms user Worker takes, as the
 * operation qualifies them (src/hosting/operation.ts, `wfpBindings`).
 */
export const documented = new Set([
  "d1",
  "r2_bucket",
  "durable_object_namespace",
  "assets",
  "worker_loader",
  "version_metadata",
  "service",
]);

/** Core binding its connect, as the real one does (`adjust` for `importRelease`). */
export const bindsConnect = (core: WorkerEntry): WorkerEntry => ({
  ...core,
  bindings: [
    ...core.bindings.filter(({ name }) => name !== "CONNECT"),
    { type: "service", name: "CONNECT", service: "grasp-os-connect" },
  ],
});

/**
 * A release imported for a placed client: core binds its own Durable
 * Object classes, as the real one does, only the bindings Workers for
 * Platforms documents for user Workers, and no cron triggers. `adjust`
 * changes core.
 */
export const importRelease = async (
  spec: Partial<ReleaseSpec> = {},
  adjust: (core: WorkerEntry) => WorkerEntry = (core) => core
): Promise<ReleaseManifest> => {
  const built = await buildRelease({
    notes: "feat(core): place me",
    crons: [],
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
        bindings: core.bindings.filter(({ type }) => documented.has(type)),
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

/**
 * The release as `release:build` makes it from the real wrangler.jsonc of
 * core and connect (its golden test, scripts/release/manifest-lib.test.ts,
 * keeps it theirs): every binding, cron and Durable Object migration of
 * theirs, on the modules, assets and migrations of a test release, which
 * the bucket holds. Imported; `adjust` changes each Worker first.
 */
export const importRealRelease = async (
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
    builtAt: now,
    importedAt: now,
  });
  return manifest;
};

/** A client placed in `destinationId`, its operation started and claimed by a first attempt. */
export const placedOperation = async (
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

/**
 * A client placed in a destination on Grasp's account, in `inNamespace`
 * (the stage's clients' namespace unless said), its operation started
 * and claimed.
 */
export const setUp = async (
  manifest: ReleaseManifest,
  inNamespace = namespace
) => {
  const account = graspAccount(cloudflare);
  if (!account.namespaces.has(inNamespace)) {
    account.namespaces.set(inNamespace, new Map());
  }
  const destinationId = await destination(
    { accountId: account.id, namespace: inNamespace },
    stageOfNamespace(inNamespace) ?? "production"
  );
  const placed = await placedOperation(destinationId, manifest);
  return { account, destinationId, ...placed };
};

export const operationOf = async (clientId: string) =>
  await db
    .select()
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, clientId))
    .get();

/** The keys of `names` a rotation keeps the previous value of. */
export const previousKeys = (names: readonly string[]): string[] =>
  names.filter((name) => name.endsWith("_PREVIOUS"));
/** The rest: what a script runs with once the window has closed. */
export const currentKeys = (names: readonly string[]): string[] =>
  names.filter((name) => !name.endsWith("_PREVIOUS"));

/** A user Worker's script in a dispatch namespace: where it's put and read. */
export const userScriptPath =
  /\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/u;

/**
 * Cloudflare's read-after-write lag: the next `stale` reads of a user
 * Worker's script after each upload answer as before it, that it isn't
 * there. Returns how many reads were answered so, by script path.
 */
export const laggingUploads = (stale: number): Map<string, number> => {
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

/** The names of the secrets recorded as removed from client `clientId`'s scripts. */
export const revokedNamesOf = async (clientId: string): Promise<string[]> => {
  const recorded = await db
    .select({ detail: auditEvents.detail })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.clientId, clientId),
        eq(auditEvents.action, "provision.secret_revoked")
      )
    );
  return recorded
    .map(
      ({ detail }) =>
        z
          .object({ script: z.string(), name: z.string() })
          .loose()
          .parse(JSON.parse(detail ?? "{}")).name
    )
    .toSorted((x, y) => x.localeCompare(y));
};

/** Runs the operation expecting it to fail, its logged failure kept out of the output, and returns the error. */
export const failing = async (
  held: HeldClient,
  running: Parameters<typeof runClientProvision>[0] = context
): Promise<unknown> => {
  // oxlint-disable-next-line no-empty-function -- the run's errors, silenced
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await runClientProvision(running, held).then(
      () => null,
      (error: unknown) => error
    );
  } finally {
    errors.mockRestore();
  }
};

/** A script's upload, wherever it's put. */
export const isScriptUpload = ({ method, path }: ApiCall): boolean =>
  method === "PUT" && (path.endsWith("-core") || path.endsWith("-connect"));

/** A core script's upload, wherever it's put. */
export const isCoreUpload = ({ method, path }: ApiCall): boolean =>
  method === "PUT" && path.endsWith("-core");

/** The code an operation's failure carries, or what it was. */
export const codeFrom = (outcome: unknown): unknown =>
  outcome instanceof Error && "code" in outcome ? outcome.code : outcome;

/** The migrations each database in `account` recorded, by database name. */
export const appliedMigrations = async (
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
export const resourceOf = async (clientId: string, role: string) => {
  const inventory = await clientInventory(db, clientId);
  const row = inventory.find((resource) => resource.role === role);
  if (row === undefined) {
    throw new Error(`${clientId} has no ${role}`);
  }
  return row;
};

/** The files a call's form carries: all its parts but the metadata. */
export const filesSent = (call: ApiCall | undefined): number =>
  call?.body instanceof FormData
    ? [...call.body.keys()].filter((name) => name !== "metadata").length
    : 0;

/** How an R2 object is read whole, rather than streamed from `body`. */
export const wholeReads: ReadonlySet<PropertyKey> = new Set([
  "arrayBuffer",
  "bytes",
  "text",
  "json",
  "blob",
]);

/** `object` read from `body`, calling `onReadWhole` when it's read whole. */
export const withBody = (
  object: R2ObjectBody,
  body: ReadableStream,
  onReadWhole: () => void
): R2ObjectBody =>
  new Proxy(object, {
    get: (target, property): unknown => {
      if (property === "body") {
        return body;
      }
      if (wholeReads.has(property)) {
        onReadWhole();
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });

/** Client `clientId`'s core and connect scripts, as its inventory names them. */
export const scriptsOf = async (clientId: string) => {
  const [core, connect] = await Promise.all([
    resourceOf(clientId, "worker:grasp-os-core"),
    resourceOf(clientId, "worker:grasp-os-connect"),
  ]);
  return { core: core.physicalName, connect: connect.physicalName };
};

/** A script's live version's bindings, by name. */
export const liveBindings = (account: AccountState, script: string) => {
  const versions = clientScripts(account).get(script)?.versions ?? [];
  const bindings = z
    .array(z.object({ name: z.string() }).loose())
    .parse(versions.at(-1)?.metadata.bindings ?? []);
  return Object.fromEntries(bindings.map((binding) => [binding.name, binding]));
};

/** What the account holds, as names: anything made twice shows as a repeat. */
export const holdings = (account: AccountState) => ({
  d1: account.d1.map(({ name }) => name).toSorted(),
  buckets: account.buckets.map(({ name }) => name).toSorted(),
  scripts: [...clientScripts(account).keys()].toSorted(),
});

/**
 * What the account holds of client `clientId`'s own, as names: every
 * client shares the account, each named for its deployment.
 */
export const holdingsOf = async (account: AccountState, clientId: string) => {
  const placement = await db
    .select({ deploymentId: clientPlacements.deploymentId })
    .from(clientPlacements)
    .where(eq(clientPlacements.clientId, clientId))
    .get();
  const own = (name: string) =>
    name.startsWith(`grasp-${placement?.deploymentId ?? ""}-`);
  const all = holdings(account);
  return {
    d1: all.d1.filter(own),
    buckets: all.buckets.filter(own),
    scripts: all.scripts.filter(own),
  };
};

/** A migration sent, with its record (`applyD1Migrations`). */
export const isMigration = (call: ApiCall): boolean =>
  call.path.endsWith("/query") &&
  JSON.stringify(call.body).includes("INSERT INTO d1_migrations");

/** A read of which migrations a database has had (`applyD1Migrations`). */
export const readMigrations = (call: ApiCall): boolean =>
  call.path.endsWith("/query") &&
  JSON.stringify(call.body).includes("SELECT name FROM d1_migrations");

export const isUpload = (script: string) => (call: ApiCall) =>
  call.method === "PUT" && call.path.endsWith(`/scripts/${script}`);

/** How many of a script's uploads carried Durable Object migrations, as sent. */
export const migrationsRun = async (script: string): Promise<number> => {
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
export const actionsOf = async (clientId: string): Promise<string[]> => {
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
export const routed = async (clientId: string): Promise<boolean> =>
  (await mappedRoute(env.ROUTER_HOSTS, `${clientId}.${domain}`)) !== null;

/** The secrets each Worker runs with: derived for the client, and connect's shared one. */
export const wanted = {
  core: ["ROUTER_SECRET", "BETTER_AUTH_SECRET", "CAPABILITY_SIGNING_KEY"],
  connect: [
    "CAPABILITY_SIGNING_KEY",
    "TOKEN_ENCRYPTION_KEY",
    "COMPOSIO_API_KEY",
  ],
};

/** Everything a finished provisioning leaves of client `clientId`, in `account`. */
export const provisioned = async (account: AccountState, clientId: string) => {
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
    uploads: account.scriptUploads.map(({ script }) => script),
    coreMigrations: await migrationsRun(core),
    applied: Object.values(await appliedMigrations(account)).map(
      (names) => names.length
    ),
    // The secrets each Worker needs that its live version lacks.
    missingSecrets: [
      ...wanted.core.filter(
        (name) =>
          clientScripts(account)
            .get(core)
            ?.versions.at(-1)
            ?.secrets.has(name) !== true
      ),
      ...wanted.connect.filter(
        (name) =>
          clientScripts(account)
            .get(connect)
            ?.versions.at(-1)
            ?.secrets.has(name) !== true
      ),
    ],
  };
};

/** What `provisioned` says of a client provisioned once with a release that sends no mail, uploads aside. */
export const once = (clientId: string) => ({
  operation: { status: "done", step: "route", error: null },
  status: "active",
  claims: [],
  route: { clientId, generation: 1 },
  coreMigrations: 1,
  applied: [1, 1, 1],
  missingSecrets: [],
});

/** Where a run can stop, and how: a call answered with a failure, or a change made whose answer was lost. */
export interface Stop {
  step: string;
  /** The last step the operation recorded before it. */
  stopped: string;
  code: string;
  plan: (account: AccountState, clientId: string) => Promise<void> | void;
}

export const stops: Stop[] = [
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
    step: "probe",
    stopped: "core",
    code: "smoke_check_failed",
    plan: (_account, clientId) => {
      // As many failed health checks as the smoke check tries.
      cloudflare.coreOf(clientId).unhealthy = 5;
    },
  },
];

export interface ProbeFailure {
  name: string;
  probe: NonNullable<CoreState["coreProbe"]>;
  code: string;
}

/** Ways core's signed probe doesn't check out, after its health check did. */
export const probeFailures: ProbeFailure[] = [
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

export interface Refusal {
  name: string;
  adjust?: (core: WorkerEntry) => WorkerEntry;
  code: string;
}

export const refusals: Refusal[] = [
  {
    name: "a release with a binding Workers for Platforms doesn't document",
    adjust: (core) => ({
      ...core,
      bindings: [...core.bindings, { type: "kv_namespace", name: "CACHE" }],
    }),
    code: "wfp_binding_unqualified",
  },
];

/** A client provisioned in the stage's destination with `first`, and its account. */
export const liveClient = async (first: ReleaseManifest) => {
  const set = await setUp(first);
  await runClientProvision(context, set.held);
  return set;
};

/**
 * A new attempt holding client `clientId`, in place of the one before if
 * it left its claim (one that stopped), as starting a release claims one.
 */
export const attempt = async (clientId: string): Promise<HeldClient> => {
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
export const runs = async (clientId: string) => {
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
export const codeOf = async (promise: Promise<unknown>): Promise<string> => {
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
export const offboardedDaysAgo = async (clientId: string, days: number) => {
  await db
    .update(clients)
    .set({ offboardedAt: new Date(Date.now() - days * 86_400_000) })
    .where(eq(clients.id, clientId));
};

/**
 * Holds the next call `matches` picks out once it has been answered, until
 * released: its caller has read the answer, and does nothing with it yet.
 */
export const heldAfter = (matches: (call: ApiCall) => boolean) => {
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
export const attemptEnded = async (
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

/** Where a release B's runner stops for good, as a crash leaves it. */
export interface CrashPoint {
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

export const crashPoints: CrashPoint[] = [
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

export type Competing = "resume" | "another" | "rollback";
export const competing: Competing[] = ["resume", "another", "rollback"];

export const walk = crashPoints.flatMap((point) =>
  competing.map((action) => ({ ...point, action }))
);

/** Core with a class of its own added, by a Durable Object migration. */
export const withExtraClass = (core: WorkerEntry): WorkerEntry => ({
  ...core,
  durableObjectMigrations: [
    ...core.durableObjectMigrations,
    { tag: "v2", new_sqlite_classes: ["Extra"] },
  ],
});

/** What the walk expects of an action after a crash point. */
export interface Expected {
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
export const expectedOf = (
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
export const crashedAt = async (point: CrashPoint) => {
  const { started, claimed, plan } = point;
  const a = await importRelease();
  const { clientId } = await liveClient(a);
  const scripts = await scriptsOf(clientId);
  // B adds a class (a Durable Object migration) and a table; C keeps
  // both and adds a table of its own.
  const b = await importRelease(
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
