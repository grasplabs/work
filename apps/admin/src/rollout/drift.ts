/**
 * Drift: what a placed client's destination runs, read live, against what
 * the admin last made live there (`client_workers`, which its operation
 * keeps, src/hosting/operation.ts). A Worker running another version was
 * changed outside the admin (a `wrangler deploy`, a rollback in the
 * dashboard); one whose traffic is split was left so.
 */
import { log } from "@grasp-os/shared/log";
import { deriveRouterSecret } from "@grasp-os/shared/router";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { CloudflareApi } from "../cloudflare/api.ts";
import { listDeployments } from "../cloudflare/workers.ts";
import type { WorkerDeployment } from "../cloudflare/workers.ts";
import type { AdminDatabase } from "../db/act.ts";
import {
  clientPlacements,
  clientProvisions,
  clients,
  clientWorkers,
} from "../db/schema.ts";
import { errorCode } from "../deploy/deploy.ts";
import type { importedManifest } from "../deploy/release.ts";
import { answeringVersion } from "../deploy/router.ts";
import { clientAuthSecret } from "../deploy/secrets.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import { clientInventory, destinationOf } from "../hosting/inventory.ts";
import { connectVersionOf } from "../hosting/probe.ts";
import type { ProbeRequest } from "../hosting/probe.ts";

/**
 * A Worker's drift: `in_sync` (all its traffic on the version the admin
 * made live), `drifted` (all of it on another), `split` (between
 * versions), or `unknown` (the account didn't answer).
 */
export type DriftState = "in_sync" | "drifted" | "split" | "unknown";

/**
 * A client's drift: its worst Worker's, or `off_pin` when it runs what the
 * admin made live but that isn't the release it's pinned to, or
 * `unknown` when the admin has made nothing live on it yet.
 */
export type ClientDriftState = DriftState | "off_pin";

/** One of a client's Workers, as drift reads it. */
export interface WorkerDrift {
  worker: string;
  scriptName: string;
  /** The version the admin last made live; null when it has no record of the Worker. */
  recorded: string | null;
  /** Its current deployment's versions and shares; null when unknown. */
  live: WorkerDeployment["versions"] | null;
  state: DriftState;
}

/** A client's drift. */
export interface ClientDrift {
  clientId: string;
  /**
   * The release it should run: the one it's pinned to, else the one the
   * admin last made live on it.
   */
  intendedRelease: string | null;
  /** Its drift: drifted, then split, off its pin, unknown, in sync. */
  state: ClientDriftState;
  workers: WorkerDrift[];
}

/** The drift of a Worker whose current deployment is `live`. */
const stateOf = (
  recorded: string | null,
  live: WorkerDeployment["versions"]
): DriftState => {
  const [only, ...others] = live;
  if (others.length > 0) {
    return "split";
  }
  return only?.version_id === recorded && only.percentage === 100
    ? "in_sync"
    : "drifted";
};

/** A client's drift is the worst it has, in this order. */
const severity: readonly ClientDriftState[] = [
  "drifted",
  "split",
  "off_pin",
  "unknown",
  "in_sync",
];

/**
 * A release's manifest, as the admin imported it: `importedManifest`,
 * or one read once for many clients (the grid).
 */
export type ManifestOf = (
  releaseId: string
) => ReturnType<typeof importedManifest>;

/**
 * How drift reads a Worker's version where only core tells it: in a
 * namespace, whose versions Cloudflare's API doesn't list.
 */
export interface HealthReads {
  fetch: typeof fetch;
  /**
   * The keys the client's router secret and auth secret are derived from:
   * the router's, for every request to core, and the client key, which
   * the admin signs its request for connect's version with.
   */
  secrets: Pick<DeploySecrets, "routerKey" | "clientKey">;
  timeoutMs?: number;
}

/** How long a read of core may take. */
const healthTimeoutMs = 5000;

/**
 * How core names each Worker's version in a namespace: its own at its
 * health (`answeringVersion`), its connect's, as connect names it over
 * its binding (through the connect gateway), to the admin's signed request
 * alone (`connectVersionOf`). Drift reads no other Worker there.
 */
const namespaceReads: Readonly<
  Record<string, (request: ProbeRequest) => Promise<string | undefined>>
