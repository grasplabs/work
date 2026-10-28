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
 *    client, each private binding the release gives core and connect
 *    answers, and its clock and connect's are armed.
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
 * - A probe of an owned workflow's run: core's probe asks its identity,
 *   every private binding of core and connect (databases, buckets,
 *   Durable Object namespaces, the sandbox with a fresh isolate's answer,
 *   connect) and both clocks, but starts no workflow.
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
 *   is a spike of its own. The admin probes a user Worker in the
 *   namespace it and the router bind (`clientDispatchNamespace`) through
 *   that binding, as the router then reaches it (GRA-283); one in any
 *   other namespace stops at the probe (`probe_unqualified`), its
 *   hostname unpublished. Real-account qualification is GRA-430's.
 *
 * Failures are recorded as codes, never messages; secret values never
 * reach a row, an audit event or a log line, only their keyed
 * fingerprints.
 */
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { log } from "@grasp-os/shared/log";
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";
import {
  clientDispatchNamespace,
  deriveRouterSecret,
} from "@grasp-os/shared/router";
import type { RouterTarget } from "@grasp-os/shared/router";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { StaffAlert } from "../alerts.ts";
import { coreAddressOf } from "../clients/core-address.ts";
import type { ClientDispatcher, CoreAddress } from "../clients/core-address.ts";
import { teamsBotOf, teamsBotVars } from "../clients/teams-bot.ts";
import { findD1Database } from "../cloudflare/accounts.ts";
import { CloudflareApiError } from "../cloudflare/api.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import { ensureSendingDomain } from "../cloudflare/email-sending.ts";
import {
  liveVersion,
  putSchedules,
  deleteTargetSecret,
  putTargetSecret,
  setScriptSubdomain,
  targetMigrationState,
  targetSecretNames,
  uploadTargetScript,
} from "../cloudflare/workers.ts";
import type { ScriptTarget } from "../cloudflare/workers.ts";
import { actIfChanged } from "../db/act.ts";
import type { Actor, AdminDatabase } from "../db/act.ts";
import {
  clientProvisions,
  clients,
  clientWorkers,
  releases,
} from "../db/schema.ts";
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
  smokeAnswering,
  smokeCheck,
  workersSubdomain,
} from "../deploy/router.ts";
import type { RouterHosts, SmokeOptions } from "../deploy/router.ts";
import { sealedWorkerSecrets } from "../deploy/sealed-secrets.ts";
import {
  clientAuthSecret,
  retainedPreviousKeys,
  workerSecrets,
} from "../deploy/secrets.ts";
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
  /** A script still has a secret it's no longer given after it was removed. */
  "secret_unrevoked",
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
  /** A release or rollback of a client that isn't active: it's provisioned first. */
  "client_not_active",
  /** A release or rollback while the client's operation still runs: it's resumed, or it ends, first. */
  "operation_running",
  /** A rollback of a client with no release before the one it runs. */
  "nothing_to_roll_back",
  /**
   * A rollback past a Durable Object migration: the release since added
   * one, and a script never goes back past a migration it ran.
   */
  "rollback_past_migration",
  /**
   * A release to one that lacks a Durable Object migration a script of the
   * client's ran: an older release, which only a rollback may go to.
   */
  "release_behind_migration",
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
    /**
     * The clients' dispatch namespace, as the router binds it: how a core
     * placed on Workers for Platforms is reached (GRA-283).
     */
    dispatcher?: ClientDispatcher;
  };
  /** Reading back what a step wrote (`observed`); tests pass a wait of 0. */
  observe?: { retryDelayMs?: number };
  /** Tells staff when a release was rolled back on its own (src/alerts.ts). */
  alert?: (alert: StaffAlert) => Promise<void>;
}

/**
 * Tries of reading back what a step just wrote. Cloudflare's API can
 * answer from before a write for a moment after it (read-after-write lag),
 * so a script just uploaded, or a secret just put, can read as missing.
 */
const observeAttempts = 6;
/** The first wait between tries, doubling after: about 31 s in all. */
const defaultObserveDelayMs = 1000;

/**
 * What `read` answers once `holds` accepts it, tried again with a
 * doubling wait while it doesn't, up to `observeAttempts` tries; then the
 * last answer, for the caller to refuse.
 */
