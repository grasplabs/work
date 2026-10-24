/**
 * Provisioning a client placed in a hosting destination (spec 40.2): one
 * operation per client, run by the runner that holds it (src/runners.ts),
 * through its steps in order:
 *
 * 1. `validated`: the release is imported and declares what it works with
 *    (`incompatibility`, as deploys check it), the destination can run
 *    every binding it uses, the client's secrets and core config can be
 *    made, and its resources are allocated in its inventory.
 * 2. `resources`: its databases and buckets exist, each id recorded
 *    (`ensureClientResources`).
 * 4. `migrations`: the release's D1 migrations, applied to the inventory's
 *    databases, by their observed ids.
 * 3. and 6. `connect`, then `core`: each Worker rendered onto the client's
 *    inventory (`renderClientWorker`) and uploaded as its stable script,
 *    with its Durable Object migrations, then observed.
 * 5. `secrets`: the client's derived secrets and the shared ones its
 *    Workers need, delivered by name to each script, then observed.
 * 7. `probe`: core answers its health check as the version live, with the
 *    router secret the router will send (`smokeCheck`), then the
 *    admin's signed probe (src/hosting/probe.ts): it runs as this
 *    client, each private binding the release gives it answers, and its
 *    clock and connect's are armed.
 * 8. `mail`, then `route`: for a release that sends mail, the client's
 *    sending domain (`clientMailDomain`) with Email Sending on in the
 *    destination's account (`ensureSendingDomain`), as a deploy sets it
 *    up, so core's `EMAIL` sends from the onboarding sender it's locked
 *    to; only then the client's hostname in the router's map.
 * 9. `done`: the operation recorded complete, the client active and the
 *    runner's claim released, in one batch.
 *
 * Steps 3 and 6 are one upload per Worker: a script is created by its
 * first upload, which carries its modules and Durable Object migrations,
 * and it goes live at once. Secrets come after (step 5), so an upload
 * keeps the secrets its script has, and any upload makes the next run
 * deliver them again. The client stays unreachable until step 8.
 *
 * Every step can run again: a retry, by the same runner or one that took
 * the client over, runs the operation from its first step, and each step
 * finds what an earlier run did. Resources are found by their recorded
 * names and ids; migrations skip what a database applied; the sending
 * domain's zone is found by its name, and sending turned on only where
 * it's off; an upload whose
 * fingerprint (everything that went into it) is recorded, and whose
 * script is observed at the release's migration tag, isn't made again;
 * secrets whose fingerprint is recorded aren't delivered again. Nothing
 * here deletes: an automatic retry never removes a resource, script or
 * secret.
 *
 * Every write to the admin's records is conditional on the runner still
 * holding the client (`stillHolds`), and it checks it holds the client
 * right before each provider write: a runner that lost the client stops
 * (`runner_replaced`) and records nothing more. That is not provider-side
 * fencing: a call already in flight can still land, and the runner that
 * holds the client next finds and reconciles what it left (spec 39.1).
 *
 * Not here, on purpose:
 * - Probes beyond identity, private resources and clocks (a sandbox call,
 *   an owned workflow): core's probe doesn't make them yet.
 * - The model-spend admission ceiling (40.5) waits for a product decision
 *   (GRA-141), and the shared AI Gateway reference for a destination (37.5)
 *   isn't recorded yet. Until both exist, a release whose Worker binds
 *   Workers AI is refused (`model_spend_undecided`) rather than given
 *   unbounded spend on the destination's account.
 * - A Workers for Platforms destination: its documented upload, secrets
 *   and script details calls are used, and any binding its documentation
 *   doesn't list for user Workers is refused before an upload
 *   (`wfp_binding_unqualified`): a release that sends mail among them, as
 *   whether a user Worker can send through a `send_email` binding at all
 *   is a spike of its own. How the admin probes, and the router
 *   reaches, a user Worker in a namespace isn't qualified, so the probe
 *   stops there (`probe_unqualified`) and the hostname stays unpublished.
 *   Real-account qualification is GRA-430's.
 *
 * Failures are recorded as codes, never messages; secret values never
 * reach a row, an audit event or a log line, only their keyed
 * fingerprints.
 */
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { log } from "@grasp-os/shared/log";
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";
import { deriveRouterSecret } from "@grasp-os/shared/router";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { findD1Database } from "../cloudflare/accounts.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import { ensureSendingDomain } from "../cloudflare/email-sending.ts";
import {
  liveVersion,
  putSchedules,
  putTargetSecret,
  setScriptSubdomain,
  targetMigrationState,
  targetSecretNames,
  uploadTargetScript,
} from "../cloudflare/workers.ts";
import type { ScriptTarget } from "../cloudflare/workers.ts";
import { actIfChanged } from "../db/act.ts";
import type { Actor, AdminDatabase } from "../db/act.ts";
import { clientProvisions, clients, clientWorkers } from "../db/schema.ts";
import {
  appliedSchema,
  currentReleases,
  incompatibility,
} from "../deploy/compatibility.ts";
import { clientMailDomain, derivedCoreConfig } from "../deploy/core-config.ts";
import type { SignInApps } from "../deploy/core-config.ts";
import {
  configuredCoreVars,
  errorCode,
  mailSenderOf,
} from "../deploy/deploy.ts";
import { migrateDatabases } from "../deploy/migrations.ts";
import { importedManifest } from "../deploy/release.ts";
import { sendsMail } from "../deploy/resources.ts";
import {
  coreOrigin,
  registerHostname,
  smokeCheck,
  workersSubdomain,
} from "../deploy/router.ts";
import type { RouterHosts, SmokeOptions } from "../deploy/router.ts";
import { sealedWorkerSecrets } from "../deploy/sealed-secrets.ts";
import { clientAuthSecret, workerSecrets } from "../deploy/secrets.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import {
  checkBindingNames,
  keyedHash,
  lockMailSender,
  renderedWorkerUpload,
  secretsFingerprint,
} from "../deploy/upload.ts";
import { deployOrder, pendingMigrations } from "../deploy/versions.ts";
import type { ReleaseStore } from "../releases/import.ts";
import { holdsClient, releaseRun, stillHolds } from "../runners.ts";
import type { HeldClient } from "../runners.ts";
import {
  allocateClientResources,
  destinationOf,
  InventoryError,
  placementOf,
  renderClientWorker,
} from "./inventory.ts";
import type { ClientPlacement, ClientResource } from "./inventory.ts";
import { privateBindings, probeCore, probeFault } from "./probe.ts";
import { ensureClientResources } from "./provision.ts";