> = {
  core: async ({ fetch: fetchCore, origin, routerSecret, timeoutMs }) =>
    await answeringVersion(fetchCore, origin, routerSecret, timeoutMs),
  connect: connectVersionOf,
};

const originSchema = z.object({ origin: z.string().optional() }).loose();

/** Core's origin, as its operation's probe passed at; null before it did. */
const coreOriginOf = async (
  db: AdminDatabase,
  clientId: string
): Promise<string | null> => {
  const row = await db
    .select({ progress: clientProvisions.progress })
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, clientId))
    .get();
  const parsed = originSchema.safeParse(JSON.parse(row?.progress ?? "{}"));
  return parsed.success ? (parsed.data.origin ?? null) : null;
};

/*
 * A Worker's drift where only core names its version. What it
 * decides: whether the secrets an operation delivered to that Worker are
 * still what it runs (src/rollout/shared-secrets.ts), so whether an old
 * shared secret can be revoked. Reading a Worker as in sync when it isn't
 * would let a key it still uses be revoked; reading it as anything else
 * only holds the revocation. Threat model:
 *
 * - A lying version. The version is Cloudflare's version metadata of the
 *   isolate answering, which neither the client's people nor App code can
 *   set: App code runs sandboxed, with no route of core's. Connect's comes
 *   to core over its binding, which in a namespace is the connect gateway
 *   bound by the admin to this client's connect alone (GRA-1217); the
 *   gateway takes no script name from a caller. Core names connect's
 *   version only to the admin's signed request (the probe's model, with a
 *   key of its own), never to the public: the router adds its secret to
 *   every request it forwards, so that secret alone says nothing of who
 *   asks. A connect deployed outside the admin answers as its
 *   own version, which differs from the one recorded: `drifted`, held.
 *   Code made to name the recorded version needs write access to the
 *   account, which can take the secrets anyway: out of scope.
 * - A secret changed by hand. In a namespace every secret change, as every
 *   upload, makes a new version, which version metadata names (a live
 *   check on a real namespace, GRA-1223, 29 Oct): the version recorded is
 *   only named while connect runs the secrets its operation delivered.
 * - Core naming core's version as connect's, or connect's for core: each
 *   Worker is compared only with its own recorded version, and two
 *   versions never share an id.
 * - A stale read. A read from before the recorded version (an isolate of
 *   an earlier version still answering) names another version: `drifted`,
 *   held. Never cached: core answers `no-store`. The version recorded is
 *   the one connect named in the operation's probe, after its secrets were
 *   delivered (src/hosting/operation.ts), and never the one recorded
 *   before this run changed connect: an isolate of that version answering
 *   the probe first is asked again until a new version answers, and if
 *   none does, no version is recorded, which holds; what was superseded
 *   stays noted until a version is recorded, so a retry refuses it too. A
 *   version is recorded only when two reads a moment apart name it, so an
 *   isolate of a version this run made before its last secret (its
 *   upload's, say) answering once isn't taken for the latest. One
 *   answering both reads still can be: the namespace's writes don't say
 *   which version they made (an upload answers with the script, a secret
 *   with its name and type), so there is no id to wait for. A later read
 *   naming the newest version then reads as `drifted`, which holds. Core's in a
 *   namespace likewise: never the superseded one, and its health and its
 *   probe naming the same.
 * - No answer: no version metadata (plain workerd), connect down, core
 *   down, too slow, or an older core without the request. `unknown`, which
 *   holds every secret the Worker holds.
 */

/**
 * The drift of `worker` (core or connect) where only core names its
 * version: `in_sync` when it names the version recorded, `drifted` when
 * another, `unknown` when it can't be asked or doesn't answer.
 */
const healthDrift = async (
  worker: { worker: string; scriptName: string; versionId: string | null },
  origin: string | null,
  health: HealthReads | undefined,
  client: { clientId: string; generation: number }
): Promise<WorkerDrift> => {
  const unknown: WorkerDrift = {
    worker: worker.worker,
    scriptName: worker.scriptName,
    recorded: worker.versionId,
    live: null,
    state: "unknown",
  };
  const read = namespaceReads[worker.worker];
  if (origin === null || health === undefined || read === undefined) {
    return unknown;
  }
  const version = await read({
    fetch: health.fetch,
    origin,
    routerSecret: await deriveRouterSecret(
      health.secrets.routerKey,
      client.clientId,
      client.generation
    ),
    authSecret: await clientAuthSecret(
      health.secrets,
      client.clientId,
      client.generation
    ),
    timeoutMs: health.timeoutMs ?? healthTimeoutMs,
  });
  if (version === undefined) {
    return unknown;
  }
  return {
    ...unknown,
    live: [{ version_id: version, percentage: 100 }],
    state: version === worker.versionId ? "in_sync" : "drifted",
  };
};