const observed = async <T>(
  context: ProvisionContext,
  read: () => Promise<T>,
  holds: (value: T) => boolean
): Promise<T> => {
  const delayMs = context.observe?.retryDelayMs ?? defaultObserveDelayMs;
  let value = await read();
  for (
    let attempt = 1;
    attempt < observeAttempts && !holds(value);
    attempt += 1
  ) {
    // oxlint-disable-next-line no-await-in-loop -- waits between tries
    await scheduler.wait(delayMs * 2 ** (attempt - 1));
    // oxlint-disable-next-line no-await-in-loop -- tries in turn
    value = await read();
  }
  return value;
};

/** What the operation's steps observed, as its row keeps it. */
const progressSchema = z.object({
  /** Each Worker's last upload: the fingerprint of everything in it. */
  uploads: z.record(z.string(), z.string()).default({}),
  /** Each Worker's delivered secrets: their fingerprint, names and values. */
  secrets: z.record(z.string(), z.string()).default({}),
  /** The core origin the probe passed at. */
  origin: z.string().optional(),
  /**
   * The newest-built release whose database migrations may have run,
   * recorded before they run (src/deploy/compatibility.ts `appliedSchema`):
   * kept across releases, so a release that migrated and then failed, and
   * the one started after it, don't forget the schema it left.
   */
  schema: z.string().optional(),
  /**
   * Each Worker's last Durable Object migration as its script was observed
   * at (null for none): what a later release or rollback may not go back
   * past, rather than what a release that never uploaded declared.
   */
  migrated: z.record(z.string(), z.string().nullable()).default({}),
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
 * Records the operation that provisions client `held.clientId` with
 * release `releaseId`, as `actor`, and returns its id: the one it has
 * already when it has one, so starting again resumes it (spec 40.1). An
 * operation of another release is refused (`operation_release_changed`):
 * it isn't replaced. Only while runner `held` holds the client, in the
 * same statement: a start that lost the client writes nothing.
 */
export const startClientProvision = async (
  db: AdminDatabase,
  actor: Actor,
  held: HeldClient,
  releaseId: string
): Promise<string> => {
  const { clientId } = held;
  const now = new Date();
  const id = crypto.randomUUID();
  await actIfChanged(
    db,
    actor,
    db
      .insert(clientProvisions)
      .select(
        sql`SELECT ${id}, ${clientId}, ${releaseId}, NULL, 'running', NULL, NULL, NULL, NULL, ${actorName(actor)}, ${now.getTime()}, ${now.getTime()} WHERE ${stillHolds(held)}`
      )
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

/**
 * The first Worker whose last Durable Object migration (`ran`, by Worker)
 * `to` doesn't have: going to `to` would take its script back past a
 * migration it ran. None when `to` has every one.
 */
const behindMigration = (
  ran: Readonly<Record<string, string | null>>,
  to: ReleaseManifest
): string | undefined =>
  Object.entries(ran).find(
    ([name, tag]) =>
      tag !== null &&
      !(
        to.workers[name]?.durableObjectMigrations.some(
          (step) => step.tag === tag
        ) ?? false
      )
  )?.[0];

/**
 * Throws unless the client of `operation` may go to `target` (a rollback
 * when `rollback`): both imported, and `target` with every Durable Object
 * migration a script ran. What a script ran is what it was observed at
 * (`migrated`); a Worker never observed counts at the last migration of
 * the release the operation has, which may have reached it. Checked for
 * every target before anything is uploaded: the upload refuses one per
 * script too, but only once connect may have gone.
 */
const assertCanGo = async (
  db: AdminDatabase,
  operation: { releaseId: string; progress: string | null },
  target: string,
  rollback: boolean
): Promise<void> => {
  const running = operation.releaseId;
  const [from, to] = await Promise.all([
    importedManifest(db, running),
    importedManifest(db, target),
  ]);
  if (to === null) {
    throw new ProvisionOperationError(
      "release_not_imported",
      `Release ${target} isn't imported`
    );
  }
  // Without what runs, what the target would go back past is unknown.
  if (from === null) {
    throw new ProvisionOperationError(
      "release_not_imported",
      `Release ${running}, which runs, isn't imported`
    );
  }
  const observedTags = progressSchema.parse(
    JSON.parse(operation.progress ?? "{}")
  ).migrated;
  // Every Worker observed, the running release's or not, and the running
  // release's others at its last migration.
  const ran = {
    ...Object.fromEntries(
      Object.entries(from.workers).map(([name, worker]) => [
        name,
        worker.durableObjectMigrations.at(-1)?.tag ?? null,
      ])
    ),
    ...observedTags,
  };
  const behind = behindMigration(ran, to);
  if (behind !== undefined) {
    throw new ProvisionOperationError(
      rollback ? "rollback_past_migration" : "release_behind_migration",
      `${behind} ran a Durable Object migration ${target} doesn't have`
    );
  }
};

/**
 * The one release every Worker of client `clientId` was seen running
 * (`client_workers`, written once an upload is observed), or null when
 * they run different releases or none: what a release started now goes
 * on from, and so what a rollback of it goes back to.
 */
const observedRelease = async (
  db: AdminDatabase,
  clientId: string
): Promise<string | null> => {
  const rows = await db
    .select({ releaseId: clientWorkers.releaseId })
    .from(clientWorkers)
    .where(eq(clientWorkers.clientId, clientId));
  const ids = new Set(rows.map(({ releaseId }) => releaseId));
  const [only = null] = ids.size === 1 ? ids : [];
  return only;
};

/**
 * Takes active client `held.clientId`'s one operation to release
 * `releaseId`, as `actor`, and returns its id (spec 40.3): a later
 * release, or with `rollback` the one it ran before (spec 40.4). Every
 * step of the operation then runs again for that release, onto the same
 * stable scripts and the client's own resources, each finding what an
 * earlier run did: an interrupted release is resumed by starting it
 * again.
 *
 * Only by the runner holding the client (`held`), which a start claims
 * first (src/hosting/workflow.ts): every write is conditional on that
 * claim in the same statement, so a start that lost the client changes
 * nothing, and the operation is never changed under the runner that
 * runs it. Holding the client, an operation left `running` by a runner
 * that ended is the holder's to resume or take elsewhere.
 *
 * What it goes back to is observed, never inferred from how the last run
 * ended: a new release records the release every Worker was seen running
 * as the one before it (`observedRelease`), and every target is checked
 * against the Durable Object migrations each script was seen at
 * (`assertCanGo`), before anything is uploaded.
 *
 * Refused for a client that isn't active (`client_not_active`), for a
 * rollback with nothing before (`nothing_to_roll_back`), when the release
 * it runs isn't imported (`release_not_imported`), past a migration a
 * script ran (`rollback_past_migration`, `release_behind_migration`), and
 * when the claim or the operation changed as it started
 * (`operation_running`). Whether the code of either release works with
 * the other and with the client's databases is the operation's first
 * step's (`incompatibility`). `cause` goes in the audit event, as when a
 * release is rolled back on its own.
 */
export const startClientRelease = async (
  db: AdminDatabase,
  actor: Actor,
  held: HeldClient,
  {
    releaseId,
    rollback,
    cause,
  }: { releaseId?: string; rollback?: boolean; cause?: string }
): Promise<{ operationId: string; releaseId: string }> => {
  const { clientId } = held;
  const client = await db
    .select({ status: clients.status })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();
  if (client?.status !== "active") {
    throw new ProvisionOperationError(
      "client_not_active",
      `${clientId} isn't active`
    );
  }
  const operation = await provisionOf(db, clientId);
  if (operation === undefined) {
    throw new ProvisionOperationError(
      "client_not_active",
      `${clientId} has no operation: it wasn't provisioned as a placement`
    );
  }
  if (!(await holdsClient(db, clientId, held.runId))) {
    throw new ProvisionOperationError(
      "operation_running",
      `${held.runId} doesn't hold ${clientId}`
    );
  }
  const target =
    rollback === true ? operation.previousReleaseId : (releaseId ?? null);
  if (target === null) {
    throw new ProvisionOperationError(
      "nothing_to_roll_back",
      `${clientId} has no release before ${operation.releaseId}`
    );
  }
  if (operation.releaseId === target) {
    if (rollback === true && operation.status === "done") {
      throw new ProvisionOperationError(
        "nothing_to_roll_back",
        `${clientId} runs ${target} already`
      );
    }
    // Done: it runs it already. Failed, or left running by a runner that
    // ended: the holder runs it again, which resumes it.
    return { operationId: operation.id, releaseId: target };
  }
  await assertCanGo(db, operation, target, rollback === true);
  const before = await observedRelease(db, clientId);
  const now = new Date();
  // Conditional on the claim, and the operation as read: a start that lost
  // either starts nothing.
  const started = await actIfChanged(
    db,
    actor,
    db
      .update(clientProvisions)
      .set({
        releaseId: target,
        previousReleaseId: before === target ? null : before,
        status: "running",
        step: null,
        error: null,
        startedBy: actorName(actor),
        createdAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(clientProvisions.id, operation.id),
          eq(clientProvisions.status, operation.status),
          eq(clientProvisions.releaseId, operation.releaseId),
          stillHolds(held)
        )
      ),
    {
      action: rollback === true ? "release.rollback" : "release.start",
      clientId,
      target,
      detail: {
        operation: operation.id,
        from: operation.releaseId,
        ...(cause === undefined ? {} : { cause }),
      },
    }
  );
  if (!started) {
    throw new ProvisionOperationError(
      "operation_running",
      `${clientId}'s operation or its claim changed as the release started`
    );
  }
  return { operationId: operation.id, releaseId: target };
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
    teamsBot: string | null;
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

/**
 * The vars Worker `app` runs with: core's (`coreVarsOf`, read once and
 * passed as `core`), and the client's Teams bot on connect and core, as a
 * deploy gives them (src/clients/teams-bot.ts).
 */
const varsOf = (
  loaded: Loaded,
  app: App,
  core: Readonly<Record<string, unknown>>
): Record<string, unknown> => ({
  ...(app === "core" ? core : {}),
  ...teamsBotVars(app, teamsBotOf(loaded.client.teamsBot)),
});

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
  const row = await db
    .select({
      status: clients.status,
      generation: clients.generation,
      rotationLiveAt: clients.rotationLiveAt,
      signIn: clients.signIn,
      teamsBot: clients.teamsBot,
    })
    .from(clients)
    .where(eq(clients.id, held.clientId))
    .get();
  if (row === undefined) {
    throw new ProvisionOperationError(
      "client_unknown",
      `No client ${held.clientId}`
    );
  }
  // An offboarded client is served no more: no attempt runs for it, so
  // none puts its hostname back (src/hosting/offboarding.ts).
  const { status, ...client } = row;
  if (status === "offboarded") {
    throw new ProvisionOperationError(
      "client_not_active",
      `${held.clientId} is offboarded`
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
    checkBindingNames(worker, varsOf(loaded, app, vars), secrets);
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

/** The newer-built of releases `a` (if any) and `b`. */
const newerOf = async (
  db: AdminDatabase,
  a: string | undefined,
  b: string
): Promise<string> => {
  if (a === undefined || a === b) {
    return b;
  }
  const [newest] = await db
    .select({ id: releases.id })
    .from(releases)
    .where(inArray(releases.id, [a, b]))
    .orderBy(desc(releases.builtAt))
    .limit(1);
  return newest?.id ?? b;
};

/**
 * The later of Durable Object migrations `recorded` and `seen`, in the
 * order `history` runs them. Migrations only move forward, and a read may
 * be stale, so an observation never lowers what's recorded: one this
 * history doesn't know is kept as the later.
 */
const laterMigration = (
  recorded: string | null | undefined,
  seen: string | null,
  history: WorkerEntry["durableObjectMigrations"]
): string | null => {
  if (recorded === undefined || recorded === null) {
    return seen;
  }
  if (seen === null) {
    return recorded;
  }
  const at = (tag: string) => history.findIndex((step) => step.tag === tag);
  if (at(recorded) === -1) {
    return recorded;
  }
  return at(seen) === -1 || at(seen) > at(recorded) ? seen : recorded;
};

/**
 * Records Worker `app` observed at Durable Object migration `tag` before
 * its upload, in `progress` (which it updates): only moving what's
 * recorded forward (`laterMigration`), as a read may be stale. The
 * observation after a confirmed upload is what sets it as it is.
 */
const recordMigrated = async (
  db: AdminDatabase,
  loaded: Loaded,
  progress: Progress,
  app: App,
  tag: string | undefined,
  history: WorkerEntry["durableObjectMigrations"]
): Promise<void> => {
  const later = laterMigration(progress.migrated[app], tag ?? null, history);
  if (progress.migrated[app] === later) {
    return;
  }
  progress.migrated = { ...progress.migrated, [app]: later };
  await recordProgress(db, loaded, progress);
};

/**
 * Sends Worker `app`'s upload (`send`) with its migrations counted as run
 * from just before: an upload whose answer is lost may have run them, so
 * what's recorded moves forward to the release's last (`laterMigration`)
 * and is trusted lower again only once observed. An upload the API
 * refused outright (a 4xx: nothing of it ran) puts back what was
 * recorded before, its error code in the answer, so a refusal never
 * blocks a rollback it couldn't have made unsafe.
 */
const uploadCountedAsRun = async (
  db: AdminDatabase,
  loaded: Loaded,
  progress: Progress,
  {
    app,
    history,
  }: { app: App; history: WorkerEntry["durableObjectMigrations"] },
  send: () => Promise<void>
): Promise<void> => {
  const { [app]: recorded, ...others } = progress.migrated;
  progress.migrated = {
    ...others,
    [app]: laterMigration(recorded, history.at(-1)?.tag ?? null, history),
  };
  await recordProgress(db, loaded, progress);
  try {
    await send();
  } catch (error) {
    // Only Cloudflare's own refusal, its error code in the answer: a 4xx
    // with no answer it wrote, or a timeout or rate limit a proxy may send
    // after passing the upload on, keeps the worst case.
    const refused =
      error instanceof CloudflareApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429 &&
      error.codes.length > 0;
    if (refused) {
      progress.migrated =
        recorded === undefined ? others : { ...others, [app]: recorded };
      await recordProgress(db, loaded, progress);
    }
    throw error;
  }
};

/** Step 4: the release's D1 migrations, on the client's own databases. */
const migrate = async (
  context: ProvisionContext,
  loaded: Loaded,
  inventory: readonly ClientResource[]
): Promise<void> => {
  const databases = await observedDatabases(context, loaded, inventory);
  await assertHolds(context.db, loaded.held);
  // Recorded before any runs: one that stops part way still left them.
  const progress = await progressNow(context.db, loaded.operation.id);
  const schema = await newerOf(
    context.db,
    progress.schema,
    loaded.manifest.releaseId
  );
  if (schema !== progress.schema) {
    await recordProgress(context.db, loaded, { ...progress, schema });
  }
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
  const vars = varsOf(
    loaded,
    app,
    app === "core" ? await coreVarsOf(context, loaded) : {}
  );
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
  if (before.exists) {
    // What it was observed at, whatever this upload does next.
    await recordMigrated(
      db,
      loaded,
      progress,
      app,
      before.migrationTag,
      worker.durableObjectMigrations
    );
  }
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
    // Delivered secrets go with the next delivery, whatever this upload
    // keeps.
    const { [app]: _delivered, ...secrets } = progress.secrets;
    progress.secrets = secrets;
    await uploadCountedAsRun(
      db,
      loaded,
      progress,
      { app, history: worker.durableObjectMigrations },
      async () => {
        await assertHolds(db, held);
        await uploadTargetScript(api, target, {
          ...prepared,
          metadata: {
            ...prepared.metadata,
            ...(migrations === undefined ? {} : { migrations }),
          },
        });
      }
    );
    const after = await observed(
      context,
      async () => await targetMigrationState(api, target),
      (state) => state.exists && state.migrationTag === lastTag
    );
    if (!after.exists || after.migrationTag !== lastTag) {
      throw new ProvisionOperationError(
        "upload_unobserved",
        `${target.scriptName} isn't at migration ${lastTag ?? "none"} after its upload`
      );
    }
    await recordProgress(db, loaded, {
      ...progress,
      uploads: { ...progress.uploads, [app]: fingerprint },
      migrated: { ...progress.migrated, [app]: after.migrationTag ?? null },
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
 * Records that secret `name` was removed from `target`'s script, by name
 * only, while `held` holds the client (`provision.secret_revoked`).
 */
const recordRevoked = async (
  db: AdminDatabase,
  { operation, held }: Loaded,
  target: ScriptTarget,
  name: string
): Promise<void> => {
  const recorded = await actIfChanged(
    db,
    "system",
    db
      .update(clientProvisions)
      .set({ updatedAt: new Date() })
      .where(and(eq(clientProvisions.id, operation.id), stillHolds(held))),
    {
      action: "provision.secret_revoked",
      clientId: held.clientId,
      target: operation.releaseId,
      detail: {
        operation: operation.id,
        run: held.runId,
        script: target.scriptName,
        name,
      },
    }
  );
  if (!recorded) {
    await assertHolds(db, held);
  }
};

/**
 * Removes from `target`'s script every secret `present` names that isn't
 * among `given` (a previous generation's key past its window, a sealed or
 * shared secret no longer given), once `given` is observed there: the
 * replacement before the revocation. Then observes them gone; returns the
 * names it removed, for the step's record. The admin is the only writer of
 * a client script's secrets, so whatever else it holds is retired, but for
 * connect's previous vault key (`retainedPreviousKeys`).
 */
const revokeRetired = async (
  context: ProvisionContext,
  loaded: Loaded,
  target: ScriptTarget,
  given: ReadonlySet<string>,
  present: ReadonlySet<string>
): Promise<string[]> => {
  const { api, db } = context;
  const retired = [...present].filter(
    (name) => !given.has(name) && !retainedPreviousKeys.has(name)
  );
  for (const name of retired) {
    // oxlint-disable-next-line no-await-in-loop -- one secret at a time
    await assertHolds(db, loaded.held);
    // oxlint-disable-next-line no-await-in-loop -- one secret at a time
    await deleteTargetSecret(api, target, name);
    // Recorded as it goes, by name: a run that fails after it still
    // leaves what it removed in the audit log.
    // oxlint-disable-next-line no-await-in-loop -- one secret at a time
    await recordRevoked(db, loaded, target, name);
  }
  if (retired.length === 0) {
    return [];
  }
  const after = await observed(
    context,
    async () => new Set(await targetSecretNames(api, target)),
    (names) => retired.every((name) => !names.has(name))
  );
  const left = retired.find((name) => after.has(name));
  if (left !== undefined) {
    throw new ProvisionOperationError(
      "secret_unrevoked",
      `${target.scriptName} still has ${left} after its removal`
    );
  }
  return retired;
};

/**
 * Step 5: each Worker's secrets delivered by name to its script, unless
 * the same secrets are recorded as delivered since its last upload and
 * the script holds exactly them by name; then observed by name, and any
 * other secret the script holds removed (`revokeRetired`). Only their
 * keyed fingerprint is recorded.
 */
const deliverSecrets = async (
  context: ProvisionContext,
  loaded: Loaded,
  inventory: readonly ClientResource[]
): Promise<void> => {
  const { api, db } = context;
  let delivered = 0;
  const revoked: string[] = [];
  for (const app of appsOf(loaded.manifest)) {
    const target = targetOf(loaded, inventory, app);
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
    const secrets = await secretsOf(context, loaded, app);
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
    const print = await secretsFingerprint(context.secrets.clientKey, secrets);
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
    const progress = await progressNow(db, loaded.operation.id);
    const given = new Set(secrets.map(({ name }) => name));
    if (progress.secrets[app] === print) {
      // Delivered since the last upload, but a secret can be deleted, or
      // another set, since: skip only when the script holds exactly them.
      // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
      const present = new Set(await targetSecretNames(api, target));
      // By name both ways: every one given is there, and nothing else is
      // but connect's previous vault key. Never by count, which another
      // secret can make up for one given also being a retained key.
      const exactly =
        [...given].every((name) => present.has(name)) &&
        [...present].every(
          (name) => given.has(name) || retainedPreviousKeys.has(name)
        );
      if (exactly) {
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
    const names = await observed(
      context,
      async () => new Set(await targetSecretNames(api, target)),
      (present) => secrets.every(({ name }) => present.has(name))
    );
    const missing = secrets.find(({ name }) => !names.has(name));
    if (missing !== undefined) {
      throw new ProvisionOperationError(
        "secrets_unobserved",
        `${target.scriptName} lacks ${missing.name} after its delivery`
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
    const removed = await revokeRetired(context, loaded, target, given, names);
    revoked.push(...removed);
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
    await recordProgress(db, loaded, {
      ...progress,
      secrets: { ...progress.secrets, [app]: print },
    });
  }
  // The names removed, never a value: what an operator set by hand and
  // lost here can be read back from the step.
  await recordStep(db, loaded, "secrets", {
    delivered,
    revoked: revoked.length,
    revokedNames: revoked.join(","),
  });
};

/** How long core's signed probe may take, its body included. */
const probeTimeoutMs = 10_000;

/**
 * Where the client's core answers for the probe and the router: its user
 * Worker through the dispatch namespace the router and the admin bind, for
 * a Workers for Platforms destination; its account's workers.dev origin
 * otherwise. A namespace other than the bound one can't be reached through
 * the binding, so it is refused (`probe_unqualified`), never probed or
 * routed some other way. What the router's map entry names, too.
 */
const reachableCore = async (
  context: ProvisionContext,
  loaded: Loaded,
  target: ScriptTarget
): Promise<{ core: CoreAddress; entry: RouterTarget }> => {
  const { held } = loaded;
  if (target.namespace === null) {
    const subdomain = await workersSubdomain(
      context.api,
      target.accountId,
      held.clientId
    );
    const origin = coreOrigin(target.scriptName, subdomain);
    return {
      core: { origin, fetch: context.router.smoke?.fetch ?? fetch },
      entry: { kind: "origin", origin },
    };
  }
  const entry: RouterTarget = { kind: "dispatch", script: target.scriptName };
  const core =
    target.namespace === clientDispatchNamespace
      ? coreAddressOf(
          entry,
          `${held.clientId}.${context.router.domain}`,
          context.router.dispatcher
        )
      : undefined;
  if (core === undefined) {
    throw new ProvisionOperationError(
      "probe_unqualified",
      `${target.scriptName} is in namespace ${target.namespace}, which the router doesn't bind`
    );
  }
  return { core, entry };
};

/**
 * Step 7: core answers its health check, as the version live, to the
 * router secret the router will send, then the admin's signed probe as
 * this client at that version, each of its private bindings answering
 * and both clocks armed, reached as the router will reach it
 * (`reachableCore`). Returns what the router's map entry names.
 */
const probe = async (
  context: ProvisionContext,
  loaded: Loaded,
  inventory: readonly ClientResource[]
): Promise<RouterTarget> => {
  const { api, db } = context;
  const { held } = loaded;
  const target = targetOf(loaded, inventory, "core");
  const { core, entry } = await reachableCore(context, loaded, target);
  const { origin } = core;
  const routerSecret = await deriveRouterSecret(
    context.secrets.routerKey,
    held.clientId,
    loaded.client.generation
  );
  const smoke = { ...context.router.smoke, fetch: core.fetch };
  // An account's own Worker: the version its deployment has live, which
  // core must answer as. One in the namespace: live at once on upload, its
  // versions not listed by the documented API, so the version answering
  // is the one the probe is held to (GRA-283; GRA-430 qualifies it).
  let version: string;
  let attempts: number;
  if (target.namespace === null) {
    // Read back through Cloudflare's lag (#1360): the upload may not show yet.
    const live = await observed(
      context,
      async () => await liveVersion(api, target.accountId, target.scriptName),
      (seen) => seen !== undefined
    );
    if (live === undefined) {
      throw new ProvisionOperationError(
        "upload_unobserved",
        `${target.scriptName} has no version live`
      );
    }
    version = live;
    attempts = await smokeCheck(origin, routerSecret, live, smoke);
  } else {
    ({ version, attempts } = await smokeAnswering(origin, routerSecret, smoke));
  }
  const answer = await probeCore({
    origin,
    routerSecret,
    authSecret: await clientAuthSecret(
      context.secrets,
      held.clientId,
      loaded.client.generation
    ),
    fetch: core.fetch,
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
    bindings: privateBindings(
      workerOf(loaded.manifest, "core"),
      workerOf(loaded.manifest, "connect")
    ),
  });
  if (fault !== null) {
    throw new ProvisionOperationError(fault.code, fault.message);
  }
  const progress = await progressNow(db, loaded.operation.id);
  await recordStep(db, loaded, "probe", { attempts }, { ...progress, origin });
  return entry;
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
  target: RouterTarget
): Promise<void> => {
  const { held } = loaded;
  const { generation } = loaded.client;
  await registerHostname(
    context.router.hosts,
    `${held.clientId}.${context.router.domain}`,
    target.kind === "dispatch"
      ? { clientId: held.clientId, script: target.script, generation }
      : { clientId: held.clientId, coreUrl: target.origin, generation },
    // The last thing before the write: KV can't make it conditional.
    async () => {
      await assertHolds(context.db, held);
      const now = await context.db
        .select({ status: clients.status })
        .from(clients)
        .where(eq(clients.id, held.clientId))
        .get();
      if (now?.status === "offboarded") {
        throw new ProvisionOperationError(
          "client_not_active",
          `${held.clientId} was offboarded`
        );
      }
    }
  );
  // The map now has this generation, so the router sends its secret: a
  // raised generation is live from here, and its previous keys are kept
  // for a window from now (src/deploy/secrets.ts), as a deploy marks it.
  const liveAt = context.now?.() ?? new Date();
  await actIfChanged(
    context.db,
    "system",
    context.db
      .update(clients)
      .set({ rotationLiveAt: liveAt, updatedAt: liveAt })
      .where(
        and(
          eq(clients.id, held.clientId),
          eq(clients.generation, loaded.client.generation),
          gt(clients.generation, 1),
          isNull(clients.rotationLiveAt),
          stillHolds(held)
        )
      ),
    {
      action: "client.rotation_live",
      clientId: held.clientId,
      detail: {
        generation: loaded.client.generation,
        operation: loaded.operation.id,
      },
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

/** Where a run of the operation stopped, recorded, and what stopped it. */
interface Stopped {
  operation: Operation;
  step: ProvisionStep;
  code: string;
  error: unknown;
}

/**
 * Runs client `held.clientId`'s operation once from its first step, as
 * runner `held`, and records it done; one done already is left as it is.
 * A failure is recorded (its step and code, audited) and answered.
 */
const runOperation = async (
  context: ProvisionContext,
  held: HeldClient
): Promise<Stopped | undefined> => {
  const { db, api } = context;
  const operation = await provisionOf(db, held.clientId);
  if (operation === undefined) {
    throw new Error(`${held.clientId} has no provisioning operation`);
  }
  if (operation.status === "done") {
    return undefined;
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
    const target = await probe(context, loaded, inventory);

    step = "mail";
    await setUpMail(context, loaded);

    step = "route";
    await route(context, loaded, target);
    await complete(db, loaded);
    return undefined;
  } catch (error) {
    const code = operationErrorCode(error);
    log.error("provision.failed", {
      operation: operation.id,
      clientId: held.clientId,
      step,
      error: code,
    });
    await recordFailure(db, { operation, held }, step, code);
    return { operation, step, code, error };
  }
};

/**
 * Whether a run that failed at `step` with `code` rolls a live client
 * back on its own: a release (one with a release before it) whose code
 * went onto the client's stable scripts and then failed its probe. A
 * user Worker has no documented version-then-promote, so the new code
 * serves from its upload; the probe failing means it serves broken until
 * the release before is back. `probe_unqualified` isn't the release's
 * fault, and the release before would stop there too.
 */
const rollsBack = async (
  db: AdminDatabase,
  operation: Operation,
  step: ProvisionStep,
  code: string
): Promise<boolean> => {
  if (
    step !== "probe" ||
    code === "probe_unqualified" ||
    operation.previousReleaseId === null ||
    operation.previousReleaseId === operation.releaseId
  ) {
    return false;
  }
  const client = await db
    .select({ status: clients.status })
    .from(clients)
    .where(eq(clients.id, operation.clientId))
    .get();
  return client?.status === "active";
};

/**
 * Sends `alert` to staff, a failure logged and not thrown: an alert that
 * can't be sent never hides what the operation did, or why it stopped.
 */
const tellStaff = async (
  context: ProvisionContext,
  alert: StaffAlert
): Promise<void> => {
  try {
    await context.alert?.(alert);
  } catch (error) {
    log.error("provision.alert_unsent", {
      clientId: alert.clientId,
      kind: alert.kind,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
};

/**
 * Rolls client `held.clientId` back to the release it ran before
 * `failed`, which failed its probe with `code`: through its operation,
 * as runner `held`, audited as the system's rollback with the cause, and
 * staff told either way. Throws when the rollback doesn't finish.
 */
const rollBackAfterProbe = async (
  context: ProvisionContext,
  held: HeldClient,
  failed: Operation,
  code: string
): Promise<void> => {
  const subject = failed.releaseId;
  try {
    await startClientRelease(context.db, "system", held, {
      rollback: true,
      cause: code,
    });
    const stopped = await runOperation(context, held);
    if (stopped !== undefined) {
      throw stopped.error;
    }
  } catch (error) {
    log.error("provision.rollback_failed", {
      operation: failed.id,
      clientId: held.clientId,
      error: operationErrorCode(error),
    });
    await tellStaff(context, {
      clientId: held.clientId,
      kind: "release_rollback_failed",
      subject,
    });
    throw error;
  }
  await tellStaff(context, {
    clientId: held.clientId,
    kind: "release_rolled_back",
    subject,
  });
};

/**
 * Runs client `held.clientId`'s provisioning operation, as runner `held`,
 * from its first step, and records it done; one done already is left as
 * it is. Run it again, as this runner or another that claimed the client,
 * to resume one that failed. On a failure it records the step and the
 * error's code, audited, and throws the error; except that a live
 * client's release that fails its probe is rolled back to the release
 * before on its own (`rollsBack`), and staff are told.
 */
export const runClientProvision = async (
  context: ProvisionContext,
  held: HeldClient
): Promise<void> => {
  const stopped = await runOperation(context, held);
  if (stopped === undefined) {
    return;
  }
  const { operation, step, code, error } = stopped;
  if (await rollsBack(context.db, operation, step, code)) {
    await rollBackAfterProbe(context, held, operation, code);
    return;
  }
  throw error;
};