export const provisionOperationErrorCodes = [
  /** The client has no record. */
  "client_unknown",
  /** The operation's release isn't imported. */
  "release_not_imported",
  /** The release declares nothing of what its code works with. */
  "release_undeclared",
  /** The release doesn't work with what the client runs, or with itself, Worker by Worker. */
  "release_incompatible",
  /** The release's code doesn't run on a database's schema as the client's migrations left it. */
  "schema_incompatible",
  /** The operation provisions another release: it's fixed for the operation. */
  "operation_release_changed",
  /** The release has a Worker other than core and connect. */
  "unknown_worker",
  /**
   * A Worker binds Workers AI: no model spend until a ceiling is configured
   * (GRA-141) and the destination's shared gateway is recorded (spec 37.5).
   */
  "model_spend_undecided",
  /** A binding kind Workers for Platforms doesn't document for user Workers. */
  "wfp_binding_unqualified",
  /** Cron triggers, which Workers for Platforms doesn't document for user Workers. */
  "wfp_schedule_unqualified",
  /** A script isn't at the release's Durable Object migration after its upload. */
  "upload_unobserved",
  /** A script lacks a secret after it was delivered. */
  "secrets_unobserved",
  /** No qualified way to probe core in this destination (Workers for Platforms, until GRA-430). */
  "probe_unqualified",
  /** Core didn't answer the admin's signed probe, as a core from before it doesn't. */
  "probe_unanswered",
  /** Core answered the probe as another client, or another version than the one live. */
  "probe_identity_mismatch",
  /** A private binding the release gives core didn't answer the probe. */
  "probe_binding_unanswered",
  /** Core's clock or connect's isn't armed with tasks after the probe. */
  "probe_clock_unarmed",
  /** Another runner holds the client: this one changes nothing more. */
  "runner_replaced",
  /** The operation's row is gone before it could be recorded done. */
  "operation_gone",
] as const;

export type ProvisionOperationErrorCode =
  (typeof provisionOperationErrorCodes)[number];

/** Why an operation stopped: a fixed code and identifiers only. */
export class ProvisionOperationError extends Error {
  readonly code: ProvisionOperationErrorCode;

  constructor(code: ProvisionOperationErrorCode, message: string) {
    super(message);
    this.name = "ProvisionOperationError";
    this.code = code;
  }
}

/**
 * A failure as the operation records it: its own code or the inventory's,
 * otherwise a deploy's (`errorCode`: a `DeployError`'s code,
 * `cloudflare_<status>_<codes>`, or `unexpected`).
 */
export const operationErrorCode = (error: unknown): string =>
  error instanceof ProvisionOperationError || error instanceof InventoryError
    ? error.code
    : errorCode(error);

/** The steps of an operation, in order; the row records the last that finished. */
export const provisionSteps = [
  "validated",
  "resources",
  "migrations",
  "connect",
  "core",
  "secrets",
  "probe",
  "mail",
  "route",
] as const;
export type ProvisionStep = (typeof provisionSteps)[number];

/** What an operation works with: a deploy's context, without its runner. */
export interface ProvisionContext {
  api: CloudflareApi;
  db: AdminDatabase;
  store: ReleaseStore;
  secrets: DeploySecrets;
  signInApps?: SignInApps;
  now?: () => Date;
  router: {
    hosts: RouterHosts;
    domain: string;
    smoke?: SmokeOptions;
  };
}

