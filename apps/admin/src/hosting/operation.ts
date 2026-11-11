/**
 * Provisioning a client placed in a hosting destination (spec 40.2): one
 * operation per client, run by the runner that holds it (src/runners.ts),
 * through its steps in order:
 *
 * 1. `validated`: the release is imported, the destination can run
 *    every binding it uses, the client's secrets and core config can be
 *    made, and its resources are allocated in its inventory.
 * 2. `resources`: its databases and buckets exist, each id recorded
 *    (`ensureClientResources`).
 * 3. `migrations`: the release's D1 migrations, applied to the inventory's
 *    databases, by their observed ids; and the model files it names, in
 *    the client's models bucket (src/deploy/model-files.ts).
 * 4. and 5. `connect`, then `core`: each Worker rendered onto the client's
 *    inventory (`renderClientWorker`) and uploaded as its stable script,
 *    with its Durable Object migrations and its secrets (the client's
 *    derived and sealed ones, and the shared ones it needs), then
 *    observed.
 * 6. `probe`: core answers its health check as the version live, with the
 *    router secret the router will send (`smokeAnswering`), then the
 *    admin's signed probe (src/hosting/probe.ts): it runs as this
 *    client, each private binding the release gives core and connect
 *    answers, and its clock and connect's are armed.
 * 7. `route`: the client's hostname in the router's map.
 * 8. `done`: the operation recorded complete, the client active and the
 *    runner's claim released, in one batch.
 *
 * Steps 4 and 5 are one upload per Worker: a script is created by its
 * first upload, which carries its modules, Durable Object migrations and
 * secrets, and it goes live at once, one version with all of them. The
 * client stays unreachable until step 7.
 *
 * Every step can run again: a retry, by the same runner or one that took
 * the client over, runs the operation from its first step, and each step
 * finds what an earlier run did. Resources are found by their recorded
 * names and ids; migrations skip what a database applied, and model
 * files what the bucket holds; the sending
 * domain's zone is found by its name, and sending turned on only where
 * it's off; an upload whose
 * fingerprint (everything that went into it) is recorded, and whose
 * script is observed at the release's migration tag and holding exactly
 * its secrets by name, isn't made again. Nothing here deletes: an
 * automatic retry never removes a resource or script, and a secret goes
 * only by an upload that no longer gives it. The one thing removed is a
 * model file in the client's models bucket that neither this release
 * nor the one before names: any release deployed later copies its own
 * again.
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
 * - A Workers for Platforms destination: its documented upload, secrets
 *   and script details calls are used, and any binding its documentation
 *   doesn't list for user Workers is refused before an upload
 *   (`wfp_binding_unqualified`). Mail is the exception: whether a user
 *   Worker can send through a `send_email` binding at all is a spike of
 *   its own (GRA-965), so there a release's `send_email` bindings are left
 *   out (`withoutMail`) rather than refused. Its core then sends no mail,
 *   and says so (core's src/mail.ts), and no sending domain is set up. The
 *   admin probes a user Worker in the
 *   namespace it and the router bind (`router.namespace`) through
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
import {
  deploymentPrefix,
  platformWorkerName,
  stageOfNamespace,
} from "@grasp-os/shared/names";
import type { Stage } from "@grasp-os/shared/names";
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";
import { deriveRouterSecret } from "@grasp-os/shared/router";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";

import { coreAddressOf } from "../clients/core-address.ts";
import type { ClientDispatcher, CoreAddress } from "../clients/core-address.ts";
import { teamsBotOf, teamsBotVars } from "../clients/teams-bot.ts";
import { findD1Database } from "../cloudflare/accounts.ts";
import { CloudflareApiError } from "../cloudflare/api.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import {
  targetMigrationState,
  targetSecretNames,
  uploadTargetAssets,
  uploadTargetScript,
} from "../cloudflare/workers.ts";
import type {
  ScriptTarget,
  Secret,
  WorkerUpload,
} from "../cloudflare/workers.ts";
import { actIfChanged } from "../db/act.ts";
import type { Actor, AdminDatabase } from "../db/act.ts";
import { clientProvisions, clients, clientWorkers } from "../db/schema.ts";
import { derivedCoreConfig } from "../deploy/core-config.ts";
import type { SignInApps } from "../deploy/core-config.ts";
import { configuredCoreVars, mailSenderOf } from "../deploy/core-vars.ts";
import { errorCode } from "../deploy/errors.ts";
import { migrateDatabases } from "../deploy/migrations.ts";
import { modelsBucketOf, syncModelFiles } from "../deploy/model-files.ts";
import type { ModelFilesSynced } from "../deploy/model-files.ts";
import { importedManifest } from "../deploy/release.ts";
import { registerHostname, smokeAnswering } from "../deploy/router.ts";
import type { RouterHosts, SmokeOptions } from "../deploy/router.ts";
import { sealedWorkerSecrets } from "../deploy/sealed-secrets.ts";
import {
  clientAuthSecret,
  sharedSecretPrints,
  workerSecrets,
} from "../deploy/secrets.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import {
  checkBindingNames,
  keyedHash,
  lockMailSender,
  renderedWorkerUpload,
  workerAssets,
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
import type {
  ClientPlacement,
  ClientResource,
  RenderOptions,
} from "./inventory.ts";
import {
  connectVersionOf,
  privateBindings,
  probeCore,
  probeFault,
} from "./probe.ts";
import type { ProbeRequest } from "./probe.ts";
import { ensureClientResources } from "./provision.ts";

export const provisionOperationErrorCodes = [
  /** The client has no record. */
  "client_unknown",
  /** The operation's release isn't imported. */
  "release_not_imported",
  /** The operation provisions another release: it's fixed for the operation. */
  "operation_release_changed",
  /** The release has a Worker other than core and connect. */
  "unknown_worker",
  /** A binding kind Workers for Platforms doesn't document for user Workers. */
  "wfp_binding_unqualified",
  /** A Workers for Platforms destination in another stage's namespace than the admin's own. */
  "destination_other_stage",
  /**
   * The admin's STAGE is neither staging nor production: it names no
   * clients' namespace of its own, so it runs no operation, never taking
   * itself for production.
   */
  "stage_unset",
  /** Cron triggers, which Workers for Platforms doesn't document for user Workers. */
  "wfp_schedule_unqualified",
  /** A script isn't at the release's Durable Object migration after its upload. */
  "upload_unobserved",
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
  /**
   * The release failed its probe once live and was rolled back to the
   * release before on its own: its deploy counts as failed.
   */
  "release_rolled_back",
  /**
   * An attempt ended at a step without recording how: its isolate was
   * killed (past its memory or CPU limit) or it timed out. Recorded with
   * the step (`attemptLostCode`).
   */
  "attempt_lost",
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
  "probe",
  "route",
] as const;
export type ProvisionStep = (typeof provisionSteps)[number];

/**
 * The step an operation left running stopped in: the one after the last
 * it finished (`step`, null before the first). A recorded step this
 * release doesn't have (records are never rewritten) is named as it was
 * recorded: where it stopped can't be told past it.
 */
export const stepReached = (step: string | null): string => {
  const steps: readonly (string | null)[] = provisionSteps;
  const done = steps.indexOf(step);
  if (step !== null && done === -1) {
    return step;
  }
  return provisionSteps[done + 1] ?? "route";
};

/** What a lost attempt is recorded as: its code and the step it reached. */
export const attemptLostCode = (step: string): string =>
  `attempt_lost: ${step}`;

/** What an attempt that finds the one before it lost audits. */
export const attemptLostAction = "provision.attempt_lost";