/**
 * Client `clientId`'s drift, read live from its destination; null when the
 * admin has no such client, or it isn't placed. Each Worker the admin
 * recorded is read: in an account's own Workers, from its deployments; in
 * a Workers for Platforms namespace, core and connect, from the version
 * core names for each through its origin (`health`), as its probe found
 * it, and `unknown` without `health`. A Worker of its inventory the admin has no
 * record of (an operation that stopped part way) is never in sync. A
 * Worker that can't be read is `unknown`, and logged.
 */
export const driftOf = async (
  api: CloudflareApi,
  db: AdminDatabase,
  clientId: string,
  health?: HealthReads
): Promise<ClientDrift | null> => {
  const [client] = await db
    .select({
      pinnedReleaseId: clients.pinnedReleaseId,
      generation: clients.generation,
      destinationId: clientPlacements.destinationId,
    })
    .from(clients)
    .innerJoin(clientPlacements, eq(clientPlacements.clientId, clients.id))
    .where(eq(clients.id, clientId));
  if (client === undefined) {
    return null;
  }
  const destination = await destinationOf(db, client.destinationId);
  const accountId = destination.accountId ?? "";
  const inNamespace = destination.kind === "workers_for_platforms";
  const recorded = await db
    .select({
      worker: clientWorkers.worker,
      scriptName: clientWorkers.scriptName,
      releaseId: clientWorkers.releaseId,
      versionId: clientWorkers.versionId,
    })
    .from(clientWorkers)
    .where(eq(clientWorkers.clientId, clientId));
  const inventory = await clientInventory(db, clientId);
  const scripts = inventory.filter(
    ({ kind, deletedAt }) => kind === "worker_script" && deletedAt === null
  );
  const unrecorded = scripts
    .filter(
      ({ physicalName }) =>
        !recorded.some(({ scriptName }) => scriptName === physicalName)
    )
    .map(({ role, physicalName }) => ({
      worker: role.replace(/^worker:/u, ""),
      scriptName: physicalName,
      versionId: null,
    }));
  // In a namespace the admin reads only what core names.
  const read = [...recorded, ...unrecorded].filter(
    ({ worker }) => !inNamespace || Object.hasOwn(namespaceReads, worker)
  );
  const origin = inNamespace ? await coreOriginOf(db, clientId) : null;
  const workers = await Promise.all(
    read.map(async ({ worker, scriptName, versionId }) => {
      try {
        if (inNamespace) {
          return await healthDrift(
            { worker, scriptName, versionId },
            origin,
            health,
            { clientId, generation: client.generation }
          );
        }
        const [current] = await listDeployments(api, accountId, scriptName);
        const live = current?.versions ?? [];
        return {
          worker,
          scriptName,
          recorded: versionId,
          live,
          state: stateOf(versionId, live),
        };
      } catch (error) {
        log.warn("drift.unread", {
          clientId,
          worker,
          error: errorCode(error),
        });
        return {
          worker,
          scriptName,
          recorded: versionId,
          live: null,
          state: "unknown" as const,
        };
      }
    })
  );
  const states = new Set<ClientDriftState>(workers.map(({ state }) => state));
  const releases = new Set(recorded.map(({ releaseId }) => releaseId));
  const [recordedRelease = null] = releases.size === 1 ? releases : [];
  if (recorded.length === 0) {
    states.add("unknown");
  }
  const { pinnedReleaseId } = client;
  if (
    pinnedReleaseId !== null &&
    recorded.some(({ releaseId }) => releaseId !== pinnedReleaseId)
  ) {
    states.add("off_pin");
  }
  return {
    clientId,
    intendedRelease: pinnedReleaseId ?? recordedRelease,
    state: severity.find((state) => states.has(state)) ?? "in_sync",
    workers,
  };
};