/** What the operation's steps observed, as its row keeps it. */
const progressSchema = z.object({
  /** Each Worker's last upload: the fingerprint of everything in it. */
  uploads: z.record(z.string(), z.string()).default({}),
  /** Each Worker's delivered secrets: their fingerprint, names and values. */
  secrets: z.record(z.string(), z.string()).default({}),
  /** The core origin the probe passed at. */
  origin: z.string().optional(),
  /**
   * The sending domain's zone, for a release that sends mail, and whether
   * it was active (its name servers delegated) when last ensured.
   */
  mail: z.object({ zoneId: z.string(), active: z.boolean() }).optional(),
});
type Progress = z.infer<typeof progressSchema>;

const apps = ["connect", "core"] as const;
type App = (typeof apps)[number];
const appSchema = z.enum(apps);

/**
 * Binding kinds Cloudflare documents for Workers for Platforms user
 * Workers: D1, R2 and Durable Objects (configuration/bindings), and
 * static assets (configuration/static-assets). The vars and secrets the
 * admin adds go in the upload's own metadata and secrets calls. Every
 * other kind core and connect bind (a service binding to connect, Worker
 * Loader, version metadata, email) waits for real-account qualification
 * (GRA-430) rather than be assumed to work.
 */
const wfpBindings: ReadonlySet<string> = new Set([
  "d1",
  "r2_bucket",
  "durable_object_namespace",
  "assets",
]);

/** Throws `runner_replaced` unless `held` still holds its client. */
const assertHolds = async (
  db: AdminDatabase,
  held: HeldClient
): Promise<void> => {
  if (!(await holdsClient(db, held.clientId, held.runId))) {
    throw new ProvisionOperationError(
      "runner_replaced",
      `${held.runId} no longer holds ${held.clientId}`
    );
  }
};

const actorName = (actor: Actor): string =>
  actor === "system" ? actor : actor.email;

/** Client `clientId`'s operation, if it has one. */
export const provisionOf = async (db: AdminDatabase, clientId: string) =>
  await db
    .select()
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, clientId))
    .get();

/**
 * Records the operation that provisions client `clientId` with release
 * `releaseId`, as `actor`, and returns its id: the one it has already
 * when it has one, so starting again resumes it (spec 40.1). An operation
 * of another release is refused (`operation_release_changed`): it isn't
 * replaced.
 */