/** What an operation works with: a deploy's context, without its runner. */
export interface ProvisionContext {
  api: CloudflareApi;
  db: AdminDatabase;
  store: ReleaseStore;
  secrets: DeploySecrets;
  signInApps?: SignInApps;
  usualHosts?: string;
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
    /**
     * The namespace `dispatcher` binds: its stage's
     * (@grasp-os/shared/names, `clientsNamespace`). A core in any other
     * isn't reachable through it. Without it, or with one that is neither
     * stage's, no operation runs (`stage_unset`).
     */
    namespace?: string;
    /** Relay mode for its core's sign-in (src/deploy/context.ts, `oauthRelayOf`). */
    oauthRelay?: Stage;
  };
  /** Reading back what a step wrote (`observed`); tests pass a wait of 0. */
  observe?: { retryDelayMs?: number };
  /** How long a call that changes a client's Workers may wait (`sendHolding`). */
  sendTimeoutMs?: number;
}

/**
 * Tries of reading back what a step just wrote. Cloudflare's API can
 * answer from before a write for a moment after it (read-after-write lag),
 * so a script just uploaded can read as missing.
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
  /**
   * Each Worker's shared secrets as last uploaded, each by name with its
   * own keyed fingerprint (`sharedSecretPrints`): what proves a rotated
   * shared secret reached the client (src/rollout/shared-secrets.ts).
   */
  shared: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  /**
   * Each Worker's secrets its next upload no longer gives, by name: noted
   * before the upload is sent, recorded as revoked (`recordRevoked`) and
   * cleared once an upload is observed. A run that dies between, the
   * upload landed, leaves them here for the next run's, which reads the
   * script without them.
   */
  revoking: z.record(z.string(), z.array(z.string())).default({}),
  /**
   * Each Worker in a namespace whose version this run is about to change
   * with an upload, by app: the version recorded live before it, which the
   * probe never records again (`freshConnectVersion`): an isolate of it
   * still answering runs the release and secrets it replaced. Cleared when
   * the probe records a version.
   */
  superseded: z.record(z.string(), z.string()).default({}),
  /**
   * Each Worker in a namespace's version recorded live as this run reached
   * its upload step, by app, before the run's record of it cleared it
   * (`provision.worker_live`), whether or not it uploads: what a later
   * write of this run notes as superseded. Cleared with `superseded`.
   */
  recordedBefore: z.record(z.string(), z.string()).default({}),
  /** The core origin the probe passed at. */
  origin: z.string().optional(),
  /**
   * When the settings core last went live with were read (ISO): a change
   * to them after it waits for the next run (src/rollout/targets.ts).
   */
  configuredAt: z.string().optional(),
  /**
   * Each Worker's last Durable Object migration as its script was observed
   * at (null for none): what a later release or rollback may not go back
   * past, rather than what a release that never uploaded declared.
   */
  migrated: z.record(z.string(), z.string().nullable()).default({}),
});
type Progress = z.infer<typeof progressSchema>;

const apps = ["connect", "core"] as const;
type App = (typeof apps)[number];
const appSchema = z.enum(apps);

/**
 * Binding kinds Cloudflare documents for Workers for Platforms user
 * Workers: D1, R2 and Durable Objects (configuration/bindings), and static assets
 * (configuration/static-assets), and what the GRA-430 run
 * on a real namespace (28 Oct) qualified: the Worker Loader, version
 * metadata and a service binding, which renders to the connect gateway (a
 * user Worker can't bind another, 10143; `renderOptionsOf`). A
 * `send_email` binding uploads, but whether it delivers is GRA-965's
 * spike, still open: it's left out there (`withoutMail`). The vars and
 * secrets the admin adds go in the upload's own metadata.
 */
const wfpBindings: ReadonlySet<string> = new Set([
  "d1",
  "r2_bucket",
  "durable_object_namespace",
  "assets",
  "worker_loader",
  "version_metadata",
  "service",
]);

/**
 * `manifest` as a Workers for Platforms namespace runs it: every Worker
 * without its `send_email` bindings, as whether a user Worker can send
 * mail at all is GRA-965's spike, still open. Its core then has no `EMAIL`
 * and sends nothing, saying why (core's src/mail.ts), and the operation
 * sets up no sending domain.
 */
const withoutMail = (manifest: ReleaseManifest): ReleaseManifest => ({
  ...manifest,
  workers: Object.fromEntries(
    Object.entries(manifest.workers).map(([name, worker]) => [
      name,
      {
        ...worker,
        bindings: worker.bindings.filter(({ type }) => type !== "send_email"),
      },
    ])
  ),
});

/**
 * How `loaded`'s destination takes a Worker's bindings: in a Workers for
 * Platforms namespace, a service binding binds the connect gateway, with
 * props naming the client's own script (GRA-1217).
 */
const renderOptionsOf = (loaded: Loaded): RenderOptions => {
  const stage = stageOfNamespace(loaded.ownNamespace);
  return {
    ...(stage === undefined
      ? {}
      : { connectGateway: platformWorkerName("connect-gateway", stage) }),
    durableObjects: loaded.client.jurisdiction,
  };
};

/** Throws `runner_replaced` unless `held` still holds its client. */
const assertHolds = async (
  db: AdminDatabase,
  held: HeldClient
): Promise<void> => {
  if (
    !(await holdsClient(
      db,
      held.clientId,
      held.runId,
      held.attempt,
      held.attemptKey
    ))
  ) {
    throw new ProvisionOperationError(
      "runner_replaced",
      `${held.runId} no longer holds ${held.clientId}`
    );
  }
};

const actorName = (actor: Actor): string =>
  actor === "system" ? actor : actor.email;

/** What a change takes live, as a client's core records it. */
export type ChangeKind = NonNullable<
  (typeof clientProvisions.$inferSelect)["what"]
>;

/** Client `clientId`'s operation, if it has one. */
export const provisionOf = async (db: AdminDatabase, clientId: string) =>
  await db
    .select()
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, clientId))
    .get();

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
 * Switches client `held.clientId`'s provisioning `operation` to release
 * `releaseId`, newer or older, as `actor`, audited
 * (`provision.switch_release`): only while the client is still being
 * provisioned and its operation isn't done, so nothing of it is live, and
 * only to a release that has every Durable Object migration its scripts
 * ran (`assertCanGo`, the rule a rollback goes by), so a channel set back
 * mid-setup is followed. Its next run starts again from its first step on
 * the new release: every step finds what an earlier one did. A client
 * that's live is refused (`operation_release_changed`).
 */
const switchProvisionRelease = async (
  db: AdminDatabase,
  actor: Actor,
  held: HeldClient,
  operation: Operation,
  releaseId: string
): Promise<void> => {
  const { clientId } = held;
  const changed = new ProvisionOperationError(
    "operation_release_changed",
    `${clientId} is being provisioned with ${operation.releaseId}, and can't take ${releaseId}`
  );
  const client = await db
    .select({ status: clients.status })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();
  if (client?.status !== "provisioning" || operation.status === "done") {
    throw changed;
  }
  await assertCanGo(db, operation, releaseId, false);
  await actIfChanged(
    db,
    actor,
    db
      .update(clientProvisions)
      .set({
        releaseId,
        status: "running",
        error: null,
        runId: held.runId,
        startedBy: actorName(actor),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(clientProvisions.id, operation.id),
          eq(clientProvisions.releaseId, operation.releaseId),
          stillHolds(held)
        )
      ),
    {
      action: "provision.switch_release",
      clientId,
      target: releaseId,
      detail: { operation: operation.id, from: operation.releaseId },
    }
  );
  // A start that lost the client, or another switch first, changed nothing.
  const after = await provisionOf(db, clientId);
  if (after?.releaseId !== releaseId) {
    throw changed;
  }
};

