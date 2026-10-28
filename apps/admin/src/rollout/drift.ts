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
import { clientInventory, destinationOf } from "../hosting/inventory.ts";

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

/** How drift reads core's version where only its health tells it: in a namespace. */
export interface HealthReads {
  fetch: typeof fetch;
  /** The router's key, which the client's router secret is derived from. */
  routerKey: string;
  timeoutMs?: number;
}

/** How long a health read of core may take. */
const healthTimeoutMs = 5000;

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

/**
 * Core's drift where only its health names its version: `in_sync` when it
 * names the version recorded, `drifted` when another, `unknown` when it
 * can't be asked or doesn't answer.
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
  if (origin === null || health === undefined) {
    return unknown;
  }
  const version = await answeringVersion(
    health.fetch,
    origin,
    await deriveRouterSecret(
      health.routerKey,
      client.clientId,
      client.generation
    ),
    health.timeoutMs ?? healthTimeoutMs
  );
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
 * a Workers for Platforms namespace, core alone, from the version its
 * health names through its origin (`health`), as its probe found it, and
 * `unknown` without `health`. A Worker of its inventory the admin has no
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
  // In a namespace the admin reads only core, through its health.
  const read = [...recorded, ...unrecorded].filter(
    ({ worker }) => !inNamespace || worker === "core"
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