export const startClientProvision = async (
  db: AdminDatabase,
  actor: Actor,
  clientId: string,
  releaseId: string
): Promise<string> => {
  const now = new Date();
  const id = crypto.randomUUID();
  await actIfChanged(
    db,
    actor,
    db
      .insert(clientProvisions)
      .values({
        id,
        clientId,
        releaseId,
        status: "running",
        startedBy: actorName(actor),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing(),
    {
      action: "provision.start",
      clientId,
      target: releaseId,
      detail: { operation: id },
    }
  );
  const operation = await provisionOf(db, clientId);
  if (operation === undefined) {
    throw new Error(`${clientId} has no operation after starting one`);
  }
  if (operation.releaseId !== releaseId) {
    throw new ProvisionOperationError(
      "operation_release_changed",
      `${clientId} is being provisioned with ${operation.releaseId}`
    );
  }
  return operation.id;
};

type Operation = NonNullable<Awaited<ReturnType<typeof provisionOf>>>;

/** What a run of the operation works on, loaded once. */
interface Loaded {
  operation: Operation;
  held: HeldClient;
  manifest: ReleaseManifest;
  placement: ClientPlacement;
  destination: Awaited<ReturnType<typeof destinationOf>>;
  accountId: string;
  client: {
    generation: number;
    rotationLiveAt: Date | null;
    signIn: string | null;
  };
}

/** The operation's progress, read afresh. */
const progressNow = async (
  db: AdminDatabase,
  id: string
): Promise<Progress> => {
  const row = await db
    .select({ progress: clientProvisions.progress })
    .from(clientProvisions)
    .where(eq(clientProvisions.id, id))
    .get();
  return progressSchema.parse(JSON.parse(row?.progress ?? "{}"));
};

/**
 * Records `step` finished, with `progress` when given and what it did,
 * audited, while `held` holds the client; `runner_replaced` otherwise.
 */
const recordStep = async (
  db: AdminDatabase,
  loaded: Loaded,
  step: ProvisionStep,
  detail: Record<string, number | string> = {},
  progress?: Progress
): Promise<void> => {
  const { operation, held } = loaded;
  const recorded = await actIfChanged(
    db,
    "system",
    db
      .update(clientProvisions)
      .set({
        step,
        status: "running",
        error: null,
        runId: held.runId,
        updatedAt: new Date(),
        ...(progress === undefined
          ? {}
          : { progress: JSON.stringify(progress) }),
      })
      .where(and(eq(clientProvisions.id, operation.id), stillHolds(held))),
    {
      action: `provision.${step}`,
      clientId: held.clientId,
      target: operation.releaseId,
      detail: { operation: operation.id, run: held.runId, ...detail },
    }
  );
  if (!recorded) {
    await assertHolds(db, held);
    throw new Error(`Operation ${operation.id} is gone`);
  }
};

/**
 * Records progress `progress` alone, while `held` holds the client:
 * what an upload or a delivery observed, before its step finishes.
 */
const recordProgress = async (
  db: AdminDatabase,
  { operation, held }: Loaded,
  progress: Progress
): Promise<void> => {
  const recorded = await actIfChanged(
    db,
    "system",
    db
      .update(clientProvisions)
      .set({ progress: JSON.stringify(progress), updatedAt: new Date() })
      .where(and(eq(clientProvisions.id, operation.id), stillHolds(held))),
    {
      action: "provision.progress",
      clientId: held.clientId,
      target: operation.releaseId,
      detail: { operation: operation.id, run: held.runId },
    }
  );
  if (!recorded) {
    await assertHolds(db, held);
  }
};

/** The release's Worker `app`. */
const workerOf = (manifest: ReleaseManifest, app: App): WorkerEntry => {
  const worker = manifest.workers[app];
  if (worker === undefined) {
    throw new ProvisionOperationError(
      "unknown_worker",
      `The release has no ${app} Worker`
    );
  }
  return worker;
};

/** The release's Workers in the order they go live: connect, then core. */
const appsOf = (manifest: ReleaseManifest): App[] =>
  deployOrder(manifest.workers).map((app) => {
    const parsed = appSchema.safeParse(app);
    if (!parsed.success) {
      throw new ProvisionOperationError(
        "unknown_worker",
        `The admin doesn't provision the Worker ${app}`
      );
    }
    return parsed.data;
  });

/** Where Worker `app`'s script is in the client's destination. */
const targetOf = (
  loaded: Loaded,
  inventory: readonly ClientResource[],
  app: App
): ScriptTarget => {
  const worker = workerOf(loaded.manifest, app);
  return {
    accountId: loaded.accountId,
    scriptName: renderClientWorker(worker, loaded.placement, inventory)
      .scriptName,
    namespace:
      loaded.destination.kind === "workers_for_platforms"
        ? loaded.destination.namespace
        : null,
  };
};

/**
 * Throws unless the destination can run `worker` as the release declares
 * it: no Workers AI anywhere (`model_spend_undecided`), and in a Workers
 * for Platforms namespace only documented bindings and no cron triggers.
 */
const assertRunnable = (loaded: Loaded, worker: WorkerEntry): void => {
  const ai = worker.bindings.find(({ type }) => type === "ai");
  if (ai !== undefined) {
    throw new ProvisionOperationError(
      "model_spend_undecided",
      `${worker.name}'s ${ai.name} binds Workers AI, but no spend ceiling or shared gateway is configured for placed clients`
    );
  }
  if (loaded.destination.kind !== "workers_for_platforms") {
    return;
  }
  const unqualified = worker.bindings.find(
    ({ type }) => !wfpBindings.has(type)
  );
  if (unqualified !== undefined) {
    throw new ProvisionOperationError(
      "wfp_binding_unqualified",
      `${worker.name}'s ${unqualified.name} is a ${unqualified.type} binding, which Workers for Platforms doesn't document for user Workers`
    );
  }
  if (worker.crons.length > 0) {
    throw new ProvisionOperationError(
      "wfp_schedule_unqualified",
      `${worker.name} has cron triggers, which Workers for Platforms doesn't document for user Workers`
    );
  }
};

/**
 * Core's vars: its derived sign-in and runtime profile, the client's
 * settings, and the change core records. No `MODEL_GATEWAY`: a placed
 * client's gateway is the destination's shared one (spec 37.5), which
 * isn't recorded yet, and no Worker of a placed client binds Workers AI
 * (`assertRunnable`).
 */
const coreVarsOf = async (
  context: ProvisionContext,
  loaded: Loaded
): Promise<Record<string, unknown>> => {
  const { MODEL_GATEWAY: _gateway, ...derived } = derivedCoreConfig({
    clientId: loaded.held.clientId,
    signIn: loaded.client.signIn,
    domain: context.router.domain,
    apps: context.signInApps ?? {},
  });
  return await configuredCoreVars(
    context.db,
    loaded.held.clientId,
    derived,
    {
      by: loaded.operation.startedBy,
      what: "release",
      release: loaded.operation.releaseId,
      // When the operation started: the same however often it's resumed.
      at: loaded.operation.createdAt.toISOString(),
    },
    mailSenderOf(context, loaded.held.clientId)
  );
};

/** The secrets Worker `app` runs with: the client's derived and sealed ones, and the shared ones it needs. */
const secretsOf = async (context: ProvisionContext, loaded: Loaded, app: App) =>
  await workerSecrets(
    app,
    workerOf(loaded.manifest, app),
    context.secrets,
    {
      id: loaded.held.clientId,
      generation: loaded.client.generation,
      rotationLiveAt: loaded.client.rotationLiveAt,
    },
    context.now?.() ?? new Date(),
    await sealedWorkerSecrets(
      context.db,
      context.secrets.clientKey,
      loaded.held.clientId,
      app
    )
  );

/**
 * Loads client `held.clientId`'s `operation` to run. Refused unless the
 * client is recorded, placed in a Cloudflare destination and its release
 * imported.
 */
const load = async (
  db: AdminDatabase,
  held: HeldClient,
  operation: Operation
): Promise<Loaded> => {
  const client = await db
    .select({
      generation: clients.generation,
      rotationLiveAt: clients.rotationLiveAt,
      signIn: clients.signIn,
    })
    .from(clients)
    .where(eq(clients.id, held.clientId))
    .get();
  if (client === undefined) {
    throw new ProvisionOperationError(
      "client_unknown",
      `No client ${held.clientId}`
    );
  }
  const manifest = await importedManifest(db, operation.releaseId);
  if (manifest === null) {
    throw new ProvisionOperationError(
      "release_not_imported",
      `Release ${operation.releaseId} isn't imported`
    );
  }
  const placement = await placementOf(db, held.clientId);
  if (placement === undefined) {
    throw new InventoryError("not_placed", `${held.clientId} isn't placed`);
  }
  const destination = await destinationOf(db, placement.destinationId);
  const usable =
    destination.accountId !== null &&
    (destination.kind === "dedicated" ||
      (destination.kind === "workers_for_platforms" &&
        destination.namespace !== null));
  if (!usable || destination.accountId === null) {
    throw new InventoryError(
      "destination_unsupported",
      `${destination.id} isn't a Cloudflare destination the admin provisions in`
    );
  }
  return {
    operation,
    held,
    manifest,
    placement,
    destination,
    accountId: destination.accountId,
    client,
  };
};

/**
 * Step 1: everything checked before the client's destination is changed,
 * then its resources allocated in its inventory.
 */
const validate = async (
  context: ProvisionContext,
  loaded: Loaded
): Promise<void> => {
  const { db } = context;
  const { manifest, held } = loaded;
  const order = appsOf(manifest);
  const refused = incompatibility(
    await currentReleases(db, held.clientId),
    manifest,
    order,
    await appliedSchema(db, held.clientId)
  );
  if (refused !== null) {
    throw new ProvisionOperationError(refused.code, refused.message);
  }
  const vars = await coreVarsOf(context, loaded);
  for (const app of order) {
    const worker = workerOf(manifest, app);
    assertRunnable(loaded, worker);
    // oxlint-disable-next-line no-await-in-loop -- two Workers
    const secrets = await secretsOf(context, loaded, app);
    checkBindingNames(worker, app === "core" ? vars : {}, secrets);
  }
  await assertHolds(db, held);
  await allocateClientResources(db, "system", {
    clientId: held.clientId,
    manifest,
    operationId: loaded.operation.id,
  });
  await recordStep(db, loaded, "validated", { workers: order.length });
};

/**
 * The inventory's databases' ids by the release's names, each checked
 * against what the provider reports under its recorded name first: an id
 * that isn't the client's own database (recorded wrongly, or since
 * replaced) stops the operation before anything binds or migrates it.
 */
const observedDatabases = async (
  context: ProvisionContext,
  loaded: Loaded,
  inventory: readonly ClientResource[]
): Promise<Map<string, string>> => {
  const databases = new Map<string, string>();
  for (const row of inventory) {
    if (row.kind !== "d1_database" || row.lifecycle !== "allocated") {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a few databases
    const found = await findD1Database(
      context.api,
      loaded.accountId,
      row.physicalName
    );
    if (row.providerId === null || found?.uuid !== row.providerId) {
      throw new InventoryError(
        "foreign_resource",
        `${loaded.held.clientId}'s ${row.role} isn't observed as ${row.physicalName}`
      );
    }
    databases.set(row.role.slice("d1:".length), row.providerId);
  }
  return databases;
};

/** Step 4: the release's D1 migrations, on the client's own databases. */
const migrate = async (
  context: ProvisionContext,
  loaded: Loaded,
  inventory: readonly ClientResource[]
): Promise<void> => {
  const databases = await observedDatabases(context, loaded, inventory);
  await assertHolds(context.db, loaded.held);
  const applied = await migrateDatabases(
    context.api,
    loaded.accountId,
    databases,
    loaded.manifest,
    context.store
  );
  await recordStep(context.db, loaded, "migrations", {
    applied: [...applied.values()].reduce((sum, count) => sum + count, 0),
  });
};

/** What a placed client's upload fingerprint is keyed with, derived from `CLIENT_KEY` for it alone. */
const uploadFingerprintPurpose = "grasp-os console placed upload fingerprint";

/**
 * Steps 3 and 6 for Worker `app`: rendered onto the client's inventory and
 * uploaded as its script, unless the upload recorded with the same
 * fingerprint is observed already; then observed at the release's last
 * Durable Object migration, and recorded as what the client runs.
 */
const upload = async (
  context: ProvisionContext,
  loaded: Loaded,
  inventory: readonly ClientResource[],
  app: App
): Promise<void> => {
  const { api, db, store } = context;
  const { manifest, held, placement } = loaded;
  const worker = workerOf(manifest, app);
  const rendered = renderClientWorker(worker, placement, inventory);
  // Its mail sends from the client's onboarding sender alone, as a
  // deploy's does (`renderBindings`).
  const mailSender = mailSenderOf(context, held.clientId);
  for (const binding of rendered.bindings) {
    lockMailSender(binding, mailSender);
  }
  const target = targetOf(loaded, inventory, app);
  const vars = app === "core" ? await coreVarsOf(context, loaded) : {};
  const fingerprint = await keyedHash(
    await hkdfHmacKey(context.secrets.clientKey, uploadFingerprintPurpose, [
      "sign",
    ]),
    {
      target,
      releaseId: manifest.releaseId,
      compatibilityDate: manifest.compatibilityDate,
      compatibilityFlags: worker.compatibilityFlags,
      mainModule: worker.mainModule,
      modules: worker.modules.map(({ name, type, sha256 }) => [
        name,
        type,
        sha256,
      ]),
      assets: worker.assets ?? null,
      observability: worker.observability,
      durableObjectMigrations: worker.durableObjectMigrations,
      bindings: rendered.bindings,
      vars,
    }
  );
  const lastTag = worker.durableObjectMigrations.at(-1)?.tag;
  const progress = await progressNow(db, loaded.operation.id);
  const before = await targetMigrationState(api, target);
  const done =
    progress.uploads[app] === fingerprint &&
    before.exists &&
    before.migrationTag === lastTag;
  if (!done) {
    const migrations = pendingMigrations(
      worker.durableObjectMigrations,
      before.migrationTag
    );
    const prepared = await renderedWorkerUpload(
      store,
      manifest,
      worker,
      rendered.bindings,
      vars
    );
    // Delivered secrets go with the next delivery, whatever this upload keeps.
    const { [app]: _delivered, ...secrets } = progress.secrets;
    await recordProgress(db, loaded, { ...progress, secrets });
    await assertHolds(db, held);
    await uploadTargetScript(api, target, {
      ...prepared,
      metadata: {
        ...prepared.metadata,
        ...(migrations === undefined ? {} : { migrations }),
      },
    });
    const after = await targetMigrationState(api, target);
    if (!after.exists || after.migrationTag !== lastTag) {
      throw new ProvisionOperationError(
        "upload_unobserved",
        `${target.scriptName} isn't at migration ${lastTag ?? "none"} after its upload`
      );
    }
    await recordProgress(db, loaded, {
      ...progress,
      secrets,
      uploads: { ...progress.uploads, [app]: fingerprint },
    });
  }
  if (target.namespace === null) {
    // An account's own Worker: its cron triggers, and whether it's on
    // workers.dev (how the probe reaches core). Each a PUT or a set.
    await assertHolds(db, held);
    await putSchedules(api, target.accountId, target.scriptName, worker.crons);
    await setScriptSubdomain(api, target.accountId, target.scriptName, {
      enabled: worker.workersDev,
      previewsEnabled: false,
    });
  }
  // What the client runs, as a deploy records it: only while the runner
  // holds the client, in the same statement.
  const recorded = await actIfChanged(
    db,
    "system",
    db
      .insert(clientWorkers)
      .select(
        sql`SELECT ${held.clientId}, ${app}, ${target.scriptName}, ${manifest.releaseId}, NULL, ${Date.now()} WHERE ${stillHolds(held)}`
      )
      .onConflictDoUpdate({
        target: [clientWorkers.clientId, clientWorkers.worker],
        set: {
          scriptName: target.scriptName,
          releaseId: manifest.releaseId,
          versionId: null,
          deployedAt: new Date(),
        },
      }),
    {
      action: "provision.worker_live",
      clientId: held.clientId,
      target: manifest.releaseId,
      detail: { operation: loaded.operation.id, worker: app },
    }
  );
  if (!recorded) {
    await assertHolds(db, held);
  }
  await recordStep(db, loaded, app, { uploaded: done ? 0 : 1 });
};

/**
 * Step 5: each Worker's secrets delivered by name to its script, unless
 * the same secrets are recorded as delivered since its last upload; then
 * observed by name. Only their keyed fingerprint is recorded.
 */
const deliverSecrets = async (
  context: ProvisionContext,
  loaded: Loaded,
  inventory: readonly ClientResource[]
): Promise<void> => {
  const { api, db } = context;
  let delivered = 0;
  for (const app of appsOf(loaded.manifest)) {
    const target = targetOf(loaded, inventory, app);
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
    const secrets = await secretsOf(context, loaded, app);
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
    const print = await secretsFingerprint(context.secrets.clientKey, secrets);
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
    const progress = await progressNow(db, loaded.operation.id);
    if (progress.secrets[app] === print) {
      // Delivered since the last upload, but a secret can be deleted
      // since: skip only when every one is still there by name.
      // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
      const present = new Set(await targetSecretNames(api, target));
      if (secrets.every(({ name }) => present.has(name))) {
        continue;
      }
    }
    for (const secret of secrets) {
      // oxlint-disable-next-line no-await-in-loop -- one secret at a time
      await assertHolds(db, loaded.held);
      // oxlint-disable-next-line no-await-in-loop -- one secret at a time
      await putTargetSecret(api, target, secret);
      delivered += 1;
    }
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
    const names = new Set(await targetSecretNames(api, target));
    const missing = secrets.find(({ name }) => !names.has(name));
    if (missing !== undefined) {
      throw new ProvisionOperationError(
        "secrets_unobserved",
        `${target.scriptName} lacks ${missing.name} after its delivery`
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
    await recordProgress(db, loaded, {
      ...progress,
      secrets: { ...progress.secrets, [app]: print },
    });
  }
  await recordStep(db, loaded, "secrets", { delivered });
};

/** How long core's signed probe may take, its body included. */
const probeTimeoutMs = 10_000;

/**
 * Step 7: core answers its health check, as the version live, to the
 * router secret the router will send, then the admin's signed probe as
 * this client at that version, each of its private bindings answering
 * and both clocks armed. Returns its origin.
 */
const probe = async (
  context: ProvisionContext,
  loaded: Loaded,
  inventory: readonly ClientResource[]
): Promise<string> => {
  const { api, db } = context;
  const { held } = loaded;
  const target = targetOf(loaded, inventory, "core");
  if (target.namespace !== null) {
    throw new ProvisionOperationError(
      "probe_unqualified",
      `No qualified way to reach ${target.scriptName} in namespace ${target.namespace} yet`
    );
  }
  const subdomain = await workersSubdomain(
    api,
    target.accountId,
    held.clientId
  );
  const origin = coreOrigin(target.scriptName, subdomain);
  const version = await liveVersion(api, target.accountId, target.scriptName);
  if (version === undefined) {
    throw new ProvisionOperationError(
      "upload_unobserved",
      `${target.scriptName} has no version live`
    );
  }
  const routerSecret = await deriveRouterSecret(
    context.secrets.routerKey,
    held.clientId,
    loaded.client.generation
  );
  const attempts = await smokeCheck(
    origin,
    routerSecret,
    version,
    context.router.smoke
  );
  const answer = await probeCore({
    origin,
    routerSecret,
    authSecret: await clientAuthSecret(
      context.secrets,
      held.clientId,
      loaded.client.generation
    ),
    fetch: context.router.smoke?.fetch ?? fetch,
    timeoutMs: context.router.smoke?.attemptTimeoutMs ?? probeTimeoutMs,
  });
  if (answer === undefined) {
    throw new ProvisionOperationError(
      "probe_unanswered",
      `Core at ${origin} didn't answer the admin's probe`
    );
  }
  const fault = probeFault(answer, {
    clientId: held.clientId,
    version,
    bindings: privateBindings(workerOf(loaded.manifest, "core")),
  });
  if (fault !== null) {
    throw new ProvisionOperationError(fault.code, fault.message);
  }
  const progress = await progressNow(db, loaded.operation.id);
  await recordStep(db, loaded, "probe", { attempts }, { ...progress, origin });
  return origin;
};

/**
 * Step 8, first part: for a release that sends mail, the client's sending
 * domain in the destination's account with Email Sending on, found before
 * anything is created (`ensureSendingDomain`); a release that sends none
 * sets up nothing. Before the hostname is published, so no client is
 * reachable whose mail has nowhere to send from.
 */
const setUpMail = async (
  context: ProvisionContext,
  loaded: Loaded
): Promise<void> => {
  const { db } = context;
  if (!sendsMail(loaded.manifest)) {
    await recordStep(db, loaded, "mail");
    return;
  }
  await assertHolds(db, loaded.held);
  const sending = await ensureSendingDomain(
    context.api,
    loaded.accountId,
    clientMailDomain(loaded.held.clientId, context.router.domain)
  );
  const progress = await progressNow(db, loaded.operation.id);
  await recordStep(
    db,
    loaded,
    "mail",
    // Mail sends only once the zone is delegated, which happens outside
    // the operation: on record for staff to see, as a deploy records it.
    { mailDomainActive: sending.active ? 1 : 0 },
    {
      ...progress,
      mail: { zoneId: sending.zoneId, active: sending.active },
    }
  );
};

/** Step 8: the client's hostname in the router's map, only after the probe passed. */
const route = async (
  context: ProvisionContext,
  loaded: Loaded,
  origin: string
): Promise<void> => {
  const { held } = loaded;
  await registerHostname(
    context.router.hosts,
    `${held.clientId}.${context.router.domain}`,
    {
      clientId: held.clientId,
      coreUrl: origin,
      generation: loaded.client.generation,
    },
    // The last thing before the write: KV can't make it conditional.
    async () => {
      await assertHolds(context.db, held);
    }
  );
  await recordStep(context.db, loaded, "route", {
    generation: loaded.client.generation,
  });
};

/**
 * Step 9: the operation done, the client active and the runner's claim
 * released, in one batch, while the runner holds the client.
 */
const complete = async (db: AdminDatabase, loaded: Loaded): Promise<void> => {
  const { operation, held } = loaded;
  await assertHolds(db, held);
  const now = new Date();
  // Guarded, not merely checked first: a runner that loses its claim
  // between the check and the batch records nothing.
  const finished = await actIfChanged(
    db,
    "system",
    db
      .update(clientProvisions)
      .set({ status: "done", updatedAt: now })
      .where(and(eq(clientProvisions.id, operation.id), stillHolds(held))),
    {
      action: "provision.done",
      clientId: held.clientId,
      target: operation.releaseId,
      detail: { operation: operation.id, run: held.runId },
    },
    [
      db
        .update(clients)
        .set({ status: "active", updatedAt: now })
        .where(
          and(
            eq(clients.id, held.clientId),
            eq(clients.status, "provisioning"),
            stillHolds(held)
          )
        ),
      releaseRun(db, held.clientId, held.runId),
    ]
  );
  if (!finished) {
    await assertHolds(db, held);
    throw new ProvisionOperationError(
      "operation_gone",
      `Operation ${operation.id} is gone`
    );
  }
};

/**
 * Records that the operation failed in `step` with `code`, while the
 * runner holds the client: one that lost it records nothing, so the
 * runner that holds it now keeps the record. A failure to record it is
 * logged, not thrown.
 */
const recordFailure = async (
  db: AdminDatabase,
  { operation, held }: Pick<Loaded, "operation" | "held">,
  step: ProvisionStep,
  code: string
): Promise<void> => {
  try {
    await actIfChanged(
      db,
      "system",
      db
        .update(clientProvisions)
        .set({ status: "failed", error: code, updatedAt: new Date() })
        .where(and(eq(clientProvisions.id, operation.id), stillHolds(held))),
      {
        action: "provision.fail",
        clientId: held.clientId,
        target: operation.releaseId,
        detail: { operation: operation.id, run: held.runId, step, error: code },
      }
    );
  } catch (recordError) {
    log.error("provision.fail_unrecorded", {
      operation: operation.id,
      error: operationErrorCode(recordError),
    });
  }
};

/**
 * Runs client `held.clientId`'s provisioning operation, as runner `held`,
 * from its first step, and records it done; one done already is left as
 * it is. Run it again, as this runner or another that claimed the client,
 * to resume one that failed. On a failure it records the step and the
 * error's code, audited, and throws the error.
 */
export const runClientProvision = async (
  context: ProvisionContext,
  held: HeldClient
): Promise<void> => {
  const { db, api } = context;
  const operation = await provisionOf(db, held.clientId);
  if (operation === undefined) {
    throw new Error(`${held.clientId} has no provisioning operation`);
  }
  if (operation.status === "done") {
    return;
  }
  let step: ProvisionStep = "validated";
  try {
    await assertHolds(db, held);
    const loaded = await load(db, held, operation);
    await validate(context, loaded);

    step = "resources";
    const inventory = await ensureClientResources(api, db, "system", held);
    await recordStep(db, loaded, "resources", { resources: inventory.length });

    step = "migrations";
    await migrate(context, loaded, inventory);

    // Rendered before either uploads, so a binding that can't be mapped
    // onto the client's own resources stops it before anything is live.
    const order = appsOf(loaded.manifest);
    for (const app of order) {
      renderClientWorker(
        workerOf(loaded.manifest, app),
        loaded.placement,
        inventory
      );
    }
    for (const app of order) {
      step = app;
      // oxlint-disable-next-line no-await-in-loop -- connect, then core
      await upload(context, loaded, inventory, app);
    }

    step = "secrets";
    await deliverSecrets(context, loaded, inventory);

    step = "probe";
    const origin = await probe(context, loaded, inventory);

    step = "mail";
    await setUpMail(context, loaded);

    step = "route";
    await route(context, loaded, origin);
    await complete(db, loaded);
  } catch (error) {
    const code = operationErrorCode(error);
    log.error("provision.failed", {
      operation: operation.id,
      clientId: held.clientId,
      step,
      error: code,
    });
    await recordFailure(db, { operation, held }, step, code);
    throw error;
  }
};