/**
 * Records the operation that provisions client `held.clientId` with
 * release `releaseId`, as `actor`, and returns its id: the one it has
 * already when it has one, so starting again resumes it (spec 40.1). One
 * of another release is switched to `releaseId` while nothing of the
 * client is live (`switchProvisionRelease`), so a client started on a
 * release that can't finish takes a fixed one, and one whose channel was
 * set back follows it; a live client's is refused
 * (`operation_release_changed`). Only while runner `held` holds the
 * client, in the same statement: a start that lost the client writes
 * nothing.
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
        sql`SELECT ${id}, ${clientId}, ${releaseId}, NULL, 'running', NULL, NULL, NULL, ${held.runId}, NULL, 1, 'release', ${actorName(actor)}, ${now.getTime()}, ${now.getTime()} WHERE ${stillHolds(held)}`
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
    await switchProvisionRelease(db, actor, held, operation, releaseId);
  }
  return operation.id;
};

/** How a release start is audited: a rollback, a run again of what runs, or a release. */
const releaseAction = ({
  rollback,
  again,
}: {
  rollback?: boolean;
  again?: boolean;
}): string => {
  if (rollback === true) {
    return "release.rollback";
  }
  return again === true ? "release.again" : "release.start";
};

type Operation = NonNullable<Awaited<ReturnType<typeof provisionOf>>>;

/**
 * Whether `operation` has `target` already, so starting it changes
 * nothing: done on it, unless asked to run it `again` (its settings or
 * secrets as they are now); failed on it, or left running by a runner
 * that ended, which the holder runs again to resume it. A rollback onto
 * what it runs done is refused (`nothing_to_roll_back`).
 */
const hasAlready = (
  operation: { releaseId: string; status: string; clientId: string },
  target: string,
  { rollback, again }: { rollback?: boolean; again?: boolean }
): boolean => {
  if (operation.releaseId !== target) {
    return false;
  }
  if (rollback === true && operation.status === "done") {
    throw new ProvisionOperationError(
      "nothing_to_roll_back",
      `${operation.clientId} runs ${target} already`
    );
  }
  return again !== true || operation.status !== "done";
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
 * Whether client operation `started.operationId` is at change
 * `started.change`: the condition a record made alongside a start
 * (`startClientRelease`) lands on, so it lands only with that start.
 */
export const startedAs = (started: {
  operationId: string;
  change: number;
}): SQL =>
  sql`EXISTS (SELECT 1 FROM ${clientProvisions} WHERE ${clientProvisions.id} = ${started.operationId} AND ${clientProvisions.change} = ${started.change})`;

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
 * (`operation_running`). `cause` goes in the audit event, as when a
 * release is rolled back on its own.
 */
export const startClientRelease = async (
  db: AdminDatabase,
  actor: Actor,
  held: HeldClient,
  {
    releaseId,
    rollback,
    again,
    what,
    cause,
    alongside,
  }: {
    releaseId?: string;
    rollback?: boolean;
    again?: boolean;
    /** What a run again takes live: its settings unless said. */
    what?: ChangeKind;
    cause?: string;
    /**
     * What the starter records of the change in the same batch as its
     * start, given the operation and the change it starts: never a start
     * without its record, nor a record without its start, so the caller
     * conditions each on the start having landed. Not run when the change
     * started already (`hasAlready`).
     */
    alongside?: (started: {
      operationId: string;
      change: number;
    }) => BatchItem<"sqlite">[];
  }
): Promise<{ operationId: string; releaseId: string; change: number }> => {
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
  if (
    !(await holdsClient(
      db,
      clientId,
      held.runId,
      held.attempt,
      held.attemptKey
    ))
  ) {
    throw new ProvisionOperationError(
      "operation_running",
      `${held.runId} doesn't hold ${clientId}`
    );
  }
  const target =
    releaseId ??
    (rollback === true ? operation.previousReleaseId : null) ??
    (again === true ? operation.releaseId : null);
  if (target === null) {
    throw new ProvisionOperationError(
      "nothing_to_roll_back",
      `${clientId} has no release before ${operation.releaseId}`
    );
  }
  if (hasAlready(operation, target, { rollback, again })) {
    return {
      operationId: operation.id,
      releaseId: target,
      change: operation.change,
    };
  }
  await assertCanGo(db, operation, target, rollback === true);
  // Run again, it goes on from what it went on from; a new release, from
  // what every Worker was seen running, or, split between releases (a
  // change that stopped part way), the last whole release carried forward,
  // so a client never loses its way back. A client split mid-rollback
  // carries R, the release it was being rolled away from: the last it ran
  // whole, so going back from there takes it to R, not further.
  const before =
    (await observedRelease(db, clientId)) ?? operation.previousReleaseId;
  let previousReleaseId = before === target ? null : before;
  if (target === operation.releaseId) {
    ({ previousReleaseId } = operation);
  }
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
        previousReleaseId,
        status: "running",
        step: null,
        error: null,
        // The run it's started for, from the start: a run whose every
        // attempt is lost before its first step is still its own
        // (`lostAttemptOf`).
        runId: held.runId,
        // A change of its own, counted.
        change: operation.change + 1,
        what: target === operation.releaseId ? (what ?? "settings") : "release",
        startedBy: actorName(actor),
        createdAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(clientProvisions.id, operation.id),
          eq(clientProvisions.status, operation.status),
          eq(clientProvisions.releaseId, operation.releaseId),
          eq(clientProvisions.change, operation.change),
          stillHolds(held)
        )
      ),
    {
      action: releaseAction({ rollback, again }),
      clientId,
      target,
      detail: {
        operation: operation.id,
        from: operation.releaseId,
        ...(cause === undefined ? {} : { cause }),
      },
    },
    alongside?.({ operationId: operation.id, change: operation.change + 1 }) ??
      []
  );
  if (!started) {
    throw new ProvisionOperationError(
      "operation_running",
      `${clientId}'s operation or its claim changed as the release started`
    );
  }
  return {
    operationId: operation.id,
    releaseId: target,
    change: operation.change + 1,
  };
};

/** What a run of the operation works on, loaded once. */
interface Loaded {
  operation: Operation;
  held: HeldClient;
  manifest: ReleaseManifest;
  placement: ClientPlacement;
  destination: Awaited<ReturnType<typeof destinationOf>>;
  accountId: string;
  /** Its Workers for Platforms dispatch namespace. */
  namespace: string;
  client: {
    generation: number;
    rotationLiveAt: Date | null;
    signIn: string | null;
    staffWindow: string | null;
    /** The onboarding its company starts with, by name; null for all of it. */
    startingFlow: string | null;
    teamsBot: string | null;
    /** Where its data is kept: what its Durable Objects are made in. */
    jurisdiction: "eu" | "none";
  };
  /**
   * When `client` and the settings were about to be read: what core runs
   * once this run's upload of it is observed, as `configuredAt` records it.
   */
  readAt: Date;
  /**
   * The clients' namespace of the admin's own stage (`router.namespace`):
   * the only one it places a client in on Workers for Platforms.
   */
  ownNamespace: string;
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

/** `notes` without the apps `dropped` names. */
const withoutApps = (
  notes: Readonly<Record<string, string>>,
  dropped: readonly string[]
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(notes).filter(([app]) => !dropped.includes(app))
  );

/** The version recorded live for `app` of the client `loaded` holds; null when none. */
const recordedVersionOf = async (
  db: AdminDatabase,
  loaded: Loaded,
  app: App
): Promise<string | null> => {
  const row = await db
    .select({ versionId: clientWorkers.versionId })
    .from(clientWorkers)
    .where(
      and(
        eq(clientWorkers.clientId, loaded.held.clientId),
        eq(clientWorkers.worker, app)
      )
    )
    .get();
  return row?.versionId ?? null;
};

/**
 * Notes on `progress` the version recorded live for `app` in a namespace
 * as this run reaches its upload step (`recordedBefore`), and records it:
 * the step clears the record whether or not it uploads, so a later run's
 * upload still finds what it supersedes.
 */
const noteRecordedBefore = async (
  db: AdminDatabase,
  loaded: Loaded,
  progress: Progress,
  app: App
): Promise<void> => {
  const versionId = await recordedVersionOf(db, loaded, app);
  if (versionId === null || progress.recordedBefore[app] === versionId) {
    return;
  }
  progress.recordedBefore = { ...progress.recordedBefore, [app]: versionId };
  await recordProgress(db, loaded, progress);
};

/**
 * Notes on `progress` the version recorded live for `app`, before this run
 * changes a script in a namespace (`superseded`), and records it: the one
 * recorded now, or, cleared by this run's upload step, the one recorded
 * before it (`recordedBefore`). Kept as noted when neither is: an earlier
 * run already changed it, and the record went with that change.
 */
const noteSuperseded = async (
  db: AdminDatabase,
  loaded: Loaded,
  progress: Progress,
  app: App
): Promise<void> => {
  const versionId =
    (await recordedVersionOf(db, loaded, app)) ??
    progress.recordedBefore[app] ??
    null;
  if (versionId === null || progress.superseded[app] === versionId) {
    return;
  }
  progress.superseded = { ...progress.superseded, [app]: versionId };
  await recordProgress(db, loaded, progress);
};

/**
 * How long after it was sent a call that changes a client's Workers is
 * taken to have landed or gone with the run that sent it. An upload
 * answers in seconds; a run whose isolate died holds no request open, and
 * its mark stays behind until then (`othersSettled`).
 *
 * What's left: Cloudflare may still apply a call whose sender died, or one
 * still unanswered past this bound, after a rollback that waited it out
 * has made its own. Nothing here can see that call land; the client would
 * then run the deploy's Worker while the admin records the rollback's,
 * until drift (src/rollout/drift.ts) shows it and the next run replaces it.
 */
const sendSettleMs = 5 * 60_000;

/**
 * How long a call that changes a client's Workers may wait for its answer
 * before it's aborted: well inside `sendSettleMs`, so no run's call is
 * still open, waited for, when a runner that took the client over goes on.
 */
const defaultSendTimeoutMs = 150_000;

/**
 * One sender's mark: the change it sent for, and when (ms). A null change
 * stands for marks that couldn't be read (`sendMarksOf`), and holds every
 * change.
 */
const sendMarkSchema = z.object({
  change: z.int().nullable(),
  at: z.number(),
  /** The script it changes. */
  script: z.string().optional(),
  /**
   * The fingerprint of the upload it sent (`uploadFingerprint`): one with
   * the same is the same call, landing late or not.
   */
  fingerprint: z.string().optional(),
});

/** An upload as its mark names it: its script, and its fingerprint. */
interface MarkedUpload {
  script: string;
  fingerprint: string;
}

/** The marks on an operation (`clientProvisions.sending`), by sender. */
const sendMarksSchema = z.record(z.string(), sendMarkSchema);

/**
 * The marks in `stored`, last written at `updatedAt`. What doesn't parse
 * counts as a call still on its way, for any change, until it ages out
 * from that write: never as none, which would let a rollback or a retry
 * send past a call it can't see.
 */
const sendMarksOf = (
  stored: string | null,
  updatedAt: Date
): z.infer<typeof sendMarksSchema> => {
  if (stored === null) {
    return {};
  }
  const unreadable = { unreadable: { change: null, at: updatedAt.getTime() } };
  try {
    const parsed = sendMarksSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : unreadable;
  } catch {
    return unreadable;
  }
};

/**
 * Whether a call marked in `marks` by a sender other than `except`, for
 * change `change` or one before it, may still land: sent less than
 * `sendSettleMs` ago. With `sameUpload`, a mark of this change for that
 * upload's script with its fingerprint doesn't count, as it is the same
 * call, nor one of this change for another script, which it doesn't
 * change. An earlier change's counts too: a release or a
 * rollback that took the client over must not send before what the
 * change it replaced sent has landed, or that call would land after it
 * and undo it.
 */
const othersSending = (
  marks: z.infer<typeof sendMarksSchema>,
  change: number,
  except: string,
  now: number,
  sameUpload?: MarkedUpload
): boolean =>
  Object.entries(marks).some(
    ([sender, mark]) =>
      sender !== except &&
      (mark.change === null || mark.change <= change) &&
      now - mark.at < sendSettleMs &&
      !(
        sameUpload !== undefined &&
        mark.change === change &&
        mark.script !== undefined &&
        (mark.script !== sameUpload.script ||
          mark.fingerprint === sameUpload.fingerprint)
      )
  );

/** The marks on client `clientId`'s operation, as stored now. */
const sendMarks = async (db: AdminDatabase, clientId: string) => {
  const row = await db
    .select({
      sending: clientProvisions.sending,
      updatedAt: clientProvisions.updatedAt,
    })
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, clientId))
    .get();
  return row === undefined ? {} : sendMarksOf(row.sending, row.updatedAt);
};

/** Who marks a call `held` sends: its attempt at its step, or the runner. */
const senderOf = (held: HeldClient): string =>
  `${held.attemptKey ?? held.runId}#${String(held.attempt ?? 0)}`;

/**
 * `sender`'s path in an operation's marks, as SQLite's JSON functions take
 * it. Stripping quotes changes no key in practice: a sender is
 * `${attemptKey ?? runId}#${attempt}`, and neither Workerflow's
 * idempotency keys nor the admin's run ids (UUIDs, `apply-…`,
 * `rollback-…`, `<client>-p…`) hold a double quote. It only keeps the
 * path's syntax whole.
 */
const markPath = (sender: string): string =>
  `$."${sender.replaceAll('"', "")}"`;

/**
 * Waits until no other sender (an attempt that timed out and went on, or
 * a run of an earlier change) has a call to client `loaded.held.clientId`'s
 * Workers on its way for this change or one before it: each mark cleared,
 * or aged out under `sendSettleMs`. A step
 * waits here before it reads what its call is built from, so a call that
 * lands meanwhile is read, never sent over (`upload`), and again right
 * before it sends (`sendHolding`).
 */
const othersSettled = async (
  context: ProvisionContext,
  { operation, held }: Pick<Loaded, "operation" | "held">,
  sameUpload?: MarkedUpload
): Promise<void> => {
  const sender = senderOf(held);
  const delayMs = context.observe?.retryDelayMs ?? defaultObserveDelayMs;
  // oxlint-disable no-await-in-loop -- reads in turn, waiting between
  while (
    othersSending(
      await sendMarks(context.db, held.clientId),
      operation.change,
      sender,
      Date.now(),
      sameUpload
    )
  ) {
    await scheduler.wait(delayMs);
  }
  // oxlint-enable no-await-in-loop
};

/**
 * Sends `send`, a call that changes client `loaded.held.clientId`'s
 * Workers, while `loaded.held` holds the client, marked on its operation
 * under its own sender (`clientProvisions.sending`: this attempt at its
 * step) from before it's sent until Cloudflare answers it. `send` is given
 * the signal that aborts it after `sendTimeoutMs`.
 *
 * A call already sent can't be stopped, only waited for, so it lands
 * before anything sent after it:
 * - a release or a rollback that took the client waits, before it sends,
 *   for every mark of the changes before it (`othersSettled`);
 * - a retry of a step waits, before it sends, for any call another
 *   attempt (one that timed out and went on, or died) still has on its
 *   way, but the very upload it makes itself, once its script is at the
 *   release's last migration (`upload`). Each mark names its upload's
 *   script and fingerprint for this.
 *
 * Marked in the same statement that checks the claim, so a call is sent
 * only marked; cleared by the sender alone, and by the change, not the
 * claim, so a call answered after its runner lost the client still clears
 * its own mark, never another's. A call with no answer (aborted, or the
 * connection lost) may still land, so its mark stays until it ages out.
 */
const sendHolding = async (
  context: ProvisionContext,
  { operation, held }: Loaded,
  send: (signal: AbortSignal) => Promise<void>,
  { upload, same }: { upload: MarkedUpload; same: boolean }
): Promise<void> => {
  const { db } = context;
  const sender = senderOf(held);
  await othersSettled(context, { operation, held }, same ? upload : undefined);
  const marked = await db
    .update(clientProvisions)
    .set({
      sending: sql`json_set(coalesce(${clientProvisions.sending}, '{}'), ${markPath(sender)}, json(${JSON.stringify({ change: operation.change, at: Date.now(), ...upload })}))`,
    })
    .where(and(eq(clientProvisions.id, operation.id), stillHolds(held)))
    .returning({ id: clientProvisions.id });
  if (marked.length === 0) {
    throw new ProvisionOperationError(
      "runner_replaced",
      `${held.runId} no longer holds ${held.clientId}`
    );
  }
  const clear = async (): Promise<void> => {
    await db
      .update(clientProvisions)
      .set({
        sending: sql`json_remove(${clientProvisions.sending}, ${markPath(sender)})`,
      })
      .where(
        and(
          eq(clientProvisions.id, operation.id),
          eq(clientProvisions.change, operation.change)
        )
      );
  };
  try {
    await send(
      AbortSignal.timeout(context.sendTimeoutMs ?? defaultSendTimeoutMs)
    );
  } catch (error) {
    // Answered, refused or not: it won't land later.
    if (error instanceof CloudflareApiError && error.status > 0) {
      await clear();
    }
    throw error;
  }
  await clear();
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
    scriptName: renderClientWorker(
      worker,
      loaded.placement,
      inventory,
      renderOptionsOf(loaded)
    ).scriptName,
    namespace: loaded.namespace,
  };
};

/**
 * Throws unless the destination can run `worker` as the release declares
 * it: in a Workers for Platforms namespace only documented bindings and
 * no cron triggers.
 */
const assertRunnable = (loaded: Loaded, worker: WorkerEntry): void => {
  // The admin's own stage's namespace alone: a staging admin never places
  // a client among production's, nor production's among staging's, with
  // the deployer token they'd share (@grasp-os/shared/names).
  if (loaded.namespace !== loaded.ownNamespace) {
    throw new ProvisionOperationError(
      "destination_other_stage",
      `${loaded.destination.id}'s namespace ${loaded.namespace} isn't this admin's own, ${loaded.ownNamespace}`
    );
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
 * Core's vars: its derived sign-in and runtime profile, the platform's AI
 * settings, checked against the AI provider keys connect gets, and the
 * change core records.
 */
const coreVarsOf = (
  context: ProvisionContext,
  loaded: Loaded
): Record<string, unknown> => {
  const derived = derivedCoreConfig({
    clientId: loaded.held.clientId,
    signIn: loaded.client.signIn,
    staffWindow: loaded.client.staffWindow,
    startingFlow: loaded.client.startingFlow,
    domain: context.router.domain,
    apps: context.signInApps ?? {},
    ...(context.router.oauthRelay === undefined
      ? {}
      : { oauthRelay: context.router.oauthRelay }),
  });
  return configuredCoreVars(loaded.held.clientId, derived, {
    by: loaded.operation.startedBy,
    // What started it: a release, or new settings or secrets on the
    // release it runs, as its core records it in its Activity.
    what: loaded.operation.what ?? "release",
    release: loaded.operation.releaseId,
    // When the operation started: the same however often it's resumed.
    at: loaded.operation.createdAt.toISOString(),
  });
};

/**
 * The vars Worker `app` runs with: core's (`coreVarsOf`, read once and
 * passed as `core`), the client's Teams bot on connect and core, as a
 * deploy gives them (src/clients/teams-bot.ts), and, on staging set up
 * for it, the providers whose platform features go to their usual host
 * (`ProvisionContext.usualHosts`).
 */
const varsOf = (
  context: ProvisionContext,
  loaded: Loaded,
  app: App,
  core: Readonly<Record<string, unknown>>
): Record<string, unknown> => ({
  ...(app === "core" ? core : {}),
  // On both Workers alike: core routes a platform feature by it and
  // connect pins the request to the same host.
  ...(context.usualHosts === undefined
    ? {}
    : { PLATFORM_AI_USUAL_HOSTS: context.usualHosts }),
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
): Promise<Omit<Loaded, "ownNamespace">> => {
  // Before any setting is read, so one changed while this run goes on
  // reads as changed after it (`configuredAt`).
  const readAt = new Date();
  const row = await db
    .select({
      status: clients.status,
      generation: clients.generation,
      rotationLiveAt: clients.rotationLiveAt,
      signIn: clients.signIn,
      staffWindow: clients.staffWindow,
      startingFlow: clients.startingFlow,
      teamsBot: clients.teamsBot,
      jurisdiction: clients.jurisdiction,
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
  if (destination.accountId === null || destination.namespace === null) {
    throw new InventoryError(
      "destination_unsupported",
      `${destination.id} has no Cloudflare account and namespace recorded`
    );
  }
  return {
    operation,
    held,
    manifest: withoutMail(manifest),
    placement,
    destination,
    accountId: destination.accountId,
    namespace: destination.namespace,
    client,
    readAt,
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
  const vars = coreVarsOf(context, loaded);
  for (const app of order) {
    const worker = workerOf(manifest, app);
    assertRunnable(loaded, worker);
    // oxlint-disable-next-line no-await-in-loop -- two Workers
    const secrets = await secretsOf(context, loaded, app);
    checkBindingNames(worker, varsOf(context, loaded, app, vars), secrets);
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
 * and is trusted lower again only once observed. An upload Cloudflare
 * never took puts back what was recorded before, so it never blocks a
 * rollback it couldn't have made unsafe: one that never went out whole
 * (`send` calls `sent` once it has: its files are read as it goes, and
 * one that can't be read stops it), or one the API refused outright (a
 * 4xx: nothing of it ran).
 */
const uploadCountedAsRun = async (
  db: AdminDatabase,
  loaded: Loaded,
  progress: Progress,
  {
    app,
    history,
  }: { app: App; history: WorkerEntry["durableObjectMigrations"] },
  send: (sent: () => void) => Promise<void>
): Promise<void> => {
  const { [app]: recorded, ...others } = progress.migrated;
  progress.migrated = {
    ...others,
    [app]: laterMigration(recorded, history.at(-1)?.tag ?? null, history),
  };
  await recordProgress(db, loaded, progress);
  let wentOut = false;
  try {
    await send(() => {
      wentOut = true;
    });
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
    if (!wentOut || refused) {
      progress.migrated =
        recorded === undefined ? others : { ...others, [app]: recorded };
      await recordProgress(db, loaded, progress);
    }
    throw error;
  }
};

/**
 * Step 3's other half: the model files the release names, in the client's
 * models bucket before core goes live (src/deploy/model-files.ts), and
 * every other model file there removed unless the release running before
 * (what a failed probe rolls back to) names it.
 */
const syncClientModelFiles = async (
  context: ProvisionContext,
  loaded: Loaded,
  inventory: readonly ClientResource[]
): Promise<ModelFilesSynced> => {
  const { manifest, operation, held } = loaded;
  const bucketName = modelsBucketOf(manifest);
  if (bucketName === undefined) {
    return { copied: 0, removed: 0 };
  }
  const row = inventory.find(
    (resource) =>
      resource.kind === "r2_bucket" &&
      resource.role === `r2:${bucketName}` &&
      resource.lifecycle === "allocated"
  );
  if (row === undefined) {
    throw new InventoryError(
      "resource_missing",
      `${held.clientId} has no ${bucketName} in its inventory`
    );
  }
  const previous =
    operation.previousReleaseId === null
      ? null
      : await importedManifest(context.db, operation.previousReleaseId);
  return await syncModelFiles(
    context,
    {
      accountId: loaded.accountId,
      name: row.physicalName,
      jurisdiction: row.jurisdiction,
    },
    { manifest, previous },
    async () => {
      await assertHolds(context.db, held);
    }
  );
};

/** Step 4: the release's D1 migrations, on the client's own databases. */
const migrate = async (
  context: ProvisionContext,
  loaded: Loaded,
  inventory: readonly ClientResource[]
): Promise<void> => {
  const databases = await observedDatabases(context, loaded, inventory);
  await assertHolds(context.db, loaded.held);
  // Checked before each migration too: an attempt that timed out, and goes
  // on beside its retry (src/runners.ts, `takeAttempt`), applies nothing.
  const applied = await migrateDatabases(
    context.api,
    loaded.accountId,
    databases,
    loaded.manifest,
    context.store,
    async () => {
      await assertHolds(context.db, loaded.held);
    }
  );
  const models = await syncClientModelFiles(context, loaded, inventory);
  await recordStep(context.db, loaded, "migrations", {
    applied: [...applied.values()].reduce((sum, count) => sum + count, 0),
    modelFilesCopied: models.copied,
    modelFilesRemoved: models.removed,
  });
};

/** What a placed client's upload fingerprint is keyed with, derived from `CLIENT_KEY` for it alone. */
const uploadFingerprintPurpose = "grasp-os console placed upload fingerprint";

/**
 * Records each secret of `removed` as removed from `target`'s script,
 * gone with the upload that no longer gives it, by name only, while
 * `held` holds the client (`provision.secret_revoked`).
 */
const recordRevoked = async (
  db: AdminDatabase,
  { operation, held }: Loaded,
  target: ScriptTarget,
  removed: readonly string[]
): Promise<void> => {
  for (const name of removed) {
    // oxlint-disable-next-line no-await-in-loop -- a few at most
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
      // oxlint-disable-next-line no-await-in-loop -- stops at the first
      await assertHolds(db, held);
    }
  }
};

/**
 * A fingerprint of everything Worker `worker`'s upload to `target` carries:
 * its code, static files, settings, bindings as rendered for the client,
 * vars, and its secrets' names and values (through their own keyed
 * fingerprint). HMAC-SHA256 under a key HKDF derives from `clientKey`
 * for this purpose alone, so the recorded fingerprint tells nothing about
 * the secret values that went into it.
 */
const uploadFingerprint = async (
  clientKey: string,
  {
    target,
    manifest,
    worker,
    bindings,
    vars,
    secrets,
  }: {
    target: ScriptTarget;
    manifest: ReleaseManifest;
    worker: WorkerEntry;
    bindings: readonly Record<string, unknown>[];
    vars: Readonly<Record<string, unknown>>;
    secrets: readonly Secret[];
  }
): Promise<string> =>
  await keyedHash(
    await hkdfHmacKey(clientKey, uploadFingerprintPurpose, ["sign"]),
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
      bindings,
      vars,
      secrets: await secretsFingerprint(clientKey, secrets),
    }
  );

/**
 * Whether `present`, the names of a script's secrets, are exactly
 * `given`: every one given there, and nothing else. By name both ways,
 * never by count alone.
 */
const holdsExactly = (
  given: ReadonlySet<string>,
  present: ReadonlySet<string>
): boolean =>
  given.size === present.size && [...given].every((name) => present.has(name));

/**
 * Records `revoked`, the secrets an observed upload of Worker `app`
 * dropped (`recordRevoked`), and clears them from `progress`'s
 * `revoking`, which the caller records.
 */
const recordDropped = async (
  db: AdminDatabase,
  loaded: Loaded,
  progress: Progress,
  {
    app,
    target,
    revoked,
  }: { app: App; target: ScriptTarget; revoked: readonly string[] }
): Promise<void> => {
  await recordRevoked(db, loaded, target, revoked);
  const { [app]: _recorded, ...revoking } = progress.revoking;
  progress.revoking = revoking;
};

/**
 * Sends Worker `app`'s `upload` to `target` and observes it: its static
 * files first, then, with the secrets it drops (`revoked`) noted in
 * `progress` (`revoking`), the script itself, marked (`sendHolding`) and
 * counted as run (`uploadCountedAsRun`); then read back at its release's
 * last Durable Object migration, which it returns (null for none).
 */
const sendUpload = async (
  context: ProvisionContext,
  loaded: Loaded,
  progress: Progress,
  {
    app,
    worker,
    target,
    upload,
    revoked,
    fingerprint,
    sameUpload,
  }: {
    app: App;
    worker: WorkerEntry;
    target: ScriptTarget;
    upload: WorkerUpload;
    revoked: readonly string[];
    /** The upload's fingerprint, marked with it (`sendHolding`). */
    fingerprint: string;
    /** Whether another attempt's same upload on its way needn't be waited for. */
    sameUpload: boolean;
  }
): Promise<string | null> => {
  const { api, db, store } = context;
  const lastTag = worker.durableObjectMigrations.at(-1)?.tag;
  // Its static files first, with a deadline of their own: they're named
  // by their content and change nothing a script runs until its upload
  // names them, so they need no mark (`sendHolding`) and don't spend the
  // upload's. Each request checks this attempt still holds the client.
  const assets = workerAssets(store, worker);
  const assetsJwt =
    assets === undefined
      ? undefined
      : await uploadTargetAssets(api, target, assets, {
          signal: AbortSignal.timeout(
            context.sendTimeoutMs ?? defaultSendTimeoutMs
          ),
          beforeSend: async () => {
            await assertHolds(db, loaded.held);
          },
        });
  await noteSuperseded(db, loaded, progress, app);
  if (revoked.length > 0) {
    progress.revoking = { ...progress.revoking, [app]: [...revoked] };
    await recordProgress(db, loaded, progress);
  }
  await uploadCountedAsRun(
    db,
    loaded,
    progress,
    { app, history: worker.durableObjectMigrations },
    async (sent) => {
      await sendHolding(
        context,
        loaded,
        async (signal) => {
          await uploadTargetScript(
            api,
            target,
            { ...upload, ...(assetsJwt === undefined ? {} : { assetsJwt }) },
            { signal, sent }
          );
        },
        {
          upload: { script: target.scriptName, fingerprint },
          same: sameUpload,
        }
      );
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
  return after.migrationTag ?? null;
};

/**
 * Steps 4 and 5 for Worker `app`: rendered onto the client's inventory and
 * uploaded as its script with its secrets, unless the upload recorded with
 * the same fingerprint is observed already, its script holding exactly
 * those secrets by name (one can be deleted, or another set, by hand
 * since); then observed at the release's last Durable Object migration,
 * and recorded as what the client runs. A secret the script held that the
 * upload no longer gives (a previous generation's key past its window, a
 * sealed or shared secret no longer given, one set by hand) is gone with
 * it, and recorded by name (`recordRevoked`). Only the secrets' keyed
 * fingerprint is recorded.
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
  const rendered = renderClientWorker(
    worker,
    placement,
    inventory,
    renderOptionsOf(loaded)
  );
  // Its mail sends from the client's onboarding sender alone, as a
  // deploy's does (`renderBindings`).
  const mailSender = mailSenderOf(context, held.clientId);
  for (const binding of rendered.bindings) {
    lockMailSender(binding, mailSender);
  }
  const target = targetOf(loaded, inventory, app);
  const vars = varsOf(
    context,
    loaded,
    app,
    app === "core" ? coreVarsOf(context, loaded) : {}
  );
  const secrets = await secretsOf(context, loaded, app);
  const given = new Set(secrets.map(({ name }) => name));
  const fingerprint = await uploadFingerprint(context.secrets.clientKey, {
    target,
    manifest,
    worker,
    bindings: rendered.bindings,
    vars,
    secrets,
  });
  const lastTag = worker.durableObjectMigrations.at(-1)?.tag;
  // Another attempt's upload of this Worker may still be on its way
  // (`othersSettled`), or a run's of the change before. One of this change
  // with this very fingerprint, once the script is at the release's last
  // Durable Object migration, is the call this one makes: landing late, it
  // changes nothing, so it isn't waited for. Every other is, and the
  // script, and so the migrations this one sends, read again once it
  // landed. An attempt doesn't send what an earlier one did when what it
  // reads has changed since (settings, sign-in, secrets, the generation,
  // the rotation's window): its fingerprint differs then.
  let before = await targetMigrationState(api, target);
  const sameUpload = before.exists && before.migrationTag === lastTag;
  await othersSettled(
    context,
    loaded,
    sameUpload ? { script: target.scriptName, fingerprint } : undefined
  );
  if (!sameUpload) {
    before = await targetMigrationState(api, target);
  }
  const progress = await progressNow(db, loaded.operation.id);
  const present = new Set(
    before.exists ? await targetSecretNames(api, target) : []
  );
  const done =
    progress.uploads[app] === fingerprint &&
    before.exists &&
    before.migrationTag === lastTag &&
    holdsExactly(given, present);
  // What an earlier run's upload dropped but didn't record (`revoking`)
  // and the script no longer holds: gone already, whether given again
  // since or not, so recorded before this upload can give it back.
  const gone = (progress.revoking[app] ?? []).filter(
    (name) => !present.has(name)
  );
  if (gone.length > 0) {
    await recordDropped(db, loaded, progress, { app, target, revoked: gone });
    await recordProgress(db, loaded, progress);
  }
  // What it holds that it's no longer given: what this upload drops.
  const revoked = [...present].filter((name) => !given.has(name));
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
  await noteRecordedBefore(db, loaded, progress, app);
  if (!done) {
    const migrations = pendingMigrations(
      worker.durableObjectMigrations,
      before.migrationTag
    );
    const prepared = renderedWorkerUpload(
      store,
      manifest,
      worker,
      rendered.bindings,
      vars,
      secrets
    );
    const migrated = await sendUpload(context, loaded, progress, {
      app,
      worker,
      target,
      upload: {
        ...prepared,
        metadata: {
          ...prepared.metadata,
          ...(migrations === undefined ? {} : { migrations }),
        },
      },
      revoked,
      fingerprint,
      sameUpload,
    });
    await recordDropped(db, loaded, progress, { app, target, revoked });
    await recordProgress(db, loaded, {
      ...progress,
      uploads: { ...progress.uploads, [app]: fingerprint },
      migrated: { ...progress.migrated, [app]: migrated },
      shared: {
        ...progress.shared,
        [app]: await sharedSecretPrints(context.secrets, app),
      },
    });
  }
  if (app === "core") {
    // Core live with the settings as this run read them: what's pending is
    // what changed after it started reading (`readAt`), sign-in included.
    const now = await progressNow(db, loaded.operation.id);
    await recordProgress(db, loaded, {
      ...now,
      configuredAt: loaded.readAt.toISOString(),
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
  // The names removed, never a value: what an operator set by hand and
  // lost here can be read back from the step.
  const removed = [...gone, ...revoked];
  await recordStep(db, loaded, app, {
    uploaded: done ? 0 : 1,
    revoked: removed.length,
    revokedNames: removed.join(","),
  });
};

/**
 * Records each Worker's version live, as its probe found it, on what the
 * client runs (`client_workers`): what drift compares against
 * (src/rollout/drift.ts). Core's is the version its probe answered as;
 * connect's, read from its script in an account's own Workers, or in a
 * namespace, whose versions Cloudflare's API doesn't list, the version
 * connect named to core in the probe (`connectVersion`), or none when it
 * named none. Only while the runner holds the client.
 */
const recordLiveVersions = async (
  context: ProvisionContext,
  loaded: Loaded,
  answered: { core: string; connect: string | null }
): Promise<void> => {
  const { db } = context;
  const { held } = loaded;
  for (const app of appsOf(loaded.manifest)) {
    const version = app === "core" ? answered.core : answered.connect;
    // oxlint-disable-next-line no-await-in-loop -- two Workers
    await db
      .update(clientWorkers)
      .set({ versionId: version })
      .where(
        and(
          eq(clientWorkers.clientId, held.clientId),
          eq(clientWorkers.worker, app),
          stillHolds(held)
        )
      );
  }
};

/**
 * The version a namespace connect answers as after this run's upload of
 * it, read twice in a row the same: `first`, what it named in the probe,
 * then asked again (`connectVersionOf`) after a wait, until two reads in a
 * row name one version, and not the one recorded before the upload
 * (`superseded`), which an isolate of it still answering would name. Two
 * reads apart the same keep an isolate of a version an earlier attempt's
 * upload made, never recorded and so never `superseded`, from being taken
 * for this one's, whose secrets a retry may have changed since. Null when
 * none settles, so none is recorded, which holds every secret connect
 * holds (src/rollout/drift.ts).
 */
const freshConnectVersion = async (
  context: ProvisionContext,
  asking: ProbeRequest,
  first: string | null,
  superseded: string | undefined
): Promise<string | null> => {
  let asked = false;
  let previous: string | null = null;
  const read = await observed(
    context,
    async () => {
      let version = first;
      if (asked) {
        version = (await connectVersionOf(asking)) ?? null;
      }
      asked = true;
      const settled =
        version !== null && version !== superseded && version === previous;
      previous = version;
      return { version, settled };
    },
    ({ settled }) => settled
  );
  return read.settled ? read.version : null;
};

/** How long core's signed probe may take, its body included. */
const probeTimeoutMs = 10_000;

/**
 * Where the client's core answers for the probe and the router: its user
 * Worker through the dispatch namespace the router and the admin bind. A
 * namespace other than the bound one can't be reached through
 * the binding, so it is refused (`probe_unqualified`), never probed or
 * routed some other way. What the router's map entry names, too.
 */
const reachableCore = (
  context: ProvisionContext,
  loaded: Loaded,
  target: ScriptTarget
): { core: CoreAddress; script: string } => {
  const { held } = loaded;
  const script = target.scriptName;
  const core =
    target.namespace === context.router.namespace
      ? coreAddressOf(
          { kind: "dispatch", script },
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
  return { core, script };
};

/**
 * Step 7: core answers its health check, as the version live, to the
 * router secret the router will send, then the admin's signed probe as
 * this client at that version, each of its private bindings answering
 * and both clocks armed, reached as the router will reach it
 * (`reachableCore`). Returns the script the router's map entry names.
 */
const probe = async (
  context: ProvisionContext,
  loaded: Loaded,
  inventory: readonly ClientResource[]
): Promise<string> => {
  const { db } = context;
  const { held } = loaded;
  const target = targetOf(loaded, inventory, "core");
  const { core, script } = reachableCore(context, loaded, target);
  const { origin } = core;
  const routerSecret = await deriveRouterSecret(
    context.secrets.routerKey,
    held.clientId,
    loaded.client.generation
  );
  // Live at once on upload, its versions not listed by the documented API,
  // so the version answering, never the one this run superseded, is the
  // one the probe is held to: an isolate of the superseded one still
  // answering is asked again until another answers. The probe then
  // answers as the same version, or the run stops: two reads apart the same.
  const { superseded } = await progressNow(db, loaded.operation.id);
  const { version, attempts } = await smokeAnswering(core, routerSecret, {
    ...context.router.smoke,
    refuses: superseded.core,
  });
  const asking = {
    origin,
    routerSecret,
    authSecret: await clientAuthSecret(
      context.secrets,
      held.clientId,
      loaded.client.generation
    ),
    fetch: core.fetch,
    timeoutMs: context.router.smoke?.attemptTimeoutMs ?? probeTimeoutMs,
  };
  const answer = await probeCore(asking);
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
  const before = await progressNow(db, loaded.operation.id);
  const connect = await freshConnectVersion(
    context,
    asking,
    answer.connectVersion ?? null,
    before.superseded.connect
  );
  await recordLiveVersions(context, loaded, {
    core: version,
    connect,
  });
  // What this run superseded is forgotten only once a version is recorded
  // in its place: a retry after a later step fails still refuses it.
  const settled = connect === null ? [] : ["connect"];
  const progress = {
    ...before,
    superseded: withoutApps(before.superseded, ["core", ...settled]),
    recordedBefore: withoutApps(before.recordedBefore, ["core", ...settled]),
  };
  await recordStep(
    db,
    loaded,
    "probe",
    // No version of connect's recorded: none settled but the one this run
    // replaced, or none at all.
    connect === null ? { attempts, connectUnrecorded: 1 } : { attempts },
    { ...progress, origin }
  );
  return script;
};

/** Step 8: the client's hostname in the router's map, only after the probe passed. */
const route = async (
  context: ProvisionContext,
  loaded: Loaded,
  script: string
): Promise<void> => {
  const { held } = loaded;
  const { generation } = loaded.client;
  // Only a script of this client's own placement (`deploymentPrefix`,
  // inventory.ts): a mis-recorded inventory never publishes another's.
  if (!script.startsWith(deploymentPrefix(loaded.placement.deploymentId))) {
    throw new ProvisionOperationError(
      "probe_unqualified",
      `${script} isn't a script of ${held.clientId}'s placement`
    );
  }
  await registerHostname(
    context.router.hosts,
    `${held.clientId}.${context.router.domain}`,
    { clientId: held.clientId, script, generation },
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
      // A rotation it delivered is live from now, while the generation is
      // still the one it delivered (src/deploy/rotation.ts): the previous
      // keys' window counts from here (src/deploy/secrets.ts).
      db
        .update(clients)
        .set({ rotationLiveAt: now })
        .where(
          and(
            eq(clients.id, held.clientId),
            eq(clients.generation, loaded.client.generation),
            isNotNull(clients.rotatedAt),
            isNull(clients.rotationLiveAt),
            stillHolds(held)
          )
        ),
      // Only while this attempt holds the client: one that timed out and
      // finishes late leaves its retry's claim be.
      releaseRun(db, held.clientId, held.runId, held.attempt, held.attemptKey),
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
 * Records client `held.clientId`'s operation failed with `code` at its
 * first step, audited, when runner `held` stopped before it could run it:
 * what it works with couldn't be read (a secret missing from Secrets
 * Store, no client domain). Only while that attempt of the runner
 * (`held.attempt`, taken first) still holds the client and the operation
 * is running: never over another runner's, nor a retry's that took the
 * client over, nor what a run recorded. Staff then read why on its Setup, rather than an
 * operation left running by a run that's gone.
 */
export const recordUnstarted = async (
  db: AdminDatabase,
  held: HeldClient,
  code: string
): Promise<void> => {
  const operation = await provisionOf(db, held.clientId);
  if (operation?.status !== "running") {
    return;
  }
  log.error("provision.failed", {
    operation: operation.id,
    clientId: held.clientId,
    step: "validated",
    error: code,
  });
  await recordFailure(db, { operation, held }, "validated", code);
};

/**
 * Notes, audited and logged, that the attempt before `held`'s ended
 * without recording how, and the step it reached. An attempt records its
 * failure on the operation (`recordFailure`) or finishes it, so one that
 * finds the operation still running after an earlier attempt of its run
 * was cut off where nothing of ours ran again: its isolate killed (past
 * its memory or CPU limit), or timed out. Workerflow only says "internal
 * workflows error"; this says where.
 */
const noteLostAttempt = async (
  db: AdminDatabase,
  operation: Operation,
  held: HeldClient
): Promise<void> => {
  if ((held.attempt ?? 1) <= 1 || operation.status !== "running") {
    return;
  }
  const step = stepReached(operation.step);
  const detail = {
    operation: operation.id,
    run: held.runId,
    attempt: held.attempt === undefined ? 0 : held.attempt - 1,
    step,
  };
  log.error(attemptLostAction, { clientId: held.clientId, ...detail });
  await actIfChanged(
    db,
    "system",
    db
      .update(clientProvisions)
      .set({ updatedAt: new Date() })
      .where(and(eq(clientProvisions.id, operation.id), stillHolds(held))),
    {
      action: attemptLostAction,
      clientId: held.clientId,
      target: operation.releaseId,
      detail,
    }
  );
};

/**
 * Why client `clientId`'s run failed when nothing of the operation
 * recorded it: its last attempt lost at the step it reached
 * (`attemptLostCode`), while the operation is still running as that run
 * left it; null when the operation recorded its own end.
 */
export const lostAttemptOf = async (
  db: AdminDatabase,
  clientId: string,
  runId: string
): Promise<string | null> => {
  const operation = await provisionOf(db, clientId);
  return operation?.status === "running" && operation.runId === runId
    ? attemptLostCode(stepReached(operation.step))
    : null;
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
    // Before anything is read or asked of Cloudflare: an admin whose
    // STAGE names no stage has no namespace of its own to hold a client
    // to, and never takes itself for production.
    const ownNamespace = context.router.namespace;
    const ownStage =
      ownNamespace === undefined ? undefined : stageOfNamespace(ownNamespace);
    if (ownNamespace === undefined || ownStage === undefined) {
      throw new ProvisionOperationError(
        "stage_unset",
        "This admin's STAGE is neither staging nor production: it runs no operation"
      );
    }
    await assertHolds(db, held);
    const loaded: Loaded = {
      ...(await load(db, held, operation)),
      ownNamespace,
    };
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
        inventory,
        renderOptionsOf(loaded)
      );
    }
    for (const app of order) {
      step = app;
      // oxlint-disable-next-line no-await-in-loop -- connect, then core
      await upload(context, loaded, inventory, app);
    }

    step = "probe";
    const script = await probe(context, loaded, inventory);

    step = "route";
    await route(context, loaded, script);
    await complete(db, loaded);
    return undefined;
  } catch (error) {
    // Any failure, a resource outside the organization's jurisdiction
    // (src/hosting/provision.ts) included, stops the run here: recorded on
    // the operation with its step and code, audited, for its Setup to show.
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
 * Rolls client `held.clientId` back to the release it ran before
 * `failed`, which failed its probe with `code`: through its operation,
 * as runner `held`, audited as the system's rollback with the cause.
 * Throws when the rollback doesn't finish, its failure recorded on the
 * operation as any is.
 */
const rollBackAfterProbe = async (
  context: ProvisionContext,
  held: HeldClient,
  failed: Operation,
  code: string
): Promise<void> => {
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
    throw error;
  }
};

/**
 * Runs client `held.clientId`'s provisioning operation, as runner `held`,
 * from its first step, and records it done; one done already is left as
 * it is. Run it again, as this runner or another that claimed the client,
 * to resume one that failed. On a failure it records the step and the
 * error's code, audited, and throws the error; except that a live
 * client's release that fails its probe is rolled back to the release
 * before on its own (`rollsBack`), audited. Only for a release
 * to another release: a run of the release it runs again (settings,
 * rotation, a secrets rollout) or a rollback passes `rollBackOnProbe`
 * false, as going back a release wouldn't undo what failed.
 */
export const runClientProvision = async (
  context: ProvisionContext,
  held: HeldClient,
  { rollBackOnProbe = true }: { rollBackOnProbe?: boolean } = {}
): Promise<void> => {
  // Here, as the attempt enters, and not in `runOperation`: a rollback
  // that this attempt starts runs the operation again as the same attempt,
  // from a start of its own, with nothing of it lost.
  const entered = await provisionOf(context.db, held.clientId);
  if (entered !== undefined) {
    await noteLostAttempt(context.db, entered, held);
  }
  const stopped = await runOperation(context, held);
  if (stopped === undefined) {
    return;
  }
  const { operation, step, code, error } = stopped;
  if (rollBackOnProbe && (await rollsBack(context.db, operation, step, code))) {
    await rollBackAfterProbe(context, held, operation, code);
    return;
  }
  throw error;
};
